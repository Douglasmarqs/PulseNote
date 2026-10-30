const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTextIntent } = require("../api/_lib/parseCommandIntent");

const parseWithoutAi = (text) => parseTextIntent({
  text, categories: [], today: "2026-10-17", aiEnabled: false,
});

test("comandos explícitos de nova tarefa criam tarefa, sem virar consulta da agenda", async () => {
  for (const text of [
    "adiciona tarefa comprar pão amanhã",
    "nova tarefa comprar pão amanhã",
    "tarefa: comprar pão amanhã",
  ]) {
    const result = await parseWithoutAi(text);
    assert.equal(result.intent, "task_action", text);
    assert.equal(result.task.action, "create", text);
    assert.equal(result.task.title, "comprar pão", text);
    assert.equal(result.task.dueDate, "2026-10-18", text);
  }
  assert.deepEqual(await parseWithoutAi("minhas tarefas"), {
    ok: true, intent: "agenda", agenda: { filter: "todas" },
  });
});

test("busca por gasto em estabelecimento não vira relatório mensal", async () => {
  assert.deepEqual(await parseWithoutAi("quanto gastei em Uber"), {
    ok: true, intent: "finance_search", search: { query: "Uber", month: null, year: null },
  });
  assert.deepEqual(await parseWithoutAi("quanto gastei com Uber esse mês"), {
    ok: true, intent: "finance_search", search: { query: "Uber", month: null, year: null },
  });
  assert.deepEqual(await parseWithoutAi("quanto gastei em julho"), {
    ok: true, intent: "report", report: { month: 7, year: 2026, format: "texto" },
  });
  assert.deepEqual(await parseWithoutAi("quanto gastei com Uber em março de 2025"), {
    ok: true, intent: "finance_search", search: { query: "Uber", month: 3, year: 2025 },
  });
});
