const test = require("node:test");
const assert = require("node:assert/strict");

const { buildNotifications, todayInTimeZone, validTimeZone, sendWhatsAppReminder } = require("../api/send-reminders")._test;
const { META_GRAPH_VERSION } = require("../api/_lib/metaGraph");

test("fuso inválido salvo por um usuário usa São Paulo sem derrubar o cron", () => {
  assert.equal(validTimeZone("Mars/Olympus"), "America/Sao_Paulo");
  assert.equal(validTimeZone(null), "America/Sao_Paulo");
  assert.equal(validTimeZone("Europe/Lisbon"), "Europe/Lisbon");
  assert.equal(validTimeZone(" Europe/Lisbon "), "Europe/Lisbon");
  assert.equal(todayInTimeZone(new Date("2026-09-10T01:30:00Z"), validTimeZone("Mars/Olympus")), "2026-09-09");
});

test("lembrete zero ou desligado conserva a intenção também no servidor", () => {
  const state = {
    tasks: [
      { id: "hora", title: "Na hora", dueDate: "2026-09-10", dueTime: "09:00", reminder: 0 },
      { id: "off", title: "Sem aviso", dueDate: "2026-09-10", dueTime: "09:00", reminder: false },
    ],
    events: [{ id: "off", title: "Sem aviso", date: "2026-09-10", time: "09:00", reminder: "none" }],
    goals: [], finances: [],
  };
  const before = buildNotifications(state, "2026-09-10", new Date("2026-09-10T11:45:00Z"), "America/Sao_Paulo");
  const due = buildNotifications(state, "2026-09-10", new Date("2026-09-10T12:00:00Z"), "America/Sao_Paulo");
  assert.deepEqual(before.map((item) => item.key), []);
  assert.deepEqual(due.map((item) => item.key), ["task_hora"]);
});

test("resumos do cron não incluem tarefas cujo lembrete foi desligado", () => {
  const today = "2026-09-10";
  const now = new Date("2026-09-10T12:00:00Z");
  const tasks = [
    { id: "late-off", title: "Antiga", status: "Pendente", dueDate: "2026-09-09", reminder: false },
    { id: "today-off", title: "Hoje", status: "Pendente", dueDate: today, reminder: "none" },
  ];
  assert.deepEqual(buildNotifications({ tasks }, today, now).map((item) => item.key), []);
  tasks.push({ id: "today-on", title: "Outra", status: "Pendente", dueDate: today });
  assert.deepEqual(buildNotifications({ tasks }, today, now).map((item) => item.key), ["tasksToday"]);
});

test("coleções antigas ou malformadas não interrompem os outros lembretes", () => {
  const now = new Date("2026-09-10T11:45:00Z");
  const notifications = buildNotifications({
    tasks: [null, { id: "t1", title: "Pagar conta", status: "Pendente", dueDate: "2026-09-10", dueTime: "09:00", reminder: 15 }],
    events: "invalid",
    goals: [null],
    finances: [null, { date: 123 }],
  }, "2026-09-10", now, "America/Sao_Paulo");
  assert.deepEqual(notifications.map((item) => item.key), ["task_t1"]);
});

test("lembrete WhatsApp usa a versão vigente da Graph API e o template aprovado", async () => {
  const keys = ["WHATSAPP_REMINDER_TEMPLATE_NAME", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"];
  const previous = keys.map((key) => process.env[key]);
  const originalFetch = global.fetch;
  let request;
  try {
    process.env.WHATSAPP_REMINDER_TEMPLATE_NAME = "pulsenote_lembrete";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "12345";
    global.fetch = async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ messages: [{ id: "wamid.test" }] }) };
    };
    assert.equal(await sendWhatsAppReminder("5531999999999", "Pagar boleto às 09:00"), "wamid.test");
    assert.equal(request.url, `https://graph.facebook.com/${META_GRAPH_VERSION}/12345/messages`);
    assert.equal(request.body.template.name, "pulsenote_lembrete");
    assert.equal(request.body.template.components[0].parameters[0].text, "Pagar boleto às 09:00");
  } finally {
    global.fetch = originalFetch;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
