// Pulsinho "perdia o modo IA" logo depois de uma pergunta: o plano gratuito
// do AI Gateway limita requisições por modelo (429) e respostas cortadas
// (JSON incompleto) eram descartadas. Estes testes cobrem as duas saídas.
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.AI_GATEWAY_API_KEY = "test-key";
process.env.AI_GATEWAY_MODELS = "anthropic/claude-haiku,openai/gpt-mini";
const { fetchGatewayJson, salvageReply, _rateLimitedUntil } = require("../api/_lib/aiGatewayFetch");

function reply(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
const answer = (content) => reply(200, { model: "x", choices: [{ message: { content } }] });
const limited = (retryAfter = "1") => reply(429, { error: { type: "rate_limit_exceeded", message: "slow down" } }, { "retry-after": retryAfter });

function withFetch(responses, fn) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    const next = responses.shift();
    return typeof next === "function" ? next(body) : next;
  };
  return fn(calls).finally(() => { global.fetch = original; });
}

const base = { systemPrompt: "s", userPrompt: "oi", messages: [], label: "t", timeoutMs: 8000, totalBudgetMs: 20000 };

test("429 no primeiro modelo: responde pelo segundo e a próxima pergunta já começa por ele", async () => {
  _rateLimitedUntil.clear();
  await withFetch([limited("30"), answer('{"reply":"oi pelo gpt"}'), answer('{"reply":"de novo"}')], async (calls) => {
    const first = await fetchGatewayJson(base);
    assert.equal(first.ok, true);
    assert.equal(first.parsed.reply, "oi pelo gpt");
    const second = await fetchGatewayJson(base);
    assert.equal(second.ok, true);
    assert.deepEqual(calls, ["anthropic/claude-haiku", "openai/gpt-mini", "openai/gpt-mini"]);
  });
});

test("todos os modelos em 429: espera o pedido de pausa e tenta de novo", async () => {
  _rateLimitedUntil.clear();
  await withFetch([limited("1"), limited("1"), answer('{"reply":"voltei"}')], async (calls) => {
    const started = Date.now();
    const result = await fetchGatewayJson(base);
    assert.equal(result.ok, true);
    assert.equal(result.parsed.reply, "voltei");
    assert.equal(calls.length, 3);
    assert.ok(Date.now() - started >= 900, "respeitou o retry-after");
  });
});

test("sem tempo sobrando, não fica esperando: devolve o 429", async () => {
  _rateLimitedUntil.clear();
  await withFetch([limited("1"), limited("1")], async (calls) => {
    const result = await fetchGatewayJson({ ...base, totalBudgetMs: 5000 });
    assert.equal(result.ok, false);
    assert.equal(result.error, "ai_rate_limited");
    assert.equal(calls.length, 2);
  });
});

test("JSON cortado no meio: aproveita o texto do reply em vez de cair no modo sem IA", async () => {
  _rateLimitedUntil.clear();
  // cortado no limite de tokens: o reply nem chega a fechar as aspas
  await withFetch([answer(String.raw`{"reply":"Seu saldo está ótimo.\nVocê gastou menos que`)], async () => {
    const result = await fetchGatewayJson(base);
    assert.equal(result.ok, true);
    assert.match(result.parsed.reply, /^Seu saldo está ótimo\.\nVocê gastou menos que/);
    assert.equal(result.parsed.salvaged, true);
  });
});

test("salvageReply: texto corrido vale; lixo não vale", () => {
  assert.deepEqual(salvageReply("Claro! Você tem 3 tarefas hoje."), { reply: "Claro! Você tem 3 tarefas hoje.", salvaged: true });
  assert.equal(salvageReply("{\"followUps\": [\"a\""), null);
  assert.equal(salvageReply(""), null);
  assert.equal(salvageReply("```json\n{\"reply\":\"ok\\\"aspas\\\"\"").reply, 'ok"aspas"');
});
