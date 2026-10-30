"use strict";

const { getAdmin } = require("./_lib/admin");

const ALLOWED_AREAS = new Set(["dashboard", "planner", "notes", "finances", "autopilot", "profile", "settings"]);

module.exports = async function usageEvent(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const authorization = req.headers?.authorization || "";
  if (!authorization.startsWith("Bearer ")) return res.status(401).json({ error: "unauthorized" });
  const area = typeof req.body?.area === "string" ? req.body.area.trim().toLowerCase() : "";
  if (!ALLOWED_AREAS.has(area)) return res.status(400).json({ error: "invalid_area" });

  try {
    const firebase = getAdmin();
    const decoded = await firebase.auth().verifyIdToken(authorization.slice(7), true);
    const user = await firebase.auth().getUser(decoded.uid);
    if (user.disabled || !user.emailVerified) return res.status(403).json({ error: "forbidden" });
    const db = firebase.firestore();
    const ref = db.collection("adminUsage").doc(decoded.uid);
    const now = new Date().toISOString();
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const current = snapshot.data() || {};
      const previousArea = ALLOWED_AREAS.has(current.lastArea) ? current.lastArea : "";
      const areaCounts = { ...(current.areaCounts || {}) };
      areaCounts[area] = (Number(areaCounts[area]) || 0) + 1;
      const transitions = { ...(current.transitions || {}) };
      if (previousArea && previousArea !== area) {
        const key = `${previousArea}>${area}`;
        transitions[key] = (Number(transitions[key]) || 0) + 1;
      }
      tx.set(ref, {
        lastSeenAt: now,
        lastArea: area,
        totalViews: (Number(current.totalViews) || 0) + 1,
        areaCounts,
        transitions,
      });
    });
    return res.status(204).end();
  } catch (error) {
    const status = error.code?.startsWith("auth/") ? 401 : 500;
    if (status === 500) console.error("Falha ao registrar uso agregado:", error);
    return res.status(status).json({ error: status === 500 ? "internal_error" : "unauthorized" });
  }
};

module.exports._test = { ALLOWED_AREAS };
