"use strict";

const { getAdmin } = require("./_lib/admin");
const { verifyStripeSignature, applyStripeEvent, readRawBody } = require("./_lib/billing");

module.exports = async function stripeWebhook(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  let eventRef;
  try {
    const rawBody = await readRawBody(req);
    if (!verifyStripeSignature(rawBody, req.headers?.["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: "invalid_signature" });
    }
    const event = JSON.parse(rawBody.toString("utf8"));
    if (!event?.id || !event?.type) return res.status(400).json({ error: "invalid_event" });
    const firebase = getAdmin();
    const db = firebase.firestore();
    eventRef = db.collection("billingWebhookEvents").doc(String(event.id));
    try {
      await eventRef.create({ type: event.type, status: "processing", receivedAt: new Date().toISOString() });
    } catch (error) {
      if (error.code === 6 || error.code === "already-exists") return res.status(200).json({ ok: true, duplicate: true });
      throw error;
    }
    const result = await applyStripeEvent(firebase, event);
    await eventRef.set({ status: "processed", processedAt: new Date().toISOString(), result }, { merge: true });
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (eventRef) await eventRef.delete().catch(() => {});
    console.error("stripe_webhook_failed", { code: error.code || error.message });
    return res.status(Number(error.status) || 500).json({ error: "webhook_failed" });
  }
};

module.exports.config = { api: { bodyParser: false } };
