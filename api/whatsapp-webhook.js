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
const admin = require("firebase-admin");
const { parseTransactionImage } = require("./_lib/parseTransactionAI");
const { parseTextIntent, findBestMatch } = require("./_lib/parseCommandIntent");

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
async function withUserData(fb, uid, mutator) {
  const ref = fb.firestore().collection("userData").doc(uid);
  let result;
  await fb.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() : { data: {} };
    const state = { ...(current.data || {}) };
    result = await mutator(state);
    if (result === undefined) return;
    tx.set(ref, { data: state, updatedAt: new Date().toISOString() }, { merge: true });
  });
  return result;
}

async function confirmWhatsAppLink(fb, uid, phone) {
  await withUserData(fb, uid, (state) => {
    state.whatsappLinkCode = null;
    state.whatsappLinkCodeExpiresAt = null;
    state.whatsappLinkedPhone = phone;
    return true;
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
  await sendWhatsAppMessage(phone, WELCOME_MESSAGE);
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
      id: `wa_${Date.now()}`,
      source: "whatsapp",
      createdAt: new Date().toISOString(),
      type: entry.type,
      amount: entry.amount,
      category: entry.categoryId,
      description: entry.description,
      date: entry.date,
      whatsappRawMessage: rawMessage || "",
    };
    finances.unshift(record);
    return record;
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
async function finishParsedResult({ fb, uid, fromPhone, categories, result, failureMsg, rawMessage }) {
  if (!result.ok) {
    await sendWhatsAppMessage(fromPhone, failureMsg);
    return;
  }

  await appendFinanceEntry(fb, uid, result.entry, rawMessage);
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
  return withUserData(fb, uid, (state) => {
    const finances = Array.isArray(state.finances) ? state.finances : [];
    const idx = finances.findIndex((f) => f.source === "whatsapp");
    if (idx === -1) return undefined;
    const deletedEntry = finances[idx];
    state.finances = [...finances.slice(0, idx), ...finances.slice(idx + 1)];
    return deletedEntry;
  });
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
  });
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
  return { income, expense, balance: income - expense, monthName, topCategories, hasEntries: entries.length > 0, expenseCount: entries.filter((f) => f.type !== "receita").length };
}

function formatMonthlyReport(summary, categories) {
  const { income, expense, balance, monthName, topCategories, hasEntries } = summary;
  if (!hasEntries) return `📊 Não encontrei nenhum lançamento em ${monthName}.`;

  const balanceIcon = balance >= 0 ? "✅" : "⚠️";
  let msg = `📊 Relatório de ${monthName}:\n💰 Receitas: R$ ${income.toFixed(2)}\n💸 Gastos: R$ ${expense.toFixed(2)}\n${balanceIcon} Saldo: R$ ${balance.toFixed(2)}`;
  if (topCategories.length > 0) {
    msg += `\n\nMaiores gastos:`;
    for (const [categoryId, total] of topCategories) {
      const label = categories.find((c) => c.id === categoryId)?.label || categoryId || "Outros";
      msg += `\n${label}: R$ ${total.toFixed(2)}`;
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
  let msg = `📈 Estatísticas de ${monthName}:\n💰 Receitas: R$ ${income.toFixed(2)}\n💸 Gastos: R$ ${expense.toFixed(2)} (${expenseCount} lançamento${expenseCount === 1 ? "" : "s"}, média de R$ ${avgExpense.toFixed(2)})\n${balanceIcon} Saldo: R$ ${balance.toFixed(2)}`;

  if (compareData && compareData.hasEntries) {
    const diff = expense - compareData.expense;
    const pct = compareData.expense > 0 ? (diff / compareData.expense) * 100 : null;
    const arrow = diff > 0 ? "📈 mais" : diff < 0 ? "📉 menos" : "igual";
    const pctText = pct !== null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)` : "";
    msg += `\n\nComparado a ${compareData.monthName}: gastou R$ ${Math.abs(diff).toFixed(2)} ${arrow}${pctText}.`;
  }
  return msg;
}

function formatDateBr(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
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
async function createTaskFromWhatsApp(fb, uid, { title, dueDate, priority }, todayIso, rawMessage) {
  return withUserData(fb, uid, (state) => {
    const tasks = Array.isArray(state.tasks) ? state.tasks : (state.tasks = []);
    const task = {
      id: crypto.randomUUID(),
      title,
      status: "Pendente",
      priority: priority || "Media",
      dueDate: dueDate || "",
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
  });
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
  });
}

async function deleteTaskByQuery(fb, uid, query) {
  return withUserData(fb, uid, (state) => {
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const match = findBestMatch(query, tasks, "title");
    if (!match) return undefined;
    state.tasks = tasks.filter((t) => t.id !== match.id);
    return match;
  });
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
      favorite: false,
      createdAt: todayIso,
      source: "whatsapp",
      whatsappRawMessage: rawMessage || "",
    };
    notes.unshift(note);
    return note;
  });
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
  });
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
  });
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
  });
}

// ── Compromissos ────────────────────────────────────────────────
async function createEventFromWhatsApp(fb, uid, { title, date, time, location }, rawMessage) {
  return withUserData(fb, uid, (state) => {
    const events = Array.isArray(state.events) ? state.events : (state.events = []);
    const event = {
      id: crypto.randomUUID(),
      title,
      date,
      time,
      location: location || "Sem local",
      reminder: 15,
      notes: "",
      source: "whatsapp",
      whatsappRawMessage: rawMessage || "",
    };
    events.push(event); // mesmo padrão do saveEvent() no app — push, não unshift
    return event;
  });
}

const HELP_MESSAGE = `🤖 O que eu entendo por aqui (tudo em linguagem natural, não precisa decorar comando):

💸 *Finanças*
"gastei 45 no mercado" / "recebi 200 de freela"
📷 foto de cupom fiscal — eu leio sozinho
"errei, era 60 não 45" — corrige o último lançamento
"quanto gastei com uber esse mês" — busca lançamentos
"saldo" / "resumo" — resumo do mês atual
"relatório do mês passado" / "quanto gastei em julho"
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

🎯 *Metas*
"criar meta economizar 5000 esse ano"
"avancei 200 na minha meta de economia"

📅 *Agenda*
"marca reunião com o cliente sexta às 15h"
"compromissos de hoje" / "da semana"

Tudo sincronizado direto com o seu painel do PulseNote, e cada ação eu confirmo por aqui mesmo.`;

const WELCOME_MESSAGE = `✅ Vinculado! Eu sou o Pulsinho — a partir de agora é só me mandar mensagem por aqui que eu cuido do resto. 🎉

${HELP_MESSAGE}`;

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

  // A Meta espera 200 rapidamente, mesmo em erro — senão ela reenvia o
  // mesmo evento várias vezes. Por isso o catch abaixo sempre responde
  // 200 (o erro real vai só pro log).
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
      const rawText = message.text.body;
      const norm = normalizeCommand(rawText);

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

      const result = await parseTextIntent({ text: rawText, categories, today });

      if (result.ok && result.intent === "report") {
        const summary = await buildMonthlyReport(fb, uid, result.report.month, result.report.year);
        await sendWhatsAppMessage(fromPhone, formatMonthlyReport(summary, categories));
        return res.status(200).end();
      }

      if (result.ok && result.intent === "stats") {
        const main = await buildMonthlyReport(fb, uid, result.stats.month, result.stats.year);
        let compareData = null;
        if (result.stats.compare) {
          compareData = await buildMonthlyReport(fb, uid, result.stats.compare.month, result.stats.compare.year);
        }
        await sendWhatsAppMessage(fromPhone, formatStatsMessage(main, compareData));
        return res.status(200).end();
      }

      if (result.ok && result.intent === "agenda") {
        const agendaMsg = await buildAgendaMessage(fb, uid, result.agenda.filter, today);
        await sendWhatsAppMessage(fromPhone, agendaMsg);
        return res.status(200).end();
      }

      if (result.ok && result.intent === "help") {
        await sendWhatsAppMessage(fromPhone, HELP_MESSAGE);
        return res.status(200).end();
      }

      if (result.ok && result.intent === "finance_edit_last") {
        const updated = await editLastWhatsAppEntry(fb, uid, result.patch);
        if (!updated) {
          await sendWhatsAppMessage(fromPhone, "Não achei nenhum lançamento feito por aqui pra corrigir 🤷");
        } else {
          const verb = updated.type === "receita" ? "Receita" : "Gasto";
          await sendWhatsAppMessage(
            fromPhone,
            `✏️ Corrigido: ${verb} de R$ ${Number(updated.amount || 0).toFixed(2)} — ${updated.description || "sem descrição"} (${updated.date}).`
          );
        }
        return res.status(200).end();
      }

      if (result.ok && result.intent === "finance_search") {
        const matches = await searchFinanceEntries(fb, uid, result.search, categories);
        if (matches.length === 0) {
          await sendWhatsAppMessage(fromPhone, `🔍 Não encontrei nenhum lançamento com "${result.search.query}".`);
        } else {
          let msg = `🔍 Encontrei ${matches.length} lançamento${matches.length === 1 ? "" : "s"}:`;
          for (const f of matches) {
            const verb = f.type === "receita" ? "+" : "-";
            msg += `\n• ${verb}R$ ${Number(f.amount || 0).toFixed(2)} — ${f.description || "sem descrição"} (${formatDateBr(f.date)})`;
          }
          await sendWhatsAppMessage(fromPhone, msg);
        }
        return res.status(200).end();
      }

      if (result.ok && result.intent === "task_action") {
        const { action } = result.task;
        if (action === "create") {
          const task = await createTaskFromWhatsApp(fb, uid, result.task, today, rawText);
          await sendWhatsAppMessage(
            fromPhone,
            `✅ 📋 Tarefa criada: "${task.title}"${task.dueDate ? ` — vence em ${formatDateBr(task.dueDate)}` : ""}${task.priority === "Alta" ? " 🔴 prioridade alta" : ""}.`
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
        return res.status(200).end();
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
        return res.status(200).end();
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
        return res.status(200).end();
      }

      if (result.ok && result.intent === "event_create") {
        const event = await createEventFromWhatsApp(fb, uid, result.event, rawText);
        await sendWhatsAppMessage(
          fromPhone,
          `✅ 📅 Compromisso marcado: "${event.title}" em ${formatDateBr(event.date)}${event.time ? ` às ${event.time}` : ""}${event.location && event.location !== "Sem local" ? ` — ${event.location}` : ""}.`
        );
        return res.status(200).end();
      }

      // intent "expense" (ou falha da IA) — mesmo fluxo de sempre
      await finishParsedResult({
        fb, uid, fromPhone, categories, result, rawMessage: rawText,
        failureMsg: 'Não consegui entender essa mensagem 🤔 Manda "ajuda" pra ver o que eu entendo, ou descreve um gasto tipo "gastei 45 no mercado".',
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
        fb, uid, fromPhone, categories, result, rawMessage: "[foto de cupom fiscal]",
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

// Desliga o parse automático de body da Vercel — precisamos dos bytes
// BRUTOS da requisição pra verificar a assinatura HMAC da Meta antes de
// qualquer parse (ver readRawBody()/verifyMetaSignature() acima).
module.exports.config = { api: { bodyParser: false } };
