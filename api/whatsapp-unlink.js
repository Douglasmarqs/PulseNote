// api/whatsapp-unlink.js
// ============================================================
// Chamado pelo botão "Desvincular" em Configurações > Integrações >
// WhatsApp (src/app.js). Existe como endpoint separado porque a coleção
// `whatsappLinks` é bloqueada para o cliente no firestore.rules (só o
// Admin SDK, usado aqui e em api/whatsapp-webhook.js, consegue
// ler/escrever nela) — o app não tem como apagar o vínculo sozinho.
//
// Variáveis de ambiente: as mesmas FIREBASE_* já usadas em
// parse-transaction.js e whatsapp-webhook.js.
// ============================================================

const admin = require("firebase-admin");

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
  return admin;
}

async function verifyUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) throw new Error("missing_token");

  const fb = getFirebaseAdmin();
  const decoded = await fb.auth().verifyIdToken(token);
  return decoded.uid;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  let uid;
  try {
    uid = await verifyUser(req);
  } catch (err) {
    console.error("Falha na autenticação:", err.message);
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const fb = getFirebaseAdmin();
    const db = fb.firestore();
    const ref = db.collection("userData").doc(uid);

    // Lê o número vinculado ANTES da transação, pra saber qual doc de
    // whatsappLinks apagar (a transação abaixo só mexe em userData).
    const snap = await ref.get();
    const phone = snap.exists ? snap.data()?.data?.whatsappLinkedPhone : null;

    if (phone) {
      await db.collection("whatsappLinks").doc(phone).delete();
    }

    // Mesma técnica de leitura+mescla usada em appendFinanceEntry() e
    // confirmWhatsAppLink() no webhook — preserva o resto do state.
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const current = s.exists ? s.data() : { data: {} };
      const state = current.data || {};
      tx.set(
        ref,
        {
          data: { ...state, whatsappLinkedPhone: null, whatsappLinkCode: null, whatsappLinkCodeExpiresAt: null },
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Erro ao desvincular WhatsApp:", err);
    return res.status(500).json({ error: "unlink_failed" });
  }
};
