# dsh-compaction-ledger

[![npm](https://img.shields.io/npm/v/dsh-compaction-ledger)](https://www.npmjs.com/package/dsh-compaction-ledger)

Compaction audit & recall for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the bridge back to what a context compaction took away.

When DSH compacts a conversation, older history is shadowed out of the model's visible context. The durable session log keeps every shadowed event verbatim ("compaction hides superseded entries without deleting them"), but nothing in the harness reads it back: the model loses the content, and the user sees only a marker with two numbers. This plugin turns each compaction into a **ledger entry** — and gives both sides a way back:

- **`recall_pruned`** (model tool) — lists the recorded compactions, then pulls the shadowed content back from the session log by exact log address (`seq`), with an optional search filter and a char budget. The model regains what it lost, on demand.
- **`/ledger`** (slash command) — every compaction in the session: when it ran, what triggered it (manual `/compact` vs. automatic pressure), whether it succeeded, how many history items and tokens it shadowed, which individual tool results were pruned, and the summarizer route. `/ledger full` adds per-entry detail; `/ledger json` is machine-readable; `/ledger restore [last|<id>]` injects a recall pointer so the model knows it can fetch the content back.

Zero extra LLM calls. Zero extra storage — everything is folded from the session's own durable event stream.

![The /ledger report before and after a real compaction, rendered as a Markdown table in the chat](docs/ledger.png)

## Why

DSH Discussions record the same failure repeatedly: compaction silently truncates, the model "forgets" decisions and tool outputs from earlier in the session, and neither side can tell what was lost ([#3201](https://github.com/deepseek-ai/deepseek-harness/discussions/3201), [#3542](https://github.com/deepseek-ai/deepseek-harness/discussions/3542), [#4578](https://github.com/deepseek-ai/deepseek-harness/discussions/4578)). Meanwhile `billion-context` — a plugin whose entire premise is replacing the compressor — is the most-downloaded plugin in the ecosystem. But replacing the compressor is a different bet: this plugin is **compressor-agnostic**. Whether DSH's stock compaction ran, or a third-party one, the shadowed content sits in the log at exact addresses, and this ledger reads it back.

## What you get

- **`Ledger` tab** — a real tab beside Chat and Trajectory: the session's compaction timeline as a live page, updated by the host-pushed projection (no polling). Totals band plus one expandable card per compaction — summary preview and pruned tool results on expansion. ![The Ledger tab](docs/ledger-tab.png)
- **`/ledger`** — headline + table: `# | Time | Trigger | Status | Items | Tokens | Took`
- **`/ledger full`** — per-entry detail: error chains for failed compactions, the summary preview with its provider/model, and the pruned tool-result list (tool name, seq, token estimate)
- **`/ledger json`** — the whole ledger as JSON for scripts and dashboards
- **`/ledger restore last`** — injects a pointer message ("a compaction shadowed N items; use recall_pruned with this compactionId") into the running session without waking a turn
- **`recall_pruned`** — model tool; no arguments lists the ledger, `{ compactionId }` recalls the shadowed content (pruned tool results first, otherwise the shadowed span, newest-first), `{ search }` filters by substring, `{ maxChars }` bounds the recall
- **Rendered output** — the report and the recall result render as styled native cards in the chat (status badges, trigger chips, token bars, per-item recall cards)

## How it works

One pure [session projection](https://github.com/deepseek-ai/deepseek-harness) folds the `compaction/start` → `compaction/prune` → `compaction/summary` → `compaction/end` event brackets plus the adjacent replacement `tool/result` appends into:

- per-entry records: trigger (manual/auto, derived from `sourceCommandId`), status and error chain, summarizer route, `shadowedSeqs` (the exact log addresses of what was shadowed), per-item pruned results with their `callId`-resolved tool names;
- whole-session totals, never trimmed.

`recall_pruned` reads the original events back through the official persistence path (`ctx.sessionPersistence`, read-only handle) — never the raw log files, never message data outside the recorded seqs.

### Verified end to end

On a live desktop session: `/compact` compacted 17 history items (~2.6k tokens) → `/ledger` showed `1 recorded (1 ok, 0 failed) · ~2.6k tokens shadowed`, trigger `manual`, `5.42s` → `recall_pruned` returned all 17 shadowed items and the model quoted the pre-compaction user message verbatim. The fold and the recall path run against the exact event shapes emitted by DSH `0.2.0-rc.2`.

## Rendering

The report renders through the chat's Markdown renderer (`conversation.chat.commandview`), and a `recall_pruned` call renders through the tool-call slot (`tool.call.toolview`). Cards degrade to monospace text if the client half is unavailable. The official compaction transcript marker is left untouched.

Upgrading from a build without the client half? The composition cache holds a package's client declaration for the lifetime of the process — a full app restart (not a page reload) is needed before the slots load.

## Install

Inside DSH (Plugins page, plugin manager tool, or CLI):

```
dsh plugin --profile <profile> add dsh-compaction-ledger
```

## Configuration

```yaml
- id: compaction-ledger
  name: dsh-compaction-ledger
  config:
    detailEntries: 50        # per-entry detail kept (totals always cover everything)
    recallMaxChars: 20000    # default recall budget for the model tool
    summaryPreviewChars: 200 # summary preview kept per entry
    restoreEnabled: true     # /ledger restore
    language: en             # report language: en | zh
```

## Notes & limitations

- The ledger records what the harness's compaction brackets report. A compaction whose events never landed (e.g. an app crash mid-bracket) shows as `running` — the unmatched start is detectable by design.
- Recall reads only the session's own log. Cross-session recall is out of scope by design: the ledger is the bridge back into *this* conversation.
- The recall budget caps how much the model can pull back per call; the content itself is never lost from the log.

## Compatibility

- DSH `0.2.0-rc.1` and later `0.2.0-rc.x` (peer range `^0.2.0-rc.1`), cordis `^4.0.1`, Node ≥ 20.
- Plain ESM host half with no build step; hand-written classic-script client half (no bundler).

## Development

```
node --test      # 53 unit tests over the fold/report/recall layers and the client half
npm run sync     # copy into local dev/desktop profiles
```

## License

MIT — see [LICENSE](./LICENSE).
