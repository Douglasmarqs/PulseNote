const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSuggestions, applySuggestionAction } = require("../api/_lib/autopilot");

const now = new Date("2026-10-14T13:00:00.000Z"); // 10:00 em São Paulo
const base = { timeZone: "America/Sao_Paulo", tasks: [], events: [], notes: [], finances: [], finGoals: [] };

test("assinaturas recorrentes geram economia anual e ignoram contas fixas e pausadas", () => {
  const state = { ...base, finRecurrents: [
    { id: "r1", description: "Streaming Plus", amount: 49.9, type: "despesa", categoryId: "assinaturas", day: 5 },
    { id: "r2", description: "Produtividade Pro", amount: 29.9, type: "despesa", categoryId: "outros", day: 9 },
    { id: "r3", description: "Internet", amount: 149.9, type: "despesa", categoryId: "assinaturas", day: 20 },
    { id: "r4", description: "Netflix", amount: 39.9, type: "despesa", categoryId: "assinaturas", day: 3, active: false },
    { id: "r5", description: "Salário", amount: 8500, type: "receita", categoryId: "salario", day: 5 },
  ] };
  const item = buildSuggestions(state, now).find((s) => s.kind === "recurring_subscriptions");
  assert.ok(item);
  assert.equal(item.area, "finances");
  assert.equal(item.metadata.monthly, 79.8);
  assert.equal(item.metadata.yearly, 957.6);
  assert.deepEqual(item.metadata.ids, ["r1", "r2"]);
  assert.match(item.reason, /2 assinaturas ativas/);
  assert.equal(item.metrics.length, 2);
  assert.equal(item.impact.tone, "positive");

  const { patch } = applySuggestionAction(state, item, "create_subscription_review_task", now);
  assert.equal(patch.tasks[0].autopilotSource, "subscriptions:2026-10");
  assert.equal(patch.tasks[0].subtasks.length, 2);
  assert.ok(!buildSuggestions({ ...state, tasks: patch.tasks }, now).some((s) => s.kind === "recurring_subscriptions"), "não repete no mesmo mês");

  const paused = applySuggestionAction(state, item, "pause_subscription_recurrents", now).patch.finRecurrents;
  assert.deepEqual(paused.filter((r) => r.active === false).map((r) => r.id).sort(), ["r1", "r2", "r4"]);
  assert.equal(paused.find((r) => r.id === "r3").active, undefined, "internet continua ativa");
  assert.throws(() => applySuggestionAction({ ...state, finRecurrents: paused }, item, "pause_subscription_recurrents", now), /stale_suggestion/);
});

test("semana cheia sugere planejamento uma vez por semana", () => {
  const tasks = ["a", "b", "c"].map((id, index) => ({ id, title: `Tarefa ${id}`, status: "Pendente", dueDate: `2026-10-${15 + index}` }));
  const state = { ...base, tasks, events: [{ id: "e1", title: "Reunião", date: "2026-10-16", time: "10:00" }] };
  const item = buildSuggestions(state, now).find((s) => s.kind === "plan_week");
  assert.ok(item);
  assert.equal(item.title, "Planejar a próxima semana");
  assert.match(item.reason, /3 tarefas pendentes e 1 compromisso/);
  const { patch } = applySuggestionAction(state, item, "create_week_plan_task", now);
  assert.equal(patch.tasks[0].title, "Planejar a próxima semana");
  assert.equal(patch.tasks[0].subtasks.length, 3);
  assert.ok(!buildSuggestions({ ...state, tasks: patch.tasks }, now).some((s) => s.kind === "plan_week"));
});

test("notas sem categoria são organizadas em pastas por assunto", () => {
  const notes = [
    { id: "n1", title: "Pauta da reunião com cliente" },
    { id: "n2", title: "Resumo do curso de IA" },
    { id: "n3", title: "Ideias para o fim de semana" },
    { id: "n4", title: "Já organizada", folder: "Trabalho" },
  ];
  const state = { ...base, notes };
  const item = buildSuggestions(state, now).find((s) => s.kind === "organize_notes");
  assert.ok(item);
  assert.equal(item.area, "notes");
  const { patch } = applySuggestionAction(state, item, "organize_notes_folders", now);
  const byId = Object.fromEntries(patch.notes.map((note) => [note.id, note.folder]));
  assert.deepEqual(byId, { n1: "Trabalho", n2: "Estudos", n3: "Pessoal", n4: "Trabalho" });
  assert.ok(!buildSuggestions({ ...state, notes: patch.notes }, now).some((s) => s.kind === "organize_notes"));
});

test("toda sugestão traz métricas e impacto para o cartão do quadro", () => {
  const state = {
    ...base,
    tasks: [{ id: "t1", title: "Pagar boleto", status: "Pendente", priority: "Alta", dueDate: "2026-10-10" }],
    events: [{ id: "e1", title: "Consulta", date: "2026-10-15", time: "09:00" }],
    notes: [{ id: "n1", title: "Viagem", checklist: [{ text: "Passaporte", done: false }] }],
    finGoals: [{ categoryId: "mercado", limit: 100 }],
    finances: [{ type: "despesa", category: "mercado", amount: 120, date: "2026-10-02" }],
  };
  for (const item of buildSuggestions(state, now)) {
    assert.ok(Array.isArray(item.metrics) && item.metrics.length, item.kind);
    assert.ok(item.impact?.value, item.kind);
  }
});
