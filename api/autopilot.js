const { getFirebaseAdmin } = require("./_lib/firebaseAdmin");
const { listAutopilotSuggestions, executeAutopilotSuggestion } = require("./_lib/autopilotService");
const { checkAutopilotAccess } = require("./_lib/autopilotAccess");

function requestBody(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body && typeof req.body === "object" ? req.body : null;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
  if (!token) return res.status(401).json({ error: "unauthorized" });

  let uid;
  let db;
  try {
    const fb = getFirebaseAdmin();
    uid = (await fb.auth().verifyIdToken(token)).uid;
    db = fb.firestore();
  } catch (error) {
    console.warn("Autopilot authentication failed:", error?.code || error?.message);
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    await checkAutopilotAccess(db, uid);
    if (req.method === "GET") {
      const suggestions = await listAutopilotSuggestions(db, uid);
      return res.status(200).json({ ok: true, suggestions });
    }
    const body = requestBody(req);
    if (!body) return res.status(400).json({ error: "invalid_json" });
    const result = await executeAutopilotSuggestion(db, uid, body);
    return res.status(200).json(result);
  } catch (error) {
    const status = Number(error?.status) || 500;
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    const code = safeStatus < 500 ? (error.code || error.message) : (error.code || "service_unavailable");
    if (safeStatus >= 500) console.error("Autopilot request failed:", error);
    return res.status(safeStatus).json({ error: code });
  }
};
