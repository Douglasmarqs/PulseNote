"use strict";

const crypto = require("node:crypto");
const { getAdmin } = require("./admin");

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
  return { uid: user.uid, email: user.email || "", displayName: user.displayName || "" };
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
  const [plansSnapshot, entitlement] = await Promise.all([
    db.collection("adminPlans").where("active", "==", true).limit(50).get(),
    db.collection("adminEntitlements").doc(user.uid).get(),
  ]);
  const plans = plansSnapshot.docs.map((entry) => {
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
  } : { planId: null, status: "unassigned", provider: null, validUntil: null };
  return { configured: stripeConfigured(), plans, subscription };
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
  createPortal,
  verifyStripeSignature,
  applyStripeEvent,
  readRawBody,
};
