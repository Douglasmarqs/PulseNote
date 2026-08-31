// api/send-reminders.js
// ============================================================
// Roda periodicamente (ver .github/workflows/send-reminders.yml) e
// replica, no servidor, as MESMAS checagens que src/notifications.js já
// faz no navegador (tarefa atrasada/vence hoje, compromisso perto da
// hora, meta quase batida, orçamento no limite) — só que aqui o
// resultado vira um PUSH (Firebase Cloud Messaging) e/ou uma mensagem de
// WhatsApp, que chegam mesmo com o app fechado.
//
// Por que não um Cron Job nativo da Vercel: o plano Hobby só permite
// 1 execução por dia (e olhe lá, só com precisão de "algum minuto dentro
// da hora marcada") — não serve pra lembrete de compromisso, que precisa
// disparar minutos antes do horário certo. Por isso o "relógio" é
// externo: o GitHub Actions do próprio repositório bate nesta rota a
// cada 15 minutos, de graça (ver o workflow).
//
// Idempotência: cada checagem só dispara UMA vez por dia por usuário
// (mesma ideia do alreadyNotifiedToday() do notifications.js), guardada
// em userData/{uid}.data.serverNotifications — sem isso, rodar a cada
// 15 min mandaria a mesma notificação repetida o dia inteiro.
//
// Variáveis de ambiente necessárias (Vercel > Settings > Environment
// Variables):
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
//     — as mesmas já usadas em api/whatsapp-webhook.js
//   REMINDERS_CRON_SECRET
//     — uma string aleatória qualquer (ex.: `openssl rand -hex 32`).
//       Só você e o GitHub Actions precisam saber. Sem ela configurada,
//       este endpoint recusa QUALQUER chamada (retorna 401) — é o que
//       impede um estranho de ficar disparando notificação pros seus
//       usuários só por saber a URL, que é pública.
//   WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN
//     — as mesmas do webhook. Pra alcançar QUALQUER usuário (não só os 5
//       números de teste), o número precisa estar em modo produção
//       (verificação de negócio feita no Meta Business Manager).
//   WHATSAPP_REMINDER_TEMPLATE_NAME / WHATSAPP_REMINDER_TEMPLATE_LANG
//     — nome e idioma (ex.: "pt_BR") de um template aprovado no Meta
//       Business Manager, categoria "Utilidade", com EXATAMENTE UMA
//       variável no corpo (ex.: "🔔 PulseNote: {{1}}"). Sem essa env var,
//       o envio por WhatsApp fica pulado silenciosamente — só o push
//       continua funcionando.
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

// Mesmo bug de sempre com números BR (ver fixBrazilianMobileNumber em
// api/whatsapp-webhook.js): o número salvo em whatsappLinkedPhone chega
// sem o 9º dígito, e a Cloud API exige esse 9 presente pra aceitar o
// envio pro mesmo número.
function fixBrazilianMobileNumber(phone) {
  if (/^55\d{10}$/.test(phone)) {
    const ddd = phone.slice(2, 4);
    const subscriber = phone.slice(4);
    return `55${ddd}9${subscriber}`;
  }
  return phone;
}

// Mensagem "por iniciativa da empresa" (fora da janela de 24h desde a
// última mensagem do usuário) — a Meta EXIGE um template pré-aprovado
// pra isso, texto livre é bloqueado. Ver comentário no topo do arquivo.
async function sendWhatsAppReminder(phone, bodyText) {
  const templateName = process.env.WHATSAPP_REMINDER_TEMPLATE_NAME;
  if (!templateName) return; // template ainda não configurado — pula, sem quebrar o resto
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: fixBrazilianMobileNumber(phone),
        type: "template",
        template: {
          name: templateName,
          language: { code: process.env.WHATSAPP_REMINDER_TEMPLATE_LANG || "pt_BR" },
          components: [{ type: "body", parameters: [{ type: "text", text: bodyText }] }],
        },
      }),
    });
    if (!res.ok) {
      console.error("WhatsApp recusou o lembrete:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Falha de rede ao mandar lembrete por WhatsApp:", err);
  }
}

// Manda o push pra todos os tokens deste usuário de uma vez. Devolve os
// tokens que a Google já considera mortos (app desinstalado, permissão
// revogada faz tempo etc.) pra gente limpar do Firestore.
async function sendPush(fb, tokens, notification) {
  if (!tokens || tokens.length === 0) return { invalidTokens: [] };
  const response = await fb.messaging().sendEachForMulticast({
    tokens,
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
  return { invalidTokens };
}

// ── Checagens — mesma lógica de src/notifications.js, só que lendo o
//    state direto do Firestore (Admin SDK) em vez de window.PulseNoteState.
//    "plain" é a versão sem formatação/emoji, usada como {{1}} do
//    template do WhatsApp.
function buildNotifications(state, todayIso, now) {
  const results = [];
  const isOpen = (item) => item.status !== "Concluida" && item.status !== "Cancelada";

  const tasks = state.tasks || [];
  const overdue = tasks.filter((t) => isOpen(t) && t.dueDate && t.dueDate < todayIso);
  const dueToday = tasks.filter((t) => isOpen(t) && t.dueDate === todayIso);
  if (overdue.length > 0) {
    results.push({
      key: "tasksOverdue",
      title: "⏰ Tarefas atrasadas",
      body: overdue.length === 1 ? `"${overdue[0].title}" está atrasada.` : `Você tem ${overdue.length} tarefas atrasadas.`,
      plain: overdue.length === 1 ? `sua tarefa "${overdue[0].title}" está atrasada.` : `você tem ${overdue.length} tarefas atrasadas.`,
      tag: "tasks-overdue",
      view: "planner",
      itemId: overdue.length === 1 ? overdue[0].id : null,
    });
  } else if (dueToday.length > 0) {
    results.push({
      key: "tasksToday",
      title: "📋 Tarefas para hoje",
      body: dueToday.length === 1 ? `"${dueToday[0].title}" vence hoje.` : `Você tem ${dueToday.length} tarefas vencendo hoje.`,
      plain: dueToday.length === 1 ? `sua tarefa "${dueToday[0].title}" vence hoje.` : `você tem ${dueToday.length} tarefas vencendo hoje.`,
      tag: "tasks-today",
      view: "planner",
      itemId: dueToday.length === 1 ? dueToday[0].id : null,
    });
  }

  (state.events || []).forEach((event) => {
    if (!event.date || !event.time) return;
    const eventDateTime = new Date(`${event.date}T${event.time}`);
    const minutesUntil = (eventDateTime - now) / 60000;
    const reminderMinutes = Number(event.reminder) || 15;
    if (minutesUntil > 0 && minutesUntil <= reminderMinutes) {
      results.push({
        key: `event_${event.id}`,
        title: "📅 Compromisso em breve",
        body: `"${event.title}" às ${event.time}${event.location ? " · " + event.location : ""}`,
        plain: `seu compromisso "${event.title}" é às ${event.time}${event.location ? " (" + event.location + ")" : ""}.`,
        tag: `event-${event.id}`,
        view: "planner",
        itemId: event.id,
      });
    }
  });

  (state.goals || []).forEach((goal) => {
    const percent = goal.target > 0 ? (goal.current / goal.target) * 100 : 0;
    if (percent >= 80 && percent < 100) {
      results.push({
        key: `goal_${goal.id}_almost`,
        title: "🎯 Quase lá!",
        body: `"${goal.title}" está ${Math.round(percent)}% completa. Falta pouco!`,
        plain: `sua meta "${goal.title}" está ${Math.round(percent)}% completa. Falta pouco!`,
        tag: `goal-${goal.id}`,
        view: "planner",
        itemId: goal.id,
      });
    }
  });

  const currentMonthKey = todayIso.slice(0, 7);
  const entries = (state.finances || []).filter((f) => f.date && f.date.startsWith(currentMonthKey));
  const receitas = entries.filter((f) => f.type === "receita").reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const despesas = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + (Number(f.amount) || 0), 0);
  if (receitas > 0) {
    const usedPct = Math.round((despesas / receitas) * 100);
    if (usedPct >= 90) {
      results.push({
        key: "financeCritical",
        title: "💸 Orçamento no limite",
        body: `Você já usou ${usedPct}% das receitas deste mês.`,
        plain: `você já usou ${usedPct}% das receitas deste mês.`,
        tag: "finance-critical",
        view: "finances",
      });
    } else if (usedPct >= 70) {
      results.push({
        key: "financeWarning",
        title: "💰 Atenção ao orçamento",
        body: `Você já usou ${usedPct}% das receitas deste mês.`,
        plain: `você já usou ${usedPct}% das receitas deste mês.`,
        tag: "finance-warning",
        view: "finances",
      });
    }
  }

  return results;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  const authHeader = req.headers.authorization || "";
  const secret = process.env.REMINDERS_CRON_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const fb = getFirebaseAdmin();
  const db = fb.firestore();
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);

  let checked = 0;
  let notified = 0;
  const errors = [];

  try {
    const snap = await db.collection("userData").get();

    for (const docSnap of snap.docs) {
      checked++;
      const uid = docSnap.id;
      const state = docSnap.data()?.data || {};

      const notifications = buildNotifications(state, todayIso, now);
      if (notifications.length === 0) continue;

      const serverNotifications = state.serverNotifications || {};
      const pending = notifications.filter((n) => serverNotifications[n.key] !== todayIso);
      if (pending.length === 0) continue;

      const tokens = Array.isArray(state.fcmTokens) ? state.fcmTokens : [];
      let invalidTokens = [];

      for (const n of pending) {
        try {
          if (tokens.length > 0) {
            const result = await sendPush(fb, tokens, n);
            invalidTokens = invalidTokens.concat(result.invalidTokens);
          }
          if (state.whatsappReminderOptIn && state.whatsappLinkedPhone) {
            await sendWhatsAppReminder(state.whatsappLinkedPhone, n.plain);
          }
          notified++;
        } catch (err) {
          errors.push({ uid, key: n.key, error: err.message });
        }
      }

      // Marca como notificado hoje + remove tokens mortos, tudo numa
      // escrita só. O Admin SDK ignora o firestore.rules (é só pro
      // cliente), então isso funciona mesmo sem mexer nas regras.
      const updates = { updatedAt: new Date().toISOString() };
      pending.forEach((n) => { updates[`data.serverNotifications.${n.key}`] = todayIso; });
      if (invalidTokens.length > 0) {
        updates["data.fcmTokens"] = admin.firestore.FieldValue.arrayRemove(...invalidTokens);
      }
      await docSnap.ref.update(updates);
    }

    return res.status(200).json({ ok: true, checked, notified, errors });
  } catch (err) {
    console.error("Erro ao rodar send-reminders:", err);
    return res.status(500).json({ error: "internal_error" });
  }
};
