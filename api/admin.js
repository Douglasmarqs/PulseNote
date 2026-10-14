"use strict";

const crypto = require("node:crypto");
const { getAdmin, requireAdmin, configuredAdminEmails } = require("./_lib/admin");
const { DEFAULT_FEATURES, getRuntimeConfig, normalizeRuntimeConfig } = require("./_lib/adminConfig");

function fail(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  throw error;
}

function text(value, max = 180) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function countValue(snapshot) {
  return snapshot.data().count;
}

async function logAction(db, actor, action, target = "", details = {}) {
  await db.collection("adminAudit").add({
    at: new Date().toISOString(),
    actorUid: actor.uid,
    actorEmail: actor.email,
    action,
    target,
    details,
  });
}

async function countAuthUsers(firebase) {
  let total = 0;
  let cursor;
  do {
    const page = await firebase.auth().listUsers(1000, cursor);
    total += page.users.length;
    cursor = page.pageToken;
  } while (cursor);
  return total;
}

async function dashboard(firebase, db) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [users, recentUsers, whatsapp, reminders, recentAudit] = await Promise.all([
    countAuthUsers(firebase),
    db.collection("userData").where("updatedAt", ">=", since).count().get().then(countValue),
    db.collection("whatsappProcessedMessages").where("processedAt", ">=", since).count().get().then(countValue),
    db.collection("reminderDeliveries").where("acceptedAt", ">=", since).count().get().then(countValue),
    db.collection("adminAudit").orderBy("at", "desc").limit(6).get(),
  ]);
  return {
    periodDays: 30,
    metrics: { users, usersWithSavedChanges30d: recentUsers, whatsappReceived30d: whatsapp, reminderDeliveriesAccepted30d: reminders },
    recentAudit: recentAudit.docs.map((entry) => ({ id: entry.id, ...entry.data() })),
  };
}

async function listUsers(firebase, db, query) {
  const limit = Math.max(1, Math.min(50, Number(query.limit) || 20));
  const email = text(query.email, 200).toLowerCase();
  let users;
  let nextPageToken = null;
  if (email) {
    try { users = [await firebase.auth().getUserByEmail(email)]; }
    catch (error) {
      if (error.code === "auth/user-not-found") users = [];
      else throw error;
    }
  } else {
    const page = await firebase.auth().listUsers(limit, text(query.pageToken, 1500) || undefined);
    users = page.users;
    nextPageToken = page.pageToken || null;
  }
  const profiles = await Promise.all(users.map((user) => db.collection("adminEntitlements").doc(user.uid).get()));
  return {
    users: users.map((user, index) => ({
      uid: user.uid,
      email: user.email || "",
      displayName: user.displayName || "",
      disabled: user.disabled,
      emailVerified: user.emailVerified,
      createdAt: user.metadata.creationTime || null,
      lastSignInAt: user.metadata.lastSignInTime || null,
      planId: profiles[index].data()?.planId || null,
      subscriptionStatus: profiles[index].data()?.status || (profiles[index].data()?.planId ? "active" : "unassigned"),
      validUntil: profiles[index].data()?.validUntil || null,
    })),
    nextPageToken,
  };
}

async function listPlans(db) {
  const snapshot = await db.collection("adminPlans").orderBy("name").limit(100).get();
  return { plans: snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })) };
}

async function listCharges(db) {
  const snapshot = await db.collection("adminCharges").orderBy("createdAt", "desc").limit(100).get();
  return { charges: snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })), mode: "manual_only" };
}

async function listSubscriptions(db) {
  const snapshot = await db.collection("adminEntitlements").orderBy("updatedAt", "desc").limit(100).get();
  return { subscriptions: snapshot.docs.map((entry) => ({ uid: entry.id, ...entry.data() })), mode: "manual_only" };
}

async function listAudit(db) {
  const snapshot = await db.collection("adminAudit").orderBy("at", "desc").limit(100).get();
  return { events: snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })) };
}

async function integrationStatus(db) {
  const configured = (names) => names.every((name) => Boolean(process.env[name]));
  const [webhookEvents, reminderHealth] = await Promise.all([
    db.collection("whatsappProcessedMessages").orderBy("updatedAt", "desc").limit(25).get(),
    db.collection("systemHealth").doc("reminders").get(),
  ]);
  const events = webhookEvents.docs.map((entry) => entry.data());
  const failedEvents = events.filter((entry) => entry.status === "failed").length;
  const lastInboundAt = events[0]?.updatedAt || null;
  const reminders = reminderHealth.data() || {};
  return {
    integrations: [
      { id: "firebase", label: "Firebase", configured: configured(["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]), detail: "Credenciais do servidor" },
      { id: "whatsapp", label: "WhatsApp", configured: configured(["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET"]),
        detail: `Webhook: ${lastInboundAt ? `último evento ${lastInboundAt}` : "sem evento registrado"}; ${failedEvents} falha(s) nos últimos ${events.length} eventos`,
        lastEventAt: lastInboundAt, recentFailures: failedEvents },
      { id: "gemini", label: "Gemini", configured: configured(["GEMINI_API_KEY"]), detail: "Interpretação de texto" },
      { id: "qstash", label: "QStash / lembretes", configured: configured(["QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "QSTASH_DESTINATION_URL"]),
        detail: `Última execução: ${reminders.lastRunAt || "nenhuma"}; estado: ${reminders.status || "desconhecido"}`,
        lastRunAt: reminders.lastRunAt || null, runStatus: reminders.status || "unknown" },
    ],
    note: "Os eventos e a execução são registros reais do servidor. 'Configurado' confirma só a presença de credenciais; a entrega final depende do provedor.",
  };
}

function validateFeatureMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "invalid_features");
  const features = {};
  for (const key of Object.keys(DEFAULT_FEATURES)) {
    if (typeof input[key] !== "boolean") fail(400, "invalid_features");
    features[key] = input[key];
  }
  if (Object.keys(input).some((key) => !Object.hasOwn(DEFAULT_FEATURES, key))) fail(400, "invalid_features");
  return features;
}

async function updateConfig(db, actor, body) {
  const features = validateFeatureMap(body.features);
  if (typeof body.maintenance?.enabled !== "boolean") fail(400, "invalid_maintenance");
  const message = text(body.maintenance.message, 240);
  const supportEmail = text(body.supportEmail, 180);
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) fail(400, "invalid_support_email");
  const config = normalizeRuntimeConfig({ features, maintenance: { enabled: body.maintenance.enabled, message }, supportEmail });
  const batch = db.batch();
  batch.set(db.collection("systemConfig").doc("global"), { ...config, updatedAt: new Date().toISOString(), updatedBy: actor.uid });
  batch.set(db.collection("adminAudit").doc(), {
    at: new Date().toISOString(), actorUid: actor.uid, actorEmail: actor.email,
    action: "config_updated", target: "global", details: { features, maintenanceEnabled: config.maintenance.enabled },
  });
  await batch.commit();
  return { config };
}

async function updateUser(firebase, db, actor, body) {
  const uid = text(body.uid, 128);
  if (!uid || typeof body.disabled !== "boolean") fail(400, "invalid_user_update");
  if (uid === actor.uid) fail(403, "cannot_disable_self");
  const user = await firebase.auth().getUser(uid);
  const role = await db.collection("adminRoles").doc(uid).get();
  if (body.disabled && (role.data()?.enabled === true || configuredAdminEmails().has((user.email || "").toLowerCase()))) {
    fail(403, "cannot_disable_admin");
  }
  // Server-only marker gates WhatsApp, reminders and client Firestore writes
  // immediately. Firebase Auth's disabled flag alone can leave an existing
  // ID token usable until it expires.
  await db.collection("adminUserStatus").doc(uid).set({
    disabled: body.disabled,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.uid,
  });
  await firebase.auth().updateUser(uid, { disabled: body.disabled });
  if (body.disabled) await firebase.auth().revokeRefreshTokens(uid);
  await logAction(db, actor, body.disabled ? "user_disabled" : "user_enabled", uid);
  return { uid, disabled: body.disabled };
}

async function savePlan(db, actor, body) {
  const id = text(body.id, 40).toLowerCase();
  const name = text(body.name, 80);
  if (!/^[a-z0-9_-]{2,40}$/.test(id) || !name || typeof body.active !== "boolean") fail(400, "invalid_plan");
  const features = validateFeatureMap(body.features);
  const plan = { name, description: text(body.description, 300), active: body.active, features,
    updatedAt: new Date().toISOString(), updatedBy: actor.uid };
  const batch = db.batch();
  batch.set(db.collection("adminPlans").doc(id), plan, { merge: true });
  batch.set(db.collection("adminAudit").doc(), { at: new Date().toISOString(), actorUid: actor.uid,
    actorEmail: actor.email, action: "plan_saved", target: id, details: { active: plan.active, features } });
  await batch.commit();
  return { plan: { id, ...plan } };
}

async function setEntitlement(firebase, db, actor, body) {
  const uid = text(body.uid, 128);
  const planId = body.planId === null ? null : text(body.planId, 40).toLowerCase();
  if (!uid || (planId !== null && !/^[a-z0-9_-]{2,40}$/.test(planId))) fail(400, "invalid_entitlement");
  const status = body.status === undefined ? "active" : body.status;
  const validUntil = body.validUntil ? text(body.validUntil, 10) : null;
  if (planId && (!["active", "paused", "cancelled"].includes(status)
    || (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)))) fail(400, "invalid_entitlement");
  await firebase.auth().getUser(uid);
  if (planId) {
    const plan = await db.collection("adminPlans").doc(planId).get();
    if (!plan.exists || plan.data().active === false) fail(400, "plan_unavailable");
  }
  const batch = db.batch();
  const ref = db.collection("adminEntitlements").doc(uid);
  if (planId) batch.set(ref, { planId, status, validUntil, source: "manual", updatedAt: new Date().toISOString(), updatedBy: actor.uid });
  else batch.delete(ref);
  batch.set(db.collection("adminAudit").doc(), { at: new Date().toISOString(), actorUid: actor.uid,
    actorEmail: actor.email, action: "entitlement_set", target: uid, details: { planId, status: planId ? status : "unassigned", validUntil } });
  await batch.commit();
  return { uid, planId, status: planId ? status : "unassigned", validUntil };
}

async function createCharge(firebase, db, actor, body) {
  const uid = text(body.uid, 128);
  const amountCents = Number(body.amountCents);
  const dueDate = text(body.dueDate, 10);
  if (!uid || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000
    || (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))) fail(400, "invalid_charge");
  await firebase.auth().getUser(uid);
  const id = crypto.randomUUID();
  const charge = { uid, amountCents, currency: "BRL", dueDate: dueDate || null,
    note: text(body.note, 300), status: "manual_pending", source: "manual",
    createdAt: new Date().toISOString(), createdBy: actor.uid };
  const batch = db.batch();
  batch.set(db.collection("adminCharges").doc(id), charge);
  batch.set(db.collection("adminAudit").doc(), { at: new Date().toISOString(), actorUid: actor.uid,
    actorEmail: actor.email, action: "manual_charge_created", target: id,
    details: { uid, amountCents, status: charge.status } });
  await batch.commit();
  return { charge: { id, ...charge } };
}

async function updateCharge(db, actor, body) {
  const id = text(body.id, 128);
  const status = body.status;
  if (!id || !["manual_pending", "manual_received", "manual_cancelled"].includes(status)) fail(400, "invalid_charge_update");
  const ref = db.collection("adminCharges").doc(id);
  const previous = await ref.get();
  if (!previous.exists || previous.data().source !== "manual") fail(404, "charge_not_found");
  const batch = db.batch();
  batch.update(ref, { status, updatedAt: new Date().toISOString(), updatedBy: actor.uid });
  batch.set(db.collection("adminAudit").doc(), { at: new Date().toISOString(), actorUid: actor.uid,
    actorEmail: actor.email, action: "manual_charge_updated", target: id, details: { status } });
  await batch.commit();
  return { id, status };
}

module.exports = async function adminApi(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "method_not_allowed" });
  try {
    const firebase = getAdmin();
    const actor = await requireAdmin(req, firebase);
    const db = firebase.firestore();
    const action = String(req.query?.action || "dashboard");
    let result;
    if (req.method === "GET") {
      if (action === "me") result = { isAdmin: true, uid: actor.uid, email: actor.email };
      else if (action === "dashboard") result = await dashboard(firebase, db);
      else if (action === "users") result = await listUsers(firebase, db, req.query || {});
      else if (action === "plans") result = await listPlans(db);
      else if (action === "subscriptions") result = await listSubscriptions(db);
      else if (action === "charges") result = await listCharges(db);
      else if (action === "features" || action === "settings") result = { config: await getRuntimeConfig(db) };
      else if (action === "integrations") result = await integrationStatus(db);
      else if (action === "audit") result = await listAudit(db);
      else fail(404, "unknown_action");
    } else {
      const body = req.body || {};
      if (action === "config-update") result = await updateConfig(db, actor, body);
      else if (action === "user-update") result = await updateUser(firebase, db, actor, body);
      else if (action === "plan-save") result = await savePlan(db, actor, body);
      else if (action === "entitlement-set") result = await setEntitlement(firebase, db, actor, body);
      else if (action === "charge-create") result = await createCharge(firebase, db, actor, body);
      else if (action === "charge-update") result = await updateCharge(db, actor, body);
      else fail(404, "unknown_action");
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error.status) || (error.code === "auth/user-not-found" ? 404 : 500);
    if (status >= 500) console.error("Falha no painel administrativo:", error);
    return res.status(status).json({ error: status >= 500 ? "internal_error" : (error.code || error.message) });
  }
};

module.exports._test = { validateFeatureMap, integrationStatus, countAuthUsers, dashboard, listUsers, updateConfig };
