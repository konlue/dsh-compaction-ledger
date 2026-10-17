/**
 * Recall of pruned content for the compaction ledger.
 *
 * The durable session log retains every pre-compaction event verbatim
 * ("compaction hides superseded entries without deleting them"), and the
 * ledger fold (./fold.js) records each entry's shadowedSeqs — the exact log
 * addresses of what the model can no longer see. This module turns those
 * addresses back into text for the recall_pruned tool.
 *
 * Event access is injected (`readEvents(offset, length)`) so the caller wires
 * the official persistence path (`ctx.sessionPersistence.open(id, "read")` →
 * `handle.read(offset, length)`) and tests can supply a plain array store.
 *
 * @module dsh-compaction-ledger/recall
 */

/** Hard cap on shadowed seqs visited in one recall (newest-first). */
const MAX_SEQS = 400;

/** Hard cap on chars for one recalled item (defensive bound). */
const MAX_ITEM_CHARS = 40_000;

/** Hard cap on the number of pages read from the store. */
const MAX_PAGES = 4;

/** Default page size for reads. */
const PAGE_SIZE = 2000;

export class RecallError extends Error {}

/**
 * Pick the ledger entry to recall from.
 * @param state fold state (may be null)
 * @param wanted `"last"` or a compactionId
 * @returns the entry, or null when nothing matches
 */
export function pickEntry(state, wanted = "last") {
  if (!state || state.entries.length === 0) return null;
  if (wanted && wanted !== "last") {
    return state.entries.find((entry) => entry.compactionId === wanted) ?? null;
  }
  // "last" prefers a completed compaction; a still-running bracket has
  // nothing settled to recall yet.
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    if (state.entries[i].status !== "running") return state.entries[i];
  }
  return null;
}

/** Flatten a message content array to text (text blocks only). */
function contentText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function roleLabel(event) {
  switch (event?.type) {
    case "user/message": return "user";
    case "assistant/message": return "assistant";
    case "tool/result": {
      const name = event.data?.message?.source?.name ?? event.data?.message?.source?.toolName;
      return typeof name === "string" && name ? `tool ${name}` : "tool result";
    }
    default: return event?.type ?? "event";
  }
}

function fence(text) {
  const runs = text.match(/`{3,}/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const fenceMark = "`".repeat(Math.max(3, longest + 1));
  return `${fenceMark}text\n${text}\n${fenceMark}`;
}

/**
 * Message content lives in different envelope shapes per event type:
 * tool/result nests it under `data.message`, while user/message and
 * assistant/message carry it flat at `data.content`.
 */
function contentOf(event) {
  return event?.data?.message?.content ?? event?.data?.content;
}

function itemBlock(event, seq) {
  const text = contentText(contentOf(event));
  const head = `**seq ${seq ?? event?.seq ?? "?"} · ${roleLabel(event)}**`;
  if (text === "") return `${head}\n\n_(no text content — non-text blocks only)_`;
  const clipped = text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}\n…(item truncated at ${MAX_ITEM_CHARS} chars)` : text;
  return `${head}\n\n${fence(clipped)}`;
}

/** Map events to seqs; tolerate stores that omit the seq field. */
function seqOf(event, fallback) {
  return typeof event?.seq === "number" ? event.seq : fallback;
}

/**
 * Build the recall text for one ledger entry.
 * @param opts `{ state, readEvents, compactionId, search?, maxChars }`
 *   - `readEvents(offset, length)` → Promise<event[]> from the durable log
 * @returns `{ report, entry, items, truncated }`
 */
export async function buildRecall(opts) {
  const { state, readEvents, compactionId = "last", search = null, maxChars = 20_000 } = opts;
  const entry = pickEntry(state, compactionId);
  if (!entry) {
    if (state && state.entries.length > 0) {
      throw new RecallError(`no compaction with id "${compactionId}" is recorded in this ledger`);
    }
    throw new RecallError("no compaction is recorded in this session's ledger yet");
  }

  const budget = Math.max(500, Math.floor(maxChars));

  // Pruned tool results are the highest-value recall targets; without them
  // the whole shadowed span went into the summary, so offer it newest-first.
  const prunedSeqs = entry.pruned.map((item) => item.seq).filter((seq) => typeof seq === "number");
  const spanSeqs = entry.shadowedSeqs ?? [];
  const targets = (prunedSeqs.length > 0 ? prunedSeqs : spanSeqs).slice(-MAX_SEQS).reverse();
  if (targets.length === 0) {
    throw new RecallError("this compaction entry has no recallable seqs recorded");
  }

  const wanted = search === null || typeof search !== "string" || search.trim() === ""
    ? null
    : search.trim().toLowerCase();

  const min = Math.min(...targets);
  const max = Math.max(...targets);
  const bySeq = new Map();
  let read = 0;
  for (let page = 0; page < MAX_PAGES && bySeq.size < targets.length; page += 1) {
    const offset = min + page * PAGE_SIZE;
    if (offset > max) break;
    const length = Math.min(PAGE_SIZE, max - offset + 1);
    const events = await readEvents(offset, length);
    if (!Array.isArray(events) || events.length === 0) break;
    for (let i = 0; i < events.length; i += 1) {
      const seq = seqOf(events[i], offset + i);
      bySeq.set(seq, events[i]);
    }
    read += events.length;
    if (events.length < length) break;
  }
  if (read === 0) {
    throw new RecallError("the session log returned no events for the recorded seqs");
  }

  const items = [];
  let used = 0;
  let truncated = false;
  const parts = [];
  for (const seq of targets) {
    const event = bySeq.get(seq);
    if (!event) continue;
    const block = itemBlock(event, seq);
    if (wanted !== null && !block.toLowerCase().includes(wanted)) continue;
    if (used + block.length > budget) {
      truncated = true;
      break;
    }
    parts.push(block);
    used += block.length;
    items.push(seq);
  }

  if (items.length === 0) {
    const scope = wanted === null ? "" : ` matching "${search}"`;
    throw new RecallError(`no recallable content${scope} was found for this compaction entry`);
  }

  const lines = [
    `Recalled ${items.length} item${items.length === 1 ? "" : "s"} from the compaction at ${new Date(entry.t1 ?? entry.t0).toLocaleString()} ` +
      `(~${Math.round(entry.shadowedTokens)} tokens were shadowed; showing newest-first).`,
  ];
  if (wanted !== null) lines.push(`Filter: "${search}".`);
  if (truncated) lines.push(`Stopped at the ${budget}-char recall budget — raise maxChars or narrow with search for more.`);
  lines.push("", ...parts.join("\n\n").split("\n"));

  return { report: lines.join("\n"), entry, items, truncated };
}

/**
 * Model-facing list of the ledger (recall_pruned with no arguments): one line
 * per entry with its compactionId, so the model can pick a target.
 */
export function buildList(state) {
  if (!state || state.entries.length === 0) {
    return "No compaction has been recorded in this session yet. The ledger fills when context pressure triggers compaction (or after a manual /compact).";
  }
  const lines = [`The session ledger records ${state.entries.length} compaction entr${state.entries.length === 1 ? "y" : "ies"}:`];
  state.entries.forEach((entry, i) => {
    lines.push(
      `- #${i + 1} id \`${entry.compactionId}\` · ${new Date(entry.t1 ?? entry.t0).toLocaleString()} · ${entry.trigger} · ${entry.status}` +
        ` · ${entry.shadowedCount} shadowed items (~${Math.round(entry.shadowedTokens)} tokens)` +
        (entry.pruned.length > 0 ? ` · ${entry.pruned.length} pruned tool results` : ""),
    );
  });
  lines.push("", "Call recall_pruned again with { compactionId } (and optional { search }, { maxChars }) to pull the original content back.");
  return lines.join("\n");
}
