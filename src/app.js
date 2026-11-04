Warning: truncated output (original token count: 97467)
Total output lines: 7931

// ============================================================
// PulseNote — Autenticação e sincronização via Firebase
// ============================================================
import { auth, db } from "./firebase-init.js";
import { createAutopilotUI } from "./autopilot-ui.js";
import { classifyPulseCommand } from "./command-routing.mjs";
import { deleteAccountDataAndIdentity } from "./account-deletion.mjs";
import { cloneState, changedStateKeys, mergeDirtyState } from "./state-sync.js";
import {
  onAuthStateChanged,
  signOut,
  updateProfile,
  updatePassword,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  EmailAuthProvider,
  GoogleAuthProvider,
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
const designPreviewRequested = new URLSearchParams(window.location.search).get("designPreview") === "1";
const designPreviewHostAllowed = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  || /^pulse-note-5erj-[a-z0-9-]+-douglas-projects-c831a9fc\.vercel\.app$/i.test(window.location.hostname);
// O modo de demonstração usa somente dados fictícios e existe para QA visual.
// O domínio oficial não corresponde ao padrão acima, então esta rota jamais
// ignora a autenticação em produção — mesmo que alguém copie o parâmetro.
const isLocalDesignPreview = designPreviewRequested && designPreviewHostAllowed;
const appReady = new Promise((resolve) => {
  let resolved = false; // garante que resolve() é chamado apenas uma vez

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      if (isLocalDesignPreview) {
        currentUser = {
          uid: "local-design-preview",
          displayName: "Douglas Marques",
          email: "preview@pulsenote.local",
          emailVerified: true,
          getIdToken: async () => null,
        };
        state = createDesignPreviewState();
        observedState = cloneState(state);
        if (!resolved) { resolved = true; resolve(); }
        return;
      }
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
    trackUsageArea(activeView);

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

let lastUsageArea = "";
let lastUsageAt = 0;
function trackUsageArea(area) {
  if (!currentUser || !Object.hasOwn(viewTitles, area)) return;
  const now = Date.now();
  if (lastUsageArea === area && now - lastUsageAt < 60_000) return;
  lastUsageArea = area;
  lastUsageAt = now;
  currentUser.getIdToken().then((token) => fetch("/api/usage-event", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ area }),
    keepalive: true,
  })).catch(() => { /* Telemetria operacional nunca bloqueia o aplicativo. */ });
}

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
  bindPremiumDashboard();
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
  // A preferência da conta, sozinha, não prova que ESTE aparelho registrou
  // a permissão do navegador. Exibir o controle como ligado sem essa
  // permissão fazia a pessoa acreditar que receberia push com o app fechado,
  // mesmo sem token FCM. O toggle agora representa o estado real do aparelho;
  // ao ligá-lo, o fluxo abaixo pede a permissão e registra/renova o token.
  if (appReminderCheckbox) {
    appReminderCheckbox.checked = state.appReminderOptIn !== false
      && window.pushNotificationsAreRegistered?.() === true;
  }
  const appReminderStatus = document.getElementById("appReminderStatus");
  if (appReminderStatus) {
    const hasToken = Array.isArray(state.fcmTokens) && state.fcmTokens.some(Boolean);
    let persistedPushStatus = null;
    try {
      persistedPushStatus = JSON.parse(localStorage.getItem("pn_push_setup_status") || "null");
    } catch (_) {
      localStorage.removeItem("pn_push_setup_status");
    }
    const pushStatus = window.PulseNotePushSetupStatus
      || persistedPushStatus
      || window.PulseNotePush?.getRegistrationStatus?.()
      || { code: "not-attempted" };
    const failureLabels = {
      "auth-required": "Entre novamente na conta e tente ativar o push.",
      "notification-unsupported": "Este navegador não oferece notificações. Use um navegador compatível ou instale o PulseNote como aplicativo.",
      "permission-denied": "Notificações estão bloqueadas para este site. Libere-as nas configurações do navegador.",
      "permission-not-granted": "A permissão de notificações não foi concedida neste aparelho.",
      "module-unavailable": "O módulo de push não terminou de carregar. Atualize a página e tente novamente.",
      "registration-failed": "Não foi possível registrar este aparelho para push. Atualize a página e tente novamente.",
      "messaging-unsupported": "Este navegador não oferece push em segundo plano.",
      "push-manager-unsupported": "Este dispositivo não oferece push em segundo plano.",
      "service-worker-unsupported": "Este navegador não oferece notificações com o app fechado.",
      "messaging/permission-blocked": "O navegador bloqueou notificações para este site.",
      "messaging/failed-service-worker-registration": "O serviço de notificações não conseguiu iniciar neste navegador.",
      "messaging/token-subscribe-failed": "O Firebase recusou o registro deste aparelho. Tente novamente.",
      "invalid-vapid-key": "A chave pública Web Push configurada no PulseNote é inválida.",
      "vapid-key-missing": "A chave Web Push do projeto ainda não está configurada.",
    };
    appReminderStatus.textContent = hasToken && state.appReminderOptIn !== false
      ? "Push em segundo plano ativo. Os avisos podem chegar com o app fechado."
      : failureLabels[pushStatus.code]
        || (("Notification" in window) && Notification.permission === "denied"
          ? "Notificações estão bloqueadas nas configurações deste navegador."
          : "Push em segundo plano ainda não foi registrado neste aparelho.");
  }

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
    const codeText = docume…67467 tokens truncated…g>${i + 1}</strong>${dot}</button>`;
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


