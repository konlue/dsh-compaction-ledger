/**
 * Client half of dsh-compaction-ledger: renders the /ledger report and the
 * recall_pruned result as rich native cards.
 *
 * The host half delivers both as plain text (see ./report.js and ./recall.js).
 * The client parses that deterministic text — the format is owned by this
 * package on both sides and pinned by a cross-layer sync test — into styled
 * components: status badges, trigger chips, token-share bars and per-item
 * recall cards. Any parse miss falls back to the MarkdownText rendering, and
 * a missing renderer degrades to monospace text, so the card can only ever
 * get simpler, never broken.
 *
 * The official transcript already renders its own compaction marker on the
 * conversation.chat.node slot — that key is left alone.
 *
 * Hand-written classic script: no imports, no exports, no JSX, no build step.
 * `id` must equal the package name — the client module loader keys the factory
 * by it and rejects a bundle that registers under a different id.
 */
window.__ModuleLoader__.load({
  id: "dsh-compaction-ledger",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    // Platform seed modules. Missing primitives degrade this card to monospace
    // text; a throwing require() would fail the whole client entry instead.
    let primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      primitives = null;
    }
    // Accepts exotic component types: the primitives used here are memo()
    // wrapped, and memo() returns an object rather than a function.
    const pick = (name) => {
      const value = primitives === null ? null : primitives[name];
      return value === undefined || value === null ? null : value;
    };
    const MarkdownText = pick("MarkdownText");
    const DisclosureRow = pick("DisclosureRow");
    const RowIcon = pick("IconHistoryOutlineRegular") ?? pick("IconArchiveOutlineRegular") ?? pick("IconApiOutlineRegular");
    const ManualIcon = pick("IconPersonOutlineRegular") ?? pick("IconUserOutlineRegular") ?? pick("IconPersonRegular");
    const AutoIcon = pick("IconFlashOutlineRegular") ?? pick("IconBoltOutlineRegular") ?? pick("IconZapOutlineRegular");

    const COMMAND_SLOT = "conversation.chat.commandview";
    const TOOL_SLOT = "tool.call.toolview";
    // Slot keys are dispatched verbatim from the command/tool name — no
    // normalization on either side, so these strings must match lib/index.js.
    const COMMAND_KEYS = ["ledger", "compaction-ledger"];
    const TOOL_KEY = "recall_pruned";

    // Reports longer than this start collapsed, so `/ledger full` and large
    // recalls do not push the conversation away while short ones stay readable.
    const OPEN_LINE_LIMIT = 30;
    // Recall items longer than this render in a scrollable box instead of
    // pushing the whole conversation apart.
    const ITEM_SCROLL_CHARS = 1200;

    // Card chrome follows the app's UI language through the app's locale
    // registry — the same mechanism the built-in rows use. The report body
    // itself stays host-generated English; only these labels translate.
    const NS = "compaction-ledger";
    const DICTS = Object.freeze({
      en: Object.freeze({
        running: "Running…",
        jsonReport: "JSON report",
        line: "line",
        lines: "lines",
        commandFailed: "The command failed.",
        reportFailed: "The ledger report failed.",
        copy: "Copy",
        copied: "Copied",
        code: "Code",
        wrap: "Wrap",
        unwrap: "Unwrap",
        footnotes: "Footnotes",
      }),
      zh: Object.freeze({
        running: "运行中…",
        jsonReport: "JSON 报告",
        line: "行",
        lines: "行",
        commandFailed: "命令执行失败。",
        reportFailed: "账本报告执行失败。",
        copy: "复制",
        copied: "已复制",
        code: "代码",
        wrap: "自动换行",
        unwrap: "不换行",
        footnotes: "脚注",
      }),
    });

    /** The slot only receives `t` when the locale face was live at assembly;
     * fall back to the English dictionary rather than throwing into the
     * framework's error boundary. */
    function translate(t) {
      return typeof t === "function" ? t : (key) => DICTS.en[key] ?? key;
    }

    function makeLabels(tr) {
      return Object.freeze({
        code: Object.freeze({
          copyLabel: tr("copy"),
          copiedLabel: tr("copied"),
          toolbarLabels: Object.freeze({ codeLabel: tr("code"), wrapLabel: tr("wrap"), unwrapLabel: tr("unwrap") }),
        }),
        footnotes: tr("footnotes"),
      });
    }

    const PLAIN_STYLE = {
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "monospace",
      fontSize: 12,
      margin: 0,
      maxHeight: 320,
      overflow: "auto",
    };
    const ERROR_STYLE = { ...PLAIN_STYLE, color: "#d64545" };
    const BODY_STYLE = { padding: "2px 0 4px 20px" };
    const LABEL_STYLE = { marginLeft: 6, opacity: 0.75, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
    const ERROR_LABEL_STYLE = { ...LABEL_STYLE, color: "#d64545" };

    const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

    /** Chips and badges: translucent fills so both light and dark app themes
     * keep enough contrast without theme-variable access. */
    const CHIP_BASE = {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      borderRadius: 999,
      padding: "1px 8px",
      fontSize: 11,
      lineHeight: "16px",
      whiteSpace: "nowrap",
      fontFamily: MONO,
      justifySelf: "start",
    };
    const TRIGGER_STYLES = {
      manual: { background: "rgba(43,108,176,.16)", color: "#3b7bbf" },
      auto: { background: "rgba(128,128,128,.18)", color: "#7a7a7a" },
    };
    const STATUS_STYLES = {
      success: { background: "rgba(76,175,80,.18)", color: "#3d9a42" },
      failed: { background: "rgba(214,69,69,.16)", color: "#d64545" },
      running: { background: "rgba(240,180,40,.22)", color: "#b8860b" },
    };
    const ROLE_COLOR = {
      user: "#3b7bbf",
      assistant: "#8e5aa8",
      tool: "#2a8f85",
    };
    const roleColor = (role) => {
      const lower = String(role ?? "").toLowerCase();
      if (lower.startsWith("user")) return ROLE_COLOR.user;
      if (lower.startsWith("assistant")) return ROLE_COLOR.assistant;
      return ROLE_COLOR.tool;
    };

    // ---------------------------------------------------------------------------
    // Text parsers: the host report formats are owned by this package and the
    // cross-layer sync test pins them, so parsing here is a presentation
    // concern, not a contract risk. Any miss returns null and the card falls
    // back to Markdown rendering.
    // ---------------------------------------------------------------------------

    /** `"2.6k"` → 2600, `"1.2M"` → 1_200_000, `"0"` → 0 (inverse of report.js fmtTokens). */
    function parseTokenText(value) {
      const match = /^([\d.]+)(k|M)?$/.exec(String(value ?? "").trim());
      if (!match) return 0;
      const n = Number.parseFloat(match[1]);
      if (!Number.isFinite(n)) return 0;
      if (match[2] === "k") return n * 1_000;
      if (match[2] === "M") return n * 1_000_000;
      return n;
    }

    /**
     * Parse the /ledger report table out of the report text.
     * Table shape (report.js): header row, `| --- |` separator, data rows of
     * exactly 7 cells `| N | Time | Trigger | Status | Items | Tokens | Took |`.
     * Returns `{ headline, rows, rest }` or null when no well-formed table exists.
     */
    function parseLedgerTable(text) {
      if (typeof text !== "string") return null;
      const lines = text.split("\n");
      const tableIdx = lines.findIndex((line) => line.startsWith("| ") && line.endsWith(" |"));
      if (tableIdx <= 0) return null;
      const separator = lines[tableIdx + 1];
      if (typeof separator !== "string" || !/^\|(\s*:?-+:?\s*\|)+$/.test(separator.trim())) return null;
      const rows = [];
      let i = tableIdx + 2;
      for (; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.startsWith("| ")) break;
        const cells = line.split("|").map((cell) => cell.trim()).slice(1, -1);
        if (cells.length !== 7) return null;
        rows.push({
          index: cells[0],
          time: cells[1],
          trigger: cells[2],
          status: cells[3],
          items: cells[4],
          tokens: cells[5],
          took: cells[6],
        });
      }
      if (rows.length === 0) return null;
      const rest = lines.slice(i).join("\n").replace(/^\s+/, "");
      // The headline sits above the table's blank separator line, if any.
      const headline = lines.slice(0, tableIdx).reverse().find((line) => line.trim() !== "") ?? "";
      return { headline, rows, rest };
    }

    const RECALL_ITEM_RE = /\*\*seq (\d+|\?) · ([^*]+)\*\*\n\n```text\n([\s\S]*?)\n```/g;

    /**
     * Parse the recall_pruned result into item cards.
     * Item shape (recall.js): `**seq N · role**` header followed by a ```text fence.
     * Returns `{ headline, items, notice, filter }` or null when no items match.
     */
    function parseRecallItems(text) {
      if (typeof text !== "string") return null;
      const items = [];
      for (const match of text.matchAll(RECALL_ITEM_RE)) {
        items.push({ seq: match[1], role: match[2].trim(), text: match[3] });
      }
      if (items.length === 0) return null;
      const headline = text.slice(0, text.indexOf("\n")).trim();
      const notice = text.match(/Stopped at the [^\n]+/)?.[0] ?? null;
      const filter = text.match(/^Filter: "[^"\n]*"\.$/m)?.[0] ?? null;
      return { headline, items, notice, filter };
    }

    // ---------------------------------------------------------------------------
    // Rich components. They use only inline-styled divs/tables — no primitives —
    // so they render even where MarkdownText is unavailable.
    // ---------------------------------------------------------------------------

    function Chip({ style, icon, children }) {
      return h("span", { style: { ...CHIP_BASE, ...style } }, icon ? h(icon, { size: 11 }) : null, children);
    }

    function StatusBadge({ status }) {
      const style = STATUS_STYLES[status] ?? STATUS_STYLES.running;
      return h(Chip, { style }, status);
    }

    function TriggerChip({ trigger }) {
      const key = trigger === "manual" ? "manual" : "auto";
      return h(Chip, { style: TRIGGER_STYLES[key], icon: key === "manual" ? ManualIcon : AutoIcon }, trigger);
    }

    function TokenBar({ value, max }) {
      const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
      return h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" } },
        h(
          "div",
          { style: { width: 48, height: 4, borderRadius: 2, background: "rgba(128,128,128,.25)", overflow: "hidden" } },
          h("div", { style: { width: `${Math.round(frac * 100)}%`, height: "100%", borderRadius: 2, background: "rgba(43,108,176,.55)" } }),
        ),
        h("span", { style: { fontFamily: MONO, fontSize: 11 } }, value),
      );
    }

    const GRID_TEMPLATE = "24px 56px minmax(72px,1fr) 74px 48px 92px 56px";

    function LedgerGrid({ rows }) {
      const maxTokens = Math.max(...rows.map((row) => parseTokenText(row.tokens)), 0);
      const headerCells = ["#", "Time", "Trigger", "Status", "Items", "Tokens", "Took"];
      return h(
        "div",
        { style: { fontSize: 12 } },
        // header
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: GRID_TEMPLATE,
              gap: "0 8px",
              padding: "2px 6px",
              color: "#888",
              fontSize: 11,
              borderBottom: "1px solid rgba(128,128,128,.25)",
            },
          },
          headerCells.map((label, i) =>
            h("span", { key: label, style: { textAlign: i === 0 || i === 4 || i === 6 ? "right" : i === 5 ? "right" : "left" } }, label),
          ),
        ),
        rows.map((row, idx) =>
          h(
            "div",
            {
              key: idx,
              style: {
                display: "grid",
                gridTemplateColumns: GRID_TEMPLATE,
                gap: "0 8px",
                alignItems: "center",
                padding: "5px 6px",
                borderRadius: 6,
                borderBottom: idx < rows.length - 1 ? "1px solid rgba(128,128,128,.14)" : "none",
              },
            },
            h("span", { style: { textAlign: "right", color: "#888", fontFamily: MONO, fontSize: 11 } }, row.index),
            h("span", { style: { fontFamily: MONO, fontSize: 11, whiteSpace: "nowrap" } }, row.time),
            h(TriggerChip, { trigger: row.trigger }),
            h(StatusBadge, { status: row.status }),
            h("span", { style: { textAlign: "right", fontFamily: MONO, fontSize: 11 } }, row.items),
            h(TokenBar, { value: parseTokenText(row.tokens), max: maxTokens }),
            h("span", { style: { textAlign: "right", fontFamily: MONO, fontSize: 11, whiteSpace: "nowrap" } }, row.took),
          ),
        ),
      );
    }

    function RecallItem({ item }) {
      const long = item.text.length > ITEM_SCROLL_CHARS;
      return h(
        "div",
        {
          style: {
            border: "1px solid rgba(128,128,128,.22)",
            borderRadius: 8,
            padding: "6px 8px",
            marginBottom: 6,
            background: "rgba(128,128,128,.06)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 } },
          h("span", { style: { ...CHIP_BASE, background: "rgba(128,128,128,.18)" } }, `seq ${item.seq}`),
          h("span", { style: { ...CHIP_BASE, background: `${roleColor(item.role)}22`, color: roleColor(item.role) } }, item.role),
        ),
        h(
          "pre",
          {
            style: {
              ...PLAIN_STYLE,
              maxHeight: long ? 180 : undefined,
              overflow: long ? "auto" : "visible",
              margin: 0,
            },
          },
          item.text,
        ),
      );
    }

    function RecallCards({ parsed }) {
      return h(
        "div",
        { style: { fontSize: 12 } },
        parsed.filter
          ? h("div", { style: { color: "#888", fontSize: 11, marginBottom: 6 } }, parsed.filter)
          : null,
        parsed.items.map((item, idx) => h(RecallItem, { key: idx, item })),
        parsed.notice
          ? h(
              "div",
              { style: { background: "rgba(240,180,40,.16)", color: "#b8860b", borderRadius: 6, padding: "4px 8px", fontSize: 11 } },
              parsed.notice,
            )
          : null,
      );
    }

    // ---------------------------------------------------------------------------
    // Fallback rendering (unchanged behaviour): Markdown through the chat
    // renderer, degrading to monospace text.
    // ---------------------------------------------------------------------------

    /**
     * Inner boundary for the Markdown subtree. A slot entry that throws during
     * render is abdicated and then leaves a bare error cell in its place — the
     * framework does not fall back to the generic card — so Markdown failures
     * must degrade to the raw report here instead of escaping.
     */
    class SafeMarkdown extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error) {
        console.error("dsh-compaction-ledger: markdown render failed, showing raw text", error);
      }
      render() {
        if (this.state.failed) return h("pre", { style: PLAIN_STYLE }, this.props.text);
        return h(MarkdownText, { text: this.props.text, streaming: false, labels: this.props.labels });
      }
    }

    function lineCount(text) {
      return text === "" ? 0 : text.split("\n").length;
    }

    function firstLine(text) {
      const end = text.indexOf("\n");
      return end === -1 ? text : text.slice(0, end);
    }

    function fenced(text, lang) {
      return "```" + lang + "\n" + text.replace(/\s+$/, "") + "\n```";
    }

    function isJsonText(text) {
      const trimmed = text.replace(/^\s+/, "");
      return trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[";
    }

    function isJsonArg(value) {
      return typeof value === "string" && value.trim().toLowerCase() === "json";
    }

    /** Flatten a tool result's content parts the way the built-in rows do. */
    function contentText(content) {
      if (!Array.isArray(content)) return "";
      const parts = [];
      for (const part of content) {
        if (part === null || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
        else {
          try {
            parts.push(JSON.stringify(part, null, 2));
          } catch (error) {
            // Skip parts that cannot be serialized rather than losing the report.
          }
        }
      }
      return parts.join("\n");
    }

    function errorText(block, tr) {
      const error = block.error;
      if (error !== null && typeof error === "object") {
        const name = typeof error.name === "string" ? error.name : "";
        const message = typeof error.message === "string" ? error.message : "";
        const code = typeof error.code === "string" ? error.code : "";
        const text = [name, message].filter(Boolean).join(": ") || code;
        if (text !== "") return text;
      }
      return tr("reportFailed");
    }

    function markdownBody(text, json, error, labels) {
      if (!MarkdownText) return h("pre", { style: error ? ERROR_STYLE : PLAIN_STYLE }, text);
      return h(SafeMarkdown, { text: json ? fenced(text, "json") : text, labels });
    }

    function plainCard(title, text, error) {
      return h(
        "div",
        { style: { fontSize: 12 } },
        h("div", { style: { opacity: 0.7 } }, title),
        h("pre", { style: error ? ERROR_STYLE : PLAIN_STYLE }, text),
      );
    }

    /**
     * One report card. The body is the rich table when the text parses and the
     * Markdown fallback otherwise; the collapsed label is always the report's
     * own first line.
     *
     * `open` is derived rather than stored, so a row that starts as "running"
     * and settles into a short report still opens by default; the first click
     * takes over from the derivation.
     */
    function ReportView(props) {
      const title = props.title;
      const text = typeof props.text === "string" ? props.text : "";
      const running = props.running === true;
      const error = props.error === true;
      const json = props.json === true;
      // An error with no text falls back to a translated generic line.
      const body = error && text === "" ? translate(props.t)("commandFailed") : text;
      const lines = lineCount(body);
      const expandable = !running && body !== "";
      const defaultOpen = json || lines <= OPEN_LINE_LIMIT;
      const [userOpen, setUserOpen] = React.useState(null);
      const open = expandable && (userOpen === null ? defaultOpen : userOpen);

      // The locale seat's identity is not guaranteed stable, so derive the
      // translator and the MarkdownText labels from it per render pass.
      const tr = React.useMemo(() => translate(props.t), [props.t]);
      const labels = React.useMemo(() => makeLabels(tr), [tr]);
      const label = running
        ? tr("running")
        : json
          ? `${tr("jsonReport")} · ${lines} ${tr(lines === 1 ? "line" : "lines")}`
          : firstLine(body);

      let bodyNode = null;
      if (expandable) {
        const parsed = !error && !json ? parseLedgerTable(body) : null;
        if (parsed !== null) {
          const restNode =
            parsed.rest === ""
              ? null
              : MarkdownText
                ? h(SafeMarkdown, { text: parsed.rest, labels })
                : h("pre", { style: PLAIN_STYLE }, parsed.rest);
          bodyNode = h("div", { style: BODY_STYLE }, h(LedgerGrid, { rows: parsed.rows }), restNode ? h("div", { style: { marginTop: 8 } }, restNode) : null);
        } else {
          bodyNode = markdownBody(body, json, error, labels);
        }
      }

      if (!DisclosureRow) return plainCard(title, running ? "" : body, error);

      return h(
        DisclosureRow,
        {
          icon: RowIcon ? h(RowIcon, { size: 14 }) : undefined,
          title,
          open,
          running,
          expandable,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: () => setUserOpen(!open),
          collapsedContent: label ? h("span", { style: error ? ERROR_LABEL_STYLE : LABEL_STYLE }, label) : undefined,
        },
        bodyNode,
      );
    }

    /** Recall tool card: parsed item cards, Markdown fallback otherwise. */
    function RecallBody(props) {
      const text = props.text;
      const labels = props.labels;
      const parsed = props.error === true || isJsonText(text) ? null : parseRecallItems(text);
      if (parsed !== null) return h(RecallCards, { parsed });
      return markdownBody(text, isJsonText(text), props.error === true, labels);
    }

    /** `/ledger [summary|full|json]` command row. */
    function LedgerCommandCard(props) {
      const node = props.node;
      if (node === null || typeof node !== "object") return null;
      const title = typeof node.name === "string" && node.name !== "" ? node.name : "ledger";
      const outcome = node.outcome;
      if (outcome === null || outcome === undefined) return h(ReportView, { title, running: true, t: props.t });
      const text = typeof outcome.text === "string" ? outcome.text : "";
      if (outcome.kind === "error") return h(ReportView, { title, error: true, t: props.t, text });
      return h(ReportView, { title, text, t: props.t, json: isJsonArg(node.args) || isJsonText(text) });
    }

    /** `recall_pruned` tool row: parsed item cards, Markdown fallback otherwise. */
    function RecallRow(props) {
      const title = typeof props.toolName === "string" && props.toolName !== "" ? props.toolName : "recall_pruned";
      const block = props.block;
      const settled = props.phase === "result" && block !== null && typeof block === "object" && block.kind === "tool-result";
      if (!settled) return h(ReportView, { title, running: true, t: props.t });
      const text = contentText(block.content);
      const error = block.isError === true;
      if (error && text === "") return h(ReportView, { title, error: true, t: props.t, text: errorText(block, translate(props.t)) });
      const tr = React.useMemo(() => translate(props.t), [props.t]);
      const labels = React.useMemo(() => makeLabels(tr), [tr]);
      const parsed = !error && !isJsonText(text) ? parseRecallItems(text) : null;
      const headline = firstLine(text);
      if (!DisclosureRow) return plainCard(title, text, error);
      return h(
        DisclosureRow,
        {
          icon: RowIcon ? h(RowIcon, { size: 14 }) : undefined,
          title,
          open: true,
          running: false,
          expandable: true,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          collapsedContent: h("span", { style: error ? ERROR_LABEL_STYLE : LABEL_STYLE }, headline),
        },
        h("div", { style: BODY_STYLE }, parsed !== null ? h(RecallCards, { parsed }) : markdownBody(text, isJsonText(text), error, labels)),
      );
    }

    function registerEntry(ctx, slotName, key, component) {
      try {
        return ctx.slots.register({ name: slotName, key, locale: NS }, component);
      } catch (error) {
        // An occupied key means the built-in card keeps rendering this command
        // or tool; that is a working fallback, not a failure worth crashing on.
        console.warn(`dsh-compaction-ledger: slot entry "${key}" was not registered in ${slotName}`, error);
        return null;
      }
    }

    function registerAll(ctx, slotName, entries) {
      const disposers = [];
      for (const [key, component] of entries) {
        const dispose = registerEntry(ctx, slotName, key, component);
        if (dispose) disposers.push(dispose);
      }
      return disposers;
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), "compaction-ledger: dictionaries");
      ctx.slots.inject(COMMAND_SLOT, () =>
        registerAll(ctx, COMMAND_SLOT, COMMAND_KEYS.map((key) => [key, LedgerCommandCard])),
      );
      ctx.slots.inject(TOOL_SLOT, () => registerAll(ctx, TOOL_SLOT, [[TOOL_KEY, RecallRow]]));
    }

    // __test exposes the parsers to the node test harness only; the loader
    // consumes inject/apply and ignores the rest.
    return {
      inject: ["slots", "locale"],
      apply,
      __test: { parseLedgerTable, parseRecallItems, parseTokenText },
    };
  },
});
