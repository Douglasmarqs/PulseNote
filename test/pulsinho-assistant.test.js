const test = require("node:test");
const assert = require("node:assert/strict");
const { askPulsinho, buildAssistantContext, buildLocalAssistantAnswer, purchaseAmountFromQuestion } = require("../api/_lib/pulsinhoAssistant");

test("entende perguntas naturais de compra sem depender de comando fixo", async () => {
  assert.equal(purchaseAmountFromQuestion("Será que consigo comprar um tênis de R$ 350,90?"), 350.9);
  assert.equal(purchaseAmountFromQuestion("quanto gastei no mercado?"), 0);

  const result = await askPulsinho({
    question: "Posso gastar 600 reais hoje?",
    state: {
      financeAccounts: [{ id: "main", workspaceId: "personal", currentBalance: 2200 }],
      financialSettings: { safetyReserve: 500 },
      finRecurrents: [{ id: "rent", workspaceId: "personal", description: "Aluguel", amount: 900, type: "despesa", day: 25 }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "simulation");
  assert.equal(result.forecast.canAfford, true);
  assert.match(result.reply, /R\$\s*600,00/);
});

test("contexto enviado ao modelo é resumido e não inclui o corpo privado das notas", () => {
  const forecast = {
    workspaceId: "personal", today: "2026-11-04", currentBalance: 1000, projectedBalance: 800,
    safeToSpend: 300, dailySafeToSpend: 20, reserve: 500, confidence: "high", reasons: [], commitments: [],
  };
  const context = buildAssistantContext({
    notes: [{ title: "Ideias", description: "segredo que não deve ir para o modelo" }],
    tasks: [], events: [], goals: [], finances: [],
  }, forecast);
  assert.deepEqual(context.noteTitles, ["Ideias"]);
  assert.doesNotMatch(JSON.stringify(context), /segredo que não deve/);
});

test("responde consultas operacionais sem depender da disponibilidade da IA externa", async () => {
  const state = {
    financeAccounts: [{ id: "main", workspaceId: "personal", currentBalance: 1450 }],
    financialSettings: { safetyReserve: 300 },
    finRecurrents: [{ id: "rent", workspaceId: "personal", description: "Aluguel", amount: 800, type: "despesa", day: 25 }],
    tasks: [{ id: "task-1", title: "Enviar proposta", status: "Pendente", dueDate: "2026-11-07", priority: "Alta" }],
    events: [], goals: [], notes: [], finances: [],
  };
  const balance = await askPulsinho({ state, question: "Como estão minhas finanças?" });
  assert.equal(balance.ok, true);
  assert.equal(balance.provider, "pulse-engine");
  assert.equal(balance.navigationTarget, "finances");
  assert.match(balance.reply, /R\$\s*1\.450,00/);

  const tasks = await askPulsinho({ state, question: "Quais tarefas estão pendentes?" });
  assert.equal(tasks.provider, "pulse-engine");
  assert.equal(tasks.navigationTarget, "planner");
  assert.match(tasks.reply, /Enviar proposta/);
});

test("fallback local é explícito e preserva uma próxima ação útil", () => {
  const forecast = {
    workspaceId: "personal", today: "2026-11-06", currentBalance: 500, projectedBalance: 500,
    safeToSpend: 200, dailySafeToSpend: 20, reserve: 300, confidence: "medium", reasons: [], commitments: [],
  };
  const context = buildAssistantContext({
    tasks: [{ id: "1", title: "Pagar condomínio", status: "Pendente", dueDate: "2026-11-07" }],
    events: [], goals: [], notes: [], finances: [],
  }, forecast);
  const answer = buildLocalAssistantAnswer("me ajuda a organizar", context, forecast, { fallback: true });
  assert.equal(answer.provider, "pulse-engine");
  assert.match(answer.reply, /IA externa demorou/);
  assert.match(answer.reply, /Pagar condomínio/);
});
