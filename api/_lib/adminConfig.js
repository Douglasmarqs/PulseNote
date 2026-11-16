"use strict";

const DEFAULT_FEATURES = Object.freeze({
  whatsapp: true,
  aiParsing: true,
  reminders: true,
  autopilot: true,
  mediaRecognition: true,
  whatsappReminders: true,
  pushNotifications: true,
  pdfReports: true,
});

const PLAN_ID_RE = /^[a-z0-9_-]{2,40}$/;
const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function normalizeRuntimeConfig(data = {}) {
  const features = {};
  for (const [key, fallback] of Object.entries(DEFAULT_FEATURES)) {
    features[key] = typeof data.features?.[key] === "boolean" ? data.features[key] : fallback;
  }
  const trialDays = Number(data.trial?.days);
  return {
    features,
    maintenance: {
      enabled: data.maintenance?.enabled === true,
      message: typeof data.maintenance?.message === "string"
        ? data.maintenance.message.slice(0, 240)
        : "O PulseNote está em manutenção. Tente novamente em breve.",
      // Previsão de retorno exibida aos usuários (texto livre curto).
      eta: str(data.maintenance?.eta, 60),
      // Administradores continuam usando o app durante a manutenção.
      allowAdmins: data.maintenance?.allowAdmins !== false,
      startedAt: str(data.maintenance?.startedAt, 40),
    },
    // Quem não tem plano: "full" mantém o acesso completo (lançamento);
    // "plan" aplica os recursos de um plano gratuito escolhido.
    access: {
      noPlan: data.access?.noPlan === "plan" && PLAN_ID_RE.test(String(data.access?.noPlanPlanId || "")) ? "plan" : "full",
      noPlanPlanId: PLAN_ID_RE.test(String(data.access?.noPlanPlanId || "")) ? String(data.access.noPlanPlanId) : "",
    },
    // Teste grátis automático para contas novas.
    trial: {
      enabled: data.trial?.enabled === true && PLAN_ID_RE.test(String(data.trial?.planId || "")),
      planId: PLAN_ID_RE.test(String(data.trial?.planId || "")) ? String(data.trial.planId) : "",
      days: Number.isInteger(trialDays) && trialDays >= 1 && trialDays <= 90 ? trialDays : 7,
      enabledAt: str(data.trial?.enabledAt, 40),
    },
    // Recebimento manual (quando o Stripe não está ativo ou como alternativa).
    payment: {
      pixKey: str(data.payment?.pixKey, 140),
      pixHolder: str(data.payment?.pixHolder, 100),
      instructions: str(data.payment?.instructions, 400),
    },
    supportEmail: typeof data.supportEmail === "string" ? data.supportEmail.slice(0, 180) : "",
  };
}

async function getRuntimeConfig(db) {
  const snapshot = await db.collection("systemConfig").doc("global").get();
  return normalizeRuntimeConfig(snapshot.data());
}

function assertFeatureEnabled(config, feature) {
  if (!Object.hasOwn(DEFAULT_FEATURES, feature)) throw new Error("unknown_feature");
  if (config.maintenance?.enabled) {
    const error = new Error("maintenance");
    error.status = 503;
    error.code = "maintenance";
    throw error;
  }
  if (config.features?.[feature] === false) {
    const error = new Error("feature_disabled");
    error.status = 503;
    error.code = "feature_disabled";
    throw error;
  }
}

module.exports = { DEFAULT_FEATURES, normalizeRuntimeConfig, getRuntimeConfig, assertFeatureEnabled };
