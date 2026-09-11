const test = require("node:test");
const assert = require("node:assert/strict");

const reminderHandler = require("../api/send-reminders");
const { buildPdfReportBuffer } = require("../api/_lib/buildPdfReport");
const { parseTextIntent } = require("../api/_lib/parseCommandIntent");
const { buildNotifications, todayInTimeZone, zonedDateTimeToUtc } = reminderHandler._test;

test("converte a data local de São Paulo para UTC sem antecipar o compromisso", () => {
  const instant = zonedDateTimeToUtc("2026-09-10", "09:00", "America/Sao_Paulo");
  assert.equal(instant.toISOString(), "2026-09-10T12:00:00.000Z");
  assert.equal(todayInTimeZone(new Date("2026-09-10T01:30:00.000Z"), "America/Sao_Paulo"), "2026-09-09");
});

test("respeita lembrete configurado de 15 minutos no fuso da pessoa", () => {
  const now = new Date("2026-09-10T11:45:00.000Z"); // 08:45 em São Paulo
  const notifications = buildNotifications({
    tasks: [],
    goals: [],
    finances: [],
    events: [{ id: "consulta", title: "Consulta", date: "2026-09-10", time: "09:00", reminder: 15 }],
  }, "2026-09-10", now, "America/Sao_Paulo");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].key, "event_consulta");
});

test("gera um PDF válido para o relatório do WhatsApp", () => {
  const pdf = buildPdfReportBuffer({
    monthLabel: "setembro de 2026",
    isClosed: false,
    entries: [
      { date: "2026-09-01", description: "Freela", categoryLabel: "Trabalho", type: "receita", amount: 500 },
      { date: "2026-09-02", description: "Mercado", categoryLabel: "Alimentacao", type: "despesa", amount: 84.5 },
    ],
  });

  assert.ok(pdf.subarray(0, 8).toString("ascii").startsWith("%PDF-1."));
  assert.ok(pdf.toString("latin1").includes("PULSENOTE - RELATORIO FINANCEIRO"));
  assert.ok(pdf.toString("latin1").includes("xref"));
});

test("comandos essenciais do WhatsApp não dependem da IA", async () => {
  const options = { categories: [], today: "2026-09-11" };

  assert.deepEqual(await parseTextIntent({ ...options, text: "ajuda" }), { ok: true, intent: "help" });
  assert.deepEqual(await parseTextIntent({ ...options, text: "relatório do mês passado" }), {
    ok: true, intent: "report", report: { month: 8, year: 2026, format: "texto" },
  });
  assert.deepEqual(await parseTextIntent({ ...options, text: "manda o PDF do mês passado" }), {
    ok: true, intent: "report", report: { month: 8, year: 2026, format: "arquivo" },
  });
  assert.deepEqual(await parseTextIntent({ ...options, text: "comparado ao mês passado, quanto gastei mais?" }), {
    ok: true, intent: "stats", stats: { month: 9, year: 2026, compare: { month: 8, year: 2026 } },
  });
});
