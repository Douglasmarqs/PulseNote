"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("src/admin.html");
const js = read("src/admin.js");
const css = read("src/admin-studio.css");

// O módulo da prévia é ESM puro: copia para .mjs temporário e importa.
async function loadPreview() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pn-preview-"));
  const file = path.join(dir, "admin-preview.mjs");
  fs.copyFileSync(path.join(root, "src/admin-preview.js"), file);
  return import(pathToFileURL(file).href);
}

test("estúdio: estrutura de três colunas (ordem, editor, prévia ao vivo)", () => {
  assert.match(html, /admin-studio\.css\?v=2/);
  assert.match(html, /plan-cards\.css\?v=\d+/);
  assert.match(js, /from "\.\/plan-cards\.js"/);
  for (const fn of ["function bindPlanStudio", "function syncDirty", "function savePlanDraft", "function startNewPlan", "studioDirty("]) assert.ok(js.includes(fn), fn);
  assert.match(js, /data-plan-save/);
  assert.match(js, /data-plan-discard/);
  assert.match(js, /"plan-order"/);
  assert.match(css, /\.ps-layout \{ display: grid; grid-template-columns: 268px/);
});

test("estúdio: aviso antes de sair com alterações não salvas", () => {
  assert.match(js, /beforeunload/);
  assert.match(js, /typeof window\?\.addEventListener === "function"/);
});

test("paleta de comandos e ações rápidas ligadas na inicialização", () => {
  assert.match(html, /id="adCmdTrigger"/);
  assert.match(html, /id="adCmd"/);
  assert.match(html, /id="adQuick"/);
  assert.match(js, /bindPlanStudio\(\);\s*bindCommandPalette\(\);\s*bindQuickActions\(\);\s*bindGrowthCrosshair\(\);/);
});

test("prévia local só liga com a flag em localhost ou prévia do projeto", () => {
  const block = js.slice(js.indexOf("const PREVIEW = ("), js.indexOf("let previewModule"));
  const PREVIEW = (loc) => new Function("globalThis", `return ${block.replace("const PREVIEW = ", "").replace(/;\s*$/, "")}`)({ location: loc });
  assert.equal(PREVIEW({ hostname: "localhost", search: "?designPreview=1" }), true);
  assert.equal(PREVIEW({ hostname: "127.0.0.1", search: "?designPreview=1" }), true);
  assert.equal(PREVIEW({ hostname: "localhost", search: "" }), false);
  assert.equal(PREVIEW({ hostname: "pulsenote.app", search: "?designPreview=1" }), false);
  assert.equal(PREVIEW({ hostname: "localhost.evil.com", search: "?designPreview=1" }), false);
});

test("prévia: dados fictícios respondem às leituras e às mudanças de plano", async () => {
  const preview = await loadPreview();
  const { plans } = await preview.previewRequest("plans");
  assert.ok(plans.length >= 3);
  for (const plan of plans) assert.equal(typeof plan.subscribers.active, "number");
  const ids = plans.map((plan) => plan.id).reverse();
  const { order } = await preview.previewRequest("plan-order", { ids });
  assert.deepEqual(order.map((item) => item.id), ids);
  const after = (await preview.previewRequest("plans")).plans.map((plan) => plan.id);
  assert.deepEqual(after, ids);
  const saved = await preview.previewRequest("plan-save", { id: plans[0].id, name: "Novo nome" });
  assert.equal(saved.plan.name, "Novo nome");
  const { events } = await preview.previewRequest("audit");
  assert.equal(events[0].action, "plan_saved");
  for (const user of (await preview.previewRequest("directory")).users) assert.match(user.email, /@exemplo\.com$/);
});
