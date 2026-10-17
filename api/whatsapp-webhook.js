// api/whatsapp-webhook.js
// ============================================================
// Ponto de entrada do assistente de IA no WhatsApp (WhatsApp Business
// Cloud API, da Meta) — o Pulsinho do outro lado da linha: a pessoa
// manda uma mensagem em linguagem natural pro número do PulseNote e
// este webhook entende a intenção e age sozinho: lança gasto/receita,
// cria/conclui/apaga tarefa, cria/busca/apaga anotação, cria/atualiza
// meta, marca compromisso, edita ou busca lançamentos, gera relatório
// e estatísticas, e responde confirmando cada ação.
//
// Status: os fluxos de ponta a ponta (vínculo, lançamento por texto e
// foto, comandos, lembretes) estão implementados e testados
// isoladamente. Falta só a confirmação de negócio no Meta Business
// Manager pro número oficial (+55 31 98773-7048) sair do modo teste —
// sem isso, a Cloud API só entrega mensagem pra números cadastrados
// como testadores (ver histórico do bloqueio #130497 em versões
// anteriores, quando o número de teste era +1).
//
// Segurança: TODA requisição POST precisa vir assinada pela Meta
// (cabeçalho X-Hub-Signature-256, verificado com HMAC-SHA256 usando
// WHATSAPP_APP_SECRET — ver verifyMetaSignature() abaixo). Sem o
// segredo configurado, o endpoint recusa QUALQUER POST (falha fechado,
// não aberto) — sem essa checagem, qualquer pessoa que descobrisse essa
// URL poderia forjar uma mensagem da Meta e mexer nos dados de outro
// usuário só sabendo o telefone dele.
//
// Variáveis de ambiente necessárias (além de GEMINI_API_KEY e
// FIREBASE_* que já existem em parse-transaction.js):
//   WHATSAPP_VERIFY_TOKEN     — string secreta escolhida por você, só
//                               para a etapa de verificação do webhook
//                               (GET, feita 1x pelo painel da Meta)
//   WHATSAPP_ACCESS_TOKEN     — token permanente do WhatsApp Cloud API
//   WHATSAPP_PHONE_NUMBER_ID  — id do número, gerado pelo Meta
//   WHATSAPP_APP_SECRET       — "App Secret" do app criado em
//                               developers.facebook.com (Configurações
//                               básicas) — usado só pra VERIFICAR a
//                               assinatura de cada requisição recebida,
//                               nunca enviado em nenhuma chamada.
//
// Comandos entendidos (tudo em linguagem natural, case/acento-insensível
// — classificados por api/_lib/parseCommandIntent.js):
//   Finanças  — lançar gasto/receita, "editar último", buscar
//               lançamentos, "saldo"/"resumo", "relatório de mês X",
//               estatísticas/comparação entre meses, foto de cupom
//   Tarefas   — criar, concluir, apagar; consultar (hoje/atrasadas/semana)
//   Notas     — criar (conteúdo salvo EXATAMENTE como escrito — ver
//               stripNoteCommandPrefix), buscar, apagar
//   Metas     — criar, atualizar progresso
//   Agenda    — marcar compromisso; consultar compromissos
//   Utilidade — "vincular 123456", "apagar último" (finanças), "ajuda"
//
// Cada ação é sempre confirmada de volta por mensagem — nunca falha em
// silêncio. Mensagens repetidas da Meta (reenvio por instabilidade de
// rede) são ignoradas via claimMessageOnce(). Data de "hoje" sempre no
// fuso de Brasília (getTodayInBrazil), nunca em UTC.
// ============================================================

const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const admin = require("firebase-admin");
const { parseTransactionImage, parseNoteImage, transcribeAudio } = require("./_lib/parseTransactionAI");
const { parseTextIntent, findBestMatch } = require("./_lib/parseCommandIntent");
const { buildPdfReportBuffer } = require("./_lib/buildPdfReport");
const { getRuntimeConfig, assertFeatureEnabled } = require("./_lib/adminConfig");
const { getUserEntitlements } = require("./_lib/admin");
const { listAutopilotSuggestions, executeAutopilotSuggestion } = require("./_lib/autopilotService");
const { findSuggestion, formatSuggestionsForWhatsApp } = require("./_lib/autopilot");
const { checkAutopilotAccess } = require("./_lib/autopilotAccess");
const { META_GRAPH_VERSION } = require("./_lib/metaGraph");
const messageContext = new AsyncLocalStorage();

function logStage(stage, startedAt, messageId) {
  const trace = messageId ? crypto.createHash("sha256").update(messageId).digest("hex").slice(0, 10) : "unknown";
  console.info("whatsapp_stage", { trace, stage, durationMs: Date.now() - startedAt });
}

async function timeStage(stage, messageId, work) {
  const startedAt = Date.now();
  try { return await work(); }
  finally { logStage(stage, startedAt, messageId); }
}

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

// ── Segurança: verificação de assinatura da Meta ───────────────────
// A Cloud API assina todo POST com HMAC-SHA256 do corpo bruto (raw
// bytes, ANTES de qualquer parse), usando o App Secret como chave —
// cabeçalho "X-Hub-Signature-256: sha256=<hex>". Por isso este arquivo
// desliga o bodyParser padrão da Vercel (ver module.exports.config no
// final) e lê o stream bruto ele mesmo: assinar depois de já ter sido
// re-serializado por um JSON.parse()+JSON.stringify() poderia não bater
// mais byte a byte com o que a Meta assinou.
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Compara em tempo constante (timingSafeEqual) — comparar strings de
// assinatura com "===" vazaria, por timing, quantos bytes iniciais
// bateram, o que author malicioso poderia usar pra forjar a assinatura
// byte a byte. FALHA FECHADO: sem WHATSAPP_APP_SECRET configurado,
// recusa tudo (não faz sentido "aceitar sem verificar").
function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  // Buffers de tamanho diferente fariam timingSafeEqual lançar exceção
  // em vez de devolver false — checa antes.
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
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

async function sendWhatsAppPayload(to, payload) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const toFixed = fixBrazilianMobileNumber(to);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(9000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to: toFixed, ...payload }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      console.error("whatsapp_send_failed", { status: res.status, code: error?.error?.code || null });
      if (res.status === 429 || res.status >= 500) throw new Error("meta_transient_failure");
      return false;
    }
    return true;
  } catch (err) {
    console.error("whatsapp_send_failed", { error: err?.name || "network_error" });
    throw err;
  } finally {
    logStage("meta_send", startedAt, messageContext.getStore()?.messageId);
  }
}

async function sendWhatsAppMessage(to, body) {
  const sent = await sendWhatsAppPayload(to, { type: "text", text: { body } });
  if (!sent) throw new Error("meta_message_rejected");
  return true;
}

function buttonFallbackText(body, buttons) {
  const actions = new Set(buttons.map((button) => String(button.id || "").split(":")[1]));
  const reference = String(buttons[0]?.id || "").match(/:(wa_[a-f0-9-]{6,80})$/i)?.[1]?.slice(-6);
  if (!reference) return body;
  if (actions.has("edit") && actions.has("delete")) {
    return `${body}\n\nPara alterar, responda *editar #${reference}*. Para remover, responda *excluir #${reference}*.`;
  }
  if (actions.has("confirm_delete") && actions.has("cancel_delete")) {
    return `${body}\n\nResponda *confirmar exclusão #${reference}* ou *cancelar exclusão #${reference}*.`;
  }
  return body;
}

// Formato de Reply Buttons documentado pelo SDK oficial da Meta:
// https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/interactive/
async function sendWhatsAppButtons(to, body, buttons, footer = "") {
  const interactive = {
    type: "button",
    body: { text: body.slice(0, 1024) },
    action: { buttons: buttons.map(({ id, title }) => ({ type: "reply", reply: { id, title } })) },
  };
  if (footer) interactive.footer = { text: footer.slice(0, 60) };
  const sent = await sendWhatsAppPayload(to, { type: "interactive", interactive });
  if (!sent) return sendWhatsAppMessage(to, buttonFallbackText(body, buttons));
  return true;
}

// Envio de arquivo é em DUAS etapas na API do WhatsApp: primeiro sobe
// os bytes (multipart/form-data) e recebe um "media id" de volta, só
// depois manda uma mensagem do tipo "document" referenciando esse id.
// FormData/Blob são globais nativos do Node usado aqui (18+), não
// precisou de nenhuma lib nova só pra isso.
async function uploadWhatsAppMedia(buffer, filename, mimeType) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`;
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
      body: form,
    });
    if (!res.ok) {
      console.error("Meta recusou o upload do arquivo:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data.id || null;
  } catch (err) {
    console.error("Falha de rede ao subir arquivo pro WhatsApp:", err);
    return null;
  }
}

async function sendWhatsAppDocument(to, mediaId, filename, caption) {
  const sent = await sendWhatsAppPayload(to, {
    type: "document",
    document: { id: mediaId, filename, caption },
  });
  if (!sent) throw new Error("meta_document_rejected");
  return true;
}

// Só retorna algo depois que handleLinkCommand() já criou o vínculo.
async function findUidForPhone(fb, phone) {
  const snap = await fb.firestore().collection("whatsappLinks").doc(phone).get();
  const uid = snap.exists ? snap.data()?.uid : null;
  if (!uid) return null;
  // A exclusão de uma conta pode deixar um vínculo legado para trás
  // (inclusive em versões antigas do app). Nunca recrie userData por
  // mensagem recebida se a identidade correspondente já não existe.
  try {
    const user = await fb.auth().getUser(uid);
    if (user.disabled) return null;
    // O índice do telefone pode ter ficado para trás depois de uma troca
    // feita por uma versão antiga. A fonte da verdade é a conta: um número
    // antigo jamais pode continuar operando só porque ainda possui índice.
    const userSnap = await fb.firestore().collection("userData").doc(uid).get();
    return userSnap.exists && userSnap.data()?.data?.whatsappLinkedPhone === phone ? uid : null;
  } catch (err) {
    if (err?.code === "auth/user-not-found" || err?.code === "auth/invalid-uid") return null;
    throw err;
  }
}

// ── Helper genérico de leitura+mutação+escrita ─────────────────────
// Toda ação disparada pelo WhatsApp que precisa ler o estado do usuário,
// alterá-lo, e escrever de volta segue o MESMO padrão (transação:
// lê o doc inteiro, muda só os campos relevantes, escreve o "data"
// inteiro de volta com merge:true — pra nunca apagar campos que essa
// função nem carregou). Esse helper existe pra não repetir esse padrão
// em cada handler (lançar/editar/apagar finança, tarefa, nota, meta,
// compromisso) — reduz o risco de um deles divergir e introduzir um bug
// sutil de concorrência.
//
// `mutator(state)` recebe uma CÓPIA rasa do estado atual (segura pra
// mutar os arrays de topo direto) e deve devolver:
//   - `undefined` → aborta, NADA é escrito (ex.: item não encontrado)
//   - qualquer outro valor → escreve `state` de volta e devolve esse
//     valor como resultado de withUserData()
async function withUserData(fb, uid, mutator, operationName = "") {
  const ref = fb.firestore().collection("userData").doc(uid);
  const inboundId = messageContext.getStore()?.messageId;
  const operationId = inboundId && operationName
    ? crypto.createHash("sha256").update(`${uid}:${inboundId}:${operationName}`).digest("hex")
    : null;
  const appliedRef = operationId ? fb.firestore().collection("whatsappAppliedOperations").doc(operationId) : null;
  let result;
  await fb.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const applied = appliedRef ? await tx.get(appliedRef) : null;
    if (applied?.exists) {
      result = applied.data().result;
      return;
    }
    const current = snap.exists ? snap.data() : { data: {} };
    const state = { ...(current.data || {}) };
    result = await mutator(state);
    if (result === undefined) return;
    tx.set(ref, { data: state, updatedAt: new Date().toISOString() }, { merge: true });
    if (appliedRef) tx.create(appliedRef, { uid, result, appliedAt: new Date().toISOString() });
  });
  return result;
}

async function getAppliedOperation(fb, uid, messageId, operationName) {
  if (!messageId) return null;
  const id = crypto.createHash("sha256").update(`${uid}:${messageId}:${operationName}`).digest("hex");
  const snap = await fb.firestore().collection("whatsappAppliedOperations").doc(id).get();
  return snap.exists ? snap.data().result : null;
}

async function confirmWhatsAppLink(fb, uid, phone, code) {
  const db = fb.firestore();
  const userRef = db.collection("userData").doc(uid);
  const newLinkRef = db.collection("whatsappLinks").doc(phone);
  const statusRef = db.collection("adminUserStatus").doc(uid);
  return db.runTransaction(async (tx) => {
    const [userSnap, newLinkSnap, statusSnap] = await Promise.all([
      tx.get(userRef), tx.get(newLinkRef), tx.get(statusRef),
    ]);
    if (!userSnap.exists || statusSnap.data()?.disabled === true) return "invalid";
    const state = { ...(userSnap.data()?.data || {}) };
    if (state.whatsappLinkCode !== code ||
        !state.whatsappLinkCodeExpiresAt ||
        new Date(state.whatsappLinkCodeExpiresAt).getTime() <= Date.now()) return "invalid";
    if (newLinkSnap.exists && newLinkSnap.data()?.uid !== uid) {
      // Versões antigas podiam deixar o índice após trocar/desvincular.
      // Só bloqueie um número que ainda consta como ativo na outra conta;
      // um índice órfão pode ser reaproveitado por quem provou possuir o
      // telefone e o novo código de vinculação.
      const previousUid = newLinkSnap.data()?.uid;
      if (typeof previousUid === "string" && previousUid) {
        const previousUser = await tx.get(db.collection("userData").doc(previousUid));
        if (previousUser.exists && previousUser.data()?.data?.whatsappLinkedPhone === phone) {
          return "already_linked";
        }
      }
    }

    const oldPhone = state.whatsappLinkedPhone;
    const oldLinkRef = oldPhone && oldPhone !== phone
      ? db.collection("whatsappLinks").doc(oldPhone) : null;
    const oldLinkSnap = oldLinkRef ? await tx.get(oldLinkRef) : null;
    // Firestore exige todas as leituras antes das escritas. Trocar o índice
    // e o número no usuário numa transação impede a janela de dois números
    // simultaneamente autorizados, inclusive quando há corrida com unlink.
    state.whatsappLinkCode = null;
    state.whatsappLinkCodeExpiresAt = null;
    state.whatsappLinkedPhone = phone;
    if (oldLinkSnap?.data()?.uid === uid) tx.delete(oldLinkRef);
    tx.set(newLinkRef, { uid, linkedAt: new Date().toISOString() });
    tx.set(userRef, { data: state, updatedAt: new Date().toISOString() }, { merge: true });
    return "linked";
  });
}

// Trata "vincular 123456" — o único jeito de um número NOVO (ainda sem
// doc em whatsappLinks) virar conhecido pelo webhook. Ver tela
// Configurações > Integrações > WhatsApp em src/index.html, que gera
// esse código de 6 dígitos e grava em userData/{uid}.data.whatsappLinkCode
// (válido por 10 min). Após confirmar, manda a mensagem de boas-vindas
// completa (WELCOME_MESSAGE) — não só um "ok, vinculado".
async function handleLinkCommand(fb, phone, text) {
  const match = text.trim().match(/^vincular\s+(\d{4,8})$/i);
  const code = match?.[1];
  if (!code) {
    await sendWhatsAppMessage(phone, 'Pra vincular, mande exatamente: "vincular" seguido do código de 6 dígitos que aparece em Configurações no PulseNote.');
    return;
  }

  const db = fb.firestore();

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

  const result = await confirmWhatsAppLink(fb, matchUid, phone, code);
  if (result === "already_linked") {
    await sendWhatsAppMessage(phone, "Esse número já está vinculado a outra conta do PulseNote. Desvincule-o da conta anterior antes de usar este código.");
    return;
  }
  if (result !== "linked") {
    await sendWhatsAppMessage(phone, "Esse código expirou ou já foi usado. Gere um novo em Configurações > Integrações no PulseNote.");
    return;
  }
  await sendWhatsAppMessage(phone, WELCOME_MESSAGE);
}

// Categorias fixas + as que o usuário criou (state.customCategories),
// no mesmo formato que buildCategoryPayload() já monta no app.js.
// Também devolve o ÚLTIMO lançamento financeiro feito por aqui (source
// "whatsapp") com seu timestamp — de graça, já que é o MESMO documento
// que a gente já ia buscar pras categorias, sem leitura extra no
// Firestore. Isso alimenta o classificador de intenção com contexto
// real da "última coisa que a pessoa fez por aqui", pra ele reconhecer
// corrigir/apagar mesmo em mensagens curtas e sem verbo (ex.: "dia 1
// desse mês", "foi ontem") como referência a esse lançamento — em vez de
// tratar cada mensagem como se não houvesse conversa nenhuma antes dela.
async function getUserCategoriesAndContext(fb, uid) {
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

  const categories = [...despesa, ...receita];
  const finances = Array.isArray(state.finances) ? state.finances : [];
  const lastFinanceEntry = finances.find((f) => f.source === "whatsapp") || null;
  const pendingClarification = state.whatsappPendingClarification || null;
  const pendingFinanceEdit = state.whatsappPendingFinanceEdit || null;
  const pendingMediaEntry = state.whatsappPendingMediaEntry || null;

  return { categories, lastFinanceEntry, pendingClarification, pendingFinanceEdit, pendingMediaEntry };
}

// 10 minutos pra responder "qual categoria" antes da pergunta expirar
// — mesma lógica/janela do contexto de "lançamento recente" usado pra
// correção de data (RECENT_CONTEXT_WINDOW_MS em parseCommandIntent.js).
const CLARIFICATION_WINDOW_MS = 10 * 60 * 1000;

async function saveWhatsAppPendingClarification(fb, uid, clarification) {
  return withUserData(fb, uid, (state) => {
    state.whatsappPendingClarification = { ...clarification, createdAt: new Date().toISOString() };
    return true;
  }, "save_clarification");
}

async function clearWhatsAppPendingClarification(fb, uid) {
  return withUserData(fb, uid, (state) => {
    if (state.whatsappPendingClarification) delete state.whatsappPendingClarification;
    return true;
  }, "clear_clarification");
}

async function savePendingMediaEntry(fb, uid, pending) {
  return withUserData(fb, uid, (state) => {
    state.whatsappPendingMediaEntry = { ...pending, createdAt: new Date().toISOString() };
    return state.whatsappPendingMediaEntry;
  }, "save_media_candidate");
}

async function clearPendingMediaEntry(fb, uid) {
  return withUserData(fb, uid, (state) => {
    state.whatsappPendingMediaEntry = null;
    return true;
  }, "clear_media_candidate");
}

function pendingIsFresh(pending, maxAgeMs = 10 * 60 * 1000) {
  const created = Date.parse(pending?.createdAt || "");
  return Number.isFinite(created) && Date.now() - created >= 0 && Date.now() - created <= maxAgeMs;
}

// Tenta casar a resposta da pessoa com uma das opções oferecidas —
// por número ("1", "2)", "opção 3") ou pelo nome da categoria (sem
// acento/emoji, por inclusão parcial pra tolerar "faculdade" batendo
// com "🎓 Faculdade"). Devolve o categoryId escolhido, ou null se a
// mensagem não pareceu uma resposta à pergunta.
function matchClarificationReply(text, options, categories) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return null;

  const numMatch = raw.match(/^(?:op[cç][aã]o\s*)?([1-9])\b/);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }

  // Só tira acento/caixa do texto da PESSOA — nada de cortar "primeira
  // palavra" aqui (isso é só pro emoji do RÓTULO da categoria, abaixo;
  // aplicado na resposta também, cortava a palavra inteira quando ela
  // não tinha espaço nenhum, tipo "educação" virando "").
  const stripAccents = (str) => String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  const stripEmojiPrefix = (str) => stripAccents(str).replace(/^\S+\s*/, "");

  const normText = stripAccents(raw);
  if (!normText) return null;
  for (const id of options) {
    const label = categories.find((c) => c.id === id)?.label || "";
    const normLabel = stripEmojiPrefix(label);
    if (normLabel && (normText.includes(normLabel) || normLabel.includes(normText))) return id;
  }
  return null;
}

// Grava no MESMO documento que o app usa (userData/{uid}.data.finances).
// IMPORTANTE: o app guarda a categoria no campo "category" (não
// "categoryId" — esse é só o nome usado durante o parsing da IA). Sem
// esse mapeamento, o lançamento aparece "sem categoria" em gráficos,
// metas e no detalhamento por categoria dentro do app.
// `rawMessage`: o texto exatamente como a pessoa mandou (ou um marcador
// pra lançamentos por foto) — guardado pra auditoria, nunca reescrito.
async function appendFinanceEntry(fb, uid, entry, rawMessage) {
  return withUserData(fb, uid, (state) => {
    const finances = Array.isArray(state.finances) ? state.finances : (state.finances = []);
    const record = {
      id: `wa_${crypto.randomUUID()}`,
      source: "whatsapp",
      createdAt: new Date().toISOString(),
      type: entry.type,
      amount: entry.amount,
      category: entry.categoryId,
      description: entry.description,
      date: entry.date,
      whatsappRawMessage: rawMessage || "",
      paymentMethod: inferPaymentMethod(rawMessage),
    };
    finances.unshift(record);
    const categoryGoal = (state.finGoals || []).find((goal) => goal.categoryId === entry.categoryId && Number(goal.limit) > 0);
    if (entry.type === "despesa" && categoryGoal) {
      const month = String(entry.date || "").slice(0, 7);
      const spent = finances
        .filter((item) => item.type === "despesa" && item.category === entry.categoryId && String(item.date || "").startsWith(month))
        .reduce((sum, item) => sum + Number(item.amount || 0), 0);
      record.budgetUsagePercent = Math.round((spent / Number(categoryGoal.limit)) * 10000) / 100;
    }
    return record;
  }, "append_finance");
}

// Baixa uma mídia (foto, áudio) mandada pelo WhatsApp. Fluxo em 2 passos,
// exigido pela própria API da Meta: 1) pega a URL temporária do arquivo
// a partir do id da mensagem; 2) baixa o arquivo nessa URL — as duas
// chamadas precisam do mesmo Bearer token, ou a Meta recusa.
// Retorna { base64, mimeType } ou null se algo falhar.
async function downloadWhatsAppMedia(mediaId) {
  if (!/^[a-zA-Z0-9_-]{6,120}$/.test(String(mediaId || ""))) return null;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!metaRes.ok) {
      console.error("whatsapp_media_metadata_failed", { status: metaRes.status });
      return null;
    }
    const meta = await metaRes.json(); // { url, mime_type, sha256, file_size, id }
    const maxBytes = 8 * 1024 * 1024;
    if (Number(meta.file_size) > maxBytes || !/^https:\/\//i.test(String(meta.url || ""))) return null;

    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!fileRes.ok) {
      console.error("Falha ao baixar arquivo da mídia:", fileRes.status);
      return null;
    }
    if (Number(fileRes.headers.get("content-length")) > maxBytes) return null;
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    // WhatsApp manda fotos grandes às vezes (até ~5MB) — o Gemini aceita,
    // mas por segurança cortamos um teto folgado pra não estourar o
    // limite de payload da function na Vercel.
    if (buffer.byteLength > maxBytes) {
      console.error("Mídia grande demais:", buffer.byteLength);
      return null;
    }

    return { base64: buffer.toString("base64"), mimeType: meta.mime_type || "image/jpeg" };
  } catch (err) {
    console.error("whatsapp_media_download_failed", { error: err?.name || "network_error" });
    return null;
  }
}

// A confirmação do WhatsApp mantém o nome da categoria por extenso, mas usa
// o mesmo emoji dela como uma pista visual rápida. Assim a pessoa reconhece
// o tipo do gasto antes mesmo de ler a linha inteira.
function categoryNameForWhatsApp(label, fallback = "Outros") {
  const clean = String(label || "")
    .replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "")
    .trim();
  return clean || fallback;
}

function formatWhatsAppAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return "0,00";
  return amount.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function inferPaymentMethod(rawMessage) {
  const text = String(rawMessage || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\bpix\b/.test(text)) return "Pix";
  if (/\bboleto\b/.test(text)) return "Boleto";
  if (/\b(debito|cartao de debito)\b/.test(text)) return "Cartão de débito";
  if (/\b(credito|cartao|visa|mastercard)\b/.test(text)) return "Cartão de crédito";
  if (/\b(dinheiro|especie)\b/.test(text)) return "Dinheiro";
  if (/\b(transferencia|ted|doc)\b/.test(text)) return "Transferência";
  return "";
}

function isPhotoNoteRequest(caption) {
  const text = String(caption || "").trim();
  // "nota fiscal" é um documento financeiro, não uma anotação pessoal.
  return /^(?:anota(?:r|ção)?|salvar (?:como )?nota)(?:\b|:)/i.test(text)
    || /^nota(?:\s*:.*)?$/i.test(text);
}

function isDestructiveAudioIntent(result) {
  return result?.ok === true && (result.intent === "finance_delete_last"
    || (result.intent === "task_action" && result.task?.action === "delete")
    || (result.intent === "note_action" && result.note?.action === "delete"));
}

function formatWhatsAppFinanceConfirmation(record, entry, categories) {
  const categoryId = record?.category || entry.categoryId;
  const categoryLabel = categories.find((c) => c.id === categoryId)?.label || "";
  const categoryName = categoryNameForWhatsApp(categoryLabel, categoryId || "Outros");
  const reference = String(record?.id || "").replace(/^wa_/, "").slice(-6) || "novo";
  const heading = record?.type === "receita" ? "Nova Receita Registrada!" : "Novo Gasto Registrado!";
  const paymentMethod = record?.paymentMethod || inferPaymentMethod(record?.whatsappRawMessage);
  const budgetLine = Number.isFinite(Number(record?.budgetUsagePercent))
    ? `\n📣 Você já utilizou ${Number(record.budgetUsagePercent).toFixed(2)}% do seu limite mensal.`
    : "";
  return [
    `✅ ${heading}`,
    `📝 Descrição: ${record?.description || entry.description}`,
    `🗂️ Categoria: ${categoryName}`,
    `💸 Valor: R$ ${formatWhatsAppAmount(record?.amount ?? entry.amount)}`,
    `📅 Data: ${formatDateBr(record?.date || entry.date, { includeYear: true })}`,
    `⚙️ ID: #${reference}`,
    paymentMethod ? `💳 Pagamento: ${paymentMethod}` : "",
  ].filter(Boolean).join("\n") + budgetLine;
}

// Compartilhado entre texto e foto: salva o lançamento e manda a
// confirmação organizada, ou a mensagem de "não entendi" se o Gemini não
// conseguiu extrair nada válido.
async function finishParsedResult({ fb, uid, fromPhone, categories, result, failureMsg, rawMessage }) {
  if (!result.ok) {
    await sendWhatsAppMessage(fromPhone, failureMsg);
    return;
  }

  const record = await timeStage("finance_write", messageContext.getStore()?.messageId, () => appendFinanceEntry(fb, uid, result.entry, rawMessage));
  await sendWhatsAppButtons(fromPhone, formatWhatsAppFinanceConfirmation(record, result.entry, categories), [
    { id: `fin:edit:${record.id}`, title: "Editar" },
    { id: `fin:delete:${record.id}`, title: "Excluir" },
  ], "Use os botões para corrigir ou excluir.");
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
  if (!messageId) throw new Error("missing_whatsapp_message_id");
  const ref = fb.firestore().collection("whatsappProcessedMessages").doc(messageId);
  return fb.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    if (snap.exists && snap.data().status === "processed") return "processed";
    if (snap.exists && snap.data().status === "processing" && Number(snap.data().leaseUntil) > now) return "busy";
    tx.set(ref, { status: "processing", leaseUntil: now + 90000, updatedAt: new Date(now).toISOString() }, { merge: true });
    return snap.exists ? "claimed_retry" : "claimed";
  });
}

async function markMessageProcessed(fb, messageId) {
  await fb.firestore().collection("whatsappProcessedMessages").doc(messageId).set({
    status: "processed", leaseUntil: 0, processedAt: new Date().toISOString(),
  }, { merge: true });
}

async function releaseMessageClaim(fb, messageId) {
  await fb.firestore().collection("whatsappProcessedMessages").doc(messageId).set({
    status: "failed", leaseUntil: 0, updatedAt: new Date().toISOString(),
  }, { merge: true });
}

// Tira acentos e caixa pra comparar comandos ("Último" == "ultimo").
function normalizeCommand(text) {
  return text.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Casamento por PADRÃO (verbo + objeto opcional), não mais por lista
// fechada de frases exatas — a lista antiga (Set de frases literais)
// só cobria "apagar ultimo"/"apagar o ultimo"/"apagar ultimo lancamento"
// e nada além disso: "exclua o ultimo gasto", "apagar o ultimo gasto"
// ou qualquer sinônimo (excluir/deletar/remover) caíam fora e iam pro
// classificador de IA, que não tinha nenhuma intenção de "apagar" pra
// devolver — por isso viravam "não entendi". Isso aqui cobre o verbo
// (apagar/apaga/excluir/exclua/deletar/deleta/remover/remove/desfazer/
// cancelar) com "o/a", "ultimo/ultima/penultimo" e o objeto
// (gasto/despesa/receita/lançamento/compra/registro) todos opcionais —
// e qualquer frase que ainda assim escapar disso cai no fallback de IA
// (intent "finance_delete_last" em parseCommandIntent.js), então não
// depende mais só desta lista pra funcionar.
const DELETE_COMMAND_RE = /^(apaga|apagar|exclui|exclua|excluir|deleta|deletar|remove|remover|desfaz|desfazer|cancela|cancelar)(\s+(o|a))?(\s+(ultimo|ultima|penultimo|penultima))?(\s+(gasto|despesa|receita|lancamento|compra|registro))?$/;
function isDeleteCommand(norm) {
  return DELETE_COMMAND_RE.test(norm);
}

function isBalanceCommand(norm) {
  if (norm === "saldo" || norm === "meu saldo" || norm === "resumo" || norm === "resumo do mes") return true;
  // "quanto gastei em julho" é relatório de julho, não o saldo do mês
  // atual. Só atalhamos as perguntas sem período (ou explicitamente
  // sobre este mês); as demais seguem ao parser determinístico/IA.
  return /^quanto (gastei|recebi)( (nesse|neste|esse|este) mes)?[?!. ]*$/.test(norm);
}

// Apaga o lançamento mais recente ENTRE OS FEITOS PELO WHATSAPP (nunca
// mexe em algo que a pessoa lançou pelo próprio app — "apagar último" só
// deve desfazer o que ela acabou de mandar por aqui). Como o app sempre
// usa unshift() (mais novo primeiro), procuramos do topo pra baixo o
// primeiro com source "whatsapp".
async function deleteLastWhatsAppEntry(fb, uid) {
  return withUserData(fb, uid, (state) => {
    const finances = Array.isArray(state.finances) ? state.finances : [];
    const idx = finances.findIndex((f) => f.source === "whatsapp");
    if (idx === -1) return undefined;
    const deletedEntry = finances[idx];
    state.finances = [...finances.slice(0, idx), ...finances.slice(idx + 1)];
    return deletedEntry;
  }, "delete_last_finance");
}

// Corrige o ÚLTIMO lançamento feito pelo WhatsApp com só os campos que
// vieram na intenção "finance_edit_last" (o resto fica como estava).
async function editLastWhatsAppEntry(fb, uid, patch) {
  return withUserData(fb, uid, (state) => {
    const finances = Array.isArray(state.finances) ? state.finances : [];
    const idx = finances.findIndex((f) => f.source === "whatsapp");
    if (idx === -1) return undefined;
    const current = finances[idx];
    const updated = {
      ...current,
      type: patch.type || current.type,
      amount: patch.amount !== undefined ? patch.amount : current.amount,
      category: patch.categoryId || current.category,
      description: patch.description || current.description,
      date: patch.date || current.date,
    };
    finances[idx] = updated;
    return updated;
  }, "edit_last_finance");
}

async function getWhatsAppEntryById(fb, uid, recordId) {
  const snap = await fb.firestore().collection("userData").doc(uid).get();
  const finances = snap.exists && Array.isArray(snap.data()?.data?.finances) ? snap.data().data.finances : [];
  return finances.find((item) => item.id === recordId && item.source === "whatsapp") || null;
}

async function editWhatsAppEntryById(fb, uid, recordId, patch) {
  return withUserData(fb, uid, (state) => {
    const finances = Array.isArray(state.finances) ? state.finances : [];
    const idx = finances.findIndex((item) => item.id === recordId && item.source === "whatsapp");
    if (idx < 0) return undefined;
    const updated = {
      ...finances[idx],
      amount: patch.amount ?? finances[idx].amount,
      description: patch.description || finances[idx].description,
      category: patch.categoryId || finances[idx].category,
      date: patch.date || finances[idx].date,
    };
    finances[idx] = updated;
    state.whatsappPendingFinanceEdit = null;
    return updated;
  }, "edit_finance_by_id");
}

async function deleteWhatsAppEntryById(fb, uid, recordId) {
  return withUserData(fb, uid, (state) => {
    const finances = Array.isArray(state.finances) ? state.finances : [];
    const idx = finances.findIndex((item) => item.id === recordId && item.source === "whatsapp");
    if (idx < 0) return undefined;
    const removed = finances[idx];
    state.finances = finances.filter((item) => item.id !== recordId);
    return removed;
  }, "delete_finance_by_id");
}

async function setPendingFinanceEdit(fb, uid, recordId) {
  return withUserData(fb, uid, (state) => {
    state.whatsappPendingFinanceEdit = { recordId, createdAt: new Date().toISOString() };
    return true;
  }, "pending_finance_edit");
}

async function clearPendingFinanceEdit(fb, uid) {
  return withUserData(fb, uid, (state) => {
    state.whatsappPendingFinanceEdit = null;
    return true;
  }, "clear_finance_edit");
}

function parseFinanceEditReply(text, categories) {
  const raw = String(text || "").trim();
  const patch = {};
  const amountMatch = raw.match(/^(?:valor\s*[:=]?\s*)?(?:r\$\s*)?(\d[\d.,]*)\s*(?:reais?)?$/i);
  if (amountMatch) {
    const amount = require("./_lib/localTextFallback").extractAmountFromText(amountMatch[1]);
    if (Number.isFinite(amount) && amount > 0) patch.amount = amount;
  }
  const descriptionMatch = raw.match(/^descri[cç][aã]o\s*[:=]?\s*(.+)$/i);
  if (descriptionMatch) patch.description = descriptionMatch[1].trim().slice(0, 60);
  const categoryMatch = raw.match(/^categoria\s*[:=]?\s*(.+)$/i);
  if (categoryMatch) {
    const wanted = normalizeCommand(categoryMatch[1]);
    const candidate = categories.find((c) => normalizeCommand(categoryNameForWhatsApp(c.label)) === wanted || normalizeCommand(c.id) === wanted);
    if (candidate) patch.categoryId = candidate.id;
  }
  return Object.keys(patch).length ? patch : null;
}

function parseFinanceReferenceCommand(normalizedText) {
  const match = String(normalizedText || "").match(/^(editar|excluir|confirmar exclusao|cancelar exclusao)\s+#?([a-f0-9]{6})$/);
  if (!match) return null;
  const action = { editar: "edit", excluir: "delete", "confirmar exclusao": "confirm_delete", "cancelar exclusao": "cancel_delete" }[match[1]];
  return { action, reference: match[2] };
}

async function findWhatsAppEntryIdByReference(fb, uid, reference) {
  const snap = await fb.firestore().collection("userData").doc(uid).get();
  const finances = snap.exists && Array.isArray(snap.data()?.data?.finances) ? snap.data().data.finances : [];
  const matches = finances.filter((item) => item.source === "whatsapp" &&
    typeof item.id === "string" && item.id.endsWith(reference));
  return matches.length === 1 ? matches[0].id : null;
}

// Busca lançamentos por palavra-chave (descrição OU categoria), com
// filtro opcional de mês/ano — usado pela intenção "finance_search".
// Só leitura, não passa por withUserData.
async function searchFinanceEntries(fb, uid, { query, month, year }, categories) {
  const doc = await fb.firestore().collection("userData").doc(uid).get();
  const state = doc.exists ? doc.data().data || {} : {};
  const finances = Array.isArray(state.finances) ? state.finances : [];
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const q = norm(query);

  let filtered = finances.filter((f) => {
    const label = categories.find((c) => c.id === f.category)?.label || "";
    return norm(f.description).includes(q) || norm(f.category).includes(q) || norm(label).includes(q);
  });
  if (month && year) {
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    filtered = filtered.filter((f) => typeof f.date === "string" && f.date.startsWith(prefix));
  }
  return filtered.slice(0, 8);
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

// Relatório de UM mês específico (passado ou não) — diferente do
// buildBalanceSummary (que é sempre o mês atual, usado pelo comando
// rápido "saldo"). Além do total, traz os 5 maiores gastos por
// categoria — é o que "relatório do mês passado" pede de verdade, não
// só um número solto. Também é a base de "estatísticas"/comparação.
async function buildMonthlyReport(fb, uid, month, year) {
  const doc = await fb.firestore().collection("userData").doc(uid).get();
  const state = doc.exists ? doc.data().data || {} : {};
  const finances = Array.isArray(state.finances) ? state.finances : [];
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}`;

  const entries = finances.filter((f) => typeof f.date === "string" && f.date.startsWith(monthPrefix));
  let income = 0;
  let expense = 0;
  const byCategory = {};
  for (const f of entries) {
    const amount = Number(f.amount) || 0;
    if (f.type === "receita") {
      income += amount;
    } else {
      expense += amount;
      byCategory[f.category] = (byCategory[f.category] || 0) + amount;
    }
  }

  const topCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const monthName = new Date(`${monthPrefix}-01T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return {
    income, expense, balance: income - expense, monthName, topCategories,
    hasEntries: entries.length > 0, expenseCount: entries.filter((f) => f.type !== "receita").length,
    entries: entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  };
}

function formatMonthlyReport(summary, categories) {
  const { income, expense, balance, monthName, topCategories, hasEntries } = summary;
  if (!hasEntries) return `📊 Não encontrei nenhum lançamento em ${monthName}.`;

  const balanceIcon = balance >= 0 ? "✅" : "⚠️";
  let msg = `📊 Relatório de ${monthName}:\n💰 Receitas: R$ ${formatWhatsAppAmount(income)}\n💸 Gastos: R$ ${formatWhatsAppAmount(expense)}\n${balanceIcon} Saldo: R$ ${formatWhatsAppAmount(balance)}`;
  if (topCategories.length > 0) {
    msg += `\n\nMaiores gastos:`;
    for (const [categoryId, total] of topCategories) {
      const label = categoryNameForWhatsApp(categories.find((c) => c.id === categoryId)?.label, categoryId || "Outros");
      msg += `\n${label}: R$ ${formatWhatsAppAmount(total)}`;
    }
  }
  return msg;
}

// Mensagem de "estatísticas" — sempre mostra o período principal, e se
// a pessoa pediu comparação explícita ("comparado ao mês passado"),
// soma a variação percentual de gasto entre os dois períodos.
function formatStatsMessage(main, compareData) {
  const { income, expense, balance, monthName, hasEntries, expenseCount } = main;
  if (!hasEntries) return `📈 Não encontrei nenhum lançamento em ${monthName} pra calcular estatísticas.`;

  const avgExpense = expenseCount > 0 ? expense / expenseCount : 0;
  const balanceIcon = balance >= 0 ? "✅" : "⚠️";
  let msg = `📈 Estatísticas de ${monthName}:\n💰 Receitas: R$ ${formatWhatsAppAmount(income)}\n💸 Gastos: R$ ${formatWhatsAppAmount(expense)} (${expenseCount} lançamento${expenseCount === 1 ? "" : "s"}, média de R$ ${formatWhatsAppAmount(avgExpense)})\n${balanceIcon} Saldo: R$ ${formatWhatsAppAmount(balance)}`;

  if (compareData && compareData.hasEntries) {
    const diff = expense - compareData.expense;
    const pct = compareData.expense > 0 ? (diff / compareData.expense) * 100 : null;
    const arrow = diff > 0 ? "📈 mais" : diff < 0 ? "📉 menos" : "igual";
    const pctText = pct !== null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)` : "";
    msg += `\n\nComparado a ${compareData.monthName}: gastou R$ ${formatWhatsAppAmount(Math.abs(diff))} ${arrow}${pctText}.`;
  }
  return msg;
}

// includeYear=true pras confirmações de lançamento (o gasto pode ser de
// um mês/ano diferente do atual, então "01/09" sozinho seria ambíguo);
// omitido (padrão) nas listas de tarefa/compromisso/agenda, onde o ano é
// sempre o corrente e só polui a mensagem.
function formatDateBr(iso, { includeYear = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-");
  return includeYear ? `${d}/${m}/${y}` : `${d}/${m}`;
}

// Consulta tarefas/compromissos direto do Firestore (mesma lógica de
// "aberto" usada em api/send-reminders.js: status diferente de
// Concluida/Cancelada) — pra responder "minhas tarefas" sem precisar
// abrir o app.
async function buildAgendaMessage(fb, uid, filter, todayIso) {
  const doc = await fb.firestore().collection("userData").doc(uid).get();
  const state = doc.exists ? doc.data().data || {} : {};
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const events = Array.isArray(state.events) ? state.events : [];
  const isOpen = (t) => t.status !== "Concluida" && t.status !== "Cancelada";
  const weekAheadIso = new Date(new Date(`${todayIso}T00:00:00`).getTime() + 7 * 86400000)
    .toISOString().slice(0, 10);

  let title = "";
  let relevantTasks = [];
  let relevantEvents = [];

  if (filter === "hoje") {
    title = "📋 Hoje";
    relevantTasks = tasks.filter((t) => isOpen(t) && t.dueDate === todayIso);
    relevantEvents = events.filter((e) => e.date === todayIso);
  } else if (filter === "atrasadas") {
    title = "⏰ Tarefas atrasadas";
    relevantTasks = tasks.filter((t) => isOpen(t) && t.dueDate && t.dueDate < todayIso);
  } else if (filter === "semana") {
    title = "📅 Essa semana";
    relevantTasks = tasks.filter((t) => isOpen(t) && t.dueDate && t.dueDate >= todayIso && t.dueDate <= weekAheadIso);
    relevantEvents = events.filter((e) => e.date && e.date >= todayIso && e.date <= weekAheadIso);
  } else {
    title = "🗒️ Suas pendências";
    relevantTasks = tasks.filter(isOpen)
      .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999")).slice(0, 10);
    relevantEvents = events.filter((e) => e.date && e.date >= todayIso)
      .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
  }

  if (relevantTasks.length === 0 && relevantEvents.length === 0) {
    if (filter === "atrasadas") return "✅ Nenhuma tarefa atrasada — tudo em dia!";
    return `${title}: nada por aqui no momento 🎉`;
  }

  let msg = `${title}:`;
  if (relevantTasks.length > 0) {
    msg += `\n\n📌 Tarefas:`;
    for (const t of relevantTasks) {
      msg += `\n• ${t.title}${t.dueDate ? ` (${formatDateBr(t.dueDate)})` : ""}`;
    }
  }
  if (relevantEvents.length > 0) {
    msg += `\n\n📅 Compromissos:`;
    for (const e of relevantEvents) {
      msg += `\n• ${e.title}${e.time ? ` às ${e.time}` : ""} (${formatDateBr(e.date)})`;
    }
  }
  return msg;
}

// ── Tarefas ─────────────────────────────────────────────────────
async function createTaskFromWhatsApp(fb, uid, { title, dueDate, dueTime, reminder, priority }, todayIso, rawMessage) {
  return withUserData(fb, uid, (state) => {
    const tasks = Array.isArray(state.tasks) ? state.tasks : (state.tasks = []);
    const task = {
      id: crypto.randomUUID(),
      title,
      status: "Pendente",
      priority: priority || "Media",
      dueDate: dueDate || "",
      dueTime: dueTime || "",
      reminder: Number.isInteger(reminder) && reminder >= 0 && reminder <= 10080 ? reminder : 15,
      createdAt: todayIso,
      completedAt: "",
      sourceNoteId: "",
      subtasks: [],
      recurrence: null,
      source: "whatsapp",
      whatsappRawMessage: rawMessage || "",
    };
    tasks.unshift(task);
    return task;
  }, "create_task");
}

async function completeTaskByQuery(fb, uid, query, todayIso) {
  return withUserData(fb, uid, (state) => {
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const open = tasks.filter((t) => t.status !== "Concluida" && t.status !== "Cancelada");
    const match = findBestMatch(query, open, "title");
    if (!match) return undefined;
    const idx = tasks.findIndex((t) => t.id === match.id);
    tasks[idx] = { ...tasks[idx], status: "Concluida", completedAt: todayIso };
    return tasks[idx];
  }, "complete_task");
}

async function deleteTaskByQuery(fb, uid, query) {
  return withUserData(fb, uid, (state) => {
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const match = findBestMatch(query, tasks, "title");
    if (!match) return undefined;
    state.tasks = tasks.filter((t) => t.id !== match.id);
    return match;
  }, "delete_task");
}

// ── Notas ───────────────────────────────────────────────────────
// Remove só o prefixo de comando reconhecível ("anota:", "nota -",
// "anotar" etc.) — o RESTO da mensagem é gravado exatamente como veio,
// sem nenhuma reescrita. Se nenhum prefixo bater, usa a mensagem
// inteira como está (mais seguro do que arriscar cortar conteúdo real).
function stripNoteCommandPrefix(rawText) {
  const m = rawText.match(/^\s*(anotar?|nota)\s*[:\-–—]?\s*/i);
  if (m && m[0].length < rawText.length) {
    return rawText.slice(m[0].length).trim();
  }
  return rawText.trim();
}

async function createNoteFromWhatsApp(fb, uid, { title, description }, todayIso, rawMessage) {
  return withUserData(fb, uid, (state) => {
    const notes = Array.isArray(state.notes) ? state.notes : (state.notes = []);
    const note = {
      id: crypto.randomUUID(),
      title: title || description.slice(0, 40),
      description,
      category: "Geral",
      folder: "Entrada",
      tags: [],
      priority: "Media",
      checklist: [],
      attachments: [],
      goal: "",
      observations: "",
      color: "blue",
      favorite: false,
      createdAt: todayIso,
      source: "whatsapp",
      whatsappRawMessage: rawMessage || "",
    };
    notes.unshift(note);
    return note;
  }, "create_note");
}

// Busca (só leitura) por título OU conteúdo — usado por "note_action"
// com action "search". Devolve até 5 resultados, mais recentes primeiro.
async function searchNotes(fb, uid, query) {
  const doc = await fb.firestore().collection("userData").doc(uid).get();
  const state = doc.exists ? doc.data().data || {} : {};
  const notes = Array.isArray(state.notes) ? state.notes : [];
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const q = norm(query);
  if (!q) return [];
  return notes.filter((n) => norm(n.title).includes(q) || norm(n.description).includes(q)).slice(0, 5);
}

async function deleteNoteByQuery(fb, uid, query) {
  return withUserData(fb, uid, (state) => {
    const notes = Array.isArray(state.notes) ? state.notes : [];
    const match = findBestMatch(query, notes, "title")
      || findBestMatch(query, notes, "description");
    if (!match) return undefined;
    state.notes = notes.filter((n) => n.id !== match.id);
    return match;
  }, "delete_note");
}

// ── Metas ───────────────────────────────────────────────────────
async function createGoalFromWhatsApp(fb, uid, { title, target }, rawMessage) {
  return withUserData(fb, uid, (state) => {
    const goals = Array.isArray(state.goals) ? state.goals : (state.goals = []);
    const goal = {
      id: crypto.randomUUID(),
      title,
      target,
      current: 0,
      milestones: [],
      source: "whatsapp",
      whatsappRawMessage: rawMessage || "",
    };
    goals.unshift(goal);
    return goal;
  }, "create_goal");
}

async function updateGoalProgress(fb, uid, { query, mode, value }) {
  return withUserData(fb, uid, (state) => {
    const goals = Array.isArray(state.goals) ? state.goals : [];
    const match = findBestMatch(query, goals, "title");
    if (!match) return undefined;
    const idx = goals.findIndex((g) => g.id === match.id);
    const base = Number(goals[idx].current) || 0;
    const newCurrent = mode === "absolute" ? value : base + value;
    goals[idx] = { ...goals[idx], current: Math.max(0, newCurrent) };
    return goals[idx];
  }, "update_goal");
}

// ── Compromissos ────────────────────────────────────────────────
async function createEventFromWhatsApp(fb, uid, { title, date, time, reminder, location }, rawMessage) {
  return withUserData(fb, uid, (state) => {
    const events = Array.isArray(state.events) ? state.events : (state.events = []);
    const event = {
      id: crypto.randomUUID(),
      title,
      date,
      time,
      location: location || "Sem local",
      reminder: Number.isInteger(reminder) && reminder >= 0 && reminder <= 10080 ? reminder : 15,
      notes: "",
      source: "whatsapp",
      whatsappRawMessage: rawMessage || "",
    };
    events.push(event); // mesmo padrão do saveEvent() no app — push, não unshift
    return event;
  }, "create_event");
}

const HELP_MESSAGE = `🤖 O que eu entendo por aqui (tudo em linguagem natural, não precisa decorar comando):

💸 *Finanças*
"gastei 45 no mercado" / "recebi 200 de freela"
📷 foto de cupom ou comprovante — leio o total; boleto não pago pede confirmação
"errei, era 60 não 45" — corrige o último lançamento
"quanto gastei com uber esse mês" — busca lançamentos
"saldo" / "resumo" — resumo do mês atual
"relatório do mês passado" / "quanto gastei em julho"
"manda o PDF do mês passado" — envia o relatório em PDF
"comparado ao mês passado, gastei mais?" — estatísticas
"apagar último" — desfaz o último lançamento feito por aqui

📋 *Tarefas*
"me lembra de pagar o boleto sexta"
"concluí a tarefa do dentista"
"apaga a tarefa de comprar ração"
"minhas tarefas" / "tarefas de hoje" / "atrasadas" / "da semana"

📝 *Notas*
"anota: ideia pro projeto X é fazer Y" — salvo exatamente como você escreveu
"busca minhas notas sobre viagem"
"apaga a nota do mercado"
📷 foto com legenda "nota" — transcrevo e salvo somente com sua confirmação

🎯 *Metas*
"criar meta economizar 5000 esse ano"
"avancei 200 na minha meta de economia"

📅 *Agenda*
"marca reunião com o cliente sexta às 15h"
"compromissos de hoje" / "da semana"

✨ *Pulse Autopilot*
"autopilot" ou "sugestões" — prioridades reais, sempre com confirmação

Tudo sincronizado direto com o seu painel do PulseNote, e cada ação eu confirmo por aqui mesmo.`;

const WELCOME_MESSAGE = `✅ WhatsApp vinculado ao PulseNote! Eu sou o Pulsinho. Tudo que você criar ou atualizar por aqui aparece no app, e o que estiver no app entra nas minhas consultas. 🎉

${HELP_MESSAGE}`;

async function handleAutopilotText(fb, uid, phone, rawText) {
  const command = normalizeCommand(rawText).replace(/[.!?]+$/g, "").trim();
  const match = command.match(/^(?:autopilot|sugestoes|sugestao)(?:\s+([a-f0-9]{10})(?:\s+(\d))?)?$/);
  if (!match) return false;
  try {
    await checkAutopilotAccess(fb.firestore(), uid);
    const suggestions = await listAutopilotSuggestions(fb.firestore(), uid);
    if (!match[1]) {
      const top = suggestions.slice(0, 3);
      await sendWhatsAppMessage(phone, `${formatSuggestionsForWhatsApp(top)}${top.length ? "\n\nResponda *autopilot CÓDIGO* para ver as ações de uma sugestão." : ""}`);
      return true;
    }
    const suggestion = findSuggestion(suggestions, match[1]);
    if (!suggestion) {
      await sendWhatsAppMessage(phone, "Essa sugestão não está mais disponível. Mande *autopilot* para ver as prioridades atuais.");
      return true;
    }
    if (!match[2]) {
      const choices = suggestion.actionOptions.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
      await sendWhatsAppMessage(phone, `✨ *${suggestion.title}*\n${suggestion.reason}\n\n${choices}\n\nResponda *autopilot ${suggestion.code} 1* (ou outro número) para escolher. Vou pedir confirmação antes de alterar qualquer dado.`);
      return true;
    }
    const option = suggestion.actionOptions[Number(match[2]) - 1];
    if (!option) {
      await sendWhatsAppMessage(phone, `Escolha uma opção válida para *${suggestion.code}*. Mande *autopilot ${suggestion.code}* para ver a lista.`);
      return true;
    }
    await sendWhatsAppButtons(phone, `Confirma “${option.label}” para “${suggestion.title}”?`, [
      { id: `ap:confirm:${suggestion.code}:${option.action}`, title: "Confirmar" },
      { id: `ap:cancel:${suggestion.code}`, title: "Cancelar" },
    ], "Nada muda sem confirmar.");
    return true;
  } catch (error) {
    console.warn("autopilot_whatsapp_failed", { code: error?.code || error?.message || "unknown" });
    await sendWhatsAppMessage(phone, error?.status === 403 || error?.status === 503
      ? "O Pulse Autopilot está indisponível no seu plano ou foi pausado. Você pode continuar usando os demais comandos."
      : "Não consegui abrir as sugestões agora. Tente novamente em instantes.");
    return true;
  }
}

async function handleAutopilotButton(fb, uid, phone, replyId) {
  const cancel = replyId.match(/^ap:cancel:([a-f0-9]{10})$/);
  if (cancel) {
    await sendWhatsAppMessage(phone, "Tudo bem. Não alterei nada.");
    return true;
  }
  const confirm = replyId.match(/^ap:confirm:([a-f0-9]{10}):([a-z_]{3,48})$/);
  if (!confirm) return false;
  try {
    await checkAutopilotAccess(fb.firestore(), uid);
    const result = await executeAutopilotSuggestion(fb.firestore(), uid, {
      suggestionId: confirm[1], action: confirm[2], confirm: true,
    });
    await sendWhatsAppMessage(phone, `✅ ${result.result?.message || "Ação concluída."} Ela já aparece no PulseNote.${result.alreadyExecuted ? " (Essa confirmação já tinha sido aplicada.)" : ""}`);
  } catch (error) {
    console.warn("autopilot_whatsapp_action_failed", { code: error?.code || error?.message || "unknown" });
    await sendWhatsAppMessage(phone, error?.status === 409
      ? "Essa sugestão mudou ou já foi resolvida. Mande *autopilot* para atualizar a lista."
      : "Não consegui aplicar essa ação agora. Nenhuma alteração foi confirmada; tente novamente depois.");
  }
  return true;
}

async function handleFinanceButton(fb, uid, phone, replyId, categories) {
  const match = replyId.match(/^fin:(edit|delete|confirm_delete|cancel_delete):(wa_[a-zA-Z0-9-]{6,80})$/);
  if (!match) return false;
  const [, action, recordId] = match;
  if (action === "cancel_delete") {
    await sendWhatsAppMessage(phone, "Tudo bem. O lançamento continua salvo.");
    return true;
  }
  const record = await getWhatsAppEntryById(fb, uid, recordId);
  if (!record) {
    await sendWhatsAppMessage(phone, "Não encontrei esse lançamento na sua conta. Ele pode ter sido removido pelo aplicativo.");
    return true;
  }
  if (action === "edit") {
    await setPendingFinanceEdit(fb, uid, recordId);
    await sendWhatsAppMessage(phone, `✏️ O que deseja mudar em “${record.description}”? Responda *valor 10,90*, *descrição Nova descrição* ou *categoria Transporte*. Mande *cancelar edição* para sair.`);
    return true;
  }
  if (action === "delete") {
    await sendWhatsAppButtons(phone, `Excluir definitivamente “${record.description}” (R$ ${formatWhatsAppAmount(record.amount)})?`, [
      { id: `fin:confirm_delete:${recordId}`, title: "Sim, excluir" },
      { id: `fin:cancel_delete:${recordId}`, title: "Cancelar" },
    ]);
    return true;
  }
  const removed = await deleteWhatsAppEntryById(fb, uid, recordId);
  await sendWhatsAppMessage(phone, removed
    ? `🗑️ Excluí “${removed.description}” (R$ ${formatWhatsAppAmount(removed.amount)}). A alteração já aparece no app.`
    : "Esse lançamento já não está mais na sua conta.");
  return true;
}

async function handleMediaButton(fb, uid, phone, replyId, pending, categories, today) {
  const match = replyId.match(/^media:(save|task|note|cancel):([a-f0-9]{10})$/);
  if (!match) return false;
  const [, action, token] = match;
  if (!pendingIsFresh(pending) || pending.token !== token) {
    await sendWhatsAppMessage(phone, "Essa foto expirou ou foi substituída. Envie o arquivo novamente para continuar.");
    return true;
  }
  if (action === "cancel") {
    await clearPendingMediaEntry(fb, uid);
    await sendWhatsAppMessage(phone, "Certo. Não salvei nada dessa imagem.");
    return true;
  }
  if (action === "note" && pending.note) {
    const note = await createNoteFromWhatsApp(fb, uid, pending.note, today, "[foto de anotação]");
    await clearPendingMediaEntry(fb, uid);
    await sendWhatsAppMessage(phone, `✅ 📝 Nota “${note.title}” salva. Confira a transcrição no aplicativo.`);
    return true;
  }
  if (action === "task" && pending.entry) {
    const title = `Pagar ${pending.entry.description} (R$ ${formatWhatsAppAmount(pending.entry.amount)})`;
    const task = await createTaskFromWhatsApp(fb, uid, {
      title, dueDate: pending.assessment?.dueDate || "", priority: "Media",
    }, today, "[boleto recebido por foto/PDF]");
    await clearPendingMediaEntry(fb, uid);
    await sendWhatsAppMessage(phone, `✅ Tarefa “${task.title}” criada${task.dueDate ? ` para ${formatDateBr(task.dueDate)}` : " sem vencimento legível — defina a data no Planner para receber lembrete"}. Não registrei o boleto como pago.`);
    return true;
  }
  if (action === "save" && pending.entry) {
    const record = await appendFinanceEntry(fb, uid, pending.entry, pending.rawMessage || "[foto/PDF confirmado]");
    await clearPendingMediaEntry(fb, uid);
    await sendWhatsAppButtons(phone, formatWhatsAppFinanceConfirmation(record, pending.entry, categories), [
      { id: `fin:edit:${record.id}`, title: "Editar" },
      { id: `fin:delete:${record.id}`, title: "Excluir" },
    ]);
    return true;
  }
  await sendWhatsAppMessage(phone, "Essa opção não corresponde ao arquivo recebido. Envie a foto novamente.");
  return true;
}

module.exports = async (req, res) => {
  // ── Verificação do webhook — a Meta chama isso 1x só, ao salvar a
  //    configuração no painel do WhatsApp Business. Não é assinado
  //    (não tem corpo), então não passa pela verificação de HMAC abaixo.
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

  // ── Verificação de assinatura (ver comentário no topo do arquivo) ──
  const rawBody = await readRawBody(req);
  const signature = req.headers["x-hub-signature-256"];
  if (!verifyMetaSignature(rawBody, signature, process.env.WHATSAPP_APP_SECRET)) {
    console.error("Webhook do WhatsApp: assinatura ausente/inválida (ou WHATSAPP_APP_SECRET não configurado) — recusando.");
    return res.status(401).end();
  }

  let body;
  try {
    body = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch (err) {
    console.error("Webhook do WhatsApp: corpo não é JSON válido.");
    return res.status(400).end();
  }

  let claimedMessageId = null;
  let fbForMessage = null;
  const inboundStartedAt = Date.now();
  const respondOk = async () => {
    if (claimedMessageId) await markMessageProcessed(fbForMessage, claimedMessageId);
    logStage("total", inboundStartedAt, claimedMessageId);
    return res.status(200).end();
  };
  try {
    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) {
      // Não é mensagem recebida — é status de entrega (enviado/entregue/
      // lido/FALHOU) de uma mensagem que O PRÓPRIO webhook mandou. Só
      // logamos quando falha de verdade, pra não poluir os logs com
      // "sent"/"delivered"/"read" de cada mensagem enviada.
      const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
      const failed = statuses?.find((s) => s.status === "failed");
      if (failed) {
        console.error("Entrega de mensagem falhou:", JSON.stringify(failed.errors));
      }
      return respondOk();
    }

    const fromPhone = message.from; // formato E.164 sem "+", ex: "5511999999999"
    const fb = getFirebaseAdmin();
    fbForMessage = fb;

    const claim = await timeStage("dedup_claim", message.id, () => claimMessageOnce(fb, message.id));
    if (claim === "processed") {
      return respondOk();
    }
    if (claim === "busy") return res.status(503).end();
    claimedMessageId = message.id;
    messageContext.enterWith({ messageId: message.id });

    const runtimeConfig = await timeStage("runtime_config", message.id, () => getRuntimeConfig(fb.firestore()));
    try {
      assertFeatureEnabled(runtimeConfig, "whatsapp");
    } catch (error) {
      await sendWhatsAppMessage(fromPhone, error.code === "maintenance"
        ? runtimeConfig.maintenance.message
        : "O atendimento pelo WhatsApp está temporariamente indisponível. Você pode continuar usando o PulseNote pelo aplicativo.");
      return respondOk();
    }

    // "vincular 123456" precisa ser tratado ANTES de checar se o número já
    // é conhecido — é justamente para números novos, ainda sem vínculo,
    // que esse comando existe.
    if (message.type === "text" && /^vincular\s+\d{4,8}$/i.test(message.text.body.trim())) {
      await handleLinkCommand(fb, fromPhone, message.text.body);
      return respondOk();
    }

    const uid = await timeStage("find_user", message.id, () => findUidForPhone(fb, fromPhone));

    if (!uid) {
      await sendWhatsAppMessage(
        fromPhone,
        "Ainda não reconheço esse número 👋 Abra o PulseNote e vincule seu WhatsApp em Configurações para eu começar a lançar por aqui."
      );
      return respondOk();
    }

    // Reaproveita a configuração já carregada e lê o plano uma só vez.
    // Antes, cada mensagem repetia configuração + plano para WhatsApp e IA.
    const entitlement = await timeStage("user_entitlements", message.id, () => getUserEntitlements(fb.firestore(), uid));
    const canUse = (feature) => runtimeConfig.features[feature] === true && (entitlement.status === "unassigned"
      || (entitlement.status === "active" && entitlement.features[feature] === true));
    if (!canUse("whatsapp")) {
      await sendWhatsAppMessage(fromPhone, "O WhatsApp não está disponível no seu plano ou está pausado. Confira seu plano no PulseNote.");
      return respondOk();
    }
    const aiEnabled = canUse("aiParsing");

    const { categories, lastFinanceEntry, pendingClarification, pendingFinanceEdit, pendingMediaEntry } =
      await timeStage("load_user_context", message.id, () => getUserCategoriesAndContext(fb, uid));
    const today = getTodayInBrazil();

    // Voz usa o mesmo roteador de intenções do texto. Assim tarefas, notas,
    // metas e compromissos ditados não ficam presos ao caminho de finanças.
    if (message.type === "audio") {
      if (!aiEnabled) {
        await sendWhatsAppMessage(fromPhone, "A leitura de áudio está pausada no seu plano. Envie seu comando em texto por enquanto.");
        return respondOk();
      }
      const media = await timeStage("audio_download", message.id, () => downloadWhatsAppMedia(message.audio?.id));
      if (!media) {
        await sendWhatsAppMessage(fromPhone, "Não consegui baixar esse áudio 😕 Tente enviar novamente.");
        return respondOk();
      }
      const transcription = await timeStage("audio_transcribe", message.id, () => transcribeAudio({ audioBase64: media.base64, mimeType: media.mimeType }));
      if (!transcription.ok) {
        await sendWhatsAppMessage(fromPhone, "Não consegui entender esse áudio 😕 Tente falar mais perto do microfone ou envie o comando em texto.");
        return respondOk();
      }
      message.type = "text";
      message.text = { body: transcription.transcript };
      message.wasAudio = true;
    }

    if (claim === "claimed_retry") {
      const priorEntry = await getAppliedOperation(fb, uid, message.id, "append_finance");
      if (priorEntry) {
        await sendWhatsAppButtons(fromPhone, formatWhatsAppFinanceConfirmation(priorEntry, priorEntry, categories), [
          { id: `fin:edit:${priorEntry.id}`, title: "Editar" }, { id: `fin:delete:${priorEntry.id}`, title: "Excluir" },
        ], "Use os botões para corrigir ou excluir.");
        return respondOk();
      }
    }

    if (message.type === "interactive" || message.type === "button") {
      const replyId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || message.button?.payload || "";
      if (await handleAutopilotButton(fb, uid, fromPhone, replyId)) return respondOk();
      if (await handleFinanceButton(fb, uid, fromPhone, replyId, categories)) return respondOk();
      if (await handleMediaButton(fb, uid, fromPhone, replyId, pendingMediaEntry, categories, today)) return respondOk();
      await sendWhatsAppMessage(fromPhone, "Não reconheci esse botão. Mande *ajuda* para ver o que posso fazer.");
      return respondOk();
    }

    if (message.type === "text") {
      const rawText = message.text.body;
      const norm = normalizeCommand(rawText);
      const referenceCommand = parseFinanceReferenceCommand(norm);

      if (message.wasAudio && (isDeleteCommand(norm) || ["delete", "confirm_delete"].includes(referenceCommand?.action))) {
        await sendWhatsAppMessage(fromPhone, "Por segurança, digite o comando para excluir um lançamento. Não apaguei nada a partir do áudio.");
        return respondOk();
      }

      if (referenceCommand) {
        const recordId = await findWhatsAppEntryIdByReference(fb, uid, referenceCommand.reference);
        if (!recordId) {
          await sendWhatsAppMessage(fromPhone, "Não encontrei uma referência única para esse lançamento. Confira o ID na confirmação ou use os botões da mensagem original.");
        } else {
          await handleFinanceButton(fb, uid, fromPhone, `fin:${referenceCommand.action}:${recordId}`, categories);
        }
        return respondOk();
      }

      if (await handleAutopilotText(fb, uid, fromPhone, rawText)) return respondOk();

      if (pendingFinanceEdit && pendingIsFresh(pendingFinanceEdit)) {
        if (/^cancelar (?:edicao|edição)$/.test(norm)) {
          await clearPendingFinanceEdit(fb, uid);
          await sendWhatsAppMessage(fromPhone, "Edição cancelada. O lançamento continua como estava.");
          return respondOk();
        }
        const patch = parseFinanceEditReply(rawText, categories);
        if (patch) {
          const updated = await editWhatsAppEntryById(fb, uid, pendingFinanceEdit.recordId, patch);
          if (updated) {
            await sendWhatsAppButtons(fromPhone, formatWhatsAppFinanceConfirmation(updated, updated, categories), [
              { id: `fin:edit:${updated.id}`, title: "Editar" },
              { id: `fin:delete:${updated.id}`, title: "Excluir" },
            ]);
          } else {
            await clearPendingFinanceEdit(fb, uid);
            await sendWhatsAppMessage(fromPhone, "Não encontrei esse lançamento para editar. Ele pode ter sido removido no app.");
          }
          return respondOk();
        }
      }

      // Resposta a uma pergunta de "qual categoria" feita há pouco —
      // resolve isso ANTES de tratar a mensagem como um comando novo.
      // Se já expirou ou não bateu com nenhuma opção oferecida, limpa
      // a pendência em silêncio e segue o fluxo normal (não trava a
      // pessoa numa pergunta velha que ela pode nem lembrar mais).
      if (pendingClarification && pendingClarification.createdAt) {
        const ageMs = Date.now() - new Date(pendingClarification.createdAt).getTime();
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= CLARIFICATION_WINDOW_MS) {
          const matchedId = matchClarificationReply(rawText, pendingClarification.options, categories);
          if (matchedId) {
            await clearWhatsAppPendingClarification(fb, uid);
            await finishParsedResult({
              fb, uid, fromPhone, categories,
              result: { ok: true, intent: "expense", entry: { ...pendingClarification.entry, categoryId: matchedId } },
              failureMsg: "",
              rawMessage: rawText,
            });
            return respondOk();
          }
        }
        await clearWhatsAppPendingClarification(fb, uid);
      }

      if (isDeleteCommand(norm)) {
        const deleted = await deleteLastWhatsAppEntry(fb, uid);
        if (!deleted) {
          await sendWhatsAppMessage(fromPhone, "Não achei nenhum lançamento feito por aqui pra apagar 🤷");
        } else {
          const verb = deleted.type === "receita" ? "Receita" : "Gasto";
          await sendWhatsAppMessage(
            fromPhone,
            `🗑️ Apaguei: ${verb} de R$ ${formatWhatsAppAmount(deleted.amount)} — ${deleted.description || "sem descrição"}.`
          );
        }
        return respondOk();
      }

      if (isBalanceCommand(norm)) {
        const { income, expense, balance, monthName } = await buildBalanceSummary(fb, uid, today);
        const balanceIcon = balance >= 0 ? "✅" : "⚠️";
        await sendWhatsAppMessage(
          fromPhone,
          `📊 Resumo de ${monthName}:\n💰 Receitas: R$ ${formatWhatsAppAmount(income)}\n💸 Gastos: R$ ${formatWhatsAppAmount(expense)}\n${balanceIcon} Saldo: R$ ${formatWhatsAppAmount(balance)}`
        );
        return respondOk();
      }

      const result = await timeStage("parse_text", message.id, () => parseTextIntent({ text: rawText, categories, today, lastFinanceEntry, aiEnabled }));

      if (message.wasAudio && isDestructiveAudioIntent(result)) {
        await sendWhatsAppMessage(fromPhone, "Por segurança, digite esse comando de exclusão. Não apaguei nada a partir do áudio.");
        return respondOk();
      }

      if (result.ok && result.intent === "report") {
        const summary = await buildMonthlyReport(fb, uid, result.report.month, result.report.year);

        if (result.report.format === "arquivo") {
          if (!summary.hasEntries) {
            await sendWhatsAppMessage(fromPhone, `📊 Não encontrei nenhum lançamento em ${summary.monthName} pra exportar.`);
            return respondOk();
          }
          const monthKey = `${result.report.year}-${String(result.report.month).padStart(2, "0")}`;
          const pdfEntries = summary.entries.map((f) => ({
            date: f.date,
            description: f.description || "",
            categoryLabel: categoryNameForWhatsApp(categories.find((c) => c.id === f.category)?.label, f.category || "Outros"),
            type: f.type === "receita" ? "receita" : "despesa",
            amount: Number(f.amount) || 0,
          }));
          const buffer = buildPdfReportBuffer({ monthLabel: summary.monthName, isClosed: false, entries: pdfEntries });
          const mediaId = await uploadWhatsAppMedia(
            buffer, `relatorio-${monthKey}.pdf`, "application/pdf"
          );
          if (!mediaId) {
            await sendWhatsAppMessage(fromPhone, "Não consegui gerar o arquivo agora 😕 Tenta de novo em instantes.");
            return respondOk();
          }
          try {
            await sendWhatsAppDocument(fromPhone, mediaId, `relatorio-${monthKey}.pdf`, `📄 Relatório de ${summary.monthName}`);
          } catch (error) {
            console.error("whatsapp_pdf_delivery_failed", { code: error?.message || "unknown" });
            await sendWhatsAppMessage(fromPhone, "Consegui gerar o PDF, mas não consegui enviá-lo pelo WhatsApp agora. Peça o relatório novamente em instantes.");
          }
          return respondOk();
        }

        await sendWhatsAppMessage(fromPhone, formatMonthlyReport(summary, categories));
        return respondOk();
      }

      if (result.ok && result.intent === "stats") {
        const main = await buildMonthlyReport(fb, uid, result.stats.month, result.stats.year);
        let compareData = null;
        if (result.stats.compare) {
          compareData = await buildMonthlyReport(fb, uid, result.stats.compare.month, result.stats.compare.year);
        }
        await sendWhatsAppMessage(fromPhone, formatStatsMessage(main, compareData));
        return respondOk();
      }

      if (result.ok && result.intent === "agenda") {
        const agendaMsg = await buildAgendaMessage(fb, uid, result.agenda.filter, today);
        await sendWhatsAppMessage(fromPhone, agendaMsg);
        return respondOk();
      }

      if (result.ok && result.intent === "help") {
        await sendWhatsAppMessage(fromPhone, HELP_MESSAGE);
        return respondOk();
      }

      if (result.ok && result.intent === "finance_delete_last") {
        const deleted = await deleteLastWhatsAppEntry(fb, uid);
        if (!deleted) {
          await sendWhatsAppMessage(fromPhone, "Não achei nenhum lançamento feito por aqui pra apagar 🤷");
        } else {
          const verb = deleted.type === "receita" ? "Receita" : "Gasto";
          await sendWhatsAppMessage(
            fromPhone,
            `🗑️ Apaguei: ${verb} de R$ ${formatWhatsAppAmount(deleted.amount)} — ${deleted.description || "sem descrição"}.`
          );
        }
        return respondOk();
      }

      if (result.ok && result.intent === "finance_edit_last") {
        const updated = await editLastWhatsAppEntry(fb, uid, result.patch);
        if (!updated) {
          await sendWhatsAppMessage(fromPhone, "Não achei nenhum lançamento feito por aqui pra corrigir 🤷");
        } else {
          const verb = updated.type === "receita" ? "Receita" : "Gasto";
          await sendWhatsAppMessage(
            fromPhone,
            `✏️ Corrigido: ${verb} de R$ ${formatWhatsAppAmount(updated.amount)} — ${updated.description || "sem descrição"} (${formatDateBr(updated.date, { includeYear: true })}).`
          );
        }
        return respondOk();
      }

      if (result.ok && result.intent === "finance_search") {
        const matches = await searchFinanceEntries(fb, uid, result.search, categories);
        if (matches.length === 0) {
          await sendWhatsAppMessage(fromPhone, `🔍 Não encontrei nenhum lançamento com "${result.search.query}".`);
        } else {
          let msg = `🔍 Encontrei ${matches.length} lançamento${matches.length === 1 ? "" : "s"}:`;
          for (const f of matches) {
            const verb = f.type === "receita" ? "+" : "-";
            msg += `\n• ${verb}R$ ${formatWhatsAppAmount(f.amount)} — ${f.description || "sem descrição"} (${formatDateBr(f.date)})`;
          }
          await sendWhatsAppMessage(fromPhone, msg);
        }
        return respondOk();
      }

      if (result.ok && result.intent === "task_action") {
        const { action } = result.task;
        if (action === "create") {
          const task = await createTaskFromWhatsApp(fb, uid, result.task, today, rawText);
          await sendWhatsAppMessage(
            fromPhone,
            `✅ 📋 Tarefa criada: "${task.title}"${task.dueDate ? ` — vence em ${formatDateBr(task.dueDate)}` : ""}${task.dueTime ? ` às ${task.dueTime} (lembrete ${task.reminder === 0 ? "na hora" : `${task.reminder} min antes`})` : ""}${task.priority === "Alta" ? " 🔴 prioridade alta" : ""}.${!task.dueDate ? " Defina a data no Planner para receber um lembrete." : !task.dueTime ? " Defina um horário no Planner para receber um aviso com antecedência." : ""}`
          );
        } else if (action === "complete") {
          const task = await completeTaskByQuery(fb, uid, result.task.query, today);
          await sendWhatsAppMessage(
            fromPhone,
            task ? `✅ Concluí: "${task.title}". Mandou bem! 🎉` : `Não achei nenhuma tarefa parecida com "${result.task.query}" 🤔`
          );
        } else {
          const task = await deleteTaskByQuery(fb, uid, result.task.query);
          await sendWhatsAppMessage(
            fromPhone,
            task ? `🗑️ Apaguei a tarefa "${task.title}".` : `Não achei nenhuma tarefa parecida com "${result.task.query}" 🤔`
          );
        }
        return respondOk();
      }

      if (result.ok && result.intent === "note_action") {
        const { action } = result.note;
        if (action === "create") {
          const content = stripNoteCommandPrefix(rawText);
          if (!content) {
            await sendWhatsAppMessage(fromPhone, "Manda o conteúdo da anotação junto, tipo: \"anota: ideia pro projeto X\".");
          } else {
            const note = await createNoteFromWhatsApp(fb, uid, { title: result.note.title, description: content }, today, rawText);
            await sendWhatsAppMessage(fromPhone, `✅ 📝 Anotado! "${note.title}" salvo nas suas notas — o conteúdo foi salvo exatamente como você escreveu.`);
          }
        } else if (action === "search") {
          const matches = await searchNotes(fb, uid, result.note.query);
          if (matches.length === 0) {
            await sendWhatsAppMessage(fromPhone, `🔍 Não encontrei nenhuma nota com "${result.note.query}".`);
          } else {
            let msg = `🔍 Encontrei ${matches.length} nota${matches.length === 1 ? "" : "s"}:`;
            for (const n of matches) {
              const preview = (n.description || "").slice(0, 60);
              msg += `\n• *${n.title}*${preview ? ` — ${preview}${n.description.length > 60 ? "…" : ""}` : ""}`;
            }
            await sendWhatsAppMessage(fromPhone, msg);
          }
        } else {
          const note = await deleteNoteByQuery(fb, uid, result.note.query);
          await sendWhatsAppMessage(
            fromPhone,
            note ? `🗑️ Apaguei a nota "${note.title}".` : `Não achei nenhuma nota parecida com "${result.note.query}" 🤔`
          );
        }
        return respondOk();
      }

      if (result.ok && result.intent === "goal_action") {
        const { action } = result.goal;
        if (action === "create") {
          const goal = await createGoalFromWhatsApp(fb, uid, result.goal, rawText);
          await sendWhatsAppMessage(fromPhone, `✅ 🎯 Meta criada: "${goal.title}" (alvo: ${goal.target}).`);
        } else {
          const goal = await updateGoalProgress(fb, uid, result.goal);
          if (!goal) {
            await sendWhatsAppMessage(fromPhone, `Não achei nenhuma meta parecida com "${result.goal.query}" 🤔`);
          } else {
            const pct = goal.target > 0 ? Math.round((goal.current / goal.target) * 100) : 0;
            await sendWhatsAppMessage(fromPhone, `✅ 🎯 Atualizei "${goal.title}": agora está em ${goal.current}/${goal.target} (${pct}%)${pct >= 100 ? " — meta batida! 🏆" : ""}.`);
          }
        }
        return respondOk();
      }

      if (result.ok && result.intent === "event_create") {
        const event = await createEventFromWhatsApp(fb, uid, result.event, rawText);
        await sendWhatsAppMessage(
          fromPhone,
          `✅ 📅 Compromisso marcado: "${event.title}" em ${formatDateBr(event.date)}${event.time ? ` às ${event.time} (lembrete ${event.reminder === 0 ? "na hora" : `${event.reminder} min antes`})` : ""}${event.location && event.location !== "Sem local" ? ` — ${event.location}` : ""}.${!event.time ? " Defina um horário no Planner para receber um lembrete." : ""}`
        );
        return respondOk();
      }

      if (result.ok && result.intent === "category_clarify") {
        const { entry, options } = result.clarify;
        await saveWhatsAppPendingClarification(fb, uid, { entry, options });
        const listMsg = options
          .map((id, i) => {
            const label = categories.find((c) => c.id === id)?.label || id;
            return `${i + 1}) ${label || categoryNameForWhatsApp(label, id)}`;
          })
          .join("\n");
        const verb = entry.type === "receita" ? "essa receita" : "esse gasto";
        await sendWhatsAppMessage(
          fromPhone,
          `Não consegui identificar bem a categoria de ${verb} (R$ ${formatWhatsAppAmount(entry.amount)} — ${entry.description}). Me diz o número:\n${listMsg}`
        );
        return respondOk();
      }

      // intent "expense" (ou falha da IA) — mesmo fluxo de sempre
      await finishParsedResult({
        fb, uid, fromPhone, categories, result, rawMessage: rawText,
        failureMsg: 'Não consegui entender essa mensagem 🤔 Manda "ajuda" pra ver o que eu entendo, ou descreve um gasto tipo "gastei 45 no mercado".',
      });
      return respondOk();
    }

    if (message.type === "image" || message.type === "document") {
      if (!aiEnabled) {
        await sendWhatsAppMessage(fromPhone, "A leitura de fotos/PDF está pausada no seu plano. Você ainda pode registrar em texto, por exemplo: *gastei 45 no mercado*.");
        return respondOk();
      }
      const mediaId = message.image?.id || message.document?.id;
      const media = await timeStage("media_download", message.id, () => downloadWhatsAppMedia(mediaId));
      if (!media) {
        await sendWhatsAppMessage(fromPhone, "Não consegui baixar esse arquivo 😕 Tente enviar a foto ou o PDF novamente.");
        return respondOk();
      }
      if (!/^image\//.test(media.mimeType) && media.mimeType !== "application/pdf") {
        await sendWhatsAppMessage(fromPhone, "Consigo ler imagens ou PDF. Envie o arquivo nesses formatos.");
        return respondOk();
      }
      const caption = String(message.image?.caption || message.document?.caption || "").trim().slice(0, 300);
      const token = crypto.createHash("sha256").update(message.id).digest("hex").slice(0, 10);
      const rawMessage = message.type === "document" ? "[PDF de boleto/comprovante]" : "[foto de boleto/comprovante]";
      const noteRequested = isPhotoNoteRequest(caption);
      if (noteRequested) {
        const noteResult = await timeStage("note_ocr", message.id, () => parseNoteImage({ imageBase64: media.base64, mimeType: media.mimeType, caption }));
        if (!noteResult.ok) {
          await sendWhatsAppMessage(fromPhone, "Não consegui transcrever essa anotação com segurança. Tente uma foto mais nítida ou envie o texto digitado.");
          return respondOk();
        }
        await savePendingMediaEntry(fb, uid, { token, note: noteResult.note });
        await sendWhatsAppButtons(fromPhone, `📝 Encontrei esta anotação:\n*${noteResult.note.title}*\n${noteResult.note.description.slice(0, 380)}${noteResult.note.description.length > 380 ? "…" : ""}\n\nConfere?`, [
          { id: `media:note:${token}`, title: "Salvar nota" },
          { id: `media:cancel:${token}`, title: "Cancelar" },
        ]);
        return respondOk();
      }

      const result = await timeStage("media_parse", message.id, () => parseTransactionImage({
        imageBase64: media.base64, mimeType: media.mimeType, categories, today, caption,
      }));
      if (!result.ok) {
        await sendWhatsAppMessage(fromPhone, "Não consegui identificar um valor total confiável nessa foto/PDF. Envie uma imagem mais nítida, informe o valor em texto ou mande com legenda *nota* para tentar salvar a transcrição.");
        return respondOk();
      }
      const assessment = result.mediaAssessment || {};
      const needsConfirmation = assessment.paymentStatus !== "pago";
      if (needsConfirmation) {
        await savePendingMediaEntry(fb, uid, { token, entry: result.entry, assessment, rawMessage });
        await sendWhatsAppButtons(fromPhone,
          `Li *${result.entry.description}* — R$ ${formatWhatsAppAmount(result.entry.amount)}. ${assessment.dueDate ? `Vencimento: ${formatDateBr(assessment.dueDate, { includeYear: true })}. ` : ""}Não há confirmação de pagamento; o que deseja fazer?`, [
            { id: `media:task:${token}`, title: "Criar tarefa" },
            { id: `media:save:${token}`, title: "Registrar gasto" },
            { id: `media:cancel:${token}`, title: "Cancelar" },
          ], "Nada é lançado sem sua escolha.");
        return respondOk();
      }
      await finishParsedResult({ fb, uid, fromPhone, categories, result, rawMessage,
        failureMsg: "Não consegui ler o total dessa foto/PDF. Envie um arquivo mais nítido." });
      return respondOk();
    }

    await sendWhatsAppMessage(fromPhone, "Consigo entender texto, áudio, foto e PDF de boleto/comprovante. Mande “ajuda” para ver exemplos.");
    return respondOk();
  } catch (err) {
    console.error("whatsapp_webhook_failed", { error: err?.name || "error", code: err?.code || null });
    if (claimedMessageId && fbForMessage) {
      try { await releaseMessageClaim(fbForMessage, claimedMessageId); }
      catch (releaseError) { console.error("whatsapp_claim_release_failed", { error: releaseError?.name || "error" }); }
    }
    logStage("total_failed", inboundStartedAt, claimedMessageId);
    return res.status(503).end();
  }
};

// Desliga o parse automático de body da Vercel — precisamos dos bytes
// BRUTOS da requisição pra verificar a assinatura HMAC da Meta antes de
// qualquer parse (ver readRawBody()/verifyMetaSignature() acima).
module.exports.config = { api: { bodyParser: false } };
// Superfície pequena e sem I/O para os testes de regressão do formato de
// resposta. A função HTTP continua sendo o export principal da Vercel.
module.exports._test = {
  formatWhatsAppFinanceConfirmation, inferPaymentMethod, formatWhatsAppAmount,
  isPhotoNoteRequest, isDestructiveAudioIntent, buttonFallbackText,
  parseFinanceReferenceCommand, sendWhatsAppDocument, findUidForPhone, confirmWhatsAppLink,
};
