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
const { normalizeRuntimeConfig } = require("./_lib/adminConfig");

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

async function verifyUser(req, fb) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) throw new Error("missing_token");

  const decoded = await fb.auth().verifyIdToken(token, true);
  const user = await fb.auth().getUser(decoded.uid);
  if (user.disabled) {
    const error = new Error("account_disabled");
    error.status = 403;
    throw error;
  }
  return decoded.uid;
}

function assertUnlinkAllowed(status, config) {
  if (status?.disabled === true) {
    const error = new Error("account_disabled");
    error.status = 403;
    throw error;
  }
  if (normalizeRuntimeConfig(config).maintenance.enabled) {
    const error = new Error("maintenance");
    error.status = 503;
    throw error;
  }
}

async function unlinkUser(db, uid) {
  const ref = db.collection("userData").doc(uid);
  const statusRef = db.collection("adminUserStatus").doc(uid);
  const configRef = db.collection("systemConfig").doc("global");

  // Verifica os bloqueios e remove os dois lados do vínculo na mesma
  // transação. Assim não sobra um link órfão se uma gravação falhar.
  await db.runTransaction(async (tx) => {
    const [s, statusSnap, configSnap] = await Promise.all([
      tx.get(ref), tx.get(statusRef), tx.get(configRef),
    ]);
    assertUnlinkAllowed(statusSnap.data(), configSnap.data());
    const current = s.exists ? s.data() : { data: {} };
    const state = current.data || {};
    const phone = state.whatsappLinkedPhone;
    if (phone) {
      const linkRef = db.collection("whatsappLinks").doc(phone);
      const link = await tx.get(linkRef);
      // Um número eventualmente reassociado a outra conta não pode ter
      // seu vínculo apagado por um estado antigo desta conta.
      if (link.data()?.uid === uid) tx.delete(linkRef);
    }
    tx.set(
      ref,
      {
        data: { ...state, whatsappLinkedPhone: null, whatsappLinkCode: null, whatsappLinkCodeExpiresAt: null },
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  });
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  let uid;
  let fb;
  try {
    fb = getFirebaseAdmin();
    uid = await verifyUser(req, fb);
  } catch (err) {
    console.error("Falha na autenticação:", err.message);
    return res.status(err.status || 401).json({ error: err.status === 403 ? "account_disabled" : "unauthorized" });
  }

  try {
    await unlinkUser(fb.firestore(), uid);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Erro ao desvincular WhatsApp:", err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : "unlink_failed" });
  }
};

module.exports.assertUnlinkAllowed = assertUnlinkAllowed;
module.exports.verifyUser = verifyUser;
module.exports.unlinkUser = unlinkUser;
