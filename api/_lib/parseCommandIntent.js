// api/_lib/parseCommandIntent.js
// ============================================================
// Decide o que a pessoa QUIS DIZER no WhatsApp antes de cair
// automaticamente no lançamento de gasto/receita — mesma ideia do
// parseTransactionAI.js, mas classificando a INTENÇÃO da mensagem
// primeiro: é um lançamento? um pedido de relatório de um mês
// específico? uma pergunta sobre tarefas/compromissos? um pedido de
// ajuda? Tudo isso numa chamada só ao Gemini (mesmo modelo já usado em
// parseTransactionAI.js), pra não dobrar o tempo de resposta com duas
// chamadas de IA por mensagem.
//
// Comandos rápidos que NÃO passam por aqui (resolvidos antes, por regex
// simples, sem gastar chamada de IA à toa): "vincular", "apagar
// último", "saldo"/"resumo" do mês atual — ver isBalanceCommand() e
// isDeleteCommand() em whatsapp-webhook.js.
// ============================================================

const GEMINI_MODEL = "gemini-3.1-flash-lite";

function buildIntentPrompt({ todayIso, categoryList }) {
  return `Você entende o que uma pessoa quis dizer numa mensagem de WhatsApp pro PulseNote (app pessoal de finanças/tarefas/agenda). Classifique a intenção em UMA destas 4:

- "expense": a pessoa está registrando um gasto ou receita que aconteceu (ex.: "gastei 45 no mercado", "recebi 200 de freela"). É a intenção padrão quando a mensagem menciona um valor sendo gasto/recebido.
- "report": a pessoa quer um RELATÓRIO/RESUMO financeiro de um mês (passado ou específico) — ex.: "relatório do mês passado", "quanto gastei em julho", "resumo de agosto de 2025", "gastos do mês retrasado".
- "agenda": a pessoa está perguntando sobre TAREFAS ou COMPROMISSOS pendentes — ex.: "minhas tarefas", "o que tenho pra hoje", "tarefas atrasadas", "compromissos dessa semana".
- "help": a pessoa está pedindo ajuda/lista de comandos — ex.: "ajuda", "o que você faz", "comandos", "menu".

Data de hoje: ${todayIso}.

Se a intenção for "report", calcule "reportMonth" (1-12) e "reportYear" a partir de expressões relativas ("mês passado", "mês retrasado", "esse mês", nomes de mês, "agosto de 2025" etc.), sempre relativo à data de hoje.

Se a intenção for "agenda", classifique "agendaFilter":
- "hoje": pediu especificamente o que é de hoje
- "atrasadas": pediu especificamente tarefas atrasadas/em atraso
- "semana": pediu o que vence/acontece essa semana
- "todas": pergunta genérica, sem filtro claro (ex.: só "minhas tarefas")

Se a intenção for "expense", preencha type/amount/categoryId/description/date com as MESMAS regras de sempre:
Categorias disponíveis (escolha exatamente um destes ids, do tipo compatível):
${categoryList}
- "amount": número positivo em reais. Obrigatório pra "expense".
- "date": resolva data relativa ("ontem", "semana passada" etc.) a partir de hoje; sem referência, use hoje.
- "type": "despesa" por padrão; "receita" só se for entrada de dinheiro.
- "categoryId": o mais específico possível, do mesmo tipo de "type".
- "description": 2 a 5 palavras do que foi gasto/recebido, sem repetir o nome da categoria.

Se não conseguir classificar com confiança em "report", "agenda" ou "help", responda "expense" mesmo — se não der pra extrair um valor válido, o app já sabe pedir pra pessoa reformular.

Exemplo 1 — "gastei 32 no ifood ontem" → {"intent":"expense","type":"despesa","amount":32,"categoryId":"alimentacao","description":"iFood","date":"<ontem>"}
Exemplo 2 — "relatório do mês passado" (hoje=${todayIso}) → {"intent":"report","reportMonth":<mês anterior>,"reportYear":<ano correspondente>}
Exemplo 3 — "o que tenho pra fazer hoje" → {"intent":"agenda","agendaFilter":"hoje"}
Exemplo 4 — "tarefas atrasadas" → {"intent":"agenda","agendaFilter":"atrasadas"}
Exemplo 5 — "ajuda" → {"intent":"help"}`;
}

// categories: [{id, type, label}], today: "YYYY-MM-DD", text: string livre
// Retorna:
//   { ok:true, intent:"expense", entry:{...} }   (mesmo formato de sempre)
//   { ok:true, intent:"report", report:{month,year} }
//   { ok:true, intent:"agenda", agenda:{filter} }
//   { ok:true, intent:"help" }
//   { ok:false, status, error }
async function parseTextIntent({ text, categories, today }) {
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
  const systemPrompt = buildIntentPrompt({ todayIso, categoryList });

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
            maxOutputTokens: 250,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                intent: { type: "string", enum: ["expense", "report", "agenda", "help"] },
                type: { type: "string", enum: ["despesa", "receita"] },
                amount: { type: "number" },
                categoryId: { type: "string", enum: categoryIds },
                description: { type: "string" },
                date: { type: "string" },
                reportMonth: { type: "integer" },
                reportYear: { type: "integer" },
                agendaFilter: { type: "string", enum: ["hoje", "atrasadas", "semana", "todas"] },
              },
              required: ["intent"],
            },
          },
        }),
      }
    );

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error("Erro na API do Gemini (intent):", aiRes.status, errBody);
      if (aiRes.status === 429) return { ok: false, status: 429, error: "ai_rate_limited" };
      return { ok: false, status: 502, error: "ai_request_failed" };
    }

    const data = await aiRes.json();
    raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  } catch (err) {
    console.error("Erro inesperado chamando o Gemini (intent):", err);
    return { ok: false, status: 502, error: "ai_request_failed" };
  }

  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (err) {
    console.error("Resposta do Gemini (intent) não é um JSON válido:", raw);
    return { ok: false, status: 502, error: "ai_bad_response" };
  }

  const intent = ["expense", "report", "agenda", "help"].includes(parsed.intent) ? parsed.intent : "expense";

  if (intent === "report") {
    const month = Number(parsed.reportMonth);
    const year = Number(parsed.reportYear);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
      return { ok: false, status: 422, error: "ai_invalid_report" };
    }
    return { ok: true, intent: "report", report: { month, year } };
  }

  if (intent === "agenda") {
    const filter = ["hoje", "atrasadas", "semana", "todas"].includes(parsed.agendaFilter) ? parsed.agendaFilter : "todas";
    return { ok: true, intent: "agenda", agenda: { filter } };
  }

  if (intent === "help") {
    return { ok: true, intent: "help" };
  }

  // intent === "expense" — mesma validação de sempre (parseTransactionAI.js)
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

  return { ok: true, intent: "expense", entry: { type, amount, categoryId, description, date } };
}

module.exports = { parseTextIntent };
