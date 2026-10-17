// Single gate for the HTTP endpoint and the WhatsApp command. Admin settings
// and plan entitlements live in server-only Firestore collections.
async function checkAutopilotAccess(db, uid) {
  const { getRuntimeConfig, assertFeatureEnabled } = require("./adminConfig");
  const { checkUserFeature } = require("./admin");
  const config = await getRuntimeConfig(db);
  assertFeatureEnabled(config, "autopilot");
  const entitlement = await checkUserFeature(db, uid, "autopilot");
  if (!entitlement.allowed) {
    const error = new Error(entitlement.reason || "plan_required");
    error.code = entitlement.reason || "plan_required";
    error.status = entitlement.reason === "maintenance" || entitlement.reason === "feature_disabled" ? 503 : 403;
    throw error;
  }
  return entitlement;
}

module.exports = { checkAutopilotAccess };
