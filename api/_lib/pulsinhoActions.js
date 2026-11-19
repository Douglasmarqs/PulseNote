// api/_lib/pulsinhoActions.js
// ============================================================
// Ações que o Pulsinho pode executar a partir de uma conversa — usadas
// tanto pelo WhatsApp (aplica no servidor, dentro de uma transação)
// quanto pelo chat do app (o servidor valida e devolve o registro
// pronto; o app só insere/atualiza pelo id).
//
// Princípios de segurança:
//  • A IA só PROPÕE ações; tudo aqui é revalidado com regras fixas
//    (tipos, datas, valores, ids e categorias existentes).
//  • Criar algo que a pessoa pediu explicitamente é "auto" (como já
//    acontecia no WhatsApp com "gastei 45 no mercado"), sempre com
//    resumo do que foi feito e opção de desfazer/corrigir.
//  • Excluir qualquer coisa é sempre "confirm" — nunca acontece sem um
//    "sim" explícito. Pelo áudio, exclusões são recusadas.
//  • Quando o alvo (tarefa, meta, nota...) é ambíguo, nada é alterado:
//    a resposta pergunta qual dos itens a pessoa quis dizer.
// ============================================================

const crypto = require("node:crypto");
const { findBestMatches } = require("./parseCommandIntent");
const { guessSpecificCategoryId } = require("./localTextFallback");
const { learnedCategoryId } = require("./financeCategories");

// Categorias amplas que podem ser refinadas pelo que está escrito na
// descrição (ex.: "alimentação" + "Mercado" → Mercado).
const BROAD_TO_SPECIFIC = {
  alimentacao: ["mercado"],
  transporte: ["combustivel"],
  saude: ["academia", "beleza"],
  contas: ["assinaturas", "moradia"],
  lazer: ["eventos", "viagem", "assinaturas"],
  outros: ["mercado", "alimentacao", "transporte", "combustivel", "saude", "contas", "moradia", "assinaturas", "pet", "educacao", "beleza", "academia", "roupas", "tecnologia"],
};
const BROAD_CATEGORY_IDS = new Set(Object.keys(BROAD_TO_SPECIFIC));

const ACTION_TYPES = [
  "add_transaction", "add_task", "add_event", "add_note", "add_goal",
  "update_goal", "complete_task", "edit_transaction",
  "delete_transaction", "delete_task", "delete_note", "delete_event",
];
const DESTRUCTIVE_TYPES = new Set(["delete_transaction", "delete_task", "delete_note", "delete_event"]);
const MAX_ACTIONS = 6;
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, max = 140) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// "padaria" → "Padaria", mas marcas como "iFood"/"iPhone" ficam como estão.
function capitalize(text) {
  if (!text || /^\p{Ll}\p{Lu}/u.test(text)) return text;
  return text.charAt(0).toLocaleUpperCase("pt-BR") + text.slice(1);
}

function keepText(value, max = 3000) {
  // Conteúdo de nota: preserva quebras de linha, só corta o excesso.
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function validIsoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T12:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? "" : text;
}

function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validTime(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  const match = text.match(/^(\d{1,2})(?:\s*(?::|h)\s*(\d{2})?)?\s*(?:h|hs|horas?)?$/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(Math.abs(value) * 100) / 100 : 0;
  const raw = String(value ?? "").replace(/[^\d.,-]/g, "");
  if (!raw) return 0;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round(Math.abs(number) * 100) / 100 : 0;
}

function reminderMinutes(value, fallback = 15) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 10080 ? number : fallback;
}

function normalizeSearch(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// "hoje", "amanhã", "sexta (21/11)", "21/11/2027" — curto e humano.
function formatWhen(date, time, today) {
  if (!date) return time ? `às ${time}` : "";
  let label;
  if (date === today) label = "hoje";
  else if (date === addDays(today, 1)) label = "amanhã";
  else if (date === addDays(today, -1)) label = "ontem";
  else {
    const [y, m, d] = date.split("-");
    const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
    const diff = Math.round((new Date(`${date}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000);
    const short = `${d}/${m}${y !== today.slice(0, 4) ? `/${y}` : ""}`;
    label = diff > 1 && diff < 7 ? `${weekday} (${short})` : short;
  }
  return time ? `${label} às ${time}` : label;
}

function reminderLabel(minutes) {
  if (minutes === 0) return "lembrete na hora";
  if (minutes < 60) return `lembrete ${minutes} min antes`;
  if (minutes % 1440 === 0) return `lembrete ${minutes / 1440} dia${minutes === 1440 ? "" : "s"} antes`;
  if (minutes % 60 === 0) return `lembrete ${minutes / 60} h antes`;
  return `lembrete ${minutes} min antes`;
}

function categoryLabel(categories, id) {
  return asArray(categories).find((c) => c.id === id)?.label || id || "Outros";
}

// ── Resolução de alvos (tarefa/meta/nota/compromisso/lançamento) ──
const POOLS = {
  task: { key: "tasks", title: "title" },
  note: { key: "notes", title: "title", fallback: "description" },
  goal: { key: "goals", title: "title" },
  event: { key: "events", title: "title" },
  finance: { key: "finances", title: "description" },
};

function resolveTarget(kind, raw, state, { onlyOpen = false } = {}) {
  const spec = POOLS[kind];
  let pool = asArray(state?.[spec.key]);
  if (onlyOpen) pool = pool.filter((item) => item.status !== "Concluida" && item.status !== "Cancelada");
  const targetId = cleanText(raw?.targetId, 120);
  if (targetId) {
    const byId = pool.find((item) => item?.id === targetId);
    if (byId) return { status: "unique", item: byId };
  }
  const query = cleanText(raw?.query || raw?.title, 120);
  if (!query) return { status: "none" };
  let matches = findBestMatches(query, pool, spec.title);
  if (!matches.length && spec.fallback) matches = findBestMatches(query, pool, spec.fallback);
  // Empate entre um título idêntico e outros parciais: o idêntico vence.
  const exact = matches.filter((item) => normalizeSearch(item[spec.title]) === normalizeSearch(query));
  if (exact.length === 1) return { status: "unique", item: exact[0] };
  if (matches.length === 1) return { status: "unique", item: matches[0] };
  if (matches.length > 1) return { status: "ambiguous", items: matches.slice(0, 5) };
  return { status: "none", query };
}

function itemTitle(kind, item) {
  return cleanText(kind === "finance" ? item?.description || "Lançamento" : item?.title || "Sem título", 80);
}

const AMBIGUITY = {
  task: "Encontrei mais de uma tarefa parecida. Qual delas?",
  note: "Encontrei mais de uma nota parecida. Qual delas?",
  goal: "Encontrei mais de uma meta parecida. Qual delas?",
  event: "Encontrei mais de um compromisso parecido. Qual deles?",
  finance: "Encontrei mais de um lançamento parecido. Qual deles?",
};

function ambiguityQuestion(_label, items, kind) {
  const list = items.map((item, index) => `${index + 1}) ${itemTitle(kind, item)}`).join("\n");
  return `${AMBIGUITY[kind]}\n${list}`;
}

// ── Normalização: transforma o que a IA propôs numa ação segura ──
// ctx: { state, categories, today, nowTime, channel, workspaceId,
//        rawMessage, fromAudio, lastFinanceEntry, makeId }
function normalizeAction(raw, ctx) {
  if (!raw || typeof raw !== "object") return { ok: false };
  const type = String(raw.type || "").trim();
  if (!ACTION_TYPES.includes(type)) return { ok: false };
  const state = ctx.state || {};
  const today = validIsoDate(ctx.today) || new Date().toISOString().slice(0, 10);
  const categories = asArray(ctx.categories);
  const makeId = ctx.makeId || (() => crypto.randomUUID());
  const channel = ctx.channel === "whatsapp" ? "whatsapp" : "app";
  const origin = channel === "whatsapp"
    ? { source: "whatsapp", whatsappRawMessage: cleanText(ctx.rawMessage, 400) }
    : { source: "pulsinho" };

  if (DESTRUCTIVE_TYPES.has(type) && ctx.fromAudio) {
    return { ok: false, ask: "Por segurança, exclusões precisam ser digitadas. Não apaguei nada a partir do áudio." };
  }

  if (type === "add_transaction") {
    const amount = parseAmount(raw.amount);
    if (!amount || amount > 10_000_000) return { ok: false, ask: "Qual foi o valor? Assim eu já registro certinho." };
    const kind = raw.transactionType === "receita" ? "receita" : "despesa";
    const description = capitalize(cleanText(raw.title || raw.description || raw.content, 80));
    const valid = categories.filter((c) => c.type === kind);
    // Regras de categorização da própria pessoa (Finanças → Automação)
    // valem também para o que o Pulsinho registra.
    const rule = asArray(state.finRules).find((r) => r && r.active !== false && (r.type || "despesa") === kind
      && cleanText(r.match, 80) && normalizeSearch(`${description} ${ctx.rawMessage || ""}`).includes(normalizeSearch(r.match))
      && valid.some((c) => c.id === r.categoryId));
    // Depois das regras, vale como a pessoa já categorizou essa descrição.
    const learned = rule ? "" : learnedCategoryId(state, description, kind, { categories });
    let categoryId = rule ? rule.categoryId : learned || (valid.some((c) => c.id === raw.categoryId) ? raw.categoryId : "");
    // QA 18/11: "Gastei R$ 30 no mercado. Registre como alimentação" virava
    // Restaurante/Delivery (id "alimentacao"). O estabelecimento/objeto
    // explícito na descrição vence a categoria ampla escolhida pela IA.
    if (categoryId && !rule && !learned && BROAD_CATEGORY_IDS.has(categoryId)) {
      const specific = guessSpecificCategoryId(description, kind, categories);
      if (specific && specific !== categoryId && (BROAD_TO_SPECIFIC[categoryId] || []).includes(specific)) categoryId = specific;
    }
    if (!categoryId) categoryId = guessSpecificCategoryId(`${description} ${ctx.rawMessage || ""}`, kind, categories) || "";
    const lowConfidence = !rule && !learned && (!categoryId || raw.categoryConfidence === "baixa");
    if (!categoryId) categoryId = kind === "receita" ? "outros_receita" : "outros";
    const alternatives = asArray(raw.categoryAlternatives).filter((id) => valid.some((c) => c.id === id) && id !== categoryId).slice(0, 3);
    const date = validIsoDate(raw.date) || today;
    const record = {
      id: channel === "whatsapp" ? `wa_${makeId()}` : makeId(),
      type: kind,
      amount,
      category: categoryId,
      description: description || cleanText(categoryLabel(categories, categoryId).replace(/^\S+\s/, ""), 80) || (kind === "receita" ? "Receita" : "Gasto"),
      date,
      accountId: "",
      workspaceId: cleanText(ctx.workspaceId, 80) || "personal",
      createdAt: new Date().toISOString(),
      ...origin,
    };
    if (typeof ctx.paymentMethodFor === "function") record.paymentMethod = ctx.paymentMethodFor(record) || "";
    return {
      ok: true,
      action: {
        type, risk: "auto", record, lowConfidence,
        categoryAlternatives: alternatives,
        summary: `${kind === "receita" ? "Receita" : "Gasto"} de ${money(amount)} — ${record.description} (${categoryLabel(categories, categoryId)}), ${formatWhen(date, "", today)}`,
      },
    };
  }

  if (type === "add_task") {
    const title = capitalize(cleanText(raw.title || raw.content, 140));
    if (!title) return { ok: false, ask: "O que eu coloco nessa tarefa?" };
    let dueDate = validIsoDate(raw.date);
    const dueTime = validTime(raw.time);
    if (dueTime && !dueDate) {
      // "me lembra às 18h" sem dia: hoje, ou amanhã se o horário já passou.
      dueDate = ctx.nowTime && dueTime <= ctx.nowTime ? addDays(today, 1) : today;
    }
    const reminder = reminderMinutes(raw.reminderMinutes, 15);
    const priority = ["Baixa", "Media", "Alta", "Urgente"].includes(raw.priority) ? raw.priority : "Media";
    const record = {
      id: makeId(), title, status: "Pendente", priority, dueDate, createdAt: today, completedAt: "",
      dueTime, reminder, sourceNoteId: "", subtasks: [], recurrence: null, ...origin,
    };
    const when = formatWhen(dueDate, dueTime, today);
    return {
      ok: true,
      action: {
        type, risk: "auto", record,
        summary: `📋 Tarefa “${title}”${when ? ` — ${when}` : ""}${dueTime ? ` (${reminderLabel(reminder)})` : ""}${priority === "Alta" || priority === "Urgente" ? " · prioridade alta" : ""}`,
      },
    };
  }

  if (type === "add_event") {
    const title = capitalize(cleanText(raw.title || raw.content, 140));
    if (!title) return { ok: false, ask: "Qual é o compromisso?" };
    const date = validIsoDate(raw.date);
    if (!date) return { ok: false, ask: `Para que dia eu marco “${title}”?` };
    const time = validTime(raw.time);
    const reminder = reminderMinutes(raw.reminderMinutes, 15);
    const location = cleanText(raw.location, 120);
    const record = {
      id: makeId(), title, date, time, location: location || "Sem local", reminder, notes: "", ...origin,
    };
    return {
      ok: true,
      action: {
        type, risk: "auto", record,
        summary: `📅 Compromisso “${title}” — ${formatWhen(date, time, today)}${location ? ` · ${location}` : ""}${time ? ` (${reminderLabel(reminder)})` : ""}`,
      },
    };
  }

  if (type === "add_note") {
    const content = keepText(raw.content || raw.description || raw.title, 3000);
    if (!content) return { ok: false, ask: "O que você quer que eu anote?" };
    const title = cleanText(raw.title, 80) || cleanText(content.split("\n")[0], 48);
    const record = {
      id: makeId(), title, description: content, category: "Geral", folder: "Entrada", tags: [], priority: "Media",
      checklist: [], attachments: [], goal: "", observations: "", color: "blue", textColor: "", favorite: false,
      createdAt: today, convertedToTaskId: "", ...origin,
    };
    return { ok: true, action: { type, risk: "auto", record, summary: `📝 Nota “${title}”` } };
  }

  if (type === "add_goal") {
    const title = cleanText(raw.title, 120);
    const target = parseAmount(raw.target ?? raw.amount ?? raw.value);
    if (!title) return { ok: false, ask: "Qual é a meta?" };
    if (!target) return { ok: false, ask: `Qual é o alvo da meta “${title}”? (por exemplo, 5000 ou 12 livros)` };
    const record = { id: makeId(), title, target, current: 0, milestones: [], ...origin };
    return { ok: true, action: { type, risk: "auto", record, summary: `🎯 Meta “${title}” (alvo ${target.toLocaleString("pt-BR")})` } };
  }

  if (type === "update_goal") {
    const value = parseAmount(raw.value ?? raw.amount);
    if (!value && raw.mode !== "absolute") return { ok: false, ask: "Quanto você avançou nessa meta?" };
    const found = resolveTarget("goal", raw, state);
    if (found.status === "ambiguous") return { ok: false, ask: ambiguityQuestion("uma meta", found.items, "goal") };
    if (found.status !== "unique") return { ok: false, ask: "Não achei essa meta. Qual é o nome dela?" };
    const goal = found.item;
    const mode = raw.mode === "absolute" ? "absolute" : "delta";
    const next = Math.max(0, mode === "absolute" ? value : (Number(goal.current) || 0) + value);
    const target = Number(goal.target) || 0;
    const pct = target > 0 ? Math.round((next / target) * 100) : 0;
    return {
      ok: true,
      action: {
        type, risk: "auto", targetId: goal.id, targetTitle: itemTitle("goal", goal),
        patch: { current: next }, previous: { current: Number(goal.current) || 0 },
        summary: `🎯 Meta “${itemTitle("goal", goal)}”: ${next.toLocaleString("pt-BR")}/${target.toLocaleString("pt-BR")} (${pct}%)${pct >= 100 ? " — meta batida! 🏆" : ""}`,
      },
    };
  }

  if (type === "complete_task") {
    const found = resolveTarget("task", raw, state, { onlyOpen: true });
    if (found.status === "ambiguous") return { ok: false, ask: ambiguityQuestion("uma tarefa", found.items, "task") };
    if (found.status !== "unique") return { ok: false, ask: "Não achei essa tarefa entre as pendentes. Como ela se chama?" };
    const task = found.item;
    return {
      ok: true,
      action: {
        type, risk: "auto", targetId: task.id, targetTitle: itemTitle("task", task),
        patch: { status: "Concluida", completedAt: today },
        previous: { status: task.status || "Pendente", completedAt: task.completedAt || "" },
        summary: `✅ Tarefa concluída: “${itemTitle("task", task)}”`,
      },
    };
  }

  if (type === "edit_transaction") {
    let entry = null;
    if (raw.targetId || raw.query) {
      const found = resolveTarget("finance", raw, state);
      if (found.status === "ambiguous") return { ok: false, ask: ambiguityQuestion("um lançamento", found.items, "finance") };
      entry = found.status === "unique" ? found.item : null;
    }
    if (!entry) {
      const lastId = ctx.lastFinanceEntry?.id;
      entry = asArray(state.finances).find((item) => item.id === lastId) || asArray(state.finances)[0] || null;
    }
    if (!entry) return { ok: false, ask: "Não encontrei um lançamento para corrigir." };
    const patch = {};
    const amount = parseAmount(raw.amount);
    if (amount && amount <= 10_000_000) patch.amount = amount;
    if (raw.transactionType === "receita" || raw.transactionType === "despesa") patch.type = raw.transactionType;
    const kind = patch.type || entry.type || "despesa";
    if (categories.some((c) => c.id === raw.categoryId && c.type === kind)) patch.category = raw.categoryId;
    const date = validIsoDate(raw.date);
    if (date) patch.date = date;
    const description = cleanText(raw.title || raw.description, 80);
    if (description) patch.description = description;
    if (!Object.keys(patch).length) return { ok: false, ask: "O que você quer mudar nesse lançamento? (valor, data, categoria ou descrição)" };
    const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, entry[key] ?? ""]));
    const changes = [
      patch.amount !== undefined && `valor ${money(patch.amount)}`,
      patch.date && `data ${formatWhen(patch.date, "", today)}`,
      patch.category && `categoria ${categoryLabel(categories, patch.category)}`,
      patch.description && `descrição “${patch.description}”`,
      patch.type && `tipo ${patch.type}`,
    ].filter(Boolean).join(", ");
    return {
      ok: true,
      action: {
        type, risk: "auto", targetId: entry.id, targetTitle: itemTitle("finance", entry), patch, previous,
        summary: `✏️ Corrigi “${itemTitle("finance", entry)}”: ${changes}`,
      },
    };
  }

  if (DESTRUCTIVE_TYPES.has(type)) {
    const kind = { delete_transaction: "finance", delete_task: "task", delete_note: "note", delete_event: "event" }[type];
    const nouns = { finance: ["um lançamento", "o lançamento"], task: ["uma tarefa", "a tarefa"], note: ["uma nota", "a nota"], event: ["um compromisso", "o compromisso"] }[kind];
    const found = resolveTarget(kind, raw, state);
    if (found.status === "ambiguous") return { ok: false, ask: ambiguityQuestion(nouns[0], found.items, kind) };
    if (found.status !== "unique") return { ok: false, ask: `Não encontrei ${nouns[1]} que você quer excluir. Pode me dizer o nome?` };
    const item = found.item;
    const detail = kind === "finance" ? ` (${money(item.amount)}${item.date ? `, ${formatWhen(item.date, "", today)}` : ""})` : "";
    return {
      ok: true,
      action: {
        type, risk: "confirm", targetId: item.id, targetTitle: itemTitle(kind, item),
        summary: `🗑️ Excluir ${nouns[1]} “${itemTitle(kind, item)}”${detail}`,
      },
    };
  }
  return { ok: false };
}

function normalizeActions(rawActions, ctx) {
  const actions = [];
  const asks = [];
  for (const raw of asArray(rawActions).slice(0, MAX_ACTIONS * 2)) {
    if (actions.length >= MAX_ACTIONS) break;
    const result = normalizeAction(raw, ctx);
    if (result.ok) actions.push(result.action);
    else if (result.ask && !asks.includes(result.ask)) asks.push(result.ask);
  }
  return { actions, asks };
}

// ── Aplicação no estado (servidor/WhatsApp) ──
const COLLECTION = {
  add_transaction: "finances", add_task: "tasks", add_event: "events", add_note: "notes", add_goal: "goals",
  update_goal: "goals", complete_task: "tasks", edit_transaction: "finances",
  delete_transaction: "finances", delete_task: "tasks", delete_note: "notes", delete_event: "events",
};

function applyActionToState(state, action) {
  const key = COLLECTION[action?.type];
  if (!key) return { ok: false };
  const list = Array.isArray(state[key]) ? state[key] : (state[key] = []);
  if (action.type.startsWith("add_")) {
    if (list.some((item) => item?.id === action.record.id)) return { ok: true, record: action.record, duplicate: true };
    // Compromissos entram no fim (mesmo padrão do app); o resto no topo.
    if (action.type === "add_event") list.push({ ...action.record });
    else list.unshift({ ...action.record });
    return { ok: true, record: action.record };
  }
  const index = list.findIndex((item) => item?.id === action.targetId);
  if (index < 0) return { ok: false, missing: true };
  if (action.type.startsWith("delete_")) {
    const [removed] = list.splice(index, 1);
    return { ok: true, record: removed };
  }
  list[index] = { ...list[index], ...action.patch };
  return { ok: true, record: list[index] };
}

// Versão enxuta para guardar ações pendentes (confirmação no WhatsApp)
// ou devolver ao app — sem nada além do necessário para aplicar.
function serializeAction(action) {
  const base = { type: action.type, risk: action.risk, summary: action.summary };
  if (action.record) base.record = action.record;
  if (action.targetId) Object.assign(base, { targetId: action.targetId, targetTitle: action.targetTitle });
  if (action.patch) Object.assign(base, { patch: action.patch, previous: action.previous });
  if (action.lowConfidence) Object.assign(base, { lowConfidence: true, categoryAlternatives: action.categoryAlternatives || [] });
  return base;
}

// Compatibilidade com a confirmação antiga (proposedAction único).
function toLegacyProposedAction(action) {
  if (!action) return null;
  const map = { add_task: "create_task", add_event: "create_event", add_note: "create_note", add_goal: "create_goal", add_transaction: "create_transaction" };
  const legacyType = map[action.type];
  if (!legacyType || !action.record) return null;
  const r = action.record;
  const payload = action.type === "add_transaction"
    ? { title: r.description, amount: r.amount, type: r.type, category: r.category, date: r.date }
    : action.type === "add_task" ? { title: r.title, dueDate: r.dueDate, dueTime: r.dueTime, reminder: r.reminder, priority: r.priority }
      : action.type === "add_event" ? { title: r.title, date: r.date, time: r.time, location: r.location, reminder: r.reminder }
        : action.type === "add_note" ? { title: r.title, description: r.description }
          : { title: r.title, target: r.target };
  return { type: legacyType, label: "Confirmar", summary: action.summary, payload, requiresConfirmation: true };
}

module.exports = {
  ACTION_TYPES,
  DESTRUCTIVE_TYPES,
  MAX_ACTIONS,
  normalizeAction,
  normalizeActions,
  applyActionToState,
  serializeAction,
  toLegacyProposedAction,
  resolveTarget,
  formatWhen,
  validTime,
  validIsoDate,
  parseAmount,
  money,
  addDays,
};
