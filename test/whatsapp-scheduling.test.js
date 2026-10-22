const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTextIntent } = require("../api/_lib/parseCommandIntent");
const { buildNotifications } = require("../api/send-reminders")._test;
const { buttonFallbackText, parseFinanceReferenceCommand, sendWhatsAppDocument } = require("../api/whatsapp-webhook")._test;

const parse = (text) => parseTextIntent({ text, categories: [], today: "2026-10-14", aiEnabled: false });

test("tarefa por WhatsApp conserva horário e antecedência sem contaminar o título", async () => {
  const parsed = await parse("me lembra de pagar boleto sexta às 15h, 30 minutos antes");
  assert.deepEqual(parsed.task, {
    action: "create", title: "pagar boleto", dueDate: "2026-10-16",
    dueTime: "15:00", reminder: 30, priority: "Media",
  });
  const notices = buildNotifications({ tasks: [{ id: "boleto", status: "Pendente", ...parsed.task }] },
    "2026-10-16", new Date("2026-10-16T17:30:00Z"), "America/Sao_Paulo");
  assert.equal(notices.some((notice) => notice.key === "task_boleto"), true);
});

test("compromisso por WhatsApp conserva hora e antecedência personalizada", async () => {
  const parsed = await parse("marca reunião amanhã às 9h, com antecedência de 1 hora");
  assert.deepEqual(parsed.event, {
    title: "reunião", date: "2026-10-15", time: "09:00", reminder: 60, location: "",
  });
  const notices = buildNotifications({ events: [{ id: "reuniao", ...parsed.event }] },
    "2026-10-15", new Date("2026-10-15T11:00:00Z"), "America/Sao_Paulo");
  assert.equal(notices.some((notice) => notice.key === "event_reuniao"), true);
});

test("na hora, meia hora e valor em reais não confundem antecedência", async () => {
  assert.equal((await parse("marca consulta sexta às 10h na hora")).event.reminder, 0);
  assert.equal((await parse("marca consulta sexta às 10h 5 min antes")).event.reminder, 5);
  assert.equal((await parse("marca consulta sexta às 10h 1 dia antes")).event.reminder, 1440);
  assert.equal((await parse("me lembra de ligar sexta às 10h meia hora antes")).task.reminder, 30);
  const money = (await parse("me lembra de pagar 30 reais amanhã às 9h")).task;
  assert.equal(money.reminder, 15);
  assert.equal(money.dueTime, "09:00");
  assert.equal(money.title, "pagar 30 reais");
  const afternoon = (await parse("me lembra de ligar amanhã às 3 da tarde, 15 min antes")).task;
  assert.equal(afternoon.dueTime, "15:00");
  assert.equal(afternoon.title, "ligar");
});

test("fallback financeiro oferece comandos textuais para editar e excluir", () => {
  const id = "wa_01234567-89ab-cdef-0123-456789abcdef";
  const message = buttonFallbackText("Gasto registrado!", [
    { id: `fin:edit:${id}`, title: "Editar" },
    { id: `fin:delete:${id}`, title: "Excluir" },
  ]);
  assert.match(message, /editar #abcdef/);
  assert.match(message, /excluir #abcdef/);
  assert.deepEqual(parseFinanceReferenceCommand("excluir #abcdef"), { action: "delete", reference: "abcdef" });
  const confirmation = buttonFallbackText("Excluir?", [
    { id: `fin:confirm_delete:${id}`, title: "Sim, excluir" },
    { id: `fin:cancel_delete:${id}`, title: "Cancelar" },
  ]);
  assert.match(confirmation, /confirmar exclusão #abcdef/);
  assert.deepEqual(parseFinanceReferenceCommand("confirmar exclusao #abcdef"), { action: "confirm_delete", reference: "abcdef" });
  assert.equal(parseFinanceReferenceCommand("excluir #qualquer"), null);
});

test("falha da Meta ao enviar PDF não é reportada como sucesso", async () => {
  const originalFetch = global.fetch;
  const originalPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const originalToken = process.env.WHATSAPP_ACCESS_TOKEN;
  try {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 131053 } }) });
    await assert.rejects(sendWhatsAppDocument("5531999999999", "media-id", "relatorio.pdf", "Relatório"), /meta_document_rejected/);
  } finally {
    global.fetch = originalFetch;
    if (originalPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhoneId;
    if (originalToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = originalToken;
  }
});
