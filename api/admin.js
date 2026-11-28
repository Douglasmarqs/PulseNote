"use strict";

const crypto = require("node:crypto");
const { getAdmin, requireAdmin, configuredAdminEmails, configuredPrimaryAdminEmail, hasPermission, ROLE_LABELS, ROLE_PERMISSIONS, ASSIGNABLE_ROLES, normalizeRole, saoPauloToday } = require("./_lib/admin");
const { DEFAULT_FEATURES, getRuntimeConfig, normalizeRuntimeConfig } = require("./_lib/adminConfig");
const { normalizeShowcase, normalizeOrder, sortPlans } = require("./_lib/plans");

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

async function authUserActivity(firebase, days = 30, historyDays = 90) {
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
  // Contas acumuladas por dia (pela data de criação) para o gráfico de
  // crescimento; e novas contas nos últimos 30 dias x 30 dias anteriores.
  const historyStart = new Date(today.getTime() - (historyDays - 1) * 86400000);
  historyStart.setUTCHours(0, 0, 0, 0);
  const created = new Map();
  let beforeHistory = 0;
  let newUsers30d = 0;
  let newUsersPrev30d = 0;
  const prevStart = new Date(start.getTime() - days * 86400000);
  for (const user of users) {
    const createdAt = timestampValue(user.metadata?.creationTime);
    if (createdAt) {
      const date = new Date(createdAt);
      if (date < historyStart) beforeHistory++;
      else created.set(createdAt.slice(0, 10), (created.get(createdAt.slice(0, 10)) || 0) + 1);
      if (date >= start) newUsers30d++;
      else if (date >= prevStart) newUsersPrev30d++;
    } else {
      beforeHistory++;
    }
    const last = timestampValue(user.metadata?.lastSignInTime);
    if (!last || new Date(last) < start) continue;
    active30d++;
    const bucket = byDate.get(last.slice(0, 10));
    if (bucket) bucket.users++;
  }
  let running = beforeHistory;
  const accountsByDay = Array.from({ length: historyDays }, (_, index) => {
    const date = new Date(historyStart.getTime() + index * 86400000).toISOString().slice(0, 10);
    running += created.get(date) || 0;
    return { date, total: running };
  });
  return { total: users.length, active30d, lastAccessByDay: buckets, accountsByDay, newUsers30d, newUsersPrev30d,
    disabled: users.filter((user) => user.disabled).length };
}

function monthlyCents(plan) {
  const price = Math.max(0, Number(plan?.priceCents) || 0);
  return plan?.billingInterval === "year" ? Math.round(price / 12) : price;
}

async function dashboard(firebase, db) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const sincePrev = new Date(Date.now() - 60 * 86400000).toISOString();
  const [authActivity, userData, usage, whatsapp, reminders, activeEntitlements, recentCharges, recentAudit, integrations, plans] = await Promise.all([
    authUserActivity(firebase),
    db.collection("userData").limit(2000).get(),
    db.collection("adminUsage").limit(2000).get(),
    db.collection("whatsappProcessedMessages").where("processedAt", ">=", since).count().get().then(countValue),
    db.collection("reminderDeliveries").where("acceptedAt", ">=", since).count().get().then(countValue),
    db.collection("adminEntitlements").where("status", "==", "active").limit(5000).get(),
    db.collection("adminCharges").where("createdAt", ">=", sincePrev).limit(1000).get(),
    db.collection("adminAudit").orderBy("at", "desc").limit(6).get(),
    integrationStatus(db),
    db.collection("adminPlans").limit(100).get(),
  ]);
  const received = (charge) => charge.status === "manual_received" || charge.status === "paid";
  let revenueCents30d = 0;
  let revenuePrevCents30d = 0;
  for (const entry of recentCharges.docs) {
    const charge = entry.data();
    if (!received(charge)) continue;
    if (String(charge.createdAt || "") >= since) revenueCents30d += Number(charge.amountCents) || 0;
    else revenuePrevCents30d += Number(charge.amountCents) || 0;
  }
  const activeSubscriptions = activeEntitlements.docs.length;
  const planById = new Map(plans.docs.map((entry) => [entry.id, { id: entry.id, ...entry.data() }]));
  const byPlan = new Map();
  for (const entry of activeEntitlements.docs) {
    const planId = text(entry.data()?.planId, 60) || "sem-plano";
    byPlan.set(planId, (byPlan.get(planId) || 0) + 1);
  }
  const planBreakdown = [...byPlan.entries()].map(([planId, count]) => {
    const plan = planById.get(planId);
    return { planId, name: plan?.name || planId, count, monthlyCents: monthlyCents(plan) };
  }).sort((a, b) => b.count - a.count);
  const mrrCents = planBreakdown.reduce((total, item) => total + item.count * item.monthlyCents, 0);
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
  const totals = accountSignals.reduce((sum, item) => ({
    tasks: sum.tasks + item.activity.tasks,
    notes: sum.notes + item.activity.notes,
    finances: sum.finances + item.activity.finances,
    events: sum.events + item.activity.events,
  }), { tasks: 0, notes: 0, finances: 0, events: 0 });
  const segments = await accessSegments(db, authActivity);
  return {
    periodDays: 30,
    segments,
    metrics: { users: authActivity.total, activeUsers30d: authActivity.active30d, activeSubscriptions, revenueCents30d,
      integrationsHealthy, integrationsTotal: integrations.integrations.length,
      usersWithSavedChanges30d, whatsappReceived30d: whatsapp, reminderDeliveriesAccepted30d: reminders,
      newUsers30d: authActivity.newUsers30d, newUsersPrev30d: authActivity.newUsersPrev30d,
      revenuePrevCents30d, mrrCents, totalTasks: totals.tasks, totalNotes: totals.notes, totalFinances: totals.finances, totalEvents: totals.events },
    lastAccessByDay: authActivity.lastAccessByDay,
    accountsByDay: authActivity.accountsByDay,
    planBreakdown,
    integrations: integrations.integrations.map(({ id, label, configured }) => ({ id, label, configured })),
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
  const [snapshot, entitlements] = await Promise.all([
    db.collection("adminPlans").orderBy("name").limit(100).get(),
    db.collection("adminEntitlements").limit(5000).get(),
  ]);
  const today = saoPauloToday();
  const counts = new Map();
  for (const entry of entitlements.docs) {
    const data = entry.data() || {};
    const { segment } = classifyEntitlement(data, today);
    if (!data.planId || !["plan", "trial"].includes(segment)) continue;
    const current = counts.get(data.planId) || { active: 0, trial: 0 };
    current[segment === "trial" ? "trial" : "active"]++;
    counts.set(data.planId, current);
  }
  return { plans: sortPlans(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data(), subscribers: counts.get(entry.id) || { active: 0, trial: 0 } }))) };
}

async function listCharges(db) {
  const snapshot = await db.collection("adminCharges").orderBy("createdAt", "desc").limit(300).get();
  return { charges: snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })), stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET) };
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
      const owner = email === primaryEmail;
      byUid.set(user.uid, { uid: user.uid, email: user.email || email, displayName: user.displayName || "", owner, role: owner ? "owner" : "admin", roleLabel: ROLE_LABELS[owner ? "owner" : "admin"], source: "environment" });
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  await Promise.all(roles.docs.map(async (entry) => {
    if (byUid.has(entry.id)) return;
    try {
      const user = await firebase.auth().getUser(entry.id);
      const owner = (user.email || "").toLowerCase() === primaryEmail;
      const role = owner ? "owner" : normalizeRole(entry.data()?.role);
      byUid.set(user.uid, { uid: user.uid, email: user.email || "", displayName: user.displayName || "", owner, role, roleLabel: ROLE_LABELS[role], source: "firestore", lastSignInAt: timestampValue(user.metadata?.lastSignInTime) });
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }));
  return { admins: [...byUid.values()].sort((a, b) => Number(b.owner) - Number(a.owner) || a.email.localeCompare(b.email)), isOwner: actor.isOwner === true,
    roles: Object.fromEntries(Object.entries(ROLE_LABELS).map(([key, label]) => [key, { label, permissions: ROLE_PERMISSIONS[key] }])) };
}

async function setAdminRole(firebase, db, actor, body) {
  if (!actor.isOwner) fail(403, "owner_required");
  if (typeof body.enabled !== "boolean") fail(400, "invalid_admin_role");
  let user;
  if (body.enabled && !body.uid) {
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
  if (body.enabled && configuredAdminEmails().has(email)) fail(409, "role_managed_by_server");
  const role = body.role === undefined ? "admin" : body.role;
  if (body.enabled && !ASSIGNABLE_ROLES.includes(role)) fail(400, "invalid_admin_role");
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(db.collection("adminRoles").doc(user.uid), { enabled: body.enabled, email, ...(body.enabled ? { role } : {}), updatedAt: now, updatedBy: actor.uid }, { merge: true });
  batch.set(db.collection("adminAudit").doc(), { at: now, actorUid: actor.uid, actorEmail: actor.email,
    action: body.enabled ? "admin_access_granted" : "admin_access_revoked", target: user.uid, details: { email, ...(body.enabled ? { role } : {}) } });
  await batch.commit();
  // Ao remover ou rebaixar, encerra as sessões ativas para o novo papel valer já.
  await firebase.auth().revokeRefreshTokens(user.uid);
  return { uid: user.uid, email, enabled: body.enabled, role: body.enabled ? role : null };
}


// ── Segmentos de acesso (visão geral) ──────────────────────────────
function addDaysIso(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T12:00:00Z`) - new Date(`${fromIso}T12:00:00Z`)) / 86400000);
}

// Classifica um acesso: com plano, em teste, pausado, vencido, sem plano.
function classifyEntitlement(data, today = saoPauloToday()) {
  if (!data?.planId) return { segment: "none", daysLeft: null };
  const expired = Boolean(data.validUntil && today > data.validUntil);
  const daysLeft = data.validUntil ? daysBetween(today, data.validUntil) : null;
  if (data.status && data.status !== "active") return { segment: data.status === "cancelled" ? "cancelled" : "paused", daysLeft };
  if (expired) return { segment: data.source === "trial" ? "trial_ended" : "expired", daysLeft };
  return { segment: data.source === "trial" ? "trial" : "plan", daysLeft };
}

async function accessSegments(db, authActivity) {
  const [entitlements, pending] = await Promise.all([
    db.collection("adminEntitlements").limit(5000).get(),
    db.collection("adminCharges").where("status", "==", "manual_pending").limit(2000).get(),
  ]);
  const today = saoPauloToday();
  const counts = { plan: 0, trial: 0, paused: 0, expired: 0, none: 0, disabled: Number(authActivity?.disabled) || 0, expiringSoon: 0, trialEndingSoon: 0 };
  let withEntitlement = 0;
  for (const entry of entitlements.docs) {
    const data = entry.data() || {};
    if (!data.planId) continue;
    withEntitlement++;
    const { segment, daysLeft } = classifyEntitlement(data, today);
    if (segment === "plan") counts.plan++;
    else if (segment === "trial") counts.trial++;
    else if (segment === "paused" || segment === "cancelled") counts.paused++;
    else counts.expired++;
    if (segment === "plan" && daysLeft !== null && daysLeft <= 7) counts.expiringSoon++;
    if (segment === "trial" && daysLeft !== null && daysLeft <= 3) counts.trialEndingSoon++;
  }
  counts.none = Math.max(0, (Number(authActivity?.total) || 0) - withEntitlement);
  let pendingCents = 0;
  let overdue = 0;
  let pendingCount = 0;
  for (const entry of pending.docs) {
    const charge = entry.data() || {};
    if (charge.status !== "manual_pending") continue;
    pendingCount++;
    pendingCents += Number(charge.amountCents) || 0;
    if (charge.dueDate && charge.dueDate < today) overdue++;
  }
  return { ...counts, pendingCharges: pendingCount, pendingCents, overdueCharges: overdue };
}

// ── Diretório completo de usuários ─────────────────────────────────
async function allAuthUsers(firebase, max = 5000) {
  const users = [];
  let cursor;
  do {
    const page = await firebase.auth().listUsers(1000, cursor);
    users.push(...page.users);
    cursor = page.pageToken;
  } while (cursor && users.length < max);
  return users.slice(0, max);
}

async function directory(firebase, db) {
  const [users, entitlements, usage, plans, pending, roles] = await Promise.all([
    allAuthUsers(firebase),
    db.collection("adminEntitlements").limit(5000).get(),
    db.collection("adminUsage").limit(5000).get(),
    db.collection("adminPlans").limit(100).get(),
    db.collection("adminCharges").where("status", "==", "manual_pending").limit(2000).get(),
    db.collection("adminRoles").where("enabled", "==", true).limit(100).get(),
  ]);
  const entitlementByUid = new Map(entitlements.docs.map((entry) => [entry.id, entry.data() || {}]));
  const usageByUid = new Map(usage.docs.map((entry) => [entry.id, entry.data() || {}]));
  const planName = new Map(plans.docs.map((entry) => [entry.id, entry.data()?.name || entry.id]));
  const pendingByUid = new Map();
  for (const entry of pending.docs) {
    const charge = entry.data() || {};
    if (charge.status !== "manual_pending" || !charge.uid) continue;
    const current = pendingByUid.get(charge.uid) || { count: 0, cents: 0 };
    pendingByUid.set(charge.uid, { count: current.count + 1, cents: current.cents + (Number(charge.amountCents) || 0) });
  }
  const adminEmails = configuredAdminEmails();
  const adminUids = new Set(roles.docs.map((entry) => entry.id));
  const today = saoPauloToday();
  const rows = users.map((user) => {
    const entitlement = entitlementByUid.get(user.uid) || {};
    const { segment, daysLeft } = classifyEntitlement(entitlement, today);
    const lastSeen = timestampValue(usageByUid.get(user.uid)?.lastSeenAt);
    return {
      uid: user.uid,
      email: user.email || "",
      displayName: user.displayName || "",
      photoURL: /^https:\/\//.test(user.photoURL || "") ? user.photoURL : "",
      provider: (user.providerData || []).some((item) => item.providerId === "google.com") ? "google" : "email",
      emailVerified: user.emailVerified === true,
      disabled: user.disabled === true,
      createdAt: timestampValue(user.metadata?.creationTime),
      lastSignInAt: timestampValue(user.metadata?.lastSignInTime),
      lastActiveAt: lastSeen,
      planId: entitlement.planId || null,
      planName: entitlement.planId ? planName.get(entitlement.planId) || entitlement.planId : null,
      status: entitlement.planId ? entitlement.status || "active" : "none",
      source: entitlement.source || null,
      validUntil: entitlement.validUntil || null,
      segment: user.disabled ? "disabled" : segment,
      daysLeft,
      pending: pendingByUid.get(user.uid) || { count: 0, cents: 0 },
      admin: adminEmails.has(String(user.email || "").toLowerCase()) || adminUids.has(user.uid),
    };
  });
  rows.sort((a, b) => String(b.lastActiveAt || b.lastSignInAt || "").localeCompare(String(a.lastActiveAt || a.lastSignInAt || "")));
  return { users: rows, today, truncated: users.length >= 5000 };
}

async function userDetail(firebase, db, query) {
  const uid = text(query.uid, 128);
  if (!uid) fail(400, "uid_required");
  const user = await firebase.auth().getUser(uid);
  const [entitlement, userData, usage, charges, aiUsage] = await Promise.all([
    db.collection("adminEntitlements").doc(uid).get(),
    db.collection("userData").doc(uid).get(),
    db.collection("adminUsage").doc(uid).get(),
    db.collection("adminCharges").where("uid", "==", uid).limit(30).get(),
    db.collection("aiUsage").doc(uid).get(),
  ]);
  const ai = aiUsage.data() || {};
  // Histórico do que a equipe fez nesta conta (só igualdade: dispensa índice
  // composto). Falha aqui não derruba a ficha.
  const history = await db.collection("adminAudit").where("target", "==", uid).limit(40).get()
    .then((snapshot) => snapshot.docs.map((entry) => {
      const data = entry.data() || {};
      return { id: entry.id, at: data.at || "", action: text(data.action, 60), actorEmail: text(data.actorEmail, 200),
        details: pick(data.details || {}, ["planId", "validUntil", "days", "status", "role"]) };
    }).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20))
    .catch(() => []);
  return {
    history,
    user: { uid, email: user.email || "", displayName: user.displayName || "", disabled: user.disabled === true,
      emailVerified: user.emailVerified === true, createdAt: timestampValue(user.metadata?.creationTime),
      lastSignInAt: timestampValue(user.metadata?.lastSignInTime) },
    entitlement: entitlement.exists ? { ...pick(entitlement.data(), ["planId", "status", "source", "validUntil", "trialStartedAt", "updatedAt", "provider"]) } : null,
    ...summarizeUserState(userData),
    ...summarizeUsage(usage),
    aiToday: ai.day === saoPauloToday() ? Number(ai.count) || 0 : 0,
    charges: charges.docs.map((entry) => ({ id: entry.id, ...pick(entry.data(), ["amountCents", "status", "dueDate", "note", "createdAt", "planId", "grantDays", "paidAt", "source"]) }))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
  };
}

function pick(object = {}, keys) {
  return Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
}

// ── Acesso: atribuir, teste, estender, pausar, remover (1 ou vários) ─
const ACCESS_OPS = ["assign", "trial", "extend", "pause", "resume", "remove"];

function validUids(input) {
  const list = Array.isArray(input) ? input : [input];
  const uids = [...new Set(list.map((uid) => text(uid, 128)).filter(Boolean))];
  if (!uids.length) fail(400, "uids_required");
  if (uids.length > 200) fail(400, "too_many_users");
  return uids;
}

async function existingUsers(firebase, uids) {
  const auth = firebase.auth();
  if (typeof auth.getUsers === "function") {
    const found = new Map();
    for (let index = 0; index < uids.length; index += 100) {
      const result = await auth.getUsers(uids.slice(index, index + 100).map((uid) => ({ uid })));
      for (const user of result.users) found.set(user.uid, user);
    }
    return found;
  }
  const found = new Map();
  for (const uid of uids) {
    try { found.set(uid, await auth.getUser(uid)); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
  }
  return found;
}

async function accessApply(firebase, db, actor, body) {
  const op = body.op;
  if (!ACCESS_OPS.includes(op)) fail(400, "invalid_access_op");
  const uids = validUids(body.uids ?? body.uid);
  const today = saoPauloToday();
  const days = Number(body.days);
  let planId = "";
  let plan = null;
  if (op === "assign" || op === "trial") {
    planId = text(body.planId, 40).toLowerCase();
    if (!/^[a-z0-9_-]{2,40}$/.test(planId)) fail(400, "plan_required");
    const snapshot = await db.collection("adminPlans").doc(planId).get();
    if (!snapshot.exists || snapshot.data()?.active === false) fail(400, "plan_unavailable");
    plan = snapshot.data();
  }
  if ((op === "trial" && (!Number.isInteger(days) || days < 1 || days > 90))
    || (op === "extend" && (!Number.isInteger(days) || days < 1 || days > 730))) fail(400, "invalid_days");
  const validUntil = op === "assign" && body.validUntil ? text(body.validUntil, 10) : null;
  if (validUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || validUntil < today)) fail(400, "invalid_valid_until");

  const users = await existingUsers(firebase, uids);
  const current = new Map(await Promise.all(uids.map(async (uid) => [uid, (await db.collection("adminEntitlements").doc(uid).get()).data() || null])));
  const now = new Date().toISOString();
  const applied = [];
  const skipped = [];
  const writes = [];
  for (const uid of uids) {
    if (!users.has(uid)) { skipped.push({ uid, reason: "user_not_found" }); continue; }
    const before = current.get(uid);
    const ref = db.collection("adminEntitlements").doc(uid);
    let next = null;
    if (op === "assign") next = { planId, status: "active", validUntil, source: "manual", updatedAt: now, updatedBy: actor.uid };
    else if (op === "trial") next = { planId, status: "active", validUntil: addDaysIso(today, days - 1), source: "trial", trialStartedAt: today, updatedAt: now, updatedBy: actor.uid };
    else if (op === "extend") {
      if (!before?.planId) { skipped.push({ uid, reason: "no_plan" }); continue; }
      const base = before.validUntil && before.validUntil >= today ? before.validUntil : addDaysIso(today, -1);
      next = { ...before, status: "active", validUntil: addDaysIso(base, days), updatedAt: now, updatedBy: actor.uid };
    } else if (op === "pause" || op === "resume") {
      if (!before?.planId) { skipped.push({ uid, reason: "no_plan" }); continue; }
      next = { ...before, status: op === "pause" ? "paused" : "active", updatedAt: now, updatedBy: actor.uid };
    } else if (op === "remove") {
      if (!before?.planId) { skipped.push({ uid, reason: "no_plan" }); continue; }
    }
    writes.push({ ref, next, uid, before });
    applied.push(uid);
  }
  // Grava em lotes (máx. 500 operações por lote no Firestore).
  for (let index = 0; index < writes.length; index += 200) {
    const batch = db.batch();
    for (const item of writes.slice(index, index + 200)) {
      if (item.next) batch.set(item.ref, item.next);
      else batch.delete(item.ref);
      batch.set(db.collection("adminAudit").doc(), { at: now, actorUid: actor.uid, actorEmail: actor.email,
        action: `access_${op}`, target: item.uid,
        details: { email: users.get(item.uid)?.email || "", planId: item.next?.planId || item.before?.planId || null,
          validUntil: item.next?.validUntil || null, days: Number.isInteger(days) ? days : null } });
    }
    await batch.commit();
  }
  const stripeWarnings = writes.filter((item) => item.before?.source === "stripe" && ["remove", "pause"].includes(op)).length;
  return { op, applied, skipped, stripeWarnings, planName: plan?.name || null };
}

// ── Cobranças em lote ───────────────────────────────────────────────
async function chargeBulk(firebase, db, actor, body) {
  const uids = validUids(body.uids);
  const requestId = text(body.requestId, 64);
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) fail(400, "invalid_charge");
  let planId = text(body.planId, 40).toLowerCase();
  let plan = null;
  if (planId) {
    if (!/^[a-z0-9_-]{2,40}$/.test(planId)) fail(400, "invalid_charge");
    const snapshot = await db.collection("adminPlans").doc(planId).get();
    if (!snapshot.exists) fail(400, "plan_unavailable");
    plan = snapshot.data();
  } else planId = null;
  const amountCents = body.amountCents === undefined || body.amountCents === null || body.amountCents === ""
    ? Number(plan?.priceCents) : Number(body.amountCents);
  const dueDate = text(body.dueDate, 10) || null;
  const grantDays = body.grantDays === undefined || body.grantDays === null || body.grantDays === ""
    ? (plan ? (plan.billingInterval === "year" ? 365 : 30) : null) : Number(body.grantDays);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000
    || (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
    || (grantDays !== null && (!Number.isInteger(grantDays) || grantDays < 1 || grantDays > 730))
    || (grantDays !== null && !planId)) fail(400, "invalid_charge");
  const note = text(body.note, 300) || (plan ? `Plano ${plan.name || planId}` : "Cobrança PulseNote");
  const users = await existingUsers(firebase, uids);
  const now = new Date().toISOString();
  const created = [];
  const skipped = [];
  for (let index = 0; index < uids.length; index += 150) {
    const chunk = uids.slice(index, index + 150);
    const refs = chunk.map((uid) => ({ uid, ref: db.collection("adminCharges").doc(crypto.createHash("sha256").update(`${actor.uid}:${requestId}:${uid}`).digest("hex")) }));
    const existing = await Promise.all(refs.map(({ ref }) => ref.get()));
    const batch = db.batch();
    refs.forEach(({ uid, ref }, position) => {
      if (!users.has(uid)) { skipped.push({ uid, reason: "user_not_found" }); return; }
      if (existing[position].exists) { skipped.push({ uid, reason: "already_created" }); return; }
      batch.set(ref, { uid, email: users.get(uid).email || "", amountCents, currency: "BRL", dueDate, note,
        planId, grantDays, status: "manual_pending", source: "manual", requestId, createdAt: now, createdBy: actor.uid });
      batch.set(db.collection("adminAudit").doc(), { at: now, actorUid: actor.uid, actorEmail: actor.email,
        action: "manual_charge_created", target: ref.id, details: { uid, email: users.get(uid).email || "", amountCents, planId } });
      created.push({ id: ref.id, uid });
    });
    await batch.commit();
  }
  return { created, skipped, amountCents, planId };
}

// Libera/estende o plano quando uma cobrança vinculada é paga.
function grantFromCharge(currentEntitlement, charge, today = saoPauloToday()) {
  if (!charge?.planId || !Number.isInteger(Number(charge.grantDays))) return null;
  const samePlan = currentEntitlement?.planId === charge.planId && (currentEntitlement.status || "active") === "active";
  const base = samePlan && currentEntitlement.validUntil && currentEntitlement.validUntil >= today
    ? currentEntitlement.validUntil : addDaysIso(today, -1);
  return { planId: charge.planId, status: "active", source: "charge", validUntil: addDaysIso(base, Number(charge.grantDays)), updatedAt: new Date().toISOString() };
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
    const providerStatus = ["sent", "delivered", "read", "failed"].includes(delivery.providerStatus)
      ? delivery.providerStatus : null;
    return {
      id: String(entry.id || "").slice(0, 10),
      uid: text(delivery.uid, 128),
      channel,
      notificationKey: text(delivery.notificationKey, 120) || "legacy",
      status,
      attemptedAt: timestampValue(delivery.updatedAt || delivery.acceptedAt),
      acceptedAt: timestampValue(delivery.acceptedAt),
      providerStatus,
      providerUpdatedAt: timestampValue(delivery.providerUpdatedAt),
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
      { id: "ai-gateway", label: "Pulsinho GPT / Claude", configured: configured(["AI_GATEWAY_OPENAI_MODEL", "AI_GATEWAY_ANTHROPIC_MODEL"]),
        detail: configured(["AI_GATEWAY_OPENAI_MODEL", "AI_GATEWAY_ANTHROPIC_MODEL"])
          ? "Modelos OpenAI e Anthropic configurados via Vercel AI Gateway"
          : "Defina os modelos AI_GATEWAY_OPENAI_MODEL e AI_GATEWAY_ANTHROPIC_MODEL" },
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
  const current = await getRuntimeConfig(db);
  const now = new Date().toISOString();
  const next = { ...current };
  if (body.features !== undefined) next.features = validateFeatureMap(body.features);
  if (body.maintenance !== undefined) {
    if (typeof body.maintenance?.enabled !== "boolean") fail(400, "invalid_maintenance");
    next.maintenance = {
      enabled: body.maintenance.enabled,
      message: text(body.maintenance.message, 240) || current.maintenance.message,
      eta: text(body.maintenance.eta, 60),
      allowAdmins: body.maintenance.allowAdmins !== false,
      startedAt: body.maintenance.enabled ? (current.maintenance.enabled ? current.maintenance.startedAt || now : now) : "",
    };
  }
  const planExists = async (id) => {
    const snapshot = await db.collection("adminPlans").doc(id).get();
    return snapshot.exists && snapshot.data()?.active !== false;
  };
  if (body.access !== undefined) {
    const noPlan = body.access?.noPlan === "plan" ? "plan" : body.access?.noPlan === "full" ? "full" : null;
    const planId = text(body.access?.noPlanPlanId, 40).toLowerCase();
    if (!noPlan || (noPlan === "plan" && (!/^[a-z0-9_-]{2,40}$/.test(planId) || !(await planExists(planId))))) fail(400, "invalid_access_policy");
    next.access = { noPlan, noPlanPlanId: noPlan === "plan" ? planId : "" };
  }
  if (body.trial !== undefined) {
    const enabled = body.trial?.enabled === true;
    const planId = text(body.trial?.planId, 40).toLowerCase();
    const days = Number(body.trial?.days);
    if (typeof body.trial?.enabled !== "boolean" || !Number.isInteger(days) || days < 1 || days > 90
      || (enabled && (!/^[a-z0-9_-]{2,40}$/.test(planId) || !(await planExists(planId))))) fail(400, "invalid_trial");
    next.trial = { enabled, planId: planId || current.trial.planId, days, enabledAt: enabled ? (current.trial.enabled ? current.trial.enabledAt || now : now) : "" };
  }
  if (body.payment !== undefined) {
    next.payment = { pixKey: text(body.payment?.pixKey, 140), pixHolder: text(body.payment?.pixHolder, 100), instructions: text(body.payment?.instructions, 400) };
  }
  const config = normalizeRuntimeConfig(next);
  const changed = ["features", "maintenance", "access", "trial", "payment"].filter((key) => body[key] !== undefined);
  if (!changed.length) fail(400, "nothing_to_update");
  const batch = db.batch();
  batch.set(db.collection("systemConfig").doc("global"), { ...config, updatedAt: now, updatedBy: actor.uid });
  batch.set(db.collection("adminAudit").doc(), {
    at: now, actorUid: actor.uid, actorEmail: actor.email,
    action: body.maintenance !== undefined && config.maintenance.enabled !== current.maintenance.enabled
      ? (config.maintenance.enabled ? "maintenance_enabled" : "maintenance_disabled") : "config_updated",
    target: "global", details: { sections: changed, maintenanceEnabled: config.maintenance.enabled },
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
  // Conversas com IA por dia: vazio = padrão do sistema; 0 = sem limite.
  const rawAiLimit = body.aiDailyLimit;
  const aiDailyLimit = rawAiLimit === null || rawAiLimit === undefined || rawAiLimit === "" ? null : Number(rawAiLimit);
  if (aiDailyLimit !== null && (!Number.isInteger(aiDailyLimit) || aiDailyLimit < 0 || aiDailyLimit > 5000)) fail(400, "invalid_plan_ai_limit");
  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 100_000_000
    || !["month", "year"].includes(billingInterval)
    || (stripePriceId && !/^price_[A-Za-z0-9]+$/.test(stripePriceId))) fail(400, "invalid_plan_billing");
  // Visibilidade: "public" aparece para os usuários assinarem; "private"
  // só pode ser atribuído pelo painel (ex.: planos de parceria ou teste).
  const visibility = body.visibility === "private" ? "private" : "public";
  // Vitrine e venda: chamada, vantagens, selo, destaque, cor, botão, ordem,
  // preço anual alternativo e dias de teste no checkout (ver _lib/plans.js).
  const showcase = normalizeShowcase(body, { billingInterval });
  const plan = { name, description: text(body.description, 300), active: body.active, features,
    priceCents, currency: "BRL", billingInterval, stripePriceId: stripePriceId || null, aiDailyLimit, visibility,
    ...showcase,
    updatedAt: new Date().toISOString(), updatedBy: actor.uid };
  const batch = db.batch();
  batch.set(db.collection("adminPlans").doc(id), plan, { merge: true });
  batch.set(db.collection("adminAudit").doc(), { at: new Date().toISOString(), actorUid: actor.uid,
    actorEmail: actor.email, action: "plan_saved", target: id, details: { active: plan.active, features, priceCents, visibility, highlight: plan.highlight } });
  await batch.commit();
  return { plan: { id, ...plan } };
}

// Ordem da vitrine (arrastar no Estúdio de planos).
async function reorderPlans(db, actor, body) {
  const order = normalizeOrder(body.ids);
  const refs = order.map(({ id }) => db.collection("adminPlans").doc(id));
  const snapshots = await Promise.all(refs.map((ref) => ref.get()));
  if (snapshots.some((snapshot) => !snapshot.exists)) fail(404, "plan_not_found");
  const batch = db.batch();
  const now = new Date().toISOString();
  order.forEach(({ order: value }, index) => batch.update(refs[index], { order: value, updatedAt: now, updatedBy: actor.uid }));
  batch.set(db.collection("adminAudit").doc(), { at: now, actorUid: actor.uid, actorEmail: actor.email,
    action: "plans_reordered", target: "plans", details: { ids: order.map(({ id }) => id) } });
  await batch.commit();
  return { order };
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
    const charge = previous.data();
    let granted = null;
    if (status === "manual_received" && charge.planId && charge.uid) {
      const entitlementRef = db.collection("adminEntitlements").doc(charge.uid);
      const entitlement = await tx.get(entitlementRef);
      granted = grantFromCharge(entitlement.exists ? entitlement.data() : null, charge);
      if (granted) tx.set(entitlementRef, { ...granted, updatedBy: actor.uid });
    }
    tx.update(ref, { status, updatedAt: new Date().toISOString(), updatedBy: actor.uid, ...(status === "manual_received" ? { paidAt: new Date().toISOString() } : {}) });
    tx.create(db.collection("adminAudit").doc(), { at: new Date().toISOString(), actorUid: actor.uid,
      actorEmail: actor.email, action: "manual_charge_updated", target: id, details: { status, ...(granted ? { planId: granted.planId, validUntil: granted.validUntil } : {}) } });
    return { id, status, granted };
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
    const allow = (permission) => { if (!hasPermission(actor, permission)) fail(403, "permission_denied"); };
    let result;
    if (req.method === "GET") {
      allow("view");
      if (action === "me") result = { isAdmin: true, isOwner: actor.isOwner === true, uid: actor.uid, email: actor.email,
        role: actor.role, roleLabel: ROLE_LABELS[actor.role], permissions: ROLE_PERMISSIONS[actor.role] };
      else if (action === "dashboard") result = await dashboard(firebase, db);
      else if (action === "users") result = await listUsers(firebase, db, req.query || {});
      else if (action === "directory") result = await directory(firebase, db);
      else if (action === "user-detail") result = await userDetail(firebase, db, req.query || {});
      else if (action === "plans") result = await listPlans(db);
      else if (action === "subscriptions") result = await listSubscriptions(db);
      else if (action === "charges") result = await listCharges(db);
      else if (action === "features" || action === "settings") result = { config: await getRuntimeConfig(db) };
      else if (action === "integrations") result = await integrationStatus(db);
      else if (action === "audit") result = await listAudit(db);
      else if (action === "admins") result = await listAdmins(firebase, db, actor);
      else fail(404, "unknown_action");
    } else {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const permissionFor = {
        "config-update": "config.manage", "user-update": "users.status", "plan-save": "plans.manage",
        "entitlement-set": "users.access", "access-apply": "users.access",
        "charge-create": "charges.manage", "charge-bulk": "charges.manage", "charge-update": "charges.manage", "plan-order": "plans.manage",
        "admin-role-set": "admins.manage",
      };
      if (!permissionFor[action]) fail(404, "unknown_action");
      allow(permissionFor[action]);
      if (action === "config-update") result = await updateConfig(db, actor, body);
      else if (action === "user-update") result = await updateUser(firebase, db, actor, body);
      else if (action === "plan-save") result = await savePlan(db, actor, body);
      else if (action === "entitlement-set") result = await setEntitlement(firebase, db, actor, body);
      else if (action === "access-apply") result = await accessApply(firebase, db, actor, body);
      else if (action === "charge-create") result = await createCharge(firebase, db, actor, body);
      else if (action === "charge-bulk") result = await chargeBulk(firebase, db, actor, body);
      else if (action === "charge-update") result = await updateCharge(db, actor, body);
      else if (action === "plan-order") result = await reorderPlans(db, actor, body);
      else if (action === "admin-role-set") result = await setAdminRole(firebase, db, actor, body);
    }
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error.status) || (error.code === "auth/user-not-found" ? 404 : 500);
    if (status >= 500) console.error("Falha no painel administrativo:", error);
    return res.status(status).json({ error: status >= 500 ? "internal_error" : (error.code || error.message) });
  }
};

module.exports._test = { validateFeatureMap, savePlan, reorderPlans, listPlans, integrationStatus, countAuthUsers, authUserActivity, summarizeUserState, summarizeUsage, aggregateUsage,
  dashboard, listUsers, listAdmins, updateConfig, updateUser, setEntitlement, createCharge, updateCharge, setAdminRole,
  directory, userDetail, accessApply, chargeBulk, grantFromCharge, classifyEntitlement, accessSegments, addDaysIso };
