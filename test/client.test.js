/**
 * Coverage for the hand-written client half (lib/client.js).
 *
 * The client module is a classic script that registers itself on
 * `window.__ModuleLoader__`, and its platform modules (react,
 * @deepseek-ai/dsh-client-ui-primitives) only exist inside the desktop shell.
 * This harness supplies minimal stand-ins and evaluates the returned element
 * tree by hand, so slot keys, the Markdown/JSON/error dispatch and the crash
 * containment are all covered by plain `node --test`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findAll } from "./harness.js";

const body = (...lines) => lines.join("\n");

/** Short enough for the card to open itself. */
const SHORT_REPORT = "Session compactions: 1 recorded (1 ok, 0 failed) · ~4.1k tokens shadowed · 1 tool result pruned";

const REPORT = body(
  "Session compactions: 1 recorded (1 ok, 0 failed) · ~4.1k tokens shadowed · 1 tool result pruned",
  "",
  "| # | Time | Trigger | Status | Items | Tokens | Took |",
  "| ---: | --- | --- | --- | ---: | ---: | ---: |",
  "| 1 | 14:32:20 | auto | success | 5 | 4.1k | 40ms |",
);

/** Past the open-by-default limit: `/ledger full` on a busy session. */
const LONG_REPORT = body(
  REPORT,
  "",
  "**Compactions** (last 40 of 40 kept)",
  "",
  ...[...Array(40)].map((_, i) => `| ${i + 2} | 15:0${i % 10}:00 | auto | success | 5 | 4.1k | 40ms |`),
);

const RECALL = body(
  "Recalled 1 item from the compaction at 10/17/2026, 2:32:20 PM (~4100 tokens were shadowed; showing newest-first).",
  "",
  "**seq 11 · tool bash**",
  "",
  "```text",
  "npm test output: 41 passing",
  "```",
);

const JSON_REPORT = body("{", '  "totals": {', '    "count": 1', "  }", "}", "");

let caseSeq = 0;

/** Minimal React stand-in: exactly the API surface lib/client.js may use. */
function stubReact() {
  const Component = class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  };
  const createElement = (type, props, ...children) => {
    const flat = children.filter((child) => child !== null && child !== undefined && child !== false && child !== true);
    return { type, props: { ...(props ?? {}), children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat } };
  };
  return {
    createElement,
    // No-op setter: every assertion here reads the first render, and the
    // controlled-disclosure behaviour is the framework's, not ours.
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useMemo: (factory) => factory(),
    // Real memo() returns an exotic object, not a function — that distinction
    // matters here, because MarkdownText and DisclosureRow are both memoized
    // and a function-only check would drop them.
    memo: (component) => ({ $$typeof: Symbol.for("react.memo"), type: component, compare: null }),
    Component,
  };
}

const memoType = (type) =>
  type !== null && typeof type === "object" && type.$$typeof === Symbol.for("react.memo") ? type.type : type;

/** Evaluate a stubbed element tree, honouring class components and boundaries. */
function renderTree(node, React) {
  if (Array.isArray(node)) return node.map((child) => renderTree(child, React));
  if (node === null || typeof node !== "object") return node;
  const { props } = node;
  const type = memoType(node.type);
  if (typeof type === "string") return { type, props: { ...props, children: renderTree(props.children, React) } };
  if (typeof type === "object" && typeof type.render === "function") return renderTree(type.render(props), React);
  if (typeof type !== "function") return node;
  if (type.prototype instanceof React.Component) {
    const instance = new type(props);
    try {
      return renderTree(instance.render(), React);
    } catch (error) {
      if (typeof type.getDerivedStateFromError !== "function") throw error;
      Object.assign(instance.state, type.getDerivedStateFromError(error));
      if (typeof instance.componentDidCatch === "function") instance.componentDidCatch(error);
      return renderTree(instance.render(), React);
    }
  }
  return renderTree(type(props), React);
}

function findOne(node, type) {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findOne(child, type);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (node.type === type) return node;
  return findOne(node.props.children, type);
}

/** Mirrors SlotCore: an occupied key at the same priority throws. */
function fakeCtx({ occupiedKeys = [] } = {}) {
  const ctx = { registered: [], injected: [], effects: [], live: 0, dictionaries: {} };
  ctx.locale = {
    register(name, dicts) {
      ctx.dictionaries[name] = dicts;
      return () => {};
    },
  };
  ctx.effect = (callback, _reason) => {
    callback();
    return () => {};
  };
  ctx.slots = {
    inject(name, callback) {
      ctx.injected.push(name);
      ctx.effects.push(callback());
      return () => {};
    },
    register(options, component) {
      if (occupiedKeys.includes(options.key)) {
        throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}"`);
      }
      ctx.registered.push({ options, component });
      ctx.live += 1;
      return () => {
        ctx.live -= 1;
      };
    },
  };
  return ctx;
}

async function loadClient({ markdownThrows = false, withPrimitives = true, occupiedKeys = [] } = {}) {
  const React = stubReact();
  const icon = React.memo((props) => React.createElement("icon", props));
  const MarkdownText = React.memo((props) => {
    if (markdownThrows) throw new Error("markdown renderer exploded");
    return React.createElement("markdown", { text: props.text, labels: props.labels, streaming: props.streaming });
  });
  // The real one is controlled and renders children only while open.
  const DisclosureRow = React.memo((props) =>
    React.createElement(
      "disclosure",
      { title: props.title, open: props.open, running: props.running, expandable: props.expandable, label: props.collapsedContent, icon: props.icon },
      props.open ? props.children : null,
    ),
  );

  const require = (specifier) => {
    if (specifier === "react") return React;
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
      if (!withPrimitives) throw new Error(`client-modules: require("${specifier}") missed the module table`);
      return { MarkdownText, DisclosureRow, IconHistoryOutlineRegular: icon, IconArchiveOutlineRegular: icon, IconApiOutlineRegular: icon };
    }
    throw new Error(`client-modules: require("${specifier}") missed the module table`);
  };

  const registration = {};
  globalThis.window = { __ModuleLoader__: { load: (value) => Object.assign(registration, value) } };
  await import(`../lib/client.js?case=${++caseSeq}`);
  const plugin = registration.factory(require);
  const ctx = fakeCtx({ occupiedKeys });
  plugin.apply(ctx);
  const componentFor = (key) => {
    const entry = ctx.registered.find((registered) => registered.options.key === key);
    if (entry === undefined) throw new Error(`no slot entry registered for "${key}"`);
    return entry.component;
  };
  // The framework resolves `t` from the registered dictionary by app language.
  const makeT = (lang) => {
    const dict = ctx.dictionaries["compaction-ledger"]?.[lang];
    return (key) => dict?.[key] ?? key;
  };
  return {
    id: registration.id,
    plugin,
    ctx,
    componentFor,
    makeT,
    render: (element) => renderTree(element, React),
  };
}

test("registers the report card on both slots under the names the host dispatches", async () => {
  const { plugin, ctx, id } = await loadClient();
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual(plugin.inject, ["slots", "locale"]);
  assert.equal(id, "dsh-compaction-ledger");

  assert.deepEqual(
    ctx.registered.map((entry) => [entry.options.name, entry.options.key ?? entry.options.id, entry.options.locale]),
    [
      ["conversation.chat.commandview", "ledger", "compaction-ledger"],
      ["conversation.chat.commandview", "compaction-ledger", "compaction-ledger"],
      ["tool.call.toolview", "recall_pruned", "compaction-ledger"],
      ["conversation.view", "ledger", "compaction-ledger"],
    ],
  );
  // Both dictionaries registered so the seat resolves either app language.
  assert.deepEqual(Object.keys(ctx.dictionaries["compaction-ledger"]).sort(), ["en", "zh"]);
  assert.deepEqual(ctx.injected, ["conversation.chat.commandview", "tool.call.toolview", "conversation.view"]);
  // The framework calls every returned effect as a disposer, so a skipped
  // registration must not leave a null behind in the array.
  for (const effect of ctx.effects) {
    for (const dispose of effect) assert.equal(typeof dispose, "function");
  }
});

test("client slot keys stay in sync with the host command and tool names", async () => {
  const host = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  // The client half is a classic script and cannot import these, so string
  // literals on both sides are the contract — this is the only guard against a
  // rename on one side silently downgrading the UI to the generic card.
  assert.ok(host.includes('definition("ledger")'));
  assert.ok(host.includes('definition("compaction-ledger")'));
  assert.ok(host.includes('name: "recall_pruned"'));
});

test("the official compaction transcript node is not claimed by this plugin", async () => {
  const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.ok(!client.includes('"compaction"'));
});

test("an occupied slot key is skipped instead of taking the whole entry down", async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args[0]);
  try {
    const { ctx } = await loadClient({ occupiedKeys: ["ledger"] });
    // The view tab is identified by `id`, so it survives an occupied "ledger"
    // command key; only the commandview entry is skipped.
    assert.deepEqual(ctx.registered.map((entry) => entry.options.key ?? entry.options.id), [
      "compaction-ledger",
      "recall_pruned",
      "ledger",
    ]);
    for (const effect of ctx.effects) {
      for (const dispose of effect) assert.equal(typeof dispose, "function");
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /slot entry "ledger" was not registered/);
});

test("manifest declares the client half the module loader looks for", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const { id } = await loadClient();
  assert.equal(pkg.dsh.client.platform, "web");
  assert.equal(pkg.exports["./client"], "./lib/client.js");
  assert.equal(id, pkg.name);
});

test("a short /ledger report opens itself and renders as Markdown", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("ledger");
  const tree = render(card({ node: { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text: SHORT_REPORT } } }));

  const row = findOne(tree, "disclosure");
  assert.equal(row.props.title, "ledger");
  assert.equal(row.props.expandable, true);
  assert.equal(row.props.open, true);
  assert.equal(row.props.label.props.children, SHORT_REPORT);

  const markdown = findOne(tree, "markdown");
  assert.equal(markdown.props.text, SHORT_REPORT);
  assert.equal(markdown.props.streaming, false);
});

test("a long /ledger full report starts collapsed behind its headline", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("ledger");
  const tree = render(card({ node: { kind: "command", name: "ledger", args: "full", outcome: { kind: "success", text: LONG_REPORT } } }));

  const row = findOne(tree, "disclosure");
  assert.equal(row.props.open, false);
  assert.equal(row.props.label.props.children, REPORT.split("\n")[0]);
  assert.equal(findOne(tree, "markdown"), null);
});

test("/ledger json renders as a JSON code block rather than collapsed prose", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("ledger");
  const tree = render(card({ node: { kind: "command", name: "ledger", args: " json ", outcome: { kind: "success", text: JSON_REPORT } } }));

  const row = findOne(tree, "disclosure");
  assert.equal(row.props.open, true);
  assert.match(row.props.label.props.children, /^JSON report · \d+ lines$/);
  assert.match(findOne(tree, "markdown").props.text, /^```json\n\{[\s\S]*\}\n```$/);
});

test("running and failed /ledger render without a body", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("ledger");

  const running = findOne(render(card({ node: { kind: "command", name: "ledger", args: null, outcome: null } })), "disclosure");
  assert.equal(running.props.running, true);
  assert.equal(running.props.expandable, false);
  assert.equal(running.props.label.props.children, "Running…");

  const failed = findOne(
    render(card({ node: { kind: "command", name: "ledger", args: "verbose", outcome: { kind: "error", text: "Unknown argument `verbose`." } } })),
    "disclosure",
  );
  assert.equal(failed.props.expandable, true);
  assert.match(failed.props.label.props.children, /Unknown argument/);
  assert.equal(failed.props.label.props.style.color, "#d64545");
});

test("markdown labels are complete; the EN fallback covers a missing locale seat", async () => {
  const { componentFor, render } = await loadClient();
  const card = componentFor("ledger");
  const node = { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text: SHORT_REPORT } };
  const labels = findOne(render(card({ node })), "markdown").props.labels;

  assert.deepEqual(Object.keys(labels).sort(), ["code", "footnotes"]);
  assert.deepEqual(Object.keys(labels.code).sort(), ["copiedLabel", "copyLabel", "toolbarLabels"]);
  // No `t` prop (framework fell back or seat missing) must still yield labels,
  // from the built-in English dictionary — never undefined into MarkdownText.
  assert.equal(labels.code.copyLabel, "Copy");
  assert.equal(labels.footnotes, "Footnotes");
});

test("card chrome renders in the app's language through the locale seat", async () => {
  const { componentFor, makeT, render } = await loadClient();
  const card = componentFor("ledger");

  const zh = makeT("zh");
  const running = findOne(render(card({ node: { kind: "command", name: "ledger", args: null, outcome: null }, t: zh })), "disclosure");
  assert.equal(running.props.label.props.children, "运行中…");

  const jsonText = '{\n  "totals": {}\n}';
  const jsonCard = render(card({ node: { kind: "command", name: "ledger", args: " json ", outcome: { kind: "success", text: jsonText } }, t: zh }));
  assert.match(findOne(jsonCard, "disclosure").props.label.props.children, /^JSON 报告 · \d+ 行$/);
  assert.equal(findOne(jsonCard, "markdown").props.labels.code.copyLabel, "复制");
  assert.equal(findOne(jsonCard, "markdown").props.labels.code.toolbarLabels.wrapLabel, "自动换行");

  const failed = findOne(
    render(card({ node: { kind: "command", name: "ledger", args: "verbose", outcome: { kind: "error", text: "" } }, t: zh })),
    "disclosure",
  );
  assert.match(failed.props.label.props.children, /命令执行失败。/);
});

test("a settled recall_pruned tool call renders its content as Markdown", async () => {
  const { componentFor, render } = await loadClient();
  const row = componentFor("recall_pruned");

  const preparing = findOne(
    render(row({ phase: "preparing", toolName: "recall_pruned", block: { phase: "preparing", callId: "c1" } })),
    "disclosure",
  );
  assert.equal(preparing.props.running, true);
  assert.equal(preparing.props.title, "recall_pruned");

  const settled = render(
    row({
      phase: "result",
      toolName: "recall_pruned",
      block: { kind: "tool-result", content: [{ type: "text", text: RECALL }], isError: false, call: { name: "recall_pruned", argsRaw: '{"compactionId":"C-A"}' } },
    }),
  );
  assert.equal(findOne(settled, "disclosure").props.title, "recall_pruned");
  // The recall text parses into item cards (see rich.test.js), so no markdown
  // node renders for it; the pre-styled item body carries the text.
  assert.equal(findOne(settled, "markdown"), null);
  assert.equal(findOne(settled, "pre").props.children, "npm test output: 41 passing");

  // A result that never saw its tool/call event has no arguments to read.
  const orphan = render(
    row({ phase: "result", toolName: "recall_pruned", block: { kind: "tool-result", content: [{ type: "text", text: RECALL }], isError: false, call: null } }),
  );
  assert.equal(findOne(orphan, "markdown"), null);
  assert.equal(findOne(orphan, "pre").props.children, "npm test output: 41 passing");
});

test("a failed recall_pruned falls back to its error text", async () => {
  const { componentFor, render } = await loadClient();
  const row = componentFor("recall_pruned");
  const tree = render(
    row({
      phase: "result",
      toolName: "recall_pruned",
      block: { kind: "tool-result", content: [], isError: true, error: { name: "RecallError", message: "boom" }, call: null },
    }),
  );
  assert.match(findOne(tree, "disclosure").props.label.props.children, /RecallError: boom/);
});

test("a markdown failure degrades to the raw report instead of abdicating the entry", async () => {
  const { componentFor, render } = await loadClient({ markdownThrows: true });
  const card = componentFor("ledger");
  // Only unparseable text reaches the Markdown renderer; a table report takes
  // the rich path (see rich.test.js). This must not throw: a throwing slot
  // entry is retired and replaced by a bare error cell, hiding the report.
  const text = "Session compactions: none recorded yet — nothing to tabulate.";
  const tree = render(card({ node: { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text } } }));
  const pre = findOne(tree, "pre");
  assert.equal(pre.props.children, text);
  assert.equal(pre.props.style.whiteSpace, "pre-wrap");

  // A table report renders through the rich path even when Markdown explodes.
  const rich = render(card({ node: { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text: REPORT } } }));
  assert.equal(findOne(rich, "pre"), null);
  assert.ok(findAll(rich, "div").some((n) => n.props.style?.display === "grid"));
});

test("missing ui primitives degrade to monospace text instead of an empty row", async () => {
  const { componentFor, render } = await loadClient({ withPrimitives: false });
  const card = componentFor("ledger");
  const tree = render(card({ node: { kind: "command", name: "ledger", args: null, outcome: { kind: "success", text: REPORT } } }));
  assert.equal(findOne(tree, "disclosure"), null);
  assert.equal(findOne(tree, "pre").props.children, REPORT);
});
