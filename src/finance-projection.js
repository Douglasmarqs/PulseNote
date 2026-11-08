(function exposeFinanceProjection(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PulseFinanceProjection = api;
})(typeof window !== "undefined" ? window : globalThis, function financeProjectionFactory() {
  const list = (value) => Array.isArray(value) ? value : [];
  const money = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : 0;
  const workspaceOf = (item) => String(item?.workspaceId || "personal");

  function buildMonthProjection({
    monthKey,
    workspaceId = "personal",
    startingBalance = 0,
    finances = [],
    recurrents = [],
    scheduledFinances = [],
    creditCards = [],
  } = {}) {
    if (!/^\d{4}-\d{2}$/.test(String(monthKey || ""))) throw new TypeError("invalid_month");
    const [year, month] = monthKey.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const actual = list(finances).filter((item) => item?.date?.startsWith(monthKey) && workspaceOf(item) === workspaceId);
    const projectedEntries = [];

    const alreadyMaterialized = (item) => actual.some((entry) =>
      String(entry.description || "").trim().toLowerCase() === String(item.description || "").trim().toLowerCase()
      && money(entry.amount) === money(item.amount)
    );

    for (const item of list(recurrents)) {
      if (workspaceOf(item) !== workspaceId || item.active === false || list(item.skippedMonths).includes(monthKey) || alreadyMaterialized(item)) continue;
      const day = Math.max(1, Math.min(daysInMonth, Number(item.day) || 1));
      projectedEntries.push({
        id: `projection:recurring:${item.id || item.description}:${monthKey}`,
        date: `${monthKey}-${String(day).padStart(2, "0")}`,
        description: String(item.description || "Lançamento recorrente"),
        amount: money(item.amount),
        type: item.type === "receita" ? "receita" : "despesa",
        category: item.categoryId || item.category || (item.type === "receita" ? "outros_receita" : "outros"),
        workspaceId,
        projected: true,
        projectionSource: "recurring",
      });
    }

    for (const item of list(scheduledFinances)) {
      if (workspaceOf(item) !== workspaceId || item.status === "cancelled" || !item?.date?.startsWith(monthKey)) continue;
      projectedEntries.push({
        id: `projection:scheduled:${item.id || item.description}:${item.date}`,
        date: item.date,
        description: String(item.description || "Lançamento agendado"),
        amount: money(item.amount),
        type: item.type === "receita" ? "receita" : "despesa",
        category: item.categoryId || item.category || (item.type === "receita" ? "outros_receita" : "outros"),
        workspaceId,
        projected: true,
        projectionSource: "scheduled",
      });
    }

    for (const card of list(creditCards)) {
      if (workspaceOf(card) !== workspaceId || card.archived === true) continue;
      for (const invoice of list(card.invoices)) {
        if (invoice.status === "paid" || !invoice?.dueDate?.startsWith(monthKey)) continue;
        projectedEntries.push({
          id: `projection:card:${card.id || card.name}:${invoice.id || invoice.dueDate}`,
          date: invoice.dueDate,
          description: `Fatura ${String(card.name || "do cartão")}`,
          amount: money(invoice.amount),
          type: "despesa",
          category: "contas",
          workspaceId,
          projected: true,
          projectionSource: "card",
        });
      }
    }

    const byDate = {};
    for (const item of [...actual, ...projectedEntries]) {
      if (!byDate[item.date]) byDate[item.date] = { receita: 0, despesa: 0, actual: [], projected: [] };
      byDate[item.date][item.type === "receita" ? "receita" : "despesa"] += money(item.amount);
      byDate[item.date][item.projected ? "projected" : "actual"].push(item);
    }

    let running = money(startingBalance);
    const days = {};
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${monthKey}-${String(day).padStart(2, "0")}`;
      const flow = byDate[date] || { receita: 0, despesa: 0, actual: [], projected: [] };
      running = money(running + flow.receita - flow.despesa);
      days[String(day).padStart(2, "0")] = { ...flow, balance: running };
    }

    return { monthKey, workspaceId, startingBalance: money(startingBalance), days, projectedEntries };
  }

  return { buildMonthProjection };
});
