/**
 * Shared test harness for the hand-written client half (lib/client.js).
 *
 * The client module is a classic script that registers itself on
 * `window.__ModuleLoader__`, and its platform modules (react,
 * @deepseek-ai/dsh-client-ui-primitives) only exist inside the desktop shell.
 * This harness supplies minimal stand-ins and evaluates the returned element
 * tree by hand, so slot keys, rendering dispatch and crash containment are
 * all covered by plain `node --test`.
 */

/** Minimal React stand-in: exactly the API surface lib/client.js may use. */
export function stubReact() {
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

export const memoType = (type) =>
  type !== null && typeof type === "object" && type.$$typeof === Symbol.for("react.memo") ? type.type : type;

/** Evaluate a stubbed element tree, honouring class components and boundaries. */
export function renderTree(node, React) {
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

export function findOne(node, type) {
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

export function findAll(node, type, acc = []) {
  if (node === null || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, acc);
    return acc;
  }
  if (node.type === type) acc.push(node);
  return findAll(node.props.children, type, acc);
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

let caseSeq = 0;

export async function loadClient({ markdownThrows = false, withPrimitives = true, occupiedKeys = [], icons = {} } = {}) {
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
      return {
        MarkdownText,
        DisclosureRow,
        IconHistoryOutlineRegular: icons.history ?? icon,
        IconArchiveOutlineRegular: icon,
        IconApiOutlineRegular: icon,
        IconPersonOutlineRegular: icons.person ?? icon,
        IconFlashOutlineRegular: icons.flash ?? icon,
      };
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
