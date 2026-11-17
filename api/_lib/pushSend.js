"use strict";

// Envio de notificações push (Firebase Cloud Messaging) para os aparelhos
// de uma pessoa. Usado pelos lembretes (api/send-reminders.js) e pelo botão
// "Enviar teste" da central de notificações (api/pulsinho.js).

// Manda o push pra todos os tokens deste usuário de uma vez. Devolve os
// tokens que a Google já considera mortos (app desinstalado, permissão
// revogada faz tempo etc.) pra gente limpar do Firestore.
async function sendPush(fb, tokens, notification) {
  if (!tokens || tokens.length === 0) return { invalidTokens: [] };
  const response = await fb.messaging().sendEachForMulticast({
    tokens,
    webpush: { headers: { Urgency: "high", TTL: "3600" } },
    // Sempre "data" (nunca "notification") — assim o FCM nunca mostra
    // nada sozinho, e quem decide a aparência é sempre o
    // onBackgroundMessage do sw.js (ou o onMessage do
    // push-notifications.js, se o app estiver aberto).
    data: {
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
      view: notification.view || "dashboard",
      itemId: notification.itemId != null ? String(notification.itemId) : "",
    },
  });
  const invalidTokens = [];
  response.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
        invalidTokens.push(tokens[i]);
      }
    }
  });
  return { invalidTokens, accepted: response.successCount, failed: response.failureCount };
}

const TEST_COOLDOWN_MS = 60 * 1000;
const MAX_TOKENS = 20;

// Push de teste para os aparelhos da própria pessoa (nunca de outra
// conta: o uid vem do token verificado). Limite de 1 envio por minuto.
async function sendTestPush(fb, uid, { now = Date.now() } = {}) {
  const db = fb.firestore();
  const guard = db.collection("pushTests").doc(uid);
  const allowed = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(guard);
    const last = Date.parse(snapshot.data()?.lastAt || 0) || 0;
    if (now - last < TEST_COOLDOWN_MS) return false;
    tx.set(guard, { lastAt: new Date(now).toISOString() }, { merge: true });
    return true;
  });
  if (!allowed) return { ok: false, status: 429, error: "push_test_cooldown" };

  const userRef = db.collection("userData").doc(uid);
  const snapshot = await userRef.get();
  const raw = snapshot.data()?.data?.fcmTokens;
  const tokens = [...new Set((Array.isArray(raw) ? raw : []).filter((t) => typeof t === "string" && t.length > 20 && t.length < 4096))].slice(0, MAX_TOKENS);
  if (!tokens.length) return { ok: false, status: 409, error: "no_push_devices" };

  const result = await sendPush(fb, tokens, {
    title: "🔔 Notificações funcionando",
    body: "Pronto! Os lembretes do PulseNote vão chegar neste aparelho, mesmo com o app fechado.",
    tag: "pulsenote-push-test",
    view: "dashboard",
  });
  if (result.invalidTokens?.length) {
    const { FieldValue } = require("./firebaseAdmin");
    await userRef.update({ "data.fcmTokens": FieldValue.arrayRemove(...result.invalidTokens) }).catch(() => {});
  }
  return { ok: true, devices: tokens.length, accepted: result.accepted || 0, failed: result.failed || 0, removed: result.invalidTokens?.length || 0 };
}

module.exports = { sendPush, sendTestPush, TEST_COOLDOWN_MS };
