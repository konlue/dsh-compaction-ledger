#!/usr/bin/env node
/**
 * CDP probe for the DeepSeek Harness desktop app.
 * Usage: node cdp.mjs "<js expression>" [--port 9222]
 * Evaluates the expression in the app's page and prints the result plus
 * buffered console messages. Requires the app started with
 * --remote-debugging-port=9222.
 */
const port = process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 9222;
const expr = process.argv[2] ?? "1+1";

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && /index\.html|localhost/i.test(t.url)) ?? targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page target found; targets:", targets.map((t) => `${t.type} ${t.url}`));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const logs = [];
let id = 0;
const pending = new Map();

function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params ?? {} }));
  });
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    logs.push(`[${msg.params.type}] ${text}`);
  } else if (msg.method === "Runtime.exceptionThrown") {
    logs.push(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
  }
};

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

await send("Runtime.enable");

// --type "<text>" : focus the composer via JS, then drive real input events.
const typeIdx = process.argv.indexOf("--type");
if (typeIdx !== -1) {
  const text = process.argv[typeIdx + 1];
  const pressEnter = process.argv.includes("--enter");
  await send("Runtime.evaluate", { expression: "document.querySelector('[contenteditable=true]')?.focus()" });
  await send("Input.insertText", { text });
  if (pressEnter) {
    for (const params of [
      { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    ]) {
      await send("Input.dispatchKeyEvent", params);
    }
  }
  const state = await send("Runtime.evaluate", {
    expression: "document.querySelector('[contenteditable=true]')?.textContent?.slice(0,80) ?? null",
    returnByValue: true,
  });
  console.log(JSON.stringify({ typed: state.result?.result?.value, enter: pressEnter }));
  for (const line of logs.slice(-10)) console.log(line);
  ws.close();
  process.exit(0);
}

try {
  const result = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    console.log("EXCEPTION:", result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  } else {
    console.log(JSON.stringify(result.result.value, null, 1) ?? String(result.result.description));
  }
} finally {
  for (const line of logs.slice(-40)) console.log(line);
  ws.close();
}
