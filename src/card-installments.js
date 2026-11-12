(function exposeCardInstallments(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PulseCardInstallments = api;
})(typeof window !== "undefined" ? window : globalThis, function cardInstallmentsFactory() {
  const monthKey = (date, offset = 0) => {
    const base = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
    return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const dueDateFor = (key, dueDay) => {
    const [year, month] = key.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${key}-${String(Math.min(Math.max(1, dueDay), lastDay)).padStart(2, "0")}`;
  };

  function buildInstallmentPlan({ amount, installments = 1, purchaseDate, closingDay = 1, dueDay = 10 } = {}) {
    const totalCents = Math.round(Number(amount) * 100);
    const count = Math.min(48, Math.max(1, Math.trunc(Number(installments) || 1)));
    const date = new Date(`${purchaseDate}T12:00:00Z`);
    if (!Number.isFinite(totalCents) || totalCents <= 0 || Number.isNaN(date.getTime())) throw new TypeError("invalid_purchase");
    const firstOffset = date.getUTCDate() > Number(closingDay) ? 1 : 0;
    const baseCents = Math.floor(totalCents / count);
    let remainder = totalCents - (baseCents * count);

    return Array.from({ length: count }, (_, index) => {
      const cents = baseCents + (remainder-- > 0 ? 1 : 0);
      const invoiceMonth = monthKey(date, firstOffset + index);
      return {
        monthKey: invoiceMonth,
        dueDate: dueDateFor(invoiceMonth, Number(dueDay) || 1),
        amount: cents / 100,
        installmentNumber: index + 1,
        totalInstallments: count,
      };
    });
  }

  return { buildInstallmentPlan };
});
