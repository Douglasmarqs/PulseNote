Warning: truncated output (original token count: 92880)
Total output lines: 7590

// ============================================================
// PulseNote — Autenticação e sincronização via Firebase
// ============================================================
import { auth, db } from "./firebase-init.js";
import { createAutopilotUI } from "./autopilot-ui.js";
import { deleteAccountDataAndIdentity } from "./account-deletion.mjs";
import { cloneState, changedStateKeys, mergeDirtyState } from "./state-sync.js";
import {
  onAuthStateChanged,
  signOut,
  updateProfile,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  sendEmailVerification,
  deleteUser,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDocFromServer,
  setDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ============================================================
// Rede de segurança: mostra erros na TELA em vez de falhar calado
// ============================================================
// Até agora, se algo desse errado (um elemento que não existe mais, uma
// função que falhou), o único sinal era "o botão não faz nada" — sem
// nenhuma pista do que realmente aconteceu, nem pra quem está usando
// nem pra mim tentando corrigir a distância. Isso captura qualquer erro
// não tratado (de clique, de carregamento, de promessa) e mostra um
// aviso simples na tela, com a mensagem exata do erro — assim dá pra
// tirar print e mandar, em vez de "não funciona".
let lastShownRuntimeError = "";
function showRuntimeErrorBanner(message) {
  if (!message || message === lastShownRuntimeError) return; // evita repetir o mesmo aviso em loop
  lastShownRuntimeError = message;
  let banner = document.getElementById("runtimeErrorBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "runtimeErrorBanner";
    banner.style.cssText =
      "position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;background:#3a0d0d;color:#ffd9d9;" +
      "border:1.5px solid #e5484d;border-radius:14px;padding:12px 14px;font:600 13px/1.4 -apple-system,system-ui,sans-serif;" +
      "box-shadow:0 12px 32px rgba(0,0,0,0.4);";
    document.body.appendChild(banner);
  }
  banner.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = "Algo quebrou nesta tela:";
  strong.style.cssText = "display:block;margin-bottom:4px;";
  const p = document.createElement("p");
  p.textContent = message;
  p.style.cssText = "margin:0 0 8px;word-break:break-word;";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Fechar";
  btn.style.cssText = "background:#e5484d;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-weight:700;";
  btn.onclick = () => banner.remove();
  banner.append(strong, p, btn);
}
window.addEventListener("error", (event) => {
  showRuntimeErrorBanner(event.message || String(event.error));
});
window.addEventListener("unhandledrejection", (event) => {
  showRuntimeErrorBanner(event.reason?.message || String(event.reason));
});

// ── Tema: Claro / Aurora / Automático ─────────────────────────────
// A escolha fica em localStorage (não depende de login/Firestore, então
// funciona até na tela de login). Um script inline no <head> do HTML já
// aplica isso antes da primeira pintura da tela, para nunca "piscar"
// claro por engano; aqui só mantemos o valor sincronizado durante o uso
// do app e ligamos os botões em Configurações > Aparência.
// Obs.: o antigo tema "Escuro" foi removido (não estava funcionando bem)
// — "Automático" em modo escuro agora usa a mesma paleta do "Aurora".
const THEME_STORAGE_KEY = "pulsenote-theme";

function syncThemeColorMeta(choice) {
  const isDark = choice === "aurora" || choice === "eclipse" || (choice !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const meta = document.getElementById("themeColorMeta");
  if (meta) meta.setAttribute("content", choice === "eclipse" ? "#000000" : (isDark ? "#060a18" : "#f5f7fa"));
  // Mantém o <meta name="color-scheme"> alinhado ao tema escolhido, para que
  // selects, calendário nativo, barra de rolagem etc. nunca fiquem brancos
  // por cima de um app configurado como escuro (ver comentário no <head>).
  const csMeta = document.getElementById("colorSchemeMeta");
  if (csMeta) csMeta.setAttribute("content", isDark ? "dark" : "light");
}

function applyTheme(choice) {
  if (choice === "light" || choice === "aurora" || choice === "eclipse") {
    document.documentElement.setAttribute("data-theme", choice);
  } else {
    document.documentElement.removeAttribute("data-theme"); // = "automático"
  }
  syncThemeColorMeta(choice);
}

// Em modo "Automático", se a pessoa mudar o tema do aparelho com o app
// aberto (sem tocar em nada dentro do PulseNote), a status bar nativa
// acompanha.
try {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getSavedTheme() === "system") syncThemeColorMeta("system");
  });
} catch { /* matchMedia/addEventListener indisponível — sem problema, é só um refinamento */ }

function getSavedTheme() {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY);
    // Valor antigo "dark", de quem já tinha escolhido o extinto tema
    // "Escuro", cai automaticamente em "system" (que agora é o Aurora
    // quando o aparelho está escuro) — sem quebrar nada pra quem já usava.
    return t === "light" || t === "aurora" || t === "eclipse" ? t : "system";
  } catch { return "system"; }
}

function setTheme(choice) {
  try { localStorage.setItem(THEME_STORAGE_KEY, choice); } catch { /* modo privado etc — segue só na sessão atual */ }
  applyTheme(choice);
}

applyTheme(getSavedTheme()); // aplica assim que o script roda (reforça o que o <head> já fez)

function bindThemeToggle() {
  const group = document.getElementById("themeToggle");
  if (!group) return;
  const buttons = group.querySelectorAll("[data-theme-choice]");
  function refreshActive() {
    const current = getSavedTheme();
    buttons.forEach((b) => b.classList.toggle("active", b.dataset.themeChoice === current));
  }
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      setTheme(btn.dataset.themeChoice);
      refreshActive();
    });
  });
  refreshActive();
}

const BASE_STORAGE_KEY = "pulsenote-state-v1";

// Número oficial do assistente do PulseNote no WhatsApp.
// WHATSAPP_BOT_NUMBER: formato livre, só pra EXIBIR pra pessoa (fallback
// manual, caso o link de ativação abaixo não abra a conversa sozinho).
// WHATSAPP_BOT_NUMBER_DIGITS: só dígitos, formato E.164 sem "+" — é o
// que o link wa.me exige pra abrir a conversa certa.
// HISTÓRICO (pra não repetir o mesmo erro): os 4 últimos dígitos
// estavam errados (7488 em vez de 7048, erro de transcrição do número
// falado) — por isso "sem 9" e "com 9" falharam antes, não era só
// questão do 9º dígito. Confirmado com print do painel do Meta
// (Gerenciador do WhatsApp > Números de telefone): o número é
// 8773-7048. Testando agora COM o 9 (padrão de celular BR pós-2016).
// Se ainda assim o wa.me disser "não está no WhatsApp", o próximo
// candidato é a mesma coisa SEM o 9: "553187737048".
// Isso é independente do bug da Cloud API em api/whatsapp-webhook.js
// (fixBrazilianMobileNumber) — aquele corrige o número que a Meta
// entrega no webhook pra poder RESPONDER pela API; este aqui é o
// número real da conta, usado só pelo link wa.me.
const WHATSAPP_BOT_NUMBER_DIGITS = "5531987737048";
const WHATSAPP_BOT_NUMBER = "+55 31 98773-7048";

// Retorna a chave de cache ISOLADA para o usuário atual.
// Isso é essencial: sem isso, o navegador misturaria os dados em cache
// de contas diferentes logadas no mesmo dispositivo.
function getStorageKey() {
  return currentUser ? `${BASE_STORAGE_KEY}:${currentUser.uid}` : null;
}

let currentUser   = null;   // objeto do usuário logado (Firebase Auth)
let unsubscribeDoc = null;  // função para parar de "escutar" o Firestore
let syncTimer      = null;
let accountDeletionInProgress = false;
let accountDeletionRequested = false;
const activeSyncs = new Set();
const SERVER_OWNED_FIELDS = ["fcmTokens", "serverNotifications"];
let observedState = null;
const dirtyBases = {};
const dirtyVersions = {};

function pendingSyncKey() {
  return currentUser ? `${BASE_STORAGE_KEY}:pending:${currentUser.uid}` : null;
}

function persistPendingSync() {
  const key = pendingSyncKey();
  if (!key) return;
  try {
    if (Object.keys(dirtyBases).length) localStorage.setItem(key, JSON.stringify(dirtyBases));
    else localStorage.removeItem(key);
  } catch { /* armazenamento indisponível; o estado atual segue em memória */ }
}

// ── Helpers de usuário (substituem getToken/getUser antigos) ──
function getUser() {
  if (!currentUser) return null;
  return {
    id: currentUser.uid,
    name: currentUser.displayName || "Usuário",
    email: currentUser.email,
  };
}

// Remove valores "undefined" em qualquer profundidade (objetos e arrays).
// O Firestore rejeita "undefined" com um erro (invalid-argument) que,
// sem essa limpeza, aparecia pro usuário só como "Erro ao salvar" genérico
// — este helper evita que esse tipo de dado quebrado chegue a ser enviado.
function stripUndefinedDeep(value) {
  if (Array.isArray(value)) return value.map(stripUndefinedDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (v === undefined) continue;
      out[key] = stripUndefinedDeep(v);
    }
    return out;
  }
  return value;
}

// ── Salva o state atual no Firestore (documento do usuário) ───
// Guard triplo antes de qualquer escrita:
// 1. currentUser existe (usuário logado)
// 2. e-mail verificado (evita erros de permissão para contas não confirmadas)
// 3. state existe e é um objeto válido
// Sem esse guard, chamadas durante a inicialização (antes do onAuthStateChanged
// terminar) disparavam "Erro ao salvar" mesmo sem nenhuma ação do usuário.
let _syncRetries = 0;
function syncToServer() {
  if (accountDeletionInProgress) return;
  const work = performSyncToServer();
  activeSyncs.add(work);
  work.then(() => activeSyncs.delete(work), () => activeSyncs.delete(work));
  return work;
}

async function performSyncToServer() {
  if (!currentUser || !currentUser.emailVerified || !state) return;
  const fields = Object.keys(dirtyBases);
  if (!fields.length) return;

  // Documento único por usuário: se ele crescer demais (fotos grandes,
  // muitos anos de lançamentos), o Firestore recusa a escrita (limite de
  // 1 MiB por documento). Detectamos isso antes da tentativa; o cache local
  // continua atualizado e o motivo fica disponível no console de suporte.
  const clean = stripUndefinedDeep(state);
  delete clean.fcmTokens;
  delete clean.serverNotifications;
  const basesAtStart = cloneState(dirtyBases);
  const versionsAtStart = { ...dirtyVersions };
  const approxBytes = new Blob([JSON.stringify(clean)]).size;
  if (approxBytes > 900_000) {
    console.error("Não foi possível sincronizar: os dados excedem o limite seguro do documento do Firestore.");
    const key = getStorageKey();
    if (key) localStorage.setItem(key, JSON.stringify(state));
    return;
  }

  try {
    const ref = doc(db, "userData", currentUser.uid);
    const merged = await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(ref);
      const remote = snapshot.exists() ? snapshot.data().data || {} : {};
      const next = mergeDirtyState(remote, clean, basesAtStart);
      const patch = {};
      for (const field of fields) {
        if (next[field] !== undefined) patch[field] = next[field];
      }
      transaction.set(ref, { data: patch, updatedAt: new Date().toISOString() }, {
        mergeFields: ["updatedAt", ...Object.keys(patch).map((key) => `data.${key}`)],
      });
      return next;
    });
    for (const field of fields) {
      if (dirtyVersions[field] === versionsAtStart[field]) {
        delete dirtyBases[field];
        delete dirtyVersions[field];
      } else {
        // A pessoa editou novamente durante a transação: o próximo merge
        // usa esta gravação confirmada como base, sem perder a edição nova.
        dirtyBases[field] = cloneState(merged[field]);
      }
    }
    persistPendingSync();
    const key = getStorageKey();
    if (key) localStorage.setItem(key, JSON.stringify(state));
    _syncRetries = 0; // reset ao ter sucesso
    if (Object.keys(dirtyBases).length) scheduleSyncToServer();
  } catch (err) {
    console.error("Erro ao salvar no Firestore:", err);
    const key = getStorageKey();
    if (key) localStorage.setItem(key, JSON.stringify(state)); // nunca perde o dado localmente
    if (!navigator.onLine) return;
    // Retry com backoff exponencial (máx 3 tentativas, 2s/4s/8s)
    if (_syncRetries < 3) {
      _syncRetries++;
      const delay = Math.pow(2, _syncRetries) * 1000;
      setTimeout(syncToServer, delay);
    } else {
      _syncRetries = 0;
    }
  }
}

function scheduleSyncToServer() {
  if (accountDeletionInProgress) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncToServer, 1200);
}

// Ao voltar a conexão, sincroniza silenciosamente o estado mais recente.
window.addEventListener("online", () => {
  if (currentUser) syncToServer();
});

// ── Logout ──────────────────────────────────────────────────
async function logout() {
  try {
    if (unsubscribeDoc) unsubscribeDoc();
    await signOut(auth);
  } finally {
    // O cache local é isolado por UID (getStorageKey), então é seguro manter
    // — não há risco de outra conta logada no mesmo aparelho "herdar" estes
    // dados. Isso só acelera a próxima vez que esta mesma pessoa logar.
    currentUser = null;
    window.location.replace("/login");
  }
}

// ── Guarda de autenticação + carregamento em tempo real ───────
// Esta é a peça central: o app só é exibido depois de confirmar
// que existe um usuário logado, e os dados vêm sempre do Firestore.
const appReady = new Promise((resolve) => {
  let resolved = false; // garante que resolve() é chamado apenas uma vez

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // Durante a exclusão, o handler abaixo limpa o cache local antes
      // de navegar. O evento de Auth pode chegar antes de deleteUser
      // resolver; não redirecione cedo demais deixando dados no aparelho.
      if (accountDeletionInProgress) return;
      window.location.replace("/login");
      return;
    }

    // Força atualizar os dados do usuário (nome, foto) com o servidor.
    // Sem isso, o objeto "user" pode vir de um cache local do navegador
    // que ainda não tem a foto de perfil mais recente — é por isso que,
    // às vezes, a foto "não aparece" depois de recarregar a página.
    try { await user.reload(); } catch { /* segue mesmo se falhar (ex: offline) */ }

    currentUser = auth.currentUser || user;

    // Bloqueia o acesso aos dados até o e-mail ser confirmado. Isso vale
    // tanto para quem acabou de se cadastrar quanto para quem faz login
    // numa conta antiga que ainda não confirmou o e-mail.
    if (!currentUser.emailVerified) {
      if (!resolved) { resolved = true; resolve(); }
      showVerifyEmailGate();
      return;
    }

    // IMPORTANTE: o state SEMPRE começa "vazio" (defaults de fábrica) até
    // o Firestore confirmar os dados reais deste usuário específico.
    // Isso evita usar por engano o cache de uma conta diferente que
    // tenha ficado salva no mesmo navegador/dispositivo.
    state = loadDefaultState();

    // Só agora, com o usuário confirmado, lemos o cache ISOLADO por UID
    // (chave inclui o uid — nunca se mistura com o de outra conta).
    const key = getStorageKey();
    const cached = key ? localStorage.getItem(key) : null;
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === "object") state = normalizeState(parsed);
      } catch { /* cache corrompido — ignora e segue com defaults */ }
    }
    observedState = cloneState(state);
    if (cached) {
      try {
        const pending = JSON.parse(localStorage.getItem(pendingSyncKey()) || "{}");
        if (pending && typeof pending === "object" && !Array.isArray(pending)) {
          for (const [field, base] of Object.entries(pending)) {
            if (SERVER_OWNED_FIELDS.includes(field) || !(field in state)) continue;
            dirtyBases[field] = base;
            dirtyVersions[field] = 1;
          }
        }
      } catch { /* metadados antigos/corrompidos — usa o servidor */ }
    }

    renderAll(); // mostra algo imediatamente (cache ou defaults) enquanto busca o Firestore

    const userDocRef = doc(db, "userData", user.uid);

    // onSnapshot escuta mudanças em tempo real no Firestore.
    // É chamado: (1) imediatamente com os dados atuais, (2) toda vez
    // que outro dispositivo/aba salvar algo novo para ESTE MESMO usuário.
    let firstSnapshotForUser = true;
    unsubscribeDoc = onSnapshot(
      userDocRef,
      (snapshot) => {
        // A exclusão apaga este documento ANTES da identidade Firebase.
        // Não confunda esse evento com o primeiro login e não recrie os
        // dados enquanto a exclusão está em andamento.
        if (!snapshot.exists() && accountDeletionInProgress) return;
        if (snapshot.exists()) {
          const remote = snapshot.data().data;
          if (remote && typeof remote === "object") {
            state = normalizeState(Object.keys(dirtyBases).length
              ? mergeDirtyState(remote, state, dirtyBases)
              : remote);
            observedState = cloneState(state);
            const k = getStorageKey();
            if (k) localStorage.setItem(k, JSON.stringify(state));
          }
        } else {
          // Documento ainda não existe no Firestore para este usuário
          // (primeiro login dele). Cria agora com os dados padrão/cache atual.
          setDoc(userDocRef, { data: stripUndefinedDeep(state), updatedAt: new Date().toISOString() })
            .catch((err) => {
              console.error("Erro ao criar documento inicial:", err);
            });
        }

        renderAll(); // re-renderiza com os dados confirmados do servidor
        autopilotUi.invalidate();
        if (firstSnapshotForUser && Object.keys(dirtyBases).length) scheduleSyncToServer();
        firstSnapshotForUser = false;

        if (!resolved) { resolved = true; resolve(); }
      },
      (err) => {
        console.error("Erro ao escutar Firestore:", err);
        if (!resolved) { resolved = true; resolve(); } // segue com cache local/defaults
      }
    );
  });
});

const statusList = ["Pendente", "Em andamento", "Concluida", "Cancelada"];
const viewTitles = {
  dashboard: "Seu dia em foco",
  planner: "Planner",
  notes: "Anotações",
  finances: "Finanças",
  autopilot: "Pulse Autopilot",
  profile: "Perfil",
  settings: "Configurações",
};

// Catálogo padrão de categorias — cobre os casos mais comuns de despesa
// pessoal (moradia, contas, alimentação, saúde, lazer, família, finanças...)
// pra ninguém precisar criar categoria manual pra coisa básica. A lista do
// picker já é buscável e rolável, então mais opções aqui não bagunça a UI —
// só torna a busca mais provável de já ter o que a pessoa precisa.
const expenseCategories = [
  // Casa & contas
  { id: "moradia",     label: "🏠 Moradia",             color: "#ff6b6b", group: "Casa & contas" },
  { id: "contas",      label: "💡 Contas e Utilidades", color: "#ffd60a", group: "Casa & contas" },
  { id: "manutencao",  label: "🔧 Manutenção e Reparos", color: "#8a9bb0", group: "Casa & contas" },
  // Alimentação
  { id: "alimentacao", label: "🍔 Restaurante/Delivery", color: "#ec4899", group: "Alimentação" },
  { id: "mercado",     label: "🛒 Mercado",              color: "#8b5cf6", group: "Alimentação" },
  // Transporte
  { id: "transporte",  label: "🚗 Transporte",   color: "#5ac8fa", group: "Transporte" },
  { id: "combustivel", label: "⛽ Combustível",  color: "#0a84ff", group: "Transporte" },
  // Saúde & bem-estar
  { id: "saude",       label: "💊 Saúde",                    color: "#ff3b30", group: "Saúde & bem-estar" },
  { id: "academia",    label: "🏋️ Academia e Esportes",      color: "#ff453a", group: "Saúde & bem-estar" },
  { id: "beleza",      label: "💅 Beleza e Cuidados pessoais", color: "#ff6482", group: "Saúde & bem-estar" },
  // Educação & trabalho
  { id: "educacao",    label: "📚 Educação",     color: "#34c759", group: "Educação & trabalho" },
  // Lazer & social
  { id: "lazer",       label: "🎬 Lazer",           color: "#af52de", group: "Lazer & social" },
  { id: "eventos",     label: "🎉 Festas e Eventos", color: "#bf5af2", group: "Lazer & social" },
  { id: "presentes",   label: "🎁 Presentes",       color: "#ff2d55", group: "Lazer & social" },
  // Compras
  { id: "roupas",      label: "👗 Roupas e Acessórios", color: "#ff2d55", group: "Compras" },
  { id: "tecnologia",  label: "📱 Tecnologia e Eletrônicos", color: "#64d2ff", group: "Compras" },
  // Assinaturas
  { id: "assinaturas", label: "🔁 Assinaturas",  color: "#5856d6", group: "Assinaturas" },
  // Família & pets
  { id: "familia",     label: "👶 Filhos e Família", color: "#ffd60a", group: "Família & pets" },
  { id: "pet",         label: "🐾 Pet",              color: "#30b0c7", group: "Família & pets" },
  // Viagem
  { id: "viagem",      label: "✈️ Viagem", color: "#00c7be", group: "Viagem" },
  // Finanças
  { id: "investimentos_desp", label: "💰 Investimentos e Poupança", color: "#30d158", group: "Finanças" },
  { id: "emprestimos", label: "🏦 Empréstimos e Dívidas", color: "#a2845e", group: "Finanças" },
  { id: "impostos",    label: "🧾 Impostos e Taxas",      color: "#8e8e93", group: "Finanças" },
  { id: "seguros",     label: "🛡️ Seguros",               color: "#5e5ce6", group: "Finanças" },
  { id: "doacoes",     label: "🎗️ Doações",               color: "#ff375f", group: "Finanças" },
  // Outros
  { id: "outros",      label: "📦 Outros",       color: "#8a9bb0", group: "Outros" },
];

// Receita tem uma natureza diferente de despesa — "de onde o dinheiro veio",
// não "em que foi gasto" — por isso usa sua própria lista de categorias.
const incomeCategories = [
  { id: "salario",      label: "💼 Salário",         color: "#34c759", group: "Trabalho" },
  { id: "freelance",    label: "💻 Freelance/Bico",  color: "#5ac8fa", group: "Trabalho" },
  { id: "investimentos",label: "📈 Investimentos",   color: "#af52de", group: "Investimentos" },
  { id: "vendas",       label: "🏷️ Vendas",          color: "#14b8a6", group: "Vendas" },
  { id: "aluguel_receb",label: "🏠 Aluguel recebido", color: "#ff6b6b", group: "Recebimentos" },
  { id: "reembolso",    label: "↩️ Reembolso",        color: "#00c7be", group: "Recebimentos" },
  { id: "emprestimo_receb", label: "🤝 Empréstimo recebido", color: "#a2845e", group: "Recebimentos" },
  { id: "pensao",       label: "👨‍👩‍👧 Pensão/Auxílio",  color: "#5e5ce6", group: "Recebimentos" },
  { id: "premio",       label: "🏆 Prêmio/Sorte",     color: "#ffd60a", group: "Presentes & prêmios" },
  { id: "presente",     label: "🎁 Presente/Bônus",   color: "#ff2d55", group: "Presentes & prêmios" },
  { id: "outros_receita", label: "📦 Outros",         color: "#8a9bb0", group: "Outros" },
];

// Retorna categorias fixas + categorias criadas pelo usuário, filtradas pelo
// tipo (despesa ou receita) — assim "Salário" nunca aparece como despesa, e
// "Alimentação" nunca aparece como origem de receita.
function getAllCategories(type = "despesa") {
  const base = type === "receita" ? incomeCategories : expenseCategories;
  const custom = (state.customCategories || []).filter((c) => (c.type || "despesa") === type);
  return [...base, ...custom];
}

// Monta a lista de categorias (despesa + receita, fixas + do usuário) no
// formato que o endpoint de IA (api/parse-transaction.js) espera, para que
// ele só escolha entre ids que realmente existem para este usuário.
function buildCategoryPayload() {
  const despesa = getAllCategories("despesa").map((c) => ({ id: c.id, type: "despesa", label: c.label }));
  const receita = getAllCategories("receita").map((c) => ({ id: c.id, type: "receita", label: c.label }));
  return [...despesa, ...receita];
}

// Categorias mais usadas nos últimos 90 dias, por frequência real de uso —
// aparecem no topo do picker pra quem lança sempre nas mesmas 3-4
// categorias não precisar rolar/buscar toda vez. Só entra na lista quem
// foi usada 2+ vezes (evita "mais usada" ridícula com uso único), e o
// corte de 90 dias evita que uma categoria antiga que a pessoa não usa
// mais fique presa no topo pra sempre.
function getMostUsedCategoryIds(type, limit = 4) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const counts = {};
  (state.finances || []).forEach((tx) => {
    if ((tx.type || "despesa") !== type) return;
    if (tx.date && tx.date < cutoffIso) return;
    if (!tx.category) return;
    counts[tx.category] = (counts[tx.category] || 0) + 1;
  });

  return Object.entries(counts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

function findCategory(catId) {
  const all = [...expenseCategories, ...incomeCategories, ...(state.customCategories || [])];
  return all.find((c) => c.id === catId) || { label: "📦 Outros", color: "#8a9bb0" };
}

// Converte uma data para "YYYY-MM-DD" usando o fuso horário LOCAL do
// usuário — NUNCA usar `.toISOString().slice(0, 10)` para isso, porque
// toISOString() converte para UTC antes de cortar a string. No horário de
// Brasília (UTC-3) isso fazia o app "virar o dia" já às 21h, mostrando o
// dia de amanhã como "hoje" (e jogando lançamentos, calendário e o
// reconhecimento de "ontem/anteontem" um dia adiante) durante toda a noite.
function toLocalIso(date) {
  const year  = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day   = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const todayIso = toLocalIso(new Date());
const tomorrowIso = offsetDate(1);
const weekIso = offsetDate(5);
const appTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";

// O state começa com os valores padrão "de fábrica". Ele só é substituído
// pelos dados reais do usuário DEPOIS que o Firebase confirma o login
// (dentro do bloco onAuthStateChanged, em appReady) — nunca antes disso.
let state = loadDefaultState();
observedState = cloneState(state);

// Ponte para o notifications.js: como ele é um <script> normal (não um
// módulo ES), não tem acesso direto às variáveis internas deste módulo.
// Usamos um getter para que window.PulseNoteState sempre reflita o "state"
// mais atual, mesmo depois de reatribuições (ex: quando os dados chegam
// do Firestore).
Object.defineProperty(window, "PulseNoteState", {
  get() { return state; },
});
let activeView = "dashboard";
let calendarMode = "month";
let draggedTaskId = null;
// ── Planner (NOVO, hub unificado) ──────────────────────────────
let plannerActiveTab = "list"; // "list" | "day" | "week" | "month"
let plannerDayDate = todayIso;
let plannerWeekAnchor = todayIso; // qualquer data dentro da semana ativa
let plannerMonthAnchor = todayIso; // qualquer data dentro do mês ativo
let plannerExpandedGoals = new Set();
let plannerExpandedTaskDetails = new Set(); // ids de tarefas com a checklist aberta — sem isso, qualquer alteração num item (concluir/excluir/adicionar) recriava a linha do zero e fechava a checklist na cara do usuário
let plannerEditingEventId = null;
let notesFolderFilter = "all"; // filtro de pasta ativo na biblioteca de Notas
// Mês ativo na view de Finanças. Formato "YYYY-MM". Começa no mês atual.
let finActiveMonth = todayIso.slice(0, 7);

const elements = {
  viewTitle: document.querySelector("#viewTitle"),
  todayLabel: document.querySelector("#todayLabel"),
  globalSearch: document.querySelector("#globalSearch"),
  toast: document.querySelector("#toast"),
};
const autopilotUi = createAutopilotUI({
  getToken: () => currentUser,
  openArea: (area) => setView(["finances", "planner", "notes"].includes(area) ? area : "dashboard"),
  notify: (message) => showToast(message),
});

document.addEventListener("DOMContentLoaded", async () => {
  // Mostra overlay de carregamento enquanto o Firebase autentica.
  // O Pulsinho (mascote) "acorda" aqui — é o único trecho do carregamento
  // que dá pra animar; o splash "de fábrica" do PWA (antes do JS rodar)
  // só aceita imagem estática, então essa é a primeira coisa animada
  // que a pessoa vê.
  const overlay = document.createElement("div");
  overlay.id = "appLoadingOverlay";
  overlay.className = "app-loading-overlay";
  overlay.innerHTML = `
    <div class="pulsinho">
      <div class="pulsinho__face">
        <div class="pulsinho__eyes"><span class="pulsinho__eye"></span><span class="pulsinho__eye"></span></div>
        <svg class="pulsinho__pulse" viewBox="0 0 120 26"><path d="M0,13 L28,13 L36,3 L44,23 L52,13 L64,13 L70,6 L76,20 L82,13 L120,13"/></svg>
      </div>
    </div>
    <strong class="app-loading-word">PulseNote</strong>
    <div class="app-loading-track"><span></span></div>
  `;
  document.body.appendChild(overlay);

  // Rede de segurança: se por algum motivo o Firebase/Firestore travar (rede
  // muito lenta, etc.) e appReady nunca resolver, garante que o overlay some
  // sozinho depois de um tempo em vez de prender o usuário numa tela de
  // carregamento pra sempre.
  const overlaySafetyTimer = setTimeout(() => {
    overlay.style.transition = "opacity 300ms ease";
    overlay.style.opacity = "0";
    setTimeout(() => overlay.remove(), 320);
  }, 9000);

  // Aguarda o Firebase confirmar sessão e carregar dados do Firestore
  await appReady;
  clearTimeout(overlaySafetyTimer);

  // Remove overlay com fade suave
  overlay.style.transition = "opacity 300ms ease";
  overlay.style.opacity = "0";
  setTimeout(() => overlay.remove(), 320);

  if (!currentUser) return; // já foi redirecionado para login.html
  if (!currentUser.emailVerified) return; // gate de verificação já está sendo exibido

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const greetingMood = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "night";
  const dateStr = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(now);

  const user = getUser();
  const firstName = user?.name?.split(" ")[0] || "Usuário";
  elements.todayLabel.textContent = `${greeting}, ${firstName} · ${dateStr}`;

  const greetingMascot = document.querySelector("#greetingMascot");
  if (greetingMascot) {
    greetingMascot.classList.remove("mood-morning", "mood-afternoon", "mood-night");
    greetingMascot.classList.add(`mood-${greetingMood}`);
  }

  renderProfileButton(user);

  // Inicia o agendador de notificações (só dispara de fato se o
  // usuário já tiver concedido permissão anteriormente)
  if (window.startNotificationScheduler) window.startNotificationScheduler();

  // Atualiza os contadores "Faltam Xh Ymin" da Agenda a cada 30s, em tempo real
  setInterval(updateEventCountdowns, 30000);

  bindNavigation();
  autopilotUi.bind();
  bindPlannerNav();
  bindPlannerQuickAdd();
  bindNoteDetail();
  bindForms();
  bindActions();
  bindSettingsView();
  checkAdminAccess();
  bindThemeToggle();
  bindFinTabs();
  bindFinanceMonthControls();
  bindFinGoalsModal();
  bindFinRecurModal();
  bindGlobalPalette();
  autoApplyRecurrents();
  // Registra a tela atual no primeiro carregamento. Isso faz o botão/gesto
  // de voltar percorrer as telas do app antes de deixar a aplicação.
  const viewFromHistory = history.state?.pnView;
  if (viewFromHistory && document.querySelector(`#${viewFromHistory}View`)) {
    setView(viewFromHistory, { fromHistory: true });
  } else {
    history.replaceState({ ...(history.state || {}), pnView: activeView, noteDetail: false }, "");
  }
  renderAll();
  autopilotUi.load();
  handlePwaShortcutAction();
});

// Tela de bloqueio exibida quando o usuário ainda não confirmou o e-mail.
// Sem isso, qualquer pessoa poderia criar uma conta com um e-mail que não
// é dela. Só dá pra usar o PulseNote depois de clicar no link enviado.
function showVerifyEmailGate() {
  if (document.getElementById("verifyEmailGate")) return;

  const overlay = document.createElement("div");
  overlay.id = "verifyEmailGate";
  overlay.className = "verify-gate-overlay";
  overlay.innerHTML = `
    <div class="verify-gate-card">
      <div class="verify-gate-icon">✉️</div>
      <h2>Confirme seu e-mail</h2>
      <p>Enviamos um link de confirmação para <strong>${currentUser.email}</strong>.
      Abra o e-mail (e confira o spam) e clique no link para liberar o acesso.</p>
      <div id="verifyGateMsg" class="settings-message" hidden></div>
      <button id="verifyGateResend" class="primary-button" style="justify-content:center">Reenviar e-mail</button>
      <button id="verifyGateCheck" class="ghost-button">Já confirmei, continuar</button>
      <button id="verifyGateLogout" class="ghost-button danger-button">Sair da conta</button>
    </div>
  `;
  document.body.appendChild(overlay);

  function showGateMsg(text, type) {
    const el = document.getElementById("verifyGateMsg");
    el.textContent = text;
    el.className = `settings-message ${type}`;
    el.hidden = false;
  }

  let cooldown = false;
  document.getElementById("verifyGateResend").addEventListener("click", async () => {
    if (cooldown) return;
    cooldown = true;
    const btn = document.getElementById("verifyGateResend");
    btn.disabled = true;
    try {
      await sendEmailVerification(currentUser);
      showGateMsg("✅ E-mail reenviado! Verifique sua caixa de entrada.", "success");
    } catch (err) {
      console.error("Erro ao reenviar verificação:", err);
      showGateMsg(
        err.code === "auth/too-many-requests"
          ? "Muitos pedidos de reenvio. Aguarde alguns minutos e tente novamente."
          : "Não foi possível reenviar agora. Tente novamente em instantes.",
        "error"
      );
    }
    setTimeout(() => { cooldown = false; btn.disabled = false; }, 30000);
  });

  document.getElementById("verifyGateCheck").addEventListener("click", async () => {
    try { await currentUser.reload(); } catch { /* segue mesmo se offline */ }
    if (currentUser.emailVerified) {
      window.location.reload();
    } else {
      showGateMsg("Ainda não detectamos a confirmação. Verifique se você já clicou no link do e-mail.", "error");
    }
  });

  document.getElementById("verifyGateLogout").addEventListener("click", async () => {
    overlay.remove();
    await logout();
  });
}

function renderProfileButton(user) {
  const topbarActions = document.querySelector(".topbar-actions");
  if (!topbarActions || document.querySelector(".user-avatar-btn")) return;

  const initial  = (user?.name || "U").charAt(0).toUpperCase();
  const photoURL = state?.profilePhoto || currentUser?.photoURL || "";

  const wrapper = document.createElement("div");
  wrapper.style.position = "relative";

  const avatarContent = photoURL
    ? `<img src="${escapeHtml(photoURL)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="foto"/>`
    : initial;

  // O botão fica no topbar; o dropdown é anexado direto no <body> —
  // assim ele nunca fica "preso" num container estreito que quebra
  // o posicionamento no mobile (bug do print: dropdown cortado à esquerda).
  wrapper.innerHTML = `
    <button class="user-avatar-btn" id="profileBtn" title="${escapeHtml(user?.name || "Perfil")}" style="overflow:hidden">
      ${avatarContent}
    </button>
  `;
  topbarActions.prepend(wrapper);

  // Overlay escuro por trás do dropdown (estilo bottom-sheet no mobile)
  const backdrop = document.createElement("div");
  backdrop.id = "profileDropdownBackdrop";
  backdrop.hidden = true;
  backdrop.style.cssText = `position:fixed;inset:0;z-index:199;background:rgba(0,0,0,0.3);backdrop-filter:blur(2px)`;
  document.body.appendChild(backdrop);

  const dropdown = document.createElement("div");
  dropdown.className = "user-dropdown";
  dropdown.id = "profileDropdown";
  dropdown.hidden = true;
  dropdown.innerHTML = `
    <div class="user-dropdown-header" style="display:flex;align-items:center;gap:12px">
      <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#6c5ce7,#af52de);
        color:#fff;font-weight:800;font-size:1rem;display:grid;place-items:center;
        flex-shrink:0;overflow:hidden">
        ${photoURL
          ? `<img src="${escapeHtml(photoURL)}" style="width:100%;height:100%;object-fit:cover" alt=""/>`
          : initial}
      </div>
      <div style="min-width:0">
        <strong style="display:block;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(user?.name || "Usuário")}</strong>
        <span style="font-size:0.78rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block">${escapeHtml(user?.email || "")}</span>
      </div>
    </div>
    <button class="dropdown-item" id="dropdownViewProfile"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>Ver perfil</button>
    <button class="dropdown-item" id="dropdownProfile"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9V15a1.7 1.7 0 00-1.6-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.7 9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.6V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.6 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.6 1z"/></svg>Configurações</button>
    <button class="dropdown-item" id="dropdownNotifications">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><path d="M6 8.5a6 6 0 0 1 12 0c0 4.2 1.3 5.8 2 6.5H4c.7-.7 2-2.3 2-6.5z"/><path d="M9.5 17.5a2.5 2.5 0 0 0 5 0"/></svg>${window.notificationsAreEnabled?.() ? "Notificações ativadas" : "Ativar notificações"}
    </button>
    <button class="dropdown-item" id="dropdownAdmin" hidden>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h8M8 13h3M14 13h2M8 17h5"/></svg>Abrir administração
    </button>
    <button class="dropdown-item danger" id="dropdownLogout"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>Sair da conta</button>
  `;
  document.body.appendChild(dropdown);

  // No desktop, posiciona o dropdown sob o avatar. No mobile, o CSS
  // (auth.css) sobrescreve para position:fixed (bottom-sheet) e isso é ignorado.
  function positionDropdown() {
    if (window.innerWidth <= 720) return;
    const rect = document.getElementById("profileBtn").getBoundingClientRect();
    dropdown.style.position = "fixed";
    dropdown.style.top   = `${rect.bottom + 10}px`;
    dropdown.style.right = `${window.innerWidth - rect.right}px`;
    dropdown.style.left  = "auto";
  }

  function openDropdown()  { positionDropdown(); dropdown.hidden = false; backdrop.hidden = false; }
  function closeDropdown() { dropdown.hidden = true; backdrop.hidden = true; }

  document.getElementById("profileBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.hidden ? openDropdown() : closeDropdown();
  });

  backdrop.addEventListener("click", closeDropdown);
  window.addEventListener("resize", () => { if (!dropdown.hidden) positionDropdown(); });

  document.getElementById("dropdownLogout").addEventListener("click", async () => {
    closeDropdown();
    if (!confirm("Deseja sair da sua conta?")) return;
    clearTimeout(syncTimer);
    try { await syncToServer(); } finally { await logout(); }
  });

  document.getElementById("dropdownViewProfile").addEventListener("click", () => {
    closeDropdown();
    setView("profile");
  });

  document.getElementById("dropdownProfile").addEventListener("click", () => {
    closeDropdown();
    setView("settings");
  });

  document.getElementById("dropdownNotifications").addEventListener("click", async () => {
    if (window.notificationsAreEnabled?.()) {
      showToast("As notificações já estão ativadas. Para desativar, use as configurações do navegador.");
      closeDropdown();
      return;
    }
    closeDropdown();
    await window.requestNotificationPermission?.();
  });

  document.getElementById("dropdownAdmin").addEventListener("click", () => {
    closeDropdown();
    window.location.assign("/admin");
  });
}

// Lê um arquivo de imagem, redimensiona e comprime no navegador (canvas),
// retornando uma Data URL (base64) pronta para salvar dentro do próprio
// documento do usuário no Firestore. Isso evita depender do Firebase
// Storage (que hoje exige o plano pago "Blaze" para funcionar) — a foto
// vai junto com o resto dos dados do usuário, do mesmo jeito que notas e
// tarefas, e sincroniza automaticamente entre dispositivos.
function fileToCompressedDataUrl(file) {
  const MAX_BYTES = 450_000; // bem abaixo do limite de 1 MB por documento do Firestore (o resto do documento — notas, tarefas, finanças — também ocupa espaço)

  function renderToDataUrl(image, maxDim, quality) {
    const ratio  = Math.min(1, maxDim / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width  = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode-failed"));
      img.onload = () => {
        try {
          let quality  = 0.85;
          let dataUrl  = renderToDataUrl(img, 320, quality);
          while (dataUrl.length > MAX_BYTES && quality > 0.4) {
            quality -= 0.15;
            dataUrl = renderToDataUrl(img, 320, quality);
          }
          if (dataUrl.length > MAX_BYTES) {
            dataUrl = renderToDataUrl(img, 200, 0.7);
          }
          if (dataUrl.length > MAX_BYTES + 200_000) {
            reject(new Error("too-large"));
            return;
          }
          resolve(dataUrl);
        } catch (err) { reject(err); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Preenche os campos da página de Configurações com os dados atuais
// (nome, e-mail, foto). Chamada sempre que renderAll() roda, para que a
// tela já apareça correta ao navegar até ela.
// ============================================================
// PERFIL (NOVO) — avatar, nível/XP, sequência, estatísticas e
// conquistas. Reaproveita os mesmos cálculos usados no Início
// (calculateXpStats, calculateStreak) e na tela antiga de Metas
// (getAchievementsList) — nenhum número novo, só uma vitrine.
// ============================================================
function renderProfile() {
  const nameEl = document.querySelector("#profileNameLabel");
  if (!nameEl) return;

  const user = getUser();
  nameEl.textContent = user?.name || "Usuário";
  const emailEl = document.querySelector("#profileEmailLabel");
  if (emailEl) emailEl.textContent = user?.email || "";

  const photoURL = state?.profilePhoto || currentUser?.photoURL || "";
  const initial = (user?.name || "U").charAt(0).toUpperCase();
  const avatarEl = document.querySelector("#profileAvatarPreview");
  if (avatarEl) avatarEl.innerHTML = photoURL ? `<img src="${escapeHtml(photoURL)}" alt="Foto de perfil"/>` : initial;

  const { level, levelProgress, xpIntoLevel, xpPerLevel, score } = calculateXpStats();
  document.querySelector("#profileLevelLabel").textContent = `Nível ${level}`;
  document.querySelector("#profileLevelBadge").textContent = level;
  document.querySelector("#profileLevelBar").style.width = `${levelProgress}%`;
  document.querySelector("#profileLevelXpLabel").textContent = `${xpIntoLevel}/${xpPerLevel} XP para o próximo nível · ${score} XP no total`;

  document.querySelector("#profileStatStreak").textContent = calculateStreak();
  document.querySelector("#profileStatTasks").textContent = state.tasks.filter((t) => t.status === "Concluida").length;
  document.querySelector("#profileStatGoals").textContent = state.goals.filter((g) => g.current >= g.target).length;
  document.querySelector("#profileStatNotes").textContent = state.notes.filter((n) => n.favorite).length;

  const achievements = getAchievementsList();
  document.querySelector("#profileAchievementCount").textContent = `${achievements.filter((a) => a.unlocked).length}/${achievements.length}`;
  document.querySelector("#profileAchievements").innerHTML = achievements
    .map(
      (a) => `
      <article class="profile-badge ${a.unlocked ? "is-unlocked" : "is-locked"}">
        <div class="profile-badge-icon">${icon(a.unlocked ? a.iconName : "lock", 19)}</div>
        <strong>${escapeHtml(a.title)}</strong>
        <span>${escapeHtml(a.detail)}</span>
      </article>
    `
    )
    .join("");
}

function renderSettings() {
  const nameEl  = document.getElementById("settingsNameInput");
  const emailEl = document.getElementById("settingsUserEmail");
  const userNameEl = document.getElementById("settingsUserName");
  const preview = document.getElementById("settingsAvatarPreview");
  if (!nameEl || !preview) return;

  const user = getUser();
  const photoURL = state?.profilePhoto || currentUser?.photoURL || "";
  const initial = (user?.name || "U").charAt(0).toUpperCase();

  if (document.activeElement !== nameEl) nameEl.value = user?.name || "";
  if (userNameEl) userNameEl.textContent = user?.name || "Usuário";
  if (emailEl) emailEl.textContent = user?.email || "";
  preview.innerHTML = photoURL
    ? `<img src="${escapeHtml(photoURL)}" alt="Foto de perfil"/>`
    : initial;

  renderWhatsAppSettings();
  loadBillingSettings();
}

let billingRequest = null;
function billingMoney(cents) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format((Number(cents) || 0) / 100);
}

async function billingApi(action, method = "GET", body) {
  if (!currentUser) throw new Error("unauthorized");
  const token = await currentUser.getIdToken();
  const response = await fetch(`/api/billing?action=${encodeURIComponent(action)}`, {
    method,
    headers: { "Authorization": `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || "billing_request_failed"), { code: payload.error });
  return payload;
}

async function loadBillingSettings(force = false) {
  const grid = document.getElementById("billingPlanGrid");
  if (!grid || !currentUser) return;
  if (billingRequest && !force) return billingRequest;
  const statusBadge = document.getElementById("billingStatusBadge");
  const statusText = document.getElementById("billingStatusText");
  billingRequest = billingApi("status").then((data) => {
    const current = data.subscription || {};
    const active = current.status === "active";
    statusBadge.textContent = active ? "Assinatura ativa" : current.planId ? "Assinatura pausada" : "Sem plano contratado";
    statusBadge.className = `billing-status-badge ${active ? "is-active" : current.planId ? "is-warning" : ""}`;
    statusText.textContent = !data.configured
      ? "Os pagamentos ainda não foram ativados pelo administrador. Seus recursos atuais continuam funcionando normalmente."
      : active ? "Seu acesso é atualizado automaticamente após cada confirmação do provedor de pagamento."
        : "Escolha um plano para ativar os recursos correspondentes.";
    grid.innerHTML = data.plans.length ? data.plans.map((plan) => {
      const isCurrent = current.planId === plan.id;
      const disabled = isCurrent || !plan.checkoutAvailable;
      return `<article class="billing-plan-card ${isCurrent ? "is-current" : ""}">
        <h3>${escapeHtml(plan.name)}</h3><p>${escapeHtml(plan.description || "Recursos definidos pelo administrador.")}</p>
        <div class="billing-plan-price">${billingMoney(plan.priceCents)} <small>/${plan.billingInterval === "year" ? "ano" : "mês"}</small></div>
        <button type="button" class="${isCurrent ? "ghost-button" : "primary-button"}" data-billing-plan="${escapeHtml(plan.id)}" ${disabled ? "disabled" : ""}>${isCurrent ? "Plano atual" : plan.checkoutAvailable ? "Assinar plano" : "Indisponível"}</button>
      </article>`;
    }).join("") : `<div class="empty-state">Nenhum plano público está disponível no momento.</div>`;
    document.getElementById("billingActions").hidden = current.provider !== "stripe";
    grid.querySelectorAll("[data-billing-plan]").forEach((button) => button.addEventListener("click", async () => {
      if (button.disabled) return;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "Abrindo pagamento…";
      try {
        const result = await billingApi("checkout", "POST", { planId: button.dataset.billingPlan });
        window.location.assign(result.url);
      } catch (error) {
        console.error("Falha ao iniciar checkout:", error.code || error.message);
        button.disabled = false;
        button.textContent = original;
        showToast("Não foi possível abrir o pagamento agora.");
      }
    }));
    return data;
  }).catch((error) => {
    console.error("Falha ao carregar cobrança:", error.code || error.message);
    statusBadge.textContent = "Indisponível";
    statusBadge.className = "billing-status-badge is-warning";
    statusText.textContent = "Não foi possível consultar sua assinatura agora. Tente novamente em instantes.";
    grid.innerHTML = "";
  }).finally(() => { billingRequest = null; });
  return billingRequest;
}

// Mostra o estado atual da integração com WhatsApp em Configurações:
// vinculado (com o número) ou não (com o código pendente, se houver um
// ainda válido). Chamada sempre que renderSettings() roda — inclusive
// quando o onSnapshot do Firestore traz a confirmação do vínculo feita
// pelo webhook, então a tela atualiza sozinha, sem precisar recarregar.
function renderWhatsAppSettings() {
  const linkedBlock   = document.getElementById("whatsappLinkedBlock");
  const unlinkedBlock = document.getElementById("whatsappUnlinkedBlock");
  const codeBlock     = document.getElementById("whatsappCodeBlock");
  if (!linkedBlock || !unlinkedBlock || !state) return;

  const appReminderCheckbox = document.getElementById("appReminderOptIn");
  if (appReminderCheckbox) appReminderCheckbox.checked = state.appReminderOptIn !== false;

  if (state.whatsappLinkedPhone) {
    linkedBlock.hidden   = false;
    unlinkedBlock.hidden = true;
    const phoneLabel = document.getElementById("whatsappLinkedPhoneLabel");
    if (phoneLabel) phoneLabel.textContent = `+${state.whatsappLinkedPhone}`;
    const reminderCheckbox = document.getElementById("whatsappReminderOptIn");
    if (reminderCheckbox) reminderCheckbox.checked = !!state.whatsappReminderOptIn;
    return;
  }

  linkedBlock.hidden   = true;
  unlinkedBlock.hidden = false;

  const stillValid = state.whatsappLinkCode
    && state.whatsappLinkCodeExpiresAt
    && new Date(state.whatsappLinkCodeExpiresAt).getTime() > Date.now();

  if (stillValid) {
    codeBlock.hidden = false;
    const codeText = document.getElementById("whatsappCodeText");
    const numberEl  = document.getElementById("whatsappBotNumberLabel");
    const expiryEl  = document.getElementById("whatsappCodeExpiry");
    if (codeText) codeText.value = `vincular ${state.whatsappLinkCode}`;
    if (numberEl) numberEl.textContent = WHATSAPP_BOT_NUMBER;
    if (expiryEl) {
      const mins = Math.max(1, Math.round((new Date(state.whatsappLinkCodeExpiresAt).getTime() - Date.now()) / 60000));
      expiryEl.textContent = `Válido por mais ${mins} min.`;
    }
  } else {
    codeBlock.hidden = true;
  }
}

// Liga todos os eventos da página de Configurações. Chamada uma única vez,
// na inicialização do app (a página é estática no HTML, não um modal
// criado/destruído via JS).
// Forçar atualização: desregistra o Service Worker, limpa os caches
// locais e recarrega direto do servidor. Não mexe em nenhum dado (que
// vive no Firestore, não no cache do navegador) — só garante que a
// pessoa está vendo a versão mais nova do app, sem depender do ciclo
// de atualização automático (que pode levar mais de uma visita pra
// "pegar" dependendo do navegador). Compartilhada pelo botão em
// Configurações e pelo gesto de puxar para atualizar.
async function forceAppUpdate() {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((reg) => reg.unregister()));
    }
  } catch (err) {
    console.warn("Erro ao limpar cache:", err);
  }
  window.location.reload(true);
}


async function checkAdminAccess() {
  const card = document.getElementById("adminAccessCard");
  const dropdownEntry = document.getElementById("dropdownAdmin");
  const isPrimaryOwner = (currentUser?.email || "").trim().toLowerCase() === "douglas1201.santos@gmail.com";
  if (!currentUser?.emailVerified) {
    if (card) card.hidden = true;
    if (dropdownEntry) dropdownEntry.hidden = true;
    return;
  }
  // Evita que a navegação principal desapareça durante uma falha transitória da API.
  // A autorização real continua obrigatoriamente validada pelo servidor em /admin.
  if (isPrimaryOwner) {
    if (card) card.hidden = false;
    if (dropdownEntry) dropdownEntry.hidden = false;
  }
  try {
    const token = await currentUser.getIdToken();
    const response = await fetch("/api/admin?action=me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const allowed = response.status === 200;
    if (card) card.hidden = !(allowed || isPrimaryOwner);
    if (dropdownEntry) dropdownEntry.hidden = !(allowed || isPrimaryOwner);
  } catch {
    if (card) card.hidden = !isPrimaryOwner;
    if (dropdownEntry) dropdownEntry.hidden = !isPrimaryOwner;
  }
}

function bindSettingsView() {
  const msgEl = document.getElementById("settingsMessage");
  function showSettingsMsg(text, type) {
    msgEl.textContent = text;
    msgEl.className   = `settings-message ${type}`;
    msgEl.hidden       = false;
    msgEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function hideSettingsMsg() {
    msgEl.hidden = true;
  }

  document.getElementById("billingPortalButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Abrindo portal…";
    try {
      const result = await billingApi("portal", "POST");
      window.location.assign(result.url);
    } catch (error) {
      console.error("Falha ao abrir portal de cobrança:", error.code || error.message);
      button.disabled = false;
      button.textContent = original;
      showSettingsMsg("Não foi possível abrir a gestão da assinatura agora.", "error");
    }
  });

  // ── Upload de foto (processada localmente, sem Firebase Storage) ──
  document.getElementById("settingsPhotoInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // permite escolher o mesmo arquivo de novo depois
    if (!file) return;
    hideSettingsMsg();

    if (!file.type.startsWith("image/")) {
      showSettingsMsg("Selecione um arquivo de imagem (JPG, PNG, etc).", "error");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showSettingsMsg("A imagem deve ter no máximo 10 MB.", "error");
      return;
    }

    const preview      = document.getElementById("settingsAvatarPreview");
    const previousHTML = preview.innerHTML;
    const progressWrap = document.getElementById("settingsUploadProgress");
    const progressBar  = document.getElementById("settingsUploadProgressBar");

    // Preview local imediato enquanto processa
    const localURL = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${localURL}" alt=""/>`;
    progressWrap.hidden = false;
    progressBar.style.width = "40%";

    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      progressBar.style.width = "100%";

      state.profilePhoto = dataUrl;
      saveState(); // salva local na hora + agenda envio ao Firestore (debounce)

      updateAllAvatars(dataUrl);
      progressWrap.hidden = true;
      showSettingsMsg("Foto atualizada!", "success");
      showToast("Foto de perfil atualizada!");
    } catch (err) {
      console.error("Erro ao processar foto:", err);
      progressWrap.hidden = true;
      preview.innerHTML = previousHTML;
      showSettingsMsg(
        err.message === "too-large"
          ? "Essa imagem é muito complexa para comprimir. Tente uma foto mais simples."
          : "Não foi possível usar essa imagem. Tente outro arquivo.",
        "error"
      );
    }
  });

  // ── Salvar nome ─────────────────────────────────────────────────
  document.getElementById("settingsNameForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideSettingsMsg();
    const newName = document.getElementById("settingsNameInput").value.trim();
    if (!newName) { showSettingsMsg("Informe um nome.", "error"); return; }
    try {
      await updateProfile(currentUser, { displayName: newName });
      const nameEl = document.querySelector(".user-dropdown-header strong");
      if (nameEl) nameEl.textContent = newName;
      renderSettings();
      showSettingsMsg("Nome atualizado!", "success");
      showToast("Perfil atualizado!");
    } catch (err) {
      console.error("Erro ao salvar nome:", err);
      showSettingsMsg(`Erro ao salvar nome: ${err.message}`, "error");
    }
  });

  // ── Trocar senha ────────────────────────────────────────────────
  document.getElementById("settingsPasswordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideSettingsMsg();
    const currentPwField = document.getElementById("settingsCurrentPw");
    const newPwField = document.getElementById("settingsNewPw");
    currentPwField.classList.remove("has-error");
    newPwField.classList.remove("has-error");
    const currentPw = currentPwField.value;
    const newPw = newPwField.value;

    if (!currentPw) {
      currentPwField.classList.add("has-error");
      currentPwField.focus();
      showSettingsMsg("Informe a senha atual.", "error");
      return;
    }
    if (!newPw || newPw.length < 6) {
      newPwField.classList.add("has-error");
      newPwField.focus();
      showSettingsMsg("A nova senha deve ter pelo menos 6 caracteres.", "error");
      return;
    }

    try {
      const credential = EmailAuthProvider.credential(currentUser.email, currentPw);
      await reauthenticateWithCredential(currentUser, credential);
      await updatePassword(currentUser, newPw);

      currentPwField.value = "";
      newPwField.value = "";
      showSettingsMsg("Senha alterada com sucesso!", "success");
      showToast("Senha alterada!");
    } catch (err) {
      const messages = {
        "auth/wrong-password":        "Senha atual incorreta.",
        "auth/invalid-credential":    "Senha atual incorreta.",
        "auth/requires-recent-login": "Por segurança, faça login novamente antes de trocar a senha.",
        "auth/weak-password":         "A nova senha é muito fraca.",
      };
      currentPwField.classList.add("has-error");
      showSettingsMsg(messages[err.code] || `Erro: ${err.message}`, "error");
    }
  });

  // ── Sair da conta ───────────────────────────────────────────────
  document.getElementById("settingsLogoutBtn").addEventListener("click", async () => {
    if (!confirm("Deseja sair da sua conta?")) return;
    await syncToServer();
    await logout();
  });

  // ── WhatsApp: ativar assistente (1 clique) ─────────────────────────
  // Gera o código de vinculação E já abre a conversa no WhatsApp oficial
  // com a mensagem "vincular <código>" pré-preenchida (link wa.me — a
  // pessoa só precisa apertar enviar). O bloco com o código também fica
  // visível na tela como fallback manual, caso o link não abra sozinho
  // (ex.: desktop sem WhatsApp instalado, ou pop-up bloqueado).
  document.getElementById("settingsWhatsappGenerateBtn")?.addEventListener("click", () => {
    hideSettingsMsg();
    const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
    state.whatsappLinkCode = code;
    state.whatsappLinkCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
    saveState();
    renderWhatsAppSettings();

    const prefilledText = encodeURIComponent(`vincular ${code}`);
    const waLink = `https://wa.me/${WHATSAPP_BOT_NUMBER_DIGITS}?text=${prefilledText}`;
    window.open(waLink, "_blank", "noopener,noreferrer");

    showToast("Abrindo o WhatsApp — é só apertar enviar! 🚀");
  });

  // ── WhatsApp: opt-in de lembretes (tarefas/eventos/metas/orçamento
  //    também por WhatsApp, além do push) ──────────────────────────
  document.getElementById("whatsappReminderOptIn")?.addEventListener("change", (e) => {
    state.whatsappReminderOptIn = e.target.checked;
    saveState();
    showToast(e.target.checked ? "🔔 Lembretes por WhatsApp ativados!" : "Lembretes por WhatsApp desativados.");
  });

  // Este listener pertence à inicialização da tela, não à normalização de
  // dados. Normalizar ocorre a cada snapshot; colocá-lo lá duplicava o
  // handler e repetia pedidos de permissão e gravações.
  document.getElementById("appReminderOptIn")?.addEventListener("change", async (e) => {
    if (e.target.checked) {
      const allowed = await window.requestNotificationPermission?.();
      if (!allowed) {
        state.appReminderOptIn = false;
        e.target.checked = false;
        saveState();
        return;
      }
    }
    state.appReminderOptIn = e.target.checked;
    saveState();
    showToast(e.target.checked ? "Lembretes no aplicativo ativados." : "Lembretes no aplicativo desativados.");
  });

  // ── WhatsApp: desvincular ──────────────────────────────────────────
  document.getElementById("settingsWhatsappUnlinkBtn")?.addEventListener("click", async () => {
    hideSettingsMsg();
    if (!confirm("Desvincular esse número do WhatsApp? Você pode gerar um novo código depois, a qualquer momento.")) return;
    try {
      const token = await currentUser?.getIdToken();
      const response = await fetch("/api/whatsapp-unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("falha ao desvincular");
      // O endpoint já limpou whatsappLinkedPhone no Firestore — o
      // onSnapshot traz essa mudança de volta e re-renderiza sozinho,
      // mas atualizamos local na hora pra não esperar o round-trip.
      state.whatsappLinkedPhone = null;
      saveState();
      renderWhatsAppSettings();
      showSettingsMsg("WhatsApp desvinculado.", "success");
      showToast("🔌 WhatsApp desvinculado!");
    } catch (err) {
      console.error("Erro ao desvincular WhatsApp:", err);
      showSettingsMsg("Não foi possível desvincular agora. Tente de novo em instantes.", "error");
    }
  });

  // ── Backup: exportar tudo como .json ─────────────────────────────
  document.getElementById("settingsExportBackup")?.addEventListener("click", () => {
    const payload = {
      pulsenoteBackup: true,
      exportedAt: new Date().toISOString(),
      data: state,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pulsenote-backup-${todayIso}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast("Backup exportado!");
  });

  // ── Backup: importar de um .json exportado anteriormente ─────────
  document.getElementById("settingsImportBackup")?.addEventListener("click", () => {
    document.getElementById("settingsImportFile")?.click();
  });
  document.getElementById("settingsImportFile")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const incoming = parsed?.data && parsed?.pulsenoteBackup ? parsed.data : parsed;
        if (!incoming || typeof incoming !== "object") throw new Error("formato inválido");
        if (!confirm("Isso vai SUBSTITUIR todos os seus dados atuais pelos do backup. Essa ação não pode ser desfeita. Continuar?")) return;
        state = normalizeState(incoming);
        saveState();
        renderAll();
        showSettingsMsg("Backup importado com sucesso!", "success");
        showToast("Dados restaurados do backup!");
      } catch (err) {
        console.error("Erro ao importar backup:", err);
        showSettingsMsg("Não foi possível ler esse arquivo. Confira se é um backup válido do PulseNote.", "error");
      }
    };
    reader.readAsText(file);
  });

  // Botão de atualização manual (alternativa ao gesto de puxar, útil no
  // desktop ou pra quem preferir um botão explícito) — mesma função
  // compartilhada forceAppUpdate(), definida no escopo do módulo.
  document.getElementById("settingsForceUpdate")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "<span>Atualizando…</span>";
    await forceAppUpdate();
  });

  // ── Excluir conta permanentemente ─────────────────────────────────
  document.getElementById("settingsDeleteAccountBtn")?.addEventListener("click", async () => {
    if (accountDeletionRequested) return;
    hideSettingsMsg();
    const account = currentUser;
    if (!account?.email) {
      showSettingsMsg("Entre novamente na sua conta antes de excluí-la.", "error");
      return;
    }
    if (!confirm("Tem certeza que quer excluir sua conta? Todos os seus dados (notas, tarefas, agenda, metas e finanças) serão apagados PERMANENTEMENTE. Essa ação não pode ser desfeita.")) return;

    const pw = prompt("Por segurança, digite sua senha atual para confirmar a exclusão:");
    if (!pw) return;

    accountDeletionRequested = true;
    let whatsappUnlinked = false;
    try {
      const credential = EmailAuthProvider.credential(account.email, pw);
      await reauthenticateWithCredential(account, credential);

      // O vínculo é protegido pelo servidor e precisa sair antes da
      // identidade. Se falhar, mantemos a conta para não deixar um
      // número associado a um UID que já não existe.
      const token = await account.getIdToken();
      const unlinkResponse = await fetch("/api/whatsapp-unlink", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!unlinkResponse.ok) {
        const unlinkError = new Error("Não foi possível desvincular o WhatsApp. Sua conta foi mantida; tente novamente mais tarde.");
        unlinkError.code = "data/unlink-failed";
        throw unlinkError;
      }
      whatsappUnlinked = true;

      // Firestore e Auth não são transacionais entre si. Confirme uma
      // cópia do servidor para poder restaurar o documento se a remoção
      // da identidade falhar. Não limpe o cache local até ambos concluírem.
      const userDocRef = doc(db, "userData", account.uid);
      accountDeletionInProgress = true;
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      try {
        // Uma sincronização já em curso poderia recriar o documento logo
        // depois do delete. Aguarde as operações deste navegador terminarem.
        await Promise.allSettled([...activeSyncs]);
        await deleteAccountDataAndIdentity({
          readData: async () => {
            const snapshot = await getDocFromServer(userDocRef);
            return snapshot.exists() ? snapshot.data() : null;
          },
          deleteData: async () => {
            try {
              await deleteDoc(userDocRef);
            } catch (err) {
              console.error("Falha ao apagar dados antes da exclusão da conta:", err?.code || err?.name || "erro");
              const deletionError = new Error("Não foi possível remover seus dados agora. Sua conta foi mantida; tente novamente mais tarde.", { cause: err });
              deletionError.code = "data/delete-failed";
              throw deletionError;
            }
          },
          deleteIdentity: () => deleteUser(account),
          restoreData: (backup) => runTransaction(db, async (transaction) => {
            const current = await transaction.get(userDocRef);
            if (!current.exists()) transaction.set(userDocRef, backup);
          }),
        });
      } catch (err) {
        accountDeletionInProgress = false;
        if (Object.keys(dirtyBases).length) scheduleSyncToServer();
        throw err;
      }

      // deleteUser pode encerrar a sessão imediatamente: use chaves
      // baseadas no UID capturado, não em currentUser (que já pode ser null).
      try {
        localStorage.removeItem(`${BASE_STORAGE_KEY}:${account.uid}`);
        localStorage.removeItem(`${BASE_STORAGE_KEY}:pending:${account.uid}`);
      } catch { /* a conta já foi removida; a navegação prossegue */ }
      window.location.replace("/login");
    } catch (err) {
      const messages = {
        "auth/wrong-password":        "Senha incorreta.",
        "auth/invalid-credential":    "Senha incorreta.",
        "auth/requires-recent-login": "Por segurança, saia e entre na conta novamente antes de excluí-la.",
        "data/unlink-failed":       "Não foi possível desvincular o WhatsApp. Sua conta foi mantida; tente novamente mais tarde.",
        "data/snapshot-failed":      "Não foi possível confirmar seus dados na nuvem. Sua conta foi mantida; verifique a conexão e tente novamente.",
        "data/delete-failed":        "Não foi possível remover seus dados agora. Sua conta foi mantida; tente novamente mais tarde.",
        "data/restore-failed":       "A exclusão não terminou e não foi possível restaurar os dados na nuvem. Não saia desta conta e entre em contato com o suporte.",
      };
      const message = messages[err.code] || `Erro ao excluir conta: ${err.message}`;
      showSettingsMsg(`${message}${whatsappUnlinked ? " O WhatsApp foi desvinculado e pode ser vinculado novamente nas configurações." : ""}`, "error");
    } finally {
      accountDeletionRequested = false;
    }
  });
}

// Atualiza todos os pontos da UI que exibem o avatar do usuário.
// Se não houver foto, cai de volta para a inicial do nome (em vez de
// deixar um ícone de imagem quebrada).
function updateAllAvatars(photoURL) {
  const initial = (getUser()?.name || "U").charAt(0).toUpperCase();
  const content = photoURL
    ? `<img src="${escapeHtml(photoURL)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" alt=""/>`
    : initial;
  const contentNoRadius = photoURL
    ? `<img src="${escapeHtml(photoURL)}" style="width:100%;height:100%;object-fit:cover" alt=""/>`
    : initial;

  // Botão principal no topbar
  const mainBtn = document.querySelector(".user-avatar-btn");
  if (mainBtn) mainBtn.innerHTML = content;

  // Mini avatar no dropdown
  const dropdownAvatar = document.querySelector(".user-dropdown-header div");
  if (dropdownAvatar) dropdownAvatar.innerHTML = contentNoRadius;

  // Avatar grande na página de Configurações
  const previewEl = document.getElementById("settingsAvatarPreview");
  if (previewEl) {
    previewEl.innerHTML = photoURL
      ? `<img src="${escapeHtml(photoURL)}" alt="Foto de perfil"/>`
      : initial;
  }

  // Avatar grande na tela de Perfil (mesmo conteúdo do de Configurações)
  const profilePreviewEl = document.getElementById("profileAvatarPreview");
  if (profilePreviewEl) profilePreviewEl.innerHTML = previewEl ? previewEl.innerHTML : (photoURL ? `<img src="${escapeHtml(photoURL)}" alt="Foto de perfil"/>` : initial);
}

// Lê a foto atual do state (já sincronizado com o Firestore) e atualiza
// o avatar em tela. Chamada em todo renderAll() — é o que garante que,
// ao trocar a foto em um aparelho, ela apareça nos outros também, sem
// precisar deslogar/logar de novo.
function refreshProfileAvatar() {
  if (!document.querySelector(".user-avatar-btn")) return; // ainda não criado
  const photoURL = state?.profilePhoto || currentUser?.photoURL || "";
  updateAllAvatars(photoURL);
}

// Garante que dados vindos do cache local ou do Firestore tenham todos os
// campos esperados pelo app, mesmo que tenham sido salvos por uma versão
// mais antiga (ex: contas criadas antes do módulo de Finanças existir).
function normalizeState(parsed) {
  if (!parsed.finances) parsed.finances = [];
  if (!parsed.notes) parsed.notes = [];
  if (!parsed.tasks) parsed.tasks = [];
  if (!parsed.events) parsed.events = [];
  if (!parsed.goals) parsed.goals = [];
  if (!parsed.customCategories) parsed.customCategories = [];
  if (!parsed.monthClosures) parsed.monthClosures = [];
  if (!parsed.finGoals) parsed.finGoals = [];
  if (!parsed.finRecurrents) parsed.finRecurrents = [];
  // O servidor de lembretes usa este fuso para converter um compromisso
  // salvo como data/hora local em um instante real. Sem persistir o fuso,
  // um usuário no Brasil recebia alerta com o horário UTC da Vercel.
  if (!parsed.timeZone) parsed.timeZone = appTimeZone;
  if (parsed.profilePhoto === undefined) parsed.profilePhoto = null;
  // Vínculo com WhatsApp (ver bindSettingsView > "Integrações" e
  // api/whatsapp-webhook.js): código de 6 dígitos gerado no app e
  // confirmado quando a pessoa manda "vincular 123456" pelo WhatsApp.
  if (parsed.whatsappLinkCode === undefined) parsed.whatsappLinkCode = null;
  if (parsed.whatsappLinkCodeExpiresAt === undefined) parsed.whatsappLinkCodeExpiresAt = null;
  if (parsed.whatsappLinkedPhone === undefined) parsed.whatsappLinkedPhone = null;
  // Notificações fora do app (ver push-notifications.js e
  // api/send-reminders.js): tokens do FCM deste(s) aparelho(s) e se a
  // pessoa também quer receber lembrete por WhatsApp (só faz sentido
  // perguntar isso quando já está vinculado — ver renderWhatsAppSettings).
  if (!Array.isArray(parsed.fcmTokens)) parsed.fcmTokens = [];
  if (parsed.whatsappReminderOptIn === undefined) parsed.whatsappReminderOptIn = false;
  // A pessoa pode desligar notificações no aplicativo sem precisar
  // desligar os lembretes do WhatsApp (e vice-versa).
  if (parsed.appReminderOptIn === undefined) parsed.appReminderOptIn = true;
  // Retrocompatibilidade: lançamentos, tarefas e metas antigos não tinham
  // esses campos — garantimos que existam pra não quebrar o restante do app.
  parsed.tasks.forEach((t) => {
    if (!t.subtasks) t.subtasks = [];
    if (t.recurrence === undefined) t.recurrence = null;
    if (t.dueTime === undefined) t.dueTime = "";
    if (!Number.isFinite(Number(t.reminder))) t.reminder = 15;
  });

  parsed.notes.forEach((n) => { if (!n.tags) n.tags = []; });
  parsed.goals.forEach((g) => { if (!g.milestones) g.milestones = []; });
  return parsed;
}

function loadDefaultState() {
  return {
    profilePhoto: null,
    notes: [],
    tasks: [],
    events: [],
    goals: [],
    finances: [],
    customCategories: [],
    monthClosures: [],
    finGoals: [],
    finRecurrents: [],
    timeZone: appTimeZone,
    whatsappLinkCode: null,
    whatsappLinkCodeExpiresAt: null,
    whatsappLinkedPhone: null,
    fcmTokens: [],
    whatsappReminderOptIn: false,
    appReminderOptIn: true,
  };
}

// Salva mudanças localmente de imediato e agenda o envio para o Firestore
// (debounce de 1.2s — evita gravar a cada tecla digitada, por exemplo)
function saveState() {
  for (const field of changedStateKeys(observedState, state, SERVER_OWNED_FIELDS)) {
    if (!(field in dirtyBases)) dirtyBases[field] = cloneState(observedState?.[field]);
    dirtyVersions[field] = (dirtyVersions[field] || 0) + 1;
  }
  observedState = cloneState(state);
  persistPendingSync();
  const key = getStorageKey();
  if (key) localStorage.setItem(key, JSON.stringify(state));
  // Só agenda sync se já temos usuário autenticado e verificado.
  // Sem esse guard, calls do renderAll() durante inicialização
  // disparavam tentativas inválidas de sync antes da sessão estar pronta.
  if (currentUser && currentUser.emailVerified) {
    scheduleSyncToServer();
  }
}


function createTask(title, status = "Pendente", priority = "Media", dueDate = todayIso, completedAt = "", dueTime = "", reminder = 15) {
  return {
    id: crypto.randomUUID(),
    title,
    status,
    priority,
    dueDate,
    createdAt: todayIso,
    completedAt,
    dueTime,
    reminder,
    sourceNoteId: "",
    subtasks: [],
    recurrence: null,
  };
}

function offsetDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toLocalIso(date);
}

function bindNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelectorAll("[data-view-shortcut]").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.viewShortcut;
      setView(view);
      const plannerFocus = button.dataset.plannerFocus;
      const settingsFocus = button.dataset.settingsFocus;
      if (view === "settings" && settingsFocus === "whatsapp") {
        requestAnimationFrame(() => document.querySelector("#whatsappIntegrationCard")?.scrollIntoView({ behavior: "smooth", block: "start" }));
        return;
      }
      if (view !== "planner" || !plannerFocus) return;

      // Os cards do Dashboard não devem levar todos para a mesma posição
      // genérica do Planner. Cada atalho abre a lente que corresponde ao
      // conteúdo resumido no card e só então rola até a área em questão.
      if (plannerFocus === "tasks") setPlannerTab("list");
      if (plannerFocus === "agenda") setPlannerTab("week");
      const target = plannerFocus === "goals"
        ? document.querySelector(".planner-goals-panel")
        : document.querySelector("#plannerView");
      requestAnimationFrame(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }));
    });
  });
}

function bindForms() {
  document.querySelector("#noteForm").addEventListener("submit", saveNote);
  document.querySelector("#noteFilter").addEventListener("change", renderNotes);
  bindNoteQuickControls();
  enableAutogrowTextareas();
  // As telas antigas de Tarefas/Agenda/Metas foram removidas (o Planner já
  // cobre tudo o que elas faziam) — mas os formulários ficam com "?." por
  // segurança, caso algum dia voltem a existir num contexto diferente.
  document.querySelector("#taskForm")?.addEventListener("submit", saveTask);
  document.querySelector("#eventForm")?.addEventListener("submit", saveEvent);
  document.querySelector("#goalForm")?.addEventListener("submit", saveGoal);
  // A busca global disparava renderAll() (redesenha TODAS as views —
  // Dashboard, Planner, Notas, Tarefas, Calendário, Metas, Finanças,
  // Perfil e Configurações, mesmo as que nem usam o termo buscado) a
  // cada tecla digitada, sem debounce nenhum — com uma quantidade
  // razoável de dados, digitar uma busca de 10 letras significava 10
  // redesenhos completos do app em sequência. Debounce de 180ms:
  // rápido o bastante pra parecer instantâneo, mas pula os redesenhos
  // intermediários enquanto a pessoa ainda está digitando.
  elements.globalSearch.addEventListener("input", debounce(renderAll, 180));

  // Filter chips (new UI)
  document.querySelectorAll("[data-note-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-note-filter]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      document.querySelector("#noteFilter").value = chip.dataset.noteFilter;
      renderNotes();
    });
  });

  // Finance form
  const expForm = document.querySelector("#expenseForm");
  if (expForm) expForm.addEventListener("submit", saveExpense);
  bindAiQuickEntry();

  // Popula o select (oculto) de categorias e sincroniza o botão visível
  // na primeira carga
  populateCategorySelect();

  // Botão de categoria visível — abre o picker com busca/criação em vez do
  // <select> nativo escondido por trás dele
  const catTrigger = document.querySelector("#expenseCategoryTrigger");
  if (catTrigger) catTrigger.addEventListener("click", () => openCategoryPicker());

  // Botão "+ Nova categoria" (atalho direto, sem passar pelo picker)
  const newCatBtn = document.querySelector("#newCategoryBtn");
  if (newCatBtn) newCatBtn.addEventListener("click", () => openNewCategoryPrompt());

  // Botão "Cancelar edição" (some quando não está editando)
  const cancelEditBtn = document.querySelector("#cancelEditExpense");
  if (cancelEditBtn) cancelEditBtn.addEventListener("click", resetExpenseForm);

  // Finance type toggle
  document.querySelectorAll("[data-fin-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelector("#expenseType").value = btn.dataset.finType;
      populateCategorySelect(null, btn.dataset.finType);
      document.querySelector(".fin-form-card")?.classList.toggle("is-receita", btn.dataset.finType === "receita");
    });
  });
}

// ── Abas internas de Finanças (Lançamentos / Análise / Controle / Automação) ──
function bindFinTabs() {
  const tabs   = document.querySelectorAll(".fin-tab-btn");
  const panels = document.querySelectorAll(".fin-tab-panel");
  if (!tabs.length) return;
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.finTab;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
      });
      panels.forEach((p) => { p.hidden = p.dataset.finPanel !== target; });
      // Garante que a aba clicada fique 100% visível — sem isso, em
      // telas estreitas onde as 4 abas não cabem, a aba podia ficar
      // cortada na borda do scroll horizontal.
      tab.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    });
  });
}

// Pula direto para um mês específico na aba Lançamentos — usado na lista de
// "Meses fechados" pra não precisar clicar em ‹ › várias vezes até achar o mês.
function goToFinMonth(monthKey) {
  finActiveMonth = monthKey;
  document.querySelectorAll(".fin-tab-btn").forEach((t) => {
    const active = t.dataset.finTab === "lancamentos";
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".fin-tab-panel").forEach((p) => { p.hidden = p.dataset.finPanel !== "lancamentos"; });
  renderFinances();
}

function bindActions() {
  document.querySelectorAll("[data-calendar-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      calendarMode = button.dataset.calendarMode;
      document.querySelectorAll("[data-calendar-mode]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      renderCalendar();
    });
  });

  // Abas de status das tarefas (mobile) — trocar de aba só atualiza
  // qual coluna fica visível, sem precisar de scroll horizontal/vertical longo
  document.querySelectorAll("[data-status-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("[data-status-tab]").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      renderTasks();
    });
  });
}

// ============================================================
// BUSCA GLOBAL (Ctrl/Cmd+K) — procura em notas, tarefas, agenda
// e finanças ao mesmo tempo, diferente da busca do topo que só
// filtra a lista da seção atual.
// ============================================================
function searchEverything(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];

  (state.notes || []).forEach((n) => {
    if (`${n.title} ${n.description}`.toLowerCase().includes(q)) {
      results.push({ type: "notes", icon: "📝", title: n.title, sub: "Nota", id: n.id });
    }
  });
  (state.tasks || []).forEach((t) => {
    if (t.title.toLowerCase().includes(q)) {
      results.push({ type: "tasks", icon: "✅", title: t.title, sub: `Tarefa · ${t.status}`, id: t.id });
    }
  });
  (state.events || []).forEach((e) => {
    if (`${e.title} ${e.location || ""}`.toLowerCase().includes(q)) {
      results.push({ type: "calendar", icon: "📅", title: e.title, sub: `Agenda · ${formatDate(e.date)}`, id: e.id });
    }
  });
  (state.finances || []).forEach((f) => {
    if ((f.description || "").toLowerCase().includes(q)) {
      results.push({ type: "finances", icon: "💰", title: f.description, sub: `Financas · ${formatCurrency(f.amount)}`, id: f.id });
    }
  });
  (state.goals || []).forEach((g) => {
    if (g.title.toLowerCase().includes(q)) {
      results.push({ type: "goals", icon: "🎯", title: g.title, sub: "Meta", id: g.id });
    }
  });

  return results.slice(0, 20);
}

function renderPaletteResults(query) {
  const el = document.querySelector("#globalPaletteResults");
  if (!el) return;
  const results = searchEverything(query);
  if (!query.trim()) {
    el.innerHTML = `<div class="empty-state">Digite pra buscar em notas, tarefas, agenda, metas e finanças.</div>`;
    return;
  }
  if (!results.length) {
    el.innerHTML = `<div class="empty-state">Nada encontrado para "${escapeHtml(query)}".</div>`;
    return;
  }
  el.innerHTML = results.map((r, i) => `
    <button class="palette-result" onclick="openPaletteResult(${i})">
      <span class="palette-result-icon">${r.icon}</span>
      <span class="palette-result-text">
        <span class="palette-result-title">${escapeHtml(r.title || "(sem título)")}</span><br>
        <span class="palette-result-sub">${escapeHtml(r.sub)}</span>
      </span>
    </button>`).join("");
  window.__paletteResults = results;
}

// Tarefas, Agenda e Metas moram todas dentro da view "planner" — não têm
// view própria. searchEverything() mantém o "type" original (tasks/
// calendar/goals) porque é útil pra distinguir o resultado, mas a
// navegação precisa ir pra view que existe de verdade (mesma causa raiz
// dos atalhos do início que apontavam pra "calendar"/"tasks"/"goals").
const PALETTE_TYPE_TO_VIEW = {
  notes: "notes",
  tasks: "planner",
  calendar: "planner",
  goals: "planner",
  finances: "finances",
};

function openPaletteResult(i) {
  const r = window.__paletteResults?.[i];
  if (!r) return;
  document.querySelector("#globalPaletteModal").hidden = true;
  setView(PALETTE_TYPE_TO_VIEW[r.type] || r.type);
}

function bindGlobalPalette() {
  const modal   = document.querySelector("#globalPaletteModal");
  const input   = document.querySelector("#globalPaletteInput");
  if (!modal) return;

  function openPalette() {
    modal.hidden = false;
    input.value = "";
    renderPaletteResults("");
    setTimeout(() => input.focus(), 30);
  }
  function closePalette() { modal.hidden = true; }

  document.querySelector("#closeGlobalPalette")?.addEventListener("click", closePalette);
  modal.addEventListener("click", (e) => { if (e.target === modal) closePalette(); });
  input?.addEventListener("input", () => renderPaletteResults(input.value));

  // A busca do topo (search-box) só filtra a lista da tela atual — pra
  // realmente "buscar em tudo" a partir dela, sem precisar saber que
  // ⌘K existe, um Enter nela abre a busca global já com o mesmo termo.
  const topSearch = document.querySelector("#globalSearch");
  topSearch?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    modal.hidden = false;
    input.value = topSearch.value;
    renderPaletteResults(input.value);
    setTimeout(() => input.focus(), 30);
  });

  document.addEventListener("keydown", (e) => {
    const isK = e.key === "k" || e.key === "K";
    if ((e.metaKey || e.ctrlKey) && isK) {
      e.preventDefault();
      modal.hidden ? openPalette() : closePalette();
    } else if (e.key === "Escape" && !modal.hidden) {
      closePalette();
    }
  });
}
window.openPaletteResult = openPaletteResult;

function setView(view, { fromHistory = false } = {}) {
  const target = document.querySelector(`#${view}View`);
  if (!target) {
    // Segurança: se algum botão apontar pra uma view que não existe (foi
    // exatamente o que causava a tela ficar em branco ao clicar na seta
    // de "Ver agenda"/"Ver tarefas"/"Ver metas" no início), a navegação
    // é ignorada em vez de apagar a tela atual inteira sem colocar nada
    // no lugar.
    console.warn(`setView: view "${view}" não existe.`);
    return;
  }
  // Um detalhe de nota aberto é um modal de tela inteira. Sem fechá-lo
  // antes de trocar a view, o backdrop continuava por cima da navegação e
  // dava a impressão de que o app havia travado. Salva e fecha sem criar
  // uma etapa extra no histórico quando a troca veio da navegação.
  const noteModal = document.querySelector("#noteDetailModal");
  if (!fromHistory && noteModal && !noteModal.hidden) closeNoteDetail({ updateHistory: false });

  const previousView = activeView;
  activeView = view;
  // Sync sidebar nav
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  // Sync bottom nav (mobile)
  document.querySelectorAll(".bottom-nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => section.classList.remove("active-view"));
  target.classList.add("active-view");
  elements.viewTitle.textContent = viewTitles[view];
  // Scroll to top on mobile
  window.scrollTo({ top: 0, behavior: "smooth" });
  // A primeira renderização dos cards de Receitas/Despesas/Saldo geralmente
  // acontece com a aba Finanças ainda escondida (clientWidth 0), então o
  // autofit em fitCurrencyValues() desiste sem ajustar o tamanho da fonte
  // (ver função abaixo) e o valor fica com a fonte grande demais do CSS,
  // cortando em "R$ 2.6..." em vez de mostrar o valor inteiro. Ao entrar
  // de fato na aba (aqui, com o card já visível e com largura real), a
  // gente reexecuta o autofit pra medir e ajustar certo.
  if (view === "finances") fitCurrencyValues("finReceitas", "finDespesas", "finSaldo");
  if (view === "dashboard") fitCurrencyValues("summaryFinSaldo", "dashFinReceitas", "dashFinDespesas", "dashFinSaldo");
  if (view === "autopilot" || view === "dashboard") autopilotUi.show();

  // A navegação entre áreas ganha uma entrada real no histórico: voltar no
  // navegador/celular retorna à tela anterior em vez de sair do app.
  if (!fromHistory && previousView !== view) {
    history.pushState({ ...(history.state || {}), pnView: view, noteDetail: false }, "");
  }
}

function saveNote(event) {
  event.preventDefault();
  const id = document.querySelector("#noteId").value;
  const existing = state.notes.find((note) => note.id === id);
  const newDescription = valueOf("#noteDescription");
  const textColor = normalizeNoteTextColor(valueOf("#noteTextColor"));
  const descriptionChanged = !existing || existing.description !== newDescription;
  const textColorChanged = Boolean(existing) && normalizeNoteTextColor(existing.textColor) !== textColor;
  const descriptionHtml = existing && !descriptionChanged && !textColorChanged
    ? existing.descriptionHtml || notePlainTextToHtml(newDescription, textColor)
    : notePlainTextToHtml(newDescription, textColor);
  const existingChecklist = existing?.checklist || [];
  const reusedChecklistIndexes = new Set();
  const checklist = splitLines(valueOf("#noteChecklist")).map((text, index) => {
    // Preserve a conclusao dos itens quando a pessoa edita outro campo da
    // nota. Primeiro procuramos o mesmo texto (inclusive se ele mudou de
    // posicao); se o texto foi renomeado, reaproveitamos o item da posicao.
    let previousIndex = existingChecklist.findIndex((item, itemIndex) =>
      !reusedChecklistIndexes.has(itemIndex) && noteChecklistItemText(item) === text
    );
    if (previousIndex < 0 && existingChecklist[index] && !reusedChecklistIndexes.has(index)) {
      previousIndex = index;
    }
    if (previousIndex < 0) return { id: crypto.randomUUID(), text, done: false };

    reusedChecklistIndexes.add(previousIndex);
    const previousItem = existingChecklist[previousIndex];
    return {
      id: typeof previousItem === "object" && previousItem.id ? previousItem.id : crypto.randomUUID(),
      text,
      done: noteChecklistItemDone(previousItem),
    };
  });
  const payload = {
    id: id || crypto.randomUUID(),
    title: valueOf("#noteTitle"),
    description: newDescription,
    category: valueOf("#noteCategory") || "Geral",
    folder: valueOf("#noteFolder") || "Entrada",
    tags: splitValues(valueOf("#noteTags")),
    priority: valueOf("#notePriority"),
    checklist,
    attachments: splitValues(valueOf("#noteAttachments")),
    goal: valueOf("#noteGoal"),
    observations: valueOf("#noteObservations"),
    color: valueOf("#noteColor") || existing?.color || "blue",
    textColor,
    favorite: existing?.favorite || false,
    createdAt: existing?.createdAt || todayIso,
    convertedToTaskId: existing?.convertedToTaskId || "",
    // A cor escolhida já aparece enquanto a pessoa escreve a primeira
    // versão da nota. Ao salvar, guardamos também o HTML equivalente para
    // que a cor apareça no cartão e no editor detalhado. Formatações ricas
    // existentes continuam intactas enquanto texto/cor não forem alterados.
    description…42880 tokens truncated…goal.current >= goal.target;
  goal.current = next;
  saveState();
  const percent = Math.min(100, Math.round((next / Math.max(1, Number(goal.target) || 1)) * 100));
  document.querySelectorAll(`[data-goal-id="${id}"]`).forEach((card) => {
    card.querySelectorAll("input").forEach((input) => {
      if (document.activeElement !== input) input.value = next;
    });
    const pill = card.querySelector(".planner-goal-chip-top .pill");
    if (pill) pill.textContent = `${percent}%`;
    const fill = card.querySelector(".progress-track > div");
    if (fill) fill.style.width = `${percent}%`;
    card.classList.toggle("is-complete", next >= goal.target);
  });
  renderGoals();
  if (!wasComplete && next >= goal.target) celebrate("Meta concluída. Medalha desbloqueada.");
}

// ── Lançamento por texto (heurística local — sem IA externa) ───
// Interpreta uma frase livre (ex.: "almoço 32 reais ontem") só com
// expressões regulares e listas de palavras-chave, tudo dentro do
// navegador — nenhum texto sai do dispositivo do usuário.
const FIN_CATEGORY_KEYWORDS = {
  alimentacao:  ["almoço","almoco","jantar","lanche","restaurante","comida","ifood","padaria","café","cafe","pizza","hambúrguer","hamburguer","churrasco","marmita","delivery","açaí","acai","sorvete","doces","rappi","padoca","brunch","sushi","mcdonalds","mcdonald's","mc donalds","mac donalds","burger king","bk","coxinha","pastel","esfiha","sanduíche","sanduiche","bolo","pão","pao"],
  mercado:      ["mercado","supermercado","mercadinho","hipermercado","atacadão","atacadao","assaí","assai","carrefour","pão de açúcar","pao de acucar","hortifruti","sacolão","sacolao","feira","açougue","acougue"],
  transporte:   ["uber","99","ônibus","onibus","metro","metrô","táxi","taxi","passagem","estacionamento","pedágio","pedagio"],
  combustivel:  ["gasolina","combustível","combustivel","etanol","diesel","gnv","posto","abastecimento"],
  saude:        ["farmácia","farmacia","remédio","remedio","médico","medico","consulta","dentista","plano de saúde","plano de saude","exame","hospital","psicólogo","psicologo","terapia","fisioterapia","óculos","oculos","vacina","laboratório","laboratorio"],
  academia:     ["academia","smart fit","bluefit","personal trainer","crossfit","pilates","yoga","musculação","musculacao","natação","natacao"],
  lazer:        ["cinema","show","viagem","bar","balada","streaming","jogo","passeio","ingresso","netflix","festa","parque","hospedagem","hotel","pousada","passeio turístico"],
  educacao:     ["curso","faculdade","livro","mensalidade escolar","escola","material escolar","apostila","aula","udemy","mensalidade da faculdade","pós-graduação","pos-graduacao"],
  moradia:      ["aluguel","condomínio","condominio","iptu","reforma","móveis","moveis","sofá","sofa"],
  contas:       ["conta de luz","conta de água","conta de agua","luz","água","agua","internet","gás","gas","conta de","celular","telefone","tv a cabo","wifi","energia","recarga"],
  manutencao:  ["oficina","mecânico","mecanico","manutenção do carro","manutencao do carro","manutenção","manutencao"],
  seguros:     ["seguro do carro","seguro"],
  impostos:    ["ipva","licenciamento"],
  roupas:       ["roupa","calça","calca","camisa","tênis","tenis","sapato","blusa","jaqueta","acessório","acessorio","bolsa","perfume"],
  assinaturas:  ["assinatura","spotify","amazon prime","youtube premium","mensalidade do","disney+","disney plus","hbo max","globoplay","apple music","icloud","google one"],
  salario:      ["salário","salario","contracheque","pagamento do trabalho","pagamento da empresa","holerite"],
  freelance:    ["freela","freelance","bico","job extra","trampo extra","projeto extra"],
  investimentos:["dividendo","rendimento","investimento","ação","ações","cdb","tesouro direto","fii","fundo imobiliário","fundo imobiliario"],
  vendas:       ["venda","vendi","vendeu"],
  reembolso:    ["reembolso","ressarcimento","devolução","devolucao"],
  presente:     ["presente","bônus","bonus","doação","doacao","mesada"],
};
const FIN_INCOME_HINTS = ["recebi","receb","ganhei","caiu","depositaram","pix recebido","entrou","salário","salario","venda","vendi","freela","freelance","bico","reembolso","presente","bônus","bonus","dividendo","rendimento"];

// Palavras "de ligação" sem valor descritivo, removidas ao montar a
// descrição final a partir do texto digitado pelo usuário — assim sobra só
// o que realmente importa (ex.: "gastei com uber pro trabalho ontem 18
// reais" -> depois de tirar data e valor, removendo essas palavras, sobra
// "uber pro trabalho", que vira a descrição "Uber pro trabalho").
const FIN_FILLER_WORDS = [
  "gastei","gasto","gastando","paguei","pagamento","pagando","comprei","compra","comprando",
  "recebi","receb","ganhei","ganhando","pix","transferência","transferencia",
  "reais","real","r\\$","de","do","da","dos","das","no","na","nos","nas","em","com","pra","para",
  "um","uma","uns","umas","o","a","os","as","e","foi","fui","ao","à","na qual","esse","essa","isso",
];

function normalizeFinAmount(raw) {
  let s = raw.trim();
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    s = s.replace(/\./g, "").replace(",", "."); // formato BR: 1.234,56
  } else if (hasComma) {
    s = s.replace(",", ".");
  } else if (hasDot) {
    const parts = s.split(".");
    if (parts[parts.length - 1].length === 3) s = s.replace(/\./g, ""); // ponto como milhar
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function addDaysIso(baseDate, delta) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + delta);
  return toLocalIso(d);
}

// Nomes em português usados no reconhecimento local de datas (parseFinanceText)
const FIN_MONTH_NAMES = {
  janeiro: 0, fevereiro: 1, marco: 2, abril: 3, maio: 4, junho: 5,
  julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
};
const FIN_WEEKDAY_NAMES = {
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
};

function parseFinanceText(text) {
  let working = text.toLowerCase();
  const today = new Date(todayIso + "T12:00:00");

  // 1) Data — extraída e REMOVIDA do texto antes de procurar o valor,
  // senão números de data ("27/06", "5 dias atrás") podem ser confundidos
  // com o valor do lançamento.
  //
  // Reconhece, em ordem de prioridade: "anteontem"/"antes de ontem",
  // "ontem", "hoje", "semana passada", "há/faz X dias"/"X dias atrás",
  // data explícita ("27/06" ou "27/06/2026"), "27 de junho", dia da
  // semana ("segunda", "terça-feira"...) e "dia 27" (sem mês = mês atual).
  let date = todayIso;
  if (/anteontem|ante-ontem|antes de ontem/.test(working)) {
    date = addDaysIso(today, -2);
    working = working.replace(/anteontem|ante-ontem|antes de ontem/g, " ");
  } else if (/\bontem\b/.test(working)) {
    date = addDaysIso(today, -1);
    working = working.replace(/\bontem\b/g, " ");
  } else if (/\bhoje\b/.test(working)) {
    working = working.replace(/\bhoje\b/g, " ");
  } else if (/semana passada/.test(working)) {
    date = addDaysIso(today, -7);
    working = working.replace(/semana passada/g, " ");
  } else {
    const daysAgoMatch =
      working.match(/(?:h[áa]|faz)\s*(\d+)\s*dias?\b/) ||
      working.match(/(\d+)\s*dias?\s*atr[áa]s/);
    if (daysAgoMatch) {
      date = addDaysIso(today, -parseInt(daysAgoMatch[1], 10));
      working = working.replace(daysAgoMatch[0], " ");
    } else {
      const explicitDate = working.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
      const monthNameMatch = !explicitDate &&
        working.match(/\b(\d{1,2})\s*(?:de\s*)?(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/);
      const weekdayMatch = !explicitDate && !monthNameMatch &&
        working.match(/\b(domingo|segunda(?:-feira)?|ter[çc]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[áa]bado)\b/);
      const dayOnlyMatch = !explicitDate && !monthNameMatch && !weekdayMatch &&
        working.match(/\bdia\s*(\d{1,2})\b/);

      if (explicitDate) {
        const day = parseInt(explicitDate[1], 10);
        const month = parseInt(explicitDate[2], 10) - 1;
        let year = explicitDate[3] ? parseInt(explicitDate[3], 10) : today.getFullYear();
        if (year < 100) year += 2000;
        const d = new Date(year, month, day);
        if (!isNaN(d)) date = toLocalIso(d);
        working = working.replace(explicitDate[0], " ");
      } else if (monthNameMatch) {
        const day = parseInt(monthNameMatch[1], 10);
        const monthKeyName = monthNameMatch[2].replace("ç", "c");
        const month = FIN_MONTH_NAMES[monthKeyName];
        let d = new Date(today.getFullYear(), month, day);
        // Se a data cair no futuro, a referência provavelmente é ao ano passado
        if (d > today) d = new Date(today.getFullYear() - 1, month, day);
        if (!isNaN(d)) date = toLocalIso(d);
        working = working.replace(monthNameMatch[0], " ");
      } else if (weekdayMatch) {
        const normalized = weekdayMatch[1]
          .replace("-feira", "")
          .replace("ç", "c")
          .replace("á", "a");
        const targetDow = FIN_WEEKDAY_NAMES[normalized];
        if (targetDow !== undefined) {
          let diff = today.getDay() - targetDow;
          if (diff <= 0) diff += 7; // sempre a ocorrência passada mais recente (nunca hoje/futuro)
          date = addDaysIso(today, -diff);
        }
        working = working.replace(weekdayMatch[0], " ");
      } else if (dayOnlyMatch) {
        const day = parseInt(dayOnlyMatch[1], 10);
        if (day >= 1 && day <= 31) {
          let d = new Date(today.getFullYear(), today.getMonth(), day);
          if (d > today) d = new Date(today.getFullYear(), today.getMonth() - 1, day);
          if (!isNaN(d)) date = toLocalIso(d);
        }
        working = working.replace(dayOnlyMatch[0], " ");
      }
    }
  }

  // 2) Valor — procura primeiro perto de "r$"/"reais"; senão, o primeiro
  // número que sobrou (já sem as referências de data). Removido de
  // "working" (matching) e de "cleanText" (vira a descrição) ao mesmo tempo.
  let cleanText = working; // vai sendo "limpo" até sobrar só a descrição
  let amount = null;
  const moneyMatch =
    working.match(/r\$\s*([\d.,]+)/) ||
    working.match(/([\d.,]+)\s*(?:reais|real)\b/) ||
    working.match(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
  if (moneyMatch) {
    amount = normalizeFinAmount(moneyMatch[1]);
    cleanText = cleanText.replace(moneyMatch[0], " ");
  }

  // 3) Tipo (receita/despesa)
  const type = FIN_INCOME_HINTS.some((kw) => working.includes(kw)) ? "receita" : "despesa";

  // 4) Categoria — escolhida pela palavra-chave MAIS ESPECÍFICA encontrada
  // (a mais longa), não pela primeira categoria da lista que bater com
  // qualquer palavra solta. Isso evita, por exemplo, que "conta de luz"
  // perca pra um match mais genérico e garante mais precisão seguindo
  // exatamente o que foi dito. Categorias personalizadas do usuário (sem
  // lista de sinônimos própria) são checadas por palavras do próprio nome.
  let categoryId = type === "receita" ? "outros_receita" : "outros";
  let bestMatchLen = 0;
  const pool = type === "receita" ? incomeCategories : expenseCategories;
  for (const cat of pool) {
    for (const kw of FIN_CATEGORY_KEYWORDS[cat.id] || []) {
      if (kw.length > bestMatchLen && working.includes(kw)) {
        categoryId = cat.id;
        bestMatchLen = kw.length;
      }
    }
  }
  const custom = (state.customCategories || []).filter((c) => (c.type || "despesa") === type);
  for (const cat of custom) {
    const words = cat.label.replace(/^\S+\s*/, "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    for (const w of words) {
      if (w.length > bestMatchLen && working.includes(w)) {
        categoryId = cat.id;
        bestMatchLen = w.length;
      }
    }
  }

  // 5) Descrição — extraída do texto REAL digitado pelo usuário (não do
  // nome da categoria), tirando só conectores sem valor descritivo
  // ("gastei", "com", "no", "reais"...). Assim "gastei em viagem antes de
  // ontem 200 reais" vira a descrição "Viagem", e não um genérico
  // "Lazer"/"Outros" igual para tudo — cada lançamento fica identificável
  // por si só na lista, em vez de várias linhas repetindo o nome da
  // categoria (era esse o problema relatado).
  let description = cleanText;
  for (const word of FIN_FILLER_WORDS) {
    description = description.replace(new RegExp(`\\b${word}\\b`, "gi"), " ");
  }
  description = description.replace(/\s+/g, " ").trim();
  if (description.length < 2) {
    // Nada de descritivo sobrou (ex.: o usuário só disse "50 reais ontem")
    // — nesse caso só o nome da categoria mesmo serve de descrição.
    description = findCategory(categoryId).label.replace(/^\S+\s*/, "");
  } else {
    description = description.charAt(0).toUpperCase() + description.slice(1);
  }

  return { type, amount, categoryId, description, date };
}

// Preenche o formulário de Finanças com o que foi reconhecido (pela IA ou
// pela heurística local) — o usuário ainda revisa e confirma clicando em
// "Registrar"; nada é salvo automaticamente.
function fillExpenseFormFrom(result) {
  document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.toggle("active", b.dataset.finType === result.type));
  document.querySelector("#expenseType").value = result.type;
  document.querySelector(".fin-form-card")?.classList.toggle("is-receita", result.type === "receita");
  populateCategorySelect(result.categoryId, result.type);

  document.querySelector("#expenseAmount").value      = result.amount.toFixed(2).replace(".", ",");
  document.querySelector("#expenseDescription").value = result.description || "";
  document.querySelector("#expenseDate").value        = result.date;

  document.querySelector("#expenseAmount")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function bindAiQuickEntry() {
  const input  = document.querySelector("#aiQuickText");
  const button = document.querySelector("#aiQuickSubmit");
  const label  = document.querySelector("#aiQuickSubmitLabel");
  if (!input || !button) return;

  const ERROR_MESSAGES = {
    ai_not_configured: "A IA ainda não foi configurada neste servidor.",
    unauthorized: "Sua sessão expirou. Recarregue a página e faça login novamente.",
    ai_rate_limited: "O limite gratuito da IA foi atingido por agora.",
  };

  function showAiQuickMascot(mode) {
    const wrap = document.querySelector("#aiQuickMascot");
    const blob = document.querySelector("#aiQuickMascotBlob");
    const text = document.querySelector("#aiQuickMascotText");
    if (!wrap || !blob || !text) return;
    wrap.hidden = false;
    blob.classList.toggle("is-thinking", mode === "thinking");
    blob.classList.toggle("is-done", mode === "done");
    text.textContent = mode === "done" ? "Prontinho! ✓" : "Pulsinho tá com a IA nisso...";
    if (mode === "done") setTimeout(hideAiQuickMascot, 1100);
  }

  function hideAiQuickMascot() {
    const wrap = document.querySelector("#aiQuickMascot");
    const blob = document.querySelector("#aiQuickMascotBlob");
    if (wrap) wrap.hidden = true;
    if (blob) blob.classList.remove("is-thinking", "is-done");
  }

  async function runAiQuickEntry() {
    const text = input.value.trim();
    if (text.length < 3) {
      showToast('Descreva um pouco melhor o lançamento (ex.: "almoço 32 reais ontem").');
      return;
    }

    // Sem nenhum número no texto, não tem valor pra registrar — nem a IA
    // nem o reconhecimento local têm como saber quanto foi gasto/recebido,
    // e antes isso resultava em preencher o valor sozinho, sem quando o
    // usuário digitava algo como só "almoço" (sem preço nenhum). Agora
    // pedimos o valor antes de tentar, em vez de preencher algo incompleto.
    if (!/\d/.test(text)) {
      showToast('Inclua o valor no texto (ex.: "almoço 32 reais") para eu conseguir preencher o lançamento.');
      return;
    }

    button.disabled = true;
    input.disabled  = true;
    if (label) label.textContent = "Pensando...";
    hideAiQuickMascot(); // reseta qualquer estado preso de uma tentativa anterior
    showAiQuickMascot("thinking");

    try {
      const token = await currentUser?.getIdToken();
      const response = await fetch("/api/parse-transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ text, categories: buildCategoryPayload(), today: todayIso }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.amount) {
        throw { handled: true, code: data.error };
      }

      input.value = "";
      fillExpenseFormFrom(data);
      showAiQuickMascot("done");
      showToast("✨ Preenchido pela IA! Confira os dados e clique em Registrar.");
    } catch (err) {
      // Se a IA falhar por qualquer motivo (cota grátis esgotada, sem
      // internet, backend ainda não configurado...), caímos para o
      // reconhecimento local — assim o recurso nunca trava de vez.
      // O mascote some na hora aqui: ele representa especificamente a IA
      // funcionando, então não faz sentido "comemorar" um resultado que
      // veio do reconhecimento local.
      hideAiQuickMascot();
      if (!err?.handled) console.error("Erro ao chamar a IA:", err);

      const local = parseFinanceText(text);
      if (!local.amount || local.amount <= 0) {
        const friendly = ERROR_MESSAGES[err?.code];
        showToast(
          friendly
            ? `${friendly} Não consegui entender a frase localmente também — preencha manualmente abaixo.`
            : 'Não consegui entender esse lançamento. Tente incluir um valor (ex.: "32 reais") ou preencha manualmente.'
        );
        return;
      }

      input.value = "";
      fillExpenseFormFrom(local);
      const friendly = ERROR_MESSAGES[err?.code];
      showToast(friendly ? `${friendly} Usei o reconhecimento local — confira os dados.` : "✨ Preenchido (modo local)! Confira os dados e clique em Registrar.");
    } finally {
      button.disabled = false;
      input.disabled  = false;
      if (label) label.textContent = "Preencher";
    }
  }

  button.addEventListener("click", runAiQuickEntry);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runAiQuickEntry();
    }
  });
}

// Evita repetir o mesmo aviso de meta várias vezes na mesma sessão
const shownFinGoalAlerts = new Set();

// Depois de lançar uma despesa, verifica se a categoria bateu 90% ou 100%
// da meta definida para ela naquele mês, e avisa com um toast (chega com
// um pequeno atraso pra não sobrepor o toast de "Despesa registrada!").
function checkFinGoalAlert(categoryId, monthKey) {
  const goal = (state.finGoals || []).find((g) => g.categoryId === categoryId);
  if (!goal || !goal.limit) return;

  const spent = (state.finances || [])
    .filter((f) => f.date.startsWith(monthKey) && f.type === "despesa" && f.category === categoryId)
    .reduce((s, f) => s + f.amount, 0);
  const pct = (spent / goal.limit) * 100;
  const cat = findCategory(categoryId);
  const label = cat.label.replace(/^\S+\s*/, "");

  const key100 = `${monthKey}:${categoryId}:100`;
  const key90  = `${monthKey}:${categoryId}:90`;

  if (pct >= 100 && !shownFinGoalAlerts.has(key100)) {
    shownFinGoalAlerts.add(key100);
    window.setTimeout(() => showToast(`🚨 Meta de "${label}" ultrapassada: ${formatCurrency(spent)} de ${formatCurrency(goal.limit)}`), 2400);
  } else if (pct >= 90 && !shownFinGoalAlerts.has(key90)) {
    shownFinGoalAlerts.add(key90);
    window.setTimeout(() => showToast(`⚠️ Você já usou ${Math.round(pct)}% da meta de "${label}"`), 2400);
  }
}

function saveExpense(event) {
  event.preventDefault();
  const editId = valueOf("#expenseId");
  const type = document.querySelector("#expenseType").value || "despesa";

  // Bloqueia salvar se o mês ativo estiver fechado
  const targetDate = valueOf("#expenseDate") || todayIso;
  const targetMonth = targetDate.slice(0, 7);
  if (isMonthClosed(targetMonth)) {
    showToast("⚠️ Este mês está fechado. Reabra-o para adicionar lançamentos.");
    return;
  }

  const defaultCategory = type === "receita" ? "outros_receita" : "outros";
  const amount = parseFloat(valueOf("#expenseAmount").replace(",", "."));
  if (isNaN(amount) || amount <= 0) { showToast("Informe um valor válido."); return; }

  const categoryId = valueOf("#expenseCategory") || defaultCategory;
  // Antes, quando a descrição ficava em branco, o título do lançamento caía
  // num texto genérico fixo ("Receita"/"Despesa"), não importa qual categoria
  // tivesse sido escolhida. Agora ele usa o nome real da categoria selecionada.
  const fallbackDescription = findCategory(categoryId).label.replace(/^\S+\s*/, "");

  if (!state.finances) state.finances = [];

  if (editId) {
    // Modo edição: atualiza o registro existente
    state.finances = state.finances.map((f) =>
      f.id === editId
        ? {
            ...f,
            type,
            amount,
            category: categoryId,
            description: valueOf("#expenseDescription") || fallbackDescription,
            date: valueOf("#expenseDate") || todayIso,
          }
        : f
    );
    showToast("✏️ Registro atualizado!");
  } else {
    const entry = {
      id: crypto.randomUUID(),
      type,
      amount,
      category: categoryId,
      description: valueOf("#expenseDescription") || fallbackDescription,
      date: valueOf("#expenseDate") || todayIso,
    };
    state.finances.unshift(entry);
    showToast(type === "receita" ? "Receita adicionada!" : "Despesa registrada!");
  }

  saveState();
  renderFinances();
  resetExpenseForm();
  if (type === "despesa") checkFinGoalAlert(categoryId, targetMonth);
}

function resetExpenseForm() {
  document.querySelector("#expenseForm").reset();
  document.querySelector("#expenseId").value = "";
  document.querySelector("#expenseDate").value = todayIso;
  document.querySelector("#expenseType").value = "despesa";
  document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.toggle("active", b.dataset.finType === "despesa"));
  document.querySelector(".fin-form-card")?.classList.remove("is-receita");
  populateCategorySelect(null, "despesa");
  // Restaura o texto do botão e título do formulário
  const submitBtn = document.querySelector("#expenseForm button[type=submit]");
  if (submitBtn) submitBtn.textContent = "➕ Registrar";
  const cancelBtn = document.querySelector("#cancelEditExpense");
  if (cancelBtn) cancelBtn.hidden = true;
}

function editFinance(id) {
  const entry = state.finances.find((f) => f.id === id);
  if (!entry) return;

  setView("finances");

  document.querySelector("#expenseId").value          = entry.id;
  document.querySelector("#expenseAmount").value       = String(entry.amount).replace(".", ",");
  document.querySelector("#expenseDescription").value  = entry.description || "";
  document.querySelector("#expenseDate").value         = entry.date;
  document.querySelector("#expenseType").value         = entry.type;
  document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.toggle("active", b.dataset.finType === entry.type));
  document.querySelector(".fin-form-card")?.classList.toggle("is-receita", entry.type === "receita");

  populateCategorySelect(entry.category, entry.type);

  const submitBtn = document.querySelector("#expenseForm button[type=submit]");
  if (submitBtn) submitBtn.textContent = "💾 Salvar alterações";
  const cancelBtn = document.querySelector("#cancelEditExpense");
  if (cancelBtn) cancelBtn.hidden = false;

  document.querySelector("#expenseAmount").focus();
  document.querySelector(".fin-form-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteFinance(id) {
  state.finances = state.finances.filter((f) => f.id !== id);
  saveState();
  renderFinances();
  showToast("Registro removido.");
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

// Mesma formatação, mas com espaço comum em vez do espaço não-quebrável
// (U+00A0) que o Intl usa entre "R$" e o número. Nos cards de resumo
// (Receitas/Despesas/Saldo) esse NBSP impedia qualquer quebra de linha
// ali — mesmo com white-space:normal no CSS, um espaço não-quebrável não
// conta como ponto de quebra, então o autofit em JS não tinha pra onde
// quebrar como último recurso e o valor ficava cortado pelo overflow:
// hidden do card. Usada só onde precisamos que o valor possa quebrar.
function formatCurrencyWrappable(value) {
  return formatCurrency(value).replace(/\u00A0/g, " ");
}

// Autofit dos valores dos cards de resumo (Receitas/Despesas/Saldo): em vez
// de confiar só no clamp() em CSS (que precisa "adivinhar" um piso de
// tamanho que sirva pra qualquer valor, e acabava cortando valores maiores
// tipo "R$ 2.927,31" em 3 colunas numa tela estreita), aqui a gente mede o
// tamanho REAL do texto renderizado e reduz a fonte só o necessário até
// caber inteiro — funciona pra qualquer quantidade de dígitos, em
// qualquer largura de tela, sem cortar nada.
function fitCurrencyValues(...ids) {
  // Duplo rAF: espera o layout do frame atual (novo texto já aplicado)
  // assentar antes de medir — medir cedo demais pode pegar larguras de
  // antes do texto novo entrar, e a fonte fica maior do que deveria.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      // Teto = o tamanho de fonte que o CSS já definiria naturalmente pra
      // esse elemento (clamp() do Financeiro, 1.7rem do card do dashboard,
      // etc.). Lendo isso em vez de usar um valor fixo, a mesma função
      // serve pra cards de tamanhos diferentes sem encolher um valor que
      // já cabia perfeitamente do jeito dele.
      el.style.fontSize = "";
      const maxPx = parseFloat(getComputedStyle(el).fontSize) || 19.2;
      const minPx = Math.min(9.5, maxPx); // nunca fica ilegível, mesmo em telas minúsculas
      // Mede sempre numa linha só (nowrap), senão o CSS já quebraria o
      // texto sozinho e o scrollWidth pareceria "cabendo" mesmo quando dá
      // pra reduzir a fonte e caber tudo numa linha. white-space volta a
      // "normal" (permite quebrar) só como último recurso lá embaixo.
      el.style.whiteSpace = "nowrap";
      el.style.fontSize = `${maxPx}px`;
      // Card ainda não está visível (ex.: outra aba ativa) — sem largura
      // real pra medir agora; deixa o CSS/clamp cuidar até a próxima vez
      // que essa função rodar com o card visível.
      if (el.clientWidth === 0) return;
      let fontPx = maxPx;
      while (el.scrollWidth > el.clientWidth + 0.5 && fontPx > minPx) {
        fontPx -= 0.5;
        el.style.fontSize = `${fontPx}px`;
      }
      // Mesmo na fonte mínima o valor não coube numa linha só (ex.: "-R$
      // 2.927,35" em 3 colunas numa tela bem estreita) — em vez de cortar
      // com "...", deixa quebrar em duas linhas ("R$" / "2.927,35") pra
      // garantir que o valor inteiro sempre fique visível.
      if (el.scrollWidth > el.clientWidth + 0.5) {
        el.style.whiteSpace = "normal";
      }
    });
  }));
}

window.addEventListener("resize", () => {
  if (document.querySelector("#financesView.active-view")) {
    fitCurrencyValues("finReceitas", "finDespesas", "finSaldo");
  }
  if (document.querySelector("#dashboardView.active-view")) {
    fitCurrencyValues("summaryFinSaldo", "dashFinReceitas", "dashFinDespesas", "dashFinSaldo");
  }
});

function renderFinances() {
  if (!document.querySelector("#financesView")) return;
  if (!state.finances) state.finances = [];

  const monthKey  = getActiveFinMonth();
  const closed    = isMonthClosed(monthKey);
  const todayMonth = todayIso.slice(0, 7);

  // ── Atualiza o navegador de mês ──────────────────────────────
  const labelEl   = document.querySelector("#finMonthLabel");
  const badgeEl   = document.querySelector("#finClosedBadge");
  const closeBtn  = document.querySelector("#finCloseMonth");
  const reopenBtn = document.querySelector("#finReopenMonth");
  const formCard  = document.querySelector(".fin-form-card");

  if (labelEl)  labelEl.textContent = finMonthLabel(monthKey);
  if (badgeEl)  badgeEl.hidden = !closed;
  if (closeBtn) closeBtn.hidden = closed;
  if (reopenBtn) reopenBtn.hidden = !closed;
  // Formulário de novo lançamento desabilitado em mês fechado
  if (formCard) formCard.classList.toggle("month-closed", closed);

  // ── Filtra lançamentos do mês ativo ──────────────────────────
  let entries = [...state.finances]
    .filter((f) => f.date.startsWith(monthKey))
    .sort((a, b) => b.date.localeCompare(a.date));

  // Aplica a busca global (por descrição ou categoria)
  const query = elements.globalSearch.value.trim().toLowerCase();
  if (query) {
    entries = entries.filter((f) => {
      const cat = findCategory(f.category);
      return (f.description || "").toLowerCase().includes(query)
          || cat.label.toLowerCase().includes(query);
    });
  }

  const receitas    = entries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const despesas    = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
  const saldoAnterior = getCarryOverBalance(monthKey);
  const saldo       = saldoAnterior + receitas - despesas;
  const usedPct     = receitas > 0 ? Math.min(100, Math.round((despesas / receitas) * 100)) : 0;

  document.querySelector("#finReceitas").textContent  = formatCurrencyWrappable(receitas);
  document.querySelector("#finDespesas").textContent  = formatCurrencyWrappable(despesas);
  document.querySelector("#finSaldo").textContent     = formatCurrencyWrappable(saldo);
  document.querySelector("#finSaldoCard").style.setProperty("--saldo-color", saldo >= 0 ? "var(--green)" : "var(--red)");
  fitCurrencyValues("finReceitas", "finDespesas", "finSaldo");
  const saldoCardEl = document.querySelector("#finSaldoCard");
  if (saldoCardEl) {
    saldoCardEl.classList.toggle("has-carryover", saldoAnterior !== 0);
    saldoCardEl.title = saldoAnterior !== 0
      ? `Inclui ${formatCurrency(Math.abs(saldoAnterior))} ${saldoAnterior >= 0 ? "de saldo" : "de saldo negativo"} vindo do mês anterior`
      : "";
  }
  document.querySelector("#finProgressBar").style.width = `${usedPct}%`;
  document.querySelector("#finProgressBar").style.background = usedPct > 80 ? "var(--red)" : usedPct > 60 ? "var(--orange)" : "var(--green)";
  document.querySelector("#finUsedLabel").textContent = `${usedPct}% das receitas usadas`;
  updateFinMood(saldo, usedPct);

  // Distribuição por categoria
  const byCat = {};
  entries.filter((f) => f.type === "despesa").forEach((f) => {
    byCat[f.category] = (byCat[f.category] || 0) + f.amount;
  });

  const catHtml = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([catId, total]) => {
      const cat = findCategory(catId);
      const pct = despesas > 0 ? Math.round((total / despesas) * 100) : 0;
      return `
        <div class="fin-cat-row">
          <div class="fin-cat-info">
            <span class="fin-cat-dot" style="background:${cat.color}"></span>
            <span class="fin-cat-label">${escapeHtml(cat.label)}</span>
          </div>
          <div class="fin-cat-bar-wrap">
            <div class="fin-cat-bar" style="width:${pct}%;background:${cat.color}20;outline:2px solid ${cat.color}40"></div>
          </div>
          <span class="fin-cat-value">${formatCurrency(total)}</span>
        </div>`;
    }).join("") || `<div class="empty-state" style="padding:12px">Sem despesas no período</div>`;

  document.querySelector("#finCategories").innerHTML = catHtml;
  renderFinInsights(monthKey, entries, receitas, despesas, byCat);

  const listHtml = entries.length
    ? entries.slice(0, 50).map((f) => renderFinTransaction(f)).join("")
    : `<div class="empty-state">${query ? "Nenhum resultado para essa busca 🔍" : "Nenhum registro no período 📭"}</div>`;

  document.querySelector("#finTransactions").innerHTML = listHtml;

  renderFinCalendar(monthKey, entries);
  renderFinChart6m();
  renderFinSaldoEvolution();
  renderFinGoals();
  renderFinClosures();
  renderFinRecurrents();
}

function renderFinInsights(monthKey, entries, receitas, despesas, byCat) {
  const root = document.querySelector("#finInsights");
  if (!root) return;

  const [year, month] = monthKey.split("-").map(Number);
  const previousKey = toLocalIso(new Date(year, month - 2, 1)).slice(0, 7);
  const previousExpenses = (state.finances || [])
    .filter((item) => item.date.startsWith(previousKey) && item.type === "despesa")
    .reduce((sum, item) => sum + item.amount, 0);
  const top = Object.entries(byCat).sort(([, a], [, b]) => b - a)[0];
  const topCategory = top ? findCategory(top[0]) : null;
  const change = despesas - previousExpenses;
  const changePercent = previousExpenses > 0 ? Math.round((change / previousExpenses) * 100) : null;
  const balance = receitas - despesas;
  const movementCount = entries.length;

  const variationText = previousExpenses === 0
    ? (despesas > 0 ? "Primeiro mês com despesas" : "Sem gastos comparáveis")
    : `${Math.abs(changePercent)}% ${change > 0 ? "a mais" : change < 0 ? "a menos" : "igual"} que o mês anterior`;
  const variationTone = change > 0 ? "warning" : change < 0 ? "positive" : "neutral";

  root.innerHTML = `
    <article class="fin-insight-card primary">
      <span class="fin-insight-label">Resultado do mês</span>
      <strong>${formatCurrency(balance)}</strong>
      <small>${receitas > 0 ? `${Math.round((despesas / receitas) * 100)}% da receita foi usada` : "Adicione receitas para acompanhar o equilíbrio"}</small>
    </article>
    <article class="fin-insight-card ${variationTone}">
      <span class="fin-insight-label">Comparação de gastos</span>
      <strong>${formatCurrency(despesas)}</strong>
      <small>${variationText}</small>
    </article>
    <article class="fin-insight-card neutral">
      <span class="fin-insight-label">Maior categoria</span>
      <strong>${topCategory ? escapeHtml(topCategory.label) : "Ainda sem despesas"}</strong>
      <small>${top ? `${formatCurrency(top[1])} em ${movementCount} lançamento${movementCount === 1 ? "" : "s"}` : "Os insights aparecem ao registrar despesas"}</small>
    </article>`;
}

// Reação de humor do Pulsinho ao saldo do mês — mesmos números que já
// alimentam os cards e a barra de orçamento, só que agora com uma
// carinha em vez de só cor. Saldo negativo pesa mais que o % gasto:
// mesmo tendo gastado pouco das receitas, saldo negativo (por causa de
// saldo anterior negativo, por exemplo) ainda é o sinal mais importante.
function updateFinMood(saldo, usedPct) {
  const blob = document.querySelector("#finMoodBlob");
  const text = document.querySelector("#finMoodText");
  if (!blob || !text) return;

  let mood, message;
  if (saldo < 0) {
    mood = "worried";
    message = "Saldo negativo esse mês — bora dar uma olhada nas despesas.";
  } else if (usedPct > 80) {
    mood = "concerned";
    message = `Já foram ${usedPct}% das receitas — segura um pouco até o fim do mês.`;
  } else {
    mood = "happy";
    message = "Saldo tranquilo por enquanto — continue assim!";
  }

  blob.classList.remove("mood-happy", "mood-concerned", "mood-worried");
  blob.classList.add(`mood-${mood}`);
  text.textContent = message;
}

function renderFinTransaction(f) {
  const cat = findCategory(f.category);
  const isReceita = f.type === "receita";
  // Antes, toda receita aparecia igual ("💰" + "Receita"), não importa qual
  // categoria (Salário, Freelance, Vendas...) tivesse sido escolhida no
  // formulário. Agora mostramos sempre o ícone/cor/nome da categoria
  // realmente selecionada — igual já acontecia para despesas.
  const icon    = cat.label.split(" ")[0];
  const catName = cat.label.replace(/^\S+\s*/, "");
  // Layout em 2 linhas: título+valor numa linha, categoria/data+ações na
  // outra. Antes tudo (ícone + título + valor + editar + excluir) disputava
  // uma única linha, sobrando pouquíssimo espaço pro título — por isso
  // descrições como "Alimentação" apareciam cortadas em "Alimen...".
  return `
    <article class="fin-transaction" data-fin-id="${f.id}">
      <div class="fin-tx-icon" style="background:${cat.color}22;color:${cat.color}">
        ${icon}
      </div>
      <div class="fin-tx-main">
        <div class="fin-tx-top">
          <strong class="fin-tx-title" title="${escapeHtml(f.description)}">${escapeHtml(f.description)}</strong>
          <span class="fin-tx-amount ${isReceita ? "receita" : "despesa"}">${isReceita ? "+" : "-"}${formatCurrency(f.amount)}</span>
        </div>
        <div class="fin-tx-bottom">
          <span class="task-meta fin-tx-meta">${escapeHtml(catName)} · ${formatDate(f.date)}</span>
          <div class="fin-tx-actions">
            <button class="mini-button" onclick="editFinance('${f.id}')" title="Editar">✏️</button>
            <button class="mini-button" onclick="deleteFinance('${f.id}')" title="Excluir">🗑️</button>
          </div>
        </div>
      </div>
    </article>`;
}

function renderFinCalendar(monthKey, entries) {
  const grid = document.querySelector("#finCalGrid");
  if (!grid) return;
  // Sincroniza o título do calendário com o mês ativo
  const calLabel = document.querySelector("#finCalMonthLabel");
  if (calLabel) calLabel.textContent = finMonthLabel(monthKey);
  const [year, month] = monthKey.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const byDay = {};
  entries.forEach((f) => {
    const day = f.date.slice(8, 10);
    if (!byDay[day]) byDay[day] = { receita: 0, despesa: 0 };
    byDay[day][f.type] += f.amount;
  });
  const days = [...Array(daysInMonth)].map((_, i) => {
    const d = String(i + 1).padStart(2, "0");
    const data = byDay[d];
    const dateStr = `${monthKey}-${d}`;
    const isToday = dateStr === todayIso;
    let dot = "";
    if (data) {
      if (data.receita > 0 && data.despesa > 0) dot = `<span class="fin-day-dot both"></span>`;
      else if (data.receita > 0) dot = `<span class="fin-day-dot receita"></span>`;
      else if (data.despesa > 0) dot = `<span class="fin-day-dot despesa"></span>`;
    }
    return `<button class="fin-cal-day ${isToday ? "today" : ""} ${data ? "has-data" : ""}" onclick="filterFinByDate('${dateStr}')"><strong>${i + 1}</strong>${dot}</button>`;
  });
  grid.innerHTML = days.join("");
}

function filterFinByDate(date) {
  const entries = state.finances.filter((f) => f.date === date);
  const listHtml = entries.length
    ? entries.map((f) => renderFinTransaction(f)).join("")
    : `<div class="empty-state">Sem registros neste dia 📭</div>`;
  document.querySelector("#finTransactions").innerHTML = listHtml;
}

// Preenche o <select> (oculto, mantido só por compatibilidade/valueOf) de
// categorias com as fixas + customizadas do usuário. Se selectedId for
// passado, marca essa opção como selecionada. Depois sincroniza o botão
// visível (#expenseCategoryTrigger) que o usuário realmente vê e toca.
function populateCategorySelect(selectedId, type = document.querySelector("#expenseType")?.value || "despesa") {
  const select = document.querySelector("#expenseCategory");
  if (!select) return;
  const current = selectedId || (select.dataset.type === type ? select.value : null);
  select.dataset.type = type;
  select.innerHTML = getAllCategories(type)
    .map((cat) => `<option value="${escapeHtml(cat.id)}">${escapeHtml(cat.label)}</option>`)
    .join("");
  if (current) select.value = current;
  // Se a categoria selecionada anteriormente não existir mais nesse tipo
  // (ex.: foi excluída, ou trocou de despesa pra receita), o <select> volta
  // sozinho pra primeira opção — sincroniza o botão com esse valor real.
  syncCategoryTrigger();

  // Texto e atalhos mudam de cara para deixar claro que "categoria de receita"
  // não é a mesma coisa que "categoria de despesa"
  const label = document.querySelector("#expenseCategoryLabel");
  const description = document.querySelector("#expenseDescription");
  if (label) label.textContent = type === "receita" ? "De onde veio" : "Categoria";
  if (description) description.placeholder = type === "receita" ? "Ex.: Salário de junho, Venda do sofá..." : "Ex.: Almoço, Uber...";
}

// Atualiza o texto/ícone do botão visível de categoria a partir do valor
// atual do <select> oculto — chamado sempre que esse valor muda (seleção
// manual no picker, preenchimento por IA, edição de lançamento existente).
function syncCategoryTrigger() {
  const select = document.querySelector("#expenseCategory");
  const trigger = document.querySelector("#expenseCategoryTrigger");
  if (!select || !trigger) return;
  const cat = findCategory(select.value);
  const iconEl = trigger.querySelector("#expenseCategoryTriggerIcon");
  const labelEl = trigger.querySelector("#expenseCategoryTriggerLabel");
  if (iconEl) iconEl.textContent = cat.label.split(" ")[0];
  if (labelEl) labelEl.textContent = cat.label.replace(/^\S+\s*/, "");
}

// Remove acentos e caixa para permitir busca "solta" (ex.: "cafe" encontra
// "Café", "alimentacao" encontra "Alimentação") — usado só na busca do
// picker de categorias, nunca para salvar dados.
function normalizeForSearch(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Exclui uma categoria criada pelo usuário (nunca uma categoria fixa do
// app). Lançamentos já registrados nela continuam existindo — só a opção
// some da lista; se a categoria excluída for a que está selecionada no
// formulário agora, o formulário volta pra "Outros" daquele tipo.
function deleteCustomCategory(catId, onDone) {
  const cat = (state.customCategories || []).find((c) => c.id === catId);
  if (!cat) return;
  const cleanName = cat.label.replace(/^\S+\s*/, "");
  if (!confirm(`Excluir a categoria "${cleanName}"?\n\nLançamentos já registrados nela continuam salvos, só a opção some da lista.`)) return;

  state.customCategories = state.customCategories.filter((c) => c.id !== catId);
  saveState();

  const select = document.querySelector("#expenseCategory");
  const type = document.querySelector("#expenseType")?.value || "despesa";
  if (select && select.value === catId) {
    populateCategorySelect(type === "receita" ? "outros_receita" : "outros", type);
  }
  showToast(`🗑️ Categoria "${cleanName}" excluída.`);
  onDone?.();
}

// Sheet de seleção de categoria: busca em tempo real pelas categorias já
// existentes (fixas + criadas pelo usuário) e, se o texto digitado não
// corresponder a nenhuma, oferece criar uma categoria nova com esse nome já
// preenchido — assim o usuário nunca fica "preso" às categorias prontas e
// consegue detalhar exatamente o que quer, no menor número de toques.
function openCategoryPicker() {
  document.getElementById("categoryPickerModal")?.remove();

  const type = document.querySelector("#expenseType")?.value || "despesa";
  const currentId = document.querySelector("#expenseCategory")?.value;
  const trigger = document.querySelector("#expenseCategoryTrigger");
  trigger?.setAttribute("aria-expanded", "true");

  const modal = document.createElement("div");
  modal.id = "categoryPickerModal";
  modal.style.cssText = `position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.45);
    backdrop-filter:blur(6px);display:grid;place-items:center;padding:20px`;

  modal.innerHTML = `
    <div style="background:var(--surface);border-radius:24px;padding:22px;width:100%;max-width:380px;
      box-shadow:0 20px 60px rgba(0,0,0,0.25);animation:fadeUp 200ms ease;
      max-height:85dvh;display:flex;flex-direction:column">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-shrink:0">
        <div>
          <h2 style="font-size:1.1rem;font-weight:800;color:var(--text)">${type === "receita" ? "De onde veio" : "Categoria"}</h2>
          <p style="font-size:0.78rem;color:var(--muted);margin-top:2px">Busque, escolha ou crie a categoria exata que você quer</p>
        </div>
        <button id="closeCategoryPicker" style="width:30px;height:30px;border-radius:10px;
          background:var(--surface2);border:none;font-size:1rem;cursor:pointer;color:var(--text2);flex-shrink:0">✕</button>
      </div>

      <input id="categoryPickerSearch" placeholder="Buscar ou digitar uma categoria nova..." autocomplete="off" maxlength="24"
        style="width:100%;min-height:46px;border:1.5px solid var(--line);border-radius:14px;
        padding:8px 14px;background:var(--surface2);color:var(--text);font-size:0.92rem;font:inherit;
        margin-bottom:12px;flex-shrink:0"/>

      <div id="categoryPickerList" style="display:grid;gap:6px;overflow-y:auto;padding-right:2px"></div>
    </div>
  `;

  document.body.appendChild(modal);

  const listEl = modal.querySelector("#categoryPickerList");
  const searchEl = modal.querySelector("#categoryPickerSearch");

  function closePicker() {
    trigger?.setAttribute("aria-expanded", "false");
    modal.remove();
  }

  function selectCategory(catId) {
    const select = document.querySelector("#expenseCategory");
    select.value = catId;
    select.dispatchEvent(new Event("change"));
    syncCategoryTrigger();
    closePicker();
  }

  function render(query) {
    const q = normalizeForSearch(query || "");
    const all = getAllCategories(type);
    const filtered = q ? all.filter((cat) => normalizeForSearch(cat.label).includes(q)) : all;
    const hasExactMatch = all.some((cat) => normalizeForSearch(cat.label.replace(/^\S+\s*/, "")) === q);

    function rowHtml(cat) {
      const isSelected = cat.id === currentId;
      const isCustom = cat.id.startsWith("custom_");
      const cleanLabel = cat.label.replace(/^\S+\s*/, "");
      const emoji = cat.label.split(" ")[0];
      return `
        <div class="cat-picker-row${isSelected ? " is-selected" : ""}" data-cat-id="${escapeHtml(cat.id)}"
          style="--cat-color:${cat.color}">
          <span class="cat-picker-icon">${emoji}</span>
          <span class="cat-picker-label">${escapeHtml(cleanLabel)}</span>
          ${isSelected ? `<span class="cat-picker-check">✓</span>` : ""}
          ${isCustom ? `<button type="button" class="cat-picker-delete" data-del-id="${escapeHtml(cat.id)}" title="Excluir categoria">🗑️</button>` : ""}
        </div>`;
    }

    let bodyHtml;

    if (q) {
      // Buscando: lista simples e achatada, sem seções — o que importa
      // aqui é achar rápido, agrupar só atrapalharia o escaneio.
      bodyHtml = filtered.map(rowHtml).join("");
    } else {
      // Sem busca: "Mais usadas" (baseado no histórico real) primeiro,
      // depois o resto organizado por grupo temático — muito mais fácil
      // de escanear do que uma parede de 26 categorias soltas.
      const mostUsedIds = getMostUsedCategoryIds(type);
      const mostUsed = mostUsedIds.map((id) => all.find((c) => c.id === id)).filter(Boolean);
      const mostUsedSet = new Set(mostUsedIds);

      const groups = new Map();
      all.forEach((cat) => {
        if (mostUsedSet.has(cat.id)) return; // já apareceu em "Mais usadas"
        const groupName = cat.group || (cat.id.startsWith("custom_") ? "Personalizadas" : "Outros");
        if (!groups.has(groupName)) groups.set(groupName, []);
        groups.get(groupName).push(cat);
      });

      const sectionsHtml = [];
      if (mostUsed.length) {
        sectionsHtml.push(`<div class="cat-picker-section">
          <p class="cat-picker-section-title" style="display:flex;align-items:center;gap:5px">${icon("star", 12)}Mais usadas</p>
          ${mostUsed.map(rowHtml).join("")}
        </div>`);
      }
      groups.forEach((cats, groupName) => {
        sectionsHtml.push(`<div class="cat-picker-section">
          <p class="cat-picker-section-title">${escapeHtml(groupName)}</p>
          ${cats.map(rowHtml).join("")}
        </div>`);
      });
      bodyHtml = sectionsHtml.join("");
    }

    const emptyHtml = filtered.length ? "" : `<div style="padding:6px 2px">${emptyStateCompactHtml({ iconName: "inbox", text: "Nenhuma categoria encontrada." })}</div>`;

    const createHtml = (query || "").trim() && !hasExactMatch ? `
      <button type="button" id="categoryPickerCreate" data-name="${escapeHtml(query.trim())}"
        style="display:flex;align-items:center;gap:10px;padding:12px;border-radius:14px;cursor:pointer;
        border:1.5px dashed var(--accent);background:var(--accent-soft);color:var(--accent);
        font-weight:700;font-size:0.88rem;margin-top:2px;width:100%;text-align:left;font-family:inherit">
        <span style="font-size:1.1rem;flex-shrink:0">➕</span>
        <span>Criar categoria "${escapeHtml(query.trim())}"</span>
      </button>` : "";

    listEl.innerHTML = bodyHtml + emptyHtml + createHtml;

    listEl.querySelectorAll(".cat-picker-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".cat-picker-delete")) return;
        selectCategory(row.dataset.catId);
      });
    });
    listEl.querySelectorAll(".cat-picker-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteCustomCategory(btn.dataset.delId, () => render(searchEl.value));
      });
    });
    listEl.querySelector("#categoryPickerCreate")?.addEventListener("click", (e) => {
      const name = e.currentTarget.dataset.name;
      closePicker();
      openNewCategoryPrompt(name);
    });
  }

  render("");
  searchEl.addEventListener("input", () => render(searchEl.value));
  searchEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Enter com resultado único visível seleciona direto; senão, se houver
    // opção de criar categoria nova, cria; economiza toques no celular.
    const rows = listEl.querySelectorAll(".cat-picker-row");
    const createBtn = listEl.querySelector("#categoryPickerCreate");
    if (rows.length === 1 && !createBtn) selectCategory(rows[0].dataset.catId);
    else createBtn?.click();
  });
  searchEl.focus();

  modal.querySelector("#closeCategoryPicker").addEventListener("click", closePicker);
  modal.addEventListener("click", (e) => { if (e.target === modal) closePicker(); });
}

// Catálogo de ícones do "Nova categoria", organizado em grupos temáticos
// (em vez de uma lista única de emojis soltos) — assim dá pra oferecer
// muito mais opções sem virar bagunça: a pessoa navega por abas curtas
// (Casa, Alimentação, Transporte...) em vez de rolar uma parede de emoji,
// ou digita no campo de busca e encontra o ícone certo na hora.
// Cada ícone carrega um nome pesquisável (em português, sem acento na hora
// da comparação) — é o que permite a busca por texto funcionar de verdade.
const NEW_CATEGORY_ICON_GROUPS = [
  { key: "casa", label: "🏠 Casa", icons: [
    ["🏠","casa"], ["💡","luz energia"], ["🚿","chuveiro água"], ["🔑","chave aluguel"],
    ["🛋️","sofá móveis"], ["🧹","limpeza faxina"], ["🪴","planta jardim"], ["📺","tv televisão"],
    ["🧺","lavanderia roupa"], ["🛏️","cama quarto"], ["🔥","gás fogão"], ["🧯","manutenção reforma"],
    ["🪑","cadeira mobília"], ["🚪","porta condomínio"],
  ]},
  { key: "alimentacao", label: "🍔 Alimentação", icons: [
    ["🍔","lanche hambúrguer"], ["🛒","mercado supermercado"], ["🍕","pizza"], ["☕","café"],
    ["🍷","vinho bebida"], ["🍺","cerveja bar"], ["🍰","doce sobremesa"], ["🥗","salada saudável"],
    ["🍣","sushi japonês"], ["🥪","sanduíche"], ["🍜","macarrão comida"], ["🍳","comida caseira ovo"],
    ["🧃","suco bebida"], ["🍽️","restaurante refeição"],
  ]},
  { key: "transporte", label: "🚗 Transporte", icons: [
    ["🚗","carro"], ["⛽","combustível gasolina"], ["🚕","táxi"], ["🚌","ônibus"],
    ["🚲","bicicleta"], ["🛵","moto"], ["🅿️","estacionamento"], ["🚆","trem"],
    ["🚉","metrô estação"], ["🛣️","estrada pedágio"], ["🚙","carro suv"], ["🔧","manutenção mecânico"],
  ]},
  { key: "saude", label: "💊 Saúde", icons: [
    ["💊","remédio farmácia"], ["🏋️","academia treino"], ["🧘","yoga bem-estar"], ["💅","estética beleza"],
    ["🦷","dentista"], ["👓","óculos"], ["🩺","médico consulta"], ["🧴","cuidados higiene"],
    ["🧠","psicólogo terapia"], ["😷","saúde remédio"], ["🩹","farmácia curativo"], ["🏥","hospital plano"],
  ]},
  { key: "lazer", label: "🎬 Lazer", icons: [
    ["🎬","cinema filme"], ["🎮","jogo videogame"], ["🎉","festa evento"], ["🎵","música show"],
    ["📷","fotografia hobby"], ["⚽","esporte futebol"], ["🎲","jogo tabuleiro"], ["🎨","arte hobby"],
    ["🎤","show karaokê"], ["🍿","cinema pipoca"], ["🎳","boliche lazer"], ["🎯","hobby diversão"],
  ]},
  { key: "educacao", label: "🎓 Educação", icons: [
    ["🎓","faculdade formatura"], ["📚","livros estudo"], ["✏️","material escolar"], ["🖊️","caneta escrita"],
    ["🏫","escola curso"], ["🧑‍🏫","aula professor"], ["💻","curso online"], ["📖","leitura livro"],
    ["🧮","matemática cálculo"], ["🔬","ciência laboratório"],
  ]},
  { key: "trabalho", label: "💼 Trabalho", icons: [
    ["💼","trabalho emprego"], ["💻","computador notebook"], ["📈","investimento gráfico"], ["📊","relatório análise"],
    ["🗂️","documentos arquivo"], ["📎","escritório material"], ["🧑‍💻","home office"], ["🖨️","impressora"],
    ["📅","agenda reunião"], ["✉️","email correspondência"],
  ]},
  { key: "compras", label: "🛍️ Compras", icons: [
    ["👗","roupa vestido"], ["👟","tênis calçado"], ["💍","joia presente"], ["🛍️","compras loja"],
    ["📱","celular eletrônico"], ["🧸","brinquedo"], ["👜","bolsa acessório"], ["🕶️","óculos acessório"],
    ["👔","roupa social"], ["🎒","mochila"], ["🛋️","móveis decoração"], ["🧴","cosmético beleza"],
  ]},
  { key: "tecnologia", label: "💻 Tecnologia", icons: [
    ["💻","notebook computador"], ["📱","celular smartphone"], ["🖥️","monitor desktop"], ["🎧","fone áudio"],
    ["⌨️","teclado periférico"], ["🖱️","mouse periférico"], ["🔌","carregador cabo"], ["📷","câmera equipamento"],
    ["🕹️","controle videogame"], ["📡","internet wifi"],
  ]},
  { key: "pets", label: "🐾 Pets", icons: [
    ["🐾","pet animal"], ["🐶","cachorro"], ["🐱","gato"], ["🦴","ração petisco"],
    ["🐠","peixe aquário"], ["🐦","pássaro"], ["🏥","veterinário"], ["🛁","banho tosa"],
  ]},
  { key: "familia", label: "👶 Família", icons: [
    ["👶","bebê filho"], ["👨‍👩‍👧","família"], ["🍼","mamadeira bebê"], ["🧸","brinquedo criança"],
    ["🎠","criança lazer"], ["🧑‍🍼","cuidados bebê"], ["🏫","escola filho"], ["👵","idoso avó"],
  ]},
  { key: "presentes", label: "🎁 Presentes", icons: [
    ["🎁","presente"], ["🎂","aniversário bolo"], ["💐","flores"], ["🎈","festa balão"],
    ["🎊","comemoração"], ["💝","presente carinho"], ["🎉","celebração"],
  ]},
  { key: "financas", label: "💰 Finanças", icons: [
    ["💰","dinheiro poupança"], ["🏦","banco"], ["🧾","conta boleto"], ["🛡️","seguro proteção"],
    ["💳","cartão crédito"], ["📉","gasto queda"], ["🎗️","doação"], ["🪙","moeda economia"],
    ["📑","imposto documento"], ["💸","gasto dinheiro"],
  ]},
  { key: "investimentos", label: "📈 Investimentos", icons: [
    ["📈","investimento alta"], ["📊","ações gráfico"], ["🏦","renda fixa banco"], ["🪙","criptomoeda moeda"],
    ["💹","bolsa mercado"], ["🏠","imóvel patrimônio"], ["💎","patrimônio valor"],
  ]},
  { key: "contas", label: "🧾 Contas", icons: [
    ["🧾","boleto conta"], ["💡","luz energia"], ["🚿","água"], ["📶","internet telefone"],
    ["📄","documento cobrança"], ["🏢","condomínio"], ["🔥","gás"],
  ]},
  { key: "assinaturas", label: "🔁 Assinaturas", icons: [
    ["🔁","assinatura recorrente"], ["📺","streaming vídeo"], ["🎵","streaming música"], ["📰","jornal revista"],
    ["☁️","nuvem armazenamento"], ["🎮","assinatura jogos"], ["📦","clube assinatura"],
  ]},
  { key: "viagem", label: "✈️ Viagem", icons: [
    ["✈️","viagem avião"], ["🧳","mala bagagem"], ["🗺️","turismo mapa"], ["🏖️","praia férias"],
    ["🏨","hotel hospedagem"], ["🚢","cruzeiro navio"], ["🏔️","montanha trilha"], ["🗽","turismo passeio"],
    ["🚀","aventura viagem"], ["🌍","mundo internacional"],
  ]},
  { key: "outros", label: "📦 Outros", icons: [
    ["📦","outros geral"], ["🔧","manutenção reparo"], ["❓","diverso"], ["⭐","favorito especial"],
    ["🔖","etiqueta marcador"], ["✨","especial diverso"], ["🧩","diverso variado"], ["📌","importante fixo"],
  ]},
];

// Achata o catálogo acima numa lista única de { emoji, name, groupKey } —
// usada pela busca, que precisa procurar em todos os grupos de uma vez
// (a pessoa não deveria ter que adivinhar em qual aba está o ícone certo).
const NEW_CATEGORY_ICON_FLAT = NEW_CATEGORY_ICON_GROUPS.flatMap((g) =>
  g.icons.map(([emoji, name]) => ({ emoji, name, groupKey: g.key }))
);

const NEW_CATEGORY_COLOR_OPTIONS = [
  "#8b5cf6","#5ac8fa","#ffd60a","#ff6b6b","#ff3b30","#ff375f","#ff2d55","#ff6482",
  "#bf5af2","#af52de","#5e5ce6","#5856d6","#0a84ff","#5ac8fa","#64d2ff","#30b0c7",
  "#00c7be","#30d158","#34c759","#a2845e","#8e8e93","#8a9bb0",
];

function openNewCategoryPrompt(prefillName) {
  const modal = document.createElement("div");
  modal.id = "newCategoryModal";
  modal.className = "modal-backdrop new-category-backdrop";
  modal.hidden = false;

  const groups = NEW_CATEGORY_ICON_GROUPS;
  const colorOptions = NEW_CATEGORY_COLOR_OPTIONS;
  const activeTypeForTitle = document.querySelector("#expenseType")?.value || "despesa";

  const isReceita = activeTypeForTitle === "receita";
  const nameMax = 30;

  modal.innerHTML = `
    <div class="modal-card new-category-card">
      <div class="modal-header new-category-header">
        <button class="icon-button" id="closeNewCategory" aria-label="Fechar">✕</button>
      </div>
      <div class="modal-body new-category-body">
        <div class="new-category-intro">
          <span class="new-category-icon-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 3.9 4.3.5-3.1 3 .8 4.3L12 12.6 8.2 14.7l.8-4.3-3.1-3 4.3-.5z"/><circle cx="12" cy="10" r="6.6"/></svg>
          </span>
          <h2>Nova categoria</h2>
          <p class="new-category-hint">
            Crie exatamente a categoria que você precisa, com o nome, ícone e cor que fizerem sentido pra você.
          </p>
          <span class="new-category-badge">ℹ️ Vai valer apenas para ${isReceita ? "receitas" : "despesas"}</span>
        </div>

        <label class="new-category-field">
          <span class="new-category-field-top">
            <span>Nome da categoria</span>
            <span id="newCatNameCount" class="new-category-count">0/${nameMax}</span>
          </span>
          <input id="newCatName" placeholder="Ex.: Assinaturas, Transporte..." maxlength="${nameMax}" value="${escapeHtml(prefillName || "")}" class="field-input new-category-name-input"/>
        </label>

        <p class="new-category-label">Ícone</p>
        <label class="new-category-icon-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input type="text" id="emojiSearchInput" placeholder="Pesquisar ícone... (ex.: mercado, carro, saúde)" autocomplete="off" />
        </label>
        <div id="emojiPicker" class="new-category-icon-list"></div>
        <p id="emojiNoResults" class="new-category-empty" hidden>Nenhum ícone encontrado. Tente outro termo.</p>

        <p class="new-category-label">Cor da categoria</p>
        <div id="colorPicker" class="new-category-color-grid">
          ${colorOptions.map((c, i) => `
            <button type="button" class="cat-color-btn${i === 0 ? " active" : ""}" data-color="${c}" style="background:${c}" aria-label="Cor ${c}">
              <svg class="cat-color-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
            </button>
          `).join("")}
        </div>

        <p class="new-category-label">Prévia da categoria</p>
        <div id="newCategoryPreview" class="new-category-preview">
          <span id="newCategoryPreviewIcon" class="new-category-preview-icon"></span>
          <div class="new-category-preview-info">
            <strong id="newCategoryPreviewName">Nome da categoria</strong>
            <span class="task-meta">${isReceita ? "Receita" : "Despesa"}</span>
          </div>
          <span id="newCategoryPreviewAmount" class="new-category-preview-amount ${isReceita ? "receita" : "despesa"}">${isReceita ? "+" : "-"}R$ 0,00</span>
        </div>

        <div id="newCategoryError" class="new-category-error"></div>

        <button id="saveNewCategory" class="primary-button new-category-save">
          <span class="new-category-save-icon" aria-hidden="true">＋</span>
          <span class="new-category-save-label">Criar categoria</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  let selectedEmoji = groups[0].icons[0][0];
  let selectedColor = colorOptions[0];
  let searchQuery = "";

  const emojiPickerEl = modal.querySelector("#emojiPicker");
  const emojiNoResultsEl = modal.querySelector("#emojiNoResults");
  const emojiSearchInput = modal.querySelector("#emojiSearchInput");
  const previewIconEl = modal.querySelector("#newCategoryPreviewIcon");
  const previewNameEl = modal.querySelector("#newCategoryPreviewName");
  // Declarado aqui (antes de ser usado) — antes vinha só lá embaixo, então
  // updatePreview() ficava com nameInput undefined na primeira renderização
  // e o ícone/cor de prévia não aparecia até a pessoa clicar em algo.
  const nameInput = modal.querySelector("#newCatName");

  // Preview em tempo real: reflete nome, ícone e cor conforme a pessoa
  // escolhe, pra ela ver exatamente como a categoria vai ficar antes de criar.
  function updatePreview() {
    previewIconEl.textContent = selectedEmoji;
    previewIconEl.style.background = `${selectedColor}22`;
    previewIconEl.style.color = selectedColor;
    const name = nameInput?.value.trim();
    previewNameEl.textContent = name || "Nome da categoria";
  }

  // Renderiza a lista de ícones como seções com título (🏠 Casa, 🍔
  // Alimentação...), tudo dentro do mesmo scroll do modal — sem abas
  // escondidas pra trocar de grupo. É o mesmo padrão já usado (e já
  // comprovadamente confiável) no picker de categoria existente
  // (ver openCategoryPicker / .cat-picker-section). As abas horizontais
  // que existiam antes aqui renderizavam em branco em alguns celulares
  // (bug de scroll aninhado no Safari do iOS) — uma lista única elimina
  // esse risco de vez, ao custo de precisar rolar mais pra ver tudo, o
  // que a busca por texto resolve pra quem já sabe o que quer.
  function renderEmojiGrid() {
    let sections;
    if (searchQuery) {
      const q = normalizeForSearch(searchQuery);
      const matches = NEW_CATEGORY_ICON_FLAT.filter((it) => normalizeForSearch(it.name).includes(q));
      sections = matches.length
        ? [{ label: "🔎 Resultados", icons: matches.map((it) => [it.emoji, it.name]) }]
        : [];
    } else {
      sections = groups;
    }

    emojiNoResultsEl.hidden = sections.length > 0;
    emojiPickerEl.hidden = sections.length === 0;

    emojiPickerEl.innerHTML = sections.map((section) => `
      <div class="new-category-icon-section">
        <p class="new-category-icon-section-title">${section.label}</p>
        <div class="new-category-emoji-grid">
          ${section.icons.map(([emoji, name]) => `
            <button type="button" class="cat-emoji-btn${emoji === selectedEmoji ? " active" : ""}" data-emoji="${emoji}" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">${emoji}</button>
          `).join("")}
        </div>
      </div>
    `).join("");

    emojiPickerEl.querySelectorAll(".cat-emoji-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedEmoji = btn.dataset.emoji;
        emojiPickerEl.querySelectorAll(".cat-emoji-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        updatePreview();
      });
    });
  }
  renderEmojiGrid();
  updatePreview();

  // Busca: filtra ícones de todos os grupos por nome (ex.: "mercado",
  // "carro") e mostra um resultado único, em vez de navegar grupo por
  // grupo — cobre tudo de uma vez.
  emojiSearchInput.addEventListener("input", () => {
    searchQuery = emojiSearchInput.value;
    renderEmojiGrid();
  });

  modal.querySelectorAll(".cat-color-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      modal.querySelectorAll(".cat-color-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedColor = btn.dataset.color;
      updatePreview();
    });
  });

  document.getElementById("closeNewCategory").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

  const nameCountEl = document.getElementById("newCatNameCount");
  function updateNameCount() {
    nameCountEl.textContent = `${nameInput.value.length}/${nameMax}`;
  }
  nameInput.focus();
  nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);
  nameInput.addEventListener("input", () => { updateNameCount(); updatePreview(); });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("saveNewCategory").click(); }
  });
  updateNameCount();
  updatePreview();

  const saveBtn = document.getElementById("saveNewCategory");
  saveBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    const errEl = document.getElementById("newCategoryError");
    const showError = (msg) => { errEl.textContent = msg; errEl.style.display = "block"; };

    if (!name) {
      showError("Digite um nome para a categoria.");
      return;
    }

    // SEGURANÇA: nome de categoria não precisa (e não deve) conter
    // caracteres de HTML — cat.label é usado em dezenas de lugares no
    // app (lista de lançamentos, recorrentes, seletores...) e nem todos
    // escapam na hora de exibir. Bloquear esses caracteres aqui, na
    // criação, fecha o problema na raiz — mais confiável do que
    // caçar cada ponto de exibição um por um.
    if (/[<>&"']/.test(name)) {
      showError("O nome não pode conter os caracteres < > & \" '.");
      return;
    }

    const activeType = document.querySelector("#expenseType")?.value || "despesa";

    // Evita duas categorias iguais (mesmo nome, mesmo tipo) — compara sem
    // acento/caixa pra pegar "Mercado" vs "mercado" também.
    const normalizedName = normalizeForSearch(name);
    const alreadyExists = getAllCategories(activeType).some(
      (cat) => normalizeForSearch(cat.label.replace(/^\S+\s*/, "")) === normalizedName
    );
    if (alreadyExists) {
      showError(`Já existe uma categoria "${name}" nesse tipo. Escolha outro nome ou use a existente.`);
      return;
    }

    errEl.style.display = "none";
    const id = "custom_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24) + "_" + Date.now().toString(36);

    if (!state.customCategories) state.customCategories = [];
    state.customCategories.push({
      id,
      label: `${selectedEmoji} ${name}`,
      color: selectedColor,
      type: activeType,
    });
    saveState();

    populateCategorySelect(id, activeType);
    modal.remove();
    showToast(`✅ Categoria "${name}" criada!`);
  });
}

// Abre direto a tela certa quando o app é aberto via atalho do PWA
// (ex: pressionar e segurar o ícone na tela inicial → "Nova tarefa")
function handlePwaShortcutAction() {
  const params = new URLSearchParams(window.location.search);
  const action = params.get("action");
  const itemFromUrl = params.get("item");
  if (action) {
    if (action === "new-task") {
      setView("planner");
      setTimeout(() => openPlannerQuickAdd("task"), 200);
    } else if (action === "new-expense") {
      setView("finances");
      setTimeout(() => document.querySelector("#expenseAmount")?.focus(), 200);
    } else if (action.startsWith("open-")) {
      // Vem de um clique em notificação do sistema (ver sw.js)
      let view = action.replace("open-", "");
      // Tarefas/Agenda/Metas viraram Planner — mantém compatibilidade com
      // notificações antigas que ainda apontem pros nomes de tela antigos.
      if (["tasks", "calendar", "goals"].includes(view)) view = "planner";
      if (["dashboard", "notes", "planner", "finances", "profile", "settings"].includes(view)) {
        setView(view);
        if (itemFromUrl) highlightItem(itemFromUrl);
      }
    }
    // Limpa o parâmetro da URL para não reabrir a mesma ação ao recarregar
    history.replaceState({ ...(history.state || {}), pnView: activeView, noteDetail: false }, "", window.location.pathname);
  }

  // Se o usuário tocar numa notificação enquanto o app já está aberto em
  // outra aba, o Service Worker manda essa mensagem em vez de abrir uma
  // nova janela — assim navegamos direto para a tela certa (e para o item
  // exato, quando a notificação se referia a um só item).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "open-view" && event.data.view) {
        let view = event.data.view;
        if (["tasks", "calendar", "goals"].includes(view)) view = "planner";
        setView(view);
        if (event.data.itemId) highlightItem(event.data.itemId);
      }
    });
  }
}

// Rola até o cartão/linha exata referenciada por uma notificação e dá um
// destaque pulsante por alguns segundos, pra deixar bem claro "é aqui".
function highlightItem(itemId) {
  // Se for uma tarefa e o mobile estiver mostrando outra aba de status,
  // troca para a aba certa antes de tentar rolar até ela.
  const task = state.tasks?.find((t) => t.id === itemId);
  if (task) {
    document.querySelectorAll("[data-status-tab]").forEach((t) =>
      t.classList.toggle("active", t.dataset.statusTab === task.status)
    );
    renderTasks();
  }

  setTimeout(() => {
    const target = document.querySelector(
      `[data-task-id="${itemId}"], [data-event-id="${itemId}"], [data-goal-id="${itemId}"], [data-fin-id="${itemId}"]`
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("notify-highlight");
    setTimeout(() => target.classList.remove("notify-highlight"), 2600);
  }, 220);
}

// ============================================================
// GRÁFICO COMPARATIVO DE 6 MESES (SVG inline)
// ============================================================
function renderFinChart6m() {
  const el = document.querySelector("#finChart6m");
  if (!el) return;

  // Coleta os últimos 6 meses (incluindo o mês ativo)
  const months = [];
  const [ay, am] = finActiveMonth.split("-").map(Number);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(ay, am - 1 - i, 1);
    months.push(toLocalIso(d).slice(0, 7));
  }

  const data = months.map((mk) => {
    const entries = (state.finances || []).filter((f) => f.date.startsWith(mk));
    const r = entries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
    const d = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
    const [y, m] = mk.split("-").map(Number);
    const lbl = safeFormatDate(new Date(y, m - 1, 1), { month: "short" }, "-");
    return { mk, lbl, r, d };
  });

  // Sem nenhuma receita/despesa nos 6 meses, o gráfico de barras viraria
  // só tracinhos mínimos no rodapé (altura mínima de 2px) com um enorme
  // vazio em cima — parecia quebrado. Mostra um estado vazio, como já
  // acontece na lista "Por categoria".
  const totalMovimentado = data.reduce((s, d) => s + d.r + d.d, 0);
  if (totalMovimentado === 0) {
    el.innerHTML = `<div class="empty-state">Sem movimentações nos últimos 6 meses</div>`;
    return;
  }

  const maxVal = Math.max(...data.flatMap((d) => [d.r, d.d]), 1);
  const W = 100, H = 80, pad = 4, barW = 6, gap = 2;
  const groupW = barW * 2 + gap + 4;
  const totalW = groupW * data.length;
  const activeData = data.find((item) => item.mk === finActiveMonth) || data[data.length - 1];
  const previousData = data[data.length - 2];
  const expenseChange = activeData.d - previousData.d;
  const expenseTrend = expenseChange === 0
    ? "igual ao mês anterior"
    : `${formatCurrency(Math.abs(expenseChange))} ${expenseChange > 0 ? "a mais" : "a menos"} em despesas`;
  const gridLines = [0.25, 0.5, 0.75].map((ratio) =>
    `<line x1="${pad}" y1="${(H - H * ratio + pad).toFixed(2)}" x2="${totalW + pad}" y2="${(H - H * ratio + pad).toFixed(2)}" stroke="var(--line)" stroke-width="0.45" stroke-dasharray="1.5 2"/>`
  ).join("");

  const bars = data.map((item, i) => {
    const x = i * groupW + pad;
    const rH = Math.max(2, (item.r / maxVal) * H);
    const dH = Math.max(2, (item.d / maxVal) * H);
    const isActive = item.mk === finActiveMonth;
    return `
      <rect x="${x}" y="${H - rH + pad}" width="${barW}" height="${rH}" rx="2" fill="${isActive ? "var(--green)" : "var(--green-soft)"}" stroke="${isActive ? "var(--green)" : "none"}" stroke-width="1"><title>${item.lbl}: receitas ${formatCurrency(item.r)}</title></rect>
      <rect x="${x + barW + gap}" y="${H - dH + pad}" width="${barW}" height="${dH}" rx="2" fill="${isActive ? "var(--red)" : "var(--red-soft)"}" stroke="${isActive ? "var(--red)" : "none"}" stroke-width="1"><title>${item.lbl}: despesas ${formatCurrency(item.d)}</title></rect>
      <text x="${x + barW}" y="${H + pad + 10}" text-anchor="middle" font-size="5" fill="var(--muted)" font-family="inherit">${item.lbl}</text>`;
  }).join("");

  const legendLine = `
    <rect x="${pad}" y="${H + pad + 14}" width="6" height="4" rx="1" fill="var(--green)"/>
    <text x="${pad + 8}" y="${H + pad + 18}" font-size="4.5" fill="var(--muted)" font-family="inherit">Receitas</text>
    <rect x="${pad + 36}" y="${H + pad + 14}" width="6" height="4" rx="1" fill="var(--red)"/>
    <text x="${pad + 44}" y="${H + pad + 18}" font-size="4.5" fill="var(--muted)" font-family="inherit">Despesas</text>`;

  el.innerHTML = `<div class="fin-chart-metrics"><span><b>${formatCurrency(activeData.r)}</b> receitas</span><span><b>${formatCurrency(activeData.d)}</b> despesas</span><small>${expenseTrend}</small></div><svg role="img" aria-label="Comparação de receitas e despesas dos últimos seis meses" viewBox="0 0 ${totalW + pad * 2} ${H + pad * 2 + 22}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto"><title>Receitas e despesas dos últimos seis meses</title>${gridLines}${bars}${legendLine}</svg>`;
}

// Gráfico de linha com o saldo acumulado (receitas - despesas de TODO o
// histórico até cada mês) — mostra a tendência real da "vida financeira",
// independente de o mês ter sido fechado ou não.
function renderFinSaldoEvolution() {
  const el = document.querySelector("#finSaldoEvolution");
  if (!el) return;

  const months = [];
  const [ay, am] = finActiveMonth.split("-").map(Number);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(ay, am - 1 - i, 1);
    months.push(toLocalIso(d).slice(0, 7));
  }

  // Sem nenhum lançamento no histórico inteiro, o saldo fica sempre em
  // zero e a linha vira um traço reto colado embaixo do gráfico — parecia
  // quebrado. Mostra um estado vazio em vez de um gráfico "fantasma".
  if ((state.finances || []).length === 0) {
    el.innerHTML = `<div class="empty-state">Sem dados suficientes para mostrar a evolução</div>`;
    return;
  }

  const firstMonth = months[0];
  const baseline = (state.finances || [])
    .filter((f) => f.date.slice(0, 7) < firstMonth)
    .reduce((s, f) => s + (f.type === "receita" ? f.amount : -f.amount), 0);

  let running = baseline;
  const data = months.map((mk) => {
    const entries = (state.finances || []).filter((f) => f.date.startsWith(mk));
    const net = entries.reduce((s, f) => s + (f.type === "receita" ? f.amount : -f.amount), 0);
    running += net;
    const [y, m] = mk.split("-").map(Number);
    const lbl = safeFormatDate(new Date(y, m - 1, 1), { month: "short" }, "-");
    return { mk, lbl, saldo: running };
  });

  const values = data.map((d) => d.saldo);
  const maxVal = Math.max(...values, 0);
  const minVal = Math.min(...values, 0);
  const range  = Math.max(maxVal - minVal, 1);

  const W = 100, H = 60, pad = 6;
  const stepX = (W - pad * 2) / Math.max(data.length - 1, 1);
  const zeroY = pad + H - ((0 - minVal) / range) * H;

  const points = data.map((d, i) => ({
    x: pad + i * stepX,
    y: pad + H - ((d.saldo - minVal) / range) * H,
    ...d,
  }));

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const last = points[points.length - 1];
  const previous = points[points.length - 2];
  const balanceChange = last.saldo - previous.saldo;
  const areaD = `${pathD} L ${last.x.toFixed(2)} ${(pad + H).toFixed(2)} L ${points[0].x.toFixed(2)} ${(pad + H).toFixed(2)} Z`;

  const dots = points.map((p) => {
    const isActive = p.mk === finActiveMonth;
    const color = p.saldo >= 0 ? "var(--green)" : "var(--red)";
    return `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${isActive ? 2.1 : 1.4}" fill="${color}" stroke="var(--surface)" stroke-width="0.6"><title>${p.lbl}: saldo ${formatCurrency(p.saldo)}</title></circle>`;
  }).join("");

  const labels = points.map((p) =>
    `<text x="${p.x.toFixed(2)}" y="${(pad + H + 8).toFixed(2)}" text-anchor="middle" font-size="4.5" fill="var(--muted)" font-family="inherit">${p.lbl}</text>`
  ).join("");

  el.innerHTML = `<div class="fin-chart-metrics"><span><b>${formatCurrency(last.saldo)}</b> saldo acumulado</span><small>${balanceChange === 0 ? "Sem variação desde o mês anterior" : `${formatCurrency(Math.abs(balanceChange))} ${balanceChange > 0 ? "de alta" : "de queda"} desde o mês anterior`}</small></div><svg role="img" aria-label="Evolução do saldo acumulado nos últimos seis meses" viewBox="0 0 ${W} ${H + pad * 2 + 10}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto"><title>Saldo acumulado nos últimos seis meses</title>
    <line x1="${pad}" y1="${zeroY.toFixed(2)}" x2="${W - pad}" y2="${zeroY.toFixed(2)}" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2,2"/>
    <path d="${areaD}" fill="var(--accent-soft)" opacity="0.5"/>
    <path d="${pathD}" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    ${labels}
  </svg>`;
}

// ============================================================
// METAS DE GASTO POR CATEGORIA
// ============================================================
function renderFinGoals() {
  const el = document.querySelector("#finGoalsList");
  if (!el) return;
  const goals = state.finGoals || [];
  if (!goals.length) {
    el.innerHTML = emptyStateHtml({
      iconName: "target",
      title: "Defina limites por categoria",
      desc: "Escolha uma categoria e um teto de gasto mensal — a barra muda de cor conforme você se aproxima do limite.",
    });
    return;
  }
  const monthKey = getActiveFinMonth();
  const byCat = {};
  (state.finances || []).filter((f) => f.date.startsWith(monthKey) && f.type === "despesa")
    .forEach((f) => { byCat[f.category] = (byCat[f.category] || 0) + f.amount; });

  el.innerHTML = goals.map((g) => {
    const cat   = findCategory(g.categoryId);
    const spent = byCat[g.categoryId] || 0;
    const pct   = Math.min(100, Math.round((spent / g.limit) * 100));
    const over  = spent > g.limit;
    const color = over ? "var(--red)" : pct > 80 ? "var(--orange)" : "var(--green)";
    return `
      <div class="fin-goal-row">
        <div class="fin-goal-top">
          <span class="fin-goal-label">${escapeHtml(cat.label)}</span>
          <span class="fin-goal-val" style="color:${color}">${formatCurrency(spent)} / ${formatCurrency(g.limit)}</span>
          <button class="icon-button" style="padding:2px 6px;font-size:0.7rem" onclick="deleteFinGoal('${g.id}')">${icon("x", 12)}</button>
        </div>
        <div class="progress-track" style="height:6px;margin-top:4px">
          <div style="width:${pct}%;height:100%;border-radius:999px;background:${color};transition:width 400ms"></div>
        </div>
        <span style="font-size:0.72rem;color:var(--muted)">${over ? `<span style="display:inline-flex;align-items:center;gap:3px;color:var(--red)">${icon("alertTriangle", 11)}Limite ultrapassado!</span>` : `${pct}% usado`}</span>
      </div>`;
  }).join("");
}

// Lista os meses já fechados, com atalho pra revisar/editar ou reabrir
// cada um sem precisar navegar mês a mês com as setas ‹ ›.
function renderFinClosures() {
  const el = document.querySelector("#finClosuresList");
  if (!el) return;
  const closures = [...(state.monthClosures || [])].sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  if (!closures.length) {
    el.innerHTML = emptyStateHtml({
      iconName: "calendarCheck",
      title: "Nenhum mês fechado ainda",
      desc: "Quando você fechar um mês, ele aparece aqui com o saldo final, pra revisar ou reabrir quando quiser.",
    });
    return;
  }
  el.innerHTML = closures.map((c) => `
    <div class="fin-closure-row">
      <div class="fin-closure-top">
        <span class="fin-closure-label">${finMonthLabel(c.monthKey)}</span>
        <span class="fin-closure-val" style="color:${c.saldo >= 0 ? "var(--green)" : "var(--red)"}">${formatCurrency(c.saldo)}</span>
      </div>
      <div class="fin-closure-actions">
        <button class="mini-button" onclick="goToFinMonth('${c.monthKey}')">Ver / editar</button>
        <button class="mini-button" onclick="reopenMonth('${c.monthKey}')">Reabrir</button>
      </div>
    </div>`).join("");
}

function deleteFinGoal(id) {
  state.finGoals = (state.finGoals || []).filter((g) => g.id !== id);
  saveState();
  renderFinGoals();
  showToast("Meta removida.");
}

function bindFinGoalsModal() {
  const modal   = document.querySelector("#finGoalsModal");
  const catSel  = document.querySelector("#goalCategory");
  const openBtn = document.querySelector("#finOpenGoalsModal");
  const closeBtn= document.querySelector("#finCloseGoalsModal");
  const saveBtn = document.querySelector("#finSaveGoal");

  openBtn?.addEventListener("click", () => {
    // Popula select com categorias de despesa
    catSel.innerHTML = expenseCategories.concat(state.customCategories?.filter((c) => (c.type || "despesa") === "despesa") || [])
      .map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join("");
    modal.hidden = false;
  });
  closeBtn?.addEventListener("click", () => { modal.hidden = true; });
  modal?.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

  saveBtn?.addEventListener("click", () => {
    const catId = catSel.value;
    const limit = parseFloat(document.querySelector("#goalLimit").value.replace(",", "."));
    if (!catId || !limit || limit <= 0) { showToast("Preencha a categoria e o limite."); return; }
    if (!state.finGoals) state.finGoals = [];
    // Atualiza se já existir meta para essa categoria
    const existing = state.finGoals.find((g) => g.categoryId === catId);
    if (existing) { existing.limit = limit; }
    else { state.finGoals.push({ id: crypto.randomUUID(), categoryId: catId, limit }); }
    saveState();
    renderFinGoals();
    modal.hidden = true;
    document.querySelector("#goalLimit").value = "";
    showToast("✅ Meta salva!");
  });
}

// ============================================================
// LANÇAMENTOS RECORRENTES
// ============================================================
function renderFinRecurrents() {
  const el = document.querySelector("#finRecurList");
  if (!el) return;
  const recurrents = state.finRecurrents || [];
  if (!recurrents.length) {
    el.innerHTML = emptyStateHtml({
      iconName: "compass",
      title: "Automatize o que se repete",
      desc: "Assinaturas, salário, aluguel — cadastre uma vez e o lançamento entra sozinho todo mês.",
    });
    return;
  }
  el.innerHTML = recurrents.map((r) => {
    const cat     = findCategory(r.categoryId);
    const isRec   = r.type === "receita";
    const skipped = isRecurrentSkipped(r, finActiveMonth);
    return `
      <div class="fin-recur-row${skipped ? " is-skipped" : ""}" data-recur-id="${r.id}">
        <span class="fin-recur-icon" style="background:${cat.color}22;color:${cat.color}">${cat.label.split(" ")[0]}</span>
        <div class="fin-recur-info">
          <strong>${escapeHtml(r.description)}</strong>
          <span class="task-meta">Dia ${r.day} · ${escapeHtml(cat.label.replace(/^\S+\s*/, ""))}${skipped ? ` · pulado em ${finMonthLabel(finActiveMonth)}` : ""}</span>
        </div>
        <span class="fin-recur-amount ${isRec ? "receita" : "despesa"}">${isRec ? "+" : "-"}${formatCurrency(r.amount)}</span>
        <div class="fin-recur-status" aria-hidden="true">${skipped ? '<span class="fin-recur-status-dot skipped"></span>' : '<span class="fin-recur-status-dot"></span>'}</div>
        <button class="fin-recur-menu-btn" type="button" data-recur-menu="${r.id}" aria-haspopup="true" aria-label="Mais ações">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>
        </button>
      </div>`;
  }).join("");

  // Único botão de menu por card em vez de 3 botões lado a lado — ao tocar,
  // mostra as ações (Lançar agora / Pular ou reativar / Remover) num
  // pequeno menu contextual, mantendo a lista limpa e alinhada.
  el.querySelectorAll("[data-recur-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.recurMenu;
      openRecurrentActionMenu(btn, id);
    });
  });
}

// Menu contextual (estilo "•••") das recorrências: substitui os antigos
// três botões (▶ ⏭ ✕) por uma única ação que abre um pequeno menu flutuante.
let activeRecurMenuEl = null;
function closeRecurrentActionMenu() {
  activeRecurMenuEl?.remove();
  activeRecurMenuEl = null;
  document.removeEventListener("click", closeRecurrentActionMenu);
}
function openRecurrentActionMenu(anchorBtn, id) {
  closeRecurrentActionMenu();
  const rec = (state.finRecurrents || []).find((r) => r.id === id);
  if (!rec) return;
  const skipped = isRecurrentSkipped(rec, finActiveMonth);

  const menu = document.createElement("div");
  menu.className = "fin-recur-menu";
  menu.innerHTML = `
    <button type="button" data-action="apply">▶ Lançar agora</button>
    <button type="button" data-action="toggleSkip">${skipped ? "↩ Reativar neste mês" : "⏭ Pular este mês"}</button>
    <button type="button" data-action="delete" class="danger">✕ Excluir recorrência</button>
  `;
  document.body.appendChild(menu);

  const rect = anchorBtn.getBoundingClientRect();
  const menuWidth = menu.offsetWidth || 200;
  const left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8);
  menu.style.top = `${rect.bottom + 6 + window.scrollY}px`;
  menu.style.left = `${Math.max(8, left) + window.scrollX}px`;

  menu.querySelector('[data-action="apply"]').addEventListener("click", (e) => {
    e.stopPropagation();
    applyRecurrent(id);
    closeRecurrentActionMenu();
  });
  menu.querySelector('[data-action="toggleSkip"]').addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSkipRecurrentMonth(id, finActiveMonth);
    closeRecurrentActionMenu();
  });
  menu.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
    e.stopPropagation();
    deleteRecurrent(id);
    closeRecurrentActionMenu();
  });

  activeRecurMenuEl = menu;
  setTimeout(() => document.addEventListener("click", closeRecurrentActionMenu), 0);
}

// Verifica se um recorrente está marcado para NÃO lançar em um mês específico
function isRecurrentSkipped(rec, monthKey) {
  return (rec.skippedMonths || []).includes(monthKey);
}

// Pula (ou reativa) uma ocorrência específica de um recorrente, sem precisar
// cancelar a recorrência inteira — útil pra, por exemplo, não lançar a
// assinatura da academia no mês em que você já pagou fora do app.
function toggleSkipRecurrentMonth(id, monthKey) {
  const rec = (state.finRecurrents || []).find((r) => r.id === id);
  if (!rec) return;
  if (!rec.skippedMonths) rec.skippedMonths = [];
  const idx = rec.skippedMonths.indexOf(monthKey);
  if (idx >= 0) {
    rec.skippedMonths.splice(idx, 1);
    showToast(`↩️ "${rec.description}" volta a lançar em ${finMonthLabel(monthKey)}.`);
  } else {
    rec.skippedMonths.push(monthKey);
    showToast(`⏭️ "${rec.description}" não será lançado em ${finMonthLabel(monthKey)}.`);
  }
  saveState();
  renderFinRecurrents();
}

function deleteRecurrent(id) {
  state.finRecurrents = (state.finRecurrents || []).filter((r) => r.id !== id);
  saveState();
  renderFinRecurrents();
  showToast("Recorrente removido.");
}

function applyRecurrent(id) {
  const rec = (state.finRecurrents || []).find((r) => r.id === id);
  if (!rec) return;
  if (!assertMonthNotClosed(finActiveMonth)) return;
  if (isRecurrentSkipped(rec, finActiveMonth)) {
    showToast(`"${rec.description}" está marcado para pular em ${finMonthLabel(finActiveMonth)}. Toque em ↩ pra reativar.`);
    return;
  }

  const [y, m] = finActiveMonth.split("-").map(Number);
  const day    = Math.min(rec.day, new Date(y, m, 0).getDate()); // ajusta para dias válidos do mês
  const date   = `${finActiveMonth}-${String(day).padStart(2, "0")}`;

  state.finances.unshift({
    id: crypto.randomUUID(),
    type: rec.type,
    amount: rec.amount,
    category: rec.categoryId,
    description: rec.description,
    date,
  });
  saveState();
  renderFinances();
  showToast(`✅ "${rec.description}" lançado em ${formatDate(date)}!`);
}

function bindFinRecurModal() {
  const modal    = document.querySelector("#finRecurModal");
  const openBtn  = document.querySelector("#finOpenRecurModal");
  const closeBtn = document.querySelector("#finCloseRecurModal");
  const saveBtn  = document.querySelector("#finSaveRecur");
  const typeSel  = document.querySelector("#recurType");
  const catSel   = document.querySelector("#recurCategory");

  function updateCatOptions() {
    const type = typeSel?.value || "despesa";
    catSel.innerHTML = getAllCategories(type).map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join("");
  }

  openBtn?.addEventListener("click", () => { updateCatOptions(); modal.hidden = false; });
  closeBtn?.addEventListener("click", () => { modal.hidden = true; });
  modal?.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  typeSel?.addEventListener("change", updateCatOptions);

  saveBtn?.addEventListener("click", () => {
    const desc   = document.querySelector("#recurDesc").value.trim();
    const amount = parseFloat(document.querySelector("#recurAmount").value.replace(",", "."));
    const type   = typeSel.value;
    const catId  = catSel.value;
    const day    = parseInt(document.querySelector("#recurDay").value, 10);

    if (!desc || !amount || amount <= 0 || !day || day < 1 || day > 31) {
      showToast("Preencha todos os campos corretamente.");
      return;
    }
    if (!state.finRecurrents) state.finRecurrents = [];
    state.finRecurrents.push({ id: crypto.randomUUID(), description: desc, amount, type, categoryId: catId, day });
    saveState();
    renderFinRecurrents();
    modal.hidden = true;
    ["#recurDesc","#recurAmount","#recurDay"].forEach((sel) => { document.querySelector(sel).value = ""; });
    showToast("✅ Recorrente salvo!");
  });
}

// ── Lança automaticamente recorrentes com vencimento hoje que ainda não
// foram lançados no mês ativo (roda uma vez por sessão ao abrir Finanças)
function autoApplyRecurrents() {
  const today = todayIso;
  const monthKey = today.slice(0, 7);
  if (isMonthClosed(monthKey)) return;
  const [, , dd] = today.split("-").map(Number);
  let applied = false;
  let toastDelay = 0;
  (state.finRecurrents || []).forEach((rec) => {
    if (rec.day !== dd) return;
    if (isRecurrentSkipped(rec, monthKey)) return;
    const alreadyLaunched = (state.finances || []).some(
      (f) => f.date === today && f.description === rec.description && f.amount === rec.amount
    );
    if (alreadyLaunched) return;
    state.finances.unshift({
      id: crypto.randomUUID(),
      type: rec.type,
      amount: rec.amount,
      category: rec.categoryId,
      description: rec.description,
      date: today,
    });
    applied = true;
    // Escalona os toasts quando mais de um recorrente cai no mesmo dia,
    // já que só existe um toast na tela por vez.
    window.setTimeout(() => showToast(`🔁 Recorrente lançado: ${rec.description}`), toastDelay);
    toastDelay += 2400;
  });
  // Só sincroniza com o servidor se algo foi realmente adicionado —
  // a versão anterior sempre chamava saveState() mesmo sem lançar nada,
  // o que disparava um ciclo de sync desnecessário ao abrir o app.
  if (applied) saveState();
}

window.editNote = editNote;
window.toggleFavorite = toggleFavorite;
window.toggleNoteChecklistPreview = toggleNoteChecklistPreview;
window.toggleNoteChecklistItem = toggleNoteChecklistItem;
window.convertNoteToTask = convertNoteToTask;
window.deleteNote = deleteNote;
window.openNoteDetail = openNoteDetail;
window.exportNoteMarkdown = exportNoteMarkdown;
window.dragTask = dragTask;
window.toggleTask = toggleTask;
window.openTaskMoveMenu = openTaskMoveMenu;
window.deleteTask = deleteTask;
window.cycleTaskRecurrence = cycleTaskRecurrence;
window.toggleTaskDetails = toggleTaskDetails;
window.addSubtask = addSubtask;
window.toggleSubtask = toggleSubtask;
window.deleteSubtask = deleteSubtask;
window.filterEventsByDate = filterEventsByDate;
window.deleteEvent = deleteEvent;
window.changeGoal = changeGoal;
window.deleteGoal = deleteGoal;
window.addGoalMilestone = addGoalMilestone;
window.toggleGoalMilestone = toggleGoalMilestone;
window.deleteGoalMilestone = deleteGoalMilestone;
window.deleteFinance = deleteFinance;
window.editFinance = editFinance;
window.filterFinByDate = filterFinByDate;
window.deleteFinGoal = deleteFinGoal;
window.deleteRecurrent = deleteRecurrent;
window.applyRecurrent = applyRecurrent;
window.toggleSkipRecurrentMonth = toggleSkipRecurrentMonth;
window.goToFinMonth = goToFinMonth;
window.reopenMonth = reopenMonth;

// Planner (Fase 2 — reformulação). Auditoria completa: todo onclick="fn(...)"
// e onsubmit="return fn(...)" gerado dinamicamente precisa da função
// correspondente aqui, porque o app.js roda como <script type="module"> e,
// nesse modo, declarações de função no topo do arquivo NÃO viram
// propriedades de window automaticamente. Esquecer uma linha aqui é
// exatamente o que causava os "Algo quebrou nesta tela" no Planner —
// ao adicionar uma função nova chamada via onclick/onsubmit em HTML
// gerado dinamicamente, ela tem que ser exposta aqui também.
window.openPlannerQuickAdd = openPlannerQuickAdd;
window.openPlannerEventEditor = openPlannerEventEditor;
window.jumpPlannerToDay = jumpPlannerToDay;
window.selectPlannerDay = selectPlannerDay;
window.togglePlannerGoalExpand = togglePlannerGoalExpand;
window.openPlannerTaskActions = openPlannerTaskActions;
window.submitGoalMilestoneForm = submitGoalMilestoneForm;
window.submitSubtaskForm = submitSubtaskForm;
window.updateGoalProgress = updateGoalProgress;

// Mesma causa raiz, encontrada durante a auditoria fora do Planner —
// corrigidas de brinde por serem idênticas e triviais (uma linha cada):
// "Editar perfil" no Perfil e os chips de pasta nas Notas também
// silenciosamente não faziam nada.
window.setView = setView;
window.setNotesFolderFilter = setNotesFolderFilter;
