const { buildFinanceForecast } = require("./financeForecast");
const { converse, detectSmallTalk, buildSmallTalkReply, brazilNow } = require("./pulsinhoBrain");
const { serializeAction, toLegacyProposedAction } = require("./pulsinhoActions");
const { buildCategoryList } = require("./financeCategories");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function purchaseAmountFromQuestion(question) {
  const text = normalized(question);
  if (!/(posso|da para|cabe|consigo).{0,35}(gastar|comprar|pagar)|se eu (gastar|comprar|pagar)/.test(text)) return 0;
  const matches = [...String(question).matchAll(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:\.\d{1,2})?)/gi)];
  if (!matches.length) return 0;
  const raw = matches[matches.length - 1][1];
  const normalizedNumber = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const value = Number(normalizedNumber);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 0;
}

function categoryTotals(state, workspaceId, monthKey) {
  const totals = new Map();
  for (const entry of asArray(state.finances)) {
    const entryWorkspace = entry.workspaceId || "personal";
    if (entryWorkspace !== workspaceId || entry.type !== "despesa" || !entry.date?.startsWith(monthKey)) continue;
    const category = String(entry.category || "outros");
    totals.set(category, (totals.get(category) || 0) + (Number(entry.amount) || 0));
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }));
}

function buildAssistantContext(state, forecast) {
  const workspaceId = forecast.workspaceId;
  const monthKey = forecast.today.slice(0, 7);
  const pendingTasks = asArray(state.tasks)
    .filter((item) => item.status !== "Concluida" && item.status !== "Cancelada")
    .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")))
    .slice(0, 8)
    .map(({ id, title, dueDate, dueTime, priority }) => ({ id, title, dueDate, dueTime, priority }));
  const upcomingEvents = asArray(state.events)
    .filter((item) => item.date >= forecast.today)
    .sort((a, b) => `${a.date}${a.time || ""}`.localeCompare(`${b.date}${b.time || ""}`))
    .slice(0, 8)
    .map(({ id, title, date, time, location }) => ({ id, title, date, time, location }));
  const goals = asArray(state.goals).slice(0, 8).map(({ id, title, current, target }) => ({ id, title, current, target }));

  return {
    date: forecast.today,
    workspaceId,
    finances: {
      currentBalance: forecast.currentBalance,
      projectedBalance: forecast.projectedBalance,
      safeToSpend: forecast.safeToSpend,
      dailySafeToSpend: forecast.dailySafeToSpend,
      reserve: forecast.reserve,
      confidence: forecast.confidence,
      reasons: forecast.reasons,
      nextCommitments: forecast.commitments.slice(0, 8),
      categoryTotals: categoryTotals(state, workspaceId, monthKey),
    },
    planner: { pendingTasks, upcomingEvents },
    goals,
    noteTitles: asArray(state.notes).slice(0, 12).map((item) => String(item.title || "Nota sem título").slice(0, 80)),
  };
}

function sanitizeProposedAction(action) {
  if (!action || typeof action !== "object") return null;
  const allowedTypes = new Set(["create_task", "create_event", "create_note", "create_goal", "create_transaction", "navigate"]);
  const type = String(action.type || "").trim();
  if (!allowedTypes.has(type)) return null;
  const payload = action.payload && typeof action.payload === "object" ? action.payload : {};
  const safePayload = {};
  for (const [key, value] of Object.entries(payload).slice(0, 12)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) continue;
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    safePayload[key] = typeof value === "string" ? value.slice(0, 240) : value;
  }
  const label = String(action.label || "Confirmar ação").trim().slice(0, 100);
  const summary = String(action.summary || "").trim().slice(0, 240);
  return { type, label: label || "Confirmar ação", summary, payload: safePayload, requiresConfirmation: true };
}

function sanitizeHistory(history) {
  return asArray(history)
    .filter((message) => ["user", "assistant"].includes(message?.role))
    .map((message) => ({ role: message.role, content: String(message.content || "").trim().slice(0, 1600) }))
    .filter((message) => message.content)
    .slice(-10);
}

function listNames(items, key = "title", limit = 3) {
  return asArray(items)
    .slice(0, limit)
    .map((item) => String(item?.[key] || "").trim())
    .filter(Boolean)
    .join(", ");
}

// Respostas operacionais não precisam depender de um provedor externo. Além
// de reduzir a latência do WhatsApp, este caminho mantém o Pulsinho útil em
// períodos de 429/503 sem inventar dados ou transformar uma pergunta em ação.
function buildLocalAssistantAnswer(question, context, forecast, { fallback = false } = {}) {
  const text = normalized(question);
  const finance = context.finances;
  const tasks = context.planner.pendingTasks;
  const events = context.planner.upcomingEvents;
  const goals = context.goals;
  const prefix = fallback ? "A IA externa demorou, então usei os dados já salvos no PulseNote. " : "";

  if (/(saldo|quanto tenho|como estao.*financ|resumo.*financ)/.test(text)) {
    return {
      reply: `${prefix}Seu saldo registrado é ${money(finance.currentBalance)} e a projeção de fechamento é ${money(finance.projectedBalance)}. A margem segura estimada para gastar é ${money(finance.safeToSpend)}.`,
      navigationTarget: "finances",
      followUps: ["Quais contas ainda vão cair?", "Quanto posso gastar por dia?", "Compare com o mês passado"],
      provider: "pulse-engine",
    };
  }

  if (/(quanto.*(dia|diario)|por dia|limite diario)/.test(text)) {
    return {
      reply: `${prefix}Pelos lançamentos e compromissos registrados, sua margem diária segura estimada é ${money(finance.dailySafeToSpend)}. A projeção preserva uma reserva de ${money(finance.reserve)}.`,
      navigationTarget: "finances",
      followUps: ["Posso gastar R$ 100 hoje?", "Quais contas ainda vão cair?", "Onde estou gastando mais?"],
      provider: "pulse-engine",
    };
  }

  if (/(contas|compromissos|parcelas|vencimentos).*(cair|pagar|previst|proxim)|o que ainda.*(pagar|cair)/.test(text)) {
    const commitments = asArray(finance.nextCommitments).slice(0, 5);
    const details = commitments.length
      ? commitments.map((item) => `${item.description || "Compromisso"} (${money(item.amount)}${item.date ? ` em ${item.date}` : ""})`).join("; ")
      : "não há compromissos financeiros futuros registrados";
    return {
      reply: `${prefix}${commitments.length ? "Próximos compromissos: " : "No momento, "}${details}.`,
      navigationTarget: "finances",
      followUps: ["Quanto sobra depois dessas contas?", "Quanto posso gastar por dia?", "Abrir análise financeira"],
      provider: "pulse-engine",
    };
  }

  if (/(categoria|onde|com o que).*(gasto|gastando)|maiores gastos/.test(text)) {
    const categories = asArray(finance.categoryTotals).slice(0, 4);
    const details = categories.length
      ? categories.map((item) => `${item.category}: ${money(item.amount)}`).join("; ")
      : "ainda não há despesas categorizadas neste mês";
    return {
      reply: `${prefix}${categories.length ? "Seus maiores grupos de gasto neste mês são: " : "Neste momento, "}${details}.`,
      navigationTarget: "finances",
      followUps: ["Compare com o mês passado", "Quanto posso gastar hoje?", "Abrir transações"],
      provider: "pulse-engine",
    };
  }

  if (/(tarefas|pendencias|o que.*fazer|prioridade.*hoje)/.test(text)) {
    const names = listNames(tasks);
    return {
      reply: `${prefix}${tasks.length ? `Você tem ${tasks.length} tarefa${tasks.length === 1 ? "" : "s"} pendente${tasks.length === 1 ? "" : "s"}. As próximas são: ${names}.` : "Você não tem tarefas pendentes registradas."}`,
      navigationTarget: "planner",
      followUps: ["Quais compromissos vêm agora?", "Abrir Planner", "Mostrar minhas metas"],
      provider: "pulse-engine",
    };
  }

  if (/(agenda|compromissos|eventos|reunioes)/.test(text)) {
    const names = listNames(events);
    return {
      reply: `${prefix}${events.length ? `Há ${events.length} compromisso${events.length === 1 ? "" : "s"} próximo${events.length === 1 ? "" : "s"}. ${names}.` : "Não há compromissos futuros registrados."}`,
      navigationTarget: "planner",
      followUps: ["Mostrar tarefas pendentes", "Abrir Planner", "O que é prioridade hoje?"],
      provider: "pulse-engine",
    };
  }

  if (/(metas|objetivos|progresso)/.test(text)) {
    const names = listNames(goals);
    return {
      reply: `${prefix}${goals.length ? `Você acompanha ${goals.length} meta${goals.length === 1 ? "" : "s"}: ${names}.` : "Você ainda não cadastrou metas."}`,
      navigationTarget: "planner",
      followUps: ["Abrir minhas metas", "Mostrar tarefas pendentes", "Como estão minhas finanças?"],
      provider: "pulse-engine",
    };
  }

  if (!fallback) return null;
  const priority = tasks[0]?.title
    ? `Sua próxima pendência é “${tasks[0].title}”.`
    : events[0]?.title
      ? `Seu próximo compromisso é “${events[0].title}”.`
      : `Sua margem segura estimada é ${money(finance.safeToSpend)}.`;
  return {
    reply: `${prefix}${priority} Para uma resposta mais específica, diga se quer analisar finanças, tarefas, agenda, metas ou notas.`,
    navigationTarget: tasks.length || events.length ? "planner" : "finances",
    followUps: ["Como estão minhas finanças?", "Quais tarefas estão pendentes?", "Quais compromissos vêm agora?"],
    provider: "pulse-engine",
  };
}

// Pedidos de ação ("agenda uma reunião", "cria tarefa") nunca devem cair
// nas respostas prontas de consulta — "agenda" também é verbo.
const ACTION_REQUEST_RE = /\b(cri[ae]r?|anot[ae]r?|marc[ae]r?|agend[ae]r?|lembr[ae]r?|registr[ae]r?|adicion[ae]r?|coloc[ae]r?|salv[ae]r?|lanc[ae]r?|apag[ae]r?|exclu[ia]r?|delet[ae]r?|remov[ae]r?|conclu\w*|terminei|finalizei|gastei|paguei|comprei|recebi|ganhei|avancei|guardei|edit[ae]r?|corrig\w*|mud[ae]r?)\b/;

function isActionRequest(question) {
  return ACTION_REQUEST_RE.test(normalized(question));
}

async function askPulsinho({ state, question, workspaceId, providerPreference, history, name = "", channel = "app", now = brazilNow(), callModel, skipBrain = false }) {
  const cleanQuestion = String(question || "").trim().slice(0, 1600);
  if (cleanQuestion.length < 1) return { ok: false, status: 400, error: "invalid_question" };
  const safeState = state || {};
  const purchaseAmount = purchaseAmountFromQuestion(cleanQuestion);
  const forecast = buildFinanceForecast(safeState, { workspaceId, purchaseAmount });

  if (purchaseAmount > 0) {
    return {
      ok: true,
      kind: "simulation",
      forecast,
      reply: `${forecast.summary} Depois dos compromissos previstos, o saldo de fechamento ficaria em ${money(forecast.projectedBalanceAfterPurchase)}. ${forecast.reasons[0] || "A projeção usa os dados registrados no PulseNote."}`,
      navigationTarget: "finances",
      followUps: ["Quais contas ainda vão cair?", "Quanto posso gastar por dia?", "Compare com o mês passado"],
      provider: "forecast-engine",
      actions: [],
    };
  }

  // Bate-papo (oi, bom dia, obrigado...) responde na hora, sem IA.
  const safeHistory = sanitizeHistory(history);
  const small = detectSmallTalk(cleanQuestion, { history: safeHistory });
  if (small && small.kind !== "prefix") {
    return {
      ok: true, kind: "answer", forecast, provider: "pulse-engine", actions: [], navigationTarget: null,
      reply: buildSmallTalkReply(small, { name, state: safeState, now, channel, seed: `${now.today}|${cleanQuestion}` }),
      followUps: ["O que tenho para hoje?", "Como estão minhas finanças?", "Me lembra de beber água às 15h"],
    };
  }

  const context = buildAssistantContext(safeState, forecast);
  if (!isActionRequest(cleanQuestion)) {
    const localAnswer = buildLocalAssistantAnswer(cleanQuestion, context, forecast);
    if (localAnswer) return { ok: true, kind: "answer", forecast, actions: [], ...localAnswer };
  }

  const brain = skipBrain ? { ok: false } : await converse({
    state: safeState, message: cleanQuestion, history: safeHistory, name, channel,
    categories: buildCategoryList(safeState), providerPreference, workspaceId: workspaceId || "personal", now, allowSmallTalk: false,
    ...(callModel ? { callModel } : {}),
  });
  if (brain.ok) {
    const actions = brain.actions.map(serializeAction);
    const firstConfirm = brain.actions.find((action) => action.risk === "confirm");
    return {
      ok: true,
      kind: "answer",
      forecast,
      reply: brain.reply,
      followUps: brain.followUps,
      navigationTarget: brain.navigationTarget,
      provider: brain.provider,
      actions,
      // Compatibilidade com versões antigas do app (um único pedido).
      proposedAction: firstConfirm ? toLegacyProposedAction(firstConfirm) : null,
    };
  }

  return { ok: true, kind: "answer", forecast, actions: [], ...buildLocalAssistantAnswer(cleanQuestion, context, forecast, { fallback: true }) };
}

module.exports = {
  askPulsinho,
  isActionRequest,
  buildAssistantContext,
  buildLocalAssistantAnswer,
  purchaseAmountFromQuestion,
  sanitizeHistory,
  sanitizeProposedAction,
};
