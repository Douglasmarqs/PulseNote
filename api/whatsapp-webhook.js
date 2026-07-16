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
//   3) Foto de cupom fiscal — implementada (downloadWhatsAppMedia() +
//      parseTransactionImage()). Falta só ÁUDIO: mesma ideia de
//      download usando message.audio.id — o Gemini aceita áudio direto
//      e já entende o que foi dito.
//
//   4) Diferente do "✨ Lançar por texto" do app (que só PREENCHE o
//      formulário e espera a pessoa confirmar), este webhook LANÇA
//      DIRETO, sem revisão — igual ao TaskLine. Se preferir revisão
//      antes de salvar, dá pra mandar uma mensagem com botões
//      "Confirmar/Editar" em vez de salvar na hora.
//
//   5) Comandos além do lançamento normal (tudo case/acento-insensível):
//      - "apagar último" / "desfazer" → apaga o último lançamento FEITO
//        PELO WHATSAPP (nunca mexe em algo lançado pelo app)
//      - "saldo" / "resumo" / "quanto gastei" → resumo rápido do mês
//        atual (receitas, gastos, saldo), sem precisar abrir o app
//
//   6) Data de "hoje" calculada no fuso de Brasília (getTodayInBrazil),
//      não em UTC — evita lançamento tardio (21h–23:59 em BR) cair com a
//      data do dia seguinte.
//
//   7) Mensagens repetidas da Meta (reenvio por instabilidade de rede)
//      são ignoradas via claimMessageOnce() — sem isso, um reenvio
//      duplicaria o lançamento.
//
// Variáveis de ambiente novas (além de GEMINI_API_KEY e FIREBASE_* que
// já existem em parse-transaction.js):
//   WHATSAPP_VERIFY_TOKEN     — string secreta escolhida por você, só
//                               para a etapa de verificação do webhook
//   WHATSAPP_ACCESS_TOKEN     — token permanente do WhatsApp Cloud API
//   WHATSAPP_PHONE_NUMBER_ID  — id do número, gerado pelo Meta
// ============================================================

const admin = require("firebase-admin");
const { parseTransactionText, parseTransactionImage } = require("./_lib/parseTransactionAI");

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

// A Cloud API tem um bug conhecido com números BR: ela entrega o número
// no webhook (`message.from`) SEM o 9º dígito do celular (ex.:
// "553195361992", 12 dígitos), mas exige esse 9 presente pra aceitar o
// ENVIO de resposta pro mesmo número — sem isso, dá erro #131030
// "Recipient phone number not in allowed list" mesmo com o número
// certinho cadastrado na lista de destinatários.
// Só mexe quando reconhece claramente o padrão BR (55 + DDD + 8 dígitos
// = 12 no total); qualquer outro formato passa direto, sem alteração.
function fixBrazilianMobileNumber(phone) {
  if (/^55\d{10}$/.test(phone)) {
    const ddd = phone.slice(2, 4);
    const subscriber = phone.slice(4);
    return `55${ddd}9${subscriber}`;
  }
  return phone;
}

async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const toFixed = fixBrazilianMobileNumber(to);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to: toFixed, text: { body } }),
    });
    // fetch() só lança exceção em falha de REDE — se a Meta recusar o
    // envio (token sem permissão, número fora da lista de testadores,
    // fora da janela de 24h etc.), ela responde com um corpo de erro
    // normalmente, sem quebrar o fetch. Sem checar res.ok aqui, esse
    // tipo de recusa passava batido, sem log nenhum.
    if (!res.ok) {
      const errBody = await res.text();
      console.error("Meta recusou o envio da mensagem:", res.status, errBody);
    } else {
      // Log de sucesso também — a Meta devolve o id da mensagem quando
      // aceita de verdade. Útil pra confirmar entrega sem precisar do
      // plano pago "Observability Plus" da Vercel pra ver o corpo da
      // chamada externa.
      const okBody = await res.text();
      console.log("Meta aceitou o envio da mensagem:", okBody);
    }
  } catch (err) {
    console.error("Falha de rede ao responder no WhatsApp:", err);
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

// Baixa uma mídia (foto, áudio) mandada pelo WhatsApp. Fluxo em 2 passos,
// exigido pela própria API da Meta: 1) pega a URL temporária do arquivo
// a partir do id da mensagem; 2) baixa o arquivo nessa URL — as duas
// chamadas precisam do mesmo Bearer token, ou a Meta recusa.
// Retorna { base64, mimeType } ou null se algo falhar.
async function downloadWhatsAppMedia(mediaId) {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
    });
    if (!metaRes.ok) {
      console.error("Falha ao pegar URL da mídia:", metaRes.status, await metaRes.text());
      return null;
    }
    const meta = await metaRes.json(); // { url, mime_type, sha256, file_size, id }

    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
    });
    if (!fileRes.ok) {
      console.error("Falha ao baixar arquivo da mídia:", fileRes.status);
      return null;
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    // WhatsApp manda fotos grandes às vezes (até ~5MB) — o Gemini aceita,
    // mas por segurança cortamos um teto folgado pra não estourar o
    // limite de payload da function na Vercel.
    if (buffer.byteLength > 8 * 1024 * 1024) {
      console.error("Mídia grande demais:", buffer.byteLength);
      return null;
    }

    return { base64: buffer.toString("base64"), mimeType: meta.mime_type || "image/jpeg" };
  } catch (err) {
    console.error("Erro inesperado baixando mídia do WhatsApp:", err);
    return null;
  }
}

// Compartilhado entre texto e foto: salva o lançamento e manda a
// confirmação com o emoji da categoria, ou a mensagem de "não entendi"
// se o Gemini não conseguiu extrair nada válido.
async function finishParsedResult({ fb, uid, fromPhone, categories, result, failureMsg }) {
  if (!result.ok) {
    await sendWhatsAppMessage(fromPhone, failureMsg);
    return;
  }

  await appendFinanceEntry(fb, uid, result.entry);
  const { type, amount, description, date, categoryId } = result.entry;

  // Categorias já guardam o emoji como primeiro "token" do label (ex.:
  // "🍔 Restaurante/Delivery") — mesma convenção usada em outros lugares
  // do app (ver renderização de resumo por categoria em src/app.js).
  const categoryLabel = categories.find((c) => c.id === categoryId)?.label || "";
  const categoryEmoji = categoryLabel.trim().split(/\s+/)[0] || (type === "receita" ? "💰" : "💸");

  const confirmMsg = type === "receita"
    ? `✅ ${categoryEmoji} Receita de ${description} adicionada! R$ ${amount.toFixed(2)} (${date}).`
    : `✅ ${categoryEmoji} Gasto com ${description} adicionado! R$ ${amount.toFixed(2)} (${date}).`;
  await sendWhatsAppMessage(fromPhone, confirmMsg);
}

// Data de "hoje" no fuso de Brasília, não em UTC (o servidor da Vercel
// roda em UTC — entre 21h e 23:59 no horário de Brasília, UTC já virou o
// dia seguinte, o que fazia lançamentos tardios caírem com a data errada,
// igual ao bug do toLocalIso() que já existe no app pro mesmo motivo).
function getTodayInBrazil() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

// Evita processar a MESMA mensagem duas vezes — a Meta reenvia o mesmo
// evento quando não recebe 200 rápido o suficiente (ou em qualquer
// instabilidade de rede), o que sem isso duplicaria lançamentos.
// `.create()` do Admin SDK falha se o doc já existe — usamos isso como
// trava atômica: só a primeira chamada "ganha" e processa de verdade.
async function claimMessageOnce(fb, messageId) {
  if (!messageId) return true; // sem id não dá pra checar, deixa passar
  try {
    await fb.firestore().collection("whatsappProcessedMessages").doc(messageId).create({
      processedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    return false; // já existe -> é reenvio, ignora
  }
}

// Tira acentos e caixa pra comparar comandos ("Último" == "ultimo").
function normalizeCommand(text) {
  return text.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const DELETE_COMMANDS = new Set([
  "apagar ultimo", "apagar o ultimo", "apagar ultimo lancamento",
  "apagar o ultimo lancamento", "desfazer", "cancelar ultimo", "apagar",
]);
function isDeleteCommand(norm) {
  return DELETE_COMMANDS.has(norm);
}

function isBalanceCommand(norm) {
  return norm === "saldo" || norm === "meu saldo" || norm === "resumo"
    || norm === "resumo do mes" || norm.startsWith("quanto gastei")
    || norm.startsWith("quanto recebi");
}

// Apaga o lançamento mais recente ENTRE OS FEITOS PELO WHATSAPP (nunca
// mexe em algo que a pessoa lançou pelo próprio app — "apagar último" só
// deve desfazer o que ela acabou de mandar por aqui). Como o app sempre
// usa unshift() (mais novo primeiro), procuramos do topo pra baixo o
// primeiro com source "whatsapp".
async function deleteLastWhatsAppEntry(fb, uid) {
  const ref = fb.firestore().collection("userData").doc(uid);
  let deletedEntry = null;
  await fb.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : { data: {} };
    const state = current.data || {};
    const finances = Array.isArray(state.finances) ? state.finances : [];
    const idx = finances.findIndex((f) => f.source === "whatsapp");
    if (idx === -1) return;
    deletedEntry = finances[idx];
    const newFinances = [...finances.slice(0, idx), ...finances.slice(idx + 1)];
    tx.set(ref, { data: { ...state, finances: newFinances }, updatedAt: new Date().toISOString() }, { merge: true });
  });
  return deletedEntry;
}

// Resumo do mês atual (baseado no fuso de Brasília) — pra responder
// "saldo" sem precisar abrir o app.
async function buildBalanceSummary(fb, uid, todayIso) {
  const doc = await fb.firestore().collection("userData").doc(uid).get();
  const state = doc.exists ? doc.data().data || {} : {};
  const finances = Array.isArray(state.finances) ? state.finances : [];
  const monthPrefix = todayIso.slice(0, 7); // "2026-07"

  let income = 0;
  let expense = 0;
  for (const f of finances) {
    if (typeof f.date !== "string" || !f.date.startsWith(monthPrefix)) continue;
    const amount = Number(f.amount) || 0;
    if (f.type === "receita") income += amount;
    else expense += amount;
  }

  const monthName = new Date(`${monthPrefix}-01T12:00:00`).toLocaleDateString("pt-BR", { month: "long" });
  return { income, expense, balance: income - expense, monthName };
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
    if (!message) {
      // Não é mensagem recebida — é status de entrega (enviado/entregue/
      // lido/FALHOU) de uma mensagem que O PRÓPRIO webhook mandou. Só
      // logamos quando falha de verdade, pra não poluir os logs com
      // "sent"/"delivered"/"read" de cada mensagem enviada.
      const statuses = req.body?.entry?.[0]?.changes?.[0]?.value?.statuses;
      const failed = statuses?.find((s) => s.status === "failed");
      if (failed) {
        console.error("Entrega de mensagem falhou:", JSON.stringify(failed.errors));
      }
      return res.status(200).end();
    }

    const fromPhone = message.from; // formato E.164 sem "+", ex: "5511999999999"
    const fb = getFirebaseAdmin();

    // Reenvio da Meta (mesmo message.id de novo)? Ignora silenciosamente.
    const isFirstTime = await claimMessageOnce(fb, message.id);
    if (!isFirstTime) {
      console.log("Mensagem repetida (reenvio da Meta), ignorando:", message.id);
      return res.status(200).end();
    }

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

    const categories = await getUserCategories(fb, uid);
    const today = getTodayInBrazil();

    if (message.type === "text") {
      const norm = normalizeCommand(message.text.body);

      if (isDeleteCommand(norm)) {
        const deleted = await deleteLastWhatsAppEntry(fb, uid);
        if (!deleted) {
          await sendWhatsAppMessage(fromPhone, "Não achei nenhum lançamento feito por aqui pra apagar 🤷");
        } else {
          const verb = deleted.type === "receita" ? "Receita" : "Gasto";
          await sendWhatsAppMessage(
            fromPhone,
            `🗑️ Apaguei: ${verb} de R$ ${Number(deleted.amount || 0).toFixed(2)} — ${deleted.description || "sem descrição"}.`
          );
        }
        return res.status(200).end();
      }

      if (isBalanceCommand(norm)) {
        const { income, expense, balance, monthName } = await buildBalanceSummary(fb, uid, today);
        const balanceIcon = balance >= 0 ? "✅" : "⚠️";
        await sendWhatsAppMessage(
          fromPhone,
          `📊 Resumo de ${monthName}:\n💰 Receitas: R$ ${income.toFixed(2)}\n💸 Gastos: R$ ${expense.toFixed(2)}\n${balanceIcon} Saldo: R$ ${balance.toFixed(2)}`
        );
        return res.status(200).end();
      }

      const result = await parseTransactionText({ text: message.text.body, categories, today });
      await finishParsedResult({
        fb, uid, fromPhone, categories, result,
        failureMsg: 'Não consegui entender esse lançamento 🤔 Tenta descrever de outro jeito, tipo "gastei 45 no mercado".',
      });
      return res.status(200).end();
    }

    if (message.type === "image") {
      const media = await downloadWhatsAppMedia(message.image.id);
      if (!media) {
        await sendWhatsAppMessage(fromPhone, "Não consegui baixar essa foto 😕 Tenta mandar de novo.");
        return res.status(200).end();
      }

      const result = await parseTransactionImage({
        imageBase64: media.base64,
        mimeType: media.mimeType,
        categories,
        today,
      });
      await finishParsedResult({
        fb, uid, fromPhone, categories, result,
        failureMsg: "Não consegui ler esse cupom 🤔 Tenta uma foto mais nítida, com o valor total visível, ou descreve o gasto em texto mesmo.",
      });
      return res.status(200).end();
    }

    // TODO — áudio: mesma ideia de download usando message.audio.id; o
    // Gemini aceita áudio direto e já entende o que foi dito.

    await sendWhatsAppMessage(fromPhone, "Por enquanto eu só entendo texto e foto de cupom — áudio chega em breve 🙂");
    return res.status(200).end();
  } catch (err) {
    console.error("Erro no webhook do WhatsApp:", err);
    return res.status(200).end();
  }
};
