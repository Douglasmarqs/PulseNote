// api/_lib/parseTransactionAI.js
// ============================================================
// Núcleo do "✨ Lançar por texto": manda uma frase livre + a lista de
// categorias do usuário para o Gemini e devolve um lançamento
// estruturado ({type, amount, categoryId, description, date}).
//
// Extraído de api/parse-transaction.js para ser reaproveitado também
// pelo webhook do WhatsApp (api/whatsapp-webhook.js) — é a MESMA lógica,
// só que agora mora num lugar só. Nada do comportamento mudou: mesmo
// prompt, mesmos exemplos, mesma validação.
// ============================================================

const GEMINI_MODEL = "gemini-2.5-flash-lite"; // rápido, barato, elegível ao nível grátis

function buildSystemPrompt({ todayIso, categoryList }) {
  return `Você extrai dados de um lançamento financeiro a partir de uma frase em português.
Data de hoje: ${todayIso}.

Categorias disponíveis (escolha exatamente um destes ids, sempre do tipo compatível):
${categoryList}

Regras OBRIGATÓRIAS:
- "amount": número positivo em reais (ex.: 32.5). Obrigatório.
- "date": se houver referência de data relativa ("ontem", "anteontem"/"antes de ontem", "semana passada", "segunda-feira", "dia 12", "27/06" etc.), calcule a data real YYYY-MM-DD a partir de hoje. Sem referência, use hoje.
- "type": "despesa" por padrão. Use "receita" APENAS se for entrada de dinheiro (salário, recebimento, venda, reembolso, freelance, rendimento etc.).
- "categoryId": escolha o id que melhor descreve o que foi dito. Priorize o mais específico (ex.: se a frase cita "mercado", escolha "alimentacao" — não "outros"). Deve ser do mesmo tipo de "type".
- "description": 2 a 5 palavras que descrevam O QUE foi gasto/recebido, extraídas do texto original — NÃO use o nome da categoria como descrição. Exemplos corretos: "Almoço no restaurante", "Uber para o trabalho", "Gasolina posto Shell", "Salário julho", "Farmácia Drogasil". Remova apenas conectores ("gastei", "paguei", "recebi", "reais", "de", "com", "no", "na" etc.).

Exemplo 1 — entrada: "gastei 32 reais no ifood ontem"
Saída: {"type":"despesa","amount":32,"categoryId":"alimentacao","description":"iFood","date":"${todayIso}"}

Exemplo 2 — entrada: "paguei 80 reais de gasolina antes de ontem"
Saída: {"type":"despesa","amount":80,"categoryId":"transporte","description":"Gasolina","date":"${todayIso}"}

Exemplo 3 — entrada: "recebi salário 2500"
Saída: {"type":"receita","amount":2500,"categoryId":"salario","description":"Salário mensal","date":"${todayIso}"}`;
}

// categories: [{id, type, label}], today: "YYYY-MM-DD", text: string livre
// Retorna { ok: true, entry } ou { ok: false, status, error }
async function parseTransactionText({ text, categories, today }) {
  if (!text || typeof text !== "string" || !text.trim() || text.length > 200) {
    return { ok: false, status: 400, error: "invalid_text" };
  }
  if (!Array.isArray(categories) || categories.length === 0) {
    return { ok: false, status: 400, error: "invalid_categories" };
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY não configurada.");
    return { ok: false, status: 500, error: "ai_not_configured" };
  }

  const todayIso = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10);
  const categoryIds = categories.map((c) => c.id);
  const categoryList = categories.map((c) => `- ${c.id} (${c.type}): ${c.label}`).join("\n");
  const systemPrompt = buildSystemPrompt({ todayIso, categoryList });

  let raw;
  try {
    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: text.trim().slice(0, 200) }] }],
          generationConfig: {
            maxOutputTokens: 200,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["despesa", "receita"] },
                amount: { type: "number" },
                categoryId: { type: "string", enum: categoryIds },
                description: { type: "string" },
                date: { type: "string" },
              },
              required: ["type", "amount", "categoryId", "description", "date"],
            },
          },
        }),
      }
    );

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error("Erro na API do Gemini:", aiRes.status, errBody);
      if (aiRes.status === 429) return { ok: false, status: 429, error: "ai_rate_limited" };
      return { ok: false, status: 502, error: "ai_request_failed" };
    }

    const data = await aiRes.json();
    raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  } catch (err) {
    console.error("Erro inesperado chamando o Gemini:", err);
    return { ok: false, status: 502, error: "ai_request_failed" };
  }

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (err) {
    console.error("Resposta do Gemini não é um JSON válido:", raw);
    return { ok: false, status: 502, error: "ai_bad_response" };
  }

  const validIds = new Set(categoryIds);
  const type = parsed.type === "receita" ? "receita" : "despesa";
  const amount = Math.round(Number(parsed.amount) * 100) / 100;
  const categoryId = validIds.has(parsed.categoryId)
    ? parsed.categoryId
    : type === "receita" ? "outros_receita" : "outros";
  const description = String(parsed.description || "").slice(0, 60).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : todayIso;

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: 422, error: "ai_invalid_amount" };
  }

  return { ok: true, entry: { type, amount, categoryId, description, date } };
}

module.exports = { parseTransactionText };