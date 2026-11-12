const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("resposta administrativa antiga não reabre painel depois do logout", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/admin.js"), "utf8")
    .replace(/^import .*;\r?\n/gm, "");
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      const classes = new Set(selector === ".ad-shell" ? ["is-locked"] : []);
      elements.set(selector, {
        hidden: false,
        textContent: "",
        innerHTML: "",
        classList: {
          add: (value) => classes.add(value),
          remove: (value) => classes.delete(value),
          contains: (value) => classes.has(value),
        },
        addEventListener() {},
        setAttribute() {},
      });
    }
    return elements.get(selector);
  };
  let onAuthChange;
  let startFetch;
  let finishFetch;
  const fetchStarted = new Promise((resolve) => { startFetch = resolve; });
  const pendingResponse = new Promise((resolve) => { finishFetch = resolve; });
  vm.runInNewContext(source, {
    auth: {},
    onAuthStateChanged: (_auth, callback) => { onAuthChange = callback; },
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    fetch: async () => { startFetch(); return pendingResponse; },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    window: {},
  }, { filename: "src/admin.js" });

  const oldSession = onAuthChange({ email: "admin@example.com", getIdToken: async () => "old-token" });
  await fetchStarted;
  await onAuthChange(null);
  finishFetch({ ok: true, json: async () => ({ ok: true, metrics: {}, recentAudit: [] }) });
  await oldSession;

  assert.equal(element(".ad-shell").classList.contains("is-locked"), true);
  assert.equal(element("#adContent").hidden, true);
  assert.equal(element("#adGate").hidden, false);
  assert.equal(element("#adAccount").textContent, "Não conectado");
});
