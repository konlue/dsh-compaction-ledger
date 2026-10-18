/**
 * Pure fold over the durable session event stream for the compaction ledger
 * projection. Events are the DeepSeek Harness session-log envelope
 * `{ type, data, time, seq }`; the compaction family is written by
 * `@deepseek-ai/dsh-compaction-basic` / `dsh-compaction-tool-result-pruner`:
 *
 *   compaction/start   { compactionId, sourceCommandId?, turn }
 *   compaction/prune   { shadowedRange, shadowedSeqs, shadowedTokenCount }
 *   compaction/summary { compactionId, summary, shadowedSeqs, shadowedTokenCount,
 *                        provider, model, usage?, ... }
 *   compaction/end     { compactionId, sourceCommandId?, turn, error? }
 *
 * Semantics mirrored from the writers:
 *   - `sourceCommandId` on compaction/start means the bracket was opened by the
 *     /compact command; its absence means automatic (pressure / overflow).
 *   - A compaction/prune event immediately precedes its replacement tool/result
 *     append; the replacement is identified by being the very next log seq and
 *     carries the same callId as the original (content-only rewrite), so the
 *     pruned item's tool identity is recovered from the callId → name map.
 *   - shadowedTokenCount on compaction/summary prices the whole replaced range
 *     (pruned results included), so token totals accumulate there only — never
 *     from prune events, which would double-count.
 *   - The log retains pre-compaction content verbatim ("compaction hides
 *     superseded entries without deleting them"), so shadowedSeqs remain valid
 *     addresses for later recall (see ./recall.js).
 *
 * Every handler is synchronous and copy-on-write: irrelevant events return
 * the previous state reference unchanged (the projection registry relies on
 * `Object.is` to skip view recomputation), and changed states are fresh
 * plain-JSON objects so projection checkpoints can persist them as-is.
 *
 * @module dsh-compaction-ledger/fold
 */

/** Bump when the fold semantics or state shape change incompatibly. */
export const STATE_VERSION = 1;

/** Default cap on remembered per-entry detail rows (configurable). */
export const DEFAULT_DETAIL_ENTRIES = 50;

/** Default summary preview length kept per entry (configurable). */
export const DEFAULT_PREVIEW_CHARS = 200;

/** Hard caps (defensive bounds, not config). */
const MAX_PRUNED_PER_ENTRY = 200;
const MAX_SHADOWED_SEQS = 2000;
const MAX_CALLS = 2000;

/** Wire-view bounds: clients read the tab from the projection's wire view, so
 * the pushed payload is bounded independently of the host-side detail cap. */
export const WIRE_ENTRY_LIMIT = 20;
const WIRE_PRUNED_LIMIT = 10;

/** Marker text length budget for a truncated shadowed-seq list. */
const SEQ_LIST_NOTE = "...";

/**
 * Empty fold state. `init` returns `null` instead so that sessions with no
 * compaction activity stay a compact `null` cell; handlers promote `null` via
 * {@link emptyState} on first relevant event.
 */
export function emptyState() {
  return {
    /** Compaction entries, oldest last, trimmed to `detailEntries`. */
    entries: [],
    /** compactionId of the currently open bracket, or null. */
    open: null,
    /** callId → tool name, bounded FIFO. */
    calls: {},
    /** Seq of the last compaction/prune seen, for adjacent-replacement pairing. */
    lastPruneSeq: null,
    /** Whole-session aggregates, never trimmed. */
    totals: {
      count: 0,
      success: 0,
      failed: 0,
      tokensShadowed: 0,
      itemsShadowed: 0,
      prunedResults: 0,
    },
  };
}

const ensureState = (state) => state ?? emptyState();

/** Index of the entry with this compactionId, or -1. */
function findEntryIndex(state, compactionId) {
  if (!compactionId) return -1;
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    if (state.entries[i].compactionId === compactionId) return i;
  }
  return -1;
}

function trimEntries(entries, cap) {
  return entries.length > cap ? entries.slice(entries.length - cap) : entries;
}

function newEntry(event) {
  const data = event.data ?? {};
  return {
    compactionId: data.compactionId ?? "",
    trigger: data.sourceCommandId === undefined ? "auto" : "manual",
    turn: data.turn ?? null,
    startSeq: event.seq ?? null,
    summarySeq: null,
    endSeq: null,
    t0: event.time ?? 0,
    t1: null,
    wallMs: null,
    status: "running",
    error: null,
    provider: null,
    model: null,
    shadowedSeqs: [],
    shadowedCount: 0,
    shadowedTokens: 0,
    summaryPreview: null,
    pruned: [],
  };
}

function onCompactionStart(state, event, cap) {
  const s = ensureState(state);
  const entry = newEntry(event);
  if (!entry.compactionId) return state;
  const entries = trimEntries([...s.entries, entry], cap);
  return { ...s, entries, open: entry.compactionId };
}

function onCompactionPrune(state, event, cap) {
  const s = ensureState(state);
  const data = event.data ?? {};
  const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];
  const tokens = data.shadowedTokenCount ?? 0;
  const totals = { ...s.totals, prunedResults: s.totals.prunedResults + 1 };

  const idx = findEntryIndex(s, s.open);
  if (idx < 0) return { ...s, totals, lastPruneSeq: event.seq ?? null };

  const entry = s.entries[idx];
  let pruned = [
    ...entry.pruned,
    { seq: seqs[0] ?? null, tokens, callId: null, tool: null },
  ];
  if (pruned.length > MAX_PRUNED_PER_ENTRY) pruned = pruned.slice(pruned.length - MAX_PRUNED_PER_ENTRY);
  const entries = s.entries.slice();
  entries[idx] = { ...entry, pruned };
  return { ...s, entries, totals, lastPruneSeq: event.seq ?? null };
}

/**
 * The replacement tool/result appended directly after a compaction/prune.
 * Its callId is the pruned original's; the tool name comes from the callId map.
 */
function onReplacementResult(state, event) {
  const s = state;
  const idx = findEntryIndex(s, s.open);
  const callId = event.data?.message?.source?.callId ?? event.data?.callId;
  const tool = (callId !== undefined && s.calls[callId]) || null;
  if (idx < 0) return { ...s, lastPruneSeq: null };

  const entry = s.entries[idx];
  if (entry.pruned.length === 0) return { ...s, lastPruneSeq: null };
  const pruned = entry.pruned.slice();
  const last = pruned.length - 1;
  pruned[last] = { ...pruned[last], callId: callId ?? null, tool };
  const entries = s.entries.slice();
  entries[idx] = { ...entry, pruned };
  return { ...s, entries, lastPruneSeq: null };
}

function onToolCall(state, event) {
  const s = ensureState(state);
  const data = event.data ?? {};
  if (data.callId === undefined) return state;
  const calls = { ...s.calls, [data.callId]: data.name ?? "unknown" };
  const ids = Object.keys(calls);
  if (ids.length > MAX_CALLS) {
    for (const id of ids.slice(0, ids.length - MAX_CALLS)) delete calls[id];
  }
  return { ...s, calls };
}

function onToolResult(state, event) {
  const s = ensureState(state);
  // Only the replacement directly following a prune is ledger business;
  // ordinary tool results are irrelevant and keep the state reference.
  if (s.lastPruneSeq === null) return state;
  if ((event.seq ?? null) !== s.lastPruneSeq + 1) return state;
  return onReplacementResult(s, event);
}

function summaryText(summary) {
  if (!Array.isArray(summary)) return "";
  const parts = [];
  for (const block of summary) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function onCompactionSummary(state, event, cap, previewChars) {
  const s = ensureState(state);
  const data = event.data ?? {};
  const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : [];
  const tokens = data.shadowedTokenCount ?? 0;
  const totals = {
    ...s.totals,
    tokensShadowed: s.totals.tokensShadowed + tokens,
    itemsShadowed: s.totals.itemsShadowed + seqs.length,
  };

  const idx = findEntryIndex(s, data.compactionId ?? s.open);
  if (idx < 0) return { ...s, totals };

  const entry = s.entries[idx];
  const preview = summaryText(data.summary);
  const entries = s.entries.slice();
  entries[idx] = {
    ...entry,
    summarySeq: event.seq ?? null,
    shadowedSeqs: seqs.length > MAX_SHADOWED_SEQS ? seqs.slice(0, MAX_SHADOWED_SEQS - SEQ_LIST_NOTE.length) : seqs,
    shadowedCount: seqs.length,
    shadowedTokens: tokens,
    provider: typeof data.provider === "string" ? data.provider : entry.provider,
    model: typeof data.model === "string" ? data.model : entry.model,
    summaryPreview: preview.length > previewChars ? `${preview.slice(0, previewChars - 1)}…` : preview || null,
  };
  return { ...s, entries, totals };
}

function onCompactionEnd(state, event) {
  const s = ensureState(state);
  const data = event.data ?? {};
  const failed = data.error !== undefined && data.error !== null;
  const totals = {
    ...s.totals,
    count: s.totals.count + 1,
    success: s.totals.success + (failed ? 0 : 1),
    failed: s.totals.failed + (failed ? 1 : 0),
  };

  const idx = findEntryIndex(s, data.compactionId ?? s.open);
  if (idx < 0) return { ...s, totals, open: s.open === (data.compactionId ?? null) ? null : s.open };

  const entry = s.entries[idx];
  if (entry.status !== "running") return { ...s, totals, open: s.open === entry.compactionId ? null : s.open };
  const t1 = event.time ?? entry.t0;
  const entries = s.entries.slice();
  entries[idx] = {
    ...entry,
    endSeq: event.seq ?? null,
    t1,
    wallMs: Math.max(0, t1 - entry.t0),
    status: failed ? "failed" : "success",
    error: failed ? String(data.error) : null,
  };
  return { ...s, entries, totals, open: s.open === entry.compactionId ? null : s.open };
}

/**
 * Fold one committed session event into the projection state.
 * @param state previous state (may be `null`)
 * @param event session-log envelope `{ type, data, time, seq }`
 * @param opts `{ detailEntries, previewChars }`
 * @returns the next state; identical reference when the event is irrelevant
 */
export function applyEvent(state, event, opts = {}) {
  const cap = Math.max(1, Math.floor(opts.detailEntries ?? DEFAULT_DETAIL_ENTRIES));
  const previewChars = Math.max(40, Math.floor(opts.previewChars ?? DEFAULT_PREVIEW_CHARS));
  switch (event?.type) {
    case "compaction/start": return onCompactionStart(state, event, cap);
    case "compaction/prune": return onCompactionPrune(state, event, cap);
    case "compaction/summary": return onCompactionSummary(state, event, cap, previewChars);
    case "compaction/end": return onCompactionEnd(state, event);
    case "tool/call": return onToolCall(state, event);
    case "tool/result": return onToolResult(state, event);
    default: return state ?? null;
  }
}

/** Compact client-facing view (wire projection of the durable aggregates).
 * Carries the bounded recent entries so the conversation-view Ledger tab can
 * render the timeline without any client-side folding. */
export function wireView(state) {
  if (!state) return null;
  const last = state.entries.length > 0 ? state.entries[state.entries.length - 1] : null;
  const entries = state.entries.slice(-WIRE_ENTRY_LIMIT).map((entry) => ({
    compactionId: entry.compactionId,
    time: entry.t1 ?? entry.t0,
    trigger: entry.trigger,
    status: entry.status,
    items: entry.shadowedCount,
    tokens: entry.shadowedTokens,
    took: entry.wallMs,
    provider: entry.provider,
    model: entry.model,
    summaryPreview: entry.summaryPreview,
    error: entry.error,
    pruned: entry.pruned.slice(-WIRE_PRUNED_LIMIT).map((item) => ({ seq: item.seq, tool: item.tool, tokens: item.tokens })),
  }));
  return {
    count: state.totals.count,
    success: state.totals.success,
    failed: state.totals.failed,
    tokensShadowed: state.totals.tokensShadowed,
    itemsShadowed: state.totals.itemsShadowed,
    prunedResults: state.totals.prunedResults,
    running: state.open !== null,
    entries,
    ...(last
      ? {
          last: {
            time: last.t1 ?? last.t0,
            trigger: last.trigger,
            status: last.status,
            items: last.shadowedCount,
            tokens: last.shadowedTokens,
          },
        }
      : {}),
  };
}
