"use strict";

const DEFAULT_FEATURES = Object.freeze({
  whatsapp: true,
  aiParsing: true,
  reminders: true,
  autopilot: true,
});

function normalizeRuntimeConfig(data = {}) {
  const features = {};
  for (const [key, fallback] of Object.entries(DEFAULT_FEATURES)) {
    features[key] = typeof data.features?.[key] === "boolean" ? data.features[key] : fallback;
  }
  return {
    features,
    maintenance: {
      enabled: data.maintenance?.enabled === true,
      message: typeof data.maintenance?.message === "string"
        ? data.maintenance.message.slice(0, 240)
        : "O PulseNote está em manutenção. Tente novamente em breve.",
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
