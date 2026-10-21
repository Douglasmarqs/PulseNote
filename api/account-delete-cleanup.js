"use strict";

const { getAdmin } = require("./_lib/admin");

const SERVER_OWNED_USER_COLLECTIONS = [
  "adminUsage",
];

async function deleteServerOwnedUserData(db, uid) {
  const batch = db.batch();
  for (const collection of SERVER_OWNED_USER_COLLECTIONS) {
    batch.delete(db.collection(collection).doc(uid));
  }
  await batch.commit();
}

module.exports = async function accountDeleteCleanup(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const authorization = req.headers?.authorization || "";
  if (!authorization.startsWith("Bearer ")) return res.status(401).json({ error: "unauthorized" });

  try {
    const firebase = getAdmin();
    const decoded = await firebase.auth().verifyIdToken(authorization.slice(7), true);
    if (!decoded.uid) return res.status(401).json({ error: "unauthorized" });
    await deleteServerOwnedUserData(firebase.firestore(), decoded.uid);
    return res.status(200).json({ ok: true });
  } catch (error) {
    const status = error.code?.startsWith("auth/") ? 401 : 500;
    if (status === 500) console.error("Falha ao limpar dados operacionais da conta:", error);
    return res.status(status).json({ error: status === 500 ? "cleanup_failed" : "unauthorized" });
  }
};

module.exports._test = { SERVER_OWNED_USER_COLLECTIONS, deleteServerOwnedUserData };
