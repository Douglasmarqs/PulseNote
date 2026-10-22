const crypto = require("node:crypto");

const DEFAULT_TIME_ZONE = "America/Sao_Paulo";
const MAX_SUGGESTIONS_PER_KIND = 3;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function dateParts(now, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
}

function localClock(now, requestedTimeZone) {
  const timeZone = validTimeZone(requestedTimeZone || DEFAULT_TIME_ZONE);
  const parts = dateParts(now, timeZone);
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    timeZone,
  };
}

function addCalendarDays(iso, days) {
  const date = new Date(`${iso}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function money(amount) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(amount);
}

function stableId(kind, parts) {
  const digest = crypto.createHash("sha256").update(JSON.stringify([kind, ...parts])).digest("hex");
  return `ap_${digest.slice(0, 20)}`;
}

function suggestion(kind, parts, details) {
  const id = stableId(kind, parts);
  return {
    id,
    code: id.slice(3, 13),
    kind,
    ...details,
    source: details.area,
    description: details.reason,
  };
}

function isOpen(item) {
  return item && item.status !== "Concluida" && item.status !== "Cancelada";
}

function checklistText(item) {
  return asText(typeof item === "string" ? item : item?.text || item?.title);
}

function checklistDone(item) {
  return typeof item === "object" && item !== null && item.done === true;
}

function categoryName(state, categoryId) {
  const custom = asArray(state.customCategories).find((item) => item.id === categoryId);
  const label = asText(custom?.label, categoryId.replace(/_/g, " "))
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D]+\s*/u, "");
  return label.charAt(0).toLocaleUpperCase("pt-BR") + label.slice(1);
}

// Pure, deterministic recommendations. No model call and no writes occur here.
function buildSuggestions(state = {}, now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError("invalid_now");
  const { today, time, timeZone } = localClock(instant, state.timeZone);
  const tomorrow = addCalendarDays(today, 1);
  const dayAfterTomorrow = addCalendarDays(today, 2);
  const month = today.slice(0, 7);
  const candidates = [];

  const overdue = asArray(state.tasks)
    .filter((task) => task?.id && isOpen(task) && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate || "") && task.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, MAX_SUGGESTIONS_PER_KIND);
  for (const task of overdue) {
    const title = asText(task.title, "Tarefa sem título");
    candidates.push(suggestion("overdue_task", [task.id, title, task.dueDate], {
      area: "planner",
      priority: task.priority === "Alta" || task.priority === "Urgente" ? "high" : "medium",
      score: task.priority === "Alta" || task.priority === "Urgente" ? 90 : 75,
      title: `Revisar tarefa atrasada: ${title}`,
      reason: `Venceu em ${task.dueDate}. Você pode reagendar para amanhã ou marcar como concluída se já terminou.`,
      target: { type: "task", id: task.id },
      actionOptions: [
        { action: "reschedule_task_tomorrow", label: "Reagendar para amanhã" },
        { action: "complete_task", label: "Marcar como concluída" },
      ],
      metadata: { dueDate: task.dueDate, proposedDueDate: tomorrow },
    }));
  }

  const upcoming = asArray(state.events)
    .filter((event) => event?.id && isOpen(event) && event.date >= today && event.date <= dayAfterTomorrow
      && (!event.time || event.date > today || event.time > time)
      && !asArray(state.tasks).some((task) => task.sourceEventId === event.id && isOpen(task)))
    .sort((a, b) => `${a.date}${a.time || ""}`.localeCompare(`${b.date}${b.time || ""}`))
    .slice(0, MAX_SUGGESTIONS_PER_KIND);
  for (const event of upcoming) {
    const title = asText(event.title, "Compromisso");
    candidates.push(suggestion("upcoming_event", [event.id, title, event.date, event.time || ""], {
      area: "planner",
      priority: "medium",
      score: 65,
      title: `Preparar compromisso: ${title}`,
      reason: `Está marcado para ${event.date}${event.time ? ` às ${event.time}` : ""}.`,
      target: { type: "event", id: event.id },
      actionOptions: [{ action: "create_prep_task", label: "Criar tarefa de preparação" }],
      metadata: { date: event.date, time: event.time || "" },
    }));
  }

  const notes = asArray(state.notes)
    .filter((note) => note?.id && asArray(note.checklist).some((item) => checklistText(item) && !checklistDone(item)))
    .slice(0, MAX_SUGGESTIONS_PER_KIND);
  for (const note of notes) {
    const pending = asArray(note.checklist)
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => checklistText(item) && !checklistDone(item));
    const first = pending[0];
    const title = asText(note.title, "Nota sem título");
    const fingerprint = pending.map(({ item, index }) => [index, item?.id || "", checklistText(item)]);
    const options = [{ action: "mark_checklist_item", label: `Concluir: ${checklistText(first.item)}` }];
    if (!note.convertedToTaskId && !asArray(state.tasks).some((task) => task.sourceNoteId === note.id)) {
      options.push({ action: "convert_note_to_task", label: "Criar tarefa a partir da nota" });
    }
    candidates.push(suggestion("pending_checklist", [note.id, title, fingerprint], {
      area: "notes",
      priority: "low",
      score: 50,
      title: `Continuar checklist: ${title}`,
      reason: `${pending.length} ${pending.length === 1 ? "item pendente" : "itens pendentes"}; próximo: ${checklistText(first.item)}.`,
      target: { type: "note", id: note.id },
      actionOptions: options,
      metadata: { pendingCount: pending.length, itemIndex: first.index },
    }));
  }

  const budgets = asArray(state.finGoals)
    .filter((goal) => goal?.categoryId && Number(goal.limit) > 0)
    .map((goal) => {
      const spent = asArray(state.finances)
        .filter((entry) => entry?.type === "despesa" && entry.category === goal.categoryId && typeof entry.date === "string" && entry.date.startsWith(month))
        .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
      return { goal, spent, ratio: spent / Number(goal.limit) };
    })
    .filter(({ ratio }) => ratio >= 0.9)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, MAX_SUGGESTIONS_PER_KIND);
  for (const { goal, spent, ratio } of budgets) {
    const category = categoryName(state, goal.categoryId);
    const marker = `budget:${month}:${goal.categoryId}`;
    if (asArray(state.tasks).some((task) => task.autopilotSource === marker)) continue;
    candidates.push(suggestion("category_limit", [month, goal.categoryId, Number(goal.limit), Math.round(spent * 100)], {
      area: "finances",
      priority: ratio >= 1 ? "high" : "medium",
      score: ratio >= 1 ? 95 : 80,
      title: `Revisar gastos de ${category}`,
      reason: `${money(spent)} de ${money(Number(goal.limit))} usados neste mês (${Math.round(ratio * 100)}%).`,
      target: { type: "category_budget", id: goal.categoryId },
      actionOptions: [{ action: "create_budget_review_task", label: "Criar tarefa para revisar gastos" }],
      metadata: { month, category, spent, limit: Number(goal.limit) },
    }));
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, MAX_SUGGESTIONS_PER_KIND * 4)
    .map(({ score, ...publicSuggestion }) => publicSuggestion);
}

function findSuggestion(suggestions, reference) {
  if (typeof reference !== "string") return null;
  const matches = suggestions.filter((item) => item.id === reference || item.code === reference.toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

function taskFromSuggestion(title, priority, dueDate, today, source) {
  return {
    id: crypto.randomUUID(),
    title,
    status: "Pendente",
    priority,
    dueDate,
    createdAt: today,
    completedAt: "",
    dueTime: "",
    reminder: 15,
    sourceNoteId: "",
    subtasks: [],
    recurrence: null,
    source: "autopilot",
    ...source,
  };
}

// Called only after the server has authenticated the user, re-read the current
// document in a Firestore transaction and matched the suggestion again.
function applySuggestionAction(state, suggestionItem, action, now = new Date()) {
  if (!suggestionItem?.actionOptions.some((option) => option.action === action)) {
    throw Object.assign(new Error("invalid_action"), { status: 400 });
  }
  const { today } = localClock(now, state.timeZone);
  const patch = {};
  let result;

  if (action === "reschedule_task_tomorrow" || action === "complete_task") {
    const tasks = asArray(state.tasks);
    const task = tasks.find((item) => item.id === suggestionItem.target.id);
    if (!task || !isOpen(task)) throw Object.assign(new Error("stale_suggestion"), { status: 409 });
    const next = action === "complete_task"
      ? { ...task, status: "Concluida", completedAt: today }
      : { ...task, dueDate: addCalendarDays(today, 1) };
    patch.tasks = tasks.map((item) => item.id === task.id ? next : item);
    result = { type: "task", id: task.id, title: asText(task.title), message: action === "complete_task" ? "Tarefa concluída." : "Tarefa reagendada para amanhã." };
  } else if (action === "mark_checklist_item" || action === "convert_note_to_task") {
    const notes = asArray(state.notes);
    const note = notes.find((item) => item.id === suggestionItem.target.id);
    if (!note) throw Object.assign(new Error("stale_suggestion"), { status: 409 });
    if (action === "mark_checklist_item") {
      const index = suggestionItem.metadata.itemIndex;
      const current = asArray(note.checklist)[index];
      if (!current || checklistDone(current)) throw Object.assign(new Error("stale_suggestion"), { status: 409 });
      const nextItem = { ...(typeof current === "object" && current ? current : {}), id: current?.id || crypto.randomUUID(), text: checklistText(current), done: true };
      const nextNote = { ...note, checklist: note.checklist.map((item, itemIndex) => itemIndex === index ? nextItem : item) };
      patch.notes = notes.map((item) => item.id === note.id ? nextNote : item);
      result = { type: "note", id: note.id, title: asText(note.title), message: "Item da checklist concluído." };
    } else {
      if (note.convertedToTaskId || asArray(state.tasks).some((task) => task.sourceNoteId === note.id)) {
        throw Object.assign(new Error("stale_suggestion"), { status: 409 });
      }
      const task = taskFromSuggestion(asText(note.title, "Revisar nota"), asText(note.priority, "Media"), today, today, { sourceNoteId: note.id });
      task.subtasks = asArray(note.checklist)
        .filter((item) => checklistText(item) && !checklistDone(item))
        .map((item) => ({ id: crypto.randomUUID(), title: checklistText(item), done: false }));
      patch.tasks = [task, ...asArray(state.tasks)];
      patch.notes = notes.map((item) => item.id === note.id ? { ...item, convertedToTaskId: task.id } : item);
      result = { type: "task", id: task.id, title: task.title, message: "Tarefa criada a partir da nota." };
    }
  } else if (action === "create_prep_task") {
    const event = asArray(state.events).find((item) => item.id === suggestionItem.target.id);
    if (!event || asArray(state.tasks).some((task) => task.sourceEventId === event.id)) {
      throw Object.assign(new Error("stale_suggestion"), { status: 409 });
    }
    const task = taskFromSuggestion(`Preparar: ${asText(event.title, "compromisso")}`, "Media", today, today, { sourceEventId: event.id });
    patch.tasks = [task, ...asArray(state.tasks)];
    result = { type: "task", id: task.id, title: task.title, message: "Tarefa de preparação criada." };
  } else if (action === "create_budget_review_task") {
    const marker = `budget:${suggestionItem.metadata.month}:${suggestionItem.target.id}`;
    if (asArray(state.tasks).some((task) => task.autopilotSource === marker)) {
      throw Object.assign(new Error("stale_suggestion"), { status: 409 });
    }
    const task = taskFromSuggestion(`Revisar gastos de ${suggestionItem.metadata.category}`, "Alta", today, today, { autopilotSource: marker });
    patch.tasks = [task, ...asArray(state.tasks)];
    result = { type: "task", id: task.id, title: task.title, message: "Tarefa de revisão de gastos criada." };
  } else {
    throw Object.assign(new Error("invalid_action"), { status: 400 });
  }

  return { patch, result };
}

function formatSuggestionsForWhatsApp(suggestions) {
  if (!suggestions.length) return "✨ Pulse Autopilot: tudo em dia por enquanto. Vou mostrar novas sugestões quando houver algo útil.";
  return [
    "✨ *Pulse Autopilot* — sugestões para você:",
    ...suggestions.map((item) => `${item.priority === "high" ? "⚠️" : "•"} ${item.title}\n${item.reason}\nCódigo: *${item.code}* · ${item.actionOptions.map((option) => option.label).join(" / ")}`),
    "Para executar, escolha a ação e confirme. Nenhuma mudança é feita automaticamente.",
  ].join("\n\n");
}

module.exports = {
  buildSuggestions,
  findSuggestion,
  applySuggestionAction,
  formatSuggestionsForWhatsApp,
  localClock,
};
