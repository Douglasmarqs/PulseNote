"use strict";

const admin = require("firebase-admin");
const { DEFAULT_FEATURES, normalizeRuntimeConfig, getRuntimeConfig } = require("./adminConfig");
const DEPLOYMENT_OWNER_EMAIL = "douglas1201.santos@gmail.com";

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
    });
  }
  return admin;
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
  const role = await firebase.firestore().collection("adminRoles").doc(user.uid).get();
  if (!listed && role.data()?.enabled !== true) {
    const error = new Error("forbidden");
    error.status = 403;
    throw error;
  }
  return { uid: user.uid, email, firebase, isOwner: email === configuredPrimaryAdminEmail() };
}

async function getUserEntitlements(db, uid) {
  const [entitlement, userStatus] = await Promise.all([
    db.collection("adminEntitlements").doc(uid).get(),
    db.collection("adminUserStatus").doc(uid).get(),
  ]);
  if (userStatus.data()?.disabled === true) {
    return { planId: null, features: {}, status: "disabled" };
  }
  const data = entitlement.data() || {};
  if (!data.planId) return { planId: null, features: {}, status: "unassigned" };
  if (data.status && data.status !== "active") {
    return { planId: data.planId, features: {}, status: data.status };
  }
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  if (data.validUntil && today > data.validUntil) {
    return { planId: data.planId, features: {}, status: "expired" };
  }
  const plan = await db.collection("adminPlans").doc(data.planId).get();
  if (!plan.exists || plan.data()?.active === false) {
    return { planId: data.planId, features: {}, status: "inactive_plan" };
  }
  const storedFeatures = plan.data()?.features || {};
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
  return { planId: data.planId, features, status: "active" };
}

async function checkUserFeature(db, uid, feature) {
  if (!Object.hasOwn(DEFAULT_FEATURES, feature)) throw new Error("unknown_feature");
  const config = await getRuntimeConfig(db);
  if (config.maintenance.enabled) return { allowed: false, reason: "maintenance" };
  if (!config.features[feature]) return { allowed: false, reason: "feature_disabled" };
  const entitlement = await getUserEntitlements(db, uid);
  // Sem plano atribuído, preserva o acesso atual durante a migração.
  if (entitlement.status === "unassigned") return { allowed: true, reason: "legacy_access" };
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
};

