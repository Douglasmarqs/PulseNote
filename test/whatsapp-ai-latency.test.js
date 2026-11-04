const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTextIntent } = require("../api/_lib/parseCommandIntent");

test("intent ambígua não repete Gemini quando o provedor está indisponível", async () => {
  const previousFetch = global.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  let calls = 0;

  process.env.GEMINI_API_KEY = "test-key";
  global.fetch = async () => {
    calls += 1;
    return { ok: false, status: 503 };
  };

  try {
    const result = await parseTextIntent({
      text: "quero organizar melhor meu dinheiro",
      today: "2026-11-03",
      categories: [
        { id: "outros", type: "despesa", label: "Outros" },
        { id: "outros_receita", type: "receita", label: "Outras receitas" },
      ],
    });

    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
