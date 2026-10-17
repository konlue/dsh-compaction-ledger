/**
 * Report-body translations for the compaction ledger.
 *
 * The host half has no access to the app's UI language (it lives in the
 * renderer's locale registry), so the report language is a plugin config key
 * (`language: "en" | "zh"`, default `"en"`). Card chrome localization is
 * separate — it lives in lib/client.js and follows the app UI automatically.
 *
 * The English dictionary is the canonical key set: unknown languages and
 * missing keys fall back to it. JSON report values intentionally stay English
 * regardless of this table, so scripts parsing `/ledger json` see a
 * language-stable contract.
 *
 * @module dsh-compaction-ledger/i18n
 */

export const LANGUAGES = ["en", "zh"];

const STRINGS = {
  en: {
    usage: "Usage: /ledger [summary|full|json] or /ledger restore [last|<compactionId>]",
    unknownArg: "Unknown argument `{arg}`. {usage}",
    noSession: "No owning session: /ledger must run inside an agent session.",
    commandDescription:
      "Show the compaction ledger of this session: every context compaction, what it shadowed, and recall pruned content (/ledger restore last)",

    emptySession:
      "Session compactions: none recorded yet — the ledger fills when context pressure triggers compaction (or after a manual /compact). Run /ledger again afterwards.",

    headline: "Session compactions: {n} recorded ({success} ok, {failed} failed) · ~{tokens} tokens shadowed · {pruned} {prunedLabel}",
    toolResultOne: "tool result pruned",
    toolResultMany: "tool results pruned",
    entriesKept: "**Compactions** (last {shown} of {total} kept)",

    indexHeader: "#",
    timeHeader: "Time",
    triggerHeader: "Trigger",
    statusHeader: "Status",
    itemsHeader: "Items",
    tokensHeader: "Tokens",
    tookHeader: "Took",
    triggerManual: "manual",
    triggerAuto: "auto",
    statusRunning: "running",
    statusSuccess: "success",
    statusFailed: "failed",

    entryDetail: "**Compaction {n}** — {trigger}, {status}",
    entrySummary: "**Summary** ({provider}/{model}):",
    entryPrunedHeader: "**Pruned tool results**",
    prunedRow: "`{tool}` · seq {seq} · ~{tokens} tokens",
    prunedUnknownTool: "unknown tool",
    noPrunedResults: "No individual tool results were pruned; the whole span went into the summary.",

    restoreDone:
      "Restore injected: the model has been handed a pointer to compaction {id} ({items} shadowed items, ~{tokens} tokens). It can pull the original content with the recall_pruned tool.",
    restoreDisabled: "Restore is disabled by the `restoreEnabled` config key.",
    restoreNoEntries: "Nothing to restore: no completed compaction is recorded in this session's ledger yet.",
    restoreNoMatch: "No compaction with id `{id}` is recorded in this ledger. Run /ledger to list the recorded ids.",
    restoreUnavailable:
      "Restore is unavailable here: this command could not reach the session's agent to inject the pointer. Run it inside the conversation.",
  },

  zh: {
    usage: "用法：/ledger [summary|full|json] 或 /ledger restore [last|<compactionId>]",
    unknownArg: "未知参数 `{arg}`。{usage}",
    noSession: "没有所属会话：/ledger 必须在 agent 会话内运行。",
    commandDescription:
      "查看本会话的压缩账本：每次上下文压缩剪除了什么、代价多少，并可取回被剪内容（/ledger restore last）",

    emptySession:
      "会话压缩：还没有记录——当上下文压力触发压缩（或手动 /compact）后账本会自动填充，届时再运行 /ledger 查看。",

    headline: "会话压缩：共 {n} 次（成功 {success}，失败 {failed}）· 约 {tokens} token 被剪除 · {pruned} {prunedLabel}",
    toolResultOne: "个工具结果被修剪",
    toolResultMany: "个工具结果被修剪",
    entriesKept: "**压缩记录**（最近 {shown} / {total} 条）",

    indexHeader: "#",
    timeHeader: "时间",
    triggerHeader: "触发",
    statusHeader: "状态",
    itemsHeader: "条目",
    tokensHeader: "Token",
    tookHeader: "耗时",
    triggerManual: "手动",
    triggerAuto: "自动",
    statusRunning: "进行中",
    statusSuccess: "成功",
    statusFailed: "失败",

    entryDetail: "**第 {n} 次压缩** —— {trigger}，{status}",
    entrySummary: "**摘要**（{provider}/{model}）：",
    entryPrunedHeader: "**被修剪的工具结果**",
    prunedRow: "`{tool}` · seq {seq} · 约 {tokens} token",
    prunedUnknownTool: "未知工具",
    noPrunedResults: "没有单独修剪的工具结果；整个区段直接进入了摘要。",

    restoreDone:
      "已注入还原指针：模型已收到第 {id} 次压缩的定位（{items} 个被剪条目，约 {tokens} token）。它可以用 recall_pruned 工具取回原文。",
    restoreDisabled: "还原已被 `restoreEnabled` 配置键关闭。",
    restoreNoEntries: "无可还原内容：本会话账本里还没有已完成的压缩记录。",
    restoreNoMatch: "账本中没有 id 为 `{id}` 的压缩。运行 /ledger 可查看已记录的 id。",
    restoreUnavailable: "还原在此处不可用：无法触达会话的 agent 来注入指针。请在对话中运行。",
  },
};

/**
 * Translator for one language, with `{name}` interpolation.
 * @param language `"en"` or `"zh"` (anything else falls back to English)
 * @returns `(key, params?) => string`
 */
export function tFor(language) {
  const dict = STRINGS[language] ?? STRINGS.en;
  return (key, params) => {
    let text = dict[key] ?? STRINGS.en[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}
