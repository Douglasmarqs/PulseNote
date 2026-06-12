const storageKey = "pulsenote-state-v1";
const statusList = ["Pendente", "Em andamento", "Concluida", "Cancelada"];
const viewTitles = {
  dashboard: "Seu dia em foco ✨",
  notes: "Anotações",
  tasks: "Tarefas",
  calendar: "Agenda",
  goals: "Metas e conquistas",
};
const themeList = ["sunny", "ocean", "candy", "forest", "night"];
const themeNames = {
  sunny: "Sol",
  ocean: "Oceano",
  candy: "Doce",
  forest: "Floresta",
  night: "Noite",
};

const todayIso = new Date().toISOString().slice(0, 10);
const tomorrowIso = offsetDate(1);
const weekIso = offsetDate(5);

let state = loadState();
let activeView = "dashboard";
let calendarMode = "month";
let draggedTaskId = null;

const elements = {
  viewTitle: document.querySelector("#viewTitle"),
  todayLabel: document.querySelector("#todayLabel"),
  globalSearch: document.querySelector("#globalSearch"),
  themeSelect: document.querySelector("#themeSelect"),
  themeSelectMobile: document.querySelector("#themeSelectMobile"),
  toast: document.querySelector("#toast"),
};

document.addEventListener("DOMContentLoaded", () => {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const icon = hour < 12 ? "☀️" : hour < 18 ? "🌤️" : "🌙";
  const dateStr = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(now);

  elements.todayLabel.textContent = `${greeting}, Douglas ${icon}  ·  ${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}`;

  state.theme = normalizeTheme(state.theme);
  applyTheme(state.theme);
  bindNavigation();
  bindForms();
  bindActions();
  renderAll();
});

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    return JSON.parse(saved);
  }

  return {
    theme: "sunny",
    notes: [
      {
        id: crypto.randomUUID(),
        title: "Organizar sprint pessoal",
        description: "Definir tres entregas principais, revisar calendario e separar blocos de foco.",
        category: "Trabalho",
        folder: "Produtividade",
        tags: ["planejamento", "foco"],
        priority: "Alta",
        checklist: ["Revisar tarefas pendentes", "Bloquear horarios", "Enviar resumo"],
        attachments: ["https://calendar.google.com"],
        goal: "Fechar a semana com clareza",
        observations: "Converter tarefas criticas em compromissos.",
        favorite: true,
        createdAt: todayIso,
      },
      {
        id: crypto.randomUUID(),
        title: "Ideias para rotina de estudos",
        description: "Criar biblioteca por temas e acompanhar progresso por ciclos.",
        category: "Estudos",
        folder: "Aprendizado",
        tags: ["estudo", "habito"],
        priority: "Media",
        checklist: ["Separar materiais", "Criar revisao semanal"],
        attachments: [],
        goal: "Estudar 5 horas na semana",
        observations: "",
        favorite: false,
        createdAt: todayIso,
      },
    ],
    tasks: [
      createTask("Revisar prioridades da semana", "Pendente", "Alta", todayIso),
      createTask("Enviar pauta da reuniao", "Em andamento", "Media", todayIso),
      createTask("Atualizar lista de metas", "Concluida", "Media", offsetDate(-1), offsetDate(-1)),
      createTask("Cancelar assinatura duplicada", "Cancelada", "Baixa", weekIso),
    ],
    events: [
      {
        id: crypto.randomUUID(),
        title: "Reuniao de planejamento",
        date: todayIso,
        time: "14:30",
        location: "Google Meet",
        reminder: 15,
        notes: "Levar resumo de tarefas e metas da semana.",
      },
      {
        id: crypto.randomUUID(),
        title: "Check-in de saude",
        date: tomorrowIso,
        time: "08:00",
        location: "Clinica central",
        reminder: 60,
        notes: "",
      },
    ],
    goals: [
      { id: crypto.randomUUID(), title: "Concluir 8 tarefas importantes", target: 8, current: 3 },
      { id: crypto.randomUUID(), title: "Manter rotina de estudos", target: 5, current: 2 },
    ],
  };
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function normalizeTheme(theme) {
  if (theme === "light") return "sunny";
  if (theme === "dark") return "night";
  return themeList.includes(theme) ? theme : "sunny";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = normalizeTheme(theme);
  if (elements.themeSelect) {
    elements.themeSelect.value = normalizeTheme(theme);
  }
  if (elements.themeSelectMobile) {
    elements.themeSelectMobile.value = normalizeTheme(theme);
  }
}

function createTask(title, status = "Pendente", priority = "Media", dueDate = todayIso, completedAt = "") {
  return {
    id: crypto.randomUUID(),
    title,
    status,
    priority,
    dueDate,
    createdAt: todayIso,
    completedAt,
    sourceNoteId: "",
  };
}

function offsetDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function bindNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelectorAll("[data-view-shortcut]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewShortcut));
  });
}

function bindForms() {
  document.querySelector("#noteForm").addEventListener("submit", saveNote);
  document.querySelector("#resetNoteForm").addEventListener("click", resetNoteForm);
  document.querySelector("#suggestNote").addEventListener("click", suggestNoteMetadata);
  document.querySelector("#noteFilter").addEventListener("change", renderNotes);
  document.querySelector("#taskForm").addEventListener("submit", saveTask);
  document.querySelector("#eventForm").addEventListener("submit", saveEvent);
  document.querySelector("#goalForm").addEventListener("submit", saveGoal);
  document.querySelector("#quickAddTask").addEventListener("click", () => {
    setView("tasks");
    document.querySelector("#taskTitle").focus();
  });
  elements.globalSearch.addEventListener("input", renderAll);

  // Filter chips (new UI)
  document.querySelectorAll("[data-note-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-note-filter]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      document.querySelector("#noteFilter").value = chip.dataset.noteFilter;
      renderNotes();
    });
  });
}

function bindActions() {
  document.querySelector("#themeToggle").addEventListener("click", () => {
    const currentIndex = themeList.indexOf(normalizeTheme(state.theme));
    state.theme = themeList[(currentIndex + 1) % themeList.length];
    applyTheme(state.theme);
    saveState();
    showToast(`Tema ${themeNames[state.theme]} aplicado.`);
  });

  [elements.themeSelect, elements.themeSelectMobile].forEach((select) => {
    select.addEventListener("change", (event) => {
      state.theme = event.target.value;
      applyTheme(state.theme);
      saveState();
      showToast(`Tema ${themeNames[state.theme]} aplicado.`);
    });
  });

  document.querySelectorAll("[data-calendar-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      calendarMode = button.dataset.calendarMode;
      document.querySelectorAll("[data-calendar-mode]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      renderCalendar();
    });
  });
}

function setView(view) {
  activeView = view;
  // Sync sidebar nav
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  // Sync bottom nav (mobile)
  document.querySelectorAll(".bottom-nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => section.classList.remove("active-view"));
  document.querySelector(`#${view}View`).classList.add("active-view");
  elements.viewTitle.textContent = viewTitles[view];
  // Scroll to top on mobile
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function saveNote(event) {
  event.preventDefault();
  const id = document.querySelector("#noteId").value;
  const payload = {
    id: id || crypto.randomUUID(),
    title: valueOf("#noteTitle"),
    description: valueOf("#noteDescription"),
    category: valueOf("#noteCategory") || "Geral",
    folder: valueOf("#noteFolder") || "Entrada",
    tags: splitValues(valueOf("#noteTags")),
    priority: valueOf("#notePriority"),
    checklist: splitLines(valueOf("#noteChecklist")),
    attachments: splitValues(valueOf("#noteAttachments")),
    goal: valueOf("#noteGoal"),
    observations: valueOf("#noteObservations"),
    favorite: state.notes.find((note) => note.id === id)?.favorite || false,
    createdAt: state.notes.find((note) => note.id === id)?.createdAt || todayIso,
  };

  state.notes = id ? state.notes.map((note) => (note.id === id ? payload : note)) : [payload, ...state.notes];
  saveState();
  resetNoteForm();
  renderAll();
  showToast(id ? "Anotacao atualizada." : "Anotacao criada.");
}

function saveTask(event) {
  event.preventDefault();
  const task = createTask(valueOf("#taskTitle"), "Pendente", valueOf("#taskPriority"), valueOf("#taskDue") || todayIso);
  state.tasks.unshift(task);
  event.target.reset();
  document.querySelector("#taskDue").value = todayIso;
  saveState();
  renderAll();
  showToast("Tarefa adicionada.");
}

function saveEvent(event) {
  event.preventDefault();
  state.events.push({
    id: crypto.randomUUID(),
    title: valueOf("#eventTitle"),
    date: valueOf("#eventDate"),
    time: valueOf("#eventTime"),
    location: valueOf("#eventLocation") || "Sem local",
    reminder: Number(valueOf("#eventReminder")),
    notes: valueOf("#eventNotes"),
  });
  event.target.reset();
  setDefaultDates();
  saveState();
  renderAll();
  showToast("Compromisso salvo com lembrete.");
}

function saveGoal(event) {
  event.preventDefault();
  state.goals.unshift({
    id: crypto.randomUUID(),
    title: valueOf("#goalTitle"),
    target: Number(valueOf("#goalTarget") || 1),
    current: 0,
  });
  event.target.reset();
  document.querySelector("#goalTarget").value = 5;
  saveState();
  renderAll();
  showToast("Meta criada.");
}

function valueOf(selector) {
  return document.querySelector(selector).value.trim();
}

function splitValues(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resetNoteForm() {
  document.querySelector("#noteForm").reset();
  document.querySelector("#noteId").value = "";
  document.querySelector("#notePriority").value = "Media";
}

function suggestNoteMetadata() {
  const text = `${valueOf("#noteTitle")} ${valueOf("#noteDescription")}`.toLowerCase();
  const category = text.includes("reuniao") || text.includes("projeto") ? "Trabalho" : text.includes("estudo") ? "Estudos" : "Pessoal";
  const priority = text.includes("urgente") || text.includes("prazo") ? "Urgente" : text.includes("importante") ? "Alta" : "Media";
  document.querySelector("#noteCategory").value = category;
  document.querySelector("#notePriority").value = priority;
  if (!valueOf("#noteTags")) {
    document.querySelector("#noteTags").value = [category.toLowerCase(), priority.toLowerCase()].join(", ");
  }
  showToast("Sugestoes aplicadas.");
}

function renderAll() {
  setDefaultDates();
  renderDashboard();
  renderNotes();
  renderTasks();
  renderCalendar();
  renderGoals();
}

function setDefaultDates() {
  document.querySelector("#taskDue").value ||= todayIso;
  document.querySelector("#eventDate").value ||= todayIso;
  document.querySelector("#eventTime").value ||= "09:00";
}

function queryFilter(items, fields) {
  const query = elements.globalSearch.value.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => fields.some((field) => String(item[field] || "").toLowerCase().includes(query)));
}

function renderDashboard() {
  const doneToday = state.tasks.filter((task) => task.completedAt === todayIso).length;
  const doneTotal = state.tasks.filter((task) => task.status === "Concluida").length;
  const activeTasks = state.tasks.filter((task) => task.status !== "Cancelada");
  const progress = activeTasks.length ? Math.round((doneTotal / activeTasks.length) * 100) : 0;
  const nextEvents = state.events.filter((event) => event.date >= todayIso && event.date <= offsetDate(7));
  const score = doneTotal * 25 + state.goals.reduce((sum, goal) => sum + goal.current * 10, 0);

  document.querySelector("#doneMetric").textContent = doneToday;
  document.querySelector("#doneMetricDetail").textContent = `${doneTotal} no historico`;
  document.querySelector("#progressMetric").textContent = `${progress}%`;
  document.querySelector("#eventMetric").textContent = nextEvents.length;
  document.querySelector("#scoreMetric").textContent = score;
  const level = Math.max(1, Math.floor(score / 150) + 1);
  const levelProgress = Math.min(100, Math.round(((score % 150) / 150) * 100));
  document.querySelector("#levelMetric").textContent = `Nivel ${level}`;
  document.querySelector("#heroLevelLabel").textContent = `Nivel ${level}`;
  document.querySelector("#heroProgressBar").style.width = `${levelProgress}%`;
  document.querySelector("#heroProgressLabel").textContent = `${levelProgress}%`;
  document.querySelector("#heroQuestLabel").textContent =
    doneTotal > 0 ? "Sua rotina esta ganhando ritmo" : "Complete uma tarefa para iniciar sua sequencia";
  document.querySelector("#streakCount").textContent = `${calculateStreak()} dias`;

  renderList("#todayTasks", state.tasks.filter((task) => task.status !== "Concluida" && task.status !== "Cancelada").slice(0, 5), renderTaskRow, "Nenhuma tarefa pendente.");
  renderList("#upcomingEvents", nextEvents.sort(sortEvent).slice(0, 5), renderEventRow, "Nenhum compromisso nos proximos dias.");
  renderChart();
  renderGoalSummary();
}

function calculateStreak() {
  let streak = 0;
  for (let days = 0; days < 30; days += 1) {
    const date = offsetDate(-days);
    if (state.tasks.some((task) => task.completedAt === date)) {
      streak += 1;
    } else if (days > 0) {
      break;
    }
  }
  return streak;
}

function renderChart() {
  const chart = document.querySelector("#chartBars");
  const days = [...Array(7)].map((_, index) => offsetDate(index - 6));
  const counts = days.map((date) => state.tasks.filter((task) => task.completedAt === date).length);
  const max = Math.max(1, ...counts);
  document.querySelector("#weeklySummary").textContent = `${counts.reduce((sum, count) => sum + count, 0)} concluidas`;
  chart.innerHTML = days
    .map((date, index) => {
      const label = new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(new Date(`${date}T12:00:00`));
      const height = 18 + (counts[index] / max) * 150;
      return `<div class="bar-item"><div class="bar" style="height:${height}px" title="${counts[index]} tarefas"></div><span>${label}</span></div>`;
    })
    .join("");
}

function renderGoalSummary() {
  renderList(
    "#goalSummary",
    state.goals.slice(0, 4),
    (goal) => {
      const percent = Math.min(100, Math.round((goal.current / goal.target) * 100));
      return `<div class="goal-row"><div><strong>${escapeHtml(goal.title)}</strong><div class="task-meta">${goal.current}/${goal.target}</div></div><span class="pill">${percent}%</span></div>`;
    },
    "Crie sua primeira meta."
  );
}

function renderNotes() {
  const filter = document.querySelector("#noteFilter").value;
  let notes = queryFilter(state.notes, ["title", "description", "category", "folder", "goal"]);
  if (filter === "favorite") notes = notes.filter((note) => note.favorite);
  if (["Alta", "Urgente"].includes(filter)) notes = notes.filter((note) => note.priority === filter);

  renderList(
    "#notesList",
    notes,
    (note) => {
      // Build checklist preview (max 3 items)
      const checklistHtml = note.checklist && note.checklist.length
        ? `<div class="checklist-preview">${note.checklist.slice(0, 3).map((item) =>
            `<div class="cl-item">
              <span class="cl-check">✓</span>
              <span class="cl-text">${escapeHtml(item)}</span>
            </div>`
          ).join("")}${note.checklist.length > 3 ? `<div class="cl-item"><span class="task-meta">+${note.checklist.length - 3} mais itens</span></div>` : ""}</div>`
        : "";

      const tagsHtml = note.tags && note.tags.length
        ? `<div class="tag-list">${note.tags.slice(0,3).map((t) => `<span class="pill">#${escapeHtml(t)}</span>`).join("")}</div>`
        : "";

      return `
        <article class="note-card">
          <header>
            <div>
              <h3>${escapeHtml(note.title)}</h3>
              <div class="note-meta">${escapeHtml(note.category)} · ${formatDate(note.createdAt)}</div>
            </div>
            <button class="mini-button" onclick="toggleFavorite('${note.id}')" title="Favoritar" style="font-size:1.1rem;background:none;border:none;padding:0;width:30px;height:30px;display:grid;place-items:center;flex-shrink:0;border-radius:50%;">${note.favorite ? "⭐" : "☆"}</button>
          </header>
          ${note.description ? `<p>${escapeHtml(note.description)}</p>` : ""}
          ${checklistHtml}
          ${tagsHtml}
          <div class="tag-list" style="margin-top:4px">
            <span class="priority-pill priority-${note.priority}">${note.priority}</span>
          </div>
          <div class="card-actions">
            <button onclick="editNote('${note.id}')">✏️ Editar</button>
            <button onclick="convertNoteToTask('${note.id}')">➡️ Tarefa</button>
            <button onclick="deleteNote('${note.id}')">🗑️</button>
          </div>
        </article>
      `;
    },
    "Nenhuma anotação encontrada. Crie a primeira! ✨"
  );
}

function editNote(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  document.querySelector("#noteId").value = note.id;
  document.querySelector("#noteTitle").value = note.title;
  document.querySelector("#noteDescription").value = note.description;
  document.querySelector("#noteCategory").value = note.category;
  document.querySelector("#noteFolder").value = note.folder;
  document.querySelector("#noteTags").value = note.tags.join(", ");
  document.querySelector("#notePriority").value = note.priority;
  document.querySelector("#noteChecklist").value = note.checklist.join("\n");
  document.querySelector("#noteAttachments").value = note.attachments.join(", ");
  document.querySelector("#noteGoal").value = note.goal;
  document.querySelector("#noteObservations").value = note.observations;
  setView("notes");
  document.querySelector("#noteTitle").focus();
}

function toggleFavorite(id) {
  state.notes = state.notes.map((note) => (note.id === id ? { ...note, favorite: !note.favorite } : note));
  saveState();
  renderAll();
}

function convertNoteToTask(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  state.tasks.unshift({ ...createTask(note.title, "Pendente", note.priority, todayIso), sourceNoteId: note.id });
  saveState();
  renderAll();
  celebrate("Anotacao convertida em tarefa.");
}

function deleteNote(id) {
  state.notes = state.notes.filter((note) => note.id !== id);
  saveState();
  renderAll();
  showToast("Anotacao excluida.");
}

function renderTasks() {
  const tasks = queryFilter(state.tasks, ["title", "status", "priority", "dueDate"]);
  const board = document.querySelector("#taskBoard");
  const activeTasks = state.tasks.filter((task) => task.status !== "Cancelada");
  const completed = activeTasks.filter((task) => task.status === "Concluida").length;
  const progress = activeTasks.length ? Math.round((completed / activeTasks.length) * 100) : 0;
  document.querySelector("#taskProgressBar").style.width = `${progress}%`;
  document.querySelector("#taskProgressLabel").textContent = `${progress}%`;

  board.innerHTML = statusList
    .map((status) => {
      const columnTasks = tasks.filter((task) => task.status === status);
      return `
        <section class="task-column" data-status="${status}">
          <div class="column-title"><h2>${status}</h2><span class="pill">${columnTasks.length}</span></div>
          ${columnTasks.map(renderTaskRow).join("") || '<div class="empty-state">Sem itens.</div>'}
        </section>
      `;
    })
    .join("");

  document.querySelectorAll(".task-column").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      column.classList.add("drag-over");
    });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", () => {
      column.classList.remove("drag-over");
      updateTaskStatus(draggedTaskId, column.dataset.status);
    });
  });
}

function renderTaskRow(task) {
  const isDone = task.status === "Concluida";
  return `
    <article class="task-row" draggable="true" ondragstart="dragTask('${task.id}')">
      <div class="task-main">
        <button class="task-check" onclick="toggleTask('${task.id}')" title="Concluir" style="${isDone ? "background:var(--green);border-color:var(--green);color:#fff;" : ""}">${isDone ? "✓" : ""}</button>
        <div>
          <div class="task-title" style="${isDone ? "text-decoration:line-through;opacity:0.5;" : ""}">${escapeHtml(task.title)}</div>
          <div class="task-meta">${formatDate(task.dueDate)} · ${escapeHtml(task.priority)}</div>
        </div>
      </div>
      <div class="tag-list">
        <span class="status-pill status-${task.status.replace(" ", "-")}">${task.status}</span>
        <button class="mini-button" onclick="deleteTask('${task.id}')" title="Excluir" style="padding:0;width:28px;height:28px;">🗑️</button>
      </div>
    </article>
  `;
}

function dragTask(id) {
  draggedTaskId = id;
}

function toggleTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  const nextStatus = task.status === "Concluida" ? "Pendente" : "Concluida";
  updateTaskStatus(id, nextStatus);
}

function updateTaskStatus(id, status) {
  const previous = state.tasks.find((task) => task.id === id)?.status;
  state.tasks = state.tasks.map((task) =>
    task.id === id
      ? {
          ...task,
          status,
          completedAt: status === "Concluida" ? todayIso : "",
        }
      : task
  );
  saveState();
  renderAll();
  if (status === "Concluida" && previous !== "Concluida") {
    celebrate("Tarefa concluida. XP ganho.");
  }
}

function deleteTask(id) {
  state.tasks = state.tasks.filter((task) => task.id !== id);
  saveState();
  renderAll();
}

function renderCalendar() {
  const current = new Date();
  document.querySelector("#monthLabel").textContent = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
  }).format(current);

  const grid = document.querySelector("#calendarGrid");
  const days = calendarMode === "month" ? getMonthDays(current) : calendarMode === "week" ? getWeekDays(current) : [todayIso];
  grid.innerHTML = days
    .map((date) => {
      const events = state.events.filter((event) => event.date === date);
      return `<button class="calendar-day ${date === todayIso ? "today" : ""} ${events.length ? "has-event" : ""}" onclick="filterEventsByDate('${date}')"><strong>${new Date(`${date}T12:00:00`).getDate()}</strong><span class="task-meta">${events.length || ""}</span></button>`;
    })
    .join("");

  const events = queryFilter(state.events, ["title", "location", "notes"]).sort(sortEvent);
  renderList("#calendarEvents", events, renderEventRow, "Nenhum compromisso cadastrado.");
}

function getMonthDays(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const total = new Date(year, month + 1, 0).getDate();
  return [...Array(total)].map((_, index) => new Date(year, month, index + 1).toISOString().slice(0, 10));
}

function getWeekDays(date) {
  const start = new Date(date);
  start.setDate(date.getDate() - date.getDay());
  return [...Array(7)].map((_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function filterEventsByDate(date) {
  const events = state.events.filter((event) => event.date === date).sort(sortEvent);
  renderList("#calendarEvents", events, renderEventRow, "Sem compromissos nesse dia.");
}

function renderEventRow(event) {
  return `
    <article class="event-row">
      <div style="flex:1;min-width:0">
        <strong style="font-size:0.9rem">${escapeHtml(event.title)}</strong>
        <div class="event-meta">📅 ${formatDate(event.date)} às ${event.time} · 📍 ${escapeHtml(event.location)}</div>
      </div>
      <div class="tag-list" style="flex-shrink:0">
        <span class="pill" style="background:var(--orange-soft);color:var(--orange);border-color:var(--orange)">⏰ ${event.reminder}min</span>
        <button class="mini-button" onclick="deleteEvent('${event.id}')" title="Excluir" style="padding:0;width:28px;height:28px">🗑️</button>
      </div>
    </article>
  `;
}

function sortEvent(first, second) {
  return `${first.date}${first.time}`.localeCompare(`${second.date}${second.time}`);
}

function deleteEvent(id) {
  state.events = state.events.filter((event) => event.id !== id);
  saveState();
  renderAll();
}

function renderGoals() {
  renderList(
    "#goalsList",
    state.goals,
    (goal) => {
      const percent = Math.min(100, Math.round((goal.current / goal.target) * 100));
      const isComplete = goal.current >= goal.target;
      return `
        <article class="goal-card" style="${isComplete ? "border-color:var(--green);background:var(--green-soft);" : ""}">
          <div>
            <h2>${escapeHtml(goal.title)}</h2>
            <div class="task-meta">${goal.current}/${goal.target} etapas ${isComplete ? "🎉" : ""}</div>
          </div>
          <div class="progress-track"><div style="width:${percent}%;background:${isComplete ? "var(--green)" : "linear-gradient(90deg,var(--accent),var(--purple))"}"></div></div>
          <div class="goal-controls">
            <button class="mini-button" onclick="changeGoal('${goal.id}', -1)">−</button>
            <span class="pill" style="${isComplete ? "background:var(--green);color:#fff;border-color:var(--green);" : ""}">${percent}%</span>
            <button class="mini-button" onclick="changeGoal('${goal.id}', 1)">+</button>
            <button class="mini-button" onclick="deleteGoal('${goal.id}')" style="margin-left:auto">🗑️</button>
          </div>
        </article>
      `;
    },
    "Nenhuma meta criada. Defina seu foco! 🎯"
  );
  renderAchievements();
}

function changeGoal(id, delta) {
  const previous = state.goals.find((goal) => goal.id === id);
  state.goals = state.goals.map((goal) =>
    goal.id === id ? { ...goal, current: Math.max(0, Math.min(goal.target, goal.current + delta)) } : goal
  );
  saveState();
  renderAll();
  const updated = state.goals.find((goal) => goal.id === id);
  if (delta > 0 && previous && updated && previous.current < previous.target && updated.current >= updated.target) {
    celebrate("Meta concluida. Medalha desbloqueada.");
  }
}

function deleteGoal(id) {
  state.goals = state.goals.filter((goal) => goal.id !== id);
  saveState();
  renderAll();
}

function renderAchievements() {
  const done = state.tasks.filter((task) => task.status === "Concluida").length;
  const favorites = state.notes.filter((note) => note.favorite).length;
  const completedGoals = state.goals.filter((goal) => goal.current >= goal.target).length;
  const achievements = [
    { title: "Primeiro check-in", detail: "Concluir uma tarefa", icon: "🏅", unlocked: done >= 1 },
    { title: "Dia produtivo", detail: "Concluir três tarefas", icon: "🔥", unlocked: done >= 3 },
    { title: "Biblioteca viva", detail: "Favoritar uma anotação", icon: "⭐", unlocked: favorites >= 1 },
    { title: "Meta batida", detail: "Completar uma meta", icon: "🎯", unlocked: completedGoals >= 1 },
  ];
  document.querySelector("#achievementCount").textContent = `${achievements.filter((item) => item.unlocked).length}/${achievements.length}`;
  document.querySelector("#achievements").innerHTML = achievements
    .map(
      (item) => `
        <article class="achievement ${item.unlocked ? "unlocked" : ""}">
          <strong>${item.icon} ${item.title}${item.unlocked ? " ✓" : ""}</strong>
          <span class="task-meta">${item.detail}</span>
        </article>
      `
    )
    .join("");
}

function renderList(selector, items, renderer, emptyText) {
  const element = document.querySelector(selector);
  element.innerHTML = items.length ? items.map(renderer).join("") : `<div class="empty-state">${emptyText}</div>`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(`${value}T12:00:00`));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function celebrate(message) {
  showToast(message);
  const burst = document.createElement("div");
  burst.className = "celebration-burst";
  burst.innerHTML = "<span></span><span></span><span></span><span></span><span></span><span></span>";
  document.body.appendChild(burst);
  window.setTimeout(() => burst.remove(), 900);
}

window.editNote = editNote;
window.toggleFavorite = toggleFavorite;
window.convertNoteToTask = convertNoteToTask;
window.deleteNote = deleteNote;
window.dragTask = dragTask;
window.toggleTask = toggleTask;
window.deleteTask = deleteTask;
window.filterEventsByDate = filterEventsByDate;
window.deleteEvent = deleteEvent;
window.changeGoal = changeGoal;
window.deleteGoal = deleteGoal;
