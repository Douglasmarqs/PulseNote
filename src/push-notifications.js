// push-notifications.js — Notificações "de verdade" via Firebase Cloud
// Messaging (FCM): diferente do notifications.js (que só dispara enquanto
// a aba/app está aberta, via setInterval), este arquivo permite receber
// notificação do sistema mesmo com o PulseNote fechado.
//
// Como as 3 partes se encaixam:
//   1) Aqui: quando a pessoa ativa notificações (mesmo botão de sempre,
//      em notifications.js), pedimos um "token" pro FCM pra ESTE
//      aparelho e salvamos em userData/{uid}.data.fcmTokens.
//   2) sw.js: acorda em segundo plano quando o servidor manda um push, e
//      mostra a notificação (funciona até com o app fechado).
//   3) api/send-reminders.js: roda periodicamente no servidor (ver
//      .github/workflows/send-reminders.yml), olha tarefas/eventos/metas/
//      finanças de cada usuário e dispara o push pros tokens salvos aqui.
//
// É um módulo ES (diferente de notifications.js/pwa-install.js, que são
// scripts comuns) porque precisa importar o SDK do Firebase e reaproveitar
// o `app`/`db`/`auth` já inicializados em firebase-init.js.

import { getMessaging, getToken, onMessage, isSupported }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { doc, updateDoc, arrayUnion, arrayRemove }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { app, db, auth } from "./firebase-init.js";
import { firebaseConfig } from "./firebase-config.js";

const VAPID_KEY = String(firebaseConfig.messagingVapidKey || "").trim();

let messagingInstance = null;
let foregroundListenerAttached = false;

async function ensureMessaging() {
  if (messagingInstance) return messagingInstance;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const supported = await isSupported().catch(() => false);
  if (!supported) return null; // ex.: Firefox no iOS, alguns webviews sem suporte a Push API
  messagingInstance = getMessaging(app);
  attachForegroundListener();
  return messagingInstance;
}

// Com o app ABERTO em primeiro plano, o FCM não mostra a notificação
// sozinho (isso só acontece em segundo plano, dentro do sw.js) — então
// mostramos manualmente aqui, com a mesma cara das notificações locais
// (mesmo ícone/tag/vibração usados em fireNotification(), notifications.js).
function attachForegroundListener() {
  if (foregroundListenerAttached || !messagingInstance) return;
  foregroundListenerAttached = true;
  onMessage(messagingInstance, (payload) => {
    const data = payload.data || {};
    navigator.serviceWorker?.ready.then((reg) => {
      reg.showNotification(data.title || "PulseNote", {
        body: data.body || "",
        icon: "icons/pulsinho-notification-icon.png",
        badge: "icons/pulsinho-notification-icon.png",
        tag: data.tag || "pulsenote-push",
        vibrate: [120, 60, 120],
        data: { view: data.view || "dashboard", itemId: data.itemId || null },
      });
    });
  });
}

async function saveTokenToFirestore(token) {
  const uid = auth.currentUser?.uid;
  if (!uid || !token) return;
  // updateDoc com caminho "data.fcmTokens" mexe SÓ nesse campo aninhado —
  // não sobrescreve o resto de userData/{uid}.data (tarefas, eventos etc.),
  // e continua batendo com a regra do firestore.rules (que só olha as
  // chaves de nível raiz do documento: 'data' e 'updatedAt').
  await updateDoc(doc(db, "userData", uid), {
    "data.fcmTokens": arrayUnion(token),
    updatedAt: new Date().toISOString(),
  });
}

// Chamado pelo notifications.js logo depois que a pessoa concede a
// permissão de notificação do navegador. Retorna true/false (sucesso).
async function enablePushNotifications() {
  try {
    if (!VAPID_KEY) {
      console.warn("Push em segundo plano indisponível: configure firebaseConfig.messagingVapidKey.");
      return false;
    }
    const messaging = await ensureMessaging();
    if (!messaging) return false;
    const registration = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });
    if (!token) return false;
    await saveTokenToFirestore(token);
    return true;
  } catch (err) {
    console.warn("Não foi possível ativar notificações push:", err);
    return false;
  }
}

// Remove o token deste aparelho do Firestore. Hoje nada no app chama isso
// ainda (desativar notificação hoje é só via configuração do navegador),
// mas fica pronto pro dia que houver um botão explícito de "desativar".
async function disablePushNotifications() {
  try {
    const messaging = await ensureMessaging();
    const uid = auth.currentUser?.uid;
    if (!messaging || !uid) return;
    const registration = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    }).catch(() => null);
    if (token) {
      await updateDoc(doc(db, "userData", uid), {
        "data.fcmTokens": arrayRemove(token),
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn("Não foi possível desativar notificações push:", err);
  }
}

// Se a pessoa já tinha ativado notificações numa visita anterior, garante
// que o token continue salvo/atualizado a cada novo login — sem isso, um
// token que expira ou muda (raro, mas acontece) faria a pessoa parar de
// receber push silenciosamente, sem nenhum aviso na tela.
auth.onAuthStateChanged((user) => {
  if (!user) return;
  const alreadyEnabled = "Notification" in window
    && Notification.permission === "granted"
    && localStorage.getItem("pn_notifications_enabled") === "1";
  if (alreadyEnabled) enablePushNotifications();
});

window.PulseNotePush = { enablePushNotifications, disablePushNotifications };
