function extractJson(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : raw);
}

function gatewayCredential() {
  return process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || "";
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

function normalizeMessages(messages, userPrompt) {
  const normalized = Array.isArray(messages)
    ? messages
        .filter((message) => ["user", "assistant"].includes(message?.role))
        .map((message) => ({
          role: message.role,
          content: String(message.content || "").trim().slice(0, 2000),
        }))
        .filter((message) => message.content)
        .slice(-12)
    : [];
  const current = String(userPrompt || "").trim();
  if (current && normalized.at(-1)?.content !== current) normalized.push({ role: "user", content: current });
  return normalized;
}

async function requestModel({ model, token, systemPrompt, userPrompt, messages, label, timeoutMs }) {
  const startedAt = Date.now();
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
          ...normalizeMessages(messages, userPrompt),
        ],
        max_tokens: 900,
      }),
    });
    if (!response.ok) {
      console.warn("ai_gateway_request", { label, status: response.status, durationMs: Date.now() - startedAt, model });
      return { ok: false, status: response.status === 429 ? 429 : 502, error: response.status === 429 ? "ai_rate_limited" : "ai_gateway_failed" };
    }
    const body = await response.json();
    const content = body.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part?.text || "").join("") : String(content || "");
    const parsed = extractJson(text);
    console.info("ai_gateway_request", { label, status: response.status, durationMs: Date.now() - startedAt, model: body.model || model });
    return { ok: true, parsed, model: body.model || model, provider: model.split("/")[0] || "gateway" };
  } catch (error) {
    console.warn("ai_gateway_request", { label, error: error?.name || "network_error", durationMs: Date.now() - startedAt, model });
    return { ok: false, status: 502, error: "ai_gateway_failed" };
  }
}

async function fetchGatewayJson({ systemPrompt, userPrompt, messages, label = "assistant", timeoutMs = 15000, providerPreference = "auto" }) {
  const token = gatewayCredential();
  const models = gatewayModels(providerPreference);
  if (!token || !models.length) return { ok: false, status: 503, error: "ai_gateway_not_configured" };
  let last = { ok: false, status: 502, error: "ai_gateway_failed" };
  for (const model of models) {
    last = await requestModel({ model, token, systemPrompt, userPrompt, messages, label, timeoutMs });
    if (last.ok) return last;
  }
  return last;
}

module.exports = { fetchGatewayJson, gatewayCredential, gatewayModels, normalizeMessages };
