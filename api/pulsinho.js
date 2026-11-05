const { getFirebaseAdmin } = require("./_lib/firebaseAdmin");
const { askPulsinho } = require("./_lib/pulsinhoAssistant");
const { loadFinanceState } = require("./_lib/financeState");

function bodyOf(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body && typeof req.body === "object" ? req.body : null;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
  if (!token) return res.status(401).json({ error: "unauthorized" });
  const body = bodyOf(req);
  if (!body) return res.status(400).json({ error: "invalid_json" });

  try {
    const firebase = getFirebaseAdmin();
    const decoded = await firebase.auth().verifyIdToken(token);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : undefined;
    const { state } = await loadFinanceState(firebase.firestore(), decoded.uid, workspaceId);
    const result = await askPulsinho({
      state,
      question: body.question,
      workspaceId,
      providerPreference: ["openai", "anthropic"].includes(body.providerPreference) ? body.providerPreference : state.aiProviderPreference,
    });
    if (!result.ok) return res.status(Number(result.status) || 502).json({ error: result.error || "assistant_unavailable" });
    return res.status(200).json(result);
  } catch (error) {
    const authError = String(error?.code || "").startsWith("auth/");
    if (authError) return res.status(401).json({ error: "unauthorized" });
    if (["space_not_found", "space_forbidden"].includes(error?.code)) return res.status(error.code === "space_forbidden" ? 403 : 404).json({ error: error.code });
    console.error("pulsinho_request_failed", { code: error?.code || error?.message || "unknown" });
    return res.status(500).json({ error: "assistant_unavailable" });
  }
};
