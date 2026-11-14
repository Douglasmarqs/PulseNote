const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
// O projeto é CommonJS; os módulos de src/ são ES. Copiamos para uma pasta
// temporária com extensão .mjs (ajustando o import relativo) e importamos de lá.
const os = require("node:os");
let tmpDir = null;
function load(file) {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulsenote-esm-"));
  const name = path.basename(file).replace(/\.js$/, ".mjs");
  const source = read(file).replace(/from "\.\/([\w-]+)\.js"/g, 'from "./$1.mjs"');
  for (const dep of ["notification-prefs.js", "onboarding.js"]) {
    const depName = dep.replace(/\.js$/, ".mjs");
    const target = path.join(tmpDir, depName);
    if (!fs.existsSync(target)) fs.writeFileSync(target, read(`src/${dep}`).replace(/from "\.\/([\w-]+)\.js"/g, 'from "./$1.mjs"'));
  }
  void source;
  return import(require("node:url").pathToFileURL(path.join(tmpDir, name)).href);
}

// Elemento mínimo para simular cliques no assistente sem precisar de DOM.
function click(root, selectorMap) {
  const handler = root.listeners.get("click");
  const target = { closest: (selector) => selectorMap[selector] || null };
  handler({ target });
}

function harness(onboarding, initial = {}) {
  const state = { onboardingDone: false, preferredWorkspace: "personal", tasks: [], notes: [], ...initial };
  const calls = { patches: [], workspace: [], whatsapp: 0, views: [], toasts: [], push: 0 };
  const root = {
    hidden: true, innerHTML: "", listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    querySelector() { return null; },
  };
  const g = global;
  g.document = { body: { classList: { add() {}, remove() {} } }, activeElement: null };
  g.window = { confirm: () => true };
  const controller = onboarding.createOnboarding({
    root,
    getState: () => state,
    patchState: (patch) => { calls.patches.push(patch); Object.assign(state, patch); },
    setWorkspace: (id) => calls.workspace.push(id),
    startWhatsappLink: () => { calls.whatsapp += 1; },
    requestPush: async () => { calls.push += 1; return true; },
    botNumber: "+55 31 98773-7048",
    openView: (view, opts) => calls.views.push([view, opts]),
    toast: (message) => calls.toasts.push(message),
    firstName: () => "Lucas",
  });
  return { controller, state, calls, root };
}

test("contas novas abrem a configuração inicial e contas com dados não", async () => {
  const onboarding = await load("src/onboarding.js");
  assert.equal(onboarding.shouldShowOnboarding({ onboardingDone: false }), true);
  assert.equal(onboarding.shouldShowOnboarding({ onboardingDone: true }), false);
  assert.equal(onboarding.hasUserData({ tasks: [{ id: 1 }] }), true);
  assert.equal(onboarding.hasUserData({ tasks: [], notes: [], finances: [] }), false);
  assert.equal(onboarding.hasUserData({ whatsappLinkedPhone: "5511987654321" }), true);

  const fresh = harness(onboarding);
  fresh.controller.sync();
  assert.equal(fresh.root.hidden, false);
  assert.match(fresh.root.innerHTML, /Configuração inicial/);

  const done = harness(onboarding, { onboardingDone: true });
  done.controller.sync();
  assert.equal(done.root.hidden, true);
});

test("fluxo completo: espaço, WhatsApp, notificações e conclusão gravam no estado", async () => {
  const onboarding = await load("src/onboarding.js");
  const { controller, calls, root } = harness(onboarding);
  controller.sync();

  click(root, { "[data-ob-space]": { dataset: { obSpace: "family" } } });
  assert.equal(controller._view.space, "family");
  click(root, { "[data-ob]": { dataset: { ob: "next" } } });
  assert.equal(controller._view.step, 2);

  click(root, { "[data-ob]": { dataset: { ob: "whatsapp" } } });
  assert.equal(calls.whatsapp, 1, "usa o mesmo vínculo de Configurações");
  click(root, { "[data-ob]": { dataset: { ob: "next" } } }); // pular por enquanto
  assert.equal(controller._view.step, 3);

  click(root, { "[data-ob-pref]": { dataset: { obPref: "spending" } } });
  assert.equal(controller._view.prefs.spending, false);
  click(root, { "[data-ob]": { dataset: { ob: "finish" } } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.push, 1, "pede permissão de aviso quando há categoria ligada");
  assert.deepEqual(calls.workspace, ["family"]);
  const patch = calls.patches.at(-1);
  assert.equal(patch.onboardingDone, true);
  assert.equal(patch.preferredWorkspace, "family");
  assert.deepEqual(patch.notificationPrefs, { tasks: true, agenda: true, spending: false, dailySummary: true });
  assert.equal(patch.appReminderOptIn, true);
  assert.equal(controller._view.done, true);
  assert.match(root.innerHTML, /Tudo pronto/);

  click(root, { "[data-ob]": { dataset: { ob: "enter" } } });
  assert.equal(controller.isOpen(), false);
  assert.deepEqual(calls.views.at(-1), ["dashboard", undefined]);
});

test("com todas as notificações desligadas não pede permissão ao navegador", async () => {
  const onboarding = await load("src/onboarding.js");
  const { controller, calls, root } = harness(onboarding);
  controller.sync();
  controller.preview(3);
  for (const key of ["tasks", "agenda", "spending", "dailySummary"]) click(root, { "[data-ob-pref]": { dataset: { obPref: key } } });
  click(root, { "[data-ob]": { dataset: { ob: "finish" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.push, 0);
  assert.equal(calls.patches.at(-1).appReminderOptIn, undefined);
});

test("o vínculo do WhatsApp chegando pelo webhook atualiza o passo sozinho", async () => {
  const onboarding = await load("src/onboarding.js");
  const { controller, state, root } = harness(onboarding);
  controller.sync();
  controller.preview(2);
  assert.match(root.innerHTML, /Conectar WhatsApp/);
  state.whatsappLinkedPhone = "5511987654321";
  controller.sync();
  assert.match(root.innerHTML, /\+55 11 98765-4321/);
  assert.match(root.innerHTML, /WhatsApp conectado/);
});

test("pular a configuração marca como concluída e não reabre", async () => {
  const onboarding = await load("src/onboarding.js");
  const { controller, calls, root } = harness(onboarding);
  controller.sync();
  click(root, { "[data-ob]": { dataset: { ob: "skip" } } });
  assert.deepEqual(calls.patches.at(-1), { onboardingDone: true });
  assert.equal(controller.isOpen(), false);
  controller.sync();
  assert.equal(controller.isOpen(), false);
});

test("formata telefones brasileiros do WhatsApp", async () => {
  const { formatWhatsappPhone } = await load("src/onboarding.js");
  assert.equal(formatWhatsappPhone("5511987654321"), "+55 11 98765-4321");
  assert.equal(formatWhatsappPhone("551187654321"), "+55 11 8765-4321");
  assert.equal(formatWhatsappPhone("14155550123"), "+14155550123");
  assert.equal(formatWhatsappPhone(""), "");
});

test("preferências de notificação: módulo do navegador e do servidor concordam", async () => {
  const client = await load("src/notification-prefs.js");
  const server = require("../api/_lib/notificationPrefs");
  const keys = ["tasksOverdue", "tasksToday", "task_1", "event_7", "goal_x_almost", "goalDue_2", "financeWarning", "financeCritical", "outro"];
  const prefSets = [null, {}, { tasks: false }, { agenda: false }, { spending: false }, { dailySummary: false }, { tasks: false, agenda: false, spending: false, dailySummary: false }];
  for (const prefs of prefSets) for (const key of keys) {
    assert.equal(client.isNotificationEnabled(prefs, key), server.isNotificationEnabled(prefs, key), `${JSON.stringify(prefs)} ${key}`);
    assert.equal(client.notificationCategory(key), server.notificationCategory(key));
  }
  assert.deepEqual(client.normalizeNotificationPrefs({ spending: false, tasks: "x" }), { tasks: true, agenda: true, spending: false, dailySummary: true });
  assert.deepEqual(client.normalizeNotificationPrefs(null), { tasks: true, agenda: true, spending: true, dailySummary: true });
});

test("servidor de lembretes respeita as categorias desligadas", () => {
  const { buildNotifications } = require("../api/send-reminders")._test;
  const today = "2026-09-10";
  const now = new Date("2026-09-10T15:00:00Z");
  const base = {
    tasks: [
      { id: "a", title: "Atrasada", status: "Pendente", dueDate: "2026-09-08" },
      { id: "b", title: "Hoje", status: "Pendente", dueDate: today },
    ],
    finances: [
      { type: "receita", amount: 1000, date: "2026-09-02" },
      { type: "despesa", amount: 950, date: "2026-09-03" },
    ],
  };
  const keys = (state) => buildNotifications(state, today, now, "America/Sao_Paulo").map((item) => item.key);
  const all = keys(base);
  assert.ok(all.includes("tasksOverdue") && all.some((key) => key.startsWith("finance")), all.join());

  assert.ok(!keys({ ...base, notificationPrefs: { tasks: false } }).includes("tasksOverdue"));
  assert.ok(!keys({ ...base, notificationPrefs: { spending: false } }).some((key) => key.startsWith("finance")));
  assert.ok(keys({ ...base, notificationPrefs: { tasks: false } }).some((key) => key.startsWith("finance")), "outras categorias continuam");
  assert.deepEqual(keys({ ...base, notificationPrefs: { tasks: false, agenda: false, spending: false, dailySummary: false } }), []);
});

test("app registra a configuração inicial e as preferências no estado e nos arquivos de cache", () => {
  const app = read("src/app.js");
  const html = read("src/index.html");
  const sw = read("src/sw.js");
  assert.match(html, /id="onboardingRoot"/);
  assert.match(app, /import \{ createOnboarding, hasUserData \} from "\.\/onboarding\.js"/);
  assert.match(app, /parsed\.notificationPrefs = normalizeNotificationPrefs/);
  assert.match(app, /function startWhatsappLink\(\)/);
  assert.match(app, /getOnboarding\(\)\?\.sync\(\)/);
  assert.match(read("src/notifications.js"), /notificationPrefEnabled\("agenda"\)/);
  assert.match(sw, /\/src\/boards\.css/);
  assert.match(sw, /\/src\/auth-boards\.css/);
});

test("login mantém todos os campos e botões usados pelo auth.js", () => {
  const html = read("src/login.html");
  for (const id of ["loginForm", "registerForm", "loginEmail", "loginPassword", "regName", "regEmail", "regPassword", "regPasswordConfirm", "loginBtn", "registerBtn", "loginError", "registerError", "pwStrengthFill", "pwStrengthLabel"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /data-google-signin/);
  assert.match(html, /data-switch="register"/);
  assert.match(html, /data-switch="login"/);
  assert.match(html, /href="\/forgot-password"/);
  assert.match(html, /Continuar com o Google/);
  assert.match(html, /Sua vida, organizada/);
});
