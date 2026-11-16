"use strict";

const { getFirebaseAdmin } = require("./firebaseAdmin");
const { DEFAULT_FEATURES, normalizeRuntimeConfig, getRuntimeConfig } = require("./adminConfig");
const DEPLOYMENT_OWNER_EMAIL = "douglas1201.santos@gmail.com";

function getAdmin() {
  return getFirebaseAdmin();
}

function configuredAdminEmails() {
  return new Set([process.env.PRIMARY_ADMIN_EMAIL || DEPLOYMENT_OWNER_EMAIL, ...(process.env.ADMIN_EMAILS || "").split(",")]
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean));
}

function configuredPrimaryAdminEmail() {
  return (process.env.PRIMARY_ADMIN_EMAIL || (process.env.ADMIN_EMAILS || "").split(",")[0] || DEPLOYMENT_OWNER_EMAIL).trim().toLowerCase();
}

async function requireAdmin(req, firebase = getAdmin()) {
  const authorization = req.headers?.authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    const error = new Error("unauthorized");
    error.status = 401;
    throw error;
  }

  let decoded;
  let user;
  try {
    decoded = await firebase.auth().verifyIdToken(authorization.slice(7), true);
    user = await firebase.auth().getUser(decoded.uid);
  } catch {
    const error = new Error("unauthorized");
    error.status = 401;
    throw error;
  }
  if (user.disabled || !user.emailVerified || !user.email) {
    const error = new Error("forbidden");
    error.status = 403;
    throw error;
  }

  const email = user.email.toLowerCase();
  const listed = configuredAdminEmails().has(email);
  const roleDoc = await firebase.firestore().collection("adminRoles").doc(user.uid).get();
  if (!listed && roleDoc.data()?.enabled !== true) {
    const error = new Error("forbidden");
    error.status = 403;
    throw error;
  }
  const isOwner = email === configuredPrimaryAdminEmail();
  // Hierarquia: dono (variável do servidor) > admins da allowlist > papel salvo.
  const role = isOwner ? "owner" : listed ? "admin" : normalizeRole(roleDoc.data()?.role);
  return { uid: user.uid, email, firebase, isOwner, role, permissions: ROLE_PERMISSIONS[role], authTime: Number(decoded.auth_time) || 0 };
}

// ── Hierarquia administrativa ─────────────────────────────────────
// Cada papel é um conjunto fechado de permissões verificado no servidor
// em toda chamada. A interface apenas esconde o que o papel não pode.
const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze(["view", "users.access", "users.status", "plans.manage", "charges.manage", "config.manage", "admins.manage"]),
  admin: Object.freeze(["view", "users.access", "users.status", "plans.manage", "charges.manage", "config.manage"]),
  finance: Object.freeze(["view", "users.access", "plans.manage", "charges.manage"]),
  support: Object.freeze(["view", "users.access"]),
  viewer: Object.freeze(["view"]),
});
const ROLE_LABELS = Object.freeze({ owner: "Proprietário", admin: "Administrador", finance: "Financeiro", support: "Suporte", viewer: "Leitura" });
const ASSIGNABLE_ROLES = Object.freeze(["admin", "finance", "support", "viewer"]);

function normalizeRole(role) {
  return ASSIGNABLE_ROLES.includes(role) ? role : "admin";
}

function hasPermission(actor, permission) {
  return Boolean(actor && (ROLE_PERMISSIONS[actor.role] || ROLE_PERMISSIONS.admin).includes(permission));
}

function saoPauloToday(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// Sem plano (ou teste encerrado): segue a política definida no painel.
async function noPlanEntitlement(db, config, extra = {}) {
  const policy = config?.access;
  if (policy?.noPlan === "plan" && policy.noPlanPlanId) {
    const plan = await db.collection("adminPlans").doc(policy.noPlanPlanId).get();
    if (plan.exists && plan.data()?.active !== false) {
      return { planId: policy.noPlanPlanId, features: planFeatures(plan.data()), status: "default_plan", ...extra };
    }
  }
  return { planId: null, features: {}, status: "unassigned", ...extra };
}

async function getUserEntitlements(db, uid, { config } = {}) {
  const [entitlement, userStatus] = await Promise.all([
    db.collection("adminEntitlements").doc(uid).get(),
    db.collection("adminUserStatus").doc(uid).get(),
  ]);
  if (userStatus.data()?.disabled === true) {
    return { planId: null, features: {}, status: "disabled" };
  }
  const data = entitlement.data() || {};
  if (!data.planId) return noPlanEntitlement(db, config);
  if (data.status && data.status !== "active") {
    return { planId: data.planId, features: {}, status: data.status };
  }
  const today = saoPauloToday();
  if (data.validUntil && today > data.validUntil) {
    // Teste grátis vencido volta para a regra de quem não tem plano.
    if (data.source === "trial") return noPlanEntitlement(db, config, { trialExpired: true, expiredPlanId: data.planId });
    return { planId: data.planId, features: {}, status: "expired" };
  }
  const plan = await db.collection("adminPlans").doc(data.planId).get();
  if (!plan.exists || plan.data()?.active === false) {
    return { planId: data.planId, features: {}, status: "inactive_plan" };
  }
  return { planId: data.planId, features: planFeatures(plan.data()), status: "active", trial: data.source === "trial", validUntil: data.validUntil || null };
}

function planFeatures(planData) {
  const storedFeatures = planData?.features || {};
  // Planos criados antes da expansão do catálogo não podem perder recursos
  // que já estavam implícitos. Novos planos persistem todas as chaves.
  const features = {
    ...storedFeatures,
    mediaRecognition: typeof storedFeatures.mediaRecognition === "boolean"
      ? storedFeatures.mediaRecognition : storedFeatures.aiParsing === true && storedFeatures.whatsapp === true,
    whatsappReminders: typeof storedFeatures.whatsappReminders === "boolean"
      ? storedFeatures.whatsappReminders : storedFeatures.reminders === true && storedFeatures.whatsapp === true,
    pushNotifications: typeof storedFeatures.pushNotifications === "boolean"
      ? storedFeatures.pushNotifications : storedFeatures.reminders === true,
    pdfReports: typeof storedFeatures.pdfReports === "boolean"
      ? storedFeatures.pdfReports : storedFeatures.whatsapp === true,
  };
  return features;
}

async function checkUserFeature(db, uid, feature) {
  if (!Object.hasOwn(DEFAULT_FEATURES, feature)) throw new Error("unknown_feature");
  const config = await getRuntimeConfig(db);
  if (config.maintenance.enabled) return { allowed: false, reason: "maintenance" };
  if (!config.features[feature]) return { allowed: false, reason: "feature_disabled" };
  const entitlement = await getUserEntitlements(db, uid, { config });
  // Sem plano atribuído, preserva o acesso atual durante a migração.
  if (entitlement.status === "unassigned") return { allowed: true, reason: "legacy_access" };
  if (entitlement.status === "default_plan") return { allowed: entitlement.features[feature] === true, reason: "default_plan" };
  return { allowed: entitlement.status === "active" && entitlement.features[feature] === true,
    reason: entitlement.status === "active" ? "plan" : entitlement.status };
}

module.exports = {
  DEFAULT_FEATURES,
  configuredAdminEmails,
  configuredPrimaryAdminEmail,
  getAdmin,
  requireAdmin,
  normalizeRuntimeConfig,
  getRuntimeConfig,
  getUserEntitlements,
  checkUserFeature,
  planFeatures,
  saoPauloToday,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  ASSIGNABLE_ROLES,
  normalizeRole,
  hasPermission,
};

