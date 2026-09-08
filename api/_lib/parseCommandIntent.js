// api/_lib/parseCommandIntent.js
// ============================================================
// Decide o que a pessoa QUIS DIZER no WhatsApp — numa chamada só ao
// Gemini (mesmo modelo já usado em parseTransactionAI.js), pra não
// dobrar o tempo de resposta com duas chamadas de IA por mensagem.
//
// Intenções cobertas: lançamento financeiro, edição do último
// lançamento, apagar o último lançamento, busca de lançamentos,
// relatório/estatísticas de um mês, consulta de tarefas/compromissos,
// criar/concluir/apagar tarefa, criar/buscar/apagar anotação,
// criar/atualizar meta, marcar compromisso, e ajuda.
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
//
// REDE DE SEGURANÇA (localTextFallback.js): o schema JSON abaixo só
// EXIGE o campo "intent" — os demais (amount, taskTitle, eventDate...)
// ficam opcionais de propósito, porque um schema só cobre TODAS as
// intenções. Isso significa que uma resposta "preguiçosa" do Gemini
// pode acertar a intenção e ainda assim deixar de preencher o campo que
// a gente mais precisa. Diferente do fluxo do app (parseTransactionAI.js
// — usado no "✨ Lançar por texto" e em foto de cupom), que SEMPRE exige
// os 5 campos do lançamento no schema e por isso raramente falha, esse
// arquivo cobre 11 intenções diferentes na mesma chamada e não pode
// exigir tudo sempre (senão "finance_edit_last" seria forçado a inventar
// valor pra correções que só mudam a categoria, por exemplo).
// Por isso, cada ponto de validação abaixo que falharia direto agora
// tenta primeiro recuperar o campo faltante analisando o TEXTO BRUTO da
// mensagem com regex (mesma heurística que o app já usa há tempos em
// parseFinanceText() pro "Lançar por texto" nunca travar) — só devolve
// "não entendi" quando nem a IA nem a extração local acham nada.
// ============================================================

const { fetchGeminiJson, GEMINI_MODEL } = require("./geminiFetch");
const {
  localExpenseFallback,
  extractAmountFromText,
  detectDate,
  extractTimeFromText,
  stripDateWordsFromDescription,
  guessType,
  guessCategoryId,
  stripKnownTriggers,
  TASK_CREATE_TRIGGERS,
  TASK_COMPLETE_DELETE_TRIGGERS,
  GOAL_CREATE_TRIGGERS,
  GOAL_UPDATE_TRIGGERS,
  EVENT_CREATE_TRIGGERS,
  FINANCE_SEARCH_TRIGGERS,
  NOTE_SEARCH_TRIGGERS,
} = require("./localTextFallback");

const INTENTS = [
  "expense", "report", "agenda", "help",
  "task_action", "note_action", "goal_action", "event_create",
  "finance_edit_last", "finance_delete_last", "finance_search", "stats",
];

function buildIntentPrompt({ todayIso, categoryList, recentEntryNote }) {
  return `Você entende o que uma pessoa quis dizer numa mensagem de WhatsApp pro PulseNote (app pessoal de notas/tarefas/agenda/metas/finanças). Classifique a intenção em UMA destas:

- "expense": registrar um gasto ou receita que aconteceu — ex.: "gastei 45 no mercado", "recebi 200 de freela". Intenção padrão quando a mensagem menciona um valor sendo gasto/recebido AGORA (lançamento novo).
- "finance_edit_last": a pessoa quer CORRIGIR o último lançamento financeiro feito por aqui — ex.: "errei, era 60 não 45", "muda o valor do último pra 80", "na verdade foi categoria transporte". Preencha os mesmos campos de "expense" só com os campos que mudaram (o resto fica como está). Isso INCLUI uma correção que menciona só uma data solta logo depois de um lançamento (ex.: "dia 1 desse mês", "foi ontem", "não, foi sexta") — mesmo sem nenhum outro campo, classifique como "finance_edit_last" (a data é extraída à parte, por regex).
- "finance_delete_last": a pessoa quer APAGAR/DESFAZER o último lançamento financeiro feito por aqui — ex.: "apaga o último gasto", "exclua isso", "desfaz o lançamento", "remove a última despesa", "cancela isso aí". Não precisa de nenhum campo além de "intent".
- "finance_search": buscar/filtrar lançamentos já salvos — ex.: "quanto gastei com uber esse mês", "busca meus gastos com farmácia", "mostra os lançamentos de mercado".
- "report": relatório/resumo financeiro de um mês (passado ou específico) — ex.: "relatório do mês passado", "quanto gastei em julho".
- "stats": estatística ou comparação entre períodos — ex.: "comparado ao mês passado gastei mais ou menos", "qual minha média de gastos", "estatísticas desse ano".
- "agenda": pergunta sobre TAREFAS ou COMPROMISSOS pendentes (consulta, não criação) — ex.: "minhas tarefas", "o que tenho pra hoje", "tarefas atrasadas".
- "task_action": criar, concluir ou apagar uma TAREFA — ex.: "cria uma tarefa pra ligar pro médico amanhã", "me lembra de pagar o boleto sexta", "concluí a tarefa do dentista", "apaga a tarefa de comprar ração".
- "note_action": criar, buscar ou apagar uma ANOTAÇÃO/NOTA (ideia, texto livre pra guardar, NÃO é tarefa nem eventos) — ex.: "anota: ideia pro projeto X é fazer Y", "nota — comprar presente pro aniversário da Ana em outubro", "busca minhas notas sobre viagem", "apaga a nota do mercado".
- "goal_action": criar uma META nova ou atualizar o progresso de uma meta existente — ex.: "criar meta economizar 5000 esse ano", "avancei 200 na minha meta de economia", "minha meta de ler livros já bateu 3".
- "event_create": marcar um COMPROMISSO/evento com data (reunião, consulta, compromisso social) — ex.: "marca uma reunião com o cliente sexta às 15h", "agenda consulta médica dia 20 às 9h no centro".
- "help": pedido de ajuda/lista de comandos — ex.: "ajuda", "o que você faz", "comandos".
${recentEntryNote}
Data de hoje: ${todayIso}.

Se "report": calcule "reportMonth" (1-12) e "reportYear" a partir de expressões relativas ("mês passado", "esse mês", nomes de mês, "agosto de 2025" etc.), relativo à data de hoje. Se a pessoa pedir explicitamente um ARQUIVO/PLANILHA/EXCEL pra baixar (ex.: "manda a planilha do mês passado", "quero o excel de agosto", "exporta isso em excel"), preencha "reportFormat":"arquivo"; se for só um resumo em texto (ex.: "relatório do mês passado", "quanto gastei em julho"), preencha "reportFormat":"texto" (esse é o padrão).

Se "stats": preencha "reportMonth"/"reportYear" (o período principal perguntado; sem período claro, use o mês atual) e, se a pessoa pediu COMPARAÇÃO explícita com outro período (ex.: "comparado ao mês passado"), preencha também "statsCompareMonth"/"statsCompareYear"; senão deixe os dois de fora.

Se "agenda", classifique "agendaFilter": "hoje" | "atrasadas" | "semana" | "todas" (genérico, sem filtro claro).

Se "expense" ou "finance_edit_last", preencha type/amount/categoryId/description/date:
Categorias disponíveis (escolha exatamente um destes ids, do tipo compatível):
${categoryList}
- "amount": número positivo em reais.
- "date": resolva data relativa ("ontem", "semana passada" etc.) a partir de hoje; sem referência, use hoje. IMPORTANTE: gasto/receita é sempre algo que JÁ ACONTECEU — se a pessoa citar um dia/mês sem ano (ex.: "dia 5", "10 de agosto") e essa data já tiver passado este mês/ano, use o mês/ano ATUAL ou ANTERIOR (o mais próximo no passado), NUNCA o mês/ano seguinte. Só use uma data futura se a pessoa disser isso explicitamente (ex.: "vou gastar", "vou pagar dia 5").
- "type": "despesa" por padrão; "receita" só se for entrada de dinheiro.
- "categoryId": o mais específico possível, do mesmo tipo de "type". Cada categoria da lista já tem um emoji próprio no rótulo — escolher a categoria certa é o que decide o emoji certo na confirmação. NUNCA escolha uma categoria genérica tipo "outros"/"outros_receita" se qualquer categoria mais específica da lista puder se aplicar ao que foi dito, mesmo que a palavra exata não apareça na mensagem (use o sentido: "gastei com o veterinário" → categoria de pet, não "outros"; "comprei fralda"/"remédio do meu filho" → categoria de filhos/família; "recebi o aluguel do inquilino" → categoria de aluguel recebido, não "outros_receita"; "paguei o seguro do carro" → categoria de seguros; "juntei dinheiro no tesouro direto" → categoria de investimentos do tipo despesa correspondente). Só use "outros"/"outros_receita" quando genuinely nenhuma categoria da lista tiver relação com o que foi dito.
- "categoryConfidence": "baixa" quando duas ou mais categorias da lista pareceriam igualmente plausíveis pro que foi dito e você está só chutando qual delas é a certa (ex.: uma despesa genérica tipo "gastei 50" sem nenhuma pista do que foi, ou algo que poderia caber em mais de uma categoria específica sem um sinal claro de qual). "alta" no caso comum, quando dá pra ter certeza razoável pelo que foi dito. Quando "baixa", preencha também "categoryAlternatives" com até 3 ids de categoria (do mesmo "type") que sejam os candidatos mais prováveis, do MESMO jeito que os ids existem na lista — a pessoa vai escolher entre eles na próxima mensagem, então não invente um id que não esteja na lista.
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
Exemplo 2b — "exclua o último gasto" → {"intent":"finance_delete_last"}
Exemplo 2c — "dia 1 desse mês" (mandada logo após um lançamento, corrigindo a data) → {"intent":"finance_edit_last"}
Exemplo 3 — "quanto gastei com uber esse mês" → {"intent":"finance_search","searchQuery":"uber"}
Exemplo 4 — "relatório do mês passado" (hoje=${todayIso}) → {"intent":"report","reportMonth":<mês anterior>,"reportYear":<ano correspondente>}
Exemplo 4b — "manda a planilha do mês passado em excel" (hoje=${todayIso}) → {"intent":"report","reportMonth":<mês anterior>,"reportYear":<ano correspondente>,"reportFormat":"arquivo"}
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
// lastFinanceEntry: o último lançamento financeiro feito por WhatsApp
// (ou null) — usado só pra dar à IA o CONTEXTO de "o que a pessoa acabou
// de fazer por aqui", pra reconhecer uma correção curta e sem verbo
// ("dia 1 desse mês", "foi 60 não 45") como referência a esse
// lançamento, em vez de tratar cada mensagem isolada sem histórico
// nenhum. Só entra no prompt se o lançamento foi feito há pouco tempo
// (RECENT_CONTEXT_WINDOW_MS) — passado esse prazo, a pessoa
// provavelmente não está mais "no meio" daquele lançamento, e citar ele
// como contexto só arriscaria confundir uma mensagem nova e sem relação.
const RECENT_CONTEXT_WINDOW_MS = 15 * 60 * 1000; // 15 minutos

function buildRecentEntryNote(lastFinanceEntry) {
  if (!lastFinanceEntry || !lastFinanceEntry.createdAt) return "";
  const ageMs = Date.now() - new Date(lastFinanceEntry.createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > RECENT_CONTEXT_WINDOW_MS) return "";
  const verb = lastFinanceEntry.type === "receita" ? "receita" : "gasto";
  return `\nCONTEXTO: a pessoa acabou de lançar isto por aqui, há poucos minutos — ${verb} de R$ ${Number(lastFinanceEntry.amount || 0).toFixed(2)}, categoria "${lastFinanceEntry.category}", descrição "${lastFinanceEntry.description}", data ${lastFinanceEntry.date}. Se a PRÓXIMA mensagem for curta, sem verbo claro de outra ação (não menciona tarefa/nota/meta/compromisso novos), e só citar um valor, uma data ou uma categoria (ex.: "dia 1 desse mês", "foi 60", "era transporte"), classifique como "finance_edit_last" corrigindo ESSE lançamento — mesmo sem palavras como "corrigir"/"errei". Se a mensagem claramente descrever um lançamento NOVO e diferente (menciona outro valor E outra descrição), ignore este contexto e trate como "expense" normalmente.\n`;
}

async function parseTextIntent({ text, categories, today, lastFinanceEntry }) {
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
  const recentEntryNote = buildRecentEntryNote(lastFinanceEntry);
  const systemPrompt = buildIntentPrompt({ todayIso, categoryList, recentEntryNote });
  const rawMessage = text.trim().slice(0, 400);

  const aiResult = await fetchGeminiJson({
    model: GEMINI_MODEL,
    apiKey: process.env.GEMINI_API_KEY,
    systemPrompt,
    contents: [{ text: rawMessage }],
    label: "intent",
    // "high": mensagem de WhatsApp aqui cobre 11 intenções diferentes,
    // pode ter correção implícita via CONTEXTO acima, categoria por
    // sentido (não só palavra-chave) e referência de data ambígua — vale
    // mais raciocínio que o padrão "medium" do modelo pra acertar isso
    // de primeira, e o custo extra de tokens de "pensamento" é
    // insignificante perto de gastar uma segunda mensagem pedindo pra
    // pessoa reformular.
    thinkingLevel: "high",
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
          categoryConfidence: { type: "string", enum: ["alta", "baixa"] },
          categoryAlternatives: { type: "array", items: { type: "string", enum: categoryIds }, maxItems: 3 },
          description: { type: "string" },
          date: { type: "string" },
          // report / stats
          reportMonth: { type: "integer" },
          reportYear: { type: "integer" },
          reportFormat: { type: "string", enum: ["texto", "arquivo"] },
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
  });

  if (!aiResult.ok) {
    // O Gemini falhou de vez (rede/HTTP/JSON inválido), mesmo depois do
    // retry do fetchGeminiJson. Último recurso antes de desistir: se a
    // mensagem tem cara de lançamento financeiro (tem um valor em reais
    // reconhecível), monta o lançamento só com regex — cobre exatamente
    // o caso "escrevi um gasto simples e a IA deu uma engasgada".
    const local = localExpenseFallback({ text: rawMessage, categories, todayIso });
    if (local) {
      console.warn("Intent do WhatsApp recuperada localmente após falha do Gemini:", rawMessage);
      return { ok: true, intent: "expense", entry: local };
    }
    console.error("Não deu pra recuperar a intenção localmente (sem valor reconhecível):", rawMessage, aiResult.error);
    return aiResult;
  }

  const parsed = aiResult.parsed;
  const intent = INTENTS.includes(parsed.intent) ? parsed.intent : "expense";
  const validIds = new Set(categoryIds);

  // ── report ──────────────────────────────────────────────────────
  if (intent === "report") {
    const [curY, curM] = todayIso.split("-").map(Number);
    // Sem período claro, assume o mês atual (mesmo default já usado em
    // "stats" e "saldo") em vez de falhar — "relatório" sozinho é um
    // pedido razoável mesmo sem mês explícito.
    const month = Number.isInteger(Number(parsed.reportMonth)) && parsed.reportMonth >= 1 && parsed.reportMonth <= 12
      ? Number(parsed.reportMonth) : curM;
    const year = Number.isInteger(Number(parsed.reportYear)) ? Number(parsed.reportYear) : curY;
    const format = parsed.reportFormat === "arquivo" ? "arquivo" : "texto";
    return { ok: true, intent: "report", report: { month, year, format } };
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
    let searchQuery = String(parsed.searchQuery || "").trim().slice(0, 60);
    if (!searchQuery) {
      // A IA acertou "quer buscar algo" mas não isolou a palavra-chave —
      // tira as frases de comando conhecidas ("busca meus gastos com",
      // "quanto gastei com"...) e usa o que sobrar.
      searchQuery = stripKnownTriggers(rawMessage, FINANCE_SEARCH_TRIGGERS).slice(0, 60);
    }
    if (!searchQuery) {
      console.error("finance_search sem palavra-chave recuperável:", rawMessage);
      return { ok: false, status: 422, error: "ai_invalid_search" };
    }
    const month = Number.isInteger(Number(parsed.searchMonth)) ? Number(parsed.searchMonth) : null;
    const year = Number.isInteger(Number(parsed.searchYear)) ? Number(parsed.searchYear) : null;
    return { ok: true, intent: "finance_search", search: { query: searchQuery, month, year } };
  }

  // ── finance_delete_last (rede de segurança pra fora do fast-path
  // regex do webhook — ver DELETE_COMMAND_RE em whatsapp-webhook.js) ──
  if (intent === "finance_delete_last") {
    return { ok: true, intent: "finance_delete_last" };
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
    const localEditDate = detectDate(rawMessage, todayIso, "past"); // correção de lançamento é sempre sobre algo já passado
    if (localEditDate) patch.date = localEditDate; // regex vence a IA em data mecânica
    if (Object.keys(patch).length === 0) {
      // Correção quase sempre é só um número solto ("errei, era 60") —
      // tenta achar o valor direto no texto antes de desistir.
      const localAmount = extractAmountFromText(rawMessage);
      if (Number.isFinite(localAmount) && localAmount > 0) {
        patch.amount = localAmount;
      } else {
        console.error("finance_edit_last sem nenhum campo recuperável:", rawMessage);
        return { ok: false, status: 422, error: "ai_empty_edit" };
      }
    }
    return { ok: true, intent: "finance_edit_last", patch };
  }

  // ── task_action ─────────────────────────────────────────────────
  if (intent === "task_action") {
    const action = ["create", "complete", "delete"].includes(parsed.taskAction) ? parsed.taskAction : "create";
    if (action === "create") {
      let title = String(parsed.taskTitle || "").trim().slice(0, 120);
      if (!title) title = stripKnownTriggers(rawMessage, TASK_CREATE_TRIGGERS).slice(0, 120);
      title = stripDateWordsFromDescription(title) || title;
      if (!title) {
        console.error("task_action create sem título recuperável:", rawMessage);
        return { ok: false, status: 422, error: "ai_invalid_task_title" };
      }
      const dueDate = detectDate(rawMessage, todayIso, "future") ||
        (/^\d{4}-\d{2}-\d{2}$/.test(parsed.taskDueDate) ? parsed.taskDueDate : "");
      const priority = ["Baixa", "Media", "Alta"].includes(parsed.taskPriority) ? parsed.taskPriority : "Media";
      return { ok: true, intent: "task_action", task: { action, title, dueDate, priority } };
    }
    const query = String(parsed.taskQuery || "").trim().slice(0, 80)
      || stripKnownTriggers(rawMessage, TASK_COMPLETE_DELETE_TRIGGERS).slice(0, 80);
    if (!query) {
      console.error("task_action complete/delete sem alvo recuperável:", rawMessage);
      return { ok: false, status: 422, error: "ai_invalid_task_query" };
    }
    return { ok: true, intent: "task_action", task: { action, query } };
  }

  // ── note_action ─────────────────────────────────────────────────
  if (intent === "note_action") {
    const action = ["create", "search", "delete"].includes(parsed.noteAction) ? parsed.noteAction : "create";
    if (action === "create") {
      const title = String(parsed.noteTitle || "").trim().slice(0, 80);
      return { ok: true, intent: "note_action", note: { action, title } };
    }
    const query = String(parsed.noteQuery || "").trim().slice(0, 80)
      || stripKnownTriggers(rawMessage, NOTE_SEARCH_TRIGGERS).slice(0, 80);
    if (!query) {
      console.error("note_action search/delete sem alvo recuperável:", rawMessage);
      return { ok: false, status: 422, error: "ai_invalid_note_query" };
    }
    return { ok: true, intent: "note_action", note: { action, query } };
  }

  // ── goal_action ─────────────────────────────────────────────────
  if (intent === "goal_action") {
    const action = ["create", "update"].includes(parsed.goalAction) ? parsed.goalAction : "update";
    if (action === "create") {
      let title = String(parsed.goalTitle || "").trim().slice(0, 120);
      let target = Number(parsed.goalTarget);
      if (!Number.isFinite(target) || target <= 0) target = extractAmountFromText(rawMessage);
      if (!title) title = stripKnownTriggers(rawMessage, GOAL_CREATE_TRIGGERS).slice(0, 120);
      if (!title || !Number.isFinite(target) || target <= 0) {
        console.error("goal_action create sem título/alvo recuperável:", rawMessage);
        return { ok: false, status: 422, error: "ai_invalid_goal_create" };
      }
      return { ok: true, intent: "goal_action", goal: { action, title, target } };
    }
    const query = String(parsed.goalQuery || "").trim().slice(0, 80)
      || stripKnownTriggers(rawMessage, GOAL_UPDATE_TRIGGERS).slice(0, 80);
    const mode = parsed.goalProgressMode === "absolute" ? "absolute" : "delta";
    let value = Number(parsed.goalProgressValue);
    if (!Number.isFinite(value)) value = extractAmountFromText(rawMessage);
    if (!query || !Number.isFinite(value)) {
      console.error("goal_action update sem alvo/valor recuperável:", rawMessage);
      return { ok: false, status: 422, error: "ai_invalid_goal_update" };
    }
    return { ok: true, intent: "goal_action", goal: { action, query, mode, value } };
  }

  // ── event_create ────────────────────────────────────────────────
  if (intent === "event_create") {
    let title = String(parsed.eventTitle || "").trim().slice(0, 120);
    if (!title) title = stripKnownTriggers(rawMessage, EVENT_CREATE_TRIGGERS).slice(0, 120);
    title = stripDateWordsFromDescription(title) || title;
    // Data/hora reconhecida no texto (regex, determinística) sempre vence
    // a que a IA devolveu — é matemática mecânica, e a IA pode "entender"
    // a frase certa mas errar a conta (ex.: ler "amanhã" e devolver a
    // data de hoje).
    const date = detectDate(rawMessage, todayIso, "future") ||
      (/^\d{4}-\d{2}-\d{2}$/.test(parsed.eventDate) ? parsed.eventDate : "");
    if (!title || !date) {
      console.error("event_create sem título/data recuperável:", rawMessage);
      return { ok: false, status: 422, error: "ai_invalid_event" };
    }
    const time = extractTimeFromText(rawMessage) ||
      (/^\d{2}:\d{2}$/.test(parsed.eventTime) ? parsed.eventTime : "");
    const location = String(parsed.eventLocation || "").trim().slice(0, 80);
    return { ok: true, intent: "event_create", event: { title, date, time, location } };
  }

  // ── intent "expense" (ou falha da classificação) ──────────────────
  // Esse é o caminho mais comum de longe ("gastei X com/em Y"), e
  // também o default de qualquer mensagem que a IA não classificou com
  // confiança — por isso é o que mais precisa de uma rede de segurança
  // sólida. Só usa o que o Gemini extraiu quando é válido; qualquer
  // campo ausente/errado é recuperado localmente do texto bruto antes
  // de considerar a mensagem "não entendida".
  const type = parsed.type === "receita" ? "receita" : (parsed.type === "despesa" ? "despesa" : null);
  let amount = Number(parsed.amount);
  amount = Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
  let categoryId = validIds.has(parsed.categoryId) ? parsed.categoryId : null;
  let description = String(parsed.description || "").slice(0, 60).trim();
  let date = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null;

  if (amount === null) {
    // Campo mais crítico do lançamento — sem ele não tem gasto pra
    // registrar. Tenta achar direto no texto antes de desistir de vez.
    amount = extractAmountFromText(rawMessage);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error("expense sem nenhum valor recuperável (IA e regex local falharam):", rawMessage);
    return { ok: false, status: 422, error: "ai_invalid_amount" };
  }

  const finalType = type || guessType(rawMessage);
  if (!categoryId) categoryId = guessCategoryId(rawMessage, finalType, categories);
  if (!description) {
    const local = localExpenseFallback({ text: rawMessage, categories, todayIso });
    description = local?.description || (finalType === "receita" ? "Recebimento" : "Gasto");
  } else {
    // A IA às vezes deixa a palavra de data solta na descrição mesmo já
    // tendo preenchido "date" certo (ex.: description "Uber ontem") —
    // limpa isso mesmo quando a descrição veio da própria IA.
    description = stripDateWordsFromDescription(description) || description;
  }
  // Data reconhecida no texto (regex, cálculo mecânico) sempre vence a
  // que a IA devolveu — "ontem"/"amanhã"/dia da semana são contas que a
  // IA pode acertar o sentido e errar o resultado; regex não erra.
  // direction="past": gasto/receita é sempre sobre algo que já aconteceu,
  // então "dia 1"/"1 de setembro" nunca deve ser empurrado pro mês/ano
  // seguinte (era exatamente esse o bug: gasto de "1 de setembro" saindo
  // lançado em setembro do ANO QUE VEM).
  const localDate = detectDate(rawMessage, todayIso, "past");
  if (localDate) date = localDate;
  else if (!date) date = todayIso;

  // Se a IA sinalizou pouca confiança na categoria (duas ou mais
  // categorias pareciam igualmente prováveis) e deu alternativas de
  // verdade, não finaliza o lançamento ainda — devolve um pedido de
  // confirmação pro webhook perguntar à pessoa, em vez de arriscar
  // encaixar num "achismo". Só ativa com pelo menos 2 alternativas
  // válidas (com 0 ou 1, não sobra opção nenhuma real pra oferecer).
  const lowConfidenceAlternatives = Array.isArray(parsed.categoryAlternatives)
    ? parsed.categoryAlternatives.filter((id) => validIds.has(id) && id !== categoryId).slice(0, 3)
    : [];
  if (parsed.categoryConfidence === "baixa" && lowConfidenceAlternatives.length >= 1) {
    const allOptions = [categoryId, ...lowConfidenceAlternatives].filter(Boolean).slice(0, 3);
    if (allOptions.length >= 2) {
      return {
        ok: true,
        intent: "category_clarify",
        clarify: { entry: { type: finalType, amount, description, date }, options: allOptions },
      };
    }
  }

  return { ok: true, intent: "expense", entry: { type: finalType, amount, categoryId, description, date } };
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
