const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/notifications.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const dueAt = new Date("2026-09-10T09:00:00").getTime();

function loadNotifications({ permission = "granted", notificationSupported = true, now = dueAt, state, localToday, localHour, pushResult = true } = {}) {
  const shown = [];
  const stored = new Map();
  let pushRegistrations = 0;
  let permissionRequests = 0;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
    getFullYear() { return localToday ? Number(localToday.slice(0, 4)) : super.getFullYear(); }
    getMonth() { return localToday ? Number(localToday.slice(5, 7)) - 1 : super.getMonth(); }
    getDate() { return localToday ? Number(localToday.slice(8, 10)) : super.getDate(); }
    // Hora local fixa: o resultado não depende do fuso de quem roda os testes
    // (a Vercel compila em UTC). Sem localHour, usa 12h (dentro da janela).
    getHours() { return localHour ?? (localToday ? 12 : super.getHours()); }
  }
  class NotificationStub {
    static permission = permission;
    static async requestPermission() { permissionRequests++; return "granted"; }
  }
  const windowStub = {
    PulseNoteState: state,
    PulseNoteShowToast: () => {},
    PulseNotePush: { enablePushNotifications: async () => { pushRegistrations++; return pushResult; } },
  };
  if (notificationSupported) windowStub.Notification = NotificationStub;
  const context = {
    Date: FixedDate,
    Notification: NotificationStub,
    navigator: { serviceWorker: { ready: Promise.resolve({
      showNotification: async (title, options) => { shown.push({ title, ...options }); },
    }) } },
    localStorage: {
      getItem: (key) => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
    setInterval: () => 1,
    console,
    window: windowStub,
  };
  vm.runInNewContext(source, context);
  return { window: context.window, shown, stored, get pushRegistrations() { return pushRegistrations; }, get permissionRequests() { return permissionRequests; } };
}

test("permissão previamente concedida ainda registra o token de push", async () => {
  const app = loadNotifications();
  assert.equal(await app.window.requestNotificationPermission(), true);
  assert.equal(app.permissionRequests, 0);
  assert.equal(app.pushRegistrations, 1);
  assert.equal(app.stored.get("pn_notifications_enabled"), "1");
});

test("o toggle de push reflete a permissão real deste aparelho", () => {
  assert.match(appSource, /appReminderCheckbox\.checked = state\.appReminderOptIn !== false\s*&& window\.pushNotificationsAreRegistered\?\.\(\) === true/);
  assert.match(appSource, /parsed\.appReminderOptIn = parsed\.fcmTokens\.length > 0/);
  assert.match(appSource, /appReminderOptIn: false/);
});

test("falha ao registrar FCM não deixa o aparelho marcado como ativo", async () => {
  const app = loadNotifications({ pushResult: { ok: false, code: "messaging/token-subscribe-failed" } });
  assert.equal(await app.window.requestNotificationPermission(), false);
  assert.equal(app.stored.get("pn_notifications_enabled"), undefined);
  assert.equal(app.window.PulseNotePushSetupStatus.code, "messaging/token-subscribe-failed");
});

test("navegador sem Notification registra diagnóstico explícito", async () => {
  const app = loadNotifications({ notificationSupported: false });
  assert.equal(await app.window.requestNotificationPermission(), false);
  assert.equal(app.pushRegistrations, 0);
  assert.equal(app.window.PulseNotePushSetupStatus.code, "notification-unsupported");
  assert.match(app.stored.get("pn_push_setup_status"), /notification-unsupported/);
});

test("permissão bloqueada registra diagnóstico explícito", async () => {
  const app = loadNotifications({ permission: "denied" });
  assert.equal(await app.window.requestNotificationPermission(), false);
  assert.equal(app.pushRegistrations, 0);
  assert.equal(app.window.PulseNotePushSetupStatus.code, "permission-denied");
  assert.match(app.stored.get("pn_push_setup_status"), /permission-denied/);
});

test("a tela reaproveita o diagnóstico persistido após renderização", () => {
  assert.match(appSource, /localStorage\.getItem\("pn_push_setup_status"\)/);
  assert.match(appSource, /window\.PulseNotePushSetupStatus\s*\|\|\s*persistedPushStatus/);
});

test("lembrete zero dispara na hora e usa a mesma tag do push remoto", async () => {
  const app = loadNotifications({ state: {
    tasks: [{ id: "t1", title: "Pagar conta", status: "Pendente", dueDate: "2026-09-10", dueTime: "09:00", reminder: 0 }],
    events: [{ id: "e1", title: "Consulta", date: "2026-09-10", time: "09:00", reminder: 0 }],
    goals: [], finances: [],
  } });
  app.stored.set("pn_notifications_enabled", "1");
  app.window.runAllNotificationChecks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.shown.map((item) => item.tag), ["task-t1", "event-e1"]);
});

test("desativar o lembrete individual impede alertas locais", async () => {
  const app = loadNotifications({ state: {
    tasks: [{ id: "t1", title: "Pagar conta", status: "Pendente", dueDate: "2026-09-10", dueTime: "09:00", reminder: false }],
    events: [{ id: "e1", title: "Consulta", date: "2026-09-10", time: "09:00", reminder: "none" }],
    goals: [], finances: [],
  } });
  app.stored.set("pn_notifications_enabled", "1");
  app.window.runAllNotificationChecks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.shown.length, 0);
});

test("resumos locais não incluem tarefas cujo lembrete foi desligado", async () => {
  const app = loadNotifications({ state: {
    tasks: [
      { id: "late-off", title: "Antiga", status: "Pendente", dueDate: "2026-09-09", reminder: false },
      { id: "today-off", title: "Hoje", status: "Pendente", dueDate: "2026-09-10", reminder: "none" },
    ],
    events: [], goals: [], finances: [],
  } });
  app.stored.set("pn_notifications_enabled", "1");
  app.window.runAllNotificationChecks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.shown.length, 0);
});

test("desativar lembretes no aplicativo bloqueia também o agendador local", async () => {
  const app = loadNotifications({ state: {
    appReminderOptIn: false,
    tasks: [{ id: "t1", title: "Pagar conta", status: "Pendente", dueDate: "2026-09-10", dueTime: "09:00", reminder: 15 }],
    events: [], goals: [], finances: [],
  } });
  app.stored.set("pn_notifications_enabled", "1");
  assert.equal(app.window.notificationsAreEnabled(), false);
  app.window.runAllNotificationChecks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.shown.length, 0);
});

test("resumo de tarefas usa o dia local, não a data UTC", async () => {
  const app = loadNotifications({
    now: new Date("2026-09-11T00:30:00Z").getTime(),
    localToday: "2026-09-10",
    localHour: 21,
    state: {
      tasks: [{ id: "t1", title: "Hoje", status: "Pendente", dueDate: "2026-09-10", dueTime: "" }],
      events: [], goals: [], finances: [],
    },
  });
  app.stored.set("pn_notifications_enabled", "1");
  app.window.runAllNotificationChecks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.shown.map((item) => item.tag), ["tasks-today"]);
});

test("anti-spam: resumos ficam quietos de madrugada e metas/orçamento não repetem", async () => {
  const state = {
    tasks: [{ id: "t1", title: "Hoje", status: "Pendente", dueDate: "2026-09-10", dueTime: "" }],
    events: [],
    goals: [{ id: "g1", title: "Ler", current: 9, target: 10 }],
    finances: [{ type: "receita", amount: 100, date: "2026-09-01" }, { type: "despesa", amount: 80, date: "2026-09-02" }],
  };
  const night = loadNotifications({ localToday: "2026-09-10", localHour: 23, state });
  night.stored.set("pn_notifications_enabled", "1");
  night.window.runAllNotificationChecks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(night.shown, [], "nada entre 22h e 8h");

  const day = loadNotifications({ localToday: "2026-09-10", localHour: 10, state });
  day.stored.set("pn_notifications_enabled", "1");
  day.window.runAllNotificationChecks();
  day.window.runAllNotificationChecks();
  await new Promise((resolve) => setImmediate(resolve));
  const tags = day.shown.map((item) => item.tag).sort();
  assert.deepEqual(tags, ["finance-warning", "goal-g1", "tasks-today"], "cada aviso uma única vez");
});

test("anti-spam: com push registrado, o navegador não duplica os avisos do servidor", async () => {
  const app = loadNotifications({
    localToday: "2026-09-10",
    state: { tasks: [{ id: "t1", title: "Hoje", status: "Pendente", dueDate: "2026-09-10", dueTime: "" }], events: [], goals: [], finances: [], fcmTokens: ["tok"] },
  });
  app.stored.set("pn_notifications_enabled", "1");
  app.window.runAllNotificationChecks();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.shown, []);
});
