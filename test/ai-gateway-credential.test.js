// O token OIDC das Functions da Vercel chega no header x-vercel-oidc-token
// (não em process.env). Sem ler o header, a IA nunca era chamada em produção
// e o Pulsinho caía sempre na resposta pronta.
const test = require("node:test");
const assert = require("node:assert/strict");

function freshModule() {
  const modulePath = require.resolve("../api/_lib/aiGatewayFetch");
  delete require.cache[modulePath];
  return require(modulePath);
}

function withEnv(values, fn) {
  const keys = ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "AI_GATEWAY_OPENAI_MODEL", "AI_GATEWAY_ANTHROPIC_MODEL", "AI_GATEWAY_MODEL", "AI_GATEWAY_MODELS"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  Object.assign(process.env, values);
  return Promise.resolve()
    .then(fn)
    .finally(() => keys.forEach((key) => (saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key]))));
}

test("lê o token OIDC do header da requisição quando não há chave nem env", () => withEnv({}, () => {
  const gateway = freshModule();
  assert.equal(gateway.gatewayCredential(), "");
  assert.equal(gateway.gatewayCredentialSource(), "none");
  assert.equal(gateway.rememberRequestOidc({ headers: { "x-vercel-oidc-token": "tok-from-header" } }), true);
  assert.equal(gateway.gatewayCredential(), "tok-from-header");
  assert.equal(gateway.gatewayCredentialSource(), "oidc_request");
}));

test("lê o token do contexto de requisição da Vercel", () => withEnv({}, () => {
  const gateway = freshModule();
  const symbol = Symbol.for("@vercel/request-context");
  const previous = globalThis[symbol];
  globalThis[symbol] = { get: () => ({ headers: { "x-vercel-oidc-token": "tok-from-context" } }) };
  try {
    assert.equal(gateway.gatewayCredential(), "tok-from-context");
    assert.equal(gateway.gatewayCredentialSource(), "oidc_context");
  } finally {
    if (previous === undefined) delete globalThis[symbol]; else globalThis[symbol] = previous;
  }
}));

test("chave fixa do AI Gateway tem prioridade sobre o OIDC", () => withEnv({ AI_GATEWAY_API_KEY: "fixed-key" }, () => {
  const gateway = freshModule();
  gateway.rememberRequestOidc({ headers: { "x-vercel-oidc-token": "tok" } });
  assert.equal(gateway.gatewayCredential(), "fixed-key");
}));

test("envia o token do header ao gateway, pede raciocínio baixo no GPT e cai para o Claude se o GPT falhar", () => withEnv({
  AI_GATEWAY_OPENAI_MODEL: "openai/gpt-5-mini",
  AI_GATEWAY_ANTHROPIC_MODEL: "anthropic/claude-haiku-5.5",
}, async () => {
  const gateway = freshModule();
  gateway.rememberRequestOidc({ headers: { "x-vercel-oidc-token": "tok-runtime" } });
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ auth: options.headers.Authorization, model: body.model, reasoning: body.reasoning });
    if (body.model.startsWith("openai/")) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" } }] }) };
    return { ok: true, status: 200, json: async () => ({ model: body.model, choices: [{ message: { content: '{"reply":"Tô de boa sim!"}' } }] }) };
  };
  try {
    const result = await gateway.fetchGatewayJson({ systemPrompt: "s", userPrompt: "ta de boa aí?", label: "test", timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.equal(result.parsed.reply, "Tô de boa sim!");
    assert.deepEqual(calls.map((c) => c.model), ["openai/gpt-5-mini", "anthropic/claude-haiku-5.5"]);
    assert.ok(calls.every((c) => c.auth === "Bearer tok-runtime"));
    assert.deepEqual(calls[0].reasoning, { effort: "low", exclude: true });
    assert.equal(calls[1].reasoning, undefined);
  } finally {
    global.fetch = originalFetch;
  }
}));

test("sem credencial nenhuma, avisa no log e não chama a rede", () => withEnv({ AI_GATEWAY_MODEL: "openai/gpt-5-mini" }, async () => {
  const gateway = freshModule();
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { ok: false }; };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const result = await gateway.fetchGatewayJson({ systemPrompt: "s", userPrompt: "oi", label: "test" });
    assert.equal(result.error, "ai_gateway_not_configured");
    assert.equal(called, false);
    assert.ok(warnings.some(([name]) => name === "ai_gateway_not_configured"));
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  }
}));

test("403 de um modelo (fora do plano gratuito) tenta o próximo; 403 de cartão não verificado para", () => withEnv({
  AI_GATEWAY_API_KEY: "k",
  AI_GATEWAY_OPENAI_MODEL: "openai/gpt-5-mini",
  AI_GATEWAY_ANTHROPIC_MODEL: "anthropic/claude-haiku-5.5",
}, async () => {
  const gateway = freshModule();
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    let calls = [];
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.model);
      if (body.model.startsWith("anthropic/")) {
        return { ok: false, status: 403, text: async () => JSON.stringify({ error: { type: "forbidden", message: "Model requires purchased credits (free tier)" } }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"reply":"oi"}' } }] }) };
    };
    const ok = await gateway.fetchGatewayJson({ systemPrompt: "s", userPrompt: "oi", providerPreference: "anthropic", timeoutMs: 5000 });
    assert.equal(ok.ok, true);
    assert.deepEqual(calls, ["anthropic/claude-haiku-5.5", "openai/gpt-5-mini"]);
    assert.ok(warnings.some(([, meta]) => meta?.errorMessage?.includes("free tier")));

    calls = [];
    global.fetch = async (url, options) => {
      calls.push(JSON.parse(options.body).model);
      return { ok: false, status: 403, text: async () => JSON.stringify({ error: { type: "customer_verification_required", message: "Add a payment method" } }) };
    };
    const blocked = await gateway.fetchGatewayJson({ systemPrompt: "s", userPrompt: "oi", timeoutMs: 5000 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errorType, "customer_verification_required");
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = originalFetch;
    console.warn = originalWarn;
  }
}));
