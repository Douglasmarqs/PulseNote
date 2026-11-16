const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { learnedCategoryId, categoryHabits, buildCategoryList } = require("../api/_lib/financeCategories");
const { normalizeAction } = require("../api/_lib/pulsinhoActions");
const { guessSpecificCategoryId } = require("../api/_lib/localTextFallback");

const history = {
  finances: [
    { id: "1", type: "despesa", description: "Padoca do Zé", category: "mercado" },
    { id: "2", type: "despesa", description: "Padoca do Zé", category: "mercado" },
    { id: "3", type: "despesa", description: "Uber", category: "transporte" },
    { id: "4", type: "receita", description: "Cliente Acme", category: "freelance" },
    { id: "5", type: "despesa", description: "Loja X", category: "outros" },
  ],
};

test("aprende com o histórico: a forma como a pessoa categoriza vence o palpite", () => {
  assert.equal(learnedCategoryId(history, "padoca do ze", "despesa"), "mercado");
  assert.equal(learnedCategoryId(history, "Padoca do Zé pão", "despesa"), "mercado");
  assert.equal(learnedCategoryId(history, "Cliente Acme", "receita"), "freelance");
  assert.equal(learnedCategoryId(history, "Loja X", "despesa"), "", "'outros' não ensina nada");
  assert.equal(learnedCategoryId(history, "Uber", "receita"), "", "tipo diferente não conta");
  assert.deepEqual(categoryHabits(history).map((h) => h.descricao), ["Padoca do Zé", "Uber", "Cliente Acme"]);
});

test("conversa do Pulsinho usa o histórico mesmo se a IA escolher outra categoria", () => {
  const action = normalizeAction(
    { type: "add_transaction", amount: 9, title: "Padoca do Zé", categoryId: "alimentacao", categoryConfidence: "baixa" },
    { state: history, categories: buildCategoryList(history), today: "2026-11-15" },
  ).action;
  assert.equal(action.record.category, "mercado");
  assert.equal(action.lowConfidence, false);
});

test("dicionário reconhece receitas e gastos do dia a dia pelo sentido", () => {
  const categories = buildCategoryList({});
  const cases = [
    ["recebi o 13º", "receita", "salario"], ["caiu a PLR", "receita", "salario"],
    ["cliente pagou o site", "receita", "freelance"], ["comissão de vendas", "receita", "freelance"],
    ["vendi a bike na OLX", "receita", "vendas"], ["restituição do imposto", "receita", "reembolso"],
    ["cashback do cartão", "receita", "reembolso"], ["aposentadoria", "receita", "pensao"],
    ["açougue do bairro", "despesa", "mercado"], ["psicólogo", "despesa", "saude"],
    ["recarga do celular", "despesa", "contas"], ["matrícula da escola", "despesa", "educacao"],
  ];
  for (const [text, type, expected] of cases) assert.equal(guessSpecificCategoryId(text, type, categories), expected, text);
});

test("Gemini fora dos textos com dados pessoais quando o plano não é pago", async () => {
  const brainPath = require.resolve("../api/_lib/pulsinhoBrain");
  const calls = { gemini: 0 };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("generativelanguage")) {
      calls.gemini += 1;
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "{\"reply\":\"oi\"}" }] } }] }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GEMINI_API_KEY: "k", AI_GATEWAY_API_KEY: "g", AI_GATEWAY_MODEL: "openai/x" });
    delete process.env.GEMINI_PAID_TIER;
    const { callBrainModel } = require(brainPath);
    const quiet = console.warn;
    console.warn = () => {};
    const free = await callBrainModel({ systemPrompt: "s", history: [], message: "oi" });
    assert.equal(free.ok, false);
    assert.equal(calls.gemini, 0, "plano gratuito: sem reserva no Gemini");
    process.env.GEMINI_PAID_TIER = "true";
    const paid = await callBrainModel({ systemPrompt: "s", history: [], message: "oi" });
    console.warn = quiet;
    assert.equal(calls.gemini, 1, "plano pago confirmado: Gemini volta como reserva");
    assert.equal(paid.ok, true);
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("'Lançar por texto' do app usa o gateway (GPT/Claude) primeiro", async () => {
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push(String(url));
    const content = JSON.stringify({ type: "receita", amount: 300, categoryId: "freelance", description: "Cliente Acme", date: "2026-11-15" });
    return { ok: true, status: 200, json: async () => ({ model: "openai/x", choices: [{ message: { content } }] }) };
  };
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { AI_GATEWAY_API_KEY: "g", AI_GATEWAY_MODEL: "openai/x", GEMINI_API_KEY: "k" });
    delete process.env.GEMINI_PAID_TIER;
    const { parseTransactionText } = require("../api/_lib/parseTransactionAI");
    const info = console.info;
    console.info = () => {};
    const result = await parseTransactionText({ text: "cliente acme pagou 300", categories: buildCategoryList({}), today: "2026-11-15" });
    console.info = info;
    assert.equal(result.ok, true);
    assert.equal(result.entry.categoryId, "freelance");
    assert.ok(seen.every((url) => url.includes("ai-gateway")), "nenhuma chamada ao Gemini");
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("app: toda função chamada por onclick existe na página (erro do Planner)", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const names = new Set([...`${app}\n${html}`.matchAll(/on(?:click|change|input|submit)="([a-zA-Z_]\w*)\(/g)].map((m) => m[1]));
  for (const ignore of ["if", "return", "event", "this", "document", "fn"]) names.delete(ignore);
  for (const name of names) {
    assert.ok(new RegExp(`window\\.${name}\\s*=`).test(app), `onclick chama ${name}, mas ela não está exposta em window`);
  }
  assert.ok(names.has("openPlannerEventActions"));
});

test("app: categoria sugerida pela descrição, sem sobrescrever escolha manual", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  assert.match(app, /function finSuggestCategory\(description/);
  assert.match(app, /select\.dataset\.userPicked === "1"/);
  assert.match(app, /select\.dataset\.userPicked = "1";/);
  assert.match(app, /const learned = finLearnedCategory\(result\.description, result\.type\);/);
});
