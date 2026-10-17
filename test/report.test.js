import assert from "node:assert/strict";
import test from "node:test";
import { parseMode, renderReport, USAGE } from "../lib/report.js";
import { applyEvent } from "../lib/fold.js";

const ev = (type, data, time, seq) => ({ type, data, time, seq });

const cfg = { language: "en" };

function sampleState() {
  const events = [
    ev("tool/call", { callId: "c1", name: "bash" }, 900, 9),
    ev("compaction/start", { compactionId: "C-1" }, 1_000, 0),
    ev("compaction/prune", { shadowedSeqs: [11], shadowedTokenCount: 120 }, 1_001, 1),
    ev("tool/result", { message: { source: { callId: "c1", name: "bash" }, content: [{ type: "text", text: "head…[...]…tail" }] } }, 1_002, 2),
    ev("compaction/summary", {
      compactionId: "C-1",
      summary: [{ type: "text", text: "Refactor summary." }],
      shadowedSeqs: [2, 5, 11],
      shadowedTokenCount: 4_100,
      provider: "deepseek",
      model: "deepseek-v4-pro",
    }, 1_010, 3),
    ev("compaction/end", { compactionId: "C-1" }, 1_040, 4),
  ];
  return events.reduce((state, e) => applyEvent(state, e, {}), null);
}

test("parseMode accepts the documented grammar", () => {
  assert.deepEqual(parseMode(""), { action: "summary", arg: null });
  assert.deepEqual(parseMode("  "), { action: "summary", arg: null });
  assert.deepEqual(parseMode("summary"), { action: "summary", arg: null });
  assert.deepEqual(parseMode("full"), { action: "full", arg: null });
  assert.deepEqual(parseMode("JSON"), { action: "json", arg: null });
  assert.deepEqual(parseMode("restore"), { action: "restore", arg: "last" });
  assert.deepEqual(parseMode("restore last"), { action: "restore", arg: "last" });
  assert.deepEqual(parseMode("restore C-abc-123"), { action: "restore", arg: "C-abc-123" });
  assert.equal(parseMode("restore a b"), null);
  assert.equal(parseMode("wat"), null);
  assert.equal(parseMode("summary extra"), null);
});

test("empty state renders the pointer text", () => {
  const text = renderReport(null, cfg, "summary");
  assert.match(text, /none recorded yet/);
  assert.equal(text.split("\n").length, 1);
});

test("summary renders a plain-prose headline and the entries table", () => {
  const text = renderReport(sampleState(), cfg, "summary");
  const first = text.split("\n")[0];
  assert.match(first, /^Session compactions: 1 recorded \(1 ok, 0 failed\)/);
  assert.match(first, /~4\.1k tokens shadowed/);
  assert.match(first, /1 tool results? pruned/);
  // headline contract: no markdown markers on the first line
  assert.doesNotMatch(first, /[#|`*]/);
  assert.match(text, /\| 1 \|/);
  assert.match(text, /auto/);
  assert.match(text, /success/);
});

test("full adds per-entry details with the pruned tool row", () => {
  const text = renderReport(sampleState(), cfg, "full");
  assert.match(text, /Compaction 1/);
  assert.match(text, /Refactor summary\./);
  assert.match(text, /`bash` · seq 11 · ~120 tokens/);
});

test("json returns a stable machine contract", () => {
  const text = renderReport(sampleState(), cfg, "json");
  const payload = JSON.parse(text);
  assert.equal(payload.totals.count, 1);
  assert.equal(payload.totals.tokensShadowed, 4_100);
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].compactionId, "C-1");
  assert.ok(text.endsWith("\n"));
});

test("json empty state is a status object", () => {
  const payload = JSON.parse(renderReport(null, cfg, "json"));
  assert.equal(payload.status, "empty");
});

test("a running bracket renders even with zero completed compactions", () => {
  const state = [ev("compaction/start", { compactionId: "C-R" }, 1_000, 0)].reduce((s, e) => applyEvent(s, e, {}), null);
  const text = renderReport(state, cfg, "summary");
  assert.match(text.split("\n")[0], /^Session compactions: 0 recorded/);
  assert.match(text, /running/);
});

test("failed compaction shows the error in full mode", () => {
  const state = [
    ev("compaction/start", { compactionId: "C-F" }, 1_000, 0),
    ev("compaction/end", { compactionId: "C-F", error: "aborted: boom" }, 1_050, 1),
  ].reduce((s, e) => applyEvent(s, e, {}), null);
  const text = renderReport(state, cfg, "full");
  assert.match(text, /failed/);
  assert.match(text, /aborted: boom/);
});

test("chinese language renders translated strings", () => {
  const text = renderReport(sampleState(), { language: "zh" }, "summary");
  assert.match(text.split("\n")[0], /^会话压缩：共 1 次/);
});

test("USAGE string documents both actions", () => {
  assert.match(USAGE, /summary\|full\|json/);
  assert.match(USAGE, /restore/);
});
