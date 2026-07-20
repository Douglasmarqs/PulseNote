// notifications.js — Sistema de notificações do PulseNote
// ============================================================
// Usa a Notification API nativa do navegador (não precisa de backend
// nem de servidor push) para avisar sobre:
//   - Tarefas vencendo hoje ou atrasadas
//   - Compromissos da agenda próximos (respeitando o "lembrete" de cada um)
//   - Metas perto do prazo / quase completas
//   - Resumo financeiro quando o orçamento do mês está acabando
//
// As notificações aparecem na bandeja real do sistema (Android, Windows,
// macOS) quando o usuário concede permissão — funcionam mesmo com o
// PulseNote instalado como app (PWA), igual a um aplicativo nativo.
// ============================================================

const NOTIFIED_KEY_PREFIX = "pn_notified_";

// Evita notificar a mesma coisa duas vezes no mesmo dia
function alreadyNotifiedToday(uniqueId) {
  const key = `${NOTIFIED_KEY_PREFIX}${uniqueId}`;
  const last = localStorage.getItem(key);
  const today = new Date().toDateString();
  if (last === today) return true;
  localStorage.setItem(key, today);
  return false;
}

// Dispara uma notificação do sistema (ou um toast como fallback)
function fireNotification(title, body, tag, onClickView, itemId) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      // Se o Service Worker estiver ativo, usamos ele — isso permite que a
      // notificação continue funcionando mesmo com o app/aba fechada,
      // e aparece de forma mais "nativa" na bandeja do sistema.
      navigator.serviceWorker?.ready.then((registration) => {
        registration.showNotification(title, {
          body,
          tag,                       // evita duplicar notificações com o mesmo "tag"
          icon: "icons/icon-192.png",
          badge: "icons/icon-192.png",
          vibrate: [120, 60, 120],
          data: { view: onClickView || "dashboard", itemId: itemId || null },
          renotify: false,
        }).catch(() => {
          // Fallback simples caso showNotification falhe
          new Notification(title, { body, icon: "icons/icon-192.png" });
        });
      }) || new Notification(title, { body, icon: "icons/icon-192.png" });
    } catch (err) {
      console.warn("Falha ao exibir notificação do sistema:", err);
    }
  }
}

// Pede permissão ao usuário (só deve ser chamado a partir de um clique,
// nunca automaticamente ao carregar a página — navegadores bloqueiam isso)
async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    (window.PulseNoteShowToast || console.log)("Seu navegador não suporta notificações.");
    return false;
  }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") {
    (window.PulseNoteShowToast || console.log)("Notificações bloqueadas. Ative nas configurações do navegador.");
    return false;
  }
  const result = await Notification.requestPermission();
  if (result === "granted") {
    (window.PulseNoteShowToast || console.log)("🔔 Notificações ativadas!");
    localStorage.setItem("pn_notifications_enabled", "1");
    runAllNotificationChecks(); // checa imediatamente após ativar
    return true;
  }
  (window.PulseNoteShowToast || console.log)("Notificações não foram ativadas.");
  return false;
}

function notificationsAreEnabled() {
  return "Notification" in window
    && Notification.permission === "granted"
    && localStorage.getItem("pn_notifications_enabled") === "1";
}

// ── Verificações específicas por área do app ──────────────────

// Tarefas com vencimento hoje ou atrasadas
function checkTaskNotifications() {
  if (!window.PulseNoteState.tasks) return;
  const today = new Date().toISOString().slice(0, 10);

  const overdue = window.PulseNoteState.tasks.filter(
    (t) => t.status !== "Concluida" && t.status !== "Cancelada" && t.dueDate && t.dueDate < today
  );
  const dueToday = window.PulseNoteState.tasks.filter(
    (t) => t.status !== "Concluida" && t.status !== "Cancelada" && t.dueDate === today
  );

  if (overdue.length > 0 && !alreadyNotifiedToday("tasks_overdue")) {
    fireNotification(
      "⏰ Tarefas atrasadas",
      overdue.length === 1
        ? `"${overdue[0].title}" está atrasada.`
        : `Você tem ${overdue.length} tarefas atrasadas.`,
      "tasks-overdue",
      "planner",
      overdue.length === 1 ? overdue[0].id : null
    );
  } else if (dueToday.length > 0 && !alreadyNotifiedToday("tasks_today")) {
    fireNotification(
      "📋 Tarefas para hoje",
      dueToday.length === 1
        ? `"${dueToday[0].title}" vence hoje.`
        : `Você tem ${dueToday.length} tarefas vencendo hoje.`,
      "tasks-today",
      "planner",
      dueToday.length === 1 ? dueToday[0].id : null
    );
  }
}

// Compromissos da agenda — respeita o campo "reminder" (minutos antes) de cada evento
function checkEventNotifications() {
  if (!window.PulseNoteState.events) return;
  const now = new Date();

  window.PulseNoteState.events.forEach((event) => {
    if (!event.date || !event.time) return;
    const eventDateTime = new Date(`${event.date}T${event.time}`);
    const minutesUntil = (eventDateTime - now) / 60000;
    const reminderMinutes = Number(event.reminder) || 15;

    // Dispara quando o evento está dentro da janela de lembrete
    // (ex: lembrete de 15min, e faltam entre 0 e 15 minutos)
    if (minutesUntil > 0 && minutesUntil <= reminderMinutes) {
      const notifyKey = `event_${event.id}`;
      if (!alreadyNotifiedToday(notifyKey)) {
        fireNotification(
          "📅 Compromisso em breve",
          `"${event.title}" às ${event.time}${event.location ? " · " + event.location : ""}`,
          `event-${event.id}`,
          "planner",
          event.id
        );
      }
    }
  });
}

// Metas perto do prazo ou quase completas (incentivo, não cobrança)
function checkGoalNotifications() {
  if (!window.PulseNoteState.goals) return;

  window.PulseNoteState.goals.forEach((goal) => {
    const percent = goal.target > 0 ? (goal.current / goal.target) * 100 : 0;
    if (percent >= 80 && percent < 100 && !alreadyNotifiedToday(`goal_${goal.id}_almost`)) {
      fireNotification(
        "🎯 Quase lá!",
        `"${goal.title}" está ${Math.round(percent)}% completa. Falta pouco!`,
        `goal-${goal.id}`,
        "planner",
        goal.id
      );
    }
  });
}

// Resumo financeiro: avisa quando o usuário já gastou uma fatia grande
// das receitas do mês (ajuda a evitar surpresa no fim do mês)
function checkFinanceNotifications() {
  if (!window.PulseNoteState.finances) return;
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const entries = window.PulseNoteState.finances.filter((f) => f.date.startsWith(currentMonthKey));

  const receitas = entries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const despesas = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
  if (receitas <= 0) return;

  const usedPct = Math.round((despesas / receitas) * 100);

  if (usedPct >= 90 && !alreadyNotifiedToday("finance_budget_critical")) {
    fireNotification(
      "💸 Orçamento no limite",
      `Você já usou ${usedPct}% das receitas deste mês.`,
      "finance-critical",
      "finances"
    );
  } else if (usedPct >= 70 && !alreadyNotifiedToday("finance_budget_warning")) {
    fireNotification(
      "💰 Atenção ao orçamento",
      `Você já usou ${usedPct}% das receitas deste mês.`,
      "finance-warning",
      "finances"
    );
  }
}

// Roda todas as verificações de uma vez
function runAllNotificationChecks() {
  if (!notificationsAreEnabled()) return;
  if (!window.PulseNoteState) return; // app.js ainda não terminou de carregar os dados
  checkTaskNotifications();
  checkEventNotifications();
  checkGoalNotifications();
  checkFinanceNotifications();
}

// Verifica a cada 5 minutos enquanto o app estiver aberto (cobre principalmente
// lembretes de compromissos, que dependem do horário exato)
let notificationInterval = null;
function startNotificationScheduler() {
  if (notificationInterval) return;
  runAllNotificationChecks(); // primeira checagem imediata
  notificationInterval = setInterval(runAllNotificationChecks, 5 * 60 * 1000);
}

window.requestNotificationPermission = requestNotificationPermission;
window.notificationsAreEnabled = notificationsAreEnabled;
window.startNotificationScheduler = startNotificationScheduler;
window.runAllNotificationChecks = runAllNotificationChecks;
