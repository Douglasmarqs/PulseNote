const test = require("node:test");
const assert = require("node:assert/strict");
const { detectRecurringSuggestions } = require("../src/recurring-detector.js");

const expense = (date, amount = 39.9, description = "Netflix", workspaceId = "personal") => ({
  id: `${workspaceId}-${date}`,
  type: "despesa",
  amount,
  category: "assinaturas",
  description,
  date,
  workspaceId,
});

test("detecta uma despesa parecida em meses distintos", () => {
  const suggestions = detectRecurringSuggestions({
    finances: [expense("2026-07-10", 39.9), expense("2026-08-11", 39.9), expense("2026-09-10", 39.9)],
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].description, "Netflix");
  assert.equal(suggestions[0].amount, 39.9);
  assert.equal(suggestions[0].day, 10);
  assert.equal(suggestions[0].occurrences, 3);
  assert.equal(suggestions[0].confidence, "high");
});

test("não sugere uma recorrência que já foi cadastrada", () => {
  const suggestions = detectRecurringSuggestions({
    finances: [expense("2026-08-10"), expense("2026-09-10")],
    recurrents: [{ type: "despesa", description: "Netflix", workspaceId: "personal" }],
  });

  assert.deepEqual(suggestions, []);
});

test("isola sugestões pelo espaço financeiro ativo", () => {
  const finances = [
    expense("2026-08-10", 39.9, "Netflix", "personal"),
    expense("2026-09-10", 39.9, "Netflix", "personal"),
    expense("2026-08-05", 120, "Internet", "family"),
    expense("2026-09-05", 120, "Internet", "family"),
  ];

  const suggestions = detectRecurringSuggestions({ finances, workspaceId: "family" });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].description, "Internet");
});

test("rejeita valores que variam demais para serem uma recorrência confiável", () => {
  const suggestions = detectRecurringSuggestions({
    finances: [expense("2026-08-10", 20), expense("2026-09-10", 80)],
  });

  assert.deepEqual(suggestions, []);
});
