/**
 * dsh-compaction-ledger — audit and recall for DeepSeek Harness context
 * compaction.
 *
 * Registers one pure session projection (`compactionLedger`) that folds the
 * `compaction/start|prune|summary|end` durable events into a per-compaction
 * ledger, a human-facing `/ledger` slash command (with restore), and a
 * model-facing `recall_pruned` tool that reads the shadowed content back from
 * the durable log. No LLM calls, no extra storage.
 *
 * The durable log retains pre-compaction content verbatim; compaction only
 * shadows it from the model-visible surface. This plugin is the bridge back.
 *
 * @module dsh-compaction-ledger
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { STATE_VERSION, applyEvent, wireView, DEFAULT_DETAIL_ENTRIES, DEFAULT_PREVIEW_CHARS } from "./fold.js";
import { renderReport, parseMode, USAGE } from "./report.js";
import { buildRecall, buildList, pickEntry, RecallError } from "./recall.js";
import { tFor } from "./i18n.js";

const name = "compaction-ledger";

const inject = ["sessionProjections", "commands", "tools", "sessionPersistence"];

const Config = z.object({
  detailEntries: z.number().default(DEFAULT_DETAIL_ENTRIES),
  recallMaxChars: z.number().default(20_000),
  summaryPreviewChars: z.number().default(DEFAULT_PREVIEW_CHARS),
  restoreEnabled: z.boolean().default(true),
  language: z.string().default("en"),
});

/** Permissive checkpoint schema: the fold owns the exact shape. */
const stateSchema = zod.union([zod.null(), zod.object({}).passthrough()]);

const wireSchema = zod
  .object({
    count: zod.number().int().nonnegative(),
    success: zod.number().int().nonnegative(),
    failed: zod.number().int().nonnegative(),
    tokensShadowed: zod.number().int().nonnegative(),
    itemsShadowed: zod.number().int().nonnegative(),
    prunedResults: zod.number().int().nonnegative(),
    running: zod.boolean(),
    last: zod
      .object({
        time: zod.number(),
        trigger: zod.string(),
        status: zod.string(),
        items: zod.number().int().nonnegative(),
        tokens: zod.number().int().nonnegative(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .nullable();

export function normalizeConfig(raw = {}) {
  const detail = Number(raw.detailEntries);
  const maxChars = Number(raw.recallMaxChars);
  const preview = Number(raw.summaryPreviewChars);
  return {
    detailEntries: Number.isFinite(detail) && detail >= 1 ? Math.min(500, Math.floor(detail)) : DEFAULT_DETAIL_ENTRIES,
    recallMaxChars: Number.isFinite(maxChars) && maxChars >= 500 ? Math.min(200_000, Math.floor(maxChars)) : 20_000,
    summaryPreviewChars:
      Number.isFinite(preview) && preview >= 40 ? Math.min(2000, Math.floor(preview)) : DEFAULT_PREVIEW_CHARS,
    restoreEnabled: raw.restoreEnabled !== false,
    language: raw.language === "zh" ? "zh" : "en",
  };
}

const TOOL_DESCRIPTION =
  "Read back content that a context compaction removed from your visible context. " +
  "Call it with no arguments to list the recorded compactions, or with { compactionId } " +
  "(from the list) to pull the shadowed content back from the session log — optionally " +
  "narrow it with { search } and bound it with { maxChars }. Use it whenever you need " +
  "something from before a compaction: earlier tool results, decisions, file contents.";

function sessionOf(agent) {
  return agent?.session ?? agent ?? null;
}

function stateOf(ctx, session) {
  try {
    return ctx.sessionProjections.stateOf(session, "compactionLedger");
  } catch {
    return null;
  }
}

/**
 * Wire the durable-log read for one recall: the official persistence path,
 * opened read-only and closed after the recall completes. Returns null when
 * the persistence service is unavailable.
 */
async function withLogReader(ctx, session, fn) {
  const persistence = ctx.sessionPersistence;
  const id = session?.id ?? session?.sessionId;
  if (!persistence || typeof persistence.open !== "function" || !id) return fn(null);
  const handle = await persistence.open(id, "read");
  try {
    const readEvents = async (offset, length) => {
      const result = await handle.read(offset, length);
      return result?.events ?? [];
    };
    return await fn(readEvents);
  } finally {
    try {
      await handle.close?.();
    } catch {
      // Closing is best-effort; the read already succeeded or failed above.
    }
  }
}

function registerLedgerCommand(ctx, cfg, tr) {
  const definition = (commandName) => ({
    name: commandName,
    description: tr("commandDescription"),
    input: { hint: "[summary|full|json] or restore [last|<compactionId>]" },
    handler: (invocation) => {
      const parsed = parseMode(invocation.rawInput);
      if (parsed === null) {
        return { kind: "error", text: tr("unknownArg", { arg: invocation.rawInput.trim(), usage: USAGE }) };
      }
      const session = sessionOf(invocation.agent);
      if (!session) return { kind: "error", text: tr("noSession") };
      const state = stateOf(ctx, session);

      if (parsed.action !== "restore") {
        return { kind: "success", text: renderReport(state, cfg, parsed.action) };
      }

      if (!cfg.restoreEnabled) {
        return { kind: "error", text: tr("restoreDisabled") };
      }
      const entry = pickEntry(state, parsed.arg);
      if (!entry) {
        if (state && state.entries.length > 0) {
          return { kind: "error", text: tr("restoreNoMatch", { id: parsed.arg }) };
        }
        return { kind: "error", text: tr("restoreNoEntries") };
      }
      const agent = invocation.agent;
      if (typeof agent?.inject !== "function") {
        return { kind: "error", text: tr("restoreUnavailable") };
      }
      const pointer = [
        `[compaction-ledger] The conversation context was compacted (compactionId ${entry.compactionId}; ` +
          `${entry.shadowedCount} shadowed items, ~${Math.round(entry.shadowedTokens)} tokens` +
          `${entry.pruned.length > 0 ? `, ${entry.pruned.length} pruned tool results` : ""}).`,
        "Content from before that point is no longer in your visible context but is preserved in the session log.",
        `When you need any of it, call the recall_pruned tool with { compactionId: "${entry.compactionId}" }` +
          " — optionally narrowed with { search } — to read the original content back.",
      ].join("\n");
      agent.inject(createUserMessage({ content: [{ type: "text", text: pointer }], source: { kind: "user" } }));
      return {
        kind: "success",
        text: tr("restoreDone", {
          id: entry.compactionId,
          items: entry.shadowedCount,
          tokens: fmtTokensLabel(entry.shadowedTokens),
        }),
      };
    },
  });
  try {
    ctx.commands.register(definition("ledger"));
  } catch {
    // Name collision with an existing /ledger — fall back to an unambiguous name.
    ctx.commands.register(definition("compaction-ledger"));
  }
}

function fmtTokensLabel(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1)}k`;
}

const RECALL_PARAMETERS = {
  compactionId: {
    type: "string",
    description:
      "Ledger entry to recall, as listed by calling this tool with no arguments. Omit to list the ledger instead.",
  },
  search: {
    type: "string",
    description: "Case-insensitive substring filter over the recalled content. Optional.",
  },
  maxChars: {
    type: "number",
    description: "Recall budget in characters (default 20000, cap 200000). Content is recalled newest-first.",
  },
};

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);

  ctx.sessionProjections.register({
    key: "compactionLedger",
    stateSchema,
    stateVersion: STATE_VERSION,
    init: () => null,
    apply: (state, event) =>
      applyEvent(state, event, {
        detailEntries: cfg.detailEntries,
        previewChars: cfg.summaryPreviewChars,
      }),
    wire: { viewSchema: wireSchema, view: wireView },
  });

  registerLedgerCommand(ctx, cfg, tFor(cfg.language));

  ctx.tools.register(
    defineTool({
      name: "recall_pruned",
      description: TOOL_DESCRIPTION,
      parameters: RECALL_PARAMETERS,
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { report: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: value.report }],
      },
      async execute(args, exec) {
        const session = sessionOf(exec.agent);
        if (!session) {
          return { report: "recall_pruned is unavailable here: this tool call has no owning agent session." };
        }
        const state = stateOf(ctx, session);
        if (!args || (args.compactionId === undefined && args.search === undefined)) {
          return { report: buildList(state) };
        }
        try {
          return await withLogReader(ctx, session, async (readEvents) => {
            if (!readEvents) {
              return { report: "recall_pruned failed: the session persistence service is not available in this composition." };
            }
            const { report } = await buildRecall({
              state,
              readEvents,
              compactionId: typeof args.compactionId === "string" && args.compactionId ? args.compactionId : "last",
              search: typeof args.search === "string" ? args.search : null,
              maxChars: Number.isFinite(args.maxChars) ? args.maxChars : cfg.recallMaxChars,
            });
            return { report };
          });
        } catch (error) {
          const message = error instanceof RecallError ? error.message : `unexpected error: ${error?.message ?? error}`;
          return { report: `recall_pruned failed: ${message}` };
        }
      },
    }),
  );
}

export { name, inject, Config };
