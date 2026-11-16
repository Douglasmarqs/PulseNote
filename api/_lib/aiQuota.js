"use strict";

// Limite diário de conversas com IA (GPT/Claude) por pessoa.
// ------------------------------------------------------------
// - Conta só mensagens que realmente chamam a IA. Cumprimentos ("oi",
//   "bom dia"), ajuda, PDF e comandos respondidos sem IA não contam.
// - Se a IA falhar, a mensagem é devolvida à cota (não paga pelo erro).
// - Sem plano (gratuito): AI_DAILY_LIMIT_FREE (padrão 10).
// - Plano pago: o limite do plano no painel admin; sem valor no plano,
//   AI_DAILY_LIMIT_PAID (padrão 200, uso justo). 0 = sem limite.
// - Administradores não têm limite.
// - Qualquer erro aqui libera a mensagem (nunca derruba o Pulsinho).

const DEFAULT_FREE_LIMIT = 10;
const DEFAULT_PAID_LIMIT = 200;
const MAX_LIMIT = 5000;

function envLimit(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= MAX_LIMIT ? value : fallback;
}

function saoPauloToday(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function normalizePlanLimit(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= MAX_LIMIT ? number : null;
}

// { limit, tier } — limit 0 significa sem limite.
async function resolveAiDailyLimit(db, uid, actor = {}) {
  const free = envLimit("AI_DAILY_LIMIT_FREE", DEFAULT_FREE_LIMIT);
  const paid = envLimit("AI_DAILY_LIMIT_PAID", DEFAULT_PAID_LIMIT);
  const { isAdministrativeOperator } = require("./autopilotAccess");
  if (await isAdministrativeOperator(db, uid, actor)) return { limit: 0, tier: "admin" };

  const { getUserEntitlements } = require("./admin");
  const { getRuntimeConfig } = require("./adminConfig");
  const config = await getRuntimeConfig(db).catch(() => null);
  const entitlement = await getUserEntitlements(db, uid, { config });
  if (!["active", "default_plan"].includes(entitlement.status) || !entitlement.planId) return { limit: free, tier: "free" };

  const plan = (await db.collection("adminPlans").doc(entitlement.planId).get()).data() || {};
  const custom = normalizePlanLimit(plan.aiDailyLimit);
  if (custom !== null) return { limit: custom, tier: Number(plan.priceCents) > 0 ? "paid" : "free", planId: entitlement.planId };
  return Number(plan.priceCents) > 0
    ? { limit: paid, tier: "paid", planId: entitlement.planId }
    : { limit: free, tier: "free", planId: entitlement.planId };
}

function createAiQuota({ db, uid, actor = {}, resolveLimit = resolveAiDailyLimit, today = saoPauloToday } = {}) {
  let consumedDay = "";
  let info = null;
  const ref = () => db.collection("aiUsage").doc(uid);

  async function consume() {
    try {
      if (!db || !uid) return { allowed: true, unlimited: true };
      const { limit, tier } = await resolveLimit(db, uid, actor);
      const day = today();
      if (!limit) {
        info = { allowed: true, unlimited: true, tier, limit: 0 };
        return info;
      }
      info = await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref());
        const data = snapshot.exists ? snapshot.data() || {} : {};
        const used = data.day === day ? Math.max(0, Number(data.count) || 0) : 0;
        if (used >= limit) return { allowed: false, used, limit, remaining: 0, tier };
        tx.set(ref(), { day, count: used + 1, limit, tier, updatedAt: new Date().toISOString() }, { merge: true });
        return { allowed: true, used: used + 1, limit, remaining: limit - used - 1, tier };
      });
      if (info.allowed) consumedDay = day;
      return info;
    } catch (error) {
      console.warn("ai_quota_failed", { stage: "consume", code: error?.code || error?.message || "unknown" });
      info = { allowed: true, unlimited: true, failedOpen: true };
      return info;
    }
  }

  // Devolve a mensagem quando a IA não respondeu (erro não custa cota).
  async function refund() {
    if (!consumedDay) return;
    const day = consumedDay;
    consumedDay = "";
    try {
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref());
        const data = snapshot.exists ? snapshot.data() || {} : {};
        if (data.day !== day) return;
        tx.set(ref(), { day, count: Math.max(0, (Number(data.count) || 0) - 1), updatedAt: new Date().toISOString() }, { merge: true });
      });
      if (info?.used) info = { ...info, used: info.used - 1, remaining: (info.remaining || 0) + 1 };
    } catch (error) {
      console.warn("ai_quota_failed", { stage: "refund", code: error?.code || error?.message || "unknown" });
    }
  }

  return { consume, refund, get info() { return info; } };
}

// Texto para quando a cota do dia acabou.
function aiLimitReply(quota = {}, { channel = "app" } = {}) {
  const limit = Number(quota.limit) || 0;
  const plan = channel === "whatsapp" ? "no app, em Configurações → Plano" : "em Configurações → Plano";
  const upgrade = quota.tier === "free" ? ` Se quiser conversar mais, dá uma olhada nos planos ${plan}.` : "";
  return `Você já usou as ${limit} conversas com IA de hoje 😊 A conversa livre volta amanhã. Enquanto isso, comandos diretos continuam funcionando: “gastei 30 no mercado”, “me lembra de pagar a luz amanhã às 9h”, “minhas tarefas”.${upgrade}`;
}

// Aviso discreto quando restam poucas conversas no dia.
// No WhatsApp sai em itálico; no app, texto simples.
function aiQuotaNotice(quota, { channel = "whatsapp" } = {}) {
  if (!quota || quota.unlimited || !quota.allowed || !quota.limit) return "";
  const wrap = (text) => (channel === "whatsapp" ? `_${text}_` : text);
  if (quota.remaining === 0) return wrap("Essa foi sua última conversa com IA de hoje. Amanhã tem mais.");
  if (quota.remaining <= 2) return wrap(`Restam ${quota.remaining} conversa${quota.remaining > 1 ? "s" : ""} com IA hoje.`);
  return "";
}

module.exports = {
  createAiQuota,
  resolveAiDailyLimit,
  aiLimitReply,
  aiQuotaNotice,
  saoPauloToday,
  normalizePlanLimit,
  DEFAULT_FREE_LIMIT,
  DEFAULT_PAID_LIMIT,
};
