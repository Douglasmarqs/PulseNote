const test = require("node:test");
const assert = require("node:assert/strict");

const reminderHandler = require("../api/send-reminders");
const { buildPdfReportBuffer } = require("../api/_lib/buildPdfReport");
const { parseTextIntent } = require("../api/_lib/parseCommandIntent");
const { guessSpecificCategoryId, guessType } = require("../api/_lib/localTextFallback");
const { formatWhatsAppFinanceConfirmation, formatWhatsAppAmount, isPhotoNoteRequest, isDestructiveAudioIntent } = require("../api/whatsapp-webhook")._test;
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

test("envia a tarefa com horário na antecedência escolhida", () => {
  const now = new Date("2026-09-10T11:45:00.000Z"); // 08:45 em São Paulo
  const notifications = buildNotifications({
    tasks: [{ id: "boleto", title: "Pagar boleto", status: "Pendente", dueDate: "2026-09-10", dueTime: "09:00", reminder: 15 }],
    goals: [],
    finances: [],
    events: [],
  }, "2026-09-10", now, "America/Sao_Paulo");

  assert.deepEqual(notifications.map((item) => item.key), ["task_boleto"]);
  assert.match(notifications[0].plain, /Pagar boleto/);
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

  assert.deepEqual(await parseTextIntent({ ...options, text: "minhas tarefas" }), {
    ok: true, intent: "agenda", agenda: { filter: "todas" },
  });
  assert.deepEqual(await parseTextIntent({ ...options, text: "me lembra de pagar o boleto amanhã" }), {
    ok: true, intent: "task_action", task: { action: "create", title: "pagar o boleto", dueDate: "2026-09-12", dueTime: "", reminder: 15, priority: "Media" },
  });
  assert.deepEqual(await parseTextIntent({ ...options, text: "concluí a tarefa do dentista" }), {
    ok: true, intent: "task_action", task: { action: "complete", query: "dentista" },
  });
  assert.deepEqual(await parseTextIntent({ ...options, text: "anota: ideia pro projeto novo" }), {
    ok: true, intent: "note_action", note: { action: "create", title: "ideia pro projeto novo" },
  });
  assert.deepEqual(await parseTextIntent({ ...options, text: "criar meta economizar 5000 esse ano" }), {
    ok: true, intent: "goal_action", goal: { action: "create", title: "economizar esse ano", target: 5000 },
  });
  assert.deepEqual(await parseTextIntent({ ...options, text: "avancei 200 na minha meta de economia" }), {
    ok: true, intent: "goal_action", goal: { action: "update", query: "economia", mode: "delta", value: 200 },
  });
  assert.deepEqual(await parseTextIntent({ ...options, text: "marca reunião com cliente amanhã às 15h" }), {
    ok: true, intent: "event_create", event: { title: "reunião com cliente", date: "2026-09-12", time: "15:00", reminder: 15, location: "" },
  });
  assert.deepEqual(await parseTextIntent({ ...options, text: "quanto gastei com uber esse mês" }), {
    ok: true, intent: "finance_search", search: { query: "uber", month: null, year: null },
  });
});

test("classifica pão e bolo como Alimentação, nunca como Contas", () => {
  const categories = [
    { id: "contas", type: "despesa", label: "💡 Contas e Utilidades" },
    { id: "alimentacao", type: "despesa", label: "🍔 Restaurante/Delivery" },
    { id: "mercado", type: "despesa", label: "🛒 Mercado" },
  ];

  assert.equal(guessSpecificCategoryId("gastei 18 com pão e bolo", "despesa", categories), "alimentacao");
  assert.equal(guessSpecificCategoryId("paguei 90 de luz", "despesa", categories), "contas");
});

test("um presente comprado é despesa; um presente recebido é receita", () => {
  assert.equal(guessType("comprei presente de 20 reais"), "despesa");
  assert.equal(guessType("recebi presente de 20 reais"), "receita");
  assert.equal(guessSpecificCategoryId("aulas de canto", "despesa", [
    { id: "aulas", type: "despesa", label: "Aulas" },
  ]), "aulas");
});

test("reconhece marcas e itens cotidianos na categoria correta", () => {
  const categories = [
    { id: "alimentacao", type: "despesa", label: "🍔 Restaurante/Delivery" },
    { id: "mercado", type: "despesa", label: "🛒 Mercado" },
    { id: "combustivel", type: "despesa", label: "⛽ Combustível" },
    { id: "saude", type: "despesa", label: "💊 Saúde" },
    { id: "pet", type: "despesa", label: "🐾 Pet" },
    { id: "contas", type: "despesa", label: "💡 Contas e Utilidades" },
  ];

  for (const [message, expected] of [
    ["Mac Donalds 40", "alimentacao"],
    ["gasto coxinha 5", "alimentacao"],
    ["Assaí 120", "mercado"],
    ["Drogasil 35", "saude"],
    ["ração do cachorro 90", "pet"],
    ["posto 180", "combustivel"],
    ["Cemig 96", "contas"],
  ]) {
    assert.equal(guessSpecificCategoryId(message, "despesa", categories), expected, message);
  }
});

test("WhatsApp mantém dois centavos e responde com ações de edição/exclusão", async () => {
  const categories = [{ id: "alimentacao", type: "despesa", label: "🍔 Alimentação" }];
  const parsed = await parseTextIntent({
    text: "gastei 10,90 com pão", categories, today: "2026-10-13", aiEnabled: false,
  });
  assert.equal(parsed.entry.amount, 10.9);
  assert.equal(formatWhatsAppAmount(parsed.entry.amount), "10,90");
  const confirmation = formatWhatsAppFinanceConfirmation({
    id: "wa_123456abcdef", type: "despesa", amount: parsed.entry.amount,
    description: "Pão", category: "alimentacao", date: "2026-10-13",
    whatsappRawMessage: "gastei 10,90 com pão no pix",
  }, parsed.entry, categories);
  assert.match(confirmation, /✅ Novo Gasto Registrado!/);
  assert.match(confirmation, /🗂️ Categoria: Alimentação/);
  assert.match(confirmation, /💸 Valor: R\$ 10,90/);
  assert.match(confirmation, /📅 Data: 13\/10\/2026/);
  assert.match(confirmation, /💳 Pagamento: Pix/);
  const short = await parseTextIntent({ text: "pão 3 reais", categories, today: "2026-10-13", aiEnabled: false });
  assert.equal(short.intent, "expense");
  assert.equal(short.entry.categoryId, "alimentacao");
  const ambiguous = await parseTextIntent({ text: "quero guardar 100", categories, today: "2026-10-13", aiEnabled: false });
  assert.equal(ambiguous.ok, false);
});

test("foto de nota fiscal segue como documento financeiro, não anotação", () => {
  assert.equal(isPhotoNoteRequest("nota fiscal"), false);
  assert.equal(isPhotoNoteRequest("nota de compra"), false);
  assert.equal(isPhotoNoteRequest("nota"), true);
  assert.equal(isPhotoNoteRequest("anotar esta imagem"), true);
  assert.equal(isPhotoNoteRequest("salvar nota: reunião"), true);
});

test("comandos destrutivos por áudio exigem que a pessoa os digite", () => {
  assert.equal(isDestructiveAudioIntent({ ok: true, intent: "finance_delete_last" }), true);
  assert.equal(isDestructiveAudioIntent({ ok: true, intent: "task_action", task: { action: "delete" } }), true);
  assert.equal(isDestructiveAudioIntent({ ok: true, intent: "note_action", note: { action: "create" } }), false);
});
