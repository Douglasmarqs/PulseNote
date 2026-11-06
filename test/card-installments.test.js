const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInstallmentPlan } = require("../src/card-installments.js");

test("distribui centavos sem alterar o valor total", () => {
  const plan = buildInstallmentPlan({ amount: 100, installments: 3, purchaseDate: "2026-11-03", closingDay: 5, dueDay: 12 });
  assert.deepEqual(plan.map((item) => item.amount), [33.34, 33.33, 33.33]);
  assert.equal(plan.reduce((sum, item) => sum + item.amount, 0), 100);
  assert.deepEqual(plan.map((item) => item.dueDate), ["2026-11-12", "2026-12-12", "2027-01-12"]);
});

test("compra depois do fechamento entra na fatura seguinte", () => {
  const [invoice] = buildInstallmentPlan({ amount: 49.9, installments: 1, purchaseDate: "2026-11-20", closingDay: 15, dueDay: 8 });
  assert.equal(invoice.monthKey, "2026-12");
  assert.equal(invoice.dueDate, "2026-12-08");
});

test("ajusta vencimento para o último dia de meses curtos", () => {
  const [invoice] = buildInstallmentPlan({ amount: 10, purchaseDate: "2027-02-01", closingDay: 10, dueDay: 31 });
  assert.equal(invoice.dueDate, "2027-02-28");
});
