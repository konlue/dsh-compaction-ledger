/**
 * Markdown / JSON report rendering for the compaction ledger.
 * Consumes the projection's host state (see ./fold.js) plus the normalized
 * plugin config, and produces the /ledger command text.
 *
 * @module dsh-compaction-ledger/report
 */

import { tFor } from "./i18n.js";

export const MODES = ["summary", "full", "json"];
export const ACTIONS = [...MODES, "restore"];

/**
 * Parse the raw text after `/ledger`:
 *   - `` / `summary` / `full` / `json`         → report in that format
 *   - `restore [last|<compactionId>]`          → inject a recall pointer
 * Returns `null` for unknown input.
 */
export function parseMode(rawInput) {
  const parts = (rawInput ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: "summary", arg: null };
  const head = parts[0].toLowerCase();
  if (parts.length === 1 && MODES.includes(head)) return { action: head, arg: null };
  if (head === "restore") {
    const arg = parts[1] ?? "last";
    if (parts.length > 2) return null;
    return { action: "restore", arg };
  }
  return null;
}

export const USAGE = "Usage: /ledger [summary|full|json] or /ledger restore [last|<compactionId>]";

function trimNum(text) {
  return text.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimNum((n / 1000).toFixed(1))}k`;
  return `${trimNum((n / 1_000_000).toFixed(2))}M`;
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${trimNum((ms / 1000).toFixed(2))}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

function fmtDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Markdown table cells must not contain raw pipes or line breaks. */
function cell(text, max = 28) {
  const flat = String(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function emptyReport(mode, tr) {
  if (mode === "json") {
    return `${JSON.stringify({ status: "empty", message: "No compaction recorded in this session yet." }, null, 2)}\n`;
  }
  return [tr("emptySession")].join("\n");
}

/**
 * First line of every text report. It doubles as the collapsed label of the
 * client card and as the first line of the raw text, so it must stand on its
 * own as plain prose — no Markdown markers, no trailing continuation.
 */
function headline(state, tr) {
  return tr("headline", {
    n: state.totals.count,
    success: state.totals.success,
    failed: state.totals.failed,
    tokens: fmtTokens(state.totals.tokensShadowed),
    pruned: state.totals.prunedResults,
    prunedLabel: tr(state.totals.prunedResults === 1 ? "toolResultOne" : "toolResultMany"),
  });
}

function entriesTable(state, tr) {
  const lines = [
    `| ${tr("indexHeader")} | ${tr("timeHeader")} | ${tr("triggerHeader")} | ${tr("statusHeader")} | ${tr("itemsHeader")} | ${tr("tokensHeader")} | ${tr("tookHeader")} |`,
    "| ---: | --- | --- | --- | ---: | ---: | ---: |",
  ];
  state.entries.forEach((entry, i) => {
    const statusKey = entry.status === "running" ? "statusRunning" : entry.status === "failed" ? "statusFailed" : "statusSuccess";
    lines.push(
      `| ${i + 1} | ${fmtDate(entry.t1 ?? entry.t0)} | ${tr(entry.trigger === "manual" ? "triggerManual" : "triggerAuto")} | ${tr(statusKey)} | ${entry.shadowedCount} | ${fmtTokens(entry.shadowedTokens)} | ${entry.wallMs === null ? "…" : fmtMs(entry.wallMs)} |`,
    );
  });
  return lines.join("\n");
}

function entryDetails(state, tr) {
  const lines = [];
  state.entries.forEach((entry, i) => {
    const statusKey = entry.status === "running" ? "statusRunning" : entry.status === "failed" ? "statusFailed" : "statusSuccess";
    lines.push(
      tr("entryDetail", {
        n: i + 1,
        trigger: tr(entry.trigger === "manual" ? "triggerManual" : "triggerAuto"),
        status: tr(statusKey),
      }),
    );
    if (entry.error) lines.push(`> ${cell(entry.error, 160)}`);
    if (entry.summaryPreview) {
      lines.push(
        tr("entrySummary", { provider: entry.provider ?? "?", model: entry.model ?? "?" }),
        "",
        `> ${cell(entry.summaryPreview, 400)}`,
      );
    }
    if (entry.pruned.length > 0) {
      lines.push("", tr("entryPrunedHeader"), "");
      for (const item of entry.pruned) {
        lines.push(
          `- ${tr("prunedRow", { tool: item.tool ?? tr("prunedUnknownTool"), seq: item.seq ?? "?", tokens: fmtTokens(item.tokens) })}`,
        );
      }
    } else {
      lines.push("", `_${tr("noPrunedResults")}_`);
    }
    lines.push("");
  });
  return lines;
}

/**
 * Render the /ledger report.
 * @param state projection host state (or null before any compaction)
 * @param cfg normalized config `{ language }`
 * @param mode one of {@link MODES}
 */
export function renderReport(state, cfg, mode = "summary") {
  const tr = tFor(cfg.language);
  if (mode === "json") {
    if (!state) return emptyReport(mode, tr);
    return `${JSON.stringify(
      {
        totals: state.totals,
        running: state.open !== null,
        entries: state.entries,
      },
      null,
      2,
    )}\n`;
  }

  if (!state || (state.totals.count === 0 && state.entries.length === 0)) return emptyReport(mode, tr);

  const lines = [headline(state, tr)];

  if (state.totals.count === 0 && state.entries.length > 0) {
    // A bracket is open but none has completed yet — still show the row.
    lines.push("", entriesTable(state, tr));
    return lines.join("\n");
  }

  lines.push("", entriesTable(state, tr));

  if (mode === "full") {
    lines.push("", ...entryDetails(state, tr));
  }
  return lines.join("\n");
}
