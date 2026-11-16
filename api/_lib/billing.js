"use strict";

const crypto = require("node:crypto");
const { getAdmin, configuredAdminEmails, saoPauloToday } = require("./admin");
const { getRuntimeConfig } = require("./adminConfig");

const OFFICIAL_APP_URL = "https://pulse-note-5erj.vercel.app";

function billingError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function appBaseUrl() {
  const configured = String(process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
  if (!configured) return OFFICIAL_APP_URL;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:") throw new Error("https_required");
    return url.origin;
  } catch {
    throw billingError(500, "invalid_app_base_url");
  }
}

function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

async function requireUser(req, firebase = getAdmin()) {
  const authorization = req.headers?.authorization || "";
  if (!authorization.startsWith("Bearer ")) throw billingError(401, "unauthorized");
  let decoded;
  let user;
  try {
    decoded = await firebase.auth().verifyIdToken(authorization.slice(7), true);
    user = await firebase.auth().getUser(decoded.uid);
  } catch {
    throw billingError(401, "unauthorized");
  }
  if (user.disabled) throw billingError(403, "account_disabled");
  const status = await firebase.firestore().collection("adminUserStatus").doc(user.uid).get();
  if (status.data()?.disabled === true) throw billingError(403, "account_disabled");
  return { uid: user.uid, email: user.email || "", displayName: user.displayName || "", createdAt: user.metadata?.creationTime || null };
}

function addDaysIso(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Mesma regra do painel: cobrança paga vinculada a plano libera/estende o acesso.
function grantFromCharge(currentEntitlement, charge, today = saoPauloToday()) {
  if (!charge?.planId || !Number.isInteger(Number(charge.grantDays))) return null;
  const samePlan = currentEntitlement?.planId === charge.planId && (currentEntitlement.status || "active") === "active";
  const base = samePlan && currentEntitlement.validUntil && currentEntitlement.validUntil >= today
    ? currentEntitlement.validUntil : addDaysIso(today, -1);
  return { planId: charge.planId, status: "active", source: "charge", validUntil: addDaysIso(base, Number(charge.grantDays)), updatedAt: new Date().toISOString() };
}

async function isAdminUser(db, user) {
  if (configuredAdminEmails().has(String(user.email || "").toLowerCase())) return true;
  const role = await db.collection("adminRoles").doc(user.uid).get();
  return role.data()?.enabled === true;
}

// Teste grátis automático: só para contas criadas depois que o teste foi
// ligado no painel e que ainda não têm nenhum registro de acesso.
async function maybeStartAutoTrial(db, user, config, entitlementSnapshot) {
  const trial = config?.trial;
  if (!trial?.enabled || !trial.planId || entitlementSnapshot.exists) return null;
  const createdAt = user.createdAt ? new Date(user.createdAt).toISOString() : "";
  if (!createdAt || (trial.enabledAt && createdAt < trial.enabledAt)) return null;
  const plan = await db.collection("adminPlans").doc(trial.planId).get();
  if (!plan.exists || plan.data()?.active === false) return null;
  const today = saoPauloToday();
  const entitlement = { planId: trial.planId, status: "active", source: "trial", trialStartedAt: today,
    validUntil: addDaysIso(today, trial.days - 1), updatedAt: new Date().toISOString(), updatedBy: "auto_trial" };
  try {
    await db.collection("adminEntitlements").doc(user.uid).create(entitlement);
  } catch (error) {
    if (error.code === 6 || error.code === "already-exists") return null;
    throw error;
  }
  await db.collection("adminAudit").add({ at: entitlement.updatedAt, actorUid: "system", actorEmail: "teste automático",
    action: "access_trial_auto", target: user.uid, details: { email: user.email || "", planId: trial.planId, validUntil: entitlement.validUntil } }).catch(() => {});
  return entitlement;
}

async function stripeRequest(path, params) {
  if (!process.env.STRIPE_SECRET_KEY) throw billingError(503, "billing_not_configured");
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: new URLSearchParams(params).toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("stripe_request_failed", { path, status: response.status, type: payload?.error?.type || "unknown" });
    throw billingError(502, "billing_provider_error");
  }
  return payload;
}

async function ensureCustomer(firebase, user) {
  const db = firebase.firestore();
  const ref = db.collection("billingCustomers").doc(user.uid);
  const current = await ref.get();
  if (current.data()?.stripeCustomerId) return current.data().stripeCustomerId;
  const customer = await stripeRequest("customers", {
    email: user.email,
    name: user.displayName,
    "metadata[firebase_uid]": user.uid,
  });
  const now = new Date().toISOString();
  const batch = db.batch();
  batch.set(ref, { stripeCustomerId: customer.id, email: user.email, updatedAt: now }, { merge: true });
  batch.set(db.collection("billingCustomerLinks").doc(customer.id), { uid: user.uid, updatedAt: now });
  await batch.commit();
  return customer.id;
}

async function publicBillingState(firebase, user) {
  const db = firebase.firestore();
  const [plansSnapshot, entitlementSnapshot, config, chargesSnapshot] = await Promise.all([
    db.collection("adminPlans").where("active", "==", true).limit(50).get(),
    db.collection("adminEntitlements").doc(user.uid).get(),
    getRuntimeConfig(db),
    db.collection("adminCharges").where("uid", "==", user.uid).limit(30).get(),
  ]);
  const autoTrial = await maybeStartAutoTrial(db, user, config, entitlementSnapshot).catch((error) => {
    console.error("auto_trial_failed", { code: error.code || error.message });
    return null;
  });
  const entitlementData = autoTrial || (entitlementSnapshot.exists ? entitlementSnapshot.data() : null);
  const entitlement = { exists: Boolean(entitlementData), data: () => entitlementData };
  const currentPlanId = entitlementData?.planId || null;
  const plans = plansSnapshot.docs.filter((entry) => entry.data()?.visibility !== "private" || entry.id === currentPlanId).map((entry) => {
    const plan = entry.data();
    return {
      id: entry.id,
      name: plan.name || entry.id,
      description: plan.description || "",
      priceCents: Number(plan.priceCents) || 0,
      currency: plan.currency || "BRL",
      billingInterval: plan.billingInterval || "month",
      features: plan.features || {},
      checkoutAvailable: Boolean(plan.stripePriceId && process.env.STRIPE_SECRET_KEY),
    };
  }).sort((a, b) => a.priceCents - b.priceCents || a.name.localeCompare(b.name));
  const subscription = entitlement.exists ? {
    planId: entitlement.data().planId || null,
    status: entitlement.data().status || "unassigned",
    provider: entitlement.data().provider || entitlement.data().source || null,
    validUntil: entitlement.data().validUntil || null,
    trial: entitlement.data().source === "trial",
    expired: Boolean(entitlement.data().validUntil && saoPauloToday() > entitlement.data().validUntil),
  } : { planId: null, status: "unassigned", provider: null, validUntil: null, trial: false, expired: false };
  const charges = chargesSnapshot.docs
    .map((entry) => ({ id: entry.id, ...entry.data() }))
    .filter((charge) => charge.status === "manual_pending")
    .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")))
    .map((charge) => ({ id: charge.id, amountCents: Number(charge.amountCents) || 0, note: charge.note || "Cobrança PulseNote",
      dueDate: charge.dueDate || null, planId: charge.planId || null, grantDays: charge.grantDays || null }));
  const maintenance = config.maintenance.enabled
    ? { enabled: true, message: config.maintenance.message, eta: config.maintenance.eta,
      bypass: config.maintenance.allowAdmins !== false && await isAdminUser(db, user) }
    : { enabled: false };
  const manualPayment = config.payment.pixKey ? { pixKey: config.payment.pixKey, pixHolder: config.payment.pixHolder, instructions: config.payment.instructions } : null;
  return { configured: stripeConfigured(), plans, subscription, charges, maintenance,
    payment: { online: stripeConfigured(), manual: charges.length ? manualPayment : null } };
}

// Pagamento de uma cobrança avulsa pelo Stripe Checkout (cartão ou Pix,
// conforme os métodos ativos na conta Stripe).
async function createChargeCheckout(firebase, user, chargeId) {
  const id = String(chargeId || "").trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw billingError(400, "invalid_charge");
  const snapshot = await firebase.firestore().collection("adminCharges").doc(id).get();
  const charge = snapshot.data();
  if (!snapshot.exists || charge.uid !== user.uid) throw billingError(404, "charge_not_found");
  if (charge.status !== "manual_pending") throw billingError(409, "charge_not_pending");
  const amount = Number(charge.amountCents);
  if (!Number.isSafeInteger(amount) || amount < 100) throw billingError(400, "invalid_charge_amount");
  const customerId = await ensureCustomer(firebase, user);
  const base = appBaseUrl();
  const session = await stripeRequest("checkout/sessions", {
    mode: "payment",
    customer: customerId,
    client_reference_id: user.uid,
    "line_items[0][price_data][currency]": "brl",
    "line_items[0][price_data][unit_amount]": String(amount),
    "line_items[0][price_data][product_data][name]": String(charge.note || "Cobrança PulseNote").slice(0, 120),
    "line_items[0][quantity]": "1",
    locale: "pt-BR",
    success_url: `${base}/app?billing=charge_success`,
    cancel_url: `${base}/app?billing=cancelled`,
    "metadata[firebase_uid]": user.uid,
    "metadata[charge_id]": id,
    "payment_intent_data[metadata][charge_id]": id,
  });
  return { url: session.url };
}

async function markChargePaid(db, chargeId, uid, providerRef) {
  const ref = db.collection("adminCharges").doc(chargeId);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const charge = snapshot.data();
    if (!snapshot.exists || charge.uid !== uid) return { ignored: true, reason: "charge_not_found" };
    if (charge.status === "paid") return { duplicate: true };
    if (charge.status !== "manual_pending") return { ignored: true, reason: "charge_not_pending" };
    let granted = null;
    if (charge.planId) {
      const entitlementRef = db.collection("adminEntitlements").doc(uid);
      const entitlement = await tx.get(entitlementRef);
      granted = grantFromCharge(entitlement.exists ? entitlement.data() : null, charge);
      if (granted) tx.set(entitlementRef, { ...granted, updatedBy: "stripe" });
    }
    const now = new Date().toISOString();
    tx.update(ref, { status: "paid", paidAt: now, updatedAt: now, provider: "stripe", providerRef: providerRef || null });
    return { chargeId, paid: true, granted };
  });
}

async function createCheckout(firebase, user, planId) {
  const id = String(planId || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(id)) throw billingError(400, "invalid_plan");
  const planSnapshot = await firebase.firestore().collection("adminPlans").doc(id).get();
  const plan = planSnapshot.data();
  if (!planSnapshot.exists || plan.active === false) throw billingError(404, "plan_unavailable");
  if (!plan.stripePriceId) throw billingError(409, "plan_checkout_not_configured");
  const customerId = await ensureCustomer(firebase, user);
  const base = appBaseUrl();
  const session = await stripeRequest("checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.uid,
    "line_items[0][price]": plan.stripePriceId,
    "line_items[0][quantity]": "1",
    allow_promotion_codes: "true",
    billing_address_collection: "auto",
    locale: "pt-BR",
    success_url: `${base}/app?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/app?billing=cancelled`,
    "metadata[firebase_uid]": user.uid,
    "metadata[plan_id]": id,
    "subscription_data[metadata][firebase_uid]": user.uid,
    "subscription_data[metadata][plan_id]": id,
  });
  return { url: session.url };
}

async function createPortal(firebase, user) {
  const customer = await firebase.firestore().collection("billingCustomers").doc(user.uid).get();
  const customerId = customer.data()?.stripeCustomerId;
  if (!customerId) throw billingError(404, "billing_customer_not_found");
  const session = await stripeRequest("billing_portal/sessions", {
    customer: customerId,
    return_url: `${appBaseUrl()}/app`,
  });
  return { url: session.url };
}

function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || !header || !secret) return false;
  const parts = String(header).split(",").map((part) => part.trim().split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > 300 || !signatures.length) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  });
}

function entitlementStatus(stripeStatus) {
  if (["active", "trialing"].includes(stripeStatus)) return "active";
  if (["canceled", "cancelled"].includes(stripeStatus)) return "cancelled";
  return "paused";
}

async function resolveUid(db, object) {
  const metadataUid = object?.metadata?.firebase_uid || object?.client_reference_id;
  if (metadataUid) return String(metadataUid);
  if (!object?.customer) return "";
  const link = await db.collection("billingCustomerLinks").doc(String(object.customer)).get();
  return link.data()?.uid || "";
}

async function applyStripeEvent(firebase, event) {
  const db = firebase.firestore();
  const object = event?.data?.object || {};
  const uid = await resolveUid(db, object);
  const now = new Date().toISOString();
  // Cobrança avulsa (mode=payment). Pix confirma depois: só marca paga
  // quando o Stripe informa payment_status "paid".
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) && object.mode === "payment") {
    const chargeId = String(object.metadata?.charge_id || "");
    if (!uid || !chargeId) return { ignored: true };
    if (object.payment_status !== "paid") return { pending: true, chargeId };
    return markChargePaid(db, chargeId, uid, object.payment_intent || object.id);
  }
  if (["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    const planId = String(object.metadata?.plan_id || "").toLowerCase();
    if (!uid || !/^[a-z0-9_-]{2,40}$/.test(planId)) return { ignored: true };
    const status = event.type === "checkout.session.completed" ? "active" : entitlementStatus(object.status);
    await db.collection("adminEntitlements").doc(uid).set({
      planId,
      status,
      source: "stripe",
      provider: "stripe",
      providerCustomerId: object.customer || null,
      providerSubscriptionId: event.type.startsWith("customer.subscription") ? object.id : object.subscription || null,
      validUntil: null,
      updatedAt: now,
    }, { merge: true });
    return { uid, planId, status };
  }
  if (["invoice.paid", "invoice.payment_failed"].includes(event.type)) {
    if (!uid) return { ignored: true };
    const paid = event.type === "invoice.paid";
    const batch = db.batch();
    batch.set(db.collection("adminCharges").doc(event.id), {
      uid,
      amountCents: Number(paid ? object.amount_paid : object.amount_due) || 0,
      currency: String(object.currency || "brl").toUpperCase(),
      status: paid ? "paid" : "failed",
      source: "stripe",
      providerInvoiceId: object.id || null,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
    batch.set(db.collection("adminEntitlements").doc(uid), { status: paid ? "active" : "paused", updatedAt: now }, { merge: true });
    await batch.commit();
    return { uid, status: paid ? "paid" : "failed" };
  }
  return { ignored: true };
}

async function readRawBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw billingError(413, "payload_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = {
  OFFICIAL_APP_URL,
  appBaseUrl,
  stripeConfigured,
  requireUser,
  publicBillingState,
  createCheckout,
  createChargeCheckout,
  createPortal,
  grantFromCharge,
  maybeStartAutoTrial,
  markChargePaid,
  verifyStripeSignature,
  applyStripeEvent,
  readRawBody,
};
