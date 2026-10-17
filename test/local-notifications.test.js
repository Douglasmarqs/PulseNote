const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/notifications.js"), "utf8");
const dueAt = new Date("2026-09-10T09:00:00").getTime();

function loadNotifications({ permission = "granted", now = dueAt, state, localToday } = {}) {
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
  }
  class NotificationStub {
    static permission = permission;
    static async requestPermission() { permissionRequests++; return "granted"; }
  }
  const context = {
    Date: FixedDate,
    Notification: NotificationStub,
    navigator: { serviceWorker: { ready: Promise.resolve({
      showNotification: async (title, options) => { shown.push({ title, ...options }); },
    }) } },
    localStorage: {
      getItem: (key) => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
    },
    setInterval: () => 1,
    console,
    window: {
      Notification: NotificationStub,
      PulseNoteState: state,
      PulseNoteShowToast: () => {},
      PulseNotePush: { enablePushNotifications: async () => { pushRegistrations++; return true; } },
    },
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
