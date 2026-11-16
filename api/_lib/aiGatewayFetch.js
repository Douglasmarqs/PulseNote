function extractJson(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : raw);
}

// Credencial do AI Gateway.
// Na Vercel, o token OIDC das Functions NÃO fica em process.env em tempo de
// execução: ele chega em cada requisição no header "x-vercel-oidc-token"
// (process.env.VERCEL_OIDC_TOKEN só existe no build e no `vercel dev`).
// Por isso lemos, nesta ordem: chave fixa (AI_GATEWAY_API_KEY) → header da
// requisição atual (contexto da Vercel ou o que o handler registrou) →
// variável de ambiente (desenvolvimento local).
const OIDC_HEADER = "x-vercel-oidc-token";
let requestOidcToken = "";
let requestOidcSeenAt = 0;

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const value = headers[name] ?? headers[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] : value || "");
}

function vercelRequestContextToken() {
  try {
    const ctx = globalThis[Symbol.for("@vercel/request-context")];
    return headerValue(ctx?.get?.()?.headers, OIDC_HEADER).trim();
  } catch {
    return "";
  }
}

// Os handlers chamam isto logo no início com o `req` recebido.
function rememberRequestOidc(req) {
  const token = headerValue(req?.headers, OIDC_HEADER).trim();
  if (token) {
    requestOidcToken = token;
    requestOidcSeenAt = Date.now();
  }
  return Boolean(token);
}

function gatewayCredential() {
  const apiKey = String(process.env.AI_GATEWAY_API_KEY || "").trim();
  if (apiKey) return apiKey;
  const fromContext = vercelRequestContextToken();
  if (fromContext) return fromContext;
  // Tokens de Function valem 2h; reaproveitamos o da requisição recente
  // (mesma instância) por no máximo 50 minutos.
  if (requestOidcToken && Date.now() - requestOidcSeenAt < 50 * 60 * 1000) return requestOidcToken;
  return String(process.env.VERCEL_OIDC_TOKEN || "").trim();
}

function gatewayCredentialSource() {
  if (String(process.env.AI_GATEWAY_API_KEY || "").trim()) return "api_key";
  if (vercelRequestContextToken()) return "oidc_context";
  if (requestOidcToken && Date.now() - requestOidcSeenAt < 50 * 60 * 1000) return "oidc_request";
  if (String(process.env.VERCEL_OIDC_TOKEN || "").trim()) return "oidc_env";
  return "none";
}

function gatewayModels(providerPreference = "auto") {
  const configured = [
    process.env.AI_GATEWAY_OPENAI_MODEL,
    process.env.AI_GATEWAY_ANTHROPIC_MODEL,
    process.env.AI_GATEWAY_MODEL,
    ...String(process.env.AI_GATEWAY_MODELS || "").split(","),
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const unique = [...new Set(configured)];
  const preferredPrefix = providerPreference === "openai" ? "openai/" : providerPreference === "anthropic" ? "anthropic/" : "";
  if (!preferredPrefix) return unique;
  return [...unique.filter((model) => model.startsWith(preferredPrefix)), ...unique.filter((model) => !model.startsWith(preferredPrefix))];
}

function normalizeMessages(messages, userPrompt, maxHistory = 12) {
  const normalized = Array.isArray(messages)
    ? messages
        .filter((message) => ["user", "assistant"].includes(message?.role))
        .map((message) => ({
          role: message.role,
          content: String(message.content || "").trim().slice(0, 2000),
        }))
        .filter((message) => message.content)
        .slice(-maxHistory)
    : [];
  const current = String(userPrompt || "").trim();
  if (current && normalized.at(-1)?.content !== current) normalized.push({ role: "user", content: current });
  return normalized;
}

async function gatewayErrorDetail(response) {
  try {
    const raw = await response.text();
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    const error = body?.error && typeof body.error === "object" ? body.error : body || {};
    return {
      type: String(error.type || error.code || body?.type || "").slice(0, 80),
      message: String(error.message || body?.message || raw || "").replace(/\s+/g, " ").slice(0, 240),
    };
  } catch {
    return { type: "", message: "" };
  }
}

// Erros que valem para a conta inteira (trocar de modelo não adianta).
function accountWideFailure(result) {
  if (result.status === 401 || result.status === 402) return true;
  return result.status === 403 && /customer_verification_required|payment method|credit card/i.test(`${result.errorType} ${result.errorMessage}`);
}

// GPT-5 mini "pensa" antes de responder e esse raciocínio consome o mesmo
// limite de tokens da resposta. Esforço baixo deixa a conversa rápida e
// evita respostas cortadas (JSON incompleto). Claude Haiku não precisa.
function reasoningFor(model) {
  return /^openai\/(gpt-5|o\d)/.test(model) ? { effort: "low", exclude: true } : null;
}

async function requestModel({ model, token, systemPrompt, userPrompt, messages, label, timeoutMs, maxTokens = 900, maxHistory = 12, withReasoning = true }) {
  const startedAt = Date.now();
  const reasoning = withReasoning ? reasoningFor(model) : null;
  try {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...normalizeMessages(messages, userPrompt, maxHistory),
        ],
        max_tokens: reasoning ? maxTokens + 1200 : maxTokens,
        ...(reasoning ? { reasoning } : {}),
      }),
    });
    if (!response.ok && response.status === 400 && reasoning) {
      // Se o provedor recusar o parâmetro de raciocínio, tenta de novo sem ele.
      console.warn("ai_gateway_request", { label, status: 400, retry: "without_reasoning", model });
      return requestModel({ model, token, systemPrompt, userPrompt, messages, label, timeoutMs: Math.max(2500, timeoutMs - (Date.now() - startedAt)), maxTokens, maxHistory, withReasoning: false });
    }
    if (!response.ok) {
      // O corpo do erro diz o motivo exato (cartão não verificado, modelo
      // fora do plano gratuito, sem créditos...). Só metadados vão ao log.
      const detail = await gatewayErrorDetail(response);
      console.warn("ai_gateway_request", { label, status: response.status, durationMs: Date.now() - startedAt, model, errorType: detail.type, errorMessage: detail.message });
      const status = [401, 402, 403, 429].includes(response.status) ? response.status : 502;
      return {
        ok: false, status, errorType: detail.type, errorMessage: detail.message,
        error: response.status === 429 ? "ai_rate_limited" : status === 502 ? "ai_gateway_failed" : status === 402 ? "ai_gateway_no_credits" : "ai_gateway_unauthorized",
      };
    }
    const body = await response.json();
    const content = body.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part?.text || "").join("") : String(content || "");
    const parsed = extractJson(text);
    console.info("ai_gateway_request", { label, status: response.status, durationMs: Date.now() - startedAt, model: body.model || model });
    return { ok: true, parsed, model: body.model || model, provider: model.split("/")[0] || "gateway" };
  } catch (error) {
    console.warn("ai_gateway_request", { label, error: error?.name === "SyntaxError" ? "invalid_json" : error?.name || "network_error", durationMs: Date.now() - startedAt, model });
    return { ok: false, status: 502, error: "ai_gateway_failed" };
  }
}

async function fetchGatewayJson({ systemPrompt, userPrompt, messages, label = "assistant", timeoutMs = 15000, totalBudgetMs, providerPreference = "auto", maxTokens = 900, maxHistory = 12 }) {
  const token = gatewayCredential();
  const models = gatewayModels(providerPreference);
  if (!token || !models.length) {
    console.warn("ai_gateway_not_configured", { label, credential: gatewayCredentialSource(), models: models.length });
    return { ok: false, status: 503, error: "ai_gateway_not_configured" };
  }
  // Orçamento total: se o primeiro modelo travar, o segundo ainda tem tempo
  // de responder sem estourar o limite da Function.
  const deadline = Date.now() + (totalBudgetMs || Math.round(timeoutMs * 1.6));
  let last = { ok: false, status: 502, error: "ai_gateway_failed" };
  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining < 2500) break;
    last = await requestModel({ model, token, systemPrompt, userPrompt, messages, label, timeoutMs: Math.min(timeoutMs, remaining), maxTokens, maxHistory });
    if (last.ok) return last;
    // 403 por modelo (ex.: fora do plano gratuito) → tenta o próximo modelo.
    if (accountWideFailure(last)) break;
  }
  return last;
}

module.exports = { fetchGatewayJson, gatewayCredential, gatewayCredentialSource, rememberRequestOidc, gatewayModels, normalizeMessages };
