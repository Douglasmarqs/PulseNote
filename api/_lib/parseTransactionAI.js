// api/_lib/parseTransactionAI.js
// ============================================================
// Núcleo do "✨ Lançar por texto": manda uma frase livre + a lista de
// categorias do usuário para o Gemini e devolve um lançamento
// estruturado ({type, amount, categoryId, description, date}).
//
// Compartilhado entre o app web (api/parse-transaction.js) e o webhook do
// WhatsApp (api/whatsapp-webhook.js) — é a MESMA lógica pros dois.
//
// Categorias são listadas ao modelo separadas por tipo (despesa/receita) e o
// categoryId devolvido é validado contra o tipo do lançamento antes de ser
// aceito — isso evita a categoria "incoerente" que aparecia quando o modelo
// escolhia um id que existia, mas era do tipo errado.
// ============================================================

const GEMINI_MODEL = "gemini-2.5-flash-lite"; // rápido, barato, elegível ao nível grátis

// Monta a lista de categorias SEPARADA por tipo (despesa / receita), em vez
// de uma lista única misturada — isso reduz muito o risco de o modelo
// escolher um id de despesa para um lançamento de receita (ou vice-versa),
// que era a principal causa de categorias "incoerentes" aparecendo no app:
// o id até existia, mas era do tipo errado, então o formulário não
// conseguia selecioná-lo e caía num valor default silencioso.
function buildSystemPrompt({ todayIso, expenseList, incomeList }) {
  return `Você extrai dados de um lançamento financeiro a partir de uma frase em português. Seja preciso: cada campo importa, principalmente a categoria, que precisa refletir EXATAMENTE o que a pessoa disse.
Data de hoje: ${todayIso}.

Categorias de DESPESA (dinheiro saindo) — use uma destas SOMENTE quando "type" for "despesa":
${expenseList}

Categorias de RECEITA (dinheiro entrando) — use uma destas SOMENTE quando "type" for "receita":
${incomeList}

Regras OBRIGATÓRIAS:
- "amount": número positivo em reais (ex.: 32.5). Obrigatório.
- "date": se houver referência de data relativa ("ontem", "anteontem"/"antes de ontem", "semana passada", "segunda-feira", "dia 12", "27/06" etc.), calcule a data real YYYY-MM-DD a partir de hoje. Sem referência, use hoje.
- "type": "despesa" por padrão. Use "receita" APENAS se for claramente entrada de dinheiro (salário, recebimento, venda, reembolso, freelance, rendimento, presente em dinheiro etc.).
- "categoryId": escolha SEMPRE um id da lista correspondente ao "type" escolhido — nunca misture (ex.: se "type" é "receita", o id TEM que vir da lista de RECEITA, mesmo que uma palavra do texto pareça combinar com uma categoria de despesa). Dentro da lista certa, escolha a categoria mais específica e coerente com o que foi dito (ex.: "mercado"/"restaurante"/"ifood" → categoria de alimentação, não "outros"; "gasolina"/"uber"/"ônibus" → transporte, não "outros"). Só use a categoria genérica "outros" quando nenhuma outra realmente combinar com o texto.
- "description": 2 a 6 palavras extraídas do texto ORIGINAL digitado pela pessoa (não invente, não resuma demais, não troque por sinônimos, não use o nome da categoria como descrição). Mantenha nomes próprios, lugares e detalhes específicos que a pessoa mencionou (ex.: "Mercado Extra", "Uber para o aeroporto", "Farmácia Drogasil", "Salário julho"). Remova só conectores sem valor descritivo ("gastei", "paguei", "recebi", "reais", "de", "com", "no", "na" etc.) — o resto do que a pessoa escreveu deve aparecer na descrição.

Exemplo 1 — entrada: "gastei 32 reais no ifood ontem"
Saída: {"type":"despesa","amount":32,"categoryId":"alimentacao","description":"iFood","date":"${todayIso}"}

Exemplo 2 — entrada: "paguei 80 reais de gasolina antes de ontem no posto shell"
Saída: {"type":"despesa","amount":80,"categoryId":"transporte","description":"Gasolina no posto Shell","date":"${todayIso}"}

Exemplo 3 — entrada: "recebi salário 2500"
Saída: {"type":"receita","amount":2500,"categoryId":"salario","description":"Salário mensal","date":"${todayIso}"}

Exemplo 4 — entrada: "vendi um sofá velho por 300"
Saída: {"type":"receita","amount":300,"categoryId":"vendas","description":"Venda de sofá velho","date":"${todayIso}"}`;
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
  const expenseCats = categories.filter((c) => (c.type || "despesa") !== "receita");
  const incomeCats = categories.filter((c) => c.type === "receita");
  const expenseList = expenseCats.map((c) => `- ${c.id}: ${c.label}`).join("\n") || "(nenhuma)";
  const incomeList = incomeCats.map((c) => `- ${c.id}: ${c.label}`).join("\n") || "(nenhuma)";
  const systemPrompt = buildSystemPrompt({ todayIso, expenseList, incomeList });

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
            maxOutputTokens: 350,
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

  const type = parsed.type === "receita" ? "receita" : "despesa";
  const amount = Math.round(Number(parsed.amount) * 100) / 100;

  // IMPORTANTE: valida que o categoryId devolvido pertence ao MESMO tipo do
  // lançamento (despesa/receita), não só que existe em algum lugar da lista
  // combinada. Antes dessa checagem, um id de despesa podia "vazar" para um
  // lançamento de receita (ou vice-versa): passava na validação por existir
  // na lista geral, mas o formulário não conseguia selecioná-lo (o <select>
  // só lista categorias do tipo certo) e a categoria ficava incoerente com
  // o que a pessoa realmente digitou.
  const sameTypeIds = categories
    .filter((c) => (c.type === "receita" ? "receita" : "despesa") === type)
    .map((c) => c.id);
  const fallbackId = type === "receita" ? "outros_receita" : "outros";
  const categoryId = sameTypeIds.includes(parsed.categoryId)
    ? parsed.categoryId
    : sameTypeIds.includes(fallbackId)
      ? fallbackId
      : sameTypeIds[0] || fallbackId;

  const description = String(parsed.description || "").slice(0, 60).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : todayIso;

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: 422, error: "ai_invalid_amount" };
  }

  return { ok: true, entry: { type, amount, categoryId, description, date } };
}

module.exports = { parseTransactionText };
