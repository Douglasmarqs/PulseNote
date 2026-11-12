"use strict";

const { getAdmin } = require("./_lib/admin");
const { requireUser, publicBillingState, createCheckout, createPortal } = require("./_lib/billing");

module.exports = async function billingApi(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "method_not_allowed" });
  try {
    const firebase = getAdmin();
    const user = await requireUser(req, firebase);
    const action = String(req.query?.action || "status");
    let result;
    if (req.method === "GET" && action === "status") result = await publicBillingState(firebase, user);
    else if (req.method === "POST" && action === "checkout") result = await createCheckout(firebase, user, req.body?.planId);
    else if (req.method === "POST" && action === "portal") result = await createPortal(firebase, user);
    else return res.status(404).json({ error: "unknown_action" });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error("billing_api_failed", { code: error.code || error.message });
    return res.status(status).json({ error: status >= 500 ? "internal_error" : (error.code || error.message) });
  }
};
