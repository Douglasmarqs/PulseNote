// Single gate for the HTTP endpoint and the WhatsApp command. Admin settings
// and plan entitlements live in server-only Firestore collections.
async function isAdministrativeOperator(db, uid, actor = {}) {
  const { configuredAdminEmails } = require("./admin");
  const email = String(actor.email || "").trim().toLowerCase();
  if (actor.emailVerified === true && email && configuredAdminEmails().has(email)) return true;
  const role = await db.collection("adminRoles").doc(uid).get();
  return role.data()?.enabled === true;
}

async function checkAutopilotAccess(db, uid, actor = {}) {
  const { getRuntimeConfig, assertFeatureEnabled } = require("./adminConfig");
  const { checkUserFeature } = require("./admin");
  const config = await getRuntimeConfig(db);
  assertFeatureEnabled(config, "autopilot");
  const entitlement = await checkUserFeature(db, uid, "autopilot");
  // A conta administrativa precisa conseguir validar o recurso que opera.
  // Isso não contorna manutenção nem a flag global, verificadas acima, e não
  // concede o benefício a usuários comuns fora do plano contratado.
  if (!entitlement.allowed && await isAdministrativeOperator(db, uid, actor)) {
    return { allowed: true, reason: "admin_access" };
  }
  if (!entitlement.allowed) {
    const error = new Error(entitlement.reason || "plan_required");
    error.code = entitlement.reason || "plan_required";
    error.status = entitlement.reason === "maintenance" || entitlement.reason === "feature_disabled" ? 503 : 403;
    throw error;
  }
  return entitlement;
}

module.exports = { checkAutopilotAccess, isAdministrativeOperator };
