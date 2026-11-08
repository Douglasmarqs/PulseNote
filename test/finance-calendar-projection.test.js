const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMonthProjection } = require("../src/finance-projection");

test("calendário financeiro acumula saldo real e compromissos previstos por dia", () => {
  const result = buildMonthProjection({
    monthKey: "2026-11",
    workspaceId: "family",
    startingBalance: 1000,
    finances: [
      { id: "salary", workspaceId: "family", date: "2026-11-05", type: "receita", amount: 2000, description: "Salário" },
      { id: "market", workspaceId: "family", date: "2026-11-06", type: "despesa", amount: 250, description: "Mercado" },
    ],
    recurrents: [
      { id: "rent", workspaceId: "family", day: 10, type: "despesa", amount: 900, description: "Aluguel", categoryId: "moradia" },
    ],
    creditCards: [
      { id: "card", workspaceId: "family", name: "Nubank", invoices: [{ id: "invoice", dueDate: "2026-11-15", amount: 400, status: "open" }] },
    ],
  });

  assert.equal(result.days["05"].balance, 3000);
  assert.equal(result.days["06"].balance, 2750);
  assert.equal(result.days["10"].balance, 1850);
  assert.equal(result.days["15"].balance, 1450);
  assert.equal(result.days["10"].projected[0].description, "Aluguel");
  assert.equal(result.days["15"].projected[0].description, "Fatura Nubank");
});

test("recorrência já lançada não é duplicada e outro espaço fica isolado", () => {
  const result = buildMonthProjection({
    monthKey: "2026-11",
    workspaceId: "personal",
    finances: [
      { id: "paid", workspaceId: "personal", date: "2026-11-08", type: "despesa", amount: 80, description: "Internet" },
      { id: "other", workspaceId: "family", date: "2026-11-08", type: "despesa", amount: 900, description: "Internet" },
    ],
    recurrents: [
      { id: "internet", workspaceId: "personal", day: 8, type: "despesa", amount: 80, description: "Internet" },
    ],
  });

  assert.equal(result.projectedEntries.length, 0);
  assert.equal(result.days["08"].despesa, 80);
  assert.equal(result.days["08"].balance, -80);
});
