"use strict";

const crypto = require("node:crypto");
const { getAdmin, requireAdmin, configuredAdminEmails, configuredPrimaryAdminEmail } = require("./_lib/admin");
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

function timestampValue(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summarizeUserState(snapshot) {
  const document = snapshot?.exists ? snapshot.data() || {} : {};
  const state = document.data || {};
  const count = (key) => Array.isArray(state[key]) ? state[key].length : 0;
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const events = Array.isArray(state.events) ? state.events : [];
  const goals = Array.isArray(state.goals) ? state.goals : [];
  const reminderItems = [...tasks, ...events, ...goals].filter((item) => item?.reminder !== undefined && item?.reminder !== null && item.reminder !== false && item.reminder !== "none");
  const tokens = Array.isArray(state.fcmTokens) ? state.fcmTokens.filter(Boolean) : [];
  return {
    lastDataUpdateAt: timestampValue(document.updatedAt),
    timeZone: text(state.timeZone, 80) || "America/Sao_Paulo",
    whatsappLinked: Boolean(state.whatsappLinkedPhone),
    whatsappReminderEnabled: state.whatsappReminderOptIn === true && Boolean(state.whatsappLinkedPhone),
    pushEnabled: state.appReminderOptIn !== false && tokens.length > 0,
    activity: {
      tasks: count("tasks"),
      notes: count("notes"),
      events: count("events"),
      goals: count("goals"),
      finances: count("finances"),
      reminderItems: reminderItems.length,
    },
  };
}

function summarizeUsage(snapshot) {
  const usage = snapshot?.exists ? snapshot.data() || {} : {};
  return {
    lastActiveAt: timestampValue(usage.lastSeenAt),
    lastArea: text(usage.lastArea, 40),
    totalViews: Number(usage.totalViews) || 0,
    areaCounts: usage.areaCounts && typeof usage.areaCounts === "object" ? usage.areaCounts : {},
  };
}

function aggregateUsage(snapshot) {
  const areaCounts = {};
  const transitions = {};
  let trackedUsers = 0;
  for (const entry of snapshot.docs) {
    const usage = entry.data() || {};
    if (usage.lastSeenAt) trackedUsers++;
    for (const [area, count] of Object.entries(usage.areaCounts || {})) areaCounts[area] = (areaCounts[area] || 0) + (Number(count) || 0);
    for (const [transition, count] of Object.entries(usage.transitions || {})) transitions[transition] = (transitions[transition] || 0) + (Number(count) || 0);
  }
  const ranked = (values, limit) => Object.entries(values).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, limit);
  return { trackedUsers, topAreas: ranked(areaCounts, 7), topTransitions: ranked(transitions, 6) };
}

async function authUserActivity(firebase, days = 30) {
  const users = [];
  let cursor;
  do {
    const page = await firebase.auth().listUsers(1000, cursor);
    users.push(...page.users);
    cursor = page.pageToken;
  } while (cursor);
  const today = new Date();
  const start = new Date(today.getTime() - (days - 1) * 86400000);
  start.setUTCHours(0, 0, 0, 0);
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    return { date: date.toISOString().slice(0, 10), users: 0 };
  });
  const byDate = new Map(buckets.map((entry) => [entry.date, entry]));
  let active30d = 0;
  for (const user of users) {
    const last = timestampValue(user.metadata?.lastSignInTime);
    if (!last || new Date(last) < start) continue;
    active30d++;
    const bucket = byDate.get(last.slice(0, 10));
    if (bucket) bucket.users++;
  }
  return { total: users.length, active30d, lastAccessByDay: buckets };
}

async function dashboard(firebase, db) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [authActivity, userData, usage, whatsapp, reminders, activeSubscriptions, recentCharges, recentAudit, integrations] = await Promise.all([
    authUserActivity(firebase),
    db.collection("userData").limit(2000).get(),
    db.collection("adminUsage").limit(2000).get(),
    db.collection("whatsappProcessedMessages").where("processedAt", ">=", since).count().get().then(countValue),
    db.collection("reminderDeliveries").where("acceptedAt", ">=", since).count().get().then(countValue),
    db.collection("adminEntitlements").where("status", "==", "active").count().get().then(countValue),
    db.collection("adminCharges").where("createdAt", ">=", since).limit(500).get(),
    db.collection("adminAudit").orderBy("at", "desc").limit(6).get(),
    integrationStatus(db),
  ]);
  const revenueCents30d = recentCharges.docs.reduce((total, entry) => {
    const charge = entry.data();
    return charge.status === "manual_received" || charge.status === "paid" ? total + (Number(charge.amountCents) || 0) : total;
  }, 0);
  const integrationsHealthy = integrations.integrations.filter((item) => item.configured).length;
  const accountSignals = userData.docs.map((entry) => summarizeUserState(entry));
  const usersWithSavedChanges30d = accountSignals.filter((item) => item.lastDataUpdateAt && item.lastDataUpdateAt >= since).length;
  const journey = {
    accounts: authActivity.total,
    savedData: accountSignals.filter((item) => Object.values(item.activity).some((value) => value > 0)).length,
    whatsappLinked: accountSignals.filter((item) => item.whatsappLinked).length,
    remindersConfigured: accountSignals.filter((item) => item.whatsappReminderEnabled || item.pushEnabled || item.activity.reminderItems > 0).length,
    planAssigned: activeSubscriptions,
  };
  return {
    periodDays: 30,
    metrics: { users: authActivity.total, activeUsers30d: authActivity.active30d, activeSubscriptions, revenueCents30d,
      integrationsHealthy, integrationsTotal: integrations.integrations.length,
      usersWithSavedChanges30d, whatsappReceived30d: whatsapp, reminderDeliveriesAccepted30d: reminders },
    lastAccessByDay: authActivity.lastAccessByDay,
    journey,
    usageFlow: aggregateUsage(usage),
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
  users.sort((a, b) => new Date(b.metadata?.lastSignInTime || 0) - new Date(a.metadata?.lastSignInTime || 0));
  const details = await Promise.all(users.map((user) => Promise.all([
    db.collection("adminEntitlements").doc(user.uid).get(),
    db.collection("userData").doc(user.uid).get(),
    db.collection("adminUsage").doc(user.uid).get(),
  ])));
  return {
    users: users.map((user, index) => ({
      uid: user.uid,
      email: user.email || "",
      displayName: user.displayName || "",
      disabled: user.disabled,
      emailVerified: user.emailVerified,
      createdAt: user.metadata.creationTime || null,
      lastSignInAt: user.metadata.lastSignInTime || null,
      planId: details[index][0].data()?.planId || null,
      subscriptionStatus: details[index][0].data()?.status || (details[index][0].data()?.planId ? "active" : "unassigned"),
      validUntil: details[index][0].data()?.validUntil || null,
      ...summarizeUserState(details[index][1]),
      ...summarizeUsage(details[index][2]),
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

async function listAdmins(firebase, db, actor) {
  const primaryEmail = configuredPrimaryAdminEmail();
  const configured = [...configuredAdminEmails()];
  const roles = await db.collection("adminRoles").where("enabled", "==", true).limit(100).get();
  const byUid = new Map();
  for (const email of configured) {
    try {
      const user = await firebase.auth().getUserByEmail(email);
      byUid.set(user.uid, { uid: user.uid, email: user.email || email, displayName: user.displayName || "", owner: email === primaryEmail, source: "environment" });
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  await Promise.all(roles.docs.map(async (entry) => {
    if (byUid.has(entry.id)) return;
    try {
      const user = await firebase.auth().getUser(entry.id);
      byUid.set(user.uid, { uid: user.uid, email: user.email || "", displayName: user.displayName || "", owner: (user.email || "").toLowerCase() === primaryEmail, source: "firestore" });
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }));
  return { admins: [...byUid.values()].sort((a, b) => Number(b.owner) - Number(a.owner) || a.email.localeCompare(b.email)), isOwner: actor.isOwner === true };
}

async function setAdminRole(firebase, db, actor, body) {
  if (!actor.isOwner) fail(403, "owner_required");
  if (typeof body.enabled !== "boolean") fail(400, "invalid_admin_role");
  let user;
  if (body.enabled) {
    const email = text(body.email, 200).toLowerCase();
    if (!email) fail(400, "email_required");
    user = await firebase.auth().getUserByEmail(email);
    if (!user.emailVerified) fail(400, "verified_email_required");
  } else {
    const uid = text(body.uid, 128);
    if (!uid) fail(400, "uid_required");
    user = await firebase.auth().getUser(uid);
  }
  const email = (user.email || "").toLowerCase();
  if (email === configuredPrimaryAdminEmail() || user.uid === actor.uid) fail(403, "cannot_change_owner");
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(db.collection("adminRoles").doc(user.uid), { enabled: body.enabled, email, updatedAt: now, updatedBy: actor.uid }, { merge: true });
  batch.set(db.collection("adminAudit").doc(), { at: now, actorUid: actor.uid, actorEmail: actor.email,
    action: body.enabled ? "admin_access_granted" : "admin_access_revoked", target: user.uid, details: { email } });
  await batch.commit();
  if (!body.enabled) await firebase.auth().revokeRefreshTokens(user.uid);
  return { uid: user.uid, email, enabled: body.enabled };
}

async function integrationStatus(db) {
  const configured = (names) => names.every((name) => Boolean(process.env[name]));
  const [webhookEvents, reminderHealth, reminderDeliverySnapshot] = await Promise.all([
    db.collection("whatsappProcessedMessages").orderBy("updatedAt", "desc").limit(25).get(),
    db.collection("systemHealth").doc("reminders").get(),
    db.collection("reminderDeliveries").orderBy("updatedAt", "desc").limit(25).get(),
  ]);
  const events = webhookEvents.docs.map((entry) => entry.data());
  const failedEvents = events.filter((entry) => entry.status === "failed").length;
  const lastInboundAt = events[0]?.updatedAt || null;
  const reminders = reminderHealth.data() || {};
  const reminderDeliveries = reminderDeliverySnapshot.docs.map((entry) => {
    const delivery = entry.data() || {};
    const channel = ["push", "whatsapp"].includes(delivery.channel) ? delivery.channel : "unknown";
    const status = ["processing", "accepted", "failed"].includes(delivery.status)
      ? delivery.status
      : delivery.acceptedAt ? "accepted" : delivery.lastError ? "failed" : "unknown";
    return {
      id: String(entry.id || "").slice(0, 10),
      uid: text(delivery.uid, 128),
      channel,
      notificationKey: text(delivery.notificationKey, 120) || "legacy",
      status,
      attemptedAt: timestampValue(delivery.updatedAt || delivery.acceptedAt),
      acceptedAt: timestampValue(delivery.acceptedAt),
      error: status === "failed" ? text(delivery.lastError, 160) || "provider_error" : null,
    };
  });
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
      { id: "stripe", label: "Stripe Billing", configured: configured(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]),
        detail: configured(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])
          ? "Credenciais e assinatura de webhook presentes no servidor"
          : "Defina STRIPE_SECRET_KEY e STRIPE_WEBHOOK_SECRET na Vercel para ativar cobranças automáticas" },
    ],
    reminderDeliveries,
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
  // Não expor uma configuração de suporte sem consumidor real no produto.
  const config = normalizeRuntimeConfig({ features, maintenance: { enabled: body.maintenance.enabled, message } });
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
  // Auth and Firestore cannot commit atomically. Disable the server-side gate
  // first; on reactivation, clear it only after Auth accepts the change. A
  // partial failure must leave the account blocked, not restore API access.
  const statusRef = db.collection("adminUserStatus").doc(uid);
  const status = {
    disabled: body.disabled,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.uid,
  };
  if (body.disabled) {
    await statusRef.set(status);
    await firebase.auth().updateUser(uid, { disabled: true });
    await firebase.auth().revokeRefreshTokens(uid);
  } else {
    await firebase.auth().updateUser(uid, { disabled: false });
    await statusRef.set(status);
  }
  await logAction(db, actor, body.disabled ? "user_disabled" : "user_enabled", uid);
  return { uid, disabled: body.disabled };
}

async function savePlan(db, actor, body) {
  const id = text(body.id, 40).toLowerCase();
  const name = text(body.name, 80);
  if (!/^[a-z0-9_-]{2,40}$/.test(id) || !name || typeof body.active !== "boolean") fail(400, "invalid_plan");
  const features = validateFeatureMap(body.features);
  const priceCents = Number(body.priceCents || 0);
  const billingInterval = body.billingInterval || "month";
  const stripePriceId = text(body.stripePriceId, 128);
  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 100_000_000
    || !["month", "year"].includes(billingInterval)
    || (stripePriceId && !/^price_[A-Za-z0-9]+$/.test(stripePriceId))) fail(400, "invalid_plan_billing");
  const plan = { name, description: text(body.description, 300), active: body.active, features,
    priceCents, currency: "BRL", billingInterval, stripePriceId: stripePriceId || null,
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
  const planId = text(body.planId, 40).toLowerCase();
  // Ausência de plano significa acesso legado a todos os recursos. Remover um
  // plano aqui poderia reabrir o acesso de uma assinatura pausada/cancelada.
  if (!uid || !/^[a-z0-9_-]{2,40}$/.test(planId)) fail(400, "plan_required");
  const status = body.status === undefined ? "active" : body.status;
  const validUntil = body.validUntil ? text(body.validUntil, 10) : null;
  if (!["active", "paused", "cancelled"].includes(status)
    || (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil))) fail(400, "invalid_entitlement");
  await firebase.auth().getUser(uid);
  const plan = await db.collection("adminPlans").doc(planId).get();
  if (!plan.exists || plan.data().active === false) fail(400, "plan_unavailable");
  const batch = db.batch();
  const ref = db.collection("adminEntitlements").doc(uid);
  batch.set(ref, { planId, status, validUntil, source: "manual", updatedAt: new Date().toISOString(), updatedBy: actor.uid });
  batch.set(db.collection("adminAudit").doc(), { at: new Date().toISOString(), actorUid: actor.uid,
    actorEmail: actor.email, action: "entitlement_set", target: uid, details: { planId, status, validUntil } });
  await batch.commit();
  return { uid, planId, status, validUntil };
}

async function createCharge(firebase, db, actor, body) {
  const uid = text(body.uid, 128);
  const amountCents = Number(body.amountCents);
  const dueDate = text(body.dueDate, 10);
  const requestId = text(body.requestId, 64);
  if (!uid || !Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000
    || (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
    || (requestId && !/^[a-f0-9-]{36}$/i.test(requestId))) fail(400, "invalid_charge");
  await firebase.auth().getUser(uid);
  // The browser reuses the same request ID after an ambiguous network failure.
  // A deterministic document ID keeps a retry from creating another charge.
  const id = requestId
    ? crypto.createHash("sha256").update(`${actor.uid}:${requestId}`).digest("hex")
    : crypto.randomUUID();
  const charge = { uid, amountCents, currency: "BRL", dueDate: dueDate || null,
    note: text(body.note, 300), status: "manual_pending", source: "manual",
    createdAt: new Date().toISOString(), createdBy: actor.uid,
    ...(requestId ? { requestId } : {}) };
  const ref = db.collection("adminCharges").doc(id);
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      const previous = existing.data();
      if (!requestId || previous.requestId !== requestId || previous.createdBy !== actor.uid
        || previous.uid !== charge.uid || previous.amountCents !== charge.amountCents
        || previous.dueDate !== charge.dueDate || previous.note !== charge.note) fail(409, "charge_request_conflict");
      return { charge: { id, ...previous }, alreadyCreated: true };
    }
    tx.create(ref, charge);
    tx.create(db.collection("adminAudit").doc(), { at: new Date().toISOString(), actorUid: actor.uid,
      actorEmail: actor.email, action: "manual_charge_created", target: id,
      details: { uid, amountCents, status: charge.status } });
    return { charge: { id, ...charge }, alreadyCreated: false };
  });
}

async function updateCharge(db, actor, body) {
  const id = text(body.id, 128);
  const status = body.status;
  if (!id || !["manual_pending", "manual_received", "manual_cancelled"].includes(status)) fail(400, "invalid_charge_update");
  const ref = db.collection("adminCharges").doc(id);
  return db.runTransaction(async (tx) => {
    const previous = await tx.get(ref);
    if (!previous.exists || previous.data().source !== "manual") fail(404, "charge_not_found");
    if (previous.data().status !== "manual_pending") fail(409, "charge_already_finalized");
    tx.update(ref, { status, updatedAt: new Date().toISOString(), updatedBy: actor.uid });
    tx.create(db.collection("adminAudit").doc(), { at: new Date().toISOString(), actorUid: actor.uid,
      actorEmail: actor.email, action: "manual_charge_updated", target: id, details: { status } });
    return { id, status };
  });
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
      if (action === "me") result = { isAdmin: true, isOwner: actor.isOwner === true, uid: actor.uid, email: actor.email };
      else if (action === "dashboard") result = await dashboard(firebase, db);
      else if (action === "users") result = await listUsers(firebase, db, req.query || {});
      else if (action === "plans") result = await listPlans(db);
      else if (action === "subscriptions") result = await listSubscriptions(db);
      else if (action === "charges") result = await listCharges(db);
      else if (action === "features" || action === "settings") result = { config: await getRuntimeConfig(db) };
      else if (action === "integrations") result = await integrationStatus(db);
      else if (action === "audit") result = await listAudit(db);
      else if (action === "admins") result = await listAdmins(firebase, db, actor);
      else fail(404, "unknown_action");
    } else {
      const body = req.body || {};
      if (action === "config-update") result = await updateConfig(db, actor, body);
      else if (action === "user-update") result = await updateUser(firebase, db, actor, body);
      else if (action === "plan-save") result = await savePlan(db, actor, body);
      else if (action === "entitlement-set") result = await setEntitlement(firebase, db, actor, body);
      else if (action === "charge-create") result = await createCharge(firebase, db, actor, body);
      else if (action === "charge-update") result = await updateCharge(db, actor, body);
      else if (action === "admin-role-set") result = await setAdminRole(firebase, db, actor, body);
      else fail(404, "unknown_action");
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error.status) || (error.code === "auth/user-not-found" ? 404 : 500);
    if (status >= 500) console.error("Falha no painel administrativo:", error);
    return res.status(status).json({ error: status >= 500 ? "internal_error" : (error.code || error.message) });
  }
};

module.exports._test = { validateFeatureMap, integrationStatus, countAuthUsers, authUserActivity, summarizeUserState, summarizeUsage, aggregateUsage,
  dashboard, listUsers, listAdmins, updateConfig, updateUser, setEntitlement, createCharge, updateCharge, setAdminRole };
