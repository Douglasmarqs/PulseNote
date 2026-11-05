const test = require("node:test");
const assert = require("node:assert/strict");
const { askPulsinho, buildAssistantContext, purchaseAmountFromQuestion } = require("../api/_lib/pulsinhoAssistant");

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
