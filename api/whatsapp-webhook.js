// api/whatsapp-webhook.js
// ============================================================
// Ponto de entrada do agente de IA no WhatsApp (WhatsApp Business Cloud
// API, da Meta): a pessoa manda "gastei 45 no mercado" pro número do
// PulseNote, e este webhook lança sozinho em Finanças — mesma ideia do
// exemplo do TaskLine que você mandou.
//
// ⚠️ ESQUELETO FUNCIONAL, AINDA NÃO É PRA PRODUÇÃO. Falta:
//
//   1) Criar um app em developers.facebook.com > WhatsApp, pegar um
//      número de teste, e configurar a URL deste endpoint (depois de
//      publicado, ex.: https://seu-dominio.app/api/whatsapp-webhook)
//      como Webhook lá, junto com WHATSAPP_VERIFY_TOKEN.
//
//   2) VINCULAÇÃO — implementada. A tela Configurações > Integrações >
//      WhatsApp (src/index.html + src/app.js) gera um código de 6
//      dígitos, válido por 10 min, salvo em
//      userData/{uid}.data.whatsappLinkCode. A pessoa manda
//      "vincular 123456" pra este número, o handleLinkCommand() abaixo
//      confirma e cria whatsappLinks/{numero} → { uid }.
//
//   3) Hoje só entende TEXTO. Foto de cupom e áudio têm TODO marcado
//      abaixo — o mesmo Gemini aceita imagem/áudio, só muda o que é
//      mandado no `contents` da chamada.
//
//   4) Diferente do "✨ Lançar por texto" do app (que só PREENCHE o
//      formulário e espera a pessoa confirmar), este webhook LANÇA
//      DIRETO, sem revisão — igual ao TaskLine. Se preferir revisão
//      antes de salvar, dá pra mandar uma mensagem com botões
//      "Confirmar/Editar" em vez de salvar na hora.
//
// Variáveis de ambiente novas (além de GEMINI_API_KEY e FIREBASE_* que
// já existem em parse-transaction.js):
//   WHATSAPP_VERIFY_TOKEN     — string secreta escolhida por você, só
//                               para a etapa de verificação do webhook
//   WHATSAPP_ACCESS_TOKEN     — token permanente do WhatsApp Cloud API
//   WHATSAPP_PHONE_NUMBER_ID  — id do número, gerado pelo Meta
// ============================================================

const admin = require("firebase-admin");
const { parseTransactionText } = require("./_lib/parseTransactionAI");

// Espelha as categorias padrão de src/app.js (expenseCategories /
// incomeCategories) — precisam bater com as do app para os ids que a IA
// escolhe fazerem sentido no Firestore. Se você editar as categorias
// padrão no app, edite aqui também.
const DEFAULT_EXPENSE_CATEGORIES = [
  { id: "moradia", label: "🏠 Moradia" },
  { id: "contas", label: "💡 Contas e Utilidades" },
  { id: "manutencao", label: "🔧 Manutenção e Reparos" },
  { id: "alimentacao", label: "🍔 Restaurante/Delivery" },
  { id: "mercado", label: "🛒 Mercado" },
  { id: "transporte", label: "🚗 Transporte" },
  { id: "combustivel", label: "⛽ Combustível" },
  { id: "saude", label: "💊 Saúde" },
  { id: "academia", label: "🏋️ Academia e Esportes" },
  { id: "beleza", label: "💅 Beleza e Cuidados pessoais" },
  { id: "educacao", label: "📚 Educação" },
  { id: "lazer", label: "🎬 Lazer" },
  { id: "eventos", label: "🎉 Festas e Eventos" },
  { id: "presentes", label: "🎁 Presentes" },
  { id: "roupas", label: "👗 Roupas e Acessórios" },
  { id: "tecnologia", label: "📱 Tecnologia e Eletrônicos" },
  { id: "assinaturas", label: "🔁 Assinaturas" },
  { id: "familia", label: "👶 Filhos e Família" },
  { id: "pet", label: "🐾 Pet" },
  { id: "viagem", label: "✈️ Viagem" },
  { id: "investimentos_desp", label: "💰 Investimentos e Poupança" },
  { id: "emprestimos", label: "🏦 Empréstimos e Dívidas" },
  { id: "impostos", label: "🧾 Impostos e Taxas" },
  { id: "seguros", label: "🛡️ Seguros" },
  { id: "doacoes", label: "🎗️ Doações" },
  { id: "outros", label: "📦 Outros" },
];
const DEFAULT_INCOME_CATEGORIES = [
  { id: "salario", label: "💼 Salário" },
  { id: "freelance", label: "💻 Freelance/Bico" },
  { id: "investimentos", label: "📈 Investimentos" },
  { id: "vendas", label: "🏷️ Vendas" },
  { id: "aluguel_receb", label: "🏠 Aluguel recebido" },
  { id: "reembolso", label: "↩️ Reembolso" },
  { id: "premio", label: "🏆 Prêmio/Sorte" },
  { id: "emprestimo_receb", label: "🤝 Empréstimo recebido" },
  { id: "pensao", label: "👨‍👩‍👧 Pensão/Auxílio" },
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

// Só retorna algo depois que handleLinkCommand() já criou o vínculo.
async function findUidForPhone(fb, phone) {
  const snap = await fb.firestore().collection("whatsappLinks").doc(phone).get();
  return snap.exists ? snap.data().uid : null;
}

// Grava o vínculo confirmado (mesma técnica em duas escritas de
// appendFinanceEntry: lê o doc inteiro, mescla só os campos do vínculo,
// escreve de volta o objeto "data" inteiro — evita apagar outros campos
// que porventura não estejam carregados aqui).
async function confirmWhatsAppLink(fb, uid, phone) {
  const ref = fb.firestore().collection("userData").doc(uid);
  await fb.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : { data: {} };
    const state = current.data || {};
    tx.set(
      ref,
      {
        data: {
          ...state,
          whatsappLinkCode: null,
          whatsappLinkCodeExpiresAt: null,
          whatsappLinkedPhone: phone,
        },
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  });
}

// Trata "vincular 123456" — o único jeito de um número NOVO (ainda sem
// doc em whatsappLinks) virar conhecido pelo webhook. Ver tela
// Configurações > Integrações > WhatsApp em src/index.html, que gera
// esse código de 6 dígitos e grava em userData/{uid}.data.whatsappLinkCode
// (válido por 10 min).
async function handleLinkCommand(fb, phone, text) {
  const match = text.trim().match(/^vincular\s+(\d{4,8})$/i);
  const code = match?.[1];
  if (!code) {
    await sendWhatsAppMessage(phone, 'Pra vincular, mande exatamente: "vincular" seguido do código de 6 dígitos que aparece em Configurações no PulseNote.');
    return;
  }

  const db = fb.firestore();

  const existingLink = await db.collection("whatsappLinks").doc(phone).get();
  if (existingLink.exists) {
    await sendWhatsAppMessage(phone, "Esse número já está vinculado a uma conta do PulseNote ✅");
    return;
  }

  // Índice de campo único (data.whatsappLinkCode) é automático no
  // Firestore — não precisa criar índice composto pra essa query.
  const snap = await db.collection("userData").where("data.whatsappLinkCode", "==", code).get();
  if (snap.empty) {
    await sendWhatsAppMessage(phone, "Código inválido ou já usado. Gere um novo em Configurações > Integrações no PulseNote.");
    return;
  }

  // Extremamente improvável, mas por segurança: se por coincidência mais
  // de uma pessoa tiver esse código pendente ao mesmo tempo, fica com
  // quem gerou por último (expiresAt mais distante no futuro).
  let matchUid = null;
  let matchExpiresAt = 0;
  const now = Date.now();
  snap.forEach((docSnap) => {
    const s = docSnap.data().data || {};
    const expiresAt = s.whatsappLinkCodeExpiresAt ? new Date(s.whatsappLinkCodeExpiresAt).getTime() : 0;
    if (expiresAt > now && expiresAt > matchExpiresAt) {
      matchUid = docSnap.id;
      matchExpiresAt = expiresAt;
    }
  });

  if (!matchUid) {
    await sendWhatsAppMessage(phone, "Esse código expirou (validade de 10 min). Gere um novo em Configurações > Integrações no PulseNote.");
    return;
  }

  await db.collection("whatsappLinks").doc(phone).set({ uid: matchUid, linkedAt: new Date().toISOString() });
  await confirmWhatsAppLink(fb, matchUid, phone);
  await sendWhatsAppMessage(phone, '✅ Vinculado! Agora é só mandar uma mensagem tipo "gastei 45 no mercado" que eu lanço direto em Finanças.');
}

// Categorias fixas + as que o usuário criou (state.customCategories),
// no mesmo formato que buildCategoryPayload() já monta no app.js.
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

// Grava no MESMO documento que o app usa (userData/{uid}.data.finances),
// numa transação — assim não corre o risco de sobrescrever uma edição
// feita ao mesmo tempo pelo app (o app também usa setDoc no documento
// inteiro; a transação garante leitura+escrita atômica).
async function appendFinanceEntry(fb, uid, entry) {
  const ref = fb.firestore().collection("userData").doc(uid);
  await fb.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : { data: {} };
    const state = current.data || {};
    const finances = Array.isArray(state.finances) ? state.finances : [];
    // IMPORTANTE: o app guarda a categoria no campo "category" (não
    // "categoryId" — esse é só o nome usado durante o parsing da IA).
    // Sem esse mapeamento, o lançamento aparece "sem categoria" em
    // gráficos, metas e no detalhamento por categoria dentro do app.
    finances.unshift({
      id: `wa_${Date.now()}`,
      source: "whatsapp",
      createdAt: new Date().toISOString(),
      type: entry.type,
      amount: entry.amount,
      category: entry.categoryId,
      description: entry.description,
      date: entry.date,
    });
    tx.set(ref, { data: { ...state, finances }, updatedAt: new Date().toISOString() }, { merge: true });
  });
}

module.exports = async (req, res) => {
  // ── Verificação do webhook — a Meta chama isso 1x só, ao salvar a
  //    configuração no painel do WhatsApp Business ──────────────────
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

  // A Meta espera 200 rapidamente, mesmo em erro — senão ela reenvia o
  // mesmo evento várias vezes. Por isso o catch abaixo sempre responde
  // 200 (o erro real vai só pro log).
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.status(200).end(); // confirmação de entrega etc — ignora

    const fromPhone = message.from; // formato E.164 sem "+", ex: "5511999999999"
    const fb = getFirebaseAdmin();

    // "vincular 123456" precisa ser tratado ANTES de checar se o número já
    // é conhecido — é justamente para números novos, ainda sem vínculo,
    // que esse comando existe.
    if (message.type === "text" && /^vincular\s+\d{4,8}$/i.test(message.text.body.trim())) {
      await handleLinkCommand(fb, fromPhone, message.text.body);
      return res.status(200).end();
    }

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
      // TODO: usar o fuso horário salvo do usuário, como o app já faz
      // via toLocalIso() — por ora usa a data UTC do servidor.
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

    // TODO — foto do cupom: baixar a mídia com
    //   GET https://graph.facebook.com/v20.0/{message.image.id}
    // (retorna uma url temporária, baixar com o mesmo Authorization
    // Bearer), converter para base64 e mandar pro Gemini como imagem
    // (contents: [{ parts: [{ inlineData: { mimeType, data } }] }]),
    // pedindo o mesmo JSON de saída — depois cai no mesmo
    // appendFinanceEntry() acima.
    //
    // TODO — áudio: mesma ideia de download usando message.audio.id; o
    // Gemini aceita áudio direto e já entende o que foi dito.

    await sendWhatsAppMessage(fromPhone, "Por enquanto eu só entendo texto — foto do cupom e áudio chegam em breve 🙂");
    return res.status(200).end();
  } catch (err) {
    console.error("Erro no webhook do WhatsApp:", err);
    return res.status(200).end();
  }
};
