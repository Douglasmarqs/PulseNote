const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFinanceForecast } = require("../api/_lib/financeForecast");

test("simulador considera saldo real, recorrências, fatura e reserva configurada", () => {
  const forecast = buildFinanceForecast({
    timeZone: "America/Sao_Paulo",
    activeWorkspaceId: "family",
    financialSettings: { safetyReserve: 500 },
    financeAccounts: [{ id: "main", workspaceId: "family", currentBalance: 3150 }],
    finRecurrents: [
      { id: "utilities", workspaceId: "family", description: "Luz e internet", amount: 310, type: "despesa", day: 25 },
    ],
    creditCards: [{ id: "card", workspaceId: "family", name: "Nubank", invoices: [{ dueDate: "2026-11-22", amount: 1180, status: "open" }] }],
  }, { now: new Date("2026-11-18T15:00:00Z"), purchaseAmount: 600 });

  assert.equal(forecast.currentBalance, 3150);
  assert.equal(forecast.projectedBalance, 1660);
  assert.equal(forecast.projectedBalanceAfterPurchase, 1060);
  assert.equal(forecast.safeToSpend, 1160);
  assert.equal(forecast.canAfford, true);
  assert.equal(forecast.commitments.length, 2);
});

test("simulador não mistura lançamentos de outro espaço", () => {
  const forecast = buildFinanceForecast({
    financeAccounts: [
      { id: "personal", workspaceId: "personal", currentBalance: 1000 },
      { id: "couple", workspaceId: "couple", currentBalance: 9000 },
    ],
    financialSettings: { safetyReserve: 200 },
    finRecurrents: [
      { id: "rent", workspaceId: "personal", description: "Aluguel", amount: 700, type: "despesa", day: 20 },
      { id: "trip", workspaceId: "couple", description: "Viagem", amount: 3000, type: "despesa", day: 20 },
    ],
  }, { now: new Date("2026-11-10T15:00:00Z"), workspaceId: "personal", purchaseAmount: 200 });

  assert.equal(forecast.currentBalance, 1000);
  assert.equal(forecast.commitments.length, 1);
  assert.equal(forecast.commitments[0].description, "Aluguel");
  assert.equal(forecast.canAfford, false);
});

test("dados legados continuam funcionando, mas sinalizam baixa confiança", () => {
  const forecast = buildFinanceForecast({
    finances: [
      { id: "income", type: "receita", amount: 2500, date: "2026-11-01" },
      { id: "expense", type: "despesa", amount: 900, date: "2026-11-03" },
    ],
  }, { now: new Date("2026-11-10T15:00:00Z") });

  assert.equal(forecast.currentBalance, 1600);
  assert.equal(forecast.confidence, "low");
  assert.match(forecast.reasons[0], /saldo atual das contas/i);
});
