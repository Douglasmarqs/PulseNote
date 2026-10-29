"use strict";

function safeError(error) {
  return {
    name: String(error?.name || "Error").slice(0, 80),
    code: String(error?.code || "unknown").slice(0, 120),
    message: String(error?.message || "unknown_error")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 240),
  };
}

module.exports = async function diagnosticFirebase(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  let stage = "runtime";
  try {
    const result = { node: process.version };

    stage = "firebase-admin/app";
    const { cert, getApps, initializeApp } = require("firebase-admin/app");

    stage = "firebase-admin/auth";
    const { getAuth } = require("firebase-admin/auth");

    stage = "firebase-admin/firestore";
    const { FieldValue, getFirestore } = require("firebase-admin/firestore");

    stage = "firebase-admin/messaging";
    const { getMessaging } = require("firebase-admin/messaging");

    stage = "environment";
    const projectId = process.env.FIREBASE_PROJECT_ID || "";
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    result.environment = {
      projectId: Boolean(projectId),
      clientEmail: Boolean(clientEmail),
      privateKey: Boolean(privateKey),
    };

    stage = "credential";
    const credential = cert({ projectId, clientEmail, privateKey });

    stage = "initialize-app";
    const app = getApps()[0] || initializeApp({ credential });

    stage = "services";
    getAuth(app);
    getFirestore(app);
    getMessaging(app);
    result.fieldValue = Boolean(FieldValue);

    return res.status(200).json({ ok: true, stage: "complete", ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, stage, error: safeError(error) });
  }
};

