// api/_lib/parseCommandIntent.js
// ============================================================
// Decide o que a pessoa QUIS DIZER no WhatsApp — numa chamada só ao
// Gemini (mesmo modelo já usado em parseTransactionAI.js), pra não
// dobrar o tempo de resposta com duas chamadas de IA por mensagem.
//
// Intenções cobertas: lançamento financeiro, edição do último
// lançamento, busca de lançamentos, relatório/estatísticas de um mês,
// consulta de tarefas/compromissos, criar/concluir/apagar tarefa,
// criar/buscar/apagar anotação, criar/atualizar meta, marcar
// compromisso, e ajuda.
//
// IMPORTANTE sobre "salvar exatamente como foi escrito": pra anotações,
// o CONTEÚDO gravado é sempre o texto bruto da mensagem (recortado só
// do prefixo de comando, ex.: "anota: "), nunca uma reescrita da IA —
// isso é feito no webhook (buildNoteFromRawText), não aqui. A IA aqui
// só sugere um TÍTULO curto pra anotação, pra não obrigar a pessoa a
// digitar um título separado.
//
// Comandos que identificam um item JÁ EXISTENTE (concluir/apagar tarefa,
// apagar/buscar anotação, atualizar meta) não recebem a lista completa
// de tarefas/anotações/metas do usuário no prompt (isso encareceria e
// atrasaria cada mensagem) — a IA só extrai o texto livre que identifica
// o alvo (ex.: "tarefa do dentista" → taskQuery: "dentista"), e o
// webhook faz o casamento (fuzzy, acento/caixa-insensível) contra a
// lista real, igual ao findBestMatch() abaixo.
//
// Comandos rápidos que NÃO passam por aqui (regex simples, sem gastar
// chamada de IA à toa): "vincular", "apagar último" (finanças),
// "saldo"/"resumo" do mês atual — ver isBalanceCommand()/isDeleteCommand()
// em whatsapp-webhook.js.
// ============================================================

const GEMINI_MODEL = "gemini-3.1-flash-lite";

const INTENTS = [
  "expense", "report", "agenda", "help",
  "task_action", "note_action", "goal_action", "event_create",
  "finance_edit_last", "finance_search", "stats",
];

function buildIntentPrompt({ todayIso, categoryList }) {
  return `Você entende o que uma pessoa quis dizer numa mensagem de WhatsApp pro PulseNote (app pessoal de notas/tarefas/agenda/metas/finanças). Classifique a intenção em UMA destas:

- "expense": registrar um gasto ou receita que aconteceu — ex.: "gastei 45 no mercado", "recebi 200 de freela". Intenção padrão quando a mensagem menciona um valor sendo gasto/recebido AGORA (lançamento novo).
- "finance_edit_last": a pessoa quer CORRIGIR o último lançamento financeiro feito por aqui — ex.: "errei, era 60 não 45", "muda o valor do último pra 80", "na verdade foi categoria transporte". Preencha os mesmos campos de "expense" só com os campos que mudaram (o resto fica como está).
- "finance_search": buscar/filtrar lançamentos já salvos — ex.: "quanto gastei com uber esse mês", "busca meus gastos com farmácia", "mostra os lançamentos de mercado".
- "report": relatório/resumo financeiro de um mês (passado ou específico) — ex.: "relatório do mês passado", "quanto gastei em julho".
- "stats": estatística ou comparação entre períodos — ex.: "comparado ao mês passado gastei mais ou menos", "qual minha média de gastos", "estatísticas desse ano".
- "agenda": pergunta sobre TAREFAS ou COMPROMISSOS pendentes (consulta, não criação) — ex.: "minhas tarefas", "o que tenho pra hoje", "tarefas atrasadas".
- "task_action": criar, concluir ou apagar uma TAREFA — ex.: "cria uma tarefa pra ligar pro médico amanhã", "me lembra de pagar o boleto sexta", "concluí a tarefa do dentista", "apaga a tarefa de comprar ração".
- "note_action": criar, buscar ou apagar uma ANOTAÇÃO/NOTA (ideia, texto livre pra guardar, NÃO é tarefa nem eventos) — ex.: "anota: ideia pro projeto X é fazer Y", "nota — comprar presente pro aniversário da Ana em outubro", "busca minhas notas sobre viagem", "apaga a nota do mercado".
- "goal_action": criar uma META nova ou atualizar o progresso de uma meta existente — ex.: "criar meta economizar 5000 esse ano", "avancei 200 na minha meta de economia", "minha meta de ler livros já bateu 3".
- "event_create": marcar um COMPROMISSO/evento com data (reunião, consulta, compromisso social) — ex.: "marca uma reunião com o cliente sexta às 15h", "agenda consulta médica dia 20 às 9h no centro".
- "help": pedido de ajuda/lista de comandos — ex.: "ajuda", "o que você faz", "comandos".

Data de hoje: ${todayIso}.

Se "report": calcule "reportMonth" (1-12) e "reportYear" a partir de expressões relativas ("mês passado", "esse mês", nomes de mês, "agosto de 2025" etc.), relativo à data de hoje.

Se "stats": preencha "reportMonth"/"reportYear" (o período principal perguntado; sem período claro, use o mês atual) e, se a pessoa pediu COMPARAÇÃO explícita com outro período (ex.: "comparado ao mês passado"), preencha também "statsCompareMonth"/"statsCompareYear"; senão deixe os dois de fora.

Se "agenda", classifique "agendaFilter": "hoje" | "atrasadas" | "semana" | "todas" (genérico, sem filtro claro).

Se "expense" ou "finance_edit_last", preencha type/amount/categoryId/description/date:
Categorias disponíveis (escolha exatamente um destes ids, do tipo compatível):
${categoryList}
- "amount": número positivo em reais.
- "date": resolva data relativa ("ontem", "semana passada" etc.) a partir de hoje; sem referência, use hoje.
- "type": "despesa" por padrão; "receita" só se for entrada de dinheiro.
- "categoryId": o mais específico possível, do mesmo tipo de "type".
- "description": 2 a 5 palavras do que foi gasto/recebido, sem repetir o nome da categoria.
Em "finance_edit_last", só inclua os campos que a pessoa claramente quis corrigir — omita os que não foram mencionados.

Se "finance_search": preencha "searchQuery" (palavra-chave central, ex.: "uber", "farmácia", "mercado") e, se houver período claro, "searchMonth"/"searchYear".

Se "task_action": preencha "taskAction" ("create"|"complete"|"delete").
  - Se "create": "taskTitle" (título curto e claro da tarefa, no que a pessoa disse, sem palavras de comando tipo "cria uma tarefa pra"), "taskDueDate" (YYYY-MM-DD resolvendo data relativa; sem menção nenhuma de prazo, deixe "" — tarefa sem data), "taskPriority" ("Alta" se a pessoa usar palavras como "urgente"/"importante"/"prioridade", senão "Media").
  - Se "complete" ou "delete": "taskQuery" (texto curto que identifica a tarefa já existente que a pessoa quer marcar/apagar, ex.: da frase "concluí a tarefa do dentista" → "dentista").

Se "note_action": preencha "noteAction" ("create"|"search"|"delete").
  - Se "create": "noteTitle" (título curto de 2 a 6 palavras resumindo do que se trata — NÃO é o conteúdo completo, é só um rótulo pra identificar a nota depois).
  - Se "search" ou "delete": "noteQuery" (palavra-chave ou texto curto que identifica a(s) nota(s), ex.: "viagem", "mercado").

Se "goal_action": preencha "goalAction" ("create"|"update").
  - Se "create": "goalTitle", "goalTarget" (número alvo da meta).
  - Se "update": "goalQuery" (texto que identifica a meta existente), "goalProgressMode" ("delta" se a pessoa falou um AVANÇO, ex.: "avancei 200" → delta; "absolute" se falou um valor TOTAL atual, ex.: "já bati 3" → absolute), "goalProgressValue" (o número).

Se "event_create": preencha "eventTitle", "eventDate" (YYYY-MM-DD, resolvendo data relativa/dia da semana a partir de hoje), "eventTime" (HH:MM 24h; sem horário mencionado, deixe ""), "eventLocation" (sem menção, deixe "").

Se não conseguir classificar com confiança em nenhuma intenção específica, responda "expense" mesmo — se não der pra extrair um valor válido, o app já sabe pedir pra pessoa reformular.

Exemplo 1 — "gastei 32 no ifood ontem" → {"intent":"expense","type":"despesa","amount":32,"categoryId":"alimentacao","description":"iFood","date":"<ontem>"}
Exemplo 2 — "errei o valor, era 60" → {"intent":"finance_edit_last","amount":60}
Exemplo 3 — "quanto gastei com uber esse mês" → {"intent":"finance_search","searchQuery":"uber"}
Exemplo 4 — "relatório do mês passado" (hoje=${todayIso}) → {"intent":"report","reportMonth":<mês anterior>,"reportYear":<ano correspondente>}
Exemplo 5 — "comparado ao mês passado, gastei mais?" → {"intent":"stats","reportMonth":<mês atual>,"reportYear":<ano atual>,"statsCompareMonth":<mês anterior>,"statsCompareYear":<ano correspondente>}
Exemplo 6 — "o que tenho pra fazer hoje" → {"intent":"agenda","agendaFilter":"hoje"}
Exemplo 7 — "me lembra de pagar o boleto sexta" → {"intent":"task_action","taskAction":"create","taskTitle":"Pagar o boleto","taskDueDate":"<sexta que vem>","taskPriority":"Media"}
Exemplo 8 — "concluí a tarefa do dentista" → {"intent":"task_action","taskAction":"complete","taskQuery":"dentista"}
Exemplo 9 — "anota: ideia pro projeto X é fazer Y" → {"intent":"note_action","noteAction":"create","noteTitle":"Ideia pro projeto X"}
Exemplo 10 — "busca minhas notas sobre viagem" → {"intent":"note_action","noteAction":"search","noteQuery":"viagem"}
Exemplo 11 — "criar meta economizar 5000 esse ano" → {"intent":"goal_action","goalAction":"create","goalTitle":"Economizar esse ano","goalTarget":5000}
Exemplo 12 — "avancei 200 na minha meta de economia" → {"intent":"goal_action","goalAction":"update","goalQuery":"economia","goalProgressMode":"delta","goalProgressValue":200}
Exemplo 13 — "marca reunião com o cliente sexta às 15h" → {"intent":"event_create","eventTitle":"Reunião com o cliente","eventDate":"<sexta que vem>","eventTime":"15:00"}
Exemplo 14 — "ajuda" → {"intent":"help"}`;
}

// categories: [{id, type, label}], today: "YYYY-MM-DD", text: string livre
async function parseTextIntent({ text, categories, today }) {
  if (!text || typeof text !== "string" || !text.trim() || text.length > 400) {
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
          contents: [{ parts: [{ text: text.trim().slice(0, 400) }] }],
          generationConfig: {
            maxOutputTokens: 400,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                intent: { type: "string", enum: INTENTS },
                // expense / finance_edit_last
                type: { type: "string", enum: ["despesa", "receita"] },
                amount: { type: "number" },
                categoryId: { type: "string", enum: categoryIds },
                description: { type: "string" },
                date: { type: "string" },
                // report / stats
                reportMonth: { type: "integer" },
                reportYear: { type: "integer" },
                statsCompareMonth: { type: "integer" },
                statsCompareYear: { type: "integer" },
                // agenda
                agendaFilter: { type: "string", enum: ["hoje", "atrasadas", "semana", "todas"] },
                // finance_search
                searchQuery: { type: "string" },
                searchMonth: { type: "integer" },
                searchYear: { type: "integer" },
                // task_action
                taskAction: { type: "string", enum: ["create", "complete", "delete"] },
                taskTitle: { type: "string" },
                taskDueDate: { type: "string" },
                taskPriority: { type: "string", enum: ["Baixa", "Media", "Alta"] },
                taskQuery: { type: "string" },
                // note_action
                noteAction: { type: "string", enum: ["create", "search", "delete"] },
                noteTitle: { type: "string" },
                noteQuery: { type: "string" },
                // goal_action
                goalAction: { type: "string", enum: ["create", "update"] },
                goalTitle: { type: "string" },
                goalTarget: { type: "number" },
                goalQuery: { type: "string" },
                goalProgressMode: { type: "string", enum: ["delta", "absolute"] },
                goalProgressValue: { type: "number" },
                // event_create
                eventTitle: { type: "string" },
                eventDate: { type: "string" },
                eventTime: { type: "string" },
                eventLocation: { type: "string" },
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

  const intent = INTENTS.includes(parsed.intent) ? parsed.intent : "expense";
  const validIds = new Set(categoryIds);

  // ── report ──────────────────────────────────────────────────────
  if (intent === "report") {
    const month = Number(parsed.reportMonth);
    const year = Number(parsed.reportYear);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
      return { ok: false, status: 422, error: "ai_invalid_report" };
    }
    return { ok: true, intent: "report", report: { month, year } };
  }

  // ── stats ───────────────────────────────────────────────────────
  if (intent === "stats") {
    const [y, m] = todayIso.split("-").map(Number);
    const month = Number.isInteger(Number(parsed.reportMonth)) ? Number(parsed.reportMonth) : m;
    const year = Number.isInteger(Number(parsed.reportYear)) ? Number(parsed.reportYear) : y;
    let compare = null;
    const cm = Number(parsed.statsCompareMonth);
    const cy = Number(parsed.statsCompareYear);
    if (Number.isInteger(cm) && cm >= 1 && cm <= 12 && Number.isInteger(cy)) compare = { month: cm, year: cy };
    return { ok: true, intent: "stats", stats: { month, year, compare } };
  }

  // ── agenda ──────────────────────────────────────────────────────
  if (intent === "agenda") {
    const filter = ["hoje", "atrasadas", "semana", "todas"].includes(parsed.agendaFilter) ? parsed.agendaFilter : "todas";
    return { ok: true, intent: "agenda", agenda: { filter } };
  }

  if (intent === "help") {
    return { ok: true, intent: "help" };
  }

  // ── finance_search ──────────────────────────────────────────────
  if (intent === "finance_search") {
    const searchQuery = String(parsed.searchQuery || "").trim().slice(0, 60);
    if (!searchQuery) return { ok: false, status: 422, error: "ai_invalid_search" };
    const month = Number.isInteger(Number(parsed.searchMonth)) ? Number(parsed.searchMonth) : null;
    const year = Number.isInteger(Number(parsed.searchYear)) ? Number(parsed.searchYear) : null;
    return { ok: true, intent: "finance_search", search: { query: searchQuery, month, year } };
  }

  // ── finance_edit_last (campos parciais — só o que veio preenchido) ─
  if (intent === "finance_edit_last") {
    const patch = {};
    if (parsed.type === "despesa" || parsed.type === "receita") patch.type = parsed.type;
    if (Number.isFinite(Number(parsed.amount)) && Number(parsed.amount) > 0) {
      patch.amount = Math.round(Number(parsed.amount) * 100) / 100;
    }
    if (validIds.has(parsed.categoryId)) patch.categoryId = parsed.categoryId;
    if (typeof parsed.description === "string" && parsed.description.trim()) {
      patch.description = parsed.description.trim().slice(0, 60);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) patch.date = parsed.date;
    if (Object.keys(patch).length === 0) return { ok: false, status: 422, error: "ai_empty_edit" };
    return { ok: true, intent: "finance_edit_last", patch };
  }

  // ── task_action ─────────────────────────────────────────────────
  if (intent === "task_action") {
    const action = ["create", "complete", "delete"].includes(parsed.taskAction) ? parsed.taskAction : null;
    if (!action) return { ok: false, status: 422, error: "ai_invalid_task_action" };
    if (action === "create") {
      const title = String(parsed.taskTitle || "").trim().slice(0, 120);
      if (!title) return { ok: false, status: 422, error: "ai_invalid_task_title" };
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.taskDueDate) ? parsed.taskDueDate : "";
      const priority = ["Baixa", "Media", "Alta"].includes(parsed.taskPriority) ? parsed.taskPriority : "Media";
      return { ok: true, intent: "task_action", task: { action, title, dueDate, priority } };
    }
    const query = String(parsed.taskQuery || "").trim().slice(0, 80);
    if (!query) return { ok: false, status: 422, error: "ai_invalid_task_query" };
    return { ok: true, intent: "task_action", task: { action, query } };
  }

  // ── note_action ─────────────────────────────────────────────────
  if (intent === "note_action") {
    const action = ["create", "search", "delete"].includes(parsed.noteAction) ? parsed.noteAction : null;
    if (!action) return { ok: false, status: 422, error: "ai_invalid_note_action" };
    if (action === "create") {
      const title = String(parsed.noteTitle || "").trim().slice(0, 80);
      return { ok: true, intent: "note_action", note: { action, title } };
    }
    const query = String(parsed.noteQuery || "").trim().slice(0, 80);
    if (!query) return { ok: false, status: 422, error: "ai_invalid_note_query" };
    return { ok: true, intent: "note_action", note: { action, query } };
  }

  // ── goal_action ─────────────────────────────────────────────────
  if (intent === "goal_action") {
    const action = ["create", "update"].includes(parsed.goalAction) ? parsed.goalAction : null;
    if (!action) return { ok: false, status: 422, error: "ai_invalid_goal_action" };
    if (action === "create") {
      const title = String(parsed.goalTitle || "").trim().slice(0, 120);
      const target = Number(parsed.goalTarget);
      if (!title || !Number.isFinite(target) || target <= 0) {
        return { ok: false, status: 422, error: "ai_invalid_goal_create" };
      }
      return { ok: true, intent: "goal_action", goal: { action, title, target } };
    }
    const query = String(parsed.goalQuery || "").trim().slice(0, 80);
    const mode = parsed.goalProgressMode === "absolute" ? "absolute" : "delta";
    const value = Number(parsed.goalProgressValue);
    if (!query || !Number.isFinite(value)) return { ok: false, status: 422, error: "ai_invalid_goal_update" };
    return { ok: true, intent: "goal_action", goal: { action, query, mode, value } };
  }

  // ── event_create ────────────────────────────────────────────────
  if (intent === "event_create") {
    const title = String(parsed.eventTitle || "").trim().slice(0, 120);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(parsed.eventDate) ? parsed.eventDate : "";
    if (!title || !date) return { ok: false, status: 422, error: "ai_invalid_event" };
    const time = /^\d{2}:\d{2}$/.test(parsed.eventTime) ? parsed.eventTime : "";
    const location = String(parsed.eventLocation || "").trim().slice(0, 80);
    return { ok: true, intent: "event_create", event: { title, date, time, location } };
  }

  // ── intent "expense" (ou falha da IA) — mesma validação de sempre ──
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

// Casamento aproximado (acento/caixa-insensível, por inclusão de termos)
// entre um texto livre ("dentista") e o título de um item existente
// (tarefa/nota/meta) — usado por task_action/note_action/goal_action
// quando o alvo já existe, em vez de mandar a lista inteira pra IA.
// Retorna o item de melhor pontuação, ou null se nada bater o suficiente.
function findBestMatch(query, items, titleKey = "title") {
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const q = norm(query);
  if (!q) return null;
  const qTokens = q.split(/\s+/).filter(Boolean);

  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const title = norm(item[titleKey]);
    if (!title) continue;
    let score = 0;
    if (title === q) score = 100;
    else if (title.includes(q) || q.includes(title)) score = 60;
    else {
      const titleTokens = new Set(title.split(/\s+/).filter(Boolean));
      const overlap = qTokens.filter((t) => titleTokens.has(t)).length;
      if (overlap > 0) score = 20 + overlap * 10;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 20 ? best : null;
}

module.exports = { parseTextIntent, findBestMatch };
