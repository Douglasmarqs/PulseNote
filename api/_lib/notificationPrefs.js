// Preferências de notificação escolhidas no onboarding / Configurações.
// Espelha src/notification-prefs.js (o navegador usa módulos ES; as functions
// da Vercel usam CommonJS). Um teste garante que as duas versões concordam.
//
// Categorias (as 4 chaves que a pessoa liga/desliga):
//   tasks        → lembretes de tarefas (com hora, atrasadas) e de metas
//   agenda       → compromissos da agenda
//   spending     → alertas de gastos / orçamento
//   dailySummary → resumo diário da rotina ("Tarefas para hoje")
const NOTIFICATION_PREF_KEYS = ["tasks", "agenda", "spending", "dailySummary"];

function notificationCategory(key) {
  const value = String(key || "");
  if (value === "tasksToday") return "dailySummary";
  if (value.startsWith("task")) return "tasks";
  if (value.startsWith("event")) return "agenda";
  if (value.startsWith("goal")) return "tasks";
  if (value.startsWith("finance")) return "spending";
  return null;
}

// Sem preferência salva (contas antigas) = tudo ligado, como sempre foi.
function isNotificationEnabled(prefs, key) {
  const category = notificationCategory(key);
  if (!category) return true;
  return !(prefs && typeof prefs === "object" && prefs[category] === false);
}

module.exports = { NOTIFICATION_PREF_KEYS, notificationCategory, isNotificationEnabled };
