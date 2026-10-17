import assert from "node:assert/strict";
import test from "node:test";
import { buildRecall, buildList, pickEntry, RecallError } from "../lib/recall.js";
import { applyEvent } from "../lib/fold.js";

const ev = (type, data, time, seq) => ({ type, data, time, seq });

/** Build fold state from a compaction sequence (no pruned tool results). */
function ledgerState() {
  const events = [
    ev("compaction/start", { compactionId: "C-A" }, 1_100, 12),
    ev("compaction/summary", {
      compactionId: "C-A",
      summary: [{ type: "text", text: "s" }],
      shadowedSeqs: [2, 5, 11, 14],
      shadowedTokenCount: 4_100,
      provider: "deepseek",
      model: "v4",
    }, 1_110, 15),
    ev("compaction/end", { compactionId: "C-A" }, 1_140, 16),
  ];
  return events.reduce((state, e) => applyEvent(state, e, {}), null);
}

/** Same ledger with one pruned tool result (seq 11, tool bash). */
function ledgerStateWithPrune() {
  const events = [
    ev("tool/call", { callId: "c1", name: "bash" }, 1_000, 10),
    ev("compaction/start", { compactionId: "C-A" }, 1_100, 12),
    ev("compaction/prune", { shadowedSeqs: [11], shadowedTokenCount: 120 }, 1_101, 13),
    ev("tool/result", { message: { source: { callId: "c1", name: "bash" }, content: [{ type: "text", text: "pruned" }] } }, 1_102, 14),
    ev("compaction/summary", {
      compactionId: "C-A",
      summary: [{ type: "text", text: "s" }],
      shadowedSeqs: [2, 5, 11, 14],
      shadowedTokenCount: 4_100,
      provider: "deepseek",
      model: "v4",
    }, 1_110, 15),
    ev("compaction/end", { compactionId: "C-A" }, 1_140, 16),
  ];
  return events.reduce((state, e) => applyEvent(state, e, {}), null);
}

/** In-memory event store: seq → event, dense paged reads (like the real JSONL log). */
function fakeStore(eventsBySeq) {
  const maxSeq = Math.max(...eventsBySeq.keys());
  return async (offset, length) => {
    const out = [];
    for (let i = 0; i < length && offset + i <= maxSeq; i += 1) {
      const seq = offset + i;
      const e = eventsBySeq.get(seq);
      // Dense fill: positions without an interesting event still come back,
      // the way a real log read returns every event in the requested range.
      out.push(e ? { ...e, seq: undefined } : ev("turn/start", { turn: 0 }, 0));
    }
    return out;
  };
}

const toolEvent = (text) => ev("tool/result", { message: { source: { callId: "c1", name: "bash" }, content: [{ type: "text", text }] } }, 0);
const userEvent = (text) => ev("user/message", { content: [{ type: "text", text }], role: "user" }, 0);

test("pickEntry prefers completed entries; falls back to any; matches by id", () => {
  const state = ledgerState();
  assert.equal(pickEntry(state, "last").compactionId, "C-A");
  assert.equal(pickEntry(state, "C-A").compactionId, "C-A");
  assert.equal(pickEntry(state, "C-nope"), null);
  assert.equal(pickEntry(null, "last"), null);

  const running = [ev("compaction/start", { compactionId: "C-R" }, 1, 0)].reduce((s, e) => applyEvent(s, e, {}), null);
  // A still-running bracket has nothing settled to recall yet.
  assert.equal(pickEntry(running, "last"), null);
});

test("buildList summarizes the ledger with ids", () => {
  const text = buildList(ledgerState());
  assert.match(text, /1 compaction entr/);
  assert.match(text, /`C-A`/);
  assert.match(text, /auto · success/);
  assert.match(text, /recall_pruned/);
  assert.match(buildList(null), /No compaction has been recorded/);
});

test("recall with pruned items returns the tool result content", async () => {
  const { report, items, truncated } = await buildRecall({
    state: ledgerStateWithPrune(),
    readEvents: fakeStore(new Map([[11, toolEvent("npm test output: 41 passing")], [14, userEvent("please fix the flaky test")]])),
    compactionId: "last",
  });
  assert.equal(truncated, false);
  assert.deepEqual(items, [11]);
  const first = report.split("\n")[0];
  assert.match(first, /^Recalled 1 item from the compaction/);
  assert.doesNotMatch(first, /[#|`*]/);
  assert.match(report, /npm test output: 41 passing/);
  assert.match(report, /seq 11 · tool bash/);
  // pruned items take priority over the shadowed span
  assert.doesNotMatch(report, /flaky test/);
});

test("recall without pruned items walks the shadowed span newest-first", async () => {
  const store = new Map([
    [2, userEvent("first user message")],
    [5, userEvent("second user message")],
    [11, toolEvent("npm test output")],
    [14, userEvent("latest message")],
  ]);
  const { report, items } = await buildRecall({ state: ledgerState(), readEvents: fakeStore(store), compactionId: "C-A", maxChars: 100_000 });
  assert.deepEqual(items, [14, 11, 5, 2]);
  assert.ok(report.indexOf("latest message") < report.indexOf("second user message"));
  assert.match(report, /seq 14 · user/);
});

test("search filter keeps only matching items", async () => {
  const store = new Map([
    [2, userEvent("alpha topic")],
    [5, userEvent("beta payload")],
  ]);
  const { report, items } = await buildRecall({ state: ledgerState(), readEvents: fakeStore(store), compactionId: "C-A", search: "BETA", maxChars: 100_000 });
  assert.deepEqual(items, [5]);
  assert.match(report, /Filter: "BETA"\./);
  assert.match(report, /beta payload/);
  assert.doesNotMatch(report, /alpha topic/);
});

test("maxChars budget truncates the recall and reports it", async () => {
  const big = "y".repeat(10_000);
  const store = new Map([
    [2, userEvent(big)],
    [5, userEvent(big)],
  ]);
  const { items, truncated } = await buildRecall({ state: ledgerState(), readEvents: fakeStore(store), compactionId: "C-A", maxChars: 12_000 });
  assert.equal(items.length, 1);
  assert.equal(truncated, true);
});

test("no matching content raises a RecallError with a clear message", async () => {
  const store = new Map([[2, userEvent("alpha")]]);
  await assert.rejects(
    buildRecall({ state: ledgerState(), readEvents: fakeStore(store), compactionId: "C-A", search: "zzz" }),
    (error) => error instanceof RecallError && /no recallable content/.test(error.message),
  );
});

test("unknown id raises; empty ledger raises", async () => {
  await assert.rejects(
    buildRecall({ state: ledgerState(), readEvents: fakeStore(new Map()), compactionId: "C-nope" }),
    (error) => error instanceof RecallError && /no compaction with id/.test(error.message),
  );
  await assert.rejects(
    buildRecall({ state: null, readEvents: fakeStore(new Map()) }),
    (error) => error instanceof RecallError && /no compaction is recorded/.test(error.message),
  );
});

test("paged reads fetch across page boundaries", async () => {
  const store = new Map();
  for (let seq = 0; seq <= 2_500; seq += 1) store.set(seq, userEvent(`item ${seq}`));
  const state = [
    ev("compaction/start", { compactionId: "C-S" }, 1, 0),
    ev("compaction/summary", { compactionId: "C-S", summary: [], shadowedSeqs: [2_400, 2_500], shadowedTokenCount: 1 }, 2, 1),
  ].reduce((s, e) => applyEvent(s, e, {}), null);
  const { items } = await buildRecall({ state, readEvents: fakeStore(store), compactionId: "C-S", maxChars: 100_000 });
  assert.deepEqual(items, [2_500, 2_400]);
});

test("non-text-only events render the no-text placeholder", async () => {
  const store = new Map([[11, ev("tool/result", { message: { source: { callId: "c1", name: "screenshot" }, content: [{ type: "image", url: "x.png" }] } }, 0)]]);
  const { report } = await buildRecall({ state: ledgerState(), readEvents: fakeStore(store), compactionId: "C-A" });
  assert.match(report, /no text content/);
});
