const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/autopilot-ui.js"), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.classList = { contains: () => false };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener() {}
  focus() {}
}

function fakeDocument(activeView = "autopilotView") {
  const elements = new Map();
  for (const id of [
    "autopilotList", "autopilotStatus", "autopilotPreview", "autopilotConfirmModal",
    "autopilotConfirmDescription", "autopilotConfirmApply", "autopilotRefresh",
    "autopilotConfirmCancel", "autopilotConfirmClose", "autopilotView", "dashboardView",
  ]) elements.set(id, new FakeElement(id));
  for (const id of ["autopilotView", "dashboardView"]) {
    elements.get(id).classList = { contains: (name) => name === "active-view" && activeView === id };
  }
  return {
    elements,
    setActiveView(view) { activeView = view; },
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return new FakeElement(); },
    addEventListener() {},
    activeElement: null,
  };
}

function response(title) {
  return { ok: true, json: async () => ({ suggestions: [{
    id: "ap_0123456789abcdef0123", title, description: "Motivo", source: "planner",
    priority: "high", actionOptions: [{ action: "complete_task", label: "Concluir" }],
  }] }) };
}

async function eventually(predicate, timeoutMs = 1500) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("condition_not_met");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("Autopilot coalesces Firestore snapshots and discards an in-flight stale response", async () => {
  const previousDocument = global.document;
  const previousFetch = global.fetch;
  const document = fakeDocument();
  global.document = document;
  let calls = 0;
  let resolveOld;
  global.fetch = async () => {
    calls++;
    return calls === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : response("Sugestão atual");
  };
  try {
    const { createAutopilotUI } = await import(moduleUrl);
    const ui = createAutopilotUI({ getToken: () => ({ getIdToken: async () => "test-token" }), openArea() {}, notify() {} });
    ui.bind();
    const initial = ui.load();
    await eventually(() => calls === 1);
    ui.invalidate();
    ui.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(calls, 1, "snapshots não devem iniciar buscas simultâneas");
    resolveOld(response("Sugestão antiga"));
    await initial;
    await eventually(() => calls === 2);
    await eventually(() => document.elements.get("autopilotList").children.length === 1);
    assert.equal(document.elements.get("autopilotList").children[0].children[1].textContent, "Sugestão atual");
    assert.equal(calls, 2, "duas mudanças rápidas devem gerar só uma nova busca");
  } finally {
    global.document = previousDocument;
    global.fetch = previousFetch;
  }
});

test("Autopilot does not fetch while hidden and loads on entry", async () => {
  const previousDocument = global.document;
  const previousFetch = global.fetch;
  const document = fakeDocument("plannerView");
  global.document = document;
  let calls = 0;
  global.fetch = async () => { calls++; return response("Sugestão ao abrir"); };
  try {
    const { createAutopilotUI } = await import(moduleUrl);
    const ui = createAutopilotUI({ getToken: () => ({ getIdToken: async () => "test-token" }), openArea() {}, notify() {} });
    ui.bind();
    ui.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(calls, 0);
    document.setActiveView("autopilotView");
    await ui.show();
    await eventually(() => document.elements.get("autopilotList").children.length === 1);
    assert.equal(calls, 1);
  } finally {
    global.document = previousDocument;
    global.fetch = previousFetch;
  }
});

test("Autopilot refreshes on entry when a hidden snapshot invalidated an in-flight request", async () => {
  const previousDocument = global.document;
  const previousFetch = global.fetch;
  const document = fakeDocument("plannerView");
  global.document = document;
  let calls = 0;
  let resolveOld;
  global.fetch = async () => {
    calls++;
    return calls === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : response("Depois do WhatsApp");
  };
  try {
    const { createAutopilotUI } = await import(moduleUrl);
    const ui = createAutopilotUI({ getToken: () => ({ getIdToken: async () => "test-token" }), openArea() {}, notify() {} });
    ui.bind();
    const oldRequest = ui.load();
    await eventually(() => calls === 1);
    ui.invalidate();
    document.setActiveView("autopilotView");
    const entering = ui.show();
    resolveOld(response("Antes do WhatsApp"));
    await Promise.all([oldRequest, entering]);
    assert.equal(calls, 2);
    assert.equal(document.elements.get("autopilotList").children[0].children[1].textContent, "Depois do WhatsApp");
  } finally {
    global.document = previousDocument;
    global.fetch = previousFetch;
  }
});
