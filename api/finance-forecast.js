const { getFirebaseAdmin } = require("./_lib/firebaseAdmin");
const { buildFinanceForecast } = require("./_lib/financeForecast");
const { loadFinanceState } = require("./_lib/financeState");

function numberParam(value) {
  if (value === undefined || value === null || value === "") return 0;
  const raw = String(value).trim();
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
  if (!token) return res.status(401).json({ error: "unauthorized" });

  try {
    const firebase = getFirebaseAdmin();
    const decoded = await firebase.auth().verifyIdToken(token);
    const workspaceId = typeof req.query?.workspaceId === "string" ? req.query.workspaceId : undefined;
    const { state } = await loadFinanceState(firebase.firestore(), decoded.uid, workspaceId);
    const purchaseAmount = numberParam(req.query?.amount);
    if (purchaseAmount === null) return res.status(400).json({ error: "invalid_amount" });
    const forecast = buildFinanceForecast(state, {
      workspaceId,
      purchaseAmount,
      purchaseDate: typeof req.query?.purchaseDate === "string" ? req.query.purchaseDate : undefined,
      reserve: req.query?.reserve === undefined ? undefined : numberParam(req.query.reserve),
    });
    return res.status(200).json({ ok: true, forecast });
  } catch (error) {
    const authError = String(error?.code || "").startsWith("auth/");
    if (authError) return res.status(401).json({ error: "unauthorized" });
    if (["space_not_found", "space_forbidden"].includes(error?.code)) return res.status(error.code === "space_forbidden" ? 403 : 404).json({ error: error.code });
    console.error("finance_forecast_failed", { code: error?.code || error?.message || "unknown" });
    return res.status(500).json({ error: "forecast_unavailable" });
  }
};
