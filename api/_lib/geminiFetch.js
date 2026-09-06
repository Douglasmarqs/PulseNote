// api/_lib/geminiFetch.js
// ============================================================
// Chamada única e resiliente ao endpoint generateContent do Gemini,
// compartilhada por parseCommandIntent.js e parseTransactionAI.js.
//
// GEMINI_MODEL fica centralizado AQUI — é o único lugar que precisa
// mudar pra trocar de modelo (ex.: "gemini-3.1-flash-lite" -> um Flash
// completo como "gemini-3.7-flash"). Antes de trocar em produção,
// confirme o nome exato do modelo em
// https://ai.google.dev/gemini-api/docs/models (ou no seletor de
// modelo dentro do seu próprio AI Studio) — nomes de modelo do Gemini
// mudam com frequência, e um nome errado aqui derruba TODAS as
// chamadas de IA do app (WhatsApp e "Lançar por texto") com erro 404.
//
// Antes, uma instabilidade passageira da API (429 de rate limit, 5xx,
// timeout de rede, ou uma resposta que não veio como JSON válido)
// derrubava a mensagem inteira na hora — sem repetir a tentativa, o
// usuário via a mensagem genérica de "não entendi" mesmo tendo escrito
// uma frase perfeitamente compreensível. Isso é exatamente a classe de
// falha que apareceu nos logs antes da troca de modelo (ver comentário
// em parseTransactionAI.js) — a diferença é que agora, em vez de só
// trocar de modelo, também damos 1 nova chance antes de desistir.
// ============================================================

const GEMINI_MODEL = "gemini-3.8-flash";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// label: string curta só pra identificar a origem da chamada nos logs
// (ex.: "intent", "transaction"). attempts: quantas tentativas no total
// (2 = tenta 1x, e se der erro de rede/HTTP tenta mais 1x). thinkingLevel:
// "low"|"medium"|"high" (família Gemini 3 — ver
// https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5); "minimal"
// NÃO existe no 3.8 Flash. Omitido, o modelo usa o padrão dele (medium).
// Usar "high" onde a mensagem pode ser ambígua/composta (várias
// intenções possíveis, correção implícita, categoria por sentido em vez
// de palavra-chave) vale o raciocínio extra; pra chamada simples e
// sensível a latência, deixe no padrão.
async function fetchGeminiJson({ model, apiKey, systemPrompt, contents, generationConfig, label, attempts = 2, thinkingLevel }) {
  let lastFailure = { ok: false, status: 502, error: "ai_request_failed" };
  const fullGenerationConfig = thinkingLevel
    ? { ...generationConfig, thinkingConfig: { thinkingLevel } }
    : generationConfig;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let raw;
    try {
      const aiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: contents }],
            generationConfig: fullGenerationConfig,
          }),
        }
      );

      if (!aiRes.ok) {
        const errBody = await aiRes.text();
        console.error(`Erro na API do Gemini (${label}), tentativa ${attempt}/${attempts}:`, aiRes.status, errBody);
        lastFailure = aiRes.status === 429
          ? { ok: false, status: 429, error: "ai_rate_limited" }
          : { ok: false, status: 502, error: "ai_request_failed" };
        if (attempt < attempts && (aiRes.status === 429 || aiRes.status >= 500)) {
          await sleep(350 * attempt);
          continue;
        }
        return lastFailure;
      }

      const data = await aiRes.json();
      raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    } catch (err) {
      console.error(`Erro inesperado chamando o Gemini (${label}), tentativa ${attempt}/${attempts}:`, err);
      lastFailure = { ok: false, status: 502, error: "ai_request_failed" };
      if (attempt < attempts) {
        await sleep(350 * attempt);
        continue;
      }
      return lastFailure;
    }

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      return { ok: true, parsed, raw };
    } catch (err) {
      console.error(`Resposta do Gemini (${label}) não é um JSON válido, tentativa ${attempt}/${attempts}:`, raw);
      lastFailure = { ok: false, status: 502, error: "ai_bad_response" };
      if (attempt < attempts) {
        await sleep(250 * attempt);
        continue;
      }
      return lastFailure;
    }
  }

  return lastFailure;
}

module.exports = { fetchGeminiJson, GEMINI_MODEL };
