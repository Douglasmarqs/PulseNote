(function exposeRecurringDetector(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PulseRecurringDetector = api;
})(typeof window !== "undefined" ? window : globalThis, function recurringDetectorFactory() {
  const list = (value) => Array.isArray(value) ? value : [];
  const workspaceOf = (item) => String(item?.workspaceId || "personal");
  const normalize = (value) => String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 1;
  };

  function detectRecurringSuggestions({ finances = [], recurrents = [], workspaceId = "personal" } = {}) {
    const existing = new Set(list(recurrents)
      .filter((item) => workspaceOf(item) === workspaceId)
      .map((item) => `${item.type === "receita" ? "receita" : "despesa"}|${normalize(item.description)}`));
    const groups = new Map();

    for (const entry of list(finances)) {
      if (workspaceOf(entry) !== workspaceId || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || ""))) continue;
      const description = normalize(entry.description);
      const amount = Number(entry.amount);
      if (description.length < 3 || !Number.isFinite(amount) || amount <= 0) continue;
      const type = entry.type === "receita" ? "receita" : "despesa";
      const key = `${type}|${entry.category || "outros"}|${description}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    return [...groups.entries()].flatMap(([key, entries]) => {
      const months = new Set(entries.map((item) => item.date.slice(0, 7)));
      if (months.size < 2) return [];
      const first = entries[0];
      const type = first.type === "receita" ? "receita" : "despesa";
      if (existing.has(`${type}|${normalize(first.description)}`)) return [];
      const amounts = entries.map((item) => Number(item.amount));
      const averageAmount = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
      const maxDeviation = Math.max(...amounts.map((amount) => Math.abs(amount - averageAmount) / averageAmount));
      if (maxDeviation > 0.12) return [];
      const days = entries.map((item) => Number(item.date.slice(8, 10)));
      const typicalDay = median(days);
      const daySpread = Math.max(...days) - Math.min(...days);
      return [{
        key,
        description: String(first.description || "Recorrência").trim().slice(0, 80),
        type,
        categoryId: first.category || (type === "receita" ? "outros_receita" : "outros"),
        amount: Math.round(averageAmount * 100) / 100,
        day: typicalDay,
        occurrences: months.size,
        confidence: daySpread <= 4 && maxDeviation <= 0.05 ? "high" : "medium",
      }];
    }).sort((a, b) => b.occurrences - a.occurrences || a.description.localeCompare(b.description)).slice(0, 6);
  }

  return { detectRecurringSuggestions };
});
