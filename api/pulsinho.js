const { getFirebaseAdmin } = require("./_lib/firebaseAdmin");
const { buildFinanceForecast } = require("./_lib/financeForecast");
const { askPulsinho } = require("./_lib/pulsinhoAssistant");
const { loadFinanceState } = require("./_lib/financeState");

function bodyOf(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body && typeof req.body === "object" ? req.body : null;
}

function numberParam(value) {
  if (value === undefined || value === null || value === "") return 0;
  const raw = String(value).trim();
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
  if (!token) return res.status(401).json({ error: "unauthorized" });

  try {
    const firebase = getFirebaseAdmin();
    const decoded = await firebase.auth().verifyIdToken(token);
    if (req.method === "GET") {
      const workspaceId = typeof req.query?.workspaceId === "string" ? req.query.workspaceId : undefined;
      const purchaseAmount = numberParam(req.query?.amount);
      if (purchaseAmount === null) return res.status(400).json({ error: "invalid_amount" });
      const { state } = await loadFinanceState(firebase.firestore(), decoded.uid, workspaceId);
      const forecast = buildFinanceForecast(state, {
        workspaceId,
        purchaseAmount,
        purchaseDate: typeof req.query?.purchaseDate === "string" ? req.query.purchaseDate : undefined,
        reserve: req.query?.reserve === undefined ? undefined : numberParam(req.query.reserve),
      });
      return res.status(200).json({ ok: true, forecast });
    }

    const body = bodyOf(req);
    if (!body) return res.status(400).json({ error: "invalid_json" });
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
    const isForecast = req.method === "GET";
    console.error(isForecast ? "finance_forecast_failed" : "pulsinho_request_failed", { code: error?.code || error?.message || "unknown" });
    return res.status(500).json({ error: isForecast ? "forecast_unavailable" : "assistant_unavailable" });
  }
};
