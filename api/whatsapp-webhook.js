const admin = require("firebase-admin");
const { parseTransactionText } = require("./_lib/parseTransactionAI");

const DEFAULT_EXPENSE_CATEGORIES = [
  { id: "alimentacao", label: "🍔 Alimentação" },
  { id: "transporte", label: "🚗 Transporte" },
  { id: "saude", label: "💊 Saúde" },
  { id: "lazer", label: "🎬 Lazer" },
  { id: "educacao", label: "📚 Educação" },
  { id: "moradia", label: "🏠 Moradia" },
  { id: "roupas", label: "👗 Roupas" },
  { id: "assinaturas", label: "🔁 Assinaturas" },
  { id: "outros", label: "📦 Outros" },
];
const DEFAULT_INCOME_CATEGORIES = [
  { id: "salario", label: "💼 Salário" },
  { id: "freelance", label: "💻 Freelance/Bico" },
  { id: "investimentos", label: "📈 Investimentos" },
  { id: "vendas", label: "🏷️ Vendas" },
  { id: "reembolso", label: "↩️ Reembolso" },
  { id: "presente", label: "🎁 Presente/Bônus" },
  { id: "outros_receita", label: "📦 Outros" },
];

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

async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to, text: { body } }),
    });
  } catch (err) {
    console.error("Falha ao responder no WhatsApp:", err);
  }
}

async function findUidForPhone(fb, phone) {
  const snap = await fb.firestore().collection("whatsappLinks").doc(phone).get();
  return snap.exists ? snap.data().uid : null;
}

async function getUserCategories(fb, uid) {
  const doc = await fb.firestore().collection("userData").doc(uid).get();
  const state = doc.exists ? doc.data().data || {} : {};
  const custom = Array.isArray(state.customCategories) ? state.customCategories : [];

  const despesa = [
    ...DEFAULT_EXPENSE_CATEGORIES,
    ...custom.filter((c) => (c.type || "despesa") === "despesa"),
  ].map((c) => ({ id: c.id, type: "despesa", label: c.label }));

  const receita = [
    ...DEFAULT_INCOME_CATEGORIES,
    ...custom.filter((c) => c.type === "receita"),
  ].map((c) => ({ id: c.id, type: "receita", label: c.label }));

  return [...despesa, ...receita];
}

async function appendFinanceEntry(fb, uid, entry) {
  const ref = fb.firestore().collection("userData").doc(uid);
  await fb.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : { data: {} };
    const state = current.data || {};
    const finances = Array.isArray(state.finances) ? state.finances : [];
    finances.unshift({
      id: `wa_${Date.now()}`,
      source: "whatsapp",
      createdAt: new Date().toISOString(),
      ...entry,
    });
    tx.set(ref, { data: { ...state, finances }, updatedAt: new Date().toISOString() }, { merge: true });
  });
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method !== "POST") return res.status(405).end();

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.status(200).end();

    const fromPhone = message.from;
    const fb = getFirebaseAdmin();
    const uid = await findUidForPhone(fb, fromPhone);

    if (!uid) {
      await sendWhatsAppMessage(
        fromPhone,
        "Ainda não reconheço esse número 👋 Abra o PulseNote e vincule seu WhatsApp em Configurações para eu começar a lançar por aqui."
      );
      return res.status(200).end();
    }

    if (message.type === "text") {
      const categories = await getUserCategories(fb, uid);
      const today = new Date().toISOString().slice(0, 10);
      const result = await parseTransactionText({ text: message.text.body, categories, today });

      if (!result.ok) {
        await sendWhatsAppMessage(
          fromPhone,
          'Não consegui entender esse lançamento 🤔 Tenta descrever de outro jeito, tipo "gastei 45 no mercado".'
        );
        return res.status(200).end();
      }

      await appendFinanceEntry(fb, uid, result.entry);
      const { type, amount, description, date } = result.entry;
      await sendWhatsAppMessage(
        fromPhone,
        `✅ Lançado! ${type === "receita" ? "Receita" : "Despesa"} de R$ ${amount.toFixed(2)} — ${description} (${date}).`
      );
      return res.status(200).end();
    }

    await sendWhatsAppMessage(fromPhone, "Por enquanto eu só entendo texto — foto do cupom e áudio chegam em breve 🙂");
    return res.status(200).end();
  } catch (err) {
    console.error("Erro no webhook do WhatsApp:", err);
    return res.status(200).end();
  }
};