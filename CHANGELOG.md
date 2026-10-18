# Changelog

## 0.2.0 (2026-10-18)

The Ledger conversation-view tab.

- **`Ledger` tab** — a real tab beside Chat and Trajectory (`conversation.view` slot, `order: 5`): the session's compaction timeline as a live page. Totals band (count, ok/failed, tokens shadowed, pruned results) plus one expandable card per compaction — time, trigger chip, status badge, token stats, and on expansion the summary preview and the pruned tool-result list.
- **Live by projection** — the tab reads the `compactionLedger` wire projection through the standard `useProjection` prop: host-computed, pushed per session, zero RPC and zero client-side folding. The wire view now carries the bounded recent entries (last 20, pruned list capped at 10 per entry); the host fold state shape is unchanged.
- **Empty state** — a dashed placeholder explaining when the ledger fills, with the `/compact` pointer, and a hint card on how to pull shadowed content back via `recall_pruned`.
- Fully localized (en/zh) including card chrome; cards degrade gracefully when the client half is unavailable.

## 0.1.1 (2026-10-18)

Styled native cards for the ledger and recall results.

- **`/ledger` table** — custom grid instead of a raw Markdown table: colored status badges (success/failed/running), trigger chips with icons (manual/auto), per-row token-share bars, right-aligned monospace numerals, row hover separation. Full-mode detail keeps Markdown below the grid.
- **`recall_pruned` cards** — each recalled item renders as its own card with a `seq` chip, a role badge (user/assistant/tool), a scroll-bounded monospace body, and an amber banner for truncation notices.
- **Format contract** — the client parses the host's deterministic report text; the parsers are pinned by cross-layer sync tests that feed the real `renderReport`/`buildRecall` output through them on every test run. Any parse miss falls back to Markdown rendering, and missing primitives still degrade to monospace — the card can only get simpler, never broken.

## 0.1.0 (2026-10-18)

Initial release.

- **`compactionLedger` session projection** — folds `compaction/start|prune|summary|end` brackets plus adjacent replacement `tool/result` appends into per-entry ledger records (trigger, status, error chain, summarizer route, shadowed seqs, pruned tool results with callId-resolved tool names) and never-trimmed session totals.
- **`recall_pruned` model tool** — lists the ledger with no arguments; recalls the shadowed content of one compaction from the durable log via `ctx.sessionPersistence`, newest-first, with `search` filtering and a `maxChars` budget.
- **`/ledger` slash command** — `summary` (headline + table), `full` (per-entry detail), `json` (machine-readable), and `restore [last|<compactionId>]` (injects a recall pointer into the running session without waking a turn).
- **Client rendering** — the command card and the `recall_pruned` tool card render as real Markdown through the chat slots, with error-boundary and monospace degradation; the official compaction transcript marker is untouched.
- Verified end to end on DSH `0.2.0-rc.2`: real `/compact` → ledger entry → verbatim recall of pre-compaction content.
