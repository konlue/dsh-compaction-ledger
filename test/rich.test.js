/**
 * Coverage for the L1 rich cards: text parsers, the styled table / recall
 * item rendering, and the host→client format contract.
 *
 * The sync tests import the HOST renderers (lib/report.js, lib/recall.js)
 * directly and feed their output to the CLIENT parsers — that is the same
 * guarantee the desktop app exercises, enforced on every `node --test` run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadClient, renderTree, findOne, findAll } from "./harness.js";
import { applyEvent } from "../lib/fold.js";
import { renderReport } from "../lib/report.js";
import { buildRecall } from "../lib/recall.js";

const ev = (type, data, time, seq) => ({ type, data, time, seq });

/** Realistic summary report (exactly what /ledger prints). */
function summaryReportText() {
  const events = [
    ev("compaction/start", { compactionId: "C-1" }, 1_000, 0),
    ev("compaction/summary", { compactionId: "C-1", summary: [], shadowedSeqs: [1, 2], shadowedTokenCount: 4_100, provider: "d", model: "m" }, 1_010, 1),
    ev("compaction/end", { compactionId: "C-1" }, 1_040, 2),
    ev("compaction/start", { compactionId: "C-2" }, 2_000, 3),
    ev("compaction/summary", { compactionId: "C-2", summary: [], shadowedSeqs: [4], shadowedTokenCount: 1_200, provider: "d", model: "m" }, 2_010, 4),
    ev("compaction/end", { compactionId: "C-2" }, 2_020, 5),
  ];
  const state = events.reduce((s, e) => applyEvent(s, e, {}), null);
  return renderReport(state, { language: "en" }, "summary");
}

/** Realistic full report (headline + table + per-entry detail). */
function fullReportText() {
  const events = [
    ev("compaction/start", { compactionId: "C-1" }, 1_000, 0),
    ev("compaction/summary", { compactionId: "C-1", summary: [{ type: "text", text: "Refactor summary." }], shadowedSeqs: [1], shadowedTokenCount: 4_100, provider: "deepseek", model: "v4" }, 1_010, 1),
    ev("compaction/end", { compactionId: "C-1" }, 1_040, 2),
  ];
  const state = events.reduce((s, e) => applyEvent(s, e, {}), null);
  return renderReport(state, { language: "en" }, "full");
}

/** Realistic recall output (exactly what recall_pruned prints). */
async function recallReportText() {
  const state = [
    ev("compaction/start", { compactionId: "C-A" }, 1_100, 0),
    ev("compaction/summary", { compactionId: "C-A", summary: [], shadowedSeqs: [8, 9], shadowedTokenCount: 4_100, provider: "d", model: "m" }, 1_110, 1),
    ev("compaction/end", { compactionId: "C-A" }, 1_140, 2),
  ].reduce((s, e) => applyEvent(s, e, {}), null);
  const readEvents = async () => [
    ev("user/message", { content: [{ type: "text", text: "first message" }], role: "user" }, 0),
    ev("user/message", { content: [{ type: "text", text: "second message" }], role: "user" }, 0),
  ];
  const { report } = await buildRecall({ state, readEvents, compactionId: "last" });
  return report;
}

// The parsers are pure functions exposed on the factory result for the test
// harness; a bare React stub must still satisfy class definition and hook calls.
const parsers = await (async () => {
  const Component = class Component {};
  const React = {
    createElement: (...args) => ({ type: args[0], props: {} }),
    Component,
    memo: (component) => ({ $$typeof: Symbol.for("react.memo"), type: component, compare: null }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useMemo: (factory) => factory(),
  };
  let result = null;
  globalThis.window = { __ModuleLoader__: { load: (value) => { result = value.factory(() => React).__test; } } };
  await import(`../lib/client.js?case=parsers`);
  return result;
})();

// ---------------------------------------------------------------------------
// parser unit behaviour
// ---------------------------------------------------------------------------

test("parseLedgerTable consumes the real /ledger summary output", () => {
  const parsed = parsers.parseLedgerTable(summaryReportText());
  assert.ok(parsed, "the real report must parse");
  assert.match(parsed.headline, /^Session compactions: 2 recorded/);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(
    { trigger: parsed.rows[0].trigger, status: parsed.rows[0].status, items: parsed.rows[0].items, tokens: parsed.rows[0].tokens },
    { trigger: "auto", status: "success", items: "2", tokens: "4.1k" },
  );
  assert.equal(parsed.rest, "");
});

test("parseLedgerTable keeps the full-mode detail as rest", () => {
  const parsed = parsers.parseLedgerTable(fullReportText());
  assert.ok(parsed);
  assert.equal(parsed.rows.length, 1);
  assert.match(parsed.rest, /Compaction 1/);
  assert.match(parsed.rest, /Refactor summary\./);
});

test("parseLedgerTable returns null for the empty-state report", () => {
  const text = "Session compactions: none recorded yet — the ledger fills when context pressure triggers compaction.";
  assert.equal(parsers.parseLedgerTable(text), null);
});

test("parseLedgerTable returns null on malformed rows", () => {
  const text = ["Session compactions: 1 recorded", "", "| # | Time |", "| --- | --- |", "| 1 | only-two-cells |"].join("\n");
  assert.equal(parsers.parseLedgerTable(text), null);
});

test("parseTokenText inverts fmtTokens", () => {
  const { parseTokenText } = parsers;
  assert.equal(parseTokenText("0"), 0);
  assert.equal(parseTokenText("2.6k"), 2_600);
  assert.equal(parseTokenText("4.1k"), 4_100);
  assert.equal(parseTokenText("1.2M"), 1_200_000);
  assert.equal(parseTokenText("17"), 17);
  assert.equal(parseTokenText("garbage"), 0);
});

test("parseRecallItems consumes the real recall_pruned output", async () => {
  const parsed = parsers.parseRecallItems(await recallReportText());
  assert.ok(parsed, "the real recall output must parse");
  assert.match(parsed.headline, /^Recalled 2 items/);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].seq, "9");
  assert.equal(parsed.items[0].role, "user");
  assert.equal(parsed.items[1].text, "first message");
  assert.equal(parsed.notice, null);
});

test("parseRecallItems returns null for the ledger list mode", () => {
  const list = "The session ledger records 1 compaction entry:\n- #1 id `x`";
  assert.equal(parsers.parseRecallItems(list), null);
});

// ---------------------------------------------------------------------------
// host→client format contract: whatever report.js/recall.js render must parse.
// ---------------------------------------------------------------------------

test("every /ledger mode output either parses or is json-fenced", async () => {
  for (const mode of ["summary", "full"]) {
    const text = mode === "summary" ? summaryReportText() : fullReportText();
    assert.ok(parsers.parseLedgerTable(text), `${mode} report must parse`);
  }
  const recall = await recallReportText();
  assert.ok(parsers.parseRecallItems(recall), "recall output must parse");
});

// ---------------------------------------------------------------------------
// rich rendering
// ---------------------------------------------------------------------------

test("a parseable /ledger report renders the styled grid with badges and bars", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("ledger");
  const tree = render(card({ node: { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text: summaryReportText() } } }));

  const rows = findAll(tree, "div").filter((n) => n.props.style?.display === "grid");
  assert.ok(rows.length >= 3, "header + 2 data rows render as grid rows");
  // status badges carry the success palette
  const badges = findAll(tree, "span").filter((n) => n.props.style?.color === "#3d9a42");
  assert.equal(badges.length, 2);
  // trigger chips: C-1 auto, C-2 auto
  const autoChips = findAll(tree, "span").filter((n) => n.props.style?.color === "#7a7a7a");
  assert.equal(autoChips.length, 2);
  // token bars: the 4.1k row's fill is wider than the 1.2k row's
  const fills = findAll(tree, "div").filter((n) => typeof n.props.style?.width === "string" && n.props.style.width.endsWith("%"));
  assert.equal(fills.length, 2);
  const w1 = Number.parseFloat(fills[0].props.style.width);
  const w2 = Number.parseFloat(fills[1].props.style.width);
  assert.equal(w1, 100);
  assert.ok(w2 > 0 && w2 < 50);
  // no raw markdown node in the rich path
  assert.equal(findOne(tree, "markdown"), null);
});

test("a full report renders the grid plus markdown detail below", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("ledger");
  const tree = render(card({ node: { kind: "command", name: "ledger", args: "full", outcome: { kind: "success", text: fullReportText() } } }));
  const rows = findAll(tree, "div").filter((n) => n.props.style?.display === "grid");
  assert.ok(rows.length >= 2);
  assert.equal(findOne(tree, "markdown").props.text.includes("Refactor summary."), true);
});

test("failed and running statuses map to their own badge colors", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("ledger");
  const text = [
    "Session compactions: 2 recorded (0 ok, 1 failed) · ~2k tokens shadowed · 0 tool results pruned",
    "",
    "| # | Time | Trigger | Status | Items | Tokens | Took |",
    "| ---: | --- | --- | --- | ---: | ---: | ---: |",
    "| 1 | 00:31:43 | manual | failed | 17 | 1k | 1s |",
    "| 2 | 00:32:00 | auto | running | 0 | 0 | … |",
  ].join("\n");
  const tree = render(card({ node: { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text } } }));
  const colors = findAll(tree, "span").map((n) => n.props.style?.color);
  assert.ok(colors.includes("#d64545"), "failed badge is red");
  assert.ok(colors.includes("#b8860b"), "running badge is amber");
  assert.ok(colors.includes("#3b7bbf"), "manual chip is blue");
});

test("an unparseable report falls back to markdown rendering", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("ledger");
  const text = "Session compactions: none recorded yet — nothing to tabulate.";
  const tree = render(card({ node: { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text } } }));
  assert.equal(findOne(tree, "markdown").props.text, text);
  assert.equal(findAll(tree, "div").filter((n) => n.props.style?.display === "grid").length, 0);
});

test("a recall_pruned result renders per-item cards with seq and role chips", async () => {
  const { componentFor, render } = await loadClient();
  const row = componentFor("recall_pruned");
  const text = await recallReportText();
  const tree = render(
    row({ phase: "result", toolName: "recall_pruned", block: { kind: "tool-result", content: [{ type: "text", text }], isError: false, call: { name: "recall_pruned", argsRaw: "{}" } } }),
  );
  const cards = findAll(tree, "div").filter((n) => n.props.style?.borderRadius === 8);
  assert.equal(cards.length, 2, "one card per recalled item");
  const chips = findAll(tree, "span").filter((n) => n.props.style?.background === "rgba(128,128,128,.18)");
  assert.deepEqual(chips.map((c) => c.props.children), ["seq 9", "seq 8"]);
  assert.equal(findOne(tree, "markdown"), null);
});

test("a recall truncation notice renders as the amber banner", async () => {
  const { componentFor, render } = await loadClient();
  const row = componentFor("recall_pruned");
  const base = await recallReportText();
  const text = `${base}\nStopped at the 20000-char recall budget — raise maxChars or narrow with search for more.`;
  const tree = render(
    row({ phase: "result", toolName: "recall_pruned", block: { kind: "tool-result", content: [{ type: "text", text }], isError: false, call: null } }),
  );
  const banner = findOne(tree, "div").props.children;
  const banners = findAll(tree, "div").filter((n) => n.props.style?.color === "#b8860b");
  assert.equal(banners.length, 1);
  assert.match(banners[0].props.children, /Stopped at the 20000-char recall budget/);
});

test("rich cards survive missing primitives via the plain card, and markdown failures still degrade", async () => {
  const { componentFor, render } = await loadClient({ withPrimitives: false });
  const card = componentFor("ledger");
  const text = summaryReportText();
  const tree = render(card({ node: { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text } } }));
  // DisclosureRow is unavailable → plain monospace card, still the full report
  assert.equal(findOne(tree, "disclosure"), null);
  assert.equal(findOne(tree, "pre").props.children, text);

  const { componentFor: componentFor2, render: render2 } = await loadClient({ markdownThrows: true });
  const card2 = componentFor2("ledger");
  // rich path does not touch MarkdownText for summary (rest is empty)
  const tree2 = render2(card2({ node: { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text } } }));
  assert.ok(findAll(tree2, "div").filter((n) => n.props.style?.display === "grid").length >= 2);
});
