// Preferências de notificação (onboarding e Configurações).
// Espelha api/_lib/notificationPrefs.js — manter as duas em sincronia.
export const NOTIFICATION_PREF_KEYS = ["tasks", "agenda", "spending", "dailySummary"];

export function defaultNotificationPrefs() {
  return { tasks: true, agenda: true, spending: true, dailySummary: true };
}

// Aceita qualquer coisa vinda do Firestore/cache e devolve sempre as 4 chaves
// booleanas. Ausente = ligado (contas antigas continuam recebendo tudo).
export function normalizeNotificationPrefs(value) {
  const base = defaultNotificationPrefs();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  for (const key of NOTIFICATION_PREF_KEYS) {
    if (typeof value[key] === "boolean") base[key] = value[key];
  }
  return base;
}

export function notificationCategory(key) {
  const value = String(key || "");
  if (value === "tasksToday") return "dailySummary";
  if (value.startsWith("task")) return "tasks";
  if (value.startsWith("event")) return "agenda";
  if (value.startsWith("goal")) return "tasks";
  if (value.startsWith("finance")) return "spending";
  return null;
}

export function isNotificationEnabled(prefs, key) {
  const category = notificationCategory(key);
  if (!category) return true;
  return !(prefs && typeof prefs === "object" && prefs[category] === false);
}
