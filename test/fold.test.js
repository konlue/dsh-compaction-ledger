import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, emptyState, wireView, STATE_VERSION, DEFAULT_DETAIL_ENTRIES } from "../lib/fold.js";

const ev = (type, data, time, seq) => ({ type, data, time, seq });

const fold = (events, opts) => events.reduce((state, e) => applyEvent(state, e, opts), null);

/** A canonical successful auto compaction with one pruned tool result. */
function autoCompactionEvents(overrides = {}) {
  const t = overrides.t0 ?? 1_000;
  return [
    ev("tool/call", { callId: "c1", name: "bash", turn: 1, step: 1 }, t, 10),
    ev("tool/result", { message: { source: { callId: "c1", name: "bash" }, content: [{ type: "text", text: "output" }] } }, t + 10, 11),
    ev("compaction/start", { compactionId: "C-A" }, t + 20, 12),
    ev("compaction/prune", { shadowedRange: { start: 11, end: 11 }, shadowedSeqs: [11], shadowedTokenCount: 120 }, t + 21, 13),
    ev("tool/result", { message: { source: { callId: "c1", name: "bash" }, content: [{ type: "text", text: "head…[...]…tail" }] } }, t + 22, 14),
    ev("compaction/summary", {
      compactionId: "C-A",
      summary: [{ type: "text", text: "The user asked to refactor." }],
      shadowedRange: { start: 2, end: 14 },
      shadowedSeqs: [2, 5, 8, 11, 14],
      shadowedTokenCount: 4_100,
      provider: "deepseek",
      model: "deepseek-v4-pro",
    }, t + 30, 15),
    ev("compaction/end", { compactionId: "C-A" }, t + 40, 16),
  ];
}

test("state version and defaults", () => {
  assert.equal(STATE_VERSION, 1);
  assert.equal(DEFAULT_DETAIL_ENTRIES >= 1, true);
});

test("irrelevant events keep the state reference unchanged", () => {
  const state = fold(autoCompactionEvents());
  for (const type of ["turn/start", "step/end", "assistant/message", "llm/retry-started", "session/created"]) {
    assert.equal(applyEvent(state, ev(type, {}, 1, 999)), state);
  }
  // ordinary tool results (no preceding prune) are irrelevant too
  assert.equal(applyEvent(state, ev("tool/result", { message: {} }, 1, 999)), state);
});

test("null state stays null through irrelevant events", () => {
  assert.equal(applyEvent(null, ev("turn/start", { turn: 1 }, 1, 0)), null);
});

test("auto compaction folds into one success entry with pruned tool identity", () => {
  const state = fold(autoCompactionEvents());
  assert.equal(state.entries.length, 1);
  const entry = state.entries[0];
  assert.equal(entry.compactionId, "C-A");
  assert.equal(entry.trigger, "auto");
  assert.equal(entry.status, "success");
  assert.equal(entry.startSeq, 12);
  assert.equal(entry.summarySeq, 15);
  assert.equal(entry.endSeq, 16);
  assert.equal(entry.wallMs, 20);
  assert.equal(entry.shadowedCount, 5);
  assert.equal(entry.shadowedTokens, 4_100);
  assert.deepEqual(entry.shadowedSeqs, [2, 5, 8, 11, 14]);
  assert.equal(entry.summaryPreview, "The user asked to refactor.");
  assert.equal(entry.provider, "deepseek");
  assert.equal(entry.model, "deepseek-v4-pro");
  // the pruned item resolved its callId and tool name from the adjacent replacement
  assert.equal(entry.pruned.length, 1);
  assert.equal(entry.pruned[0].seq, 11);
  assert.equal(entry.pruned[0].callId, "c1");
  assert.equal(entry.pruned[0].tool, "bash");
  assert.equal(entry.pruned[0].tokens, 120);

  // totals: tokens/items accumulate from the summary only (no prune double-count)
  assert.deepEqual(state.totals, {
    count: 1,
    success: 1,
    failed: 1 - 1,
    tokensShadowed: 4_100,
    itemsShadowed: 5,
    prunedResults: 1,
  });
  assert.equal(state.open, null);
});

test("manual trigger is derived from sourceCommandId", () => {
  const state = fold([
    ev("compaction/start", { compactionId: "C-M", sourceCommandId: "cmd-1" }, 1_000, 0),
    ev("compaction/summary", { compactionId: "C-M", summary: [], shadowedSeqs: [1], shadowedTokenCount: 10, provider: "p", model: "m" }, 1_010, 1),
    ev("compaction/end", { compactionId: "C-M", sourceCommandId: "cmd-1" }, 1_020, 2),
  ]);
  assert.equal(state.entries[0].trigger, "manual");
  assert.equal(state.totals.success, 1);
});

test("failed compaction records the error and totals", () => {
  const state = fold([
    ev("compaction/start", { compactionId: "C-F" }, 1_000, 0),
    ev("compaction/end", { compactionId: "C-F", error: "DeepSeek request aborted by caller: boom" }, 1_050, 1),
  ]);
  const entry = state.entries[0];
  assert.equal(entry.status, "failed");
  assert.equal(entry.error, "DeepSeek request aborted by caller: boom");
  assert.equal(entry.summarySeq, null);
  assert.equal(entry.shadowedCount, 0);
  assert.deepEqual(state.totals, {
    count: 1,
    success: 0,
    failed: 1,
    tokensShadowed: 0,
    itemsShadowed: 0,
    prunedResults: 0,
  });
});

test("a still-running bracket is exposed via open and wire view", () => {
  const state = fold([
    ev("compaction/start", { compactionId: "C-R" }, 1_000, 0),
    ev("compaction/prune", { shadowedSeqs: [3], shadowedTokenCount: 50 }, 1_001, 1),
  ]);
  assert.equal(state.open, "C-R");
  assert.equal(state.entries[0].status, "running");
  assert.equal(state.entries[0].wallMs, null);
  const view = wireView(state);
  assert.equal(view.running, true);
  assert.equal(view.count, 0);
  assert.equal(view.prunedResults, 1);
});

test("unresolved pruned item (replacement never appended) keeps callId null", () => {
  const state = fold([
    ev("compaction/start", { compactionId: "C-X" }, 1_000, 0),
    ev("compaction/prune", { shadowedSeqs: [7], shadowedTokenCount: 9 }, 1_001, 1),
    ev("compaction/summary", { compactionId: "C-X", summary: [], shadowedSeqs: [7], shadowedTokenCount: 9 }, 1_002, 2),
    ev("compaction/end", { compactionId: "C-X" }, 1_003, 3),
  ]);
  assert.equal(state.entries[0].pruned[0].callId, null);
  assert.equal(state.entries[0].pruned[0].tool, null);
  // totals unaffected
  assert.equal(state.totals.prunedResults, 1);
});

test("a tool/result that is not adjacent to the prune never resolves it", () => {
  const state = fold([
    ev("compaction/start", { compactionId: "C-G" }, 1_000, 0),
    ev("compaction/prune", { shadowedSeqs: [7], shadowedTokenCount: 9 }, 1_001, 1),
    ev("tool/result", { message: { source: { callId: "zz", name: "read_file" }, content: [] } }, 1_010, 5),
  ]);
  assert.equal(state.entries[0].pruned[0].callId, null);
  assert.equal(state.lastPruneSeq, 1);
});

test("prune events for an unknown/trimmed bracket still count in totals", () => {
  const state = fold([
    ev("compaction/prune", { shadowedSeqs: [7], shadowedTokenCount: 9 }, 1_001, 0),
  ]);
  assert.equal(state.totals.prunedResults, 1);
  assert.equal(state.entries.length, 0);
});

test("detail cap trims oldest entries but totals survive", () => {
  const events = [];
  let seq = 0;
  for (let i = 0; i < 6; i += 1) {
    events.push(ev("compaction/start", { compactionId: `C-${i}` }, 1_000 + i * 100, seq++));
    events.push(ev("compaction/summary", { compactionId: `C-${i}`, summary: [{ type: "text", text: `s${i}` }], shadowedSeqs: [seq], shadowedTokenCount: 10 }, 1_050 + i * 100, seq++));
    events.push(ev("compaction/end", { compactionId: `C-${i}` }, 1_060 + i * 100, seq++));
  }
  const state = fold(events, { detailEntries: 3 });
  assert.equal(state.entries.length, 3);
  assert.equal(state.entries[0].compactionId, "C-3");
  assert.equal(state.entries[2].compactionId, "C-5");
  assert.equal(state.totals.count, 6);
  assert.equal(state.totals.tokensShadowed, 60);
  assert.equal(state.totals.itemsShadowed, 6);
});

test("summary preview is truncated at previewChars", () => {
  const long = "x".repeat(500);
  const state = fold([
    ev("compaction/start", { compactionId: "C-P" }, 1_000, 0),
    ev("compaction/summary", { compactionId: "C-P", summary: [{ type: "text", text: long }], shadowedSeqs: [1], shadowedTokenCount: 5 }, 1_010, 1),
  ], { previewChars: 100 });
  assert.equal(state.entries[0].summaryPreview.length, 100);
  assert.ok(state.entries[0].summaryPreview.endsWith("…"));
});

test("summary preview joins multiple text blocks and skips non-text", () => {
  const state = fold([
    ev("compaction/start", { compactionId: "C-B" }, 1_000, 0),
    ev("compaction/summary", {
      compactionId: "C-B",
      summary: [
        { type: "text", text: "alpha" },
        { type: "image", url: "x" },
        { type: "text", text: "beta" },
      ],
      shadowedSeqs: [1],
      shadowedTokenCount: 5,
    }, 1_010, 1),
  ]);
  assert.equal(state.entries[0].summaryPreview, "alpha\nbeta");
});

test("shadowedSeqs hard cap bounds the stored list", () => {
  const many = Array.from({ length: 5_000 }, (_, i) => i);
  const state = fold([
    ev("compaction/start", { compactionId: "C-CAP" }, 1_000, 0),
    ev("compaction/summary", { compactionId: "C-CAP", summary: [], shadowedSeqs: many, shadowedTokenCount: 1 }, 1_010, 1),
  ]);
  assert.ok(state.entries[0].shadowedSeqs.length < 5_000);
  assert.equal(state.entries[0].shadowedCount, 5_000);
});

test("callId map is FIFO-bounded", () => {
  let seq = 0;
  const events = [];
  for (let i = 0; i < 2_100; i += 1) {
    events.push(ev("tool/call", { callId: `c${i}`, name: "bash" }, i, seq++));
  }
  const state = fold(events);
  assert.equal(Object.keys(state.calls).length, 2_000);
  assert.equal(state.calls.c2099, "bash");
  assert.equal(state.calls.c0, undefined);
});

test("state survives a JSON checkpoint round-trip", () => {
  const state = fold(autoCompactionEvents());
  const restored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(restored, state);
  // and the fold continues cleanly from the restored shape
  const next = applyEvent(restored, ev("compaction/start", { compactionId: "C-2" }, 2_000, 20));
  assert.equal(next.entries.length, 2);
  assert.equal(next.open, "C-2");
});

test("wire view of an empty/absent state is null; totals view carries bounded entries", () => {
  assert.equal(wireView(null), null);
  const view = wireView(fold(autoCompactionEvents()));
  assert.deepEqual(view, {
    count: 1,
    success: 1,
    failed: 0,
    tokensShadowed: 4_100,
    itemsShadowed: 5,
    prunedResults: 1,
    running: false,
    entries: [
      {
        compactionId: "C-A",
        time: 1_040,
        trigger: "auto",
        status: "success",
        items: 5,
        tokens: 4_100,
        took: 20,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        summaryPreview: "The user asked to refactor.",
        error: null,
        pruned: [{ seq: 11, tool: "bash", tokens: 120 }],
      },
    ],
    last: { time: 1_040, trigger: "auto", status: "success", items: 5, tokens: 4_100 },
  });
});

test("wire entries are bounded to the last 20", () => {
  const events = [];
  let seq = 0;
  for (let i = 0; i < 25; i += 1) {
    events.push(ev("compaction/start", { compactionId: `C-${i}` }, 1_000 + i * 100, seq++));
    events.push(ev("compaction/end", { compactionId: `C-${i}` }, 1_060 + i * 100, seq++));
  }
  const view = wireView(fold(events));
  assert.equal(view.entries.length, 20);
  assert.equal(view.entries[0].compactionId, "C-5");
  assert.equal(view.count, 25);
});

test("emptyState is plain JSON and promotable", () => {
  const s = emptyState();
  assert.deepEqual(Object.keys(s.totals), ["count", "success", "failed", "tokensShadowed", "itemsShadowed", "prunedResults"]);
  const next = applyEvent(null, ev("compaction/start", { compactionId: "C" }, 1, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(next)).open, "C");
});
