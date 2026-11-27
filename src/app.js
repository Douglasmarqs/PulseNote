// ============================================================
// PulseNote — Autenticação e sincronização via Firebase
// ============================================================
import { auth, db, sendVerificationEmail } from "./firebase-init.js";
import { createOnboarding, hasUserData } from "./onboarding.js";
import { defaultNotificationPrefs, normalizeNotificationPrefs } from "./notification-prefs.js";
import { createAutopilotUI } from "./autopilot-ui.js";
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
const pulsinhoConversation = [];
let pulsinhoConversationRestored = "";
let pendingPulsinhoAction = null;
// Ações que o Pulsinho devolveu e que precisam de um "sim" (exclusões,
// gasto com categoria incerta). As demais são aplicadas na hora, com
// botão de desfazer no próprio balão da conversa.
let pendingPulsinhoActions = [];
const pulsinhoUndo = new Map();
// Avisos inofensivos do navegador que não são erro do app (o mais comum:
// "ResizeObserver loop completed with undelivered notifications", disparado
// ao trocar de área rápido). Mostrá-los como "Algo quebrou" assustava à toa.
const BENIGN_RUNTIME_ERRORS = /ResizeObserver loop|Script error\.?$|Load failed$|cancelad|AbortError|The user aborted/i;
function showRuntimeErrorBanner(message) {
  if (!message || message === lastShownRuntimeError) return; // evita repetir o mesmo aviso em loop
  if (BENIGN_RUNTIME_ERRORS.test(String(message))) return;
  lastShownRuntimeError = message;
  let banner = document.getElementById("runtimeErrorBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "runtimeErrorBanner";
    banner.className = "rt-error";
    banner.setAttribute("role", "alert");
    document.body.appendChild(banner);
  }
  banner.innerHTML = `<span class="rt-error-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17v.01"/></svg></span>
    <div class="rt-error-copy"><strong>Algo não saiu como esperado</strong><p></p><small>Se continuar, envie um print desta mensagem.</small></div>
    <button type="button" class="rt-error-x" aria-label="Fechar aviso"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  banner.querySelector("p").textContent = message;
  banner.querySelector(".rt-error-x").onclick = () => banner.remove();
  requestAnimationFrame(() => banner.classList.add("is-open"));
}
window.addEventListener("error", (event) => {
  showRuntimeErrorBanner(event.message || String(event.error));
});
window.addEventListener("unhandledrejection", (event) => {
  showRuntimeErrorBanner(event.reason?.message || String(event.reason));
});

// ── Tema: Claro / Escuro / Eclipse / Automático ───────────────────
// A escolha fica em localStorage (não depende de login/Firestore, então
// funciona até na tela de login). Um script inline no <head> do HTML já
// aplica isso antes da primeira pintura da tela, para nunca "piscar"
// claro por engano; aqui só mantemos o valor sincronizado durante o uso
// do app e ligamos os botões em Configurações > Aparência.
// O identificador interno "aurora" representa o tema Escuro executivo;
// ele é preservado para não quebrar preferências já salvas.
const THEME_STORAGE_KEY = "pulsenote-theme";

function syncThemeColorMeta(choice) {
  const isDark = choice === "aurora" || choice === "eclipse" || (choice !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const meta = document.getElementById("themeColorMeta");
  if (meta) meta.setAttribute("content", choice === "eclipse" ? "#060a13" : (isDark ? "#0a1020" : "#f7f8fc"));
  // Mantém o <meta name="color-scheme"> alinhado ao tema escolhido, para que
  // selects, calendário nativo, barra de rolagem etc. nunca fiquem brancos
  // por cima de um app configurado como escuro (ver comentário no <head>).
  const csMeta = document.getElementById("colorSchemeMeta");
  if (csMeta) csMeta.setAttribute("content", isDark ? "dark" : "light");
}

// "Automático" vira claro ou escuro conforme o aparelho. Resolver para um
// atributo real evita que folhas de estilo diferentes interpretem a
// ausência do atributo de jeitos diferentes (tema misturado).
function resolveThemeChoice(choice) {
  if (choice === "light" || choice === "aurora" || choice === "eclipse") return choice;
  let dark = false;
  try { dark = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { /* sem matchMedia */ }
  return dark ? "aurora" : "light";
}

function applyTheme(choice) {
  document.documentElement.setAttribute("data-theme", resolveThemeChoice(choice));
  syncThemeColorMeta(choice);
}

// Em modo "Automático", se a pessoa mudar o tema do aparelho com o app
// aberto (sem tocar em nada dentro do PulseNote), o app inteiro acompanha.
try {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getSavedTheme() === "system") applyTheme("system");
  });
} catch { /* matchMedia/addEventListener indisponível — sem problema, é só um refinamento */ }

function getSavedTheme() {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY);
    // Valores antigos continuam caindo em "system", sem quebrar quem já
    // usava uma versão anterior do seletor de aparência.
    return t === "light" || t === "aurora" || t === "eclipse" ? t : "system";
  } catch { return "system"; }
}

function setTheme(choice) {
  try { localStorage.setItem(THEME_STORAGE_KEY, choice); } catch { /* modo privado etc — segue só na sessão atual */ }
  // No navegador, web-motion.js troca o tema com uma revelação circular
  // a partir do ponto clicado (View Transitions); sem ele, troca direto.
  if (typeof window.pnWithThemeTransition === "function") window.pnWithThemeTransition(() => applyTheme(choice));
  else applyTheme(choice);
}

applyTheme(getSavedTheme()); // aplica assim que o script roda (reforça o que o <head> já fez)

function bindThemeToggle() {
  const group = document.getElementById("themeToggle");
  if (!group) return;
  const buttons = group.querySelectorAll("[data-theme-choice]");
  function refreshActive() {
    const current = getSavedTheme();
    // role="radio" precisa de aria-checked: leitores de tela anunciavam
    // todas as opções como desmarcadas (QA 18/11).
    buttons.forEach((b) => {
      const on = b.dataset.themeChoice === current;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  group.setAttribute("role", "radiogroup");
  if (!group.hasAttribute("aria-label")) group.setAttribute("aria-label", "Tema");
  group.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const list = [...buttons];
    const index = list.indexOf(document.activeElement);
    const next = list[(index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length];
    next.focus();
    next.click();
  });
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
    window.dispatchEvent(new CustomEvent("pulsenote:synced", { detail: { ok: false, tooLarge: true } }));
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
    // Avisa quem mostra estado de salvamento (selo da nota aberta) que a
    // nuvem confirmou — "Salvo" passa a significar salvo de verdade.
    window.dispatchEvent(new CustomEvent("pulsenote:synced", { detail: { ok: true, pending: Object.keys(dirtyBases).length > 0 } }));
  } catch (err) {
    console.error("Erro ao salvar no Firestore:", err);
    const key = getStorageKey();
    if (key) localStorage.setItem(key, JSON.stringify(state)); // nunca perde o dado localmente
    window.dispatchEvent(new CustomEvent("pulsenote:synced", { detail: { ok: false, offline: !navigator.onLine } }));
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
const designPreviewMode = new URLSearchParams(window.location.search).get("designPreview") || "";
const designPreviewRequested = ["1", "worst"].includes(designPreviewMode);
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
          displayName: designPreviewMode === "worst" ? "Aleksandra Wiśniewska-Kowalczyk de Albuquerque" : "Lucas Martins",
          email: designPreviewMode === "worst" ? "bartholomew.fitzgerald@northwind-industries-holdings.example.com" : "lucas.martins@exemplo.com",
          emailVerified: true,
          getIdToken: async () => null,
        };
        state = createDesignPreviewState(designPreviewMode);
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

    // E-mail já confirmado mas o token ainda é de antes da confirmação:
    // renova agora para as APIs (espaços compartilhados, cobrança) já
    // receberem email_verified=true.
    if (currentUser.emailVerified) {
      try {
        const claims = (await currentUser.getIdTokenResult()).claims || {};
        if (claims.email_verified === false) await currentUser.getIdToken(true);
      } catch { /* offline: o pulseApi renova na primeira chamada */ }
    }

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

        // O espaço escolhido na configuração inicial vira o espaço ao abrir o app.
        if (firstSnapshotForUser && state.preferredWorkspace && state.preferredWorkspace !== "personal") {
          setActiveFinanceWorkspace(state.preferredWorkspace);
        }
        renderAllUnlessEditingNote(); // re-renderiza com os dados confirmados do servidor
        if (onboardingReady) getOnboarding()?.sync();
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

// Cada gravação volta do servidor (onSnapshot) e redesenhava o app inteiro
// — no meio da digitação isso causava travadinhas e atrapalhava cliques na
// barra de formatação. Com a nota aberta em foco, o redesenho espera a
// pessoa fazer uma pausa (ou sair da nota). O editor nunca é reescrito por
// ele, então nada se perde; só a lista em volta atualiza depois.
let deferredRenderTimer = 0;
function noteEditorHasFocus() {
  const active = document.activeElement;
  return Boolean(active && ndCurrentNoteId && active.closest?.("#noteDetailModal"));
}
function renderAllUnlessEditingNote() {
  clearTimeout(deferredRenderTimer);
  if (!noteEditorHasFocus()) { renderAll(); return; }
  const retry = () => {
    if (noteEditorHasFocus() && Date.now() - lastNoteKeyAt < 2500) deferredRenderTimer = setTimeout(retry, 1200);
    else renderAll();
  };
  deferredRenderTimer = setTimeout(retry, 1200);
}
let lastNoteKeyAt = 0;
document.addEventListener("input", (event) => { if (event.target.closest?.("#noteDetailModal")) lastNoteKeyAt = Date.now(); }, true);

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

// "Hoje" acompanha o relógio: com o app aberto de um dia para o outro
// (PWA fica dias na memória do celular), tudo que depende da data —
// compromissos de hoje, foco da semana, calendário — vira junto.
let todayIso = toLocalIso(new Date());
let tomorrowIso = offsetDate(1);
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
let plannerMonthSelected = todayIso; // dia tocado no calendário do mês (mostra a agenda dele embaixo)
let plannerExpandedGoals = new Set();
let plannerExpandedTaskDetails = new Set(); // ids de tarefas com a checklist aberta — sem isso, qualquer alteração num item (concluir/excluir/adicionar) recriava a linha do zero e fechava a checklist na cara do usuário
let plannerEditingEventId = null;
let notesFolderFilter = "all"; // filtro de pasta ativo na biblioteca de Notas
// Mês ativo na view de Finanças. Formato "YYYY-MM". Começa no mês atual.
let finActiveMonth = todayIso.slice(0, 7);
let activeWorkspaceId = "personal";
let sharedFinanceSpaces = [];
let sharedFinanceInvites = [];
const sharedSpaceSyncTimers = new Map();
let finCategoryDrilldown = null;
let lastForecastFetchAt = 0;
let latestDashboardForecast = null;

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

// Saída da abertura: o Pulsinho dá um impulso e voa em arco até o logo do
// app (barra lateral no computador, topo no celular) enquanto a tela se
// revela num círculo que nasce do logo. Ao pousar, o logo dá um pulinho e
// os blocos da tela esmaecem em sequência. Devolve false se não houver
// onde pousar (ex.: tela de verificação), e a abertura sai do jeito simples.
function playSplashExit(overlay) {
  const mascot = overlay.querySelector(".pulsinho");
  const hop = overlay.querySelector(".pulsinho-hop");
  const logos = [...document.querySelectorAll(".bd-sidebar .bd-brand-mark, .bd-mobile-brand .bd-brand-mark")];
  const logo = logos.find((el) => el.getClientRects().length && el.getBoundingClientRect().width > 0);
  if (!mascot || !hop || !logo || typeof overlay.animate !== "function") return false;
  const from = mascot.getBoundingClientRect();
  const to = logo.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const scale = to.width / from.width;
  const lift = Math.min(120, Math.abs(dy) * 0.35 + 40);
  hop.style.animation = "none";
  overlay.querySelectorAll(".pulsinho-ring, .pulsinho-orbit").forEach((el) => { el.style.display = "none"; });
  const flight = hop.animate([
    { transform: "none" },
    { transform: "translateY(10px) scale(1.1, .88)", offset: 0.16 },
    { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - lift}px) scale(${(1 + scale) / 2}) rotate(-12deg)`, offset: 0.58 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(0deg)` },
  ], { duration: 820, easing: "cubic-bezier(.45,0,.2,1)", fill: "forwards" });
  // A tela aparece num círculo que nasce do logo (o fundo da abertura "abre").
  const cx = to.left + to.width / 2;
  const cy = to.top + to.height / 2;
  const r = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy)) + 30;
  // (boards.css pinta o fundo da abertura com !important; o "véu" assume.)
  overlay.style.setProperty("background", "transparent", "important");
  overlay.style.setProperty("background-color", "transparent", "important");
  const veil = document.createElement("i");
  veil.className = "app-loading-veil";
  overlay.prepend(veil);
  veil.animate([
    { clipPath: `circle(${r}px at ${cx}px ${cy}px)` },
    { clipPath: `circle(${r}px at ${cx}px ${cy}px)`, offset: 0.35 },
    { clipPath: `circle(0px at ${cx}px ${cy}px)` },
  ], { duration: 900, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" });
  const view = document.querySelector(".view.active-view");
  const blocks = view ? [...(view.children.length === 1 ? view.firstElementChild.children : view.children)].filter((el) => el.getClientRects().length).slice(0, 8) : [];
  blocks.forEach((el, i) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 360 + i * 60, easing: "ease-out", fill: "backwards" }));
  flight.finished.then(() => {
    logo.animate([
      { transform: "scale(.7)" },
      { transform: "scale(1.22) rotate(-8deg)", offset: 0.45 },
      { transform: "scale(.94) rotate(3deg)", offset: 0.75 },
      { transform: "none" },
    ], { duration: 520, easing: "cubic-bezier(.34,1.5,.5,1)" });
    const ring = document.createElement("i");
    ring.className = "app-loading-land";
    ring.style.left = `${cx}px`;
    ring.style.top = `${cy}px`;
    document.body.appendChild(ring);
    ring.animate([{ transform: "translate(-50%,-50%) scale(.5)", opacity: 0.9 }, { transform: "translate(-50%,-50%) scale(2.6)", opacity: 0 }], { duration: 640, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" })
      .finished.then(() => ring.remove(), () => ring.remove());
    overlay.remove();
  }, () => overlay.remove());
  return true;
}

document.addEventListener("DOMContentLoaded", async () => {
  // Mostra overlay de carregamento enquanto o Firebase autentica.
  // O Pulsinho (mascote) "acorda" aqui — é o único trecho do carregamento
  // que dá pra animar; o splash "de fábrica" do PWA (antes do JS rodar)
  // só aceita imagem estática, então essa é a primeira coisa animada
  // que a pessoa vê.
  // A abertura já vem no HTML (aparece antes do JS); só cria aqui se faltar.
  let overlay = document.getElementById("appLoadingOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "appLoadingOverlay";
    overlay.className = "app-loading-overlay";
    overlay.innerHTML = `<div class="pulsinho-stage" aria-hidden="true"><i class="pulsinho-ring"></i><i class="pulsinho-ring"></i><span class="pulsinho-orbit"><i></i><i></i><i></i></span><div class="pulsinho-hop"><div class="pulsinho"><span class="pulsinho__cheeks"><i></i><i></i></span><div class="pulsinho__face"><div class="pulsinho__eyes"><span class="pulsinho__eye"></span><span class="pulsinho__eye"></span></div><svg class="pulsinho__pulse" viewBox="0 0 120 26"><path pathLength="100" d="M0,13 L28,13 L36,3 L44,23 L52,13 L64,13 L70,6 L76,20 L82,13 L120,13"/></svg></div></div></div></div><strong class="app-loading-word">PulseNote</strong><div class="app-loading-track"><span></span></div>`;
    document.body.appendChild(overlay);
  }

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

  // Deixa a entrada do Pulsinho terminar (mesmo com os dados já em cache),
  // então ele dá um pulinho de despedida e a abertura some suavemente.
  // Com movimento reduzido (comum no Windows com "Efeitos de animação"
  // desligado) a abertura sumia na hora e parecia não existir no computador.
  // Agora ela toca a versão suave (ver index.html) pelo mesmo tempo mínimo.
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const minShow = reduceMotion ? 1100 : 1400;
  const shownFor = performance.now();
  if (shownFor < minShow) await new Promise((resolve) => setTimeout(resolve, minShow - shownFor));
  overlay.classList.add("is-leaving");
  if (reduceMotion || !playSplashExit(overlay)) {
    setTimeout(() => {
      overlay.style.transition = "opacity 300ms ease";
      overlay.style.opacity = "0";
      setTimeout(() => overlay.remove(), 320);
    }, reduceMotion ? 200 : 260);
  }

  if (!currentUser) return; // já foi redirecionado para login.html
  if (!currentUser.emailVerified) return; // gate de verificação já está sendo exibido
  mountDesignPreviewToggle();

  const now = new Date();
  const hour = now.getHours();
  const greeting = greetingForHour(hour);
  const greetingMood = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "night";
  const dateStr = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(now);

  const user = getUser();
  const firstName = user?.name?.split(" ")[0] || "Usuário";
  elements.todayLabel.textContent = `${greeting}, ${firstName} · ${dateStr}`;
  applyViewHeading(activeView);
  renderShellUser(user);

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
  startLiveClock();

  bindNavigation();
  bindPremiumDashboard();
  await loadFinanceSpaces({ silent: true });
  autopilotUi.bind();
  bindPlannerNav();
  bindPlannerQuickAdd();
  bindNoteDetail();
  bindForms();
  bindActions();
  bindSettingsView();

  // Configuração inicial: só abre para conta nova (sem dados). O QA visual pode
  // forçar um passo com ?designPreview=1&onboarding=1|2|3|done.
  onboardingReady = true;
  getOnboarding()?.sync();
  const onboardingPreviewStep = new URLSearchParams(window.location.search).get("onboarding");
  if (isLocalDesignPreview && onboardingPreviewStep) {
    // Só no modo demonstração: simula o número já vinculado para mostrar o sucesso.
    if (onboardingPreviewStep === "done") state.whatsappLinkedPhone = "5511987654321";
    getOnboarding()?.preview(onboardingPreviewStep);
  }
  checkAdminAccess();
  bindThemeToggle();
  bindFinTabs();
  bindFinanceMonthControls();
  bindFinGoalsModal();
  bindFinRecurModal();
  bindFinControlBoard();
  bindAutopilotBoard();
  bindSettingsBoard();
  bindGlobalPalette();
  autoApplyRecurrents();
  autoCloseFinMonths();
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
      <div class="verify-gate-icon">${bdIcon("mail")}</div>
      <h2>Confirme seu e-mail</h2>
      <p>Enviamos um link de confirmação para <strong>${escapeHtml(currentUser.email || "")}</strong>.
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

  // QA 18/11: o botão ficava disponível logo após o envio automático e o
  // Firebase respondia "muitos pedidos". Agora há uma contagem regressiva
  // visível (60 s após cada envio; 2 min se o provedor pedir pausa), que
  // sobrevive a recarregar a página.
  const resendKey = `pn_verify_resend_${currentUser.uid}`;
  const btn = document.getElementById("verifyGateResend");
  let tick = null;
  const readUntil = () => { try { return Number(sessionStorage.getItem(resendKey)) || 0; } catch { return 0; } };
  const writeUntil = (ms) => { try { sessionStorage.setItem(resendKey, String(Date.now() + ms)); } catch { /* sem storage: só a memória */ } refreshResend(Date.now() + ms); };
  function refreshResend(untilOverride) {
    window.clearInterval(tick);
    const until = untilOverride || readUntil();
    const paint = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left > 0) {
        btn.disabled = true;
        btn.textContent = `Reenviar em ${left}s`;
        btn.setAttribute("aria-label", `Reenviar e-mail disponível em ${left} segundos`);
      } else {
        window.clearInterval(tick);
        btn.disabled = false;
        btn.textContent = "Reenviar e-mail";
        btn.removeAttribute("aria-label");
      }
    };
    paint();
    if (until > Date.now()) tick = window.setInterval(paint, 1000);
  }
  // O e-mail acabou de ser enviado no cadastro: começa já em espera.
  if (!readUntil()) writeUntil(60000); else refreshResend();

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await sendVerificationEmail(sendEmailVerification, currentUser);
      showGateMsg("E-mail reenviado. Confira a caixa de entrada e o spam.", "success");
      writeUntil(60000);
    } catch (err) {
      console.error("Erro ao reenviar verificação:", err);
      const limited = err.code === "auth/too-many-requests";
      showGateMsg(
        limited
          ? "O provedor pediu uma pausa nos reenvios. O botão volta sozinho quando liberar."
          : "Não foi possível reenviar agora. Tente novamente em instantes.",
        "error"
      );
      writeUntil(limited ? 120000 : 15000);
    }
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
  const topbarActions = document.querySelector("#bdTopActions");
  if (!topbarActions || document.querySelector(".user-avatar-btn")) return;

  const initial  = bdInitials(user?.name || "U");
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
  topbarActions.append(wrapper);

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
const PF_ACH_ICON = { checkCircle: "check-circle", zap: "bolt", flame: "flame", trophy: "trophy", star: "star", notebook: "note", target: "target", flag: "flag", calendarCheck: "calendar", calendarWeek: "calendar-week", sparkle: "sparkle" };
let pfAchFilter = "all";

function pfAchIcon(name) {
  return bdIcon(PF_ACH_ICON[name] || "star");
}

function pfPlanLabel() {
  const text = document.querySelector("#bdUserPlan")?.textContent?.trim() || "";
  return text && text !== "—" ? text : "Seu plano";
}

// Perfil v3: identidade com anel de nível, mês em números (comparado ao
// anterior), mapa de atividade, conquistas compactas e atalhos de conta.
function pfxMonthKey(offset = 0) {
  const [y, m] = todayIso.slice(0, 7).split("-").map(Number);
  const d = new Date(y, m - 1 + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function pfxDelta(current, previous, { money = false, inverse = false } = {}) {
  if (!previous && !current) return { text: "", tone: "" };
  if (!previous) return { text: "novo este mês", tone: "up" };
  const diff = current - previous;
  if (!diff) return { text: "igual ao mês passado", tone: "" };
  const good = inverse ? diff < 0 : diff > 0;
  const label = money ? formatCurrency(Math.abs(diff)) : Math.abs(diff).toLocaleString("pt-BR");
  return { text: `${diff > 0 ? "+" : "−"}${label} vs mês passado`, tone: good ? "up" : "down" };
}

// Dias com algo feito no app: tarefa concluída, nota criada/editada ou
// lançamento registrado. É o que alimenta o mapa de atividade.
function pfxActivityByDay() {
  const map = new Map();
  const bump = (iso) => { if (iso && /^\d{4}-\d{2}-\d{2}/.test(iso)) { const k = iso.slice(0, 10); map.set(k, (map.get(k) || 0) + 1); } };
  (state.tasks || []).forEach((t) => bump(t.completedAt));
  (state.notes || []).forEach((n) => { bump(n.createdAt); if (n.updatedAt && n.updatedAt.slice(0, 10) !== String(n.createdAt || "").slice(0, 10)) bump(n.updatedAt); });
  (state.finances || []).forEach((f) => bump(f.createdAt || ""));
  return map;
}

function pfxBestStreak() {
  const days = [...new Set((state.tasks || []).map((t) => t.completedAt).filter(Boolean))].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  days.forEach((day) => {
    const time = new Date(`${day}T12:00:00`).getTime();
    run = prev !== null && Math.round((time - prev) / 86400000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = time;
  });
  return best;
}

function pfxRenderHeatmap({ fromView = false } = {}) {
  const root = document.querySelector("#profileHeatmap");
  if (!root) return;
  const activity = pfxActivityByDay();
  let activitySig = 0;
  activity.forEach((n, iso) => { activitySig = (activitySig * 31 + n * 7 + Number(iso.replaceAll("-", ""))) % 1e9; });
  const dataSig = `${todayIso}|${activity.size}|${activitySig}`;
  // Ao abrir o Perfil: mesmo dia e mesma atividade do último desenho →
  // nada a fazer, sem medir (medir aqui recalculava a página na troca).
  // Mudança de largura é tratada pelo ResizeObserver (pfxWatchHeatmap).
  if (fromView && root.childElementCount && root.dataset.pnDataSig === dataSig) return;
  const wrapEl = root.closest(".pfx-heat-wrap");
  // Tela de perfil escondida (largura 0): desenha quando ela aparecer.
  if (!wrapEl || !wrapEl.clientWidth) return;
  root.dataset.pnDataSig = dataSig;
  pfxWatchHeatmap(wrapEl);
  // Quantas semanas cabem (12 a 20) e de que tamanho fica cada célula para o
  // mapa ocupar a largura exata do cartão — sem rolagem nem célula cortada.
  const cs = getComputedStyle(wrapEl);
  const gap = parseFloat(cs.getPropertyValue("--gap")) || 4;
  const innerW = wrapEl.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const labelsW = (wrapEl.querySelector(".pfx-heat-days")?.offsetWidth || 28) + (parseFloat(cs.columnGap) || 10);
  const avail = Math.max(120, innerW - labelsW);
  // Tela larga: até 26 semanas (6 meses) com células maiores, para o mapa
  // preencher o cartão sem ficar com buracos enormes entre as colunas.
  const weeks = Math.max(12, Math.min(26, Math.floor((avail + gap) / (13 + gap))));
  const cell = Math.max(9, Math.min(24, Math.floor((avail - gap * (weeks - 1)) / weeks)));
  wrapEl.style.setProperty("--cell", `${cell}px`);
  // Mesmo dia, mesmo tamanho e mesma atividade do último desenho: não
  // refaz as ~180 células (abrir o Perfil reconstruía o mapa inteiro).
  const sig =`${todayIso}|${weeks}|${cell}|${activity.size}|${activitySig}`;
  if (root.dataset.pnSig === sig && root.childElementCount) return;
  root.dataset.pnSig = sig;
  wrapEl.dataset.weeks = String(weeks);
  wrapEl.dataset.width = String(wrapEl.clientWidth);
  const today = new Date(`${todayIso}T12:00:00`);
  const mondayOffset = (today.getDay() + 6) % 7; // 0 = segunda
  const start = new Date(today);
  start.setDate(today.getDate() - mondayOffset - (weeks - 1) * 7);
  const level = (n) => (n <= 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4);
  let activeDays = 0;
  const cells = [];
  const MONTHS_SHORT = ["jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."];
  for (let i = 0; i < weeks * 7; i += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const iso = toLocalIso(day);
    const future = iso > todayIso;
    const count = future ? 0 : activity.get(iso) || 0;
    if (count) activeDays += 1;
    // Data montada à mão (formatar com Intl em cada célula custava ~8ms).
    const label = `${day.getDate()} de ${MONTHS_SHORT[day.getMonth()]}: ${count ? `${count} ${count === 1 ? "atividade" : "atividades"}` : "sem atividade"}`;
    cells.push(`<i class="l${level(count)}${future ? " is-future" : ""}${iso === todayIso ? " is-today" : ""}" style="--d:${i}" title="${escapeHtml(label)}"></i>`);
  }
  root.innerHTML = cells.join("");
  root.setAttribute("aria-label", `Atividade das últimas ${weeks} semanas: ${activeDays} dias ativos`);
  const summary = document.querySelector("#profileActivitySummary");
  if (summary) summary.textContent = `${activeDays} ${activeDays === 1 ? "dia ativo" : "dias ativos"} em ${weeks} semanas`;
}

// Redesenha o mapa quando a largura do cartão muda (girar o celular,
// redimensionar a janela do app instalado, abrir a tela de perfil).
let pfxHeatObserver = null;
let pfxHeatTimer = 0;
function pfxWatchHeatmap(wrapEl) {
  if (pfxHeatObserver || typeof ResizeObserver !== "function") return;
  pfxHeatObserver = new ResizeObserver(() => {
    clearTimeout(pfxHeatTimer);
    pfxHeatTimer = setTimeout(() => {
      const width = wrapEl.clientWidth;
      if (width && String(width) !== wrapEl.dataset.width) pfxRenderHeatmap();
    }, 120);
  });
  pfxHeatObserver.observe(wrapEl);
}

function pfxAccountRows() {
  const root = document.querySelector("#profileAccountRows");
  if (!root) return;
  const notifOn = Boolean(window.notificationsAreEnabled?.());
  const notifSupported = "Notification" in window;
  const wa = state.whatsappLinkedPhone ? `Conectado · +${state.whatsappLinkedPhone}` : "Não conectado";
  const isAdmin = document.getElementById("adminAccessCard")?.hidden === false;
  const rows = [
    { icon: "crown", title: "Plano", sub: pfPlanLabel(), action: `data-pfx-go="settings:plano"`, cta: bdIcon("chev-right") },
    {
      icon: "bell",
      title: "Notificações",
      sub: notifOn ? "Ativas neste aparelho" : notifSupported ? "Desativadas neste aparelho" : "Não suportadas neste navegador",
      tone: notifOn ? "on" : "",
      action: notifOn || !notifSupported ? `data-pfx-go="settings:notificacoes"` : "data-pfx-notify",
      cta: notifOn || !notifSupported ? bdIcon("chev-right") : `<span class="pfx-row-btn">Ativar</span>`,
    },
    { icon: "whatsapp", title: "WhatsApp", sub: wa, tone: state.whatsappLinkedPhone ? "on" : "", action: `data-pfx-go="settings:integracoes"`, cta: state.whatsappLinkedPhone ? bdIcon("chev-right") : `<span class="pfx-row-btn">Conectar</span>` },
    { icon: "shield", title: "Segurança e dados", sub: "Senha, sessões e exclusão da conta", action: `data-pfx-go="settings:seguranca"`, cta: bdIcon("chev-right") },
    { icon: "arrow-down", title: "Backup", sub: "Baixar uma cópia dos seus dados", action: "data-pfx-backup", cta: `<span class="pfx-row-btn">Baixar</span>` },
  ];
  if (isAdmin) rows.push({ icon: "sliders", title: "Administração", sub: "Painel do PulseNote", action: "data-pfx-admin", cta: bdIcon("external") });
  root.innerHTML = rows.map((row) => `<button type="button" class="pfx-row${row.tone ? ` is-${row.tone}` : ""}" ${row.action}>
      <span class="pfx-row-ico">${bdIcon(row.icon)}</span>
      <span class="pfx-row-copy"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.sub)}</small></span>
      <span class="pfx-row-cta">${row.cta}</span>
    </button>`).join("");
}

function pfxSyncThemeSeg() {
  const current = typeof getSavedTheme === "function" ? getSavedTheme() : "system";
  document.querySelectorAll("#profileThemeSeg [data-pfx-theme]").forEach((button) => {
    const on = button.dataset.pfxTheme === current;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-checked", String(on));
  });
}

function bindProfileV3() {
  const view = document.querySelector("#profileView");
  if (!view || view.dataset.bound) return;
  view.dataset.bound = "1";
  view.addEventListener("click", (event) => {
    const go = event.target.closest("[data-pfx-go]");
    if (go) {
      const [target, section] = go.dataset.pfxGo.split(":");
      setView(target);
      if (target === "settings" && section) setTimeout(() => openSettingsSection(section), 0);
      return;
    }
    if (event.target.closest("[data-pfx-photo]")) return document.getElementById("settingsPhotoInput")?.click();
    if (event.target.closest("[data-pfx-notify]")) {
      Promise.resolve(window.requestNotificationPermission?.()).finally(() => pfxAccountRows());
      return;
    }
    if (event.target.closest("[data-pfx-backup]")) return document.getElementById("settingsExportBackup")?.click();
    if (event.target.closest("[data-pfx-admin]")) return window.location.assign("/admin");
    if (event.target.closest("[data-pfx-logout]")) return document.getElementById("dropdownLogout")?.click();
    const theme = event.target.closest("[data-pfx-theme]");
    if (theme) {
      // Reaproveita o seletor de tema de Configurações (mantém os dois em sincronia).
      document.querySelector(`#themeToggle [data-theme-choice="${theme.dataset.pfxTheme}"]`)?.click();
      pfxSyncThemeSeg();
      return;
    }
    const toggle = event.target.closest("#profileAchToggle");
    if (toggle) {
      const all = document.querySelector("#profileAchAll");
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector("span").textContent = open ? "Recolher conquistas" : "Ver todas as conquistas";
      if (all) all.hidden = !open;
    }
  });
  view.querySelector(".pfx-theme-seg")?.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft"].includes(event.key)) return;
    const list = [...view.querySelectorAll("[data-pfx-theme]")];
    const index = list.indexOf(document.activeElement);
    const next = list[(index + (event.key === "ArrowRight" ? 1 : list.length - 1)) % list.length];
    next?.focus();
    next?.click();
  });
}

function renderProfile() {
  const nameEl = document.querySelector("#profileNameLabel");
  if (!nameEl) return;
  bindProfileV3();

  const user = getUser();
  nameEl.textContent = user?.name || "Usuário";
  const emailEl = document.querySelector("#profileEmailLabel");
  if (emailEl) emailEl.textContent = user?.email || "";

  const photoURL = state?.profilePhoto || currentUser?.photoURL || "";
  const avatarEl = document.querySelector("#profileAvatarPreview");
  if (avatarEl) avatarEl.innerHTML = photoURL ? `<img src="${escapeHtml(photoURL)}" alt="Foto de perfil"/>` : escapeHtml(bdInitials(user?.name || "U"));

  // Nível: anel em volta da foto + barra compacta.
  const { level, levelProgress, xpIntoLevel, xpPerLevel, score } = calculateXpStats();
  const streak = calculateStreak();
  document.querySelector("#profileLevelLabel").textContent = `Nível ${level}`;
  document.querySelector("#profileLevelBadge").textContent = level;
  document.querySelector("#profileLevelBar").style.width = `${levelProgress}%`;
  document.querySelector("#profileLevelRing")?.style.setProperty("--p", levelProgress);
  document.querySelector("#profileLevelXpLabel").textContent = `${xpIntoLevel}/${xpPerLevel} XP · ${score.toLocaleString("pt-BR")} XP no total`;
  const nextEl = document.querySelector("#profileLevelNext");
  if (nextEl) nextEl.textContent = `Faltam ${xpPerLevel - xpIntoLevel} XP para o nível ${level + 1}`;

  const planChip = document.querySelector("#profilePlanChip span");
  if (planChip) planChip.textContent = pfPlanLabel();
  const streakChip = document.querySelector("#profileStreakChip span");
  if (streakChip) streakChip.textContent = streak === 1 ? "1 dia seguido" : `${streak} dias seguidos`;
  const since = currentUser?.metadata?.creationTime ? new Date(currentUser.metadata.creationTime) : null;
  const sinceChip = document.querySelector("#profileSinceChip");
  if (sinceChip) {
    sinceChip.hidden = !since || Number.isNaN(since.getTime());
    if (!sinceChip.hidden) sinceChip.querySelector("span").textContent = `Desde ${safeFormatDate(since, { month: "short", year: "numeric" }, "")}`;
  }

  // Seu mês em números (comparado ao mês anterior).
  const thisMonth = pfxMonthKey(0);
  const lastMonth = pfxMonthKey(-1);
  const monthTitle = document.querySelector("#profileMonthTitle");
  if (monthTitle) monthTitle.textContent = `Seu mês · ${finMonthLabel(thisMonth)}`;
  const doneIn = (key) => (state.tasks || []).filter((t) => t.status === "Concluida" && String(t.completedAt || "").startsWith(key)).length;
  const notesIn = (key) => (state.notes || []).filter((n) => String(n.createdAt || "").startsWith(key)).length;
  const balanceIn = (key) => (state.finances || [])
    .filter((f) => (f.workspaceId || "personal") === "personal" && String(f.date || "").startsWith(key))
    .reduce((sum, f) => sum + (f.type === "receita" ? 1 : -1) * (Number(f.amount) || 0), 0);
  const goalsDone = (state.goals || []).filter((g) => g.current >= g.target).length;
  const setDelta = (id, delta) => {
    const el = document.querySelector(id);
    if (!el) return;
    el.textContent = delta.text;
    el.dataset.tone = delta.tone;
  };
  const tasksNow = doneIn(thisMonth);
  const notesNow = notesIn(thisMonth);
  const balanceNow = balanceIn(thisMonth);
  document.querySelector("#profileStatTasks").textContent = tasksNow.toLocaleString("pt-BR");
  setDelta("#profileDeltaTasks", pfxDelta(tasksNow, doneIn(lastMonth)));
  document.querySelector("#profileStatGoals").textContent = goalsDone.toLocaleString("pt-BR");
  setDelta("#profileDeltaGoals", { text: `de ${(state.goals || []).length} ${(state.goals || []).length === 1 ? "meta" : "metas"}`, tone: "" });
  document.querySelector("#profileStatNotes").textContent = notesNow.toLocaleString("pt-BR");
  setDelta("#profileDeltaNotes", pfxDelta(notesNow, notesIn(lastMonth)));
  const balanceEl = document.querySelector("#profileStatBalance");
  if (balanceEl) {
    balanceEl.textContent = formatCurrency(balanceNow);
    balanceEl.dataset.tone = balanceNow < 0 ? "down" : balanceNow > 0 ? "up" : "";
  }
  setDelta("#profileDeltaBalance", pfxDelta(balanceNow, balanceIn(lastMonth), { money: true }));

  // Atividade
  document.querySelector("#profileStatStreak").textContent = streak;
  const best = document.querySelector("#profileBestStreak");
  if (best) best.textContent = Math.max(streak, pfxBestStreak());
  pfxRenderHeatmap();

  // Conquistas compactas
  const achievements = getAchievementsList();
  const unlockedCount = achievements.filter((a) => a.unlocked).length;
  document.querySelector("#profileAchievementCount").textContent = `${unlockedCount}/${achievements.length}`;
  const sub = document.querySelector("#profileAchievementSub");
  if (sub) sub.textContent = unlockedCount === achievements.length
    ? "Você desbloqueou todas as conquistas. Incrível!"
    : `${unlockedCount} de ${achievements.length} ganhas — faltam ${achievements.length - unlockedCount}.`;
  const achBar = document.querySelector("#profileAchievementBar");
  if (achBar) achBar.style.width = `${Math.round((unlockedCount / Math.max(1, achievements.length)) * 100)}%`;
  const medals = document.querySelector("#profileMedals");
  if (medals) medals.innerHTML = achievements.map((a) => `<span class="pfx-medal${a.unlocked ? " is-on" : ""}" title="${escapeHtml(`${a.title} — ${a.unlocked ? "ganha" : a.detail}`)}">${pfAchIcon(a.iconName)}</span>`).join("");

  const nextCard = document.querySelector("#profileNextAchievement");
  if (nextCard) {
    const upcoming = achievements
      .filter((a) => !a.unlocked)
      .map((a) => ({ ...a, ratio: (Number(a.current) || 0) / (Number(a.target) || 1) }))
      .sort((x, y) => y.ratio - x.ratio)
      .slice(0, 2);
    nextCard.innerHTML = upcoming.length
      ? `<p class="pfx-next-title">Mais perto de sair</p>${upcoming.map((a) => {
          const target = Number(a.target) || 1;
          const current = Math.min(target, Number(a.current) || 0);
          return `<div class="pfx-next-row">
            <span class="pfx-next-ico">${pfAchIcon(a.iconName)}</span>
            <div class="pfx-next-copy"><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.detail)} · ${current}/${target}</small>
              <div class="pf-bar pfx-next-bar"><div style="width:${Math.round((current / target) * 100)}%"></div></div></div>
          </div>`;
        }).join("")}`
      : `<p class="pfx-next-title">${bdIcon("crown")} Coleção completa — continue no ritmo para subir de nível.</p>`;
  }

  const visible = achievements.filter((a) => pfAchFilter === "all" || (pfAchFilter === "unlocked" ? a.unlocked : !a.unlocked));
  const grid = document.querySelector("#profileAchievements");
  grid.innerHTML = visible.length
    ? visible.map((a) => {
        const target = Number(a.target) || 1;
        const current = Math.min(target, Number(a.current) || 0);
        return `<div class="pfx-ach-item${a.unlocked ? " is-on" : ""}">
          <span class="pfx-ach-ico">${pfAchIcon(a.iconName)}</span>
          <span class="pfx-ach-copy"><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.detail)}</small></span>
          <span class="pfx-ach-state">${a.unlocked ? bdIcon("check") : `${current}/${target}`}</span>
        </div>`;
      }).join("")
    : `<p class="pfx-empty">${pfAchFilter === "unlocked" ? "Nenhuma conquista ainda — conclua sua primeira tarefa para começar." : "Nada pendente por aqui. Você conquistou tudo!"}</p>`;
  document.querySelectorAll("#profileAchAll [data-pf-filter]").forEach((btn) => {
    const on = btn.dataset.pfFilter === pfAchFilter;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    if (!btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => { pfAchFilter = btn.dataset.pfFilter; renderProfile(); });
    }
  });

  pfxAccountRows();
  pfxSyncThemeSeg();
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
  const aiPreference = document.getElementById("pulsinhoAiPreference");
  if (aiPreference && document.activeElement !== aiPreference) aiPreference.value = state.aiProviderPreference || "auto";
  loadBillingSettings();
  if (!handleBillingReturnParams.done) { handleBillingReturnParams.done = true; handleBillingReturnParams(); }
  renderSettingsBoard();
}

// ============================================================
// CONFIGURAÇÕES (quadro 10) — visão geral em cartões + detalhes em painel
// ============================================================
const ST_TITLES = { conta: "Conta", aparencia: "Aparência", plano: "Plano e cobrança", integracoes: "Integrações", inteligencia: "Inteligência", notificacoes: "Notificações", seguranca: "Segurança e dados" };
let stBillingSummary = null;
let stOpenKey = "";
let stMovedHome = null;

function stIsMobile() { return window.matchMedia("(max-width: 760px)").matches; }

function renderSettingsBoard() {
  const user = getUser();
  const name = user?.name || "Usuário";
  const photoURL = state?.profilePhoto || currentUser?.photoURL || "";
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  set("stName", name);
  set("stEmail", user?.email || "");
  const avatar = document.getElementById("stAvatar");
  if (avatar) avatar.innerHTML = photoURL ? `<img src="${escapeHtml(photoURL)}" alt=""/>` : escapeHtml(bdInitials(name));
  const emailInput = document.getElementById("stEmailInput");
  if (emailInput) emailInput.value = user?.email || "";

  const isAdmin = document.getElementById("adminAccessCard")?.hidden === false;
  const role = isAdmin ? "Proprietário da organização" : "Conta pessoal";
  set("stRole", role);
  set("stOrgRole", isAdmin ? "Proprietário" : "Pessoal");
  const adminBtn = document.getElementById("stAdminBtn");
  if (adminBtn) adminBtn.hidden = !isAdmin;
  const editBtn = document.getElementById("stEditProfileBtn");
  if (editBtn) editBtn.hidden = isAdmin;

  // Plano
  const planLabel = document.querySelector("#bdUserPlan")?.textContent?.trim() || "";
  const summary = stBillingSummary || (isLocalDesignPreview
    ? { name: planLabel || "Plano Pro", status: "Ativo", tone: "on", desc: "Recursos avançados, IA e integrações." }
    : { name: planLabel || "Seu plano", status: "…", tone: "", desc: "Consultando sua assinatura…" });
  set("stPlanName", summary.name);
  set("stPlanDesc", summary.desc);
  const chip = document.getElementById("stPlanStatus");
  if (chip) { chip.textContent = summary.status; chip.className = `st-chip${summary.tone ? ` is-${summary.tone}` : ""}`; }
  const badge = document.getElementById("stPlanBadge");
  if (badge) {
    const short = summary.tone === "on" ? summary.name.replace(/^Plano\s+/i, "") : "";
    badge.hidden = !short;
    badge.textContent = short;
  }

  // Conquistas
  const achRoot = document.getElementById("stAchievement");
  if (achRoot && typeof getAchievementsList === "function") {
    const list = getAchievementsList();
    const unlocked = list.filter((item) => item.unlocked);
    const highlight = unlocked[unlocked.length - 1] || list[0];
    const next = list.find((item) => !item.unlocked);
    const dots = list.slice(0, 5).map((item) => `<i class="${item.unlocked ? "is-on" : ""}" title="${escapeHtml(item.title)}">${item.unlocked ? bdIcon("check") : ""}</i>`).join("");
    achRoot.innerHTML = `<span class="st-ach-badge${highlight?.unlocked ? "" : " is-locked"}">${bdIcon(highlight?.unlocked ? "star" : "lock")}</span>
      <div class="st-ach-copy"><strong>${escapeHtml(highlight?.title || "Primeira conquista")}</strong><small>${escapeHtml(highlight?.unlocked ? highlight.detail : `Próxima: ${next?.detail || highlight?.detail || ""}`)} · ${unlocked.length}/${list.length}</small><div class="st-ach-dots">${dots}</div></div>`;
  }

  // Integrações e notificações
  const linked = Boolean(state?.whatsappLinkedPhone);
  set("stWaStatus", linked ? `Conectado • +${state.whatsappLinkedPhone}` : "Desconectado");
  document.getElementById("stWaStatus")?.classList.toggle("is-on", linked);
  const waSwitch = document.getElementById("stWaSwitch");
  if (waSwitch) waSwitch.setAttribute("aria-checked", String(linked));
  const push = document.getElementById("appReminderOptIn");
  const pushOn = Boolean(push?.checked);
  set("stPushStatus", pushOn ? "Ativo" : "Desativado");
  document.getElementById("stPushStatus")?.classList.toggle("is-on", pushOn);
  const pushSwitch = document.getElementById("stPushSwitch");
  if (pushSwitch) pushSwitch.setAttribute("aria-checked", String(pushOn));
  const notesSwitch = document.getElementById("stAiNotesSwitch");
  if (notesSwitch) notesSwitch.setAttribute("aria-checked", String(state?.aiReadNotes !== false));

  if (typeof renderAutopilotAiPreference === "function") renderAutopilotAiPreference();
}

function stSetActiveNav(key) {
  document.querySelectorAll(".st-nav-item").forEach((item) => {
    const active = item.dataset.st === key;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "true"); else item.removeAttribute("aria-current");
  });
}

function openSettingsSection(key) {
  if (!ST_TITLES[key]) return;
  stSetActiveNav(key);
  const inline = key === "aparencia" || key === "inteligencia";
  if (inline && !stIsMobile()) {
    closeSettingsDrawer();
    stSetActiveNav(key);
    const card = document.querySelector(`[data-st-sec="${key}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    card?.classList.remove("is-flash");
    requestAnimationFrame(() => card?.classList.add("is-flash"));
    return;
  }
  const drawer = document.getElementById("stDrawer");
  const body = document.getElementById("stDrawerBody");
  if (!drawer || !body) return;
  closeSettingsDrawer({ keepNav: true });
  const panel = inline ? document.querySelector(`[data-st-sec="${key}"]`) : document.querySelector(`[data-st-panel="${key}"]`);
  if (!panel) return;
  stMovedHome = { panel, parent: panel.parentElement, next: panel.nextSibling };
  body.appendChild(panel);
  document.getElementById("stDrawerTitle").textContent = ST_TITLES[key];
  const msg = document.getElementById("settingsMessage");
  if (msg) msg.hidden = true;
  stOpenKey = key;
  drawer.hidden = false;
  document.body.classList.add("st-drawer-open");
  if (key === "plano") loadBillingSettings(true);
  renderSettingsBoard();
  requestAnimationFrame(() => (drawer.querySelector(stIsMobile() ? "#stDrawerBack" : "#stDrawerClose"))?.focus());
}

// Saída do painel de Configurações: desliza para fora (celular: volta
// como uma tela empilhada; navegador: recua e esmaece) e só então devolve o
// conteúdo ao lugar — fechar não "corta" mais de uma vez.
let stDrawerExit = null;
function closeSettingsDrawer({ keepNav = false } = {}) {
  const drawer = document.getElementById("stDrawer");
  stDrawerExit?.();
  const wasOpen = Boolean(drawer && !drawer.hidden && stOpenKey);
  const finish = () => {
    stDrawerExit = null;
    if (stMovedHome) {
      const { panel, parent, next } = stMovedHome;
      parent.insertBefore(panel, next && next.parentElement === parent ? next : null);
      stMovedHome = null;
    }
    if (drawer) { drawer.hidden = true; drawer.style.pointerEvents = ""; }
    document.body.classList.remove("st-drawer-open");
  };
  if (!keepNav && stOpenKey) stSetActiveNav(stIsMobile() ? "" : "conta");
  stOpenKey = "";
  const card = drawer?.querySelector(".st-drawer-card");
  if (!wasOpen || keepNav || !card?.animate || prefersReducedMotion()) { finish(); return; }
  const mobile = stIsMobile();
  const duration = mobile ? 240 : 190;
  const easing = "cubic-bezier(.4, 0, .9, .55)";
  drawer.style.pointerEvents = "none";
  const anims = [card.animate(mobile
    ? [{ transform: "translateX(0)" }, { transform: "translateX(100%)" }]
    : [{ transform: "translateX(0)", opacity: 1 }, { transform: "translateX(28px)", opacity: 0 }], { duration, easing, fill: "forwards" })];
  if (!mobile) anims.push(drawer.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: "ease", fill: "forwards" }));
  stDrawerExit = () => { finish(); anims.forEach((a) => a.cancel()); };
  anims[0].onfinish = () => stDrawerExit?.();
}

function bindSettingsBoard() {
  const view = document.getElementById("settingsView");
  if (!view) return;
  view.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-st]");
    if (nav) return openSettingsSection(nav.dataset.st);
    const go = event.target.closest("[data-st-go]");
    if (go) return openSettingsSection(go.dataset.stGo);
    const proxy = event.target.closest("[data-st-proxy]");
    if (proxy) document.getElementById(proxy.dataset.stProxy)?.click();
  });
  document.getElementById("stDrawerClose")?.addEventListener("click", () => closeSettingsDrawer());
  document.getElementById("stDrawerBack")?.addEventListener("click", () => closeSettingsDrawer());
  document.getElementById("stDrawer")?.addEventListener("click", (event) => { if (event.target.id === "stDrawer") closeSettingsDrawer(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !document.getElementById("stDrawer")?.hidden) closeSettingsDrawer(); });

  document.getElementById("stInteligencia")?.addEventListener("click", (event) => {
    const option = event.target.closest("[data-ai-pref]");
    if (!option) return;
    state.aiProviderPreference = ["openai", "anthropic"].includes(option.dataset.aiPref) ? option.dataset.aiPref : "auto";
    saveState();
    renderAutopilotAiPreference();
    showToast("Preferência do Pulsinho atualizada.");
  });
  document.getElementById("stWaSwitch")?.addEventListener("click", () => {
    if (state.whatsappLinkedPhone) document.getElementById("settingsWhatsappUnlinkBtn")?.click();
    else startWhatsappLink();
    setTimeout(renderSettingsBoard, 400);
  });
  document.getElementById("stAiNotesSwitch")?.addEventListener("click", () => {
    state.aiReadNotes = state.aiReadNotes === false;
    saveState();
    renderSettingsBoard();
    showToast(state.aiReadNotes ? "O Pulsinho pode ler suas notas para responder." : "O Pulsinho não lê mais o conteúdo das notas (só os títulos).");
  });
  document.getElementById("stPushSwitch")?.addEventListener("click", () => {
    const box = document.getElementById("appReminderOptIn");
    if (!box) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    setTimeout(renderSettingsBoard, 300);
  });
  document.getElementById("appReminderOptIn")?.addEventListener("change", () => setTimeout(renderSettingsBoard, 0));
  window.matchMedia("(max-width: 760px)").addEventListener?.("change", () => { if (stOpenKey) closeSettingsDrawer(); stSetActiveNav(stIsMobile() ? "" : "conta"); });
  if (stIsMobile()) stSetActiveNav("");
}

let billingRequest = null;

function billingShortDate(iso) {
  const [year, month, day] = String(iso || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
}

// ── Manutenção: tela cheia com a mensagem definida no painel ──────────
let maintenancePoll = null;
function applyMaintenanceState(maintenance) {
  const active = Boolean(maintenance?.enabled) && !maintenance.bypass;
  let screen = document.getElementById("pnMaintenance");
  if (!active) {
    if (screen) screen.remove();
    document.documentElement.classList.remove("is-maintenance");
    if (maintenancePoll) { clearInterval(maintenancePoll); maintenancePoll = null; }
    if (maintenance?.enabled && maintenance.bypass && !applyMaintenanceState.warned) {
      applyMaintenanceState.warned = true;
      showToast("Manutenção ativa: só administradores estão usando o app agora.");
    }
    return;
  }
  if (!screen) {
    screen = document.createElement("div");
    screen.id = "pnMaintenance";
    screen.className = "pn-maintenance";
    screen.setAttribute("role", "alertdialog");
    screen.setAttribute("aria-modal", "true");
    screen.setAttribute("aria-labelledby", "pnMaintenanceTitle");
    document.body.appendChild(screen);
  }
  screen.innerHTML = `<div class="pn-maintenance__card">
    <span class="bd-mascot pn-maintenance__mascot" aria-hidden="true"><span class="bd-mascot__eyes"><i></i><i></i></span><svg class="bd-mascot__pulse" viewBox="0 0 120 26"><path d="M0,13 L28,13 L36,3 L44,23 L52,13 L64,13 L70,6 L76,20 L82,13 L120,13"/></svg></span>
    <h1 id="pnMaintenanceTitle">Estamos em manutenção</h1>
    <p>${escapeHtml(maintenance.message || "O PulseNote está em manutenção. Volte em instantes.")}</p>
    ${maintenance.eta ? `<p class="pn-maintenance__eta">Previsão de retorno: <strong>${escapeHtml(maintenance.eta)}</strong></p>` : ""}
    <p class="pn-maintenance__safe">Seus dados estão guardados com segurança.</p>
    <button type="button" class="primary-button" id="pnMaintenanceRetry">Tentar de novo</button>
  </div>`;
  document.documentElement.classList.add("is-maintenance");
  screen.querySelector("#pnMaintenanceRetry")?.addEventListener("click", () => loadBillingSettings(true));
  if (!maintenancePoll) maintenancePoll = setInterval(() => loadBillingSettings(true), 60000);
}

// ── Cobranças pendentes do usuário ────────────────────────────────────
let billingChargesNotified = false;
function renderBillingCharges(data) {
  const host = document.getElementById("billingChargesList");
  const charges = Array.isArray(data?.charges) ? data.charges : [];
  if (host) {
    host.hidden = !charges.length;
    const manual = data?.payment?.manual;
    host.innerHTML = charges.length ? `<h3 class="billing-charges__title">Cobranças pendentes</h3>${charges.map((charge) => `
      <article class="billing-charge" data-charge-id="${escapeHtml(charge.id)}">
        <div><strong>${escapeHtml(charge.note)}</strong><small>${billingMoney(charge.amountCents)}${charge.dueDate ? ` · vence ${billingShortDate(charge.dueDate)}` : ""}${charge.planId && charge.grantDays ? ` · libera ${charge.grantDays} dias de plano` : ""}</small></div>
        ${data?.payment?.online ? `<button type="button" class="primary-button" data-pay-charge="${escapeHtml(charge.id)}">Pagar agora</button>` : ""}
      </article>`).join("")}
      ${manual ? `<div class="billing-pix"><span>Pague por Pix${manual.pixHolder ? ` para <strong>${escapeHtml(manual.pixHolder)}</strong>` : ""}</span><code>${escapeHtml(manual.pixKey)}</code><button type="button" class="ghost-button" data-copy-pix="${escapeHtml(manual.pixKey)}">Copiar chave Pix</button>${manual.instructions ? `<small>${escapeHtml(manual.instructions)}</small>` : ""}</div>` : ""}
      ${!data?.payment?.online && !manual ? `<small class="billing-charges__hint">O administrador vai te enviar as instruções de pagamento.</small>` : ""}` : "";
    host.querySelectorAll("[data-pay-charge]").forEach((button) => button.addEventListener("click", async () => {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "Abrindo pagamento…";
      try {
        const result = await billingApi("charge-pay", "POST", { chargeId: button.dataset.payCharge });
        window.location.assign(result.url);
      } catch (error) {
        console.error("Falha ao iniciar pagamento:", error.code || error.message);
        button.disabled = false;
        button.textContent = original;
        showToast("Não foi possível abrir o pagamento agora.");
      }
    }));
    host.querySelector("[data-copy-pix]")?.addEventListener("click", async (event) => {
      try { await navigator.clipboard.writeText(event.currentTarget.dataset.copyPix); showToast("Chave Pix copiada."); }
      catch { showToast("Não foi possível copiar. Selecione a chave e copie manualmente."); }
    });
  }
  if (charges.length && !billingChargesNotified) {
    billingChargesNotified = true;
    const total = charges.reduce((sum, charge) => sum + charge.amountCents, 0);
    showToast(`Você tem ${charges.length === 1 ? "1 cobrança pendente" : `${charges.length} cobranças pendentes`} (${billingMoney(total)}). Veja em Configurações → Plano.`);
  }
}

// Retorno do pagamento e link direto para a cobrança (?pay=...).
function handleBillingReturnParams() {
  let params;
  try { params = new URLSearchParams(window.location.search); } catch { return; }
  const billing = params.get("billing");
  const pay = params.get("pay");
  if (!billing && !pay) return;
  if (billing === "charge_success" || billing === "success") showToast("Pagamento enviado! A confirmação pode levar alguns instantes.");
  else if (billing === "cancelled") showToast("Pagamento cancelado. Nada foi cobrado.");
  setTimeout(() => { try { openSettingsSection("plano"); } catch { /* tela ainda carregando */ } }, 600);
  params.delete("billing");
  params.delete("pay");
  params.delete("session_id");
  const query = params.toString();
  try { window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`); } catch { /* sem history */ }
}
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
  const statusBadge = document.getElementById("billingStatusBadge");
  const statusText = document.getElementById("billingStatusText");
  // A prévia visual usa uma identidade fictícia e nunca deve consultar APIs
  // autenticadas. Além de evitar ruído no console, isto reforça que o QA não
  // cria assinatura, checkout ou qualquer alteração financeira real.
  if (isLocalDesignPreview) {
    statusBadge.textContent = "Prévia visual";
    statusBadge.className = "billing-status-badge";
    statusText.textContent = "Planos e pagamentos não são simulados neste preview seguro.";
    grid.innerHTML = '<div class="empty-state">Entre com uma conta real para consultar assinatura e cobrança.</div>';
    const actions = document.getElementById("billingActions");
    if (actions) actions.hidden = true;
    return null;
  }
  if (billingRequest && !force) return billingRequest;
  billingRequest = billingApi("status").then((data) => {
    applyMaintenanceState(data.maintenance);
    renderBillingCharges(data);
    const current = data.subscription || {};
    const active = current.status === "active" && !current.expired;
    const trialUntil = current.trial && active && current.validUntil ? billingShortDate(current.validUntil) : "";
    // QA 18/11: o cadastro promete "Grátis para sempre", mas quem não assinou
    // via "Sem plano contratado" e "Nenhum plano público disponível". Sem
    // assinatura (e sem plano vencido/pausado), a conta está no plano gratuito.
    const onFree = !active && !current.planId && !current.expired;
    const planLabel = document.querySelector("#bdUserPlan");
    if (planLabel) planLabel.textContent = active ? `Plano ${(data.plans || []).find((plan) => plan.id === current.planId)?.name || ""}`.trim() : onFree ? "Plano gratuito" : "Sem plano";
    const pfPlan = document.querySelector("#profilePlanChip span");
    if (pfPlan && planLabel) pfPlan.textContent = planLabel.textContent;
    statusBadge.textContent = trialUntil ? `Teste grátis até ${trialUntil}` : active ? "Assinatura ativa" : current.expired ? (current.trial ? "Teste encerrado" : "Plano vencido") : current.planId ? "Assinatura pausada" : "Plano gratuito ativo";
    statusBadge.className = `billing-status-badge ${active || onFree ? "is-active" : current.planId ? "is-warning" : ""}`;
    const currentPlan = (data.plans || []).find((plan) => plan.id === current.planId);
    stBillingSummary = {
      name: currentPlan ? `Plano ${currentPlan.name}` : onFree ? "Plano gratuito" : "Sem plano",
      status: trialUntil ? `Teste até ${trialUntil}` : active ? "Ativo" : current.expired ? "Vencido" : current.planId ? "Pausado" : onFree ? "Ativo" : "Inativo",
      tone: active || onFree ? "on" : current.planId ? "warn" : "",
      desc: currentPlan?.description || (active ? "Recursos do seu plano liberados." : onFree ? "Planner, notas, finanças, backup e o Pulsinho com uso diário limitado — sem cobrança." : "Escolha um plano para liberar mais recursos."),
    };
    renderSettingsBoard();
    statusText.textContent = onFree
      ? "Sua conta está no plano gratuito, sem cobrança e sem cartão cadastrado. Inclui Planner, Notas, Finanças, backup e o Pulsinho com um limite diário de uso da IA."
      : !data.configured
        ? "Os pagamentos ainda não foram ativados pelo administrador. Seus recursos atuais continuam funcionando normalmente."
        : active ? "Seu acesso é atualizado automaticamente após cada confirmação do provedor de pagamento."
          : "Escolha um plano para ativar os recursos correspondentes.";
    if (!data.plans.length && onFree) {
      grid.innerHTML = "";
      grid.hidden = true;
      const billingActions = document.getElementById("billingActions");
      if (billingActions) billingActions.hidden = true;
      return data;
    }
    grid.hidden = false;
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
// Gera o código de vinculação (vale 10 min) e abre o WhatsApp oficial com
// "vincular <código>" pré-preenchido. Usado por Configurações e pela
// configuração inicial (onboarding).
function startWhatsappLink() {
  const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  state.whatsappLinkCode = code;
  state.whatsappLinkCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  saveState();
  renderWhatsAppSettings();

  const prefilledText = encodeURIComponent(`vincular ${code}`);
  const waLink = `https://wa.me/${WHATSAPP_BOT_NUMBER_DIGITS}?text=${prefilledText}`;
  window.open(waLink, "_blank", "noopener,noreferrer");

  showToast("Abrindo o WhatsApp — é só apertar enviar! 🚀");
}

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
  // Mantém o atalho visível para a conta proprietária mesmo se a consulta
  // transitória falhar. A página /admin ainda valida a autorização no servidor.
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
    if (card) card.hidden = !(allowed || isPrimaryOwner); renderSettingsBoard();
    if (dropdownEntry) dropdownEntry.hidden = !(allowed || isPrimaryOwner);
  } catch {
    if (card) card.hidden = !isPrimaryOwner; renderSettingsBoard();
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
    startWhatsappLink();
  });

  // ── WhatsApp: opt-in de lembretes (tarefas/eventos/metas/orçamento
  //    também por WhatsApp, além do push) ──────────────────────────
  document.getElementById("whatsappReminderOptIn")?.addEventListener("change", (e) => {
    state.whatsappReminderOptIn = e.target.checked;
    saveState();
    showToast(e.target.checked ? "🔔 Lembretes por WhatsApp ativados!" : "Lembretes por WhatsApp desativados.");
  });

  document.getElementById("pulsinhoAiPreference")?.addEventListener("change", (event) => {
    state.aiProviderPreference = ["openai", "anthropic"].includes(event.target.value) ? event.target.value : "auto";
    saveState();
    showToast("Preferência do Pulsinho atualizada.");
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
        renderWhatsAppSettings();
        return;
      }
    }
    state.appReminderOptIn = e.target.checked;
    saveState();
    renderWhatsAppSettings();
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

    accountDeletionRequested = true;
    let whatsappUnlinked = false;
    try {
      const providers = new Set((account.providerData || []).map((provider) => provider?.providerId));
      if (providers.has(GoogleAuthProvider.PROVIDER_ID)) {
        await reauthenticateWithPopup(account, new GoogleAuthProvider());
      } else if (providers.has(EmailAuthProvider.PROVIDER_ID)) {
        const pw = prompt("Por segurança, digite sua senha atual para confirmar a exclusão:");
        if (!pw) return;
        const credential = EmailAuthProvider.credential(account.email, pw);
        await reauthenticateWithCredential(account, credential);
      } else {
        const providerError = new Error("Não foi possível identificar o método de acesso desta conta.");
        providerError.code = "auth/provider-not-supported";
        throw providerError;
      }

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

      // Remove métricas operacionais protegidas pelo Admin SDK. Elas não
      // podem ser apagadas diretamente pelo navegador por design.
      const cleanupResponse = await fetch("/api/account-delete-cleanup", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!cleanupResponse.ok) {
        const cleanupError = new Error("Não foi possível remover os dados operacionais. Sua conta foi mantida; tente novamente mais tarde.");
        cleanupError.code = "data/cleanup-failed";
        throw cleanupError;
      }

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
        localStorage.removeItem(`pulsenote-pulsinho-thread:${account.uid}`);
      } catch { /* a conta já foi removida; a navegação prossegue */ }
      window.location.replace("/login");
    } catch (err) {
      const messages = {
        "auth/wrong-password":        "Senha incorreta.",
        "auth/invalid-credential":    "Senha incorreta.",
        "auth/popup-closed-by-user": "A confirmação com o Google foi cancelada.",
        "auth/provider-not-supported": "Este método de acesso não permite confirmar a exclusão. Entre novamente e tente de novo.",
        "auth/requires-recent-login": "Por segurança, saia e entre na conta novamente antes de excluí-la.",
        "data/unlink-failed":       "Não foi possível desvincular o WhatsApp. Sua conta foi mantida; tente novamente mais tarde.",
        "data/cleanup-failed":      "Não foi possível remover os dados operacionais agora. Sua conta foi mantida; tente novamente mais tarde.",
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
  const initial = bdInitials(getUser()?.name || "U");
  const content = photoURL
    ? `<img src="${escapeHtml(photoURL)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" alt=""/>`
    : initial;
  const contentNoRadius = photoURL
    ? `<img src="${escapeHtml(photoURL)}" style="width:100%;height:100%;object-fit:cover" alt=""/>`
    : initial;

  // Botão principal no topbar
  const mainBtn = document.querySelector(".user-avatar-btn");
  if (mainBtn) mainBtn.innerHTML = content;
  renderShellUser(getUser());

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
  if (!parsed.creditCards) parsed.creditCards = [];
  if (!parsed.scheduledFinances) parsed.scheduledFinances = [];
  if (!Array.isArray(parsed.savingsGoals)) parsed.savingsGoals = [];
  if (!Array.isArray(parsed.finRules)) parsed.finRules = [];
  if (!Array.isArray(parsed.finActivity)) parsed.finActivity = [];
  if (!parsed.financialSettings || typeof parsed.financialSettings !== "object") parsed.financialSettings = { safetyReserve: 0 };
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
  if (parsed.appReminderOptIn === undefined) {
    parsed.appReminderOptIn = parsed.fcmTokens.length > 0;
  }
  if (!["auto", "openai", "anthropic"].includes(parsed.aiProviderPreference)) parsed.aiProviderPreference = "auto";
  if (typeof parsed.aiReadNotes !== "boolean") parsed.aiReadNotes = true;
  // Preferências de aviso (4 categorias) e configuração inicial. Contas antigas
  // não têm esses campos: avisos ficam todos ligados (como sempre foi) e quem
  // já tem dados nunca vê a configuração inicial.
  parsed.notificationPrefs = normalizeNotificationPrefs(parsed.notificationPrefs);
  if (!["personal", "couple", "family", "business"].includes(parsed.preferredWorkspace)) parsed.preferredWorkspace = "personal";
  if (typeof parsed.onboardingDone !== "boolean") parsed.onboardingDone = hasUserData(parsed);
  // Retrocompatibilidade: lançamentos, tarefas e metas antigos não tinham
  // esses campos — garantimos que existam pra não quebrar o restante do app.
  parsed.tasks.forEach((t) => {
    if (!t.subtasks) t.subtasks = [];
    if (t.recurrence === undefined) t.recurrence = null;
    if (t.dueTime === undefined) t.dueTime = "";
    t.reminder = normalizeReminderValue(t.reminder);
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
    creditCards: [],
    scheduledFinances: [],
    savingsGoals: [],
    finRules: [],
    finActivity: [],
    financeAccounts: [],
    financialSettings: { safetyReserve: 0 },
    timeZone: appTimeZone,
    whatsappLinkCode: null,
    whatsappLinkCodeExpiresAt: null,
    whatsappLinkedPhone: null,
    fcmTokens: [],
    whatsappReminderOptIn: false,
    appReminderOptIn: false,
    aiProviderPreference: "auto",
    // Configuração inicial (ver onboarding.js): contas novas começam em falso;
    // contas antigas com dados são marcadas como concluídas em normalizeState.
    onboardingDone: false,
    preferredWorkspace: "personal",
    notificationPrefs: defaultNotificationPrefs(),
  };
}

function createDesignPreviewState(mode = "1") {
  const monthKey = todayIso.slice(0, 7);
  const day = Number(todayIso.slice(8, 10));
  const dateForDay = (value) => `${monthKey}-${String(Math.max(1, Math.min(28, value))).padStart(2, "0")}`;
  const prevKey = getPreviousMonthKey(monthKey);
  const prevPrevKey = getPreviousMonthKey(prevKey);
  const dayOf = (key, value) => `${key}-${String(value).padStart(2, "0")}`;
  const monthsBack = (n) => { const [yy, mm] = monthKey.split("-").map(Number); return toLocalIso(new Date(yy, mm - 1 - n, 1)).slice(0, 7); };
  const preview = normalizeState({
    ...loadDefaultState(),
    onboardingDone: true, // a configuração inicial só aparece no QA com ?onboarding=
    tasks: [
      { id: "preview-task-1", title: "Revisar relatório mensal", status: "Pendente", priority: "Alta", dueDate: todayIso, dueTime: "12:00", subtasks: [], recurrence: null },
      { id: "preview-task-2", title: "Responder e-mails prioritários", status: "Concluida", priority: "Baixa", dueDate: todayIso, completedAt: todayIso, subtasks: [], recurrence: null },
      { id: "preview-task-3", title: "Ajustar apresentação de resultados", status: "Pendente", priority: "Media", dueDate: todayIso, dueTime: "18:00", subtasks: [], recurrence: null },
      { id: "preview-task-4", title: "Planejar metas de fevereiro", status: "Pendente", priority: "Alta", dueDate: offsetDate(1), subtasks: [], recurrence: null },
      { id: "preview-task-5", title: "Organizar despesas do mês", status: "Pendente", priority: "Media", dueDate: offsetDate(3), subtasks: [], recurrence: null },
      { id: "preview-task-6", title: "Atualizar controle de gastos", status: "Pendente", priority: "Alta", dueDate: offsetDate(-1), subtasks: [], recurrence: null },
      { id: "preview-task-7", title: "Enviar notas fiscais ao financeiro", status: "Pendente", priority: "Media", dueDate: offsetDate(-1), subtasks: [], recurrence: null },
    ],
    events: [
      { id: "preview-event-1", title: "Reunião de alinhamento", date: todayIso, time: "10:00", endTime: "11:00", location: "", notes: "", reminder: 30 },
      { id: "preview-event-2", title: "Almoço com o time", date: todayIso, time: "13:00", endTime: "14:00", location: "", notes: "", reminder: 30 },
      { id: "preview-event-3", title: "Revisão do relatório", date: todayIso, time: "15:00", endTime: "16:00", location: "", notes: "", reminder: 15 },
    ],
    notes: [
      { id: "preview-note-1", title: "Planejamento do trimestre", description: "Definir metas, revisar projetos e alinhar próximos passos.", descriptionHtml: 'Definir metas, revisar projetos e <span style="background-color: rgb(253, 224, 71);">alinhar próximos passos.</span>', category: "Trabalho", folder: "Trabalho", tags: [], priority: "Alta", color: "purple", favorite: true, createdAt: todayIso, updatedAt: `${todayIso}T09:20:00`, attachments: [], goal: "", observations: "",
        checklist: [
          { id: "pn1-1", text: "Revisar metas do trimestre", done: true },
          { id: "pn1-2", text: "Atualizar cronograma dos projetos", done: true },
          { id: "pn1-3", text: "Alinhar com o time", done: true },
          { id: "pn1-4", text: "Definir indicadores (KPIs)", done: false },
          { id: "pn1-5", text: "Agendar reunião de acompanhamento", done: false },
        ] },
      { id: "preview-note-2", title: "Reunião de produto", description: "Pontos discutidos, decisões e próximos itens.", descriptionHtml: 'Pontos discutidos, decisões e <span style="background-color: rgb(253, 224, 71);">próximos itens.</span>', category: "Trabalho", folder: "Trabalho", tags: [], priority: "Media", color: "pink", favorite: false, createdAt: offsetDate(-1), updatedAt: `${offsetDate(-1)}T17:42:00`, attachments: [], goal: "", observations: "",
        checklist: [{ id: "pn2-1", text: "Enviar resumo", done: false }, { id: "pn2-2", text: "Atualizar roadmap", done: false }, { id: "pn2-3", text: "Marcar retrospectiva", done: false }] },
      { id: "preview-note-3", title: "Ideias de melhorias", description: "Otimizar o onboarding, revisar métricas e testar novos fluxos.", category: "Trabalho", folder: "Trabalho", tags: [], priority: "Media", color: "green", favorite: false, createdAt: offsetDate(-2), attachments: [], goal: "", observations: "",
        checklist: [{ id: "pn3-1", text: "Mapear atritos", done: true }, { id: "pn3-2", text: "Rever métricas", done: true }, { id: "pn3-3", text: "Prototipar fluxo", done: false }, { id: "pn3-4", text: "Testar com usuários", done: false }] },
      { id: "preview-note-4", title: "Estudos – IA", description: "Anotações do curso, links úteis e conceitos principais.", descriptionHtml: 'Anotações do curso, links úteis e <span style="background-color: rgb(253, 224, 71);">conceitos principais.</span>', category: "Estudos", folder: "Estudos", tags: [], priority: "Media", color: "blue", favorite: false, createdAt: offsetDate(-3), attachments: [], goal: "", observations: "",
        checklist: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `pn4-${n}`, text: `Módulo ${n}`, done: n <= 4 })) },
      { id: "preview-note-5", title: "Leituras da semana", description: "Resumo dos principais insights e aplicações práticas.", category: "Pessoal", folder: "Pessoal", tags: [], priority: "Baixa", color: "purple", favorite: false, createdAt: offsetDate(-4), attachments: [], goal: "", observations: "",
        checklist: [{ id: "pn5-1", text: "Capítulo 3", done: false }, { id: "pn5-2", text: "Artigo sobre hábitos", done: false }] },
      { id: "preview-note-6", title: "Finanças pessoais", description: "Revisar gastos do mês, ajustar metas e atualizar planilha.", descriptionHtml: 'Revisar gastos do mês, <span style="background-color: rgb(253, 224, 71);">ajustar metas</span> e atualizar planilha.', category: "Pessoal", folder: "Pessoal", tags: [], priority: "Media", color: "green", favorite: false, createdAt: offsetDate(-6), attachments: [], goal: "", observations: "",
        checklist: [{ id: "pn6-1", text: "Exportar extrato", done: true }, { id: "pn6-2", text: "Categorizar gastos", done: true }, { id: "pn6-3", text: "Atualizar planilha", done: true }] },
    ],
    goals: [{ id: "preview-goal-1", title: "Concluir o relatório mensal e planejar fevereiro.", current: 72, target: 100, milestones: [
      { id: "ms-1", title: "Coletar dados", done: true },
      { id: "ms-2", title: "Analisar resultados", done: true },
      { id: "ms-3", title: "Redigir relatório", done: true },
      { id: "ms-4", title: "Revisar com o time", done: true },
      { id: "ms-5", title: "Finalizar e enviar", done: false },
    ] }],
    finances: [
      // Mês atual: receitas 8.500, gastos 3.280
      { id: "preview-fin-1", type: "receita", amount: 8500, category: "salario", description: "Salário", date: dateForDay(22), accountId: "preview-acc-itau" },
      { id: "preview-fin-2", type: "despesa", amount: 1345, category: "moradia", description: "Condomínio e taxas", date: dateForDay(5) },
      { id: "preview-fin-3", type: "despesa", amount: 420.9, category: "alimentacao", description: "Supermercado", date: dateForDay(Math.min(day, 23)), accountId: "preview-acc-nubank" },
      { id: "preview-fin-4", type: "despesa", amount: 32, category: "alimentacao", description: "Almoço no restaurante", date: dateForDay(Math.min(day, 24)), accountId: "preview-acc-nubank" },
      { id: "preview-fin-5", type: "despesa", amount: 203.1, category: "alimentacao", description: "Feira e padaria", date: dateForDay(12) },
      { id: "preview-fin-6", type: "despesa", amount: 459, category: "transporte", description: "Combustível e transporte", date: dateForDay(10) },
      { id: "preview-fin-7", type: "despesa", amount: 328, category: "saude", description: "Farmácia e consultas", date: dateForDay(15) },
      { id: "preview-fin-8", type: "despesa", amount: 149.9, category: "assinaturas", description: "Provedor de internet", date: dateForDay(20), accountId: "preview-acc-itau" },
      { id: "preview-fin-9", type: "despesa", amount: 112.1, category: "assinaturas", description: "Streaming e apps", date: dateForDay(8) },
      { id: "preview-fin-10", type: "despesa", amount: 230, category: "outros", description: "Compras diversas", date: dateForDay(18) },
      // Mês anterior (base da comparação "vs. mês anterior")
      { id: "preview-fin-11", type: "despesa", amount: 2733, category: "moradia", description: "Despesas fixas do mês", date: dayOf(prevKey, 3) },
      { id: "preview-fin-12", type: "receita", amount: 8500, category: "salario", description: "Salário", date: dayOf(prevKey, 5) },
      { id: "preview-fin-13", type: "despesa", amount: 4537, category: "viagem", description: "Viagem de fim de ano", date: dayOf(prevKey, 25) },
      { id: "preview-hist-0-r", type: "receita", amount: 8200, category: "salario", description: "Salário", date: dayOf(monthsBack(5), 5), accountId: "preview-acc-itau" },
      { id: "preview-hist-0-d", type: "despesa", amount: 4300, category: "moradia", description: "Despesas do mês", date: dayOf(monthsBack(5), 12), accountId: "preview-acc-itau" },
      { id: "preview-hist-1-r", type: "receita", amount: 8400, category: "salario", description: "Salário", date: dayOf(monthsBack(4), 5), accountId: "preview-acc-itau" },
      { id: "preview-hist-1-d", type: "despesa", amount: 5200, category: "moradia", description: "Despesas do mês", date: dayOf(monthsBack(4), 12), accountId: "preview-acc-itau" },
      { id: "preview-hist-2-r", type: "receita", amount: 8300, category: "salario", description: "Salário", date: dayOf(monthsBack(3), 5), accountId: "preview-acc-itau" },
      { id: "preview-hist-2-d", type: "despesa", amount: 4600, category: "moradia", description: "Despesas do mês", date: dayOf(monthsBack(3), 12), accountId: "preview-acc-itau" },
      { id: "preview-hist-3-r", type: "receita", amount: 8600, category: "salario", description: "Salário", date: dayOf(monthsBack(2), 5), accountId: "preview-acc-itau" },
      { id: "preview-hist-3-d", type: "despesa", amount: 3900, category: "moradia", description: "Despesas do mês", date: dayOf(monthsBack(2), 12), accountId: "preview-acc-itau" },
      // Gastos que se repetem e viram "Sugestões inteligentes" na Automação
      ...[4, 3, 2].flatMap((n) => [
        { id: `preview-sug-stream-${n}`, type: "despesa", amount: 39.9, category: "assinaturas", description: "Assinatura de streaming", date: dayOf(monthsBack(n), 9) },
        { id: `preview-sug-phone-${n}`, type: "despesa", amount: 89.9, category: "contas", description: "Plano de celular", date: dayOf(monthsBack(n), 14) },
        { id: `preview-sug-soft-${n}`, type: "despesa", amount: 59.9, category: "assinaturas", description: "Assinatura de software", date: dayOf(monthsBack(n), 17) },
      ]),
    ],
    monthClosures: [
      { id: "preview-close-1", monthKey: prevPrevKey, workspaceId: "personal", receitas: 0, despesas: 0, saldo: 6000 },
      { id: "preview-close-2", monthKey: prevKey, workspaceId: "personal", receitas: 8500, despesas: 7270, saldo: 7230 },
    ],
    financeAccounts: [
      { id: "preview-acc-itau", name: "Conta Corrente", institution: "Itaú", type: "checking", workspaceId: "personal", balance: 4820 },
      { id: "preview-acc-nubank", name: "Conta Digital", institution: "Nubank", type: "checking", workspaceId: "personal", balance: 1250 },
      { id: "preview-acc-xp", name: "Investimentos", institution: "XP", type: "investment", workspaceId: "personal", balance: 12400 },
    ],
    // Limites por categoria (somam R$ 4.500 — a "meta" do card Gastos do mês)
    finGoals: [
      { id: "preview-goal-moradia", categoryId: "moradia", limit: 1900, workspaceId: "personal" },
      { id: "preview-goal-alimentacao", categoryId: "alimentacao", limit: 1000, workspaceId: "personal" },
      { id: "preview-goal-transporte", categoryId: "transporte", limit: 600, workspaceId: "personal" },
      { id: "preview-goal-saude", categoryId: "saude", limit: 400, workspaceId: "personal" },
      { id: "preview-goal-assinaturas", categoryId: "assinaturas", limit: 280, workspaceId: "personal" },
      { id: "preview-goal-outros", categoryId: "outros", limit: 320, workspaceId: "personal" },
    ],
    savingsGoals: [
      { id: "preview-save-trip", name: "Viagem de férias", target: 6000, saved: 3200, icon: "plane", workspaceId: "personal" },
      { id: "preview-save-emergency", name: "Reserva de emergência", target: 15000, saved: 12000, icon: "piggy", workspaceId: "personal" },
    ],
    creditCards: [
      { id: "preview-card-nubank", name: "Nubank", last4: "1234", limit: 5000, closingDay: 26, dueDay: 3, workspaceId: "personal", archived: false,
        invoices: [{ id: "preview-inv-nubank", dueDate: dayOf(monthsBack(-1), 3), amount: 420.9, status: "open", purchases: [] }] },
      { id: "preview-card-visa", name: "Visa", last4: "5678", limit: 8000, closingDay: 2, dueDay: 10, workspaceId: "personal", archived: false,
        invoices: [{ id: "preview-inv-visa", dueDate: dayOf(monthsBack(-1), 10), amount: 1600, status: "open", purchases: [] }] },
    ],
    scheduledFinances: [
      { id: "preview-sched-condo", description: "Condomínio", amount: 420.9, type: "despesa", categoryId: "moradia", date: dayOf(monthsBack(-1), 15), status: "scheduled", workspaceId: "personal" },
    ],
    finRules: [
      { id: "preview-rule-rent", name: "Aluguel sempre em Moradia", match: "aluguel", type: "despesa", categoryId: "moradia", active: true, hits: 3, workspaceId: "personal" },
      { id: "preview-rule-salary", name: "Se receber saldo via PIX “Salário”, classificar como receita", match: "salário", type: "receita", categoryId: "salario", active: true, hits: 1, workspaceId: "personal" },
    ],
    finActivity: [
      { id: "preview-log-1", at: new Date(`${todayIso}T09:41:00`).toISOString(), kind: "entry", text: "Lançamento via WhatsApp: R$ 49,90", workspaceId: "personal" },
      { id: "preview-log-2", at: new Date(`${todayIso}T08:20:00`).toISOString(), kind: "rule", text: "Regra executada: Aluguel (R$ 1.600,00)", workspaceId: "personal" },
      { id: "preview-log-3", at: new Date(`${offsetDate(-1)}T17:36:00`).toISOString(), kind: "suggestion", text: "Sugestão gerada: Plano de celular", workspaceId: "personal" },
      { id: "preview-log-4", at: new Date(`${offsetDate(-1)}T14:02:00`).toISOString(), kind: "closure", text: `Fechamento mensal concluído (${BD_MONTHS[Number(prevKey.slice(5, 7)) - 1]}/${prevKey.slice(0, 4)})`, workspaceId: "personal" },
    ],
    financialSettings: { safetyReserve: 0, autoCloseMonth: true },
    whatsappLinkedPhone: "5511987654321",
    finRecurrents: [
      { id: "preview-rec-1", description: "Aluguel", amount: 1600, type: "despesa", categoryId: "moradia", day: Math.min(31, day + 1), skippedMonths: [] },
      { id: "preview-rec-2", description: "Fatura do cartão", amount: 1240, type: "despesa", categoryId: "outros", day: Math.min(31, day + 5), skippedMonths: [] },
      { id: "preview-rec-3", description: "Internet", amount: 149.9, type: "despesa", categoryId: "assinaturas", day: Math.min(31, day + 7), skippedMonths: [] },
      { id: "preview-rec-4", description: "Academia", amount: 129.9, type: "despesa", categoryId: "saude", day: Math.min(31, day + 3), skippedMonths: [] },
      { id: "preview-rec-5", description: "Salário", amount: 8500, type: "receita", categoryId: "salario", day: 22, skippedMonths: [] },
    ],
  });
  if (mode === "1") {
    // Conversa de exemplo do Pulsinho (somente no modo demonstração local).
    pulsinhoConversation.push(
      { role: "user", content: "Analise meus gastos deste mês e crie uma tarefa para revisar as assinaturas, pois acho que posso economizar." },
      { role: "assistant", content: "Analisei seus gastos e identifiquei R$ 490,00 em assinaturas mensais (14% do total). Posso criar uma tarefa no seu Planner para você revisar essas assinaturas e avaliar cancelamentos?" },
    );
    pendingPulsinhoAction = {
      type: "create_task",
      label: "Criar tarefa",
      summary: "Criar tarefa no Planner",
      payload: { title: "Revisar assinaturas e avaliar cancelamentos", date: offsetDate(2), reminder: "Às 10:00" },
      requiresConfirmation: true,
    };
  }
  if (mode !== "worst") return preview;
  preview.tasks.unshift({
    id: "preview-task-worst",
    title: "Revisar a proposta comercial internacional com condições de pagamento, responsabilidades e observações da equipe multidisciplinar",
    status: "Pendente",
    priority: "Urgente",
    dueDate: todayIso,
    time: "23:59",
    subtasks: [],
    recurrence: null,
  });
  preview.events.unshift({
    id: "preview-event-worst",
    title: "Reunião extraordinária de planejamento financeiro familiar e revisão do orçamento anual",
    date: todayIso,
    time: "08:00",
    location: "Centro Empresarial Antônio Carlos Jobim — Torre Internacional, sala 1284",
    notes: "",
    reminderMinutes: 1440,
  });
  preview.goals.unshift({ id: "preview-goal-worst", title: "Concluir a reserva de emergência da família antes da mudança internacional", current: 999999, target: 1000000, milestones: [] });
  preview.finances.unshift({ id: "preview-fin-worst", type: "despesa", amount: 999999.99, category: "outros", description: "Transferência internacional extraordinária", date: todayIso });
  return normalizeState(preview);
}

function mountDesignPreviewToggle() {
  if (!isLocalDesignPreview || document.querySelector(".design-preview-toggle")) return;
  const toggle = document.createElement("nav");
  toggle.className = "design-preview-toggle";
  toggle.setAttribute("aria-label", "Dados de teste do layout");
  toggle.innerHTML = `<a href="?designPreview=1" class="${designPreviewMode === "1" ? "active" : ""}">Demo</a><a href="?designPreview=worst" class="${designPreviewMode === "worst" ? "active" : ""}">Pior caso</a>`;
  document.body.appendChild(toggle);
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
    if (isSharedFinanceWorkspace(activeWorkspaceId)) scheduleSharedSpaceSync(activeWorkspaceId);
  }
}


// Lembrete de tarefa/compromisso: minutos de antecedência ou "none".
// "Sem lembrete" é a opção padrão dos formulários; antes ela virava NaN
// (Number("none")), que ao recarregar era trocado por 15 min — e o aviso
// chegava mesmo sem ninguém ter pedido. Agora "none" é guardado como está
// e o servidor (api/send-reminders.js) já ignora esse valor.
function normalizeReminderValue(value, fallback = 15) {
  // NaN/null vêm de tarefas salvas com "Sem lembrete" antes da correção.
  if (value === "none" || value === false || value === null || (typeof value === "number" && Number.isNaN(value))) return "none";
  if (value === undefined || value === "") return fallback;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? Math.min(10080, Math.round(minutes)) : fallback;
}

function readReminderChoice(selectSelector, customSelector) {
  const selected = document.querySelector(selectSelector)?.value || "none";
  if (selected === "none") return "none";
  if (selected === "custom") {
    const custom = Number(document.querySelector(customSelector)?.value);
    return Math.min(10080, Math.max(1, Number.isFinite(custom) && custom > 0 ? Math.round(custom) : 15));
  }
  return normalizeReminderValue(selected);
}

function setReminderChoice(selectSelector, customSelector, wrapSelector, value) {
  const reminder = normalizeReminderValue(value);
  const preset = reminder === "none" || [0, 5, 15, 30, 60, 1440].includes(reminder);
  document.querySelector(selectSelector).value = preset ? String(reminder) : "custom";
  document.querySelector(customSelector).value = preset ? "" : reminder;
  document.querySelector(wrapSelector).hidden = preset;
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
  // Barra inferior e lateral trocam de área no instante do toque (como em
  // apps nativos) em vez de esperar o dedo sair (~100ms a menos). O clique
  // que vem logo depois é ignorado; teclado e leitores de tela continuam
  // pelo clique normal.
  let navArmedAt = 0;
  document.querySelectorAll(".bd-tabbar [data-view], .bd-sidebar [data-nav][data-view]").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.pointerType === "pen") return;
      navArmedAt = performance.now();
      if (button.dataset.view !== activeView) setView(button.dataset.view);
    });
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (performance.now() - navArmedAt < 900 && button.closest(".bd-tabbar, .bd-sidebar")) return;
      setView(button.dataset.view);
    });
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
      // "Seus compromissos de hoje" → a lente Dia, já em hoje (é o mesmo recorte).
      if (plannerFocus === "agenda") { plannerDayDate = todayIso; setPlannerTab("day"); }
      const target = plannerFocus === "goals"
        ? document.querySelector(".planner-goals-panel")
        : document.querySelector("#plannerView");
      requestAnimationFrame(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }));
    });
  });
}

function bindPremiumDashboard() {
  bindBoardsShell();
  document.querySelector(".bd-ws")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-workspace]");
    if (button) setActiveFinanceWorkspace(button.dataset.workspace);
  });
  document.querySelector("#finWorkspaceSelect")?.addEventListener("change", (event) => setActiveFinanceWorkspace(event.target.value));

  const commandForm = document.querySelector("#pulseCommandForm");
  const commandInput = document.querySelector("#pulseCommandInput");
  commandForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const command = commandInput?.value.trim() || "";
    if (!command) {
      commandInput?.focus();
      return;
    }
    await askPulsinhoFromDashboard(command);
  });

  document.querySelector("#pulseOpenSimulator")?.addEventListener("click", openFinanceSimulator);
  const forecastVisual = document.querySelector(".pulse-forecast-visual");
  forecastVisual?.addEventListener("click", openDashboardForecastDetail);
  forecastVisual?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openDashboardForecastDetail();
  });
  document.querySelector("#pulseForecastDetailClose")?.addEventListener("click", closeDashboardForecastDetail);
  document.querySelector("#pulseForecastDetailModal")?.addEventListener("click", (event) => {
    if (event.target.id === "pulseForecastDetailModal") closeDashboardForecastDetail();
  });
  document.querySelector("#pulseForecastDetailModal [data-view-shortcut='finances']")?.addEventListener("click", closeDashboardForecastDetail);
  document.querySelector("#pulseForecastDetailModal")?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDashboardForecastDetail();
  });
  document.querySelector("#finSimulatorForm")?.addEventListener("submit", runFinanceSimulation);
  document.querySelector("#finAddAccount")?.addEventListener("click", () => toggleFinanceAccountForm(true));
  document.querySelector("#finAccountCancel")?.addEventListener("click", () => toggleFinanceAccountForm(false));
  document.querySelector("#finAccountForm")?.addEventListener("submit", saveFinanceAccount);
  document.querySelector("#finAddCard")?.addEventListener("click", () => toggleCreditCardForm(true));
  document.querySelector("#finCardCancel")?.addEventListener("click", () => toggleCreditCardForm(false));
  document.querySelector("#finCardForm")?.addEventListener("submit", saveCreditCard);
  document.querySelector("#finCloseCardPurchase")?.addEventListener("click", closeCreditCardPurchase);
  document.querySelector("#finCardPurchaseModal")?.addEventListener("click", (event) => {
    if (event.target.id === "finCardPurchaseModal") closeCreditCardPurchase();
  });
  document.querySelector("#finCardPurchaseForm")?.addEventListener("submit", saveCreditCardPurchase);
  document.querySelector("#finCreateSpaceToggle")?.addEventListener("click", () => {
    const form = document.querySelector("#finCreateSpaceForm");
    if (form) form.hidden = false;
    document.querySelector("#finSharedSpaceName")?.focus();
  });
  document.querySelector("#finCreateSpaceCancel")?.addEventListener("click", () => {
    const form = document.querySelector("#finCreateSpaceForm");
    if (form) form.hidden = true;
  });
  document.querySelector("#finCreateSpaceForm")?.addEventListener("submit", createFinanceSpace);
  document.querySelector("#finSharedSpacesList")?.addEventListener("submit", inviteToFinanceSpace);
  document.querySelector("#finSharedSpacesList")?.addEventListener("click", handleSharedSpaceAction);
  document.querySelector("#finSharedInvites")?.addEventListener("click", handleSharedSpaceAction);

  const response = document.querySelector("#pulseCommandResponse");
  response?.addEventListener("click", (event) => {
    const followUp = event.target.closest("[data-pulsinho-followup]");
    if (followUp && commandInput) {
      commandInput.value = followUp.dataset.pulsinhoFollowup || "";
      commandInput.focus();
      commandForm?.requestSubmit();
      return;
    }
    const undo = event.target.closest("[data-pulsinho-undo]");
    if (undo) {
      undoPulsinhoAction(undo.dataset.pulsinhoUndo);
      return;
    }
    if (event.target.closest("[data-pulsinho-action-confirm]")) {
      if (pendingPulsinhoActions.length) confirmPulsinhoActions();
      else confirmPulsinhoAction();
      return;
    }
    if (event.target.closest("[data-pulsinho-action-cancel]")) {
      const hadActions = pendingPulsinhoActions.length || pendingPulsinhoAction;
      pendingPulsinhoAction = null;
      pendingPulsinhoActions = [];
      if (hadActions) pulsinhoConversation.push({ role: "assistant", content: "Tudo bem, cancelei. Nada foi alterado.", provider: "pulse-engine" });
      renderPulsinhoConversation();
    }
  });

  document.querySelector("#finCategories")?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-fin-category]");
    if (row) openFinanceCategory(row.dataset.finCategory);
  });
  document.querySelector("#finCategories")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-fin-category]");
    if (!row) return;
    event.preventDefault();
    openFinanceCategory(row.dataset.finCategory);
  });
  document.querySelector("#finChart6m")?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-fin-month]");
    if (target) goToFinMonth(target.dataset.finMonth);
  });
  document.querySelector("#finChart6m")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest("[data-fin-month]");
    if (!target) return;
    event.preventDefault();
    goToFinMonth(target.dataset.finMonth);
  });
}

// QA 18/11 (espaço compartilhado): depois de confirmar o e-mail, o token
// guardado ainda dizia email_verified=false por até 1 h e o servidor recusava
// a criação. Se o servidor responder "e-mail não verificado"/"não autorizado",
// renova o token uma vez e repete o pedido antes de desistir.
async function pulseApi(path, options = {}, { retried = false } = {}) {
  if (!currentUser) throw new Error("unauthorized");
  const token = await currentUser.getIdToken(retried);
  const response = await fetch(path, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && !retried && (payload.error === "verified_email_required" || response.status === 401)) {
    try { await currentUser.reload(); } catch { /* segue com o token renovado */ }
    return pulseApi(path, options, { retried: true });
  }
  if (!response.ok) throw Object.assign(new Error(payload.error || "request_failed"), { code: payload.error, status: response.status });
  return payload;
}

// Mensagens específicas para as falhas dos espaços compartilhados.
function financeSpaceErrorMessage(error, fallback) {
  const map = {
    verified_email_required: "Confirme seu e-mail para criar ou entrar em espaços compartilhados. Já confirmou? Saia e entre de novo.",
    unauthorized: "Sua sessão expirou. Entre de novo para continuar.",
    invalid_name: "Use um nome com pelo menos 2 caracteres.",
    invalid_invite: "Confira o e-mail do convite — ele não pode ser o seu próprio.",
    already_member: "Essa pessoa já faz parte do espaço.",
    member_limit: "Este espaço já tem o máximo de 12 membros.",
    owner_required: "Só quem administra o espaço pode convidar pessoas.",
    space_not_found: "Esse espaço não existe mais.",
    owner_cannot_leave: "Quem administra não pode sair do próprio espaço.",
    finance_spaces_unavailable: "O servidor não respondeu agora. Tente de novo em alguns segundos.",
  };
  if (!navigator.onLine) return "Você está sem internet. Conecte-se e tente de novo.";
  return map[error?.code] || fallback;
}

function bdConfirmRows(action) {
  const payload = action?.payload || {};
  const labels = [
    [["title", "titulo", "description", "descricao"], "Título"],
    [["date", "dueDate", "data"], "Data sugerida"],
    [["time", "hora", "dueTime"], "Horário"],
    [["reminder", "lembrete"], "Lembrete"],
    [["amount", "valor"], "Valor"],
    [["category", "categoria"], "Categoria"],
  ];
  const rows = [];
  for (const [keys, label] of labels) {
    const key = keys.find((k) => payload[k] !== undefined && payload[k] !== "");
    if (!key) continue;
    let value = payload[key];
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      const d = new Date(`${value}T12:00:00`);
      value = `${BD_WEEKDAYS[d.getDay()]}, ${String(d.getDate()).padStart(2, "0")} de ${BD_MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
    } else if (key === "amount" || key === "valor") {
      value = formatCurrency(Number(value) || 0);
    }
    if (label === "Título") {
      rows.push(`<span class="field-label">${label}</span><div class="field-box">${escapeHtml(String(value))}</div>`);
    } else {
      const icon = { "Data sugerida": "calendar", "Horário": "clock", "Lembrete": "bell-ring", "Valor": "wallet", "Categoria": "layers" }[label] || "info";
      rows.push(`<div class="row">${bdIcon(icon)}<span>${label}</span><b>${escapeHtml(String(value))}</b></div>`);
    }
  }
  return rows.join("");
}

// Memória da conversa do app: guardada neste aparelho (por conta), para
// continuar de onde parou depois de recarregar ou fechar o app. Guarda as
// últimas mensagens e envia ao Pulsinho as 20 mais recentes como contexto.
const PULSINHO_THREAD_LIMIT = 60;
function pulsinhoThreadKey() {
  return currentUser?.uid ? `pulsenote-pulsinho-thread:${currentUser.uid}` : "";
}

function restorePulsinhoConversation() {
  const key = pulsinhoThreadKey();
  if (!key || pulsinhoConversationRestored === key) return;
  pulsinhoConversationRestored = key;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(saved) || !saved.length || pulsinhoConversation.length) return;
    for (const message of saved.slice(-PULSINHO_THREAD_LIMIT)) {
      if (!["user", "assistant"].includes(message?.role) || typeof message.content !== "string") continue;
      pulsinhoConversation.push({
        role: message.role,
        content: message.content.slice(0, 4000),
        // Desfazer só vale na sessão em que a ação aconteceu.
        actions: Array.isArray(message.actions) ? message.actions.map((item) => ({ summary: String(item.summary || ""), undone: Boolean(item.undone) })) : [],
      });
    }
  } catch {
    // Armazenamento indisponível (modo privado): segue sem memória local.
  }
}

function persistPulsinhoConversation() {
  const key = pulsinhoThreadKey();
  if (!key) return;
  try {
    const slim = pulsinhoConversation.slice(-PULSINHO_THREAD_LIMIT).map(({ role, content, actions }) => ({
      role, content, actions: (actions || []).map(({ summary, undone }) => ({ summary, undone: Boolean(undone) })),
    }));
    if (slim.length) localStorage.setItem(key, JSON.stringify(slim));
    else localStorage.removeItem(key);
  } catch {
    // Sem espaço ou sem permissão: a conversa continua só na memória.
  }
}

// Defesa no app (o servidor já limpa): nenhum campo técnico do JSON da IA
// — followUps, navigationTarget, actions… — aparece no texto da conversa.
function pulsinhoCleanReply(text) {
  let out = String(text ?? "");
  const trimmed = out.trim();
  if (/^\{[\s\S]*"reply"\s*:/.test(trimmed)) {
    try { const parsed = JSON.parse(trimmed); if (typeof parsed?.reply === "string") out = parsed.reply; } catch { /* segue limpando */ }
  }
  out = out.replace(/(?:["']?\s*[,}]?\s*)?["']?\b(?:followUps|follow-ups|follow_ups|navigationTarget|navigation_target|actions|lookups|asks|provider)\b["']?\s*:\s*[[{"'nt0-9-][\s\S]*$/i, "");
  return out.replace(/["'}\]\s,]+$/u, (tail) => (/[}\]]/.test(tail) ? "" : tail)).replace(/\bremindes?\b/gi, "lembretes").trim() || String(text ?? "");
}

function renderPulsinhoConversation({ loading = false, error = "" } = {}) {
  const root = document.querySelector("#pulseCommandResponse");
  if (!root) return;
  restorePulsinhoConversation();
  if (!loading) persistPulsinhoConversation();
  root.classList.toggle("is-loading", loading);
  const hour = new Date().getHours();
  const hello = greetingForHour(hour);
  const introText = `${hello}, ${bdFirstName()}! Sou o Pulsinho. Pode falar comigo do seu jeito: registro gastos, crio tarefas e lembretes, marco compromissos, anoto ideias — ou a gente só conversa.`;
  // Primeira vez que o painel aparece: o Pulsinho acena, "digita" e a
  // saudação surge palavra por palavra. Depois disso, fica estática.
  if (pulsinhoIntroState === "pending" && pulsinhoConversation.length) pulsinhoIntroState = "done";
  const intro = pulsinhoIntroState === "pending"
    ? ""
    : pulsinhoIntroState === "typing"
      ? pulsinhoTypingHtml("Pulsinho está digitando", "bd-typing--intro")
      : pulsinhoIntroState === "reveal"
        ? `<div class="bd-msg bd-msg--ai bd-msg--intro is-revealing">${introText.split(" ").map((word, index) => `<span style="--w:${index}">${escapeHtml(word)} </span>`).join("")}</div>`
        : `<div class="bd-msg bd-msg--ai bd-msg--intro">${escapeHtml(introText)}</div>`;
  // Mensagens seguidas do mesmo lado formam um grupo (pouco espaço entre
  // elas, "bico" só na última). Só as mensagens novas entram animadas —
  // antes todas as bolhas "pulavam" de novo a cada resposta.
  const sideOf = (message) => (message?.role === "user" ? "user" : "ai");
  const introShown = pulsinhoIntroState === "reveal" || pulsinhoIntroState === "done";
  const freshFrom = pulsinhoRenderedCount;
  const messages = pulsinhoConversation.map((message, index) => {
    const followUps = message === pulsinhoConversation.at(-1) && Array.isArray(message.followUps) ? message.followUps : [];
    const followUpHtml = followUps.length
      ? `<div class="bd-followups">${followUps.map((item) => `<button type="button" data-pulsinho-followup="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")}</div>`
      : "";
    const side = sideOf(message);
    const prev = index ? pulsinhoConversation[index - 1] : introShown ? { role: "assistant" } : null;
    const next = pulsinhoConversation[index + 1] || (loading ? { role: "assistant" } : null);
    const classes = [
      `bd-msg bd-msg--${side}`,
      !prev || sideOf(prev) !== side ? "is-start" : "",
      !next || sideOf(next) !== side ? "is-end" : "",
      index >= freshFrom ? "is-new" : "",
    ].filter(Boolean).join(" ");
    const actionsHtml = Array.isArray(message.actions) && message.actions.length
      ? `<div class="bd-msg-actions">${message.actions.map((item) => `<div class="bd-msg-action${item.undone ? " is-undone" : ""}"><span>${escapeHtml(toastCleanText(item.summary) || item.summary)}</span>${item.undone ? "<em>Desfeito</em>" : item.undoKey ? `<button type="button" data-pulsinho-undo="${escapeHtml(item.undoKey)}">Desfazer</button>` : ""}</div>`).join("")}</div>`
      : "";
    const text = side === "ai" ? pulsinhoCleanReply(message.content) : message.content;
    return `<div class="${classes}">${escapeHtml(text)}${actionsHtml}${followUpHtml}</div>`;
  }).join("");
  pulsinhoRenderedCount = pulsinhoConversation.length;
  const multi = pendingPulsinhoActions.length
    ? `<section class="bd-confirm is-sheet" aria-label="Confirmação necessária">
        <div class="bd-confirm-head">
          <span class="ico${pendingPulsinhoActions.some((item) => String(item.type).startsWith("delete_")) ? " is-danger" : ""}">${bdIcon(pendingPulsinhoActions.some((item) => String(item.type).startsWith("delete_")) ? "trash" : "task-check")}</span>
          <div><strong>Confirmar?</strong><small>Nada muda sem a sua confirmação.</small></div>
          <button type="button" class="bd-icon-btn close" data-pulsinho-action-cancel aria-label="Fechar">${bdIcon("x")}</button>
        </div>
        <ul class="bd-confirm-list">${pendingPulsinhoActions.map((item) => `<li>${escapeHtml(item.summary || "")}</li>`).join("")}</ul>
        <div class="bd-confirm-actions">
          <button type="button" class="bd-btn" data-pulsinho-action-cancel>Cancelar</button>
          <button type="button" class="bd-btn bd-btn--primary" data-pulsinho-action-confirm>${bdIcon("check")}Confirmar</button>
        </div>
      </section>`
    : "";
  const action = multi || (pendingPulsinhoAction
    ? `<section class="bd-confirm is-sheet" aria-label="Confirmação necessária">
        <div class="bd-confirm-head">
          <span class="ico">${bdIcon("task-check")}</span>
          <div><strong>Confirmar ação?</strong><small>${escapeHtml(pendingPulsinhoAction.summary || pendingPulsinhoAction.label || "")}</small></div>
          <button type="button" class="bd-icon-btn close" data-pulsinho-action-cancel aria-label="Fechar">${bdIcon("x")}</button>
        </div>
        ${bdConfirmRows(pendingPulsinhoAction) ? `<div class="bd-confirm-rows">${bdConfirmRows(pendingPulsinhoAction)}</div>` : ""}
        <div class="bd-confirm-actions">
          <button type="button" class="bd-btn" data-pulsinho-action-cancel>Cancelar</button>
          <button type="button" class="bd-btn bd-btn--primary" data-pulsinho-action-confirm>${bdIcon("check")}${escapeHtml(pendingPulsinhoAction.label || "Confirmar")}</button>
        </div>
      </section>`
    : "");
  const loadingMessage = loading ? pulsinhoTypingHtml("Pulsinho está pensando") : "";
  const errorMessage = error ? `<div class="bd-chat-error">${escapeHtml(error)}</div>` : "";
  root.innerHTML = `${intro}${messages}${loadingMessage}${errorMessage}${action}`;
  document.querySelector("#bdChat")?.classList.toggle("is-thinking", loading);
  const status = document.querySelector("#bdChatStatus");
  if (status) status.textContent = loading ? "Pensando…" : "Online agora";
  root.scrollTop = root.scrollHeight;
  updatePulsinhoJump();
  updatePulsinhoSuggestions();
}

let pulsinhoIntroState = "pending";
let pulsinhoRenderedCount = Infinity; // primeira renderização: nada entra animado

// "Digitando…" do Pulsinho: o mesmo traço de batimento do mascote passa
// pela bolha, em vez dos três pontinhos genéricos.
function pulsinhoTypingHtml(label, extraClass = "") {
  return `<div class="bd-typing bd-typing--pulse ${extraClass}" role="status" aria-label="${escapeHtml(label)}"><svg viewBox="0 0 72 20" aria-hidden="true"><path class="bd-typing-base" d="M0 10 H22 L27 3 L33 17 L38 10 H72"/><path class="bd-typing-beat" pathLength="100" d="M0 10 H22 L27 3 L33 17 L38 10 H72"/></svg></div>`;
}

function playPulsinhoIntro() {
  if (pulsinhoIntroState !== "pending") return;
  const chat = document.querySelector("#bdChat");
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce || pulsinhoConversation.length) {
    pulsinhoIntroState = "done";
    renderPulsinhoConversation();
    return;
  }
  pulsinhoIntroState = "typing";
  chat?.classList.add("is-greeting");
  renderPulsinhoConversation();
  setTimeout(() => {
    if (pulsinhoIntroState !== "typing") return;
    pulsinhoIntroState = "reveal";
    renderPulsinhoConversation();
    setTimeout(() => {
      // Terminada a animação, a saudação vira texto normal (no iPhone,
      // uma palavra animada às vezes ficava presa meio apagada).
      if (pulsinhoIntroState === "reveal") {
        pulsinhoIntroState = "done";
        const root = document.querySelector("#pulseCommandResponse");
        const keepScroll = root ? root.scrollTop : 0;
        renderPulsinhoConversation();
        if (root && pulsinhoConversation.length) root.scrollTop = keepScroll;
      }
      chat?.classList.remove("is-greeting");
    }, 2200);
  }, 1050);
}

// Toca a apresentação quando o painel aparece na tela pela primeira vez
// (no celular ele fica mais abaixo no Início).
function watchPulsinhoIntro() {
  const chat = document.querySelector("#bdChat");
  if (!chat || chat.dataset.introWatch === "1") return;
  chat.dataset.introWatch = "1";
  if (!("IntersectionObserver" in window)) { playPulsinhoIntro(); return; }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    // No celular, no Início, só aparece o balão: a apresentação toca quando
    // a conversa abre de fato (ver openPulsinhoConvo).
    if (pulsinhoTeaserMode()) return;
    observer.disconnect();
    playPulsinhoIntro();
  }, { threshold: 0.35 });
  observer.observe(chat);
}

// ── Balão do Pulsinho (Início, celular) ─────────────────────────
// Em vez do cartão de conversa inteiro no meio do Início, o Pulsinho
// aparece como um balão com uma chamada dele, montada com os dados reais
// do dia (atrasadas, próximo compromisso, gastos). Tocar no balão abre a
// conversa em tela cheia; os atalhos embaixo já respondem por você.
const chatTeaserQuery = () => window.matchMedia?.("(max-width: 760px)").matches;
function pulsinhoTeaserMode() {
  const chat = document.querySelector("#bdChat");
  return Boolean(chat && chatTeaserQuery() && document.querySelector("#dashboardView")?.contains(chat));
}

let pulsinhoTeaserIndex = 0;
let pulsinhoTeaserTimer = 0;
let pulsinhoTeaserCallsCache = [];

function pulsinhoTeaserCalls() {
  const firstName = (getUser()?.name || "").trim().split(/\s+/)[0] || "";
  const hour = new Date().getHours();
  const hello = `${greetingForHour(hour)}${firstName ? `, ${firstName}` : ""}!`;
  const now = new Date();
  const nowHm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const { counts } = bdAgendaSnapshot();
  const nextEvent = state.events
    .filter((event) => event && event.date === todayIso && event.time && event.time >= nowHm)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))[0];
  const spentToday = bdWorkspaceFinances().some((entry) => entry.date === todayIso && entry.type === "despesa");
  const todayAsk = { label: "O que tenho hoje?", send: "O que tenho para hoje?" };
  const logSpend = { label: "Anotar gasto", prefill: "Gastei " };
  const calls = [];
  if (counts.overdue) {
    calls.push({
      text: `${counts.overdue === 1 ? "Uma tarefa ficou" : `${counts.overdue} tarefas ficaram`} para trás. Quer ver e reorganizar comigo?`,
      actions: [{ label: "Ver atrasadas", send: "Quais tarefas estão atrasadas?" }, todayAsk],
    });
  }
  if (nextEvent) {
    calls.push({
      text: `Seu próximo compromisso é “${nextEvent.title}” às ${nextEvent.time}.`,
      actions: [todayAsk, { label: "Criar lembrete", prefill: "Me lembra de " }],
    });
  } else if (counts.tasksTotal > counts.tasksDone) {
    const left = counts.tasksTotal - counts.tasksDone;
    calls.push({
      text: `${left === 1 ? "Falta 1 tarefa" : `Faltam ${left} tarefas`} para fechar o dia. Posso te ajudar a priorizar?`,
      actions: [todayAsk, { label: "Nova tarefa", prefill: "Criar tarefa " }],
    });
  }
  calls.push(spentToday
    ? { text: "Quer saber como estão seus gastos do mês até agora?", actions: [{ label: "Gastos do mês", send: "Como estão meus gastos este mês?" }, logSpend] }
    : { text: "Gastou algo hoje? Me conta do seu jeito que eu anoto.", actions: [logSpend, { label: "Gastos do mês", send: "Como estão meus gastos este mês?" }] });
  calls.push({ text: "Me peça um lembrete, uma tarefa ou um resumo do mês — é só falar.", actions: [{ label: "Criar lembrete", prefill: "Me lembra de " }, todayAsk] });
  calls[0] = { ...calls[0], text: `${hello} ${calls[0].text}` };
  return calls;
}

function paintPulsinhoTeaser(call, { animate = false } = {}) {
  const text = document.querySelector("#bdChatTeaserText");
  const actions = document.querySelector("#bdChatTeaserActions");
  if (!text || !actions || !call) return;
  const apply = () => {
    text.textContent = call.text;
    actions.innerHTML = call.actions.map((action, index) => `<button type="button" class="bd-teaser-chip" data-teaser-action="${index}">${escapeHtml(action.label)}</button>`).join("");
  };
  const bubble = document.querySelector("#bdChatTeaser .bd-teaser-bubble");
  if (!animate || prefersReducedMotion() || !bubble?.animate) { apply(); return; }
  const out = [bubble, actions].map((el) => el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px)" }], { duration: 160, easing: "ease-in", fill: "forwards" }));
  out[0].finished.then(() => {
    apply();
    out.forEach((animation) => animation.cancel());
    bubble.animate([{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.9,.3,1)" });
    actions.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 60, easing: "ease-out", fill: "backwards" });
  }, apply);
}

function renderPulsinhoTeaser({ keepIndex = true } = {}) {
  if (!document.querySelector("#bdChatTeaser")) return;
  pulsinhoTeaserCallsCache = pulsinhoTeaserCalls();
  if (!keepIndex || pulsinhoTeaserIndex >= pulsinhoTeaserCallsCache.length) pulsinhoTeaserIndex = 0;
  paintPulsinhoTeaser(pulsinhoTeaserCallsCache[pulsinhoTeaserIndex]);
  schedulePulsinhoTeaser();
}

function schedulePulsinhoTeaser() {
  clearTimeout(pulsinhoTeaserTimer);
  if (prefersReducedMotion() || pulsinhoTeaserCallsCache.length < 2) return;
  pulsinhoTeaserTimer = setTimeout(() => {
    const visible = pulsinhoTeaserMode() && activeView === "dashboard" && !document.hidden && !isPulsinhoConvo();
    if (visible) {
      pulsinhoTeaserIndex = (pulsinhoTeaserIndex + 1) % pulsinhoTeaserCallsCache.length;
      paintPulsinhoTeaser(pulsinhoTeaserCallsCache[pulsinhoTeaserIndex], { animate: true });
    }
    schedulePulsinhoTeaser();
  }, 7000);
}

function bindPulsinhoTeaser() {
  const teaser = document.querySelector("#bdChatTeaser");
  if (!teaser || teaser.dataset.bound === "1") return;
  teaser.dataset.bound = "1";
  document.querySelector("#bdChatTeaserOpen")?.addEventListener("click", () => openPulsinhoConvo());
  document.querySelector("#bdChatTeaserActions")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-teaser-action]");
    if (!chip) return;
    const action = pulsinhoTeaserCallsCache[pulsinhoTeaserIndex]?.actions?.[Number(chip.dataset.teaserAction)];
    if (!action) return;
    const input = document.querySelector("#pulseCommandInput");
    const form = document.querySelector("#pulseCommandForm");
    openPulsinhoConvo();
    if (!input) return;
    input.value = action.send || action.prefill || "";
    updatePulsinhoSuggestions();
    if (action.send && form) {
      // Espera a conversa terminar de abrir para a mensagem entrar animada.
      setTimeout(() => { if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true })); }, prefersReducedMotion() ? 0 : 260);
    } else {
      input.focus({ preventScroll: true });
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* sem seleção */ }
    }
  });
}

// ── Modo conversa do Pulsinho (celular) ────────────────────────
// No Início o Pulsinho é um cartão. Ao tocar para digitar, o MESMO cartão
// "levanta" da página (animação a partir de onde estava) e flutua sobre
// ela, com o fundo escurecido: cabeçalho no topo, mensagens no meio e o
// campo logo acima do teclado. Ele acompanha a área visível
// (visualViewport) — sem rolar a página por trás, que era o que deixava a
// conversa "toda lá embaixo" no iPhone. Com o teclado fechado ele ocupa a
// tela para ler a conversa; ⌄, toque fora ou Esc devolve ao Início.
const chatIsMobile = () => window.matchMedia?.("(max-width: 760px)").matches;
let chatConvoFrame = 0;
let pulsinhoConvoGuardUntil = 0;

// Áreas seguras do aparelho (notch e barra de gestos) em pixels.
function safeAreaInsets() {
  let probe = document.querySelector("#pnSafeProbe");
  if (!probe) {
    probe = document.createElement("div");
    probe.id = "pnSafeProbe";
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
    document.body.appendChild(probe);
  }
  const style = getComputedStyle(probe);
  return { top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0 };
}

function isPulsinhoConvo() {
  return Boolean(document.querySelector("#bdChat")?.classList.contains("is-convo"));
}

function layoutPulsinhoConvo() {
  cancelAnimationFrame(chatConvoFrame);
  chatConvoFrame = requestAnimationFrame(() => {
    const chat = document.querySelector("#bdChat");
    if (!chat?.classList.contains("is-convo")) return;
    const vv = window.visualViewport;
    const viewTop = vv ? vv.offsetTop : 0;
    const viewHeight = vv ? vv.height : window.innerHeight;
    const keyboard = window.innerHeight - viewHeight > 140 || (vv && screen.height - viewHeight > 250);
    const body = document.querySelector("#pulseCommandResponse");
    const nearEnd = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 200;
    const { top: safeTop, bottom: safeBottom } = safeAreaInsets();
    // Com o teclado aberto a conversa aproveita a altura toda; sem teclado
    // ela flutua deixando o Início (escurecido) à vista em cima — tocar ali
    // fecha, como uma folha.
    // Aberta a partir do balão do Início, a conversa ocupa a tela (como um
    // app de mensagens); o cartão antigo flutuava a 11% do topo.
    const top = viewTop + (keyboard ? Math.max(10, safeTop + 6) : chat.classList.contains("from-teaser") ? Math.max(10, safeTop + 8) : Math.max(safeTop + 10, Math.round(viewHeight * 0.11)));
    const bottomGap = keyboard ? 8 : Math.max(10, safeBottom + 6);
    chat.style.setProperty("--convo-top", `${Math.round(top)}px`);
    chat.style.setProperty("--convo-h", `${Math.round(Math.max(240, viewTop + viewHeight - bottomGap - top))}px`);
    chat.classList.toggle("has-keyboard", Boolean(keyboard));
    // Quem estava lendo o fim da conversa continua vendo a última mensagem
    // quando a altura muda (teclado abrindo/fechando).
    if (nearEnd) setTimeout(scrollPulsinhoToEnd, 230);
    const backdrop = document.querySelector("#bdChatBackdrop");
    if (backdrop) backdrop.style.top = `${Math.round(viewTop)}px`;
  });
}

function scrollPulsinhoToEnd() {
  const body = document.querySelector("#pulseCommandResponse");
  if (body) body.scrollTop = body.scrollHeight;
}

function updatePulsinhoSuggestions() {
  const box = document.querySelector("#bdChatSuggest");
  if (!box) return;
  const hasUserMessage = pulsinhoConversation.some((item) => item.role === "user");
  // No computador a conversa fica sempre aberta ao lado do Início: as
  // sugestões preenchem o espaço até a primeira mensagem da pessoa.
  const docked = window.matchMedia("(min-width: 761px)").matches;
  box.hidden = !(isPulsinhoConvo() || docked) || hasUserMessage || Boolean(document.querySelector("#pulseCommandInput")?.value.trim());
}

// Recorte (clip-path) que mostra só a área `rect` dentro do cartão `box`.
function pulsinhoClipFor(rect, box, radius = 20) {
  const t = Math.max(0, rect.top - box.top);
  const r = Math.max(0, box.right - rect.right);
  const b = Math.max(0, box.bottom - rect.bottom);
  const l = Math.max(0, rect.left - box.left);
  return `inset(${t.toFixed(1)}px ${r.toFixed(1)}px ${b.toFixed(1)}px ${l.toFixed(1)}px round ${radius}px)`;
}

let pulsinhoClosing = false;

function openPulsinhoConvo() {
  const chat = document.querySelector("#bdChat");
  if (!chat || pulsinhoClosing || isPulsinhoConvo() || !chatIsMobile() || !document.querySelector("#dashboardView")?.contains(chat)) return;
  const teaser = pulsinhoTeaserMode();
  const from = chat.getBoundingClientRect();
  // Onde está o Pulsinho do balão agora: ele "voa" daqui até o cabeçalho.
  const teaserMascot = teaser ? document.querySelector(".bd-teaser-mascot") : null;
  const mascotFrom = teaserMascot?.getBoundingClientRect() || null;
  if (mascotFrom) pulsinhoMascotOffset = { x: mascotFrom.left - from.left, y: mascotFrom.top - from.top, w: mascotFrom.width, h: mascotFrom.height };
  // Guarda o lugar do cartão na página (nada pula por baixo).
  const placeholder = document.createElement("div");
  placeholder.id = "bdChatPlaceholder";
  placeholder.className = `bd-chat-ph${teaser ? " is-teaser" : ""}`;
  placeholder.style.height = `${Math.round(from.height)}px`;
  chat.before(placeholder);
  let backdrop = document.querySelector("#bdChatBackdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "bdChatBackdrop";
    backdrop.className = "bd-chat-backdrop";
    // Ignora o "clique fantasma" do mesmo toque que abriu a conversa.
    backdrop.addEventListener("click", () => { if (Date.now() > pulsinhoConvoGuardUntil) closePulsinhoConvo(); });
    backdrop.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
    document.body.appendChild(backdrop);
  }
  backdrop.hidden = false;
  pulsinhoConvoGuardUntil = Date.now() + 450;
  chat.classList.toggle("from-teaser", teaser);
  chat.classList.add("is-convo");
  document.body.classList.add("bd-chat-convo");
  document.documentElement.classList.add("pn-scroll-locked");
  document.querySelector("#bdChatClose")?.removeAttribute("hidden");
  layoutPulsinhoConvo();
  if (pulsinhoIntroState === "pending") playPulsinhoIntro();
  const reduce = prefersReducedMotion();
  requestAnimationFrame(() => {
    const to = chat.getBoundingClientRect();
    if (!to.height || reduce || typeof chat.animate !== "function") return;
    if (!teaser) backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
    if (teaser) {
      // O balão "se abre" até virar a tela de conversa: o recorte começa
      // exatamente onde o balão estava e cresce até a tela inteira.
      chat.animate([
        { clipPath: pulsinhoClipFor(from, to, 22) },
        { clipPath: "inset(0px 0px 0px 0px round 22px)" },
      ], { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" });
      playPulsinhoOpenChoreography(chat, from, to, { backdrop, teaserMascot, mascotFrom });
      return;
    }
    // Cartão antigo (fora do modo balão): "levanta" de onde estava.
    chat.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, opacity: 0.6 },
      { transform: "none", opacity: 1 },
    ], { duration: 300, easing: "cubic-bezier(.2,.9,.3,1)" });
  });
  scrollPulsinhoToEnd();
  updatePulsinhoSuggestions();
}

// Abertura da conversa (celular) — transição de "elemento compartilhado":
// 1. o escurecido do fundo se espalha em círculo a partir do balão;
// 2. o Pulsinho do balão VOA em arco até o cabeçalho enquanto a tela cresce
//    em volta dele, pousa com um leve amassar e a linha de pulso se desenha;
// 3. nome e "Online agora" deslizam, mensagens entram em cascata do lado de
//    quem falou, a confirmação e o campo sobem e a borda do campo acende.
let pulsinhoMascotOffset = null;
function pulsinhoFlyMascot(source, fromRect, toRect, { duration = 620, delay = 0, back = false } = {}) {
  if (!source || !fromRect || !toRect || !fromRect.width || !toRect.width) return null;
  const clone = source.cloneNode(true);
  clone.classList.add("bd-mascot-fly");
  clone.setAttribute("aria-hidden", "true");
  Object.assign(clone.style, { left: `${fromRect.left}px`, top: `${fromRect.top}px`, width: `${fromRect.width}px`, height: `${fromRect.height}px`, "--s": `${fromRect.width}px` });
  document.body.appendChild(clone);
  const dx = toRect.left + toRect.width / 2 - (fromRect.left + fromRect.width / 2);
  const dy = toRect.top + toRect.height / 2 - (fromRect.top + fromRect.height / 2);
  const scale = toRect.width / fromRect.width;
  // Arco: sobe um pouco acima da reta (como um pulo) e gira de leve.
  const lift = Math.min(90, Math.abs(dy) * 0.22 + 26);
  const flight = clone.animate([
    { transform: "translate(0, 0) scale(1) rotate(0deg)" },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - lift}px) scale(${((1 + scale) / 2) * 1.12}) rotate(${back ? 10 : -10}deg)`, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(0deg)` },
  ], { duration, delay, easing: "cubic-bezier(.5,0,.2,1)", fill: "both" });
  const cleanup = () => clone.remove();
  flight.finished.then(cleanup, cleanup);
  return flight;
}

// Cancela só os efeitos criados por código (WAAPI) dentro da conversa —
// as animações de CSS do mascote (piscar, respirar) continuam.
function clearPulsinhoScriptedAnimations(chat) {
  chat?.getAnimations?.({ subtree: true }).forEach((item) => {
    const isCss = (typeof CSSAnimation !== "undefined" && item instanceof CSSAnimation) || (typeof CSSTransition !== "undefined" && item instanceof CSSTransition);
    if (!isCss) item.cancel();
  });
}

function playPulsinhoOpenChoreography(chat, from, to, { backdrop, teaserMascot, mascotFrom } = {}) {
  const ease = "cubic-bezier(.2,.9,.3,1)";
  clearPulsinhoScriptedAnimations(chat.querySelector(".bd-chat-head"));
  const cx = from.left + from.width / 2;
  const cy = from.top + Math.min(from.height / 2, 60);
  // 1. Fundo escurece espalhando-se em círculo a partir do balão.
  if (backdrop) {
    const r = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy)) + 40;
    backdrop.animate([
      { clipPath: `circle(0px at ${cx}px ${cy}px)`, opacity: 0.6 },
      { clipPath: `circle(${r}px at ${cx}px ${cy}px)`, opacity: 1 },
    ], { duration: 560, easing: "cubic-bezier(.16,1,.3,1)" });
  }
  // Brilho suave que nasce no balão.
  const glow = document.createElement("i");
  glow.className = "bd-chat-glow";
  glow.setAttribute("aria-hidden", "true");
  glow.style.left = `${(cx - to.left).toFixed(1)}px`;
  glow.style.top = `${(cy - to.top).toFixed(1)}px`;
  chat.appendChild(glow);
  glow.animate([
    { transform: "translate(-50%, -50%) scale(.2)", opacity: 0.85 },
    { transform: "translate(-50%, -50%) scale(3.4)", opacity: 0 },
  ], { duration: 760, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" }).finished.then(() => glow.remove(), () => glow.remove());

  // 2. O Pulsinho voa do balão até o cabeçalho.
  const avatar = chat.querySelector("#bdChatAvatar");
  const headMascot = chat.querySelector(".bd-chat-mascot");
  const landAt = headMascot?.getBoundingClientRect();
  const flight = pulsinhoFlyMascot(teaserMascot, mascotFrom, landAt, { duration: 600, delay: 40 });
  const landDelay = flight ? 620 : 120;
  if (avatar) {
    if (flight) avatar.animate([{ opacity: 0 }, { opacity: 0 }], { duration: landDelay });
    // Pouso: amassa e volta (o mascote tem animação própria; mexemos no avatar).
    avatar.animate([
      { transform: "scale(1.18, .82)" },
      { transform: "scale(.94, 1.06)", offset: 0.45 },
      { transform: "none" },
    ], { duration: 420, delay: landDelay, easing: "cubic-bezier(.34,1.5,.5,1)", fill: "backwards" });
    const ring = document.createElement("i");
    ring.className = "bd-chat-land-ring";
    ring.setAttribute("aria-hidden", "true");
    avatar.appendChild(ring);
    ring.animate([{ transform: "scale(.6)", opacity: 0.8 }, { transform: "scale(2.1)", opacity: 0 }], { duration: 620, delay: landDelay, easing: "cubic-bezier(.2,.7,.3,1)", fill: "both" })
      .finished.then(() => ring.remove(), () => ring.remove());
  }
  // Linha de pulso desenhada ao pousar.
  const pulse = headMascot?.querySelector(".bd-mascot__pulse path");
  if (pulse && typeof pulse.getTotalLength === "function") {
    const len = pulse.getTotalLength();
    pulse.animate([{ strokeDasharray: `${len}`, strokeDashoffset: `${len}` }, { strokeDasharray: `${len}`, strokeDashoffset: "0" }], { duration: 520, delay: landDelay + 60, easing: "cubic-bezier(.65,0,.35,1)", fill: "backwards" });
  }
  // 3. Textos do cabeçalho, botões, mensagens, confirmação e campo.
  chat.querySelectorAll(".bd-chat-head h3, #bdChatStatus").forEach((el, index) => {
    el.animate([{ opacity: 0, transform: "translateX(-12px)", filter: "blur(3px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 380, delay: Math.max(0, landDelay - 140) + index * 70, easing: ease, fill: "backwards" });
  });
  chat.querySelectorAll(".bd-chat-head > .bd-icon-btn:not([hidden]), .bd-chat-head > .bd-chat-menu-wrap").forEach((el, index) => {
    el.animate([{ opacity: 0, transform: "scale(.7)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: 280 + index * 60, easing: "cubic-bezier(.34,1.5,.5,1)", fill: "backwards" });
  });
  const messages = [...chat.querySelectorAll("#pulseCommandResponse > .bd-msg")].slice(-6);
  messages.forEach((msg, index) => {
    const user = msg.classList.contains("bd-msg--user");
    msg.animate([
      { opacity: 0, transform: `translate(${user ? 22 : -22}px, 10px) scale(.94)`, filter: "blur(4px)" },
      { opacity: 1, transform: "none", filter: "blur(0)" },
    ], { duration: 420, delay: 220 + index * 70, easing: ease, fill: "backwards" });
  });
  // Folha de confirmação (quando há uma ação pendente) sobe de baixo.
  chat.querySelector("#pulseCommandResponse .bd-confirm")?.animate([{ opacity: 0, transform: "translateY(24px) scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 440, delay: 320 + messages.length * 50, easing: ease, fill: "backwards" });
  chat.querySelector(":scope > .bd-chat-suggest:not([hidden])")?.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 340, delay: 380, easing: ease, fill: "backwards" });
  chat.querySelector(":scope > .bd-chat-form")?.animate([{ opacity: 0, transform: "translateY(28px)" }, { opacity: 1, transform: "none" }], { duration: 440, delay: 200, easing: ease, fill: "backwards" });
  chat.querySelector(".bd-composer")?.animate([
    { boxShadow: "0 0 0 0 rgba(106,92,255,0)" },
    { boxShadow: "0 0 0 5px rgba(106,92,255,.35), 0 0 24px rgba(34,211,238,.25)", offset: 0.4 },
    { boxShadow: "0 0 0 0 rgba(106,92,255,0)" },
  ], { duration: 900, delay: 560, easing: "ease-out" });
}

function finishClosePulsinhoConvo(chat) {
  chat.classList.remove("is-convo", "has-keyboard", "is-dragging", "from-teaser");
  chat.style.removeProperty("--convo-top");
  chat.style.removeProperty("--convo-h");
  chat.style.removeProperty("--convo-drag");
  document.body.classList.remove("bd-chat-convo");
  document.documentElement.classList.remove("pn-scroll-locked");
  document.querySelector("#bdChatClose")?.setAttribute("hidden", "");
  document.querySelector("#bdChatPlaceholder")?.remove();
  updatePulsinhoSuggestions();
  repairViewportAfterOverlay();
}

function closePulsinhoConvo() {
  const chat = document.querySelector("#bdChat");
  if (!chat || !isPulsinhoConvo() || pulsinhoClosing) return;
  document.querySelector("#pulseCommandInput")?.blur();
  document.querySelector("#bdChatMenu")?.setAttribute("hidden", "");
  const reduce = prefersReducedMotion();
  const backdrop = document.querySelector("#bdChatBackdrop");
  const hideBackdrop = () => { if (backdrop) backdrop.hidden = true; };
  if (backdrop && !backdrop.hidden) {
    if (reduce || typeof backdrop.animate !== "function") hideBackdrop();
    else backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: "ease-out" }).finished.then(hideBackdrop, hideBackdrop);
  }
  const placeholder = document.querySelector("#bdChatPlaceholder");
  // Modo balão: a tela de conversa "se fecha" de volta para dentro do balão.
  if (chat.classList.contains("from-teaser") && placeholder && !reduce && typeof chat.animate === "function") {
    pulsinhoClosing = true;
    const box = chat.getBoundingClientRect();
    const target = placeholder.getBoundingClientRect();
    // O Pulsinho do cabeçalho volta voando para o lugar dele no balão.
    const headMascot = chat.querySelector(".bd-chat-mascot");
    const off = pulsinhoMascotOffset;
    if (headMascot && off) {
      const mascotTo = { left: target.left + off.x, top: target.top + off.y, width: off.w, height: off.h };
      const back = pulsinhoFlyMascot(headMascot, headMascot.getBoundingClientRect(), mascotTo, { duration: 420, back: true });
      // Sem "fill: forwards": um efeito preso no fim deixava o Pulsinho do
      // cabeçalho invisível para sempre (sumia na próxima abertura).
      if (back) chat.querySelector("#bdChatAvatar")?.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 460, id: "pn-avatar-hide" });
    }
    // Fecha "recolhendo": o conteúdo desce e some, o campo de digitar
    // afunda, e o recorte volta para dentro do balão.
    chat.querySelectorAll(":scope > .bd-chat-head, :scope > .bd-chat-stage, :scope > .bd-chat-suggest").forEach((part) => {
      part.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(8px) scale(.98)" }], { duration: 180, easing: "ease-in", fill: "forwards" });
    });
    chat.querySelector(":scope > .bd-chat-form")?.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(18px)" }], { duration: 200, easing: "ease-in", fill: "forwards" });
    const animation = chat.animate([
      { clipPath: "inset(0px 0px 0px 0px round 22px)" },
      { clipPath: pulsinhoClipFor(target, box, 22) },
    ], { duration: 340, delay: 40, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" });
    const done = () => {
      pulsinhoClosing = false;
      chat.getAnimations?.().forEach((item) => item.cancel());
      chat.querySelectorAll(":scope > *").forEach((part) => part.getAnimations?.().forEach((item) => item.cancel()));
      clearPulsinhoScriptedAnimations(chat);
      finishClosePulsinhoConvo(chat);
      // O balão "recebe" a conversa de volta: encolhe e volta com mola, e o
      // Pulsinho do balão dá um pulinho.
      document.querySelector("#bdChatTeaser")?.animate?.([
        { opacity: 0.4, transform: "scale(.94)" },
        { opacity: 1, transform: "scale(1.02)", offset: 0.6 },
        { opacity: 1, transform: "none" },
      ], { duration: 420, easing: "cubic-bezier(.34,1.4,.5,1)" });
      document.querySelector(".bd-teaser-mascot")?.animate?.([
        { transform: "none" },
        { transform: "translateY(-6px) rotate(-8deg) scale(1.08)", offset: 0.45 },
        { transform: "none" },
      ], { duration: 520, delay: 80, easing: "cubic-bezier(.34,1.4,.5,1)" });
    };
    animation.finished.then(done, done);
    return;
  }
  // Volta "pousando" no lugar do cartão (o inverso da abertura).
  const from = chat.getBoundingClientRect();
  const drag = parseFloat(chat.style.getPropertyValue("--convo-drag")) || 0;
  finishClosePulsinhoConvo(chat);
  const to = chat.getBoundingClientRect();
  if (!reduce && to.height && typeof chat.animate === "function") {
    chat.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, opacity: drag > 0 ? 0.85 : 1 },
      { transform: "none", opacity: 1 },
    ], { duration: 280, easing: "cubic-bezier(.2,.9,.3,1)" });
  }
  requestAnimationFrame(() => {
    const rect = chat.getBoundingClientRect();
    if (rect.bottom > window.innerHeight || rect.top < 0) chat.scrollIntoView({ block: "center" });
    scrollPulsinhoToEnd();
  });
}

// Arrastar o cabeçalho para baixo fecha a conversa, como uma folha.
function bindPulsinhoDragToClose() {
  const chat = document.querySelector("#bdChat");
  const head = chat?.querySelector(".bd-chat-head");
  if (!head || head.dataset.dragBound === "1") return;
  head.dataset.dragBound = "1";
  let startY = 0;
  let startT = 0;
  let dy = 0;
  let active = false;
  head.addEventListener("touchstart", (event) => {
    if (!isPulsinhoConvo() || event.touches.length !== 1 || event.target.closest("button, a, input")) return;
    active = true;
    startY = event.touches[0].clientY;
    startT = Date.now();
    dy = 0;
  }, { passive: true });
  head.addEventListener("touchmove", (event) => {
    if (!active) return;
    dy = Math.max(0, event.touches[0].clientY - startY);
    if (dy > 4) {
      event.preventDefault();
      chat.classList.add("is-dragging");
      // Resistência: acompanha o dedo, cada vez mais "pesado".
      chat.style.setProperty("--convo-drag", `${Math.round(dy < 120 ? dy : 120 + (dy - 120) * 0.35)}px`);
    }
  }, { passive: false });
  const end = () => {
    if (!active) return;
    active = false;
    const fast = dy > 40 && dy / Math.max(1, Date.now() - startT) > 0.6;
    if (dy > 110 || fast) { closePulsinhoConvo(); return; }
    chat.classList.remove("is-dragging");
    chat.style.removeProperty("--convo-drag");
  };
  head.addEventListener("touchend", end);
  head.addEventListener("touchcancel", end);
}

// Mantém os nomes usados em outros pontos do app.
function releasePulsinhoFit() { closePulsinhoConvo(); }

function bindPulsinhoKeyboardFit() {
  const input = document.querySelector("#pulseCommandInput");
  if (!input || input.dataset.fitBound === "1") return;
  input.dataset.fitBound = "1";
  // Entra no modo conversa ANTES do foco (no toque), assim o iPhone não
  // rola a página para mostrar o campo. O foco (e o teclado) vem no fim
  // do mesmo toque, já com o cartão no lugar novo.
  const enter = () => { if (chatIsMobile()) openPulsinhoConvo(); };
  input.addEventListener("touchstart", (event) => {
    if (!chatIsMobile() || isPulsinhoConvo() || event.touches.length > 1) return;
    event.preventDefault();
    openPulsinhoConvo();
    pulsinhoConvoGuardUntil = Date.now() + 600;
    document.addEventListener("touchend", () => input.focus({ preventScroll: true }), { once: true });
  }, { passive: false });
  input.addEventListener("focus", () => {
    enter();
    [80, 320, 600].forEach((ms) => setTimeout(() => { layoutPulsinhoConvo(); scrollPulsinhoToEnd(); }, ms));
  });
  input.addEventListener("input", updatePulsinhoSuggestions);
  input.addEventListener("blur", () => setTimeout(layoutPulsinhoConvo, 120));
  document.querySelector("#bdChatClose")?.addEventListener("click", closePulsinhoConvo);
  bindPulsinhoDragToClose();
  document.querySelector("#bdChatSuggest")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chat-suggest]");
    if (!chip) return;
    input.value = chip.dataset.chatSuggest;
    input.focus({ preventScroll: true });
    try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* sem seleção */ }
    updatePulsinhoSuggestions();
  });
  window.visualViewport?.addEventListener("resize", layoutPulsinhoConvo);
  window.visualViewport?.addEventListener("scroll", layoutPulsinhoConvo);
  window.addEventListener("resize", () => { if (!chatIsMobile()) closePulsinhoConvo(); else layoutPulsinhoConvo(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && isPulsinhoConvo()) closePulsinhoConvo(); });
}

function updatePulsinhoJump() {
  const root = document.querySelector("#pulseCommandResponse");
  const jump = document.querySelector("#bdChatJump");
  if (!root || !jump) return;
  jump.hidden = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
}

async function askPulsinhoFromDashboard(question) {
  const input = document.querySelector("#pulseCommandInput");
  // O histórico leva também o resumo do que foi feito em cada resposta,
  // para "na verdade foi 40" ou "desfaz a tarefa" terem contexto.
  const history = pulsinhoConversation.map(({ role, content, actions }) => ({
    role,
    content: [content, ...(actions || []).map((item) => `${item.summary}${item.undone ? " (desfeito)" : ""}`)].filter(Boolean).join("\n"),
  })).slice(-20);
  pulsinhoConversation.push({ role: "user", content: question });
  pendingPulsinhoAction = null;
  pendingPulsinhoActions = [];
  if (input) input.value = "";
  renderPulsinhoConversation({ loading: true });
  try {
    const payload = await pulseApi("/api/pulsinho", {
      method: "POST",
      body: JSON.stringify({ question, history, workspaceId: activeWorkspaceId, providerPreference: state.aiProviderPreference || "auto" }),
    });
    handlePulsinhoPayload(payload);
  } catch (error) {
    renderPulsinhoConversation({
      error: error?.code === "ai_not_configured" || error?.code === "assistant_unavailable"
        ? "A IA conversacional ainda não está disponível neste ambiente. Seus dados não foram alterados."
        : "A conexão falhou. Seus dados não foram alterados; tente novamente em instantes.",
    });
  }
}

const PULSINHO_COLLECTIONS = {
  add_transaction: "finances", add_task: "tasks", add_event: "events", add_note: "notes", add_goal: "goals",
  update_goal: "goals", complete_task: "tasks", edit_transaction: "finances",
  delete_transaction: "finances", delete_task: "tasks", delete_note: "notes", delete_event: "events",
};

// Aplica uma ação já validada pelo servidor. Criações chegam com o
// registro pronto (mesmo formato do app); alterações e exclusões
// chegam pelo id. Devolve o resumo e como desfazer.
function applyPulsinhoAction(action) {
  const key = PULSINHO_COLLECTIONS[action?.type];
  if (!key) return null;
  if (!Array.isArray(state[key])) state[key] = [];
  const list = state[key];
  if (action.type.startsWith("add_")) {
    if (!action.record?.id || list.some((item) => item.id === action.record.id)) return null;
    const record = { ...action.record };
    if (action.type === "add_transaction") record.workspaceId = activeWorkspaceId;
    if (action.type === "add_event") list.push(record);
    else list.unshift(record);
    return { summary: action.summary, undo: () => { state[key] = state[key].filter((item) => item.id !== record.id); } };
  }
  const index = list.findIndex((item) => item.id === action.targetId);
  if (index < 0) return null;
  if (action.type.startsWith("delete_")) {
    const [removed] = list.splice(index, 1);
    return {
      summary: `Excluído: “${action.targetTitle || removed?.title || removed?.description || "item"}”`,
      undo: () => { state[key].splice(Math.min(index, state[key].length), 0, removed); },
    };
  }
  const before = { ...list[index] };
  list[index] = { ...list[index], ...(action.patch || {}) };
  return {
    summary: action.summary,
    undo: () => {
      const position = state[key].findIndex((item) => item.id === before.id);
      if (position >= 0) state[key][position] = before;
    },
  };
}

function applyPulsinhoActions(actions) {
  const applied = [];
  for (const action of actions) {
    const result = applyPulsinhoAction(action);
    if (!result) continue;
    const undoKey = crypto.randomUUID();
    pulsinhoUndo.set(undoKey, result.undo);
    applied.push({ summary: result.summary, undoKey });
  }
  if (applied.length) {
    saveState();
    renderAll();
  }
  return applied;
}

function handlePulsinhoPayload(payload) {
  const actions = Array.isArray(payload?.actions) ? payload.actions : [];
  const needsConfirm = (action) => action.risk !== "auto" || action.lowConfidence;
  const applied = applyPulsinhoActions(actions.filter((action) => !needsConfirm(action)));
  pendingPulsinhoActions = actions.filter(needsConfirm);
  pulsinhoConversation.push({
    role: "assistant",
    content: payload?.reply || (applied.length ? "Pronto!" : "Não encontrei uma resposta segura com os dados disponíveis."),
    followUps: Array.isArray(payload?.followUps) ? payload.followUps : [],
    provider: payload?.provider || "",
    actions: applied,
  });
  // Versões antigas do servidor devolvem só uma proposta única.
  pendingPulsinhoAction = !actions.length && payload?.proposedAction?.requiresConfirmation ? payload.proposedAction : null;
  renderPulsinhoConversation();
}

function confirmPulsinhoActions() {
  const actions = pendingPulsinhoActions;
  pendingPulsinhoActions = [];
  const applied = applyPulsinhoActions(actions);
  pulsinhoConversation.push({
    role: "assistant",
    content: applied.length ? "Pronto!" : "Esses itens já não existem mais — talvez tenham sido alterados. Nada foi alterado.",
    provider: "pulse-engine",
    actions: applied,
  });
  renderPulsinhoConversation();
}

function undoPulsinhoAction(undoKey) {
  const undo = pulsinhoUndo.get(undoKey);
  if (!undo) return;
  undo();
  pulsinhoUndo.delete(undoKey);
  for (const message of pulsinhoConversation) {
    for (const item of message.actions || []) if (item.undoKey === undoKey) item.undone = true;
  }
  saveState();
  renderAll();
  renderPulsinhoConversation();
  showToast("Desfeito.");
}

function validPulsinhoDate(value, fallback = todayIso) {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : fallback;
}

function confirmPulsinhoAction() {
  const action = pendingPulsinhoAction;
  if (!action) return;
  const payload = action.payload || {};
  const title = String(payload.title || payload.description || "").trim().slice(0, 180);
  if (action.type !== "navigate" && !title) {
    showToast("Não foi possível confirmar: faltou um título ou descrição.");
    return;
  }

  if (action.type === "create_task") {
    state.tasks.unshift(createTask(title, "Pendente", ["Baixa", "Media", "Alta", "Urgente"].includes(payload.priority) ? payload.priority : "Media", validPulsinhoDate(payload.dueDate), "", String(payload.dueTime || "").slice(0, 5), normalizeReminderValue(payload.reminder)));
  } else if (action.type === "create_event") {
    state.events.push({ id: crypto.randomUUID(), title, date: validPulsinhoDate(payload.date), time: String(payload.time || "").slice(0, 5), location: String(payload.location || "Sem local").slice(0, 120), reminder: normalizeReminderValue(payload.reminder), notes: String(payload.notes || "").slice(0, 500) });
  } else if (action.type === "create_note") {
    state.notes.unshift({ id: crypto.randomUUID(), title, description: String(payload.description || "").slice(0, 3000), category: String(payload.category || "Geral").slice(0, 60), folder: "Entrada", tags: [], priority: "Media", checklist: [], attachments: [], goal: "", observations: "", color: "blue", textColor: "", favorite: false, createdAt: todayIso, convertedToTaskId: "" });
  } else if (action.type === "create_goal") {
    state.goals.unshift({ id: crypto.randomUUID(), title, target: Math.max(1, Number(payload.target) || 100), current: Math.max(0, Number(payload.current) || 0), milestones: [] });
  } else if (action.type === "create_transaction") {
    const amount = Math.round(Math.abs(Number(payload.amount) || 0) * 100) / 100;
    if (!amount) { showToast("Não foi possível confirmar: informe um valor válido."); return; }
    const type = payload.type === "receita" ? "receita" : "despesa";
    const category = String(payload.category || (type === "receita" ? "outros_receita" : "outros")).slice(0, 60);
    state.finances.unshift({ id: crypto.randomUUID(), type, amount, category, description: title, date: validPulsinhoDate(payload.date), accountId: "", workspaceId: activeWorkspaceId });
  } else if (action.type === "navigate") {
    const target = ["dashboard", "finances", "planner", "notes", "autopilot", "settings"].includes(payload.target) ? payload.target : "dashboard";
    setView(target);
    pendingPulsinhoAction = null;
    renderPulsinhoConversation();
    return;
  } else {
    showToast("Essa ação ainda não é compatível com o PulseNote.");
    return;
  }

  pendingPulsinhoAction = null;
  saveState();
  renderAll();
  pulsinhoConversation.push({ role: "assistant", content: "Pronto. A ação foi confirmada e salva no PulseNote.", provider: "pulse-engine" });
  renderPulsinhoConversation();
}

function parseMoneyInput(value) {
  const raw = String(value || "").trim().replace(/\s/g, "");
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
}

function parseSignedMoneyInput(value) {
  const raw = String(value || "").trim().replace(/\s/g, "");
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function openFinanceSimulator() {
  setView("finances");
  document.querySelector('[data-fin-tab="analise"]')?.click();
  requestAnimationFrame(() => {
    document.querySelector("#finSimulatorForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
    document.querySelector("#finSimulatorAmount")?.focus();
  });
}

async function runFinanceSimulation(event) {
  event?.preventDefault();
  const input = document.querySelector("#finSimulatorAmount");
  const result = document.querySelector("#finSimulatorResult");
  const amount = parseMoneyInput(input?.value);
  if (!amount) {
    showToast("Informe um valor válido para simular.");
    input?.focus();
    return;
  }
  if (result) {
    result.hidden = false;
    result.classList.remove("is-risk");
    result.innerHTML = '<div class="fin-simulator-answer"><strong>Calculando projeção…</strong><p>Considerando suas contas e compromissos registrados.</p></div>';
  }
  try {
    const params = new URLSearchParams({ amount: String(amount), workspaceId: activeWorkspaceId });
    const payload = await pulseApi(`/api/finance-forecast?${params}`);
    const forecast = payload.forecast || {};
    if (result) {
      result.classList.toggle("is-risk", forecast.canAfford === false);
      result.innerHTML = `
        <div class="fin-simulator-answer"><strong>${forecast.canAfford ? "Sim, pode gastar!" : "Melhor esperar"}</strong><p>${escapeHtml(forecast.summary || "")}</p></div>
        <div class="fin-simulator-metric"><strong>${formatCurrency(forecast.projectedBalanceAfterPurchase)}</strong><span>saldo projetado após a compra</span></div>
        <div class="fin-simulator-metric"><strong>${formatCurrency(forecast.lowestBalance)}</strong><span>menor saldo até o fim do mês</span></div>
        <div class="fin-simulator-metric"><strong>${formatCurrency(forecast.reserve)}</strong><span>reserva preservada na análise</span></div>`;
    }
  } catch {
    // Sem a projeção do servidor (offline ou demonstração), responde pelo
    // orçamento do mês: limites por categoria ou, sem limites, o saldo.
    if (result) {
      const local = finLocalForecast(amount);
      result.classList.toggle("is-risk", !local.canAfford);
      result.innerHTML = local.canAfford
        ? `<div class="fin-simulator-answer"><strong>Sim, pode gastar!</strong><p>Você ainda tem <b>${formatCurrency(local.available)}</b> disponíveis no orçamento deste mês.</p></div>`
        : `<div class="fin-simulator-answer"><strong>Melhor esperar</strong><p>${local.available > 0 ? `Sobram só <b>${formatCurrency(local.available)}</b> no orçamento deste mês.` : "O orçamento deste mês já foi todo usado."}</p></div>`;
    }
  }
}

function finLocalForecast(amount) {
  const totals = finMonthTotals(todayIso.slice(0, 7));
  const limits = (state.finGoals || []).filter((g) => (g.workspaceId || "personal") === activeWorkspaceId).reduce((sum, g) => sum + (Number(g.limit) || 0), 0);
  const available = Math.round(((limits > 0 ? limits - totals.d : totals.saldo) - 0) * 100) / 100;
  return { available: Math.max(0, available), canAfford: amount <= available };
}

function openFinanceCategory(categoryId) {
  finCategoryDrilldown = categoryId || null;
  document.querySelector('[data-fin-tab="lancamentos"]')?.click();
  renderFinances();
  requestAnimationFrame(() => document.querySelector("#finTransactions")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function isSharedFinanceWorkspace(workspaceId) {
  return sharedFinanceSpaces.some((space) => space.id === workspaceId);
}

function sharedFinanceSpace(workspaceId) {
  return sharedFinanceSpaces.find((space) => space.id === workspaceId) || null;
}

function canEditFinanceWorkspace(workspaceId = activeWorkspaceId) {
  const space = sharedFinanceSpace(workspaceId);
  return !space || Boolean(space.canEdit);
}

function requireFinanceWorkspaceEdit(workspaceId = activeWorkspaceId) {
  if (canEditFinanceWorkspace(workspaceId)) return true;
  showToast("Este espaço foi compartilhado com você em modo somente leitura.");
  return false;
}

function workspaceLabel(workspaceId) {
  const shared = sharedFinanceSpace(workspaceId);
  if (shared) return shared.name;
  return ({ personal: "Pessoal", couple: "Casal privado", family: "Família privada", business: "Empresa" })[workspaceId] || "Pessoal";
}

function financeSpaceDataFromState(workspaceId) {
  const inSpace = (item) => (item?.workspaceId || "personal") === workspaceId;
  return {
    finances: (state.finances || []).filter(inSpace),
    financeAccounts: (state.financeAccounts || []).filter(inSpace),
    finGoals: (state.finGoals || []).filter(inSpace),
    finRecurrents: (state.finRecurrents || []).filter(inSpace),
    creditCards: (state.creditCards || []).filter(inSpace),
    scheduledFinances: (state.scheduledFinances || []).filter(inSpace),
    monthClosures: (state.monthClosures || []).filter(inSpace),
    financialSettings: { safetyReserve: Number(state.financialSettings?.safetyReserve) || 0 },
  };
}

function mergeFinanceSpaceData(space) {
  if (!space?.id || !space.data) return;
  const fields = ["finances", "financeAccounts", "finGoals", "finRecurrents", "creditCards", "scheduledFinances", "monthClosures"];
  for (const field of fields) {
    const local = Array.isArray(state[field]) ? state[field] : [];
    const personal = local.filter((item) => (item?.workspaceId || "personal") !== space.id);
    const remote = Array.isArray(space.data[field]) ? space.data[field].map((item) => ({ ...item, workspaceId: space.id })) : [];
    state[field] = [...personal, ...remote];
  }
}

function renderFinanceWorkspaceOptions() {
  const fixed = [
    { id: "personal", label: "Pessoal" },
    { id: "couple", label: "Casal privado" },
    { id: "family", label: "Família privada" },
    { id: "business", label: "Empresa" },
  ];
  const options = [...fixed, ...sharedFinanceSpaces.map((space) => ({ id: space.id, label: `Compartilhado · ${space.name}` }))];
  for (const selector of ["#finWorkspaceSelect", "#finAccountWorkspace"]) {
    const select = document.querySelector(selector);
    if (!select) continue;
    const previous = select.value || activeWorkspaceId;
    select.innerHTML = options.map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`).join("");
    select.value = options.some((option) => option.id === previous) ? previous : activeWorkspaceId;
  }
  // No seletor rápido, um espaço compartilhado do tipo Casal/Família ocupa o
  // botão "Casal"/"Família" (é o que o quadro mostra). O espaço privado de
  // mesmo nome continua disponível no menu completo e aparece aqui se estiver em uso.
  const shortLabels = { personal: "Pessoal", couple: "Casal", family: "Família", business: "Empresa" };
  const icons = { personal: "user", couple: "users", family: "house", business: "layers" };
  const sharedByType = {};
  sharedFinanceSpaces.forEach((space) => { if ((space.type === "couple" || space.type === "family") && !sharedByType[space.type]) sharedByType[space.type] = space; });
  const mappedIds = new Set(Object.values(sharedByType).map((space) => space.id));
  const segment = [];
  for (const option of options) {
    if (option.id === "business" && option.id !== activeWorkspaceId) continue;
    if (mappedIds.has(option.id)) continue;
    const mapped = sharedByType[option.id];
    if (mapped) {
      segment.push({ id: mapped.id, label: shortLabels[option.id], icon: icons[option.id], title: mapped.name });
      if (activeWorkspaceId === option.id) segment.push({ id: option.id, label: `${shortLabels[option.id]} privado`, icon: "lock" });
      continue;
    }
    segment.push({ id: option.id, label: shortLabels[option.id] || option.label.replace("Compartilhado · ", ""), icon: icons[option.id] || "users" });
  }
  for (const switcher of document.querySelectorAll(".bd-ws, #finWsSeg")) {
    switcher.innerHTML = segment.map((option) => `<button type="button" class="bd-ws-option${option.id === activeWorkspaceId ? " active" : ""}" data-workspace="${escapeHtml(option.id)}" aria-pressed="${option.id === activeWorkspaceId}"${option.title ? ` title="${escapeHtml(option.title)}"` : ""}>${bdIcon(option.icon)}${escapeHtml(option.label)}</button>`).join("");
  }
}

function renderSharedFinanceSpaces() {
  renderFinMembers();
  const root = document.querySelector("#finSharedSpacesList");
  const invitesRoot = document.querySelector("#finSharedInvites");
  if (!root || !invitesRoot) return;
  invitesRoot.hidden = !sharedFinanceInvites.length;
  invitesRoot.innerHTML = sharedFinanceInvites.map((invite) => `
    <article class="fin-shared-invite">
      <div><strong>Convite para ${escapeHtml(invite.spaceName || "um espaço")}</strong><span>${escapeHtml(invite.inviterName || "Um usuário")} convidou você para colaborar.</span></div>
      <button type="button" data-shared-action="accept" data-invite-id="${escapeHtml(invite.id)}">Aceitar convite</button>
    </article>`).join("");
  if (!sharedFinanceSpaces.length) {
    root.innerHTML = '<div class="empty-state">Nenhum espaço compartilhado. Crie um para organizar as finanças com seu parceiro ou família.</div>';
    return;
  }
  root.innerHTML = sharedFinanceSpaces.map((space) => {
    const owner = space.role === "owner";
    const memberNames = (space.members || []).map((member) => member.name || member.email).filter(Boolean).join(", ");
    return `<article class="fin-shared-space-card${space.id === activeWorkspaceId ? " is-active" : ""}">
      <div class="fin-shared-space-icon" aria-hidden="true">${bdIcon(space.type === "couple" ? "heart" : space.type === "family" ? "house" : "users")}</div>
      <div class="fin-shared-space-copy"><strong>${escapeHtml(space.name)}</strong><span>${escapeHtml(memberNames || "Somente você")} · ${space.canEdit ? "Pode editar" : "Somente leitura"}</span></div>
      <button type="button" class="fin-shared-open" data-shared-action="open" data-space-id="${escapeHtml(space.id)}">${space.id === activeWorkspaceId ? "Em uso" : "Abrir"}</button>
      ${owner ? `<form class="fin-shared-invite-form" data-space-id="${escapeHtml(space.id)}"><input type="email" name="email" autocomplete="email" placeholder="E-mail para convidar" aria-label="E-mail para convidar" required><select name="role" aria-label="Permissão"><option value="editor">Pode editar</option><option value="viewer">Somente leitura</option></select><button type="submit">Convidar</button></form>` : `<button type="button" class="fin-shared-leave" data-shared-action="leave" data-space-id="${escapeHtml(space.id)}">Sair do espaço</button>`}
    </article>`;
  }).join("");
}

function applyFinanceSpacePermissions() {
  const space = sharedFinanceSpace(activeWorkspaceId);
  const readOnly = Boolean(space && !space.canEdit);
  document.querySelector("#financesView")?.classList.toggle("is-readonly-space", readOnly);
  for (const selector of ["#expenseForm input", "#expenseForm select", "#expenseForm button", "#aiQuickSubmit", "#finCloseMonth", "#finReopenMonth", "#finAddAccount", "#finAddCard", "#finCardForm input", "#finCardForm button", "#finOpenGoalsModal", "#finOpenRecurModal", "#finOpenSavingsModal", "#finOpenRuleModal", "#finOpenSchedModal", "#finAutoFab"]) {
    document.querySelectorAll(selector).forEach((element) => { element.disabled = readOnly; });
  }
}

async function loadFinanceSpaces({ silent = false } = {}) {
  if (isLocalDesignPreview && currentUser && !sharedFinanceSpaces.length && designPreviewMode !== "empty") {
    // Demonstração: um espaço "Casal" com a Ana, como no quadro.
    sharedFinanceSpaces = [{
      id: "preview-space-casal", name: "Casa Lucas e Ana", type: "couple", role: "owner", canEdit: true, revision: 0,
      members: [
        { uid: currentUser.uid, name: currentUser.displayName || "Você", email: currentUser.email || "", role: "owner" },
        { uid: "preview-ana", name: "Ana Pereira", email: "ana.pereira@exemplo.com", role: "editor" },
      ],
      data: null,
    }];
  }
  if (!currentUser || isLocalDesignPreview) {
    renderFinanceWorkspaceOptions();
    renderSharedFinanceSpaces();
    return;
  }
  try {
    const payload = await pulseApi("/api/finance-spaces");
    sharedFinanceSpaces = Array.isArray(payload.spaces) ? payload.spaces : [];
    sharedFinanceInvites = Array.isArray(payload.invites) ? payload.invites : [];
    sharedFinanceSpaces.forEach(mergeFinanceSpaceData);
    // A leitura do servidor é a nova base, não uma edição local. Assim o
    // próximo salvamento de uma nota pessoal não tenta copiar os dados do
    // espaço compartilhado para o documento privado do usuário.
    observedState = cloneState(state);
    if (isSharedFinanceWorkspace(activeWorkspaceId) === false && !["personal", "couple", "family", "business"].includes(activeWorkspaceId)) activeWorkspaceId = "personal";
    renderFinanceWorkspaceOptions();
    renderSharedFinanceSpaces();
    applyFinanceSpacePermissions();
  } catch (error) {
    if (!silent) showToast("Não foi possível atualizar os espaços compartilhados agora.");
    const root = document.querySelector("#finSharedSpacesList");
    if (root) root.innerHTML = '<div class="empty-state">Os espaços compartilhados não puderam ser carregados. Seus dados pessoais continuam disponíveis.</div>';
  }
}

async function createFinanceSpace(event) {
  event.preventDefault();
  const name = valueOf("#finSharedSpaceName").trim();
  const type = valueOf("#finSharedSpaceType") || "group";
  if (name.length < 2) return showToast("Dê um nome ao espaço compartilhado.");
  const submit = event.currentTarget.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const payload = await pulseApi("/api/finance-spaces", { method: "POST", body: JSON.stringify({ action: "create", name, type }) });
    if (payload.space) sharedFinanceSpaces.push(payload.space);
    event.currentTarget.reset();
    event.currentTarget.hidden = true;
    renderFinanceWorkspaceOptions();
    renderSharedFinanceSpaces();
    if (payload.space?.id) setActiveFinanceWorkspace(payload.space.id);
    showToast("Espaço compartilhado criado.", { tone: "success" });
  } catch (error) {
    console.warn("finance-space create failed", error?.code || error?.message);
    showToast(financeSpaceErrorMessage(error, "Não foi possível criar o espaço agora. Tente de novo em alguns segundos."), { tone: "warn" });
  }
  finally { if (submit) submit.disabled = false; }
}

async function inviteToFinanceSpace(event) {
  const form = event.target.closest(".fin-shared-invite-form");
  if (!form) return;
  event.preventDefault();
  const email = String(new FormData(form).get("email") || "").trim();
  const role = String(new FormData(form).get("role") || "editor");
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    await pulseApi("/api/finance-spaces", { method: "POST", body: JSON.stringify({ action: "invite", spaceId: form.dataset.spaceId, email, role }) });
    form.reset();
    showToast("Convite criado. Ele aparecerá na conta desse e-mail.");
  } catch (error) {
    showToast(financeSpaceErrorMessage(error, "Não foi possível criar o convite agora."), { tone: "warn" });
  } finally { if (submit) submit.disabled = false; }
}

async function handleSharedSpaceAction(event) {
  const button = event.target.closest("[data-shared-action]");
  if (!button) return;
  const action = button.dataset.sharedAction;
  if (action === "open") return setActiveFinanceWorkspace(button.dataset.spaceId);
  button.disabled = true;
  try {
    if (action === "accept") {
      await pulseApi("/api/finance-spaces", { method: "POST", body: JSON.stringify({ action: "accept", inviteId: button.dataset.inviteId }) });
      await loadFinanceSpaces();
      showToast("Convite aceito. O espaço já está disponível.");
    }
    if (action === "leave") {
      if (!confirm("Sair deste espaço compartilhado? Seus dados pessoais não serão alterados.")) return;
      await pulseApi("/api/finance-spaces", { method: "POST", body: JSON.stringify({ action: "leave", spaceId: button.dataset.spaceId }) });
      if (activeWorkspaceId === button.dataset.spaceId) activeWorkspaceId = "personal";
      await loadFinanceSpaces();
      renderAll();
      showToast("Você saiu do espaço compartilhado.");
    }
  } catch (error) { showToast(financeSpaceErrorMessage(error, "Não foi possível concluir essa ação."), { tone: "warn" }); }
  finally { button.disabled = false; }
}

function scheduleSharedSpaceSync(workspaceId) {
  const space = sharedFinanceSpace(workspaceId);
  if (!space?.canEdit) return;
  clearTimeout(sharedSpaceSyncTimers.get(workspaceId));
  sharedSpaceSyncTimers.set(workspaceId, setTimeout(() => syncSharedFinanceSpace(workspaceId), 900));
}

async function syncSharedFinanceSpace(workspaceId) {
  const space = sharedFinanceSpace(workspaceId);
  if (!space?.canEdit || !currentUser || isLocalDesignPreview) return;
  try {
    const payload = await pulseApi("/api/finance-spaces", {
      method: "POST",
      body: JSON.stringify({ action: "save", spaceId: workspaceId, revision: space.revision, data: financeSpaceDataFromState(workspaceId) }),
    });
    space.revision = payload.revision;
    space.data = financeSpaceDataFromState(workspaceId);
  } catch (error) {
    if (error.code === "space_conflict") {
      await loadFinanceSpaces({ silent: true });
      renderAll();
      showToast("Este espaço mudou em outro aparelho. Atualizamos os dados para evitar sobrescrever alterações.");
    } else {
      showToast("A alteração ficou salva neste aparelho, mas o espaço compartilhado ainda não sincronizou.");
    }
  } finally {
    sharedSpaceSyncTimers.delete(workspaceId);
  }
}

function setActiveFinanceWorkspace(workspaceId) {
  const allowed = new Set(["personal", "couple", "family", "business", ...sharedFinanceSpaces.map((space) => space.id)]);
  activeWorkspaceId = allowed.has(workspaceId) ? workspaceId : "personal";
  document.querySelectorAll("[data-workspace]").forEach((item) => {
    const active = item.dataset.workspace === activeWorkspaceId;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  const select = document.querySelector("#finWorkspaceSelect");
  if (select) select.value = activeWorkspaceId;
  const accountSelect = document.querySelector("#finAccountWorkspace");
  if (accountSelect && [...accountSelect.options].some((option) => option.value === activeWorkspaceId)) accountSelect.value = activeWorkspaceId;
  finCategoryDrilldown = null;
  lastForecastFetchAt = 0;
  latestDashboardForecast = null;
  renderSharedFinanceSpaces();
  applyFinanceSpacePermissions();
  renderDashboard();
  renderFinances();
}

function toggleFinanceAccountForm(open, account = null) {
  const wrap = document.querySelector("#finAccountFormWrap");
  const form = document.querySelector("#finAccountForm");
  if (!wrap || !form) return;
  wrap.hidden = !open;
  if (!open) {
    form.reset();
    document.querySelector("#finAccountId").value = "";
    return;
  }
  document.querySelector("#finAccountId").value = account?.id || "";
  document.querySelector("#finAccountName").value = account?.name || "";
  const institution = document.querySelector("#finAccountInstitution");
  if (institution) institution.value = account?.institution || "";
  document.querySelector("#finAccountType").value = account?.type || "checking";
  document.querySelector("#finAccountWorkspace").value = account?.workspaceId || activeWorkspaceId;
  document.querySelector("#finAccountBalance").value = account ? String(account.balance || 0).replace(".", ",") : "";
  requestAnimationFrame(() => document.querySelector("#finAccountName")?.focus());
}

function saveFinanceAccount(event) {
  event.preventDefault();
  const id = valueOf("#finAccountId");
  const name = valueOf("#finAccountName").trim();
  const balance = parseSignedMoneyInput(valueOf("#finAccountBalance"));
  const type = valueOf("#finAccountType") || "checking";
  const institution = valueOf("#finAccountInstitution").trim().slice(0, 40);
  const workspaceId = valueOf("#finAccountWorkspace") || "personal";
  if (!requireFinanceWorkspaceEdit(workspaceId)) return;
  if (name.length < 2) {
    showToast("Informe um nome para a conta.");
    return;
  }
  state.financeAccounts ||= [];
  if (id) {
    state.financeAccounts = state.financeAccounts.map((account) => account.id === id
      ? { ...account, name, institution, balance, type, workspaceId, updatedAt: new Date().toISOString() }
      : account);
  } else {
    state.financeAccounts.push({
      id: crypto.randomUUID(), name, institution, balance, type, workspaceId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false,
    });
  }
  saveState();
  toggleFinanceAccountForm(false);
  renderFinances();
  lastForecastFetchAt = 0;
  refreshDashboardForecast(true);
}

function editFinanceAccount(id) {
  const account = (state.financeAccounts || []).find((item) => item.id === id);
  if (account && !requireFinanceWorkspaceEdit(account.workspaceId || "personal")) return;
  if (account) toggleFinanceAccountForm(true, account);
}

function archiveFinanceAccount(id) {
  const account = (state.financeAccounts || []).find((item) => item.id === id);
  if (account && !requireFinanceWorkspaceEdit(account.workspaceId || "personal")) return;
  if (!account || !confirm(`Arquivar a conta “${account.name}”? Os lançamentos existentes serão preservados.`)) return;
  account.archived = true;
  account.updatedAt = new Date().toISOString();
  saveState();
  renderFinances();
}
window.editFinanceAccount = editFinanceAccount;
window.archiveFinanceAccount = archiveFinanceAccount;

function toggleCreditCardForm(open) {
  const form = document.querySelector("#finCardForm");
  if (!form) return;
  const wrap = document.querySelector("#finCardFormWrap");
  if (wrap) wrap.hidden = !open;
  else form.hidden = !open;
  if (!open) {
    form.reset();
    document.querySelector("#finCardClosingDay").value = "1";
    document.querySelector("#finCardDueDay").value = "10";
    return;
  }
  renderFinCardPreview();
  requestAnimationFrame(() => document.querySelector("#finCardName")?.focus());
}

// Prévia ao vivo do cartão no formulário (nome, final e bandeira).
function renderFinCardPreview() {
  const root = document.querySelector("#finCardPreview");
  if (!root) return;
  const card = { name: valueOf("#finCardName").trim() || "Seu cartão", last4: valueOf("#finCardLast4").replace(/\D/g, "").slice(-4), network: valueOf("#finCardNetwork") };
  root.innerHTML = finCardArtHtml(card, { size: "lg" });
}
["#finCardName", "#finCardLast4", "#finCardNetwork"].forEach((sel) => {
  document.addEventListener("input", (event) => { if (event.target.matches?.(sel)) renderFinCardPreview(); });
  document.addEventListener("change", (event) => { if (event.target.matches?.(sel)) renderFinCardPreview(); });
});

function saveCreditCard(event) {
  event.preventDefault();
  if (!requireFinanceWorkspaceEdit()) return;
  const name = valueOf("#finCardName").trim();
  const last4 = valueOf("#finCardLast4").replace(/\D/g, "").slice(-4);
  const limit = parseSignedMoneyInput(valueOf("#finCardLimit"));
  const closingDay = Number(valueOf("#finCardClosingDay"));
  const dueDay = Number(valueOf("#finCardDueDay"));
  if (name.length < 2 || limit <= 0 || closingDay < 1 || closingDay > 31 || dueDay < 1 || dueDay > 31) {
    showToast("Revise o nome, o limite e as datas do cartão.");
    return;
  }
  state.creditCards ||= [];
  const network = valueOf("#finCardNetwork") || "";
  state.creditCards.push({
    id: crypto.randomUUID(), name, last4, limit, closingDay, dueDay, ...(network ? { network } : {}),
    workspaceId: activeWorkspaceId, invoices: [], archived: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  saveState();
  toggleCreditCardForm(false);
  renderFinances();
  showToast(`Cartão ${name} adicionado.`, { tone: "success" });
  lastForecastFetchAt = 0;
  refreshDashboardForecast(true);
}

function openCreditCardPurchase(cardId) {
  const card = (state.creditCards || []).find((item) => item.id === cardId && !item.archived);
  if (!card || !requireFinanceWorkspaceEdit(card.workspaceId || "personal")) return;
  document.querySelector("#finCardPurchaseCardId").value = card.id;
  document.querySelector("#finCardPurchaseTitle").textContent = `Compra no ${card.name}`;
  document.querySelector("#finCardPurchaseDate").value = todayIso;
  document.querySelector("#finCardPurchaseInstallments").value = "1";
  document.querySelector("#finCardPurchaseModal").hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => document.querySelector("#finCardPurchaseDescription")?.focus());
}

function closeCreditCardPurchase() {
  const modal = document.querySelector("#finCardPurchaseModal");
  if (modal) modal.hidden = true;
  document.querySelector("#finCardPurchaseForm")?.reset();
  document.body.classList.remove("modal-open");
}

function saveCreditCardPurchase(event) {
  event.preventDefault();
  const card = (state.creditCards || []).find((item) => item.id === valueOf("#finCardPurchaseCardId"));
  if (!card || !requireFinanceWorkspaceEdit(card.workspaceId || "personal")) return;
  const description = valueOf("#finCardPurchaseDescription").trim();
  const amount = parseSignedMoneyInput(valueOf("#finCardPurchaseAmount"));
  const purchaseDate = valueOf("#finCardPurchaseDate");
  const installments = Number(valueOf("#finCardPurchaseInstallments"));
  const buildPlan = window.PulseCardInstallments?.buildInstallmentPlan;
  if (description.length < 2 || amount <= 0 || !purchaseDate || installments < 1 || installments > 48 || typeof buildPlan !== "function") {
    showToast("Revise a descrição, o valor, a data e as parcelas.");
    return;
  }

  const purchaseId = crypto.randomUUID();
  const plan = buildPlan({ amount, installments, purchaseDate, closingDay: card.closingDay, dueDay: card.dueDay });
  card.invoices ||= [];
  for (const part of plan) {
    let invoice = card.invoices.find((item) => item.monthKey === part.monthKey);
    if (!invoice) {
      invoice = { id: crypto.randomUUID(), monthKey: part.monthKey, dueDate: part.dueDate, amount: 0, status: "open", purchases: [] };
      card.invoices.push(invoice);
    }
    invoice.amount = Math.round((Number(invoice.amount || 0) + part.amount) * 100) / 100;
    invoice.purchases ||= [];
    invoice.purchases.push({
      id: `${purchaseId}:${part.installmentNumber}`,
      purchaseId, description, purchaseDate, amount: part.amount,
      installmentNumber: part.installmentNumber, totalInstallments: part.totalInstallments,
    });
  }
  card.updatedAt = new Date().toISOString();
  saveState();
  closeCreditCardPurchase();
  renderFinances();
  lastForecastFetchAt = 0;
  refreshDashboardForecast(true);
  showToast(installments > 1 ? `Compra distribuída em ${installments} faturas.` : "Compra adicionada à fatura.");
}

function payCreditCardInvoice(cardId, invoiceId) {
  const card = (state.creditCards || []).find((item) => item.id === cardId);
  const invoice = card?.invoices?.find((item) => item.id === invoiceId);
  if (!card || !invoice || invoice.status === "paid" || !requireFinanceWorkspaceEdit(card.workspaceId || "personal")) return;
  state.finances ||= [];
  state.finances.unshift({
    id: crypto.randomUUID(), type: "despesa", amount: Number(invoice.amount || 0), category: "contas",
    description: `Fatura ${card.name}`, date: todayIso, workspaceId: card.workspaceId || "personal",
    cardId: card.id, invoiceId: invoice.id,
  });
  invoice.status = "paid";
  invoice.paidAt = new Date().toISOString();
  saveState();
  renderFinances();
  lastForecastFetchAt = 0;
  refreshDashboardForecast(true);
  showToast(`Fatura de ${formatCurrency(invoice.amount)} marcada como paga.`);
}

function archiveCreditCard(cardId) {
  const card = (state.creditCards || []).find((item) => item.id === cardId);
  if (!card || !requireFinanceWorkspaceEdit(card.workspaceId || "personal")) return;
  if (!confirm(`Arquivar o cartão “${card.name}”? As faturas existentes serão preservadas.`)) return;
  card.archived = true;
  card.updatedAt = new Date().toISOString();
  saveState();
  renderFinances();
}
window.openCreditCardPurchase = openCreditCardPurchase;
window.payCreditCardInvoice = payCreditCardInvoice;
window.archiveCreditCard = archiveCreditCard;

function clearFinanceCategory() {
  finCategoryDrilldown = null;
  renderFinances();
}
window.clearFinanceCategory = clearFinanceCategory;

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
  document.querySelectorAll(".fin-tab-btn").forEach((tab) => {
    tab.addEventListener("click", () => {
      setFinBoardTab(tab.dataset.finTab);
      // Centraliza a aba só se a fileira de abas rola (celular), e no
      // quadro seguinte — rolar agora forçava um recálculo no meio da troca.
      requestAnimationFrame(() => {
        const row = tab.parentElement;
        if (row && row.scrollWidth > row.clientWidth + 2) tab.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      });
    });
  });
  bindFinanceBoard();
}

// Pula direto para um mês específico na aba Lançamentos — usado na lista de
// "Meses fechados" pra não precisar clicar em ‹ › várias vezes até achar o mês.
function goToFinMonth(monthKey) {
  finActiveMonth = monthKey;
  finSelectedDay = null;
  setFinBoardTab("lancamentos");
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
      results.push({ type: "notes", icon: bdIcon("note"), title: n.title, sub: "Nota", id: n.id });
    }
  });
  (state.tasks || []).forEach((t) => {
    if (t.title.toLowerCase().includes(q)) {
      results.push({ type: "tasks", icon: bdIcon("task-check"), title: t.title, sub: `Tarefa · ${t.status}`, id: t.id });
    }
  });
  (state.events || []).forEach((e) => {
    if (`${e.title} ${e.location || ""}`.toLowerCase().includes(q)) {
      results.push({ type: "calendar", icon: bdIcon("calendar"), title: e.title, sub: `Agenda · ${formatDate(e.date)}`, id: e.id });
    }
  });
  (state.finances || []).forEach((f) => {
    if ((f.description || "").toLowerCase().includes(q)) {
      results.push({ type: "finances", icon: bdIcon("wallet"), title: f.description, sub: `Finanças · ${formatCurrency(f.amount)}`, id: f.id });
    }
  });
  (state.goals || []).forEach((g) => {
    if (g.title.toLowerCase().includes(q)) {
      results.push({ type: "goals", icon: bdIcon("target"), title: g.title, sub: "Meta", id: g.id });
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
  trackUsageArea(view);
  // Sync sidebar nav
  document.querySelectorAll("[data-nav]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  // Sync bottom nav (mobile)
  document.querySelectorAll("[data-bnav]").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => section.classList.remove("active-view"));
  target.classList.add("active-view");
  applyViewHeading(view);
  placePulsinhoPanel(view);
  // Desenha o gráfico da Home já no mesmo quadro em que ela aparece. Antes
  // ia para o próximo quadro: o primeiro mostrava o gráfico antigo e, logo
  // depois, ele se redesenhava — a "leve recentralizada" ao voltar para a Home.
  if (view === "dashboard") renderBoardsEvolution({ fromView: true });
  if (view === "notes") renderNotes();
  // Trocas de area precisam começar no topo imediatamente. "instant" ignora
  // qualquer scroll-behavior: smooth herdado do CSS (com "auto" o navegador
  // podia animar a subida, o que parecia a tela se reajustando sozinha).
  try { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); } catch { window.scrollTo(0, 0); }
  // A primeira renderização dos cards de Receitas/Despesas/Saldo geralmente
  // acontece com a aba Finanças ainda escondida (clientWidth 0), então o
  // autofit em fitCurrencyValues() desiste sem ajustar o tamanho da fonte
  // (ver função abaixo) e o valor fica com a fonte grande demais do CSS,
  // cortando em "R$ 2.6..." em vez de mostrar o valor inteiro. Ao entrar
  // de fato na aba (aqui, com o card já visível e com largura real), a
  // gente reexecuta o autofit pra medir e ajustar certo.
  if (view === "finances") {
    fitCurrencyValues("finReceitas", "finDespesas", "finSaldo");
    requestAnimationFrame(finMoveTabIndicator);
    if (previousView !== view) finPlayEntrance();
  }
  // Perfil: o mapa de atividade precisa da largura real (a tela estava oculta).
  // Desenha já, no mesmo quadro em que a tela aparece: no quadro seguinte
  // o mapa mudava de altura e empurrava o resto (o "tremido" do Perfil).
  if (view === "profile") pfxRenderHeatmap({ fromView: true });
  if (view === "dashboard") fitCurrencyValues("summaryFinSaldo", "dashFinReceitas", "dashFinDespesas", "dashFinSaldo");
  if (view === "autopilot" || view === "dashboard") autopilotUi.show();
  if (previousView !== view) {
    syncTabbarInk(view, { animate: true });
    animateViewEntrance(target, previousView, view);
  }

  // A navegação entre áreas ganha uma entrada real no histórico: voltar no
  // navegador/celular retorna à tela anterior em vez de sair do app.
  if (!fromHistory && previousView !== view) {
    history.pushState({ ...(history.state || {}), pnView: view, noteDetail: false }, "");
  }
}

// ── Troca de telas fluida ───────────────────────────────────────
// Ordem das abas do celular: a tela nova entra pelo lado para onde a
// pessoa "andou" (direita ao avançar, esquerda ao voltar). Telas fora da
// barra (Perfil, Configurações, Autopiloto) sobem de leve.
const VIEW_ORDER = { dashboard: 0, planner: 1, notes: 2, finances: 3 };
const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
// Elementos fixos (botões flutuantes, folhas, conversa) não podem ficar
// dentro de algo com transform — senão "pulam" durante a animação.
const VIEW_FIXED_SELECTOR = ".bp-fab, .bf-fab, .bn-detail-wrap, .bn-form-wrap, .bn-sheet-backdrop, .bd-chat-backdrop, .modal-backdrop, .bf-pop, .ap-confirm, .st-drawer, .bd-chat.is-convo";

function animateViewEntrance(target, fromView, toView) {
  if (!target || typeof target.animate !== "function" || prefersReducedMotion()) return;
  // Troca de tela só por ESMAECER — nada desliza. Qualquer deslize, mesmo
  // de 3 a 8px, somado às entradas dos cartões e ao texto em posições
  // fracionadas, era percebido como uma "tremidinha". Medido quadro a
  // quadro em todas as áreas: agora a posição dos blocos não muda.
  // Sem ler tamanhos/posições aqui (ler logo após trocar a tela obrigava o
  // navegador a recalcular a página inteira no meio da troca).
  const wrapper = target.children.length === 1 ? target.firstElementChild : target;
  const blocks = [...wrapper.children].filter((el) => !el.hidden && !el.matches(VIEW_FIXED_SELECTOR));
  const easing = "cubic-bezier(.2, .8, .2, 1)";
  // Curto e com início rápido (sensação de tela a 120 Hz): 180ms.
  blocks.slice(0, 10).forEach((el, index) => {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: Math.min(index, 4) * 18, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "backwards" });
  });
  // Título e subtítulo: o texto novo já entra quase visível e só clareia.
  [elements.viewTitle, document.querySelector("#viewSubtitle")].forEach((el) => {
    // Cancela só a animação anterior que guardamos: perguntar ao elemento
    // por todas as animações (getAnimations) forçava o navegador a
    // recalcular a página inteira no meio da troca (12–31ms).
    if (!el) return;
    el.__pnTitleAnim?.cancel();
    el.__pnTitleAnim = el.animate?.([{ opacity: 0.55 }, { opacity: 1 }], { duration: 180, easing });
  });
}

// Barra inferior: uma pílula desliza até a aba ativa.
// A barra inferior não muda de lugar ao trocar de tela: as posições das
// abas são medidas uma vez (e de novo só quando a janela muda de tamanho).
// Antes elas eram lidas a cada troca, logo depois de trocar a tela, o que
// forçava o navegador a recalcular a página inteira no meio da transição.
let tabbarInkPositions = null;
window.addEventListener("resize", () => { tabbarInkPositions = null; }, { passive: true });
function measureTabbarInk(bar) {
  const barBox = bar.getBoundingClientRect();
  if (!barBox.width) return null;
  const positions = {};
  bar.querySelectorAll(".bd-tab[data-view]").forEach((tab) => {
    const box = (tab.querySelector(".bd-tab-icon") || tab).getBoundingClientRect();
    positions[tab.dataset.view] = { x: box.left - barBox.left + box.width / 2 - 26, y: box.top - barBox.top + box.height / 2 - 15 };
  });
  return positions;
}
function syncTabbarInk(view = activeView, { animate = false } = {}) {
  const bar = document.querySelector(".bd-tabbar");
  if (!bar) return;
  if (!tabbarInkPositions) {
    // Mede no quadro seguinte, com a página já calculada.
    requestAnimationFrame(() => {
      if (!bar.getClientRects().length) return;
      tabbarInkPositions = measureTabbarInk(bar);
      if (tabbarInkPositions) syncTabbarInk(view, { animate: false });
    });
    return;
  }
  let ink = bar.querySelector(".bd-tab-ink");
  if (!ink) {
    ink = document.createElement("span");
    ink.className = "bd-tab-ink";
    ink.setAttribute("aria-hidden", "true");
    bar.prepend(ink);
  }
  const tab = bar.querySelector(`.bd-tab[data-view="${view}"]`);
  const pos = tabbarInkPositions[view];
  if (!tab || !pos) { ink.style.opacity = "0"; return; }
  const width = 52;
  const { x, y } = pos;
  ink.classList.toggle("is-instant", !animate || prefersReducedMotion() || ink.style.opacity !== "1");
  ink.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  ink.style.width = `${width}px`;
  ink.style.opacity = "1";
  if (animate && !prefersReducedMotion()) {
    tab.querySelector(".bd-tab-icon")?.animate?.([{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-2px) scale(1.12)" }, { transform: "translateY(0) scale(1)" }], { duration: 360, easing: "cubic-bezier(.3, 1.4, .5, 1)" });
  }
}

// Salvar nota: valida, monta a nota, atualiza a tela na hora e grava em
// segundo plano (sem redesenhar o app inteiro — era isso que dava o
// "travadinha" ao salvar). Título vazio usa a primeira linha do texto.
let noteFormSaving = false;
function saveNote(event) {
  event?.preventDefault();
  if (noteFormSaving) return;
  syncNoteEditorSource();
  const id = document.querySelector("#noteId").value;
  const existing = state.notes.find((note) => note.id === id);
  const newDescription = valueOf("#noteDescription");
  const items = noteDraftChecklist
    .map((item) => ({ id: item.id || crypto.randomUUID(), text: String(item.text || "").trim(), done: Boolean(item.done) }))
    .filter((item) => item.text);
  const typedTitle = valueOf("#noteTitle");
  if (!typedTitle && !newDescription && !items.length) {
    setNoteFormError("Escreva um título, um texto ou um item de checklist para salvar.");
    const titleInput = document.querySelector("#noteTitle");
    titleInput?.focus();
    document.querySelector("#noteForm")?.animate?.([
      { transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" },
    ], { duration: 320, easing: "ease-in-out" });
    return;
  }
  noteFormSaving = true;
  const title = (typedTitle || newDescription.split("\n").find((line) => line.trim()) || items[0]?.text || "Sem título").trim().slice(0, 80);
  const textColor = normalizeNoteTextColor(valueOf("#noteTextColor"));
  const descriptionChanged = !existing || existing.description !== newDescription;
  const textColorChanged = Boolean(existing) && normalizeNoteTextColor(existing.textColor) !== textColor;
  // Conteúdo com formatação (negrito, listas, marca-texto…) vem do editor;
  // texto puro continua salvo em "description" para busca, WhatsApp e IA.
  const editorHtml = noteEditorHtml();
  const descriptionHtml = editorHtml
    ? editorHtml
    : existing && !descriptionChanged && !textColorChanged
      ? existing.descriptionHtml || notePlainTextToHtml(newDescription, textColor)
      : notePlainTextToHtml(newDescription, textColor);
  const payload = {
    ...(existing || {}),
    id: id || crypto.randomUUID(),
    title,
    description: newDescription,
    category: valueOf("#noteCategory") || existing?.category || "Geral",
    folder: valueOf("#noteFolder") || existing?.folder || "Entrada",
    tags: splitValues(valueOf("#noteTags")),
    priority: NOTE_PRIORITIES.includes(valueOf("#notePriority")) ? valueOf("#notePriority") : "Media",
    checklist: items,
    attachments: splitValues(valueOf("#noteAttachments")),
    goal: valueOf("#noteGoal"),
    observations: valueOf("#noteObservations"),
    color: valueOf("#noteColor") || existing?.color || "blue",
    textColor,
    favorite: existing?.favorite || false,
    createdAt: existing?.createdAt || todayIso,
    updatedAt: new Date().toISOString(),
    convertedToTaskId: existing?.convertedToTaskId || "",
    descriptionHtml,
  };

  const isNew = !existing;
  state.notes = existing ? state.notes.map((note) => (note.id === payload.id ? payload : note)) : [payload, ...state.notes];
  resetNoteForm();
  closeNotesFormSheet();
  if (isNew && notesFolderFilter !== "all" && notesFolderFilter !== payload.folder) notesFolderFilter = "all";
  renderNotes();
  flashNoteCard(payload.id);
  if (notesPanelMode()) openNoteDetail(payload.id);
  showToast(isNew ? "Nota criada" : "Alterações salvas", isNew && !notesPanelMode()
    ? { actionLabel: "Abrir", onAction: () => openNoteDetail(payload.id) }
    : {});
  queueNotePersist();
  noteFormSaving = false;
}

// Destaque rápido no cartão que acabou de ser criado/alterado.
function flashNoteCard(id) {
  requestAnimationFrame(() => {
    const card = document.querySelector(`#notesList .bn-card[data-note-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.remove("is-flash");
    void card.offsetWidth;
    card.classList.add("is-flash");
    setTimeout(() => card.classList.remove("is-flash"), 1300);
  });
}

// Gravação em segundo plano: a tela responde primeiro; o estado vai para
// o armazenamento local/Firestore no próximo momento livre do navegador.
// Se o app for para o fundo antes disso, grava na hora.
let notePersistQueued = false;
function queueNotePersist() {
  if (notePersistQueued) return;
  notePersistQueued = true;
  const run = () => {
    if (!notePersistQueued) return;
    notePersistQueued = false;
    saveState();
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 900 });
  else setTimeout(run, 120);
}
function flushNotePersist() {
  if (!notePersistQueued) return;
  notePersistQueued = false;
  saveState();
}
// Nota aberta com alterações não salvas: grava antes de a página sumir
// (fechar aba, recarregar, app do celular indo para o fundo). saveState
// guarda no aparelho na hora e deixa a ida para a nuvem pendente, que
// conclui na próxima abertura se não der tempo agora.
function flushOpenNoteOnLeave() {
  try { if (ndCurrentNoteId && ndDirty) flushNoteDetailSave({ persist: "now" }); } catch { /* segue para o resto */ }
  flushNotePersist();
}
window.addEventListener("pagehide", flushOpenNoteOnLeave);
window.addEventListener("beforeunload", flushOpenNoteOnLeave);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushOpenNoteOnLeave(); });

function saveTask(event) {
  event.preventDefault();
  const task = createTask(valueOf("#taskTitle"), "Pendente", valueOf("#taskPriority"), valueOf("#taskDue") || todayIso);
  state.tasks.unshift(task);
  event.target.reset();
  document.querySelector("#taskDue").value = todayIso;
  saveState();
  renderAll();
  showToast("Tarefa adicionada.");
}

function saveEvent(event) {
  event.preventDefault();
  const date = valueOf("#eventDate");
  const time = valueOf("#eventTime");

  // Detecta conflito de horário: outro compromisso no mesmo dia a menos de
  // 30 minutos de distância. Não bloqueia (a pessoa pode querer mesmo assim,
  // ex.: dois compromissos rápidos e próximos), só avisa antes de salvar.
  if (date && time) {
    const [h, m] = time.split(":").map(Number);
    const newMinutes = h * 60 + m;
    const conflict = state.events.find((e) => {
      if (e.date !== date || !e.time) return false;
      const [eh, em] = e.time.split(":").map(Number);
      return Math.abs((eh * 60 + em) - newMinutes) < 30;
    });
    if (conflict) {
      if (!confirm(`Você já tem "${conflict.title}" às ${conflict.time} nesse dia, bem perto desse horário. Adicionar mesmo assim?`)) return;
    }
  }

  state.events.push({
    id: crypto.randomUUID(),
    title: valueOf("#eventTitle"),
    date,
    time,
    location: valueOf("#eventLocation") || "Sem local",
    reminder: normalizeReminderValue(valueOf("#eventReminder")),
    notes: valueOf("#eventNotes"),
  });
  event.target.reset();
  setDefaultDates();
  saveState();
  renderAll();
  showToast("Compromisso salvo com lembrete.");
}

function saveGoal(event) {
  event.preventDefault();
  state.goals.unshift({
    id: crypto.randomUUID(),
    title: valueOf("#goalTitle"),
    target: Number(valueOf("#goalTarget") || 1),
    current: 0,
    milestones: [],
  });
  event.target.reset();
  document.querySelector("#goalTarget").value = 5;
  saveState();
  renderAll();
  showToast("Meta criada.");
}

// ── Marcos/checkpoints de uma meta (ex.: "Correr 10km" → 3 marcos) ──
function addGoalMilestone(id, event) {
  event?.stopPropagation();
  const title = prompt("Nome do marco (ex.: “Primeiros 3km”):");
  if (!title || !title.trim()) return;
  const goal = state.goals.find((g) => g.id === id);
  if (!goal) return;
  addNamedGoalMilestone(goal, title.trim());
  saveState();
  renderGoals();
  renderPlannerGoalsStrip();
}

// QA 18/11: nomear a primeira etapa de uma meta numérica (ex.: 1/3) trocava
// tudo por uma lista nova de 1 etapa e o progresso ia a 0/1. Agora as etapas
// numéricas viram etapas "Etapa N" (as já concluídas continuam marcadas) e o
// nome digitado preenche a próxima etapa pendente — o progresso é mantido.
function addNamedGoalMilestone(goal, title) {
  if (!goal.milestones) goal.milestones = [];
  if (!goal.milestones.length) {
    const total = Math.max(0, Math.round(Number(goal.target) || 0));
    const done = Math.min(total, Math.max(0, Math.round(Number(goal.current) || 0)));
    if (total > 1 || done > 0) {
      goal.milestones = Array.from({ length: total }, (_, index) => ({
        id: crypto.randomUUID(), title: `Etapa ${index + 1}`, done: index < done, placeholder: true,
      }));
    }
  }
  const slot = goal.milestones.find((m) => m.placeholder && !m.done) || null;
  if (slot) { slot.title = title; delete slot.placeholder; }
  else goal.milestones.push({ id: crypto.randomUUID(), title, done: false });
  syncGoalFromMilestones(goal);
  return Boolean(slot);
}

// Com etapas nomeadas, o contador da meta acompanha as etapas marcadas
// (assim conquistas e "meta concluída" valem para os dois jeitos).
function syncGoalFromMilestones(goal) {
  const list = goal?.milestones || [];
  if (!list.length) return;
  goal.target = list.length;
  goal.current = list.filter((m) => m.done).length;
}

function toggleGoalMilestone(goalId, msId, event) {
  event?.stopPropagation();
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;
  goal.milestones = (goal.milestones || []).map((m) => (m.id === msId ? { ...m, done: !m.done } : m));
  syncGoalFromMilestones(goal);
  saveState();
  renderGoals();
  renderPlannerGoalsStrip();
}

function deleteGoalMilestone(goalId, msId, event) {
  event?.stopPropagation();
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;
  goal.milestones = (goal.milestones || []).filter((m) => m.id !== msId);
  syncGoalFromMilestones(goal);
  saveState();
  renderGoals();
  renderPlannerGoalsStrip();
}

function valueOf(selector) {
  return document.querySelector(selector).value.trim();
}

function splitValues(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

const NOTE_TEXT_COLORS = new Set(["#8b5cf6", "#ff375f", "#30d158", "#0a84ff", "#bf5af2"]);

function normalizeNoteTextColor(color) {
  const normalized = String(color || "").trim().toLowerCase();
  return NOTE_TEXT_COLORS.has(normalized) ? normalized : "";
}

function notePlainTextToHtml(text, color) {
  const safeColor = normalizeNoteTextColor(color);
  if (!safeColor || !text) return "";
  const safeText = escapeHtml(text).replace(/\n/g, "<br>");
  return `<span style="color:${safeColor}">${safeText}</span>`;
}

function setNoteDraftTextColor(color) {
  const safeColor = normalizeNoteTextColor(color);
  const input = document.querySelector("#noteTextColor");
  const description = document.querySelector("#noteDescription");
  if (input) input.value = safeColor;
  if (description) description.style.color = safeColor || "";
  document.querySelectorAll("#noteTextColorPicker [data-note-text-color]").forEach((button) => {
    const selected = normalizeNoteTextColor(button.dataset.noteTextColor) === safeColor;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function resetNoteForm() {
  const form = document.querySelector("#noteForm");
  if (!form) return;
  form.reset();
  document.querySelector("#noteId").value = "";
  setNoteEditorContent(null);
  setNotePriorityUI("Media");
  ["#noteCategory", "#noteTags", "#noteGoal", "#noteAttachments", "#noteObservations", "#noteFolder"].forEach((selector) => {
    const field = document.querySelector(selector);
    if (field) field.value = "";
  });
  document.querySelector("#noteColor").value = "blue";
  setNoteDraftTextColor("");
  noteDraftChecklist = [];
  renderNoteChecklistBuilder();
  closeNoteFolderNew();
  renderNoteFolderPicker();
  setNoteFormError("");
  document.querySelector("#noteEditingBanner").hidden = true;
  document.querySelector("#noteSaveBtnLabel").textContent = "Salvar nota";
  const formHeading = document.querySelector("#noteFormHeading");
  if (formHeading) formHeading.textContent = "Nova nota";
  paintNoteToolbar(document.querySelector("#noteEditorTools"), null, "neCmd");
}

function setNoteFormError(message) {
  const el = document.querySelector("#noteFormError");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

// ── Editor de "Nova nota" (com formatação) ─────────────────────
// O <textarea id="noteDescription"> continua existindo como fonte do
// texto puro; o editor visível guarda o HTML já higienizado.
function noteEditorHtml() {
  const editor = document.querySelector("#noteEditor");
  if (!editor) return "";
  const clean = sanitizeNoteHtml(editor.innerHTML);
  return /<(b|strong|i|em|u|s|strike|mark|ul|ol|li|a|font)\b|style=/i.test(clean) ? clean : "";
}

function syncNoteEditorSource() {
  const editor = document.querySelector("#noteEditor");
  const source = document.querySelector("#noteDescription");
  if (!editor || !source) return;
  source.value = noteHtmlToPlainText(sanitizeNoteHtml(editor.innerHTML));
  editor.classList.toggle("is-empty", !source.value.trim() && !editor.querySelector("li"));
}

function setNoteEditorContent(note) {
  const editor = document.querySelector("#noteEditor");
  if (!editor) return;
  editor.innerHTML = note?.descriptionHtml
    ? sanitizeNoteHtml(note.descriptionHtml)
    : escapeHtml(note?.description || "").replace(/\n/g, "<br>");
  syncNoteEditorSource();
}

const NOTE_PRIORITIES = ["Baixa", "Media", "Alta", "Urgente"];
function notePriorityKey(priority) {
  return { Baixa: "baixa", Media: "media", Alta: "alta", Urgente: "urgente" }[priority] || "media";
}
function notePriorityLabel(priority) {
  return { Baixa: "Baixa", Media: "Média", Alta: "Alta", Urgente: "Urgente" }[priority] || "Média";
}

// Prioridade é um grupo de rádio: exatamente um botão marcado, sempre.
function setNotePriorityUI(priority) {
  const value = NOTE_PRIORITIES.includes(priority) ? priority : "Media";
  const select = document.querySelector("#notePriority");
  if (select) select.value = value;
  document.querySelectorAll("#notePrioritySeg [data-prio]").forEach((button) => {
    const active = button.dataset.prio === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-checked", String(active));
    button.tabIndex = active ? 0 : -1;
  });
}

// Mantido pelo nome antigo (outros pontos ainda chamam).
function updateNoteEditorTools() {
  const editor = document.querySelector("#noteEditor");
  paintNoteToolbar(document.querySelector("#noteEditorTools"), document.activeElement === editor ? editor : null, "neCmd");
}

let neSavedRange = null;
function bindNoteEditor() {
  const editor = document.querySelector("#noteEditor");
  const tools = document.querySelector("#noteEditorTools");
  if (!editor || !tools || editor.dataset.bound === "1") return;
  editor.dataset.bound = "1";
  const paint = () => paintNoteToolbar(tools, noteEditorActive(editor) ? editor : null, "neCmd");
  const rememberRange = () => {
    const range = noteSelectionIn(editor);
    if (range) neSavedRange = range.cloneRange();
  };
  document.addEventListener("selectionchange", () => {
    if (!noteEditorActive(editor)) return;
    rememberRange();
    paint();
  });
  // Tocar no texto para mudar o cursor de lugar desfaz o "pendente".
  editor.addEventListener("pointerdown", () => { if (notePending?.editor === editor) notePending = null; });
  // Mantém a seleção no editor ao tocar nos botões.
  tools.addEventListener("mousedown", (event) => { if (event.target.closest("[data-ne-cmd]")) event.preventDefault(); });
  tools.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ne-cmd]");
    if (!button) return;
    const cmd = button.dataset.neCmd;
    if (cmd === "checklist") { addNoteChecklistItem(); return; }
    noteRestoreEditorSelection(editor, neSavedRange);
    if (cmd === "clear") {
      const range = noteSelectionIn(editor);
      noteClearFormatting(editor, !range || range.collapsed);
    } else {
      noteApplyCommand(editor, cmd);
    }
    scrubNoteEditorStyles(editor);
    syncNoteEditorSource();
    rememberRange();
    paint();
    requestAnimationFrame(paint);
  });
  editor.addEventListener("input", () => { notePending = null; syncNoteEditorSource(); setNoteFormError(""); });
  editor.addEventListener("focus", paint);
  editor.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== editor && !noteSelectionIn(editor)) paint(); }, 0));
  // Colar entra como texto puro (sem estilos de sites ou de outros apps).
  editor.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (typeof text !== "string") return;
    event.preventDefault();
    document.execCommand("insertText", false, text.slice(0, 20000));
  });
  syncNoteEditorSource();

  const seg = document.querySelector("#notePrioritySeg");
  seg?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prio]");
    if (button) setNotePriorityUI(button.dataset.prio);
  });
  seg?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const current = NOTE_PRIORITIES.indexOf(document.querySelector("#notePriority")?.value || "Media");
    const next = NOTE_PRIORITIES[(current + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : 3)) % 4];
    setNotePriorityUI(next);
    seg.querySelector(`[data-prio="${next}"]`)?.focus();
  });
  document.querySelector("#noteTitle")?.addEventListener("input", () => setNoteFormError(""));
  document.querySelector("#noteTitle")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault(); // Enter no título vai para o conteúdo, não salva por acidente
    editor.focus();
  });
}

// ── Checklist da nova nota ──────────────────────────────────────
// Cada item é um campo de verdade: marcar, editar, remover; Enter cria o
// próximo, Backspace num item vazio apaga e volta para o anterior.
let noteDraftChecklist = [];

// Itens longos quebram linha (campo cresce com o texto) em vez de cortar.
function autosizeCheckText(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.max(36, el.scrollHeight)}px`;
}

function renderNoteChecklistBuilder({ focusId = null, caret = "end" } = {}) {
  const list = document.querySelector("#noteChecklistItems");
  const count = document.querySelector("#noteChecklistCount");
  const section = document.querySelector("#noteChecklistBuilder");
  if (!list) return;
  const filled = noteDraftChecklist.filter((item) => item.text.trim());
  const done = filled.filter((item) => item.done).length;
  if (count) count.textContent = filled.length ? `${done}/${filled.length} concluído${filled.length === 1 ? "" : "s"}` : "Opcional";
  section?.classList.toggle("has-items", noteDraftChecklist.length > 0);
  list.innerHTML = noteDraftChecklist.map((item) => `<li class="bn-clb-row${item.done ? " is-done" : ""}" data-clb-id="${escapeHtml(item.id)}">
      <button type="button" class="bn-clb-check" data-clb-toggle aria-pressed="${item.done}" aria-label="${item.done ? "Desmarcar" : "Marcar"} item">${item.done ? bdIcon("check") : ""}</button>
      <textarea class="bn-clb-input" rows="1" maxlength="120" placeholder="Item da checklist" autocomplete="off" enterkeyhint="next" aria-label="Item da checklist">${escapeHtml(item.text)}</textarea>
      <button type="button" class="bn-clb-del" data-clb-del aria-label="Remover item">${bdIcon("x")}</button>
    </li>`).join("");
  list.querySelectorAll(".bn-clb-input").forEach(autosizeCheckText);
  if (focusId) {
    const input = list.querySelector(`[data-clb-id="${CSS.escape(focusId)}"] .bn-clb-input`);
    if (input) {
      input.focus({ preventScroll: false });
      const pos = caret === "start" ? 0 : input.value.length;
      try { input.setSelectionRange(pos, pos); } catch { /* sem seleção */ }
    }
  }
}

function addNoteChecklistItem(afterId = null, text = "") {
  const last = noteDraftChecklist.at(-1);
  if (!afterId && !text && last && !last.text.trim()) {
    renderNoteChecklistBuilder({ focusId: last.id });
    return;
  }
  const item = { id: crypto.randomUUID(), text, done: false };
  const index = afterId ? noteDraftChecklist.findIndex((entry) => entry.id === afterId) : -1;
  if (index >= 0) noteDraftChecklist.splice(index + 1, 0, item);
  else noteDraftChecklist.push(item);
  renderNoteChecklistBuilder({ focusId: item.id, caret: "start" });
}

function bindNoteChecklistBuilder() {
  const list = document.querySelector("#noteChecklistItems");
  if (!list || list.dataset.bound === "1") return;
  list.dataset.bound = "1";
  const itemOf = (el) => {
    const row = el.closest("[data-clb-id]");
    return row ? noteDraftChecklist.find((item) => item.id === row.dataset.clbId) : null;
  };
  list.addEventListener("input", (event) => {
    const input = event.target.closest(".bn-clb-input");
    const item = input && itemOf(input);
    if (!item) return;
    if (/\n/.test(input.value)) input.value = input.value.replace(/\n+/g, " ");
    item.text = input.value;
    autosizeCheckText(input);
    setNoteFormError("");
    const filled = noteDraftChecklist.filter((entry) => entry.text.trim());
    const count = document.querySelector("#noteChecklistCount");
    if (count) count.textContent = filled.length ? `${filled.filter((entry) => entry.done).length}/${filled.length} concluído${filled.length === 1 ? "" : "s"}` : "Opcional";
  });
  list.addEventListener("keydown", (event) => {
    const input = event.target.closest(".bn-clb-input");
    const item = input && itemOf(input);
    if (!item) return;
    const index = noteDraftChecklist.indexOf(item);
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.isComposing) return;
      if (!input.value.trim()) return; // item vazio: não cria outro vazio
      const caret = input.selectionStart ?? input.value.length;
      // Enter no meio do texto quebra o item em dois, como numa lista.
      const tail = input.value.slice(caret).trim();
      if (tail) { item.text = input.value.slice(0, caret).trim(); }
      addNoteChecklistItem(item.id, tail);
    } else if (event.key === "Backspace" && !input.value && noteDraftChecklist.length) {
      event.preventDefault();
      noteDraftChecklist.splice(index, 1);
      const previous = noteDraftChecklist[Math.max(0, index - 1)];
      renderNoteChecklistBuilder({ focusId: previous?.id || null });
      if (!previous) document.querySelector("#noteChecklistAdd")?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const target = noteDraftChecklist[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!target) return;
      event.preventDefault();
      list.querySelector(`[data-clb-id="${CSS.escape(target.id)}"] .bn-clb-input`)?.focus();
    }
  });
  list.addEventListener("click", (event) => {
    const item = itemOf(event.target);
    if (!item) return;
    if (event.target.closest("[data-clb-toggle]")) {
      item.done = !item.done;
      const row = event.target.closest("[data-clb-id]");
      const button = row.querySelector("[data-clb-toggle]");
      row.classList.toggle("is-done", item.done);
      button.setAttribute("aria-pressed", String(item.done));
      button.setAttribute("aria-label", `${item.done ? "Desmarcar" : "Marcar"} item`);
      button.innerHTML = item.done ? bdIcon("check") : "";
      const filled = noteDraftChecklist.filter((entry) => entry.text.trim());
      const count = document.querySelector("#noteChecklistCount");
      if (count) count.textContent = filled.length ? `${filled.filter((entry) => entry.done).length}/${filled.length} concluído${filled.length === 1 ? "" : "s"}` : "Opcional";
    } else if (event.target.closest("[data-clb-del]")) {
      const index = noteDraftChecklist.indexOf(item);
      noteDraftChecklist.splice(index, 1);
      const neighbour = noteDraftChecklist[index] || noteDraftChecklist[index - 1];
      renderNoteChecklistBuilder({ focusId: neighbour?.id || null });
      if (!neighbour) document.querySelector("#noteChecklistAdd")?.focus();
    }
  });
  // Ao sair de um item vazio (que não seja o último em edição), ele some.
  list.addEventListener("focusout", (event) => {
    const input = event.target.closest(".bn-clb-input");
    const item = input && itemOf(input);
    if (!item || item.text.trim()) return;
    setTimeout(() => {
      const stillThere = noteDraftChecklist.includes(item);
      const focusInside = list.contains(document.activeElement) || document.activeElement?.id === "noteChecklistAdd";
      if (!stillThere || item.text.trim() || focusInside) return;
      noteDraftChecklist = noteDraftChecklist.filter((entry) => entry !== item);
      renderNoteChecklistBuilder();
    }, 0);
  });
  document.querySelector("#noteChecklistAdd")?.addEventListener("click", () => addNoteChecklistItem());
}

// ── Pasta da nota (substitui o antigo "Organizar") ─────────────
let noteExtraFolders = [];
function noteFolderOptions() {
  const counts = new Map();
  state.notes.forEach((note) => {
    const name = String(note.folder || "").trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  });
  noteExtraFolders.forEach((name) => { if (!counts.has(name)) counts.set(name, 0); });
  if (!counts.has("Entrada")) counts.set("Entrada", 0);
  return [...counts.keys()].sort((a, b) => (a === "Entrada" ? -1 : b === "Entrada" ? 1 : (counts.get(b) - counts.get(a)) || a.localeCompare(b, "pt-BR")));
}

function renderNoteFolderPicker() {
  const root = document.querySelector("#noteFolderPicker");
  if (!root) return;
  const current = document.querySelector("#noteFolder")?.value || "Entrada";
  const options = noteFolderOptions();
  if (!options.includes(current)) options.push(current);
  root.innerHTML = options.map((name) => `<button type="button" role="radio" class="bn-folder-chip" data-folder="${escapeHtml(name)}" aria-checked="${name === current}" tabindex="${name === current ? 0 : -1}">${bdIcon("folder")}<span>${escapeHtml(name)}</span></button>`).join("")
    + `<button type="button" class="bn-folder-chip is-add" data-folder-new aria-expanded="${!document.querySelector("#noteFolderNewRow")?.hidden}">${bdIcon("plus")}<span>Nova pasta</span></button>`;
}

function setNoteFolderValue(name) {
  const input = document.querySelector("#noteFolder");
  if (input) input.value = name || "";
  renderNoteFolderPicker();
}

function openNoteFolderNew() {
  const row = document.querySelector("#noteFolderNewRow");
  if (!row) return;
  row.hidden = false;
  renderNoteFolderPicker();
  setTimeout(() => document.querySelector("#noteFolderNewInput")?.focus(), 30);
}

function closeNoteFolderNew() {
  const row = document.querySelector("#noteFolderNewRow");
  if (row) row.hidden = true;
  const input = document.querySelector("#noteFolderNewInput");
  if (input) input.value = "";
}

function commitNoteFolderNew() {
  const input = document.querySelector("#noteFolderNewInput");
  const name = String(input?.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) { input?.focus(); return; }
  const existing = noteFolderOptions().find((folder) => folder.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"));
  if (!existing) noteExtraFolders.push(name);
  closeNoteFolderNew();
  setNoteFolderValue(existing || name);
  document.querySelector(`#noteFolderPicker [data-folder="${CSS.escape(existing || name)}"]`)?.focus();
}

function bindNoteFolderPicker() {
  const root = document.querySelector("#noteFolderPicker");
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-folder-new]")) {
      const row = document.querySelector("#noteFolderNewRow");
      if (row?.hidden) openNoteFolderNew(); else { closeNoteFolderNew(); renderNoteFolderPicker(); }
      return;
    }
    const chip = event.target.closest("[data-folder]");
    if (chip) setNoteFolderValue(chip.dataset.folder);
  });
  root.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const chips = [...root.querySelectorAll("[data-folder]")];
    const index = chips.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = chips[(index + (event.key === "ArrowRight" ? 1 : chips.length - 1)) % chips.length];
    setNoteFolderValue(next.dataset.folder);
    root.querySelector(`[data-folder="${CSS.escape(next.dataset.folder)}"]`)?.focus();
  });
  document.querySelector("#noteFolderNewOk")?.addEventListener("click", commitNoteFolderNew);
  document.querySelector("#noteFolderNewCancel")?.addEventListener("click", () => { closeNoteFolderNew(); renderNoteFolderPicker(); });
  document.querySelector("#noteFolderNewInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); commitNoteFolderNew(); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeNoteFolderNew(); renderNoteFolderPicker(); }
  });
}

function bindNoteQuickControls() {
  bindNoteEditor();
  bindNoteChecklistBuilder();
  bindNoteFolderPicker();
  renderNoteFolderPicker();
  renderNoteChecklistBuilder();
  // "Limpar" e "Cancelar edição": ligados uma única vez (antes eram dois
  // listeners iguais em lugares diferentes, e o formulário limpava duas vezes).
  const clear = () => {
    resetNoteForm();
    document.querySelector("#noteTitle")?.focus();
  };
  const resetBtn = document.querySelector("#resetNoteForm");
  if (resetBtn && resetBtn.dataset.bound !== "1") { resetBtn.dataset.bound = "1"; resetBtn.addEventListener("click", clear); }
  const cancelBtn = document.querySelector("#cancelEditNote");
  if (cancelBtn && cancelBtn.dataset.bound !== "1") { cancelBtn.dataset.bound = "1"; cancelBtn.addEventListener("click", clear); }
}

// Faz os textareas marcados crescerem junto com o texto, em vez de
// quebrarem o layout do cartão ou esconderem conteúdo num scroll interno.
function enableAutogrowTextareas() {
  document.querySelectorAll("textarea.autogrow").forEach((textarea) => {
    const resize = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    if (!textarea.dataset.autogrowBound) {
      textarea.addEventListener("input", resize);
      textarea.dataset.autogrowBound = "1";
    }
    resize();
  });
}

// ── Relógio do app ───────────────────────────────────────────────
// A cada 30s (e sempre que o app volta para a frente) confere a data.
// Virou o dia: atualiza "hoje" e redesenha tudo. Mesmo dia: só refaz o
// que depende da hora (compromissos que já passaram, foco da semana,
// dica do Pulsinho) — barato e sem mexer em formulários abertos.
// Uma regra só para "Bom dia/Boa tarde/Boa noite" (madrugada é noite),
// usada no título, no balão e na conversa do Pulsinho.
function greetingForHour(hour) {
  return hour < 5 ? "Boa noite" : hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
}

function refreshTodayIfNeeded() {
  const now = toLocalIso(new Date());
  if (now === todayIso) return false;
  const previous = todayIso;
  todayIso = now;
  tomorrowIso = offsetDate(1);
  if (plannerDayDate === previous) plannerDayDate = now;
  if (plannerWeekAnchor === previous) plannerWeekAnchor = now;
  if (plannerMonthAnchor.slice(0, 7) === previous.slice(0, 7)) plannerMonthAnchor = now;
  if (plannerMonthSelected === previous) plannerMonthSelected = now;
  renderAll();
  return true;
}

function refreshTimeSensitiveViews() {
  if (refreshTodayIfNeeded()) return;
  if (document.hidden) return;
  applyViewHeading(activeView); // saudação acompanha a hora
  if (activeView === "dashboard") renderBoardsToday();
  if (activeView === "planner") {
    renderPlannerFocus();
    renderPlannerTip();
    if (plannerActiveTab === "list") renderPlannerAgenda();
  }
}

let liveClockTimer = 0;
function startLiveClock() {
  if (liveClockTimer) return;
  liveClockTimer = setInterval(refreshTimeSensitiveViews, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTimeSensitiveViews(); });
  window.addEventListener("focus", refreshTimeSensitiveViews);
}

function renderAll() {
  setDefaultDates();
  renderDashboard();
  renderPlanner();
  renderNotes();
  renderTasks();
  renderCalendar();
  renderGoals();
  renderFinances();
  renderProfile();
  renderSettings();
  refreshProfileAvatar();
}

// Campo de data compacto: o seletor nativo continua (toque abre o
// calendário do sistema), mas o texto exibido é curto e nunca quebra
// linha — no iPhone "16 de nov. de 2026" estourava o campo.
function finPrettyDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return "Escolher data";
  const shift = (days) => {
    const date = new Date(`${todayIso}T12:00:00`);
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  if (iso === todayIso) return "Hoje";
  if (iso === shift(-1)) return "Ontem";
  if (iso === shift(1)) return "Amanhã";
  const [year, month, day] = iso.split("-").map(Number);
  const base = `${day} ${BD_MONTHS[month - 1]}`;
  return year === Number(todayIso.slice(0, 4)) ? base : `${base} ${year}`;
}

function enhanceCompactDateInput(input, label) {
  if (!input || !label || input.dataset.compactDate === "1") return;
  input.dataset.compactDate = "1";
  const update = () => { label.textContent = finPrettyDate(input.value); };
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (native?.get && native?.set) {
    Object.defineProperty(input, "value", {
      configurable: true,
      get() { return native.get.call(this); },
      set(next) { native.set.call(this, next); update(); },
    });
  }
  input.addEventListener("input", update);
  input.addEventListener("change", update);
  input.addEventListener("click", () => { try { input.showPicker?.(); } catch { /* navegador sem showPicker */ } });
  update();
}

function setDefaultDates() {
  const taskDue = document.querySelector("#taskDue");
  if (taskDue) taskDue.value ||= todayIso;
  const eventDate = document.querySelector("#eventDate");
  if (eventDate) eventDate.value ||= todayIso;
  const eventTime = document.querySelector("#eventTime");
  if (eventTime) eventTime.value ||= "09:00";
  const expDate = document.querySelector("#expenseDate");
  enhanceCompactDateInput(expDate, document.querySelector("#expenseDateLabel"));
  if (expDate) expDate.value ||= todayIso;
}

function queryFilter(items, fields) {
  const query = elements.globalSearch.value.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => fields.some((field) => String(item[field] || "").toLowerCase().includes(query)));
}

// ── XP/Nível: cálculo único, reaproveitado pelo Início e pelo Perfil.
// Antes esse cálculo só existia dentro do renderDashboard — extraído
// aqui pra não duplicar a fórmula em dois lugares. ──
function calculateXpStats() {
  const doneTotal = state.tasks.filter((task) => task.status === "Concluida").length;
  const score = doneTotal * 25 + state.goals.reduce((sum, goal) => sum + goal.current * 10, 0);
  const xpPerLevel = 150;
  const level = Math.max(1, Math.floor(score / xpPerLevel) + 1);
  const xpIntoLevel = score % xpPerLevel;
  const levelProgress = Math.min(100, Math.round((xpIntoLevel / xpPerLevel) * 100));
  return { score, level, levelProgress, xpIntoLevel, xpPerLevel };
}

// ── Conquistas: lista única de regras, reaproveitada pela tela antiga
// de Metas e pelo novo Perfil. ──
function getAchievementsList() {
  const done = state.tasks.filter((task) => task.status === "Concluida").length;
  const favorites = state.notes.filter((note) => note.favorite).length;
  const completedGoals = state.goals.filter((goal) => goal.current >= goal.target).length;
  const streak = calculateStreak();
  const { level } = calculateXpStats();
  return [
    { title: "Primeiro check-in", detail: "Concluir uma tarefa", iconName: "checkCircle", current: done, target: 1, unlocked: done >= 1 },
    { title: "Dia produtivo", detail: "Concluir três tarefas", iconName: "zap", current: done, target: 3, unlocked: done >= 3 },
    { title: "Maratonista", detail: "Concluir dez tarefas", iconName: "flame", current: done, target: 10, unlocked: done >= 10 },
    { title: "Centena", detail: "Concluir cem tarefas", iconName: "trophy", current: done, target: 100, unlocked: done >= 100 },
    { title: "Biblioteca viva", detail: "Favoritar uma anotação", iconName: "star", current: favorites, target: 1, unlocked: favorites >= 1 },
    { title: "Colecionador de ideias", detail: "Ter dez anotações", iconName: "notebook", current: state.notes.length, target: 10, unlocked: state.notes.length >= 10 },
    { title: "Meta batida", detail: "Completar uma meta", iconName: "target", current: completedGoals, target: 1, unlocked: completedGoals >= 1 },
    { title: "Trilha de metas", detail: "Completar três metas", iconName: "flag", current: completedGoals, target: 3, unlocked: completedGoals >= 3 },
    { title: "Constância", detail: "Sequência de 3 dias", iconName: "calendarCheck", current: streak, target: 3, unlocked: streak >= 3 },
    { title: "Semana cheia", detail: "Sequência de 7 dias", iconName: "flame", current: streak, target: 7, unlocked: streak >= 7 },
    { title: "Organizador", detail: "Ter cinco compromissos", iconName: "calendarWeek", current: state.events.length, target: 5, unlocked: state.events.length >= 5 },
    { title: "Em ascensão", detail: "Alcançar o nível 5", iconName: "sparkle", current: level, target: 5, unlocked: level >= 5 },
  ];
}

// ============================================================
// Sistema visual dos quadros — shell e Dashboard
// ============================================================
const BD_WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const BD_MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
let bdEvoRange = 30;

function bdIcon(id) {
  return `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
}

// Carrossel horizontal com bolinhas: só aparecem quando há o que deslizar,
// acompanham a rolagem e, ao tocar, levam até o cartão correspondente.
function bdSetupPager(scroller, dots, itemSelector) {
  if (!scroller || !dots || scroller.dataset.pager === "1") return;
  scroller.dataset.pager = "1";
  const visibleItems = () => [...scroller.querySelectorAll(itemSelector)].filter((el) => el.getClientRects().length > 0);
  const activeIndex = (items) => {
    if (!items.length) return 0;
    if (scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 4) return items.length - 1;
    const start = scroller.getBoundingClientRect().left + (parseFloat(getComputedStyle(scroller).paddingLeft) || 0);
    let best = 0;
    let bestDistance = Infinity;
    items.forEach((el, index) => {
      const distance = Math.abs(el.getBoundingClientRect().left - start);
      if (distance < bestDistance) { best = index; bestDistance = distance; }
    });
    return best;
  };
  const paint = () => {
    // Tela escondida (outra aba aberta): não mexe nas bolinhas. Antes elas
    // sumiam aqui e voltavam ao reabrir a Home, empurrando tudo abaixo dos
    // cartões alguns pixels para baixo.
    if (!scroller.clientWidth) return;
    const items = visibleItems();
    const overflow = scroller.scrollWidth > scroller.clientWidth + 4 && items.length > 1;
    dots.style.display = overflow ? "" : "none";
    if (!overflow) return;
    if (dots.children.length !== items.length || dots.firstElementChild?.tagName !== "BUTTON") {
      dots.removeAttribute("aria-hidden");
      dots.setAttribute("role", "tablist");
      dots.innerHTML = items.map((_, index) => `<button type="button" role="tab" aria-label="Cartão ${index + 1} de ${items.length}"></button>`).join("");
    }
    const active = activeIndex(items);
    [...dots.children].forEach((dot, index) => {
      dot.classList.toggle("active", index === active);
      dot.setAttribute("aria-selected", String(index === active));
    });
  };
  dots.addEventListener("click", (event) => {
    const dot = event.target.closest("button");
    if (!dot) return;
    const items = visibleItems();
    const target = items[[...dots.children].indexOf(dot)];
    if (!target) return;
    const padding = parseFloat(getComputedStyle(scroller).paddingLeft) || 0;
    const left = target.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft - padding;
    scroller.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  });
  let frame = 0;
  scroller.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(paint);
  }, { passive: true });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => paint());
    observer.observe(scroller);
    scroller.querySelectorAll(itemSelector).forEach((el) => observer.observe(el));
  }
  window.addEventListener("resize", paint, { passive: true });
  paint();
}

function bdFirstName() {
  return (getUser()?.name || "Usuário").trim().split(/\s+/)[0] || "Usuário";
}

function bdInitials(name) {
  const parts = String(name || "U").trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) || "U";
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return `${first}${last}`.toUpperCase();
}

function bdFormatBoardDate(date = new Date()) {
  return `${BD_WEEKDAYS[date.getDay()]}, ${String(date.getDate()).padStart(2, "0")} de ${BD_MONTHS[date.getMonth()]} de ${date.getFullYear()}`;
}

// Título + subtítulo do cabeçalho de cada área (seguem os quadros).
let onboardingController = null;
let onboardingReady = false;
function getOnboarding() {
  if (onboardingController) return onboardingController;
  const root = document.querySelector("#onboardingRoot");
  if (!root) return null;
  onboardingController = createOnboarding({
    root,
    getState: () => state,
    patchState: (patch) => { Object.assign(state, patch); saveState(); renderAll(); },
    setWorkspace: (workspaceId) => setActiveFinanceWorkspace(workspaceId),
    startWhatsappLink,
    requestPush: () => window.requestNotificationPermission?.(),
    botNumber: WHATSAPP_BOT_NUMBER,
    openView: (viewName, options = {}) => {
      setView(viewName);
      if (options.focus) requestAnimationFrame(() => document.querySelector(options.focus)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    },
    toast: (message) => showToast(message),
    firstName: () => bdFirstName(),
  });
  return onboardingController;
}

// Ilustração animada ao lado do título (no lugar dos emojis 👋 e 📝, que
// mudam de aparência em cada aparelho): sol nascendo de manhã, sol à tarde,
// lua com estrelas à noite e um bloquinho sendo escrito nas Notas.
function viewHeadingGlyph(view, hour) {
  if (view === "dashboard") {
    if (hour >= 5 && hour < 12) {
      return `<svg class="pn-glyph pn-glyph--sunrise" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="pgRise" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe17a"/><stop offset="1" stop-color="#ff8f4a"/></linearGradient><clipPath id="pgRiseClip"><rect x="0" y="0" width="32" height="22"/></clipPath></defs><g class="pg-rays" stroke="#ffb547" stroke-width="2.2" stroke-linecap="round"><path d="M16 4.5v3"/><path d="M6.6 8.6l2.1 2.1"/><path d="M25.4 8.6l-2.1 2.1"/><path d="M3 17h3"/><path d="M26 17h3"/></g><g clip-path="url(#pgRiseClip)"><circle class="pg-sun" cx="16" cy="21" r="7" fill="url(#pgRise)"/></g><path d="M4 22.5h24" stroke="#ff9f5a" stroke-width="2.2" stroke-linecap="round"/><path class="pg-haze" d="M9 26.5h14" stroke="#ffb98a" stroke-width="2" stroke-linecap="round" opacity=".7"/></svg>`;
    }
    if (hour >= 12 && hour < 18) {
      return `<svg class="pn-glyph pn-glyph--sun" viewBox="0 0 32 32" aria-hidden="true"><defs><radialGradient id="pgSun" cx="38%" cy="34%" r="70%"><stop offset="0" stop-color="#fff4b8"/><stop offset=".55" stop-color="#ffc83d"/><stop offset="1" stop-color="#ff9640"/></radialGradient></defs><g class="pg-rays" stroke="#ffb547" stroke-width="2.3" stroke-linecap="round"><path d="M16 2.8v3.4"/><path d="M16 25.8v3.4"/><path d="M2.8 16h3.4"/><path d="M25.8 16h3.4"/><path d="M6.7 6.7l2.4 2.4"/><path d="M22.9 22.9l2.4 2.4"/><path d="M6.7 25.3l2.4-2.4"/><path d="M22.9 9.1l2.4-2.4"/></g><circle class="pg-sun" cx="16" cy="16" r="7.4" fill="url(#pgSun)"/></svg>`;
    }
    return `<svg class="pn-glyph pn-glyph--moon" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="pgMoon" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e6dcff"/><stop offset="1" stop-color="#9b86ff"/></linearGradient><mask id="pgMoonCut"><rect width="32" height="32" fill="#fff"/><circle cx="21.5" cy="11" r="8.2" fill="#000"/></mask></defs><circle class="pg-moon" cx="14.5" cy="17.5" r="10" fill="url(#pgMoon)" mask="url(#pgMoonCut)"/><path class="pg-star pg-star--a" d="M24 4.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="#ffe17a"/><circle class="pg-star pg-star--b" cx="28" cy="13" r="1.3" fill="#9fe8ff"/><circle class="pg-star pg-star--c" cx="19.5" cy="11" r="1" fill="#fff"/></svg>`;
  }
  if (view === "planner") {
    // Calendário com argolas que balançam e um ✓ sendo marcado no dia.
    return `<svg class="pn-glyph pn-glyph--planner" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="pgCal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fe3ff"/><stop offset="1" stop-color="#4f8dff"/></linearGradient><linearGradient id="pgCalTop" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#6a5cff"/></linearGradient></defs><rect x="4" y="6.5" width="24" height="21.5" rx="5" fill="url(#pgCal)"/><path d="M4 11.5a5 5 0 015-5h14a5 5 0 015 5V13H4z" fill="url(#pgCalTop)"/><g class="pg-rings" fill="none" stroke="#e8e4ff" stroke-width="2.4" stroke-linecap="round"><path class="pg-ring pg-ring--a" d="M10.5 4v5"/><path class="pg-ring pg-ring--b" d="M21.5 4v5"/></g><g fill="#fff" opacity=".55"><circle cx="9.5" cy="17.5" r="1.3"/><circle cx="16" cy="17.5" r="1.3"/><circle cx="9.5" cy="23" r="1.3"/></g><circle class="pg-day" cx="21.5" cy="21.5" r="4.6" fill="#fff"/><path class="pg-tick" d="M19.3 21.6l1.6 1.6 3-3.2" fill="none" stroke="#2fcf8b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" pathLength="10"/></svg>`;
  }
  if (view === "finances") {
    // Barras crescendo, linha de tendência subindo e uma moeda que quica.
    return `<svg class="pn-glyph pn-glyph--finance" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="pgBar" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#16a974"/><stop offset="1" stop-color="#5ff0b0"/></linearGradient><radialGradient id="pgCoin" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#fff2b0"/><stop offset=".6" stop-color="#ffc83d"/><stop offset="1" stop-color="#e09400"/></radialGradient></defs><rect class="pg-bar pg-bar--1" x="4" y="18" width="5.2" height="10" rx="1.8" fill="url(#pgBar)" opacity=".75"/><rect class="pg-bar pg-bar--2" x="11.4" y="13.5" width="5.2" height="14.5" rx="1.8" fill="url(#pgBar)" opacity=".88"/><rect class="pg-bar pg-bar--3" x="18.8" y="9" width="5.2" height="19" rx="1.8" fill="url(#pgBar)"/><path class="pg-trend" d="M4.5 14.5l7-5 5 2.5 7-6.5" fill="none" stroke="#8b7bff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" pathLength="10"/><g class="pg-coin"><circle cx="26.5" cy="6.8" r="4.3" fill="url(#pgCoin)" stroke="#c98500" stroke-width=".9"/><circle cx="26.5" cy="6.8" r="2.5" fill="none" stroke="#fff5c7" stroke-width="1" opacity=".85"/></g></svg>`;
  }
  if (view === "notes") {
    return `<svg class="pn-glyph pn-glyph--notes" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="pgPad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9d8bff"/><stop offset="1" stop-color="#6a5cff"/></linearGradient></defs><rect x="4.5" y="4" width="18" height="23" rx="4" fill="url(#pgPad)"/><path class="pg-line pg-line--1" d="M8.5 11h10" stroke="#fff" stroke-width="2" stroke-linecap="round" pathLength="10"/><path class="pg-line pg-line--2" d="M8.5 15.5h10" stroke="#fff" stroke-width="2" stroke-linecap="round" pathLength="10" opacity=".85"/><path class="pg-line pg-line--3" d="M8.5 20h6" stroke="#fff" stroke-width="2" stroke-linecap="round" pathLength="10" opacity=".7"/><g class="pg-pencil"><path d="M19.6 25.6l1-4.1 7.6-7.6a1.9 1.9 0 0 1 2.7 2.7l-7.6 7.6z" fill="#ffc83d" stroke="#0d1424" stroke-width="1.2" stroke-linejoin="round"/><path d="M19.6 25.6l1-4.1 3.1 3.1z" fill="#ffe7c2" stroke="#0d1424" stroke-width="1.2" stroke-linejoin="round"/><path d="M27.2 14.9l2.7 2.7" stroke="#0d1424" stroke-width="1.2"/></g></svg>`;
  }
  return "";
}

function applyViewHeading(view) {
  const first = bdFirstName();
  const hour = new Date().getHours();
  const greeting = greetingForHour(hour);
  const compact = window.matchMedia("(max-width: 760px)").matches; // textos curtos do quadro mobile
  const headings = {
    dashboard: [`${greeting}, ${first}!`, compact ? "Seu panorama de hoje." : "Aqui está o seu panorama de hoje."],
    planner: ["Planner", "Organize suas tarefas, compromissos e metas."],
    notes: [`Notas, ${first}!`, compact ? "Capture ideias, organize e aja." : "Capture ideias, organize informações e transforme em ação."],
    finances: ["Finanças", "Organize, acompanhe e evolua suas finanças."],
    autopilot: ["", ""],
    profile: ["Perfil", "Seu progresso, conquistas e estatísticas"],
    settings: ["Configurações", "Gerencie sua conta, preferências, integrações e segurança."],
  };
  const [title, subtitle] = headings[view] || [viewTitles[view] || "", ""];
  if (elements.viewTitle) {
    const glyph = viewHeadingGlyph(view, hour);
    elements.viewTitle.innerHTML = `${escapeHtml(title)}${glyph}`;
    elements.viewTitle.style.display = title ? "" : "none";
  }
  const subtitleEl = document.querySelector("#viewSubtitle");
  if (subtitleEl) subtitleEl.textContent = subtitle;
  // Não usar data-view aqui: bindNavigation liga um clique de navegação em todo [data-view].
  document.body.dataset.activeView = view;
  const dateEl = document.querySelector("#bdDateText");
  if (dateEl) dateEl.textContent = bdFormatBoardDate();
}

// O painel do Pulsinho é um só: no Autopilot ele vai para a coluna da direita
// (como no quadro) e volta para o Início ao sair. A conversa continua a mesma.
function placePulsinhoPanel(view) {
  if (view !== "dashboard") releasePulsinhoFit();
  const chat = document.querySelector("#bdChat");
  const slot = document.querySelector("#apChatSlot");
  const home = document.querySelector("#dashboardView .bd-dash");
  if (!chat || !slot || !home) return;
  if (view === "autopilot") {
    if (chat.parentElement !== slot) slot.appendChild(chat);
    renderAutopilotAiPreference();
  } else if (chat.parentElement !== home) {
    const confirm = chat.querySelector("#autopilotConfirmModal");
    if (confirm) { confirm.hidden = true; document.body.appendChild(confirm); }
    chat.classList.remove("has-ap-confirm");
    home.appendChild(chat);
  }
}

const AP_AI_LABELS = { auto: "Automático · Claude · GPT", openai: "GPT (OpenAI)", anthropic: "Claude (Anthropic)" };
function renderAutopilotAiPreference() {
  const pref = state?.aiProviderPreference || "auto";
  const label = document.querySelector("#apAiLabel");
  if (label) label.textContent = AP_AI_LABELS[pref] || AP_AI_LABELS.auto;
  document.querySelectorAll("[data-ai-pref]").forEach((button) => {
    button.classList.toggle("active", button.dataset.aiPref === pref);
    button.setAttribute("aria-checked", String(button.dataset.aiPref === pref));
  });
  const select = document.querySelector("#pulsinhoAiPreference");
  if (select && document.activeElement !== select) select.value = pref;
}

function bindAutopilotBoard() {
  const button = document.querySelector("#apAiBtn");
  const menu = document.querySelector("#apAiMenu");
  if (!button || !menu) return;
  const close = () => { menu.hidden = true; button.setAttribute("aria-expanded", "false"); };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    renderAutopilotAiPreference();
    menu.hidden = !menu.hidden;
    button.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector(".active, [data-ai-pref]")?.focus();
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-ai-pref]");
    if (!option) return;
    state.aiProviderPreference = ["openai", "anthropic"].includes(option.dataset.aiPref) ? option.dataset.aiPref : "auto";
    saveState();
    renderAutopilotAiPreference();
    close();
    showToast(`IA do Pulsinho: ${AP_AI_LABELS[state.aiProviderPreference].split(" · ")[0]}.`);
  });
  document.addEventListener("click", (event) => { if (!menu.hidden && !event.target.closest(".ap-ai")) close(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !menu.hidden) { close(); button.focus(); } });
  renderAutopilotAiPreference();
}

function renderShellUser(user) {
  const name = user?.name || "Usuário";
  const photoURL = state?.profilePhoto || currentUser?.photoURL || "";
  const avatar = document.querySelector("#bdUserAvatar");
  if (avatar) {
    avatar.innerHTML = photoURL ? `<img src="${escapeHtml(photoURL)}" alt="" />` : escapeHtml(bdInitials(name));
  }
  const nameEl = document.querySelector("#bdUserName");
  if (nameEl) nameEl.textContent = name;
  if (isLocalDesignPreview) {
    const planEl = document.querySelector("#bdUserPlan");
    if (planEl) planEl.textContent = "Plano Pro";
  }
}

// ── Dados do dashboard ─────────────────────────────────────
function bdWorkspaceFinances() {
  return (state.finances || []).filter((f) => f.date && (f.workspaceId || "personal") === activeWorkspaceId);
}

function bdSignedAmount(entry) {
  const amount = Number(entry.amount) || 0;
  return entry.type === "receita" ? amount : -amount;
}

// Mesmo critério do saldo do app: sobra do mês anterior (se fechado) + lançamentos do mês até a data.
function bdBalanceOn(iso, entries = bdWorkspaceFinances()) {
  const monthKey = iso.slice(0, 7);
  return getCarryOverBalance(monthKey, activeWorkspaceId)
    + entries.filter((f) => f.date.startsWith(monthKey) && f.date <= iso).reduce((sum, f) => sum + bdSignedAmount(f), 0);
}

function bdBalanceSeries(range) {
  const entries = bdWorkspaceFinances();
  const net = new Map();
  for (const entry of entries) net.set(entry.date, (net.get(entry.date) || 0) + bdSignedAmount(entry));
  const monthly = range > 120;
  const days = range; // 365 no Início (12 meses), 180 em Finanças (6 meses)
  const end = new Date();
  end.setHours(12, 0, 0, 0);
  const cursor = new Date(end);
  cursor.setDate(cursor.getDate() - (days - 1));
  const points = [];
  let running = 0;
  let runningMonth = "";
  while (cursor <= end) {
    const iso = toLocalIso(cursor);
    const monthKey = iso.slice(0, 7);
    if (monthKey !== runningMonth) {
      runningMonth = monthKey;
      running = getCarryOverBalance(monthKey, activeWorkspaceId)
        + entries.filter((f) => f.date.startsWith(monthKey) && f.date < iso).reduce((sum, f) => sum + bdSignedAmount(f), 0);
    }
    running += net.get(iso) || 0;
    points.push({ date: iso, value: running });
    cursor.setDate(cursor.getDate() + 1);
  }
  if (!monthly) return points;
  const byMonth = new Map();
  for (const point of points) byMonth.set(point.date.slice(0, 7), point);
  return [...byMonth.values()];
}

function bdNiceStep(raw) {
  if (!(raw > 0)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / 10 ** exp;
  const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

// Curva suave MONOTÔNICA (Fritsch–Carlson): passa por todos os pontos sem
// "inventar" picos ou vales. A versão anterior (Catmull-Rom) fazia o saldo
// subir antes de uma queda — um valor que nunca existiu — e podia levar a
// linha para fora da área do gráfico.
function bdSmoothPath(coords) {
  const n = coords.length;
  if (n < 3) return coords.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = coords[i + 1][0] - coords[i][0] || 1e-6;
    slope[i] = (coords[i + 1][1] - coords[i][1]) / dx[i];
  }
  const tangent = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) tangent[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  let d = `M${coords[0][0].toFixed(1)} ${coords[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [x0, y0] = coords[i];
    const [x1, y1] = coords[i + 1];
    const h = dx[i] / 3;
    d += ` C${(x0 + h).toFixed(1)} ${(y0 + tangent[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)} ${(y1 - tangent[i + 1] * h).toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return d;
}

function bdAxisMoney(value) {
  return `R$ ${Math.round(value).toLocaleString("pt-BR")}`;
}

function bdPointLabel(point, monthly) {
  const [year, month, day] = point.date.split("-").map(Number);
  return monthly ? `${BD_MONTHS[month - 1]}/${String(year).slice(2)}` : `${day} ${BD_MONTHS[month - 1]}`;
}

function renderBoardsEvolution(opts = {}) {
  drawBalanceChart(document.querySelector("#bdEvoChart"), bdEvoRange, "bdEvoFill", opts);
}

function renderBoardsSparkline(series) {
  const svg = document.querySelector("#bdBalanceSpark");
  if (!svg) return;
  const pts = series.slice(-30);
  if (pts.length < 2) { svg.innerHTML = ""; return; }
  const min = Math.min(...pts.map((p) => p.value));
  const max = Math.max(...pts.map((p) => p.value));
  const span = max - min || 1;
  const coords = pts.map((p, i) => [2 + (i / (pts.length - 1)) * 194, 58 - ((p.value - min) / span) * 46]);
  const line = bdSmoothPath(coords);
  svg.innerHTML = `<defs><linearGradient id="bdSparkFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#25d388" stop-opacity=".45"/><stop offset="1" stop-color="#25d388" stop-opacity="0"/></linearGradient></defs><path d="${line} L200 70 L0 70 Z" fill="url(#bdSparkFill)"/><path d="${line}" fill="none" stroke="#25d388" stroke-width="1.8" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
}

// ── Gastos por categoria: rosca + ranking ───────────────────────
// Paleta categórica validada (contraste e daltonismo) para os dois temas;
// a ordem é fixa e "Outros" fica sempre no cinza neutro. A identidade de
// cada fatia nunca depende só da cor: a lista ao lado traz ícone e nome.
const BD_CAT_COLORS = 6;

function bdCategoryLabel(id) {
  return String(findCategory(id).label || "Outros").replace(/^[^\p{L}\p{N}]+/u, "").trim() || "Outros";
}

function bdCategoryName(id) {
  const label = bdCategoryLabel(id);
  return label.length > 9 ? `${label.slice(0, 8)}.` : label;
}

function bdArcPath(cx, cy, r, start, end) {
  const a0 = (start - 90) * Math.PI / 180;
  const a1 = (end - 90) * Math.PI / 180;
  const large = end - start > 180 ? 1 : 0;
  return `M${(cx + r * Math.cos(a0)).toFixed(2)} ${(cy + r * Math.sin(a0)).toFixed(2)} A${r} ${r} 0 ${large} 1 ${(cx + r * Math.cos(a1)).toFixed(2)} ${(cy + r * Math.sin(a1)).toFixed(2)}`;
}

let bdCatsAnimated = false;
// Categoria escolhida no gráfico (continua escolhida quando a tela redesenha).
let bdCatsSelected = null;
let bdCatsData = null;

// Gastos por categoria: rosca com pontas arredondadas e respiro entre as
// fatias. Tocar numa fatia (ou na linha da legenda) destaca a categoria:
// a fatia sai um pouco para fora, o centro mostra nome, valor e % e o
// resumo embaixo conta quantos lançamentos e qual foi o maior. Tocar de
// novo (ou no centro) volta ao total. Nada ali é texto selecionável.
function renderBoardsCategories(monthEntries) {
  const host = document.querySelector("#bdCats");
  if (!host) return;
  host.style.gridTemplateColumns = "";
  const expenses = monthEntries.filter((f) => f.type === "despesa");
  const total = expenses.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
  if (!total) {
    bdCatsData = null;
    host.innerHTML = `<div class="bd-cats-empty">
      <span class="bd-cats-empty-ring" aria-hidden="true">${bdIcon("piggy")}</span>
      <strong>Nenhum gasto neste mês</strong>
      <small>Quando você registrar despesas, a divisão por categoria aparece aqui.</small>
    </div>`;
    return;
  }
  const byCat = new Map();
  for (const f of expenses) {
    const id = f.category || "outros";
    const entry = byCat.get(id) || { value: 0, count: 0, biggest: null };
    const amount = Number(f.amount) || 0;
    entry.value += amount;
    entry.count += 1;
    if (!entry.biggest || amount > (Number(entry.biggest.amount) || 0)) entry.biggest = f;
    byCat.set(id, entry);
  }
  const sorted = [...byCat.entries()].sort((a, b) => b[1].value - a[1].value);
  // Até 5 categorias com cor própria; o restante vira "Outros" (cinza).
  const named = sorted.filter(([id]) => id !== "outros").slice(0, 5);
  const rows = named.map(([id, info], index) => ({ id, ...info, slot: index + 1 }));
  const restEntries = sorted.filter(([id]) => !named.some(([n]) => n === id));
  const restValue = restEntries.reduce((sum, [, info]) => sum + info.value, 0);
  if (restValue > 0.004) {
    const biggest = restEntries.map(([, info]) => info.biggest).sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))[0];
    rows.push({ id: "outros", value: restValue, count: restEntries.reduce((sum, [, info]) => sum + info.count, 0), biggest, slot: 0, rest: restEntries.length });
  }
  rows.forEach((row) => { row.pct = (row.value / total) * 100; });
  bdCatsData = { rows, total, count: expenses.length };
  if (bdCatsSelected && !rows.some((row) => row.id === bdCatsSelected)) bdCatsSelected = null;

  const size = 200;
  const c = size / 2;
  const radius = 74;
  const stroke = 20;
  const capDeg = ((stroke / 2) / radius) * (180 / Math.PI); // quanto a ponta redonda avança
  const gapDeg = rows.length > 1 ? 3 : 0;
  let cursor = 0;
  const segments = rows.map((row, index) => {
    const sweep = (row.value / total) * 360;
    const mid = cursor + sweep / 2;
    let start = cursor + gapDeg / 2;
    let end = cursor + sweep - gapDeg / 2;
    // Pontas redondas só cabem em fatias com espaço; as finas ficam retas.
    const round = rows.length > 1 && end - start > capDeg * 2 + 1.5;
    if (round) { start += capDeg; end -= capDeg; }
    end = Math.max(end, start + 0.6);
    cursor += sweep;
    const d = rows.length === 1
      ? `M${c} ${c - radius} a${radius} ${radius} 0 1 1 -0.01 0`
      : bdArcPath(c, c, radius, start, Math.min(end, start + 359.4));
    const rad = (mid - 90) * Math.PI / 180;
    const label = row.id === "outros" && row.rest > 1 ? `Outros (${row.rest} categorias)` : bdCategoryLabel(row.id);
    return `<g class="bd-donut-seg-g" data-cat-index="${index}" style="--seg:var(--bd-cat-${row.slot});--dx:${(Math.cos(rad) * 6).toFixed(2)}px;--dy:${(Math.sin(rad) * 6).toFixed(2)}px" role="button" tabindex="-1" aria-label="${escapeHtml(label)}: ${escapeHtml(formatCurrency(row.value))}, ${Math.round(row.pct)}%">
        <path class="bd-donut-hit" d="${d}"/>
        <path class="bd-donut-seg${round ? " is-round" : ""}" d="${d}" pathLength="100"/>
      </g>`;
  }).join("");

  host.innerHTML = `<div class="bd-cats-viz${bdCatsAnimated ? "" : " is-intro"}">
    <figure class="bd-donut" aria-label="Gastos do mês por categoria: total ${escapeHtml(formatCurrency(total))}">
      <svg viewBox="0 0 ${size} ${size}">
        <defs>
          <radialGradient id="bdDonutGlow" cx="50%" cy="50%" r="50%">
            <stop offset="55%" stop-color="var(--bd-donut-glow)" stop-opacity="0"/>
            <stop offset="100%" stop-color="var(--bd-donut-glow)" stop-opacity=".22"/>
          </radialGradient>
        </defs>
        <circle class="bd-donut-halo" cx="${c}" cy="${c}" r="${radius - stroke / 2 - 4}" fill="url(#bdDonutGlow)"/>
        <circle class="bd-donut-track" cx="${c}" cy="${c}" r="${radius}" stroke-width="${stroke}"/>
        <circle class="bd-donut-inner" cx="${c}" cy="${c}" r="${radius - stroke / 2 - 7}"/>
        <g class="bd-donut-segs" stroke-width="${stroke}">${segments}</g>
      </svg>
      <button type="button" class="bd-donut-center" data-cats-clear aria-label="Mostrar o total do mês"></button>
    </figure>
    <ol class="bd-cat-list">
      ${rows.map((row, index) => {
        const label = row.id === "outros" && row.rest > 1 ? `Outros · ${row.rest} categorias` : bdCategoryLabel(row.id);
        return `<li class="bd-cat-row" data-cat-index="${index}" style="--seg:var(--bd-cat-${row.slot})" tabindex="0" role="button" aria-pressed="false">
          <span class="bd-cat-chip">${finCategoryIconHtml(row.id)}</span>
          <span class="bd-cat-main">
            <span class="bd-cat-line"><strong>${escapeHtml(label)}</strong><b>${escapeHtml(formatCurrency(row.value))}</b></span>
            <span class="bd-cat-meter"><i style="width:${Math.max(2, row.pct).toFixed(1)}%"></i></span>
          </span>
          <span class="bd-cat-share">${row.pct >= 10 ? Math.round(row.pct) : row.pct.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</span>
        </li>`;
      }).join("")}
    </ol>
  </div>
  <p class="bd-cats-insight" aria-live="polite"></p>`;
  bdCatsAnimated = true;
  paintBoardsCategories(null);
}

// Desenha o estado atual: categoria escolhida (ou prévia do mouse) ou total.
function paintBoardsCategories(previewIndex) {
  const host = document.querySelector("#bdCats");
  if (!host || !bdCatsData) return;
  const { rows, total, count } = bdCatsData;
  const selectedIndex = bdCatsSelected ? rows.findIndex((row) => row.id === bdCatsSelected) : -1;
  const index = previewIndex !== null && previewIndex !== undefined ? previewIndex : selectedIndex;
  const row = index >= 0 ? rows[index] : null;
  host.querySelector(".bd-cats-viz")?.classList.toggle("has-active", Boolean(row));
  host.querySelectorAll("[data-cat-index]").forEach((el) => {
    const on = Number(el.dataset.catIndex) === index;
    el.classList.toggle("is-active", on);
    if (el.classList.contains("bd-cat-row")) el.setAttribute("aria-pressed", String(Number(el.dataset.catIndex) === selectedIndex));
  });
  const center = host.querySelector(".bd-donut-center");
  const insight = host.querySelector(".bd-cats-insight");
  const key = row ? `cat:${row.id}` : "total";
  if (center && center.dataset.key !== key) {
    center.dataset.key = key;
    center.style.setProperty("--seg", row ? `var(--bd-cat-${row.slot})` : "var(--bd-primary)");
    center.innerHTML = row
      ? `<span class="bd-dc-ico">${finCategoryIconHtml(row.id)}</span>
         <small>${escapeHtml(row.id === "outros" && row.rest > 1 ? "Outros" : bdCategoryLabel(row.id)).replace(/\//g, "/<wbr>")}</small>
         <strong>${escapeHtml(formatCurrency(row.value))}</strong>
         <span class="bd-dc-pct">${Math.round(row.pct)}% do total</span>`
      : `<small>Total gasto</small>
         <strong>${escapeHtml(formatCurrency(total))}</strong>
         <span>${count} lançamento${count === 1 ? "" : "s"}</span>`;
    center.setAttribute("aria-label", row ? "Voltar ao total do mês" : `Total gasto no mês: ${formatCurrency(total)}`);
    // Troca suave do centro: o conteúdo novo entra já meio visível (sem
    // apagar e acender), e uma troca rápida cancela a anterior.
    if (!prefersReducedMotion()) {
      center.getAnimations?.().forEach((a) => a.cancel());
      center.animate?.([{ opacity: 0.4, transform: "scale(.95)" }, { opacity: 1, transform: "scale(1)" }], { duration: 200, easing: "cubic-bezier(.2,.9,.3,1)" });
    }
  }
  if (insight && insight.dataset.key !== key) {
    insight.dataset.key = key;
    if (row) {
      const biggest = row.biggest;
      const what = biggest ? escapeHtml(biggest.description || bdCategoryLabel(biggest.category)) : "";
      insight.innerHTML = `${bdIcon("receipt")}<span><b>${row.count} lançamento${row.count === 1 ? "" : "s"}</b>${biggest ? ` · maior: <b>${escapeHtml(formatCurrency(Number(biggest.amount) || 0))}</b> em ${what}` : ""}</span>`;
    } else {
      const top = rows[0];
      insight.innerHTML = `${bdIcon("sparkle")}<span><b>${escapeHtml(bdCategoryLabel(top.id))}</b> concentra ${Math.round(top.pct)}% dos gastos do mês. Toque numa fatia para detalhar.</span>`;
    }
  }
}

function selectBoardsCategory(index) {
  if (!bdCatsData) return;
  const row = bdCatsData.rows[index];
  bdCatsSelected = !row || bdCatsSelected === row.id ? null : row.id;
  if (bdCatsSelected) navigator.vibrate?.(8);
  paintBoardsCategories(null);
}

function bindBoardsCategories() {
  const host = document.querySelector("#bdCats");
  if (!host || host.dataset.bound === "1") return;
  host.dataset.bound = "1";
  const fine = () => window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;
  host.addEventListener("click", (event) => {
    previewIndex = undefined; // o clique redesenha; a próxima prévia sempre pinta
    if (event.target.closest("[data-cats-clear]")) { bdCatsSelected = null; paintBoardsCategories(null); return; }
    const target = event.target.closest("[data-cat-index]");
    if (target) selectBoardsCategory(Number(target.dataset.catIndex));
  });
  // Prévia ao passar o mouse (só com mouse de verdade; no toque vale o toque).
  // Nos vãos entre as fatias (ou entre as linhas da lista) a prévia espera um
  // instante antes de voltar ao total: passar de uma fatia para a vizinha não
  // pisca mais "Total gasto" no meio do caminho.
  let revertTimer = 0;
  let previewIndex = null;
  const preview = (index) => {
    clearTimeout(revertTimer);
    if (index === previewIndex) return;
    previewIndex = index;
    paintBoardsCategories(index);
  };
  host.addEventListener("pointerover", (event) => {
    if (!fine()) return;
    const target = event.target.closest("[data-cat-index]");
    if (target) { preview(Number(target.dataset.catIndex)); return; }
    clearTimeout(revertTimer);
    revertTimer = setTimeout(() => preview(null), 180);
  });
  host.addEventListener("pointerleave", () => { if (fine()) { clearTimeout(revertTimer); preview(null); } });
  host.addEventListener("keydown", (event) => {
    const row = event.target.closest(".bd-cat-row");
    if (!row) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectBoardsCategory(Number(row.dataset.catIndex));
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = [...host.querySelectorAll(".bd-cat-row")];
      const next = rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
      if (bdCatsSelected) selectBoardsCategory(Number(next.dataset.catIndex));
    } else if (event.key === "Escape" && bdCatsSelected) {
      bdCatsSelected = null;
      paintBoardsCategories(null);
    }
  });
  // Toque longo não abre "copiar/selecionar" nem o menu do navegador.
  host.addEventListener("contextmenu", (event) => { if (event.target.closest(".bd-cats-viz, .bd-cats-insight")) event.preventDefault(); });
  host.addEventListener("selectstart", (event) => event.preventDefault());
}

function bdDueLabel(dueIso) {
  const diff = Math.round((new Date(`${dueIso}T12:00:00`) - new Date(`${todayIso}T12:00:00`)) / 86400000);
  const when = diff === 0 ? "Vence hoje" : diff === 1 ? "Vence amanhã" : `Vence em ${diff} dias`;
  const d = new Date(`${dueIso}T12:00:00`);
  return `${when} • ${BD_WEEKDAYS[d.getDay()]}, ${String(d.getDate()).padStart(2, "0")} de ${BD_MONTHS[d.getMonth()]}`;
}

function bdRecurringIcon(item) {
  const text = `${item.description || ""} ${item.categoryId || ""} ${item.category || ""}`.toLowerCase();
  if (/aluguel|moradia|condom/.test(text)) return "home";
  if (/internet|wifi|net\b/.test(text)) return "wifi";
  if (/luz|energia|agua|água|gas\b|gás/.test(text)) return "bolt";
  if (/celular|telefone|plano/.test(text)) return "phone";
  if (/streaming|netflix|spotify|assinatura/.test(text)) return "tv";
  return "receipt";
}

function bdShortDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Agenda do dia no Início — espelha o Planner: os MESMOS compromissos e
// tarefas que a lente "Dia" mostra para hoje, mais as tarefas atrasadas
// (o grupo "Atrasadas" da lista) e as contas fixas que vencem hoje
// (recorrências de Finanças ainda não lançadas). Nada de prazos de outros
// dias aqui: o cartão se chama "de hoje".
function bdAgendaSnapshot() {
  const monthKey = todayIso.slice(0, 7);
  const [year, month] = monthKey.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const todayDay = Number(todayIso.slice(8, 10));
  const now = new Date();
  const nowHm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const items = [];

  const events = state.events.filter((e) => e && e.date === todayIso);
  for (const event of events) {
    const ends = event.endTime || event.time || "";
    const past = Boolean(event.time) && ends < nowHm;
    const where = event.location && event.location !== "Sem local" ? event.location : "";
    items.push({
      kind: "event", order: `2 ${event.time || "00:00"} 0`, icon: "calendar", tone: "blue",
      title: event.title, sub: [event.time ? plannerTimeRange(event) : "Dia todo", where].filter(Boolean).join(" · "),
      trail: event.time ? { text: event.time, cls: "time" } : { text: "Dia todo", cls: "soft" },
      past, id: event.id, view: "planner", focus: "agenda",
    });
  }

  // Tarefas do dia: exatamente o filtro do Planner (vence hoje e não foi cancelada).
  const todayTasks = state.tasks.filter((t) => t && t.dueDate === todayIso && t.status !== "Cancelada");
  for (const task of todayTasks) {
    const done = task.status === "Concluida";
    const important = task.priority === "Urgente" || task.priority === "Alta";
    items.push({
      kind: "task", order: done ? `4 ${task.dueTime || "99:99"}` : `2 ${task.dueTime || "99:98"} 1`,
      icon: done ? "check-circle" : "task-check", tone: done ? "green" : important ? "amber" : "violet",
      title: task.title,
      sub: done ? "Tarefa concluída" : `Tarefa${important ? ` · prioridade ${String(task.priority).toLowerCase()}` : ""}`,
      trail: task.dueTime ? { text: task.dueTime, cls: "time" } : { text: done ? "Feita" : "Hoje", cls: "soft" },
      done, id: task.id, view: "planner", focus: "tasks",
    });
  }

  // Atrasadas: mesmas do grupo "Atrasadas" do Planner, sempre no topo.
  const overdueTasks = state.tasks.filter((t) => t && t.dueDate && t.dueDate < todayIso && t.status !== "Concluida" && t.status !== "Cancelada");
  for (const task of overdueTasks) {
    items.push({
      kind: "overdue", order: `0 ${task.dueDate} ${task.dueTime || ""}`, icon: "alert", tone: "red",
      title: task.title, sub: `Atrasada · venceu ${bdShortDate(task.dueDate)}`,
      trail: { text: "Atrasada", cls: "danger" }, overdue: true, id: task.id, view: "planner", focus: "tasks",
    });
  }

  // Contas fixas que vencem hoje (Finanças › Recorrências) e ainda não foram lançadas.
  const entries = bdWorkspaceFinances();
  for (const item of (state.finRecurrents || []).filter((r) => (r.workspaceId || "personal") === activeWorkspaceId)) {
    if (item.active === false || isRecurrentSkipped(item, monthKey)) continue;
    const dueDay = Math.min(Number(item.day) || 1, daysInMonth);
    if (dueDay !== todayDay) continue;
    const alreadyLogged = entries.some((e) => e.date.startsWith(monthKey) && e.description === item.description && Number(e.amount) === Number(item.amount));
    if (alreadyLogged) continue;
    const income = item.type === "receita";
    items.push({
      kind: "bill", order: "3", icon: income ? "coin" : bdRecurringIcon(item), tone: income ? "green" : "amber",
      title: item.description, sub: income ? "Receita fixa · entra hoje" : "Conta fixa · vence hoje",
      trail: { text: `${income ? "+ " : ""}${formatCurrency(Number(item.amount) || 0)}`, cls: "amount" },
      view: "finances",
    });
  }

  items.sort((a, b) => a.order.localeCompare(b.order));
  return {
    items,
    counts: {
      events: events.length,
      tasksDone: todayTasks.filter((t) => t.status === "Concluida").length,
      tasksTotal: todayTasks.length,
      overdue: overdueTasks.length,
      bills: items.filter((item) => item.kind === "bill").length,
    },
  };
}

// Mantido para quem ainda chama pelo nome antigo.
function bdAgendaItems() { return bdAgendaSnapshot().items; }

function renderBoardsToday() {
  const host = document.querySelector("#bdToday");
  if (!host) return;
  if (pulsinhoTeaserCallsCache.length) renderPulsinhoTeaser();
  const summary = document.querySelector("#bdTodaySummary");
  const { items, counts } = bdAgendaSnapshot();
  if (summary) {
    const chips = [
      `<button type="button" class="bd-ts tone-blue" data-agenda-view="planner" data-agenda-focus="agenda" title="Os mesmos compromissos do Planner para hoje">${bdIcon("calendar")}<b>${counts.events}</b><small>${counts.events === 1 ? "compromisso" : "compromissos"}</small></button>`,
      `<button type="button" class="bd-ts tone-violet" data-agenda-view="planner" data-agenda-focus="tasks" title="Tarefas que vencem hoje (feitas/total)">${bdIcon("task-check")}<b>${counts.tasksTotal ? `${counts.tasksDone}/${counts.tasksTotal}` : 0}</b><small>${counts.tasksTotal === 1 ? "tarefa" : "tarefas"}</small></button>`,
      counts.overdue ? `<button type="button" class="bd-ts tone-red" data-agenda-view="planner" data-agenda-focus="tasks" title="Tarefas com prazo vencido">${bdIcon("alert")}<b>${counts.overdue}</b><small>${counts.overdue === 1 ? "atrasada" : "atrasadas"}</small></button>` : "",
      counts.bills ? `<button type="button" class="bd-ts tone-amber" data-agenda-view="finances" title="Contas fixas de Finanças que vencem hoje">${bdIcon("receipt")}<b>${counts.bills}</b><small>${counts.bills === 1 ? "conta hoje" : "contas hoje"}</small></button>` : "",
    ].filter(Boolean);
    summary.hidden = !items.length;
    summary.dataset.count = String(chips.length);
    summary.innerHTML = items.length ? chips.join("") : "";
  }
  if (!items.length) {
    host.innerHTML = `<li class="bd-agenda-empty">
      <span class="bd-agenda-empty-art" aria-hidden="true">${bdIcon("sun")}<i></i><i></i><i></i></span>
      <strong>Dia livre por aqui</strong>
      <small>Nenhum compromisso, tarefa ou conta para hoje.</small>
      <span class="bd-agenda-empty-actions">
        <button type="button" class="bd-chip-btn" data-agenda-add="event">${bdIcon("calendar")}Compromisso</button>
        <button type="button" class="bd-chip-btn" data-agenda-add="task">${bdIcon("task-check")}Tarefa</button>
      </span>
    </li>`;
    return;
  }
  const visible = items.slice(0, 5);
  const hidden = items.length - visible.length;
  host.innerHTML = visible.map((item) => `<li class="bd-ag${item.past ? " is-past" : ""}${item.done ? " is-done" : ""}${item.overdue ? " is-overdue" : ""}" data-agenda-view="${item.view}"${item.focus ? ` data-agenda-focus="${item.focus}"` : ""} role="button" tabindex="0">
    <span class="bd-li-ico tone-${item.tone}">${bdIcon(item.icon)}</span>
    <span class="bd-li-main"><strong>${escapeHtml(item.title || "")}</strong><small>${escapeHtml(item.sub || "")}</small></span>
    <span class="bd-ag-trail is-${item.trail.cls}">${item.trail.cls === "time" ? bdIcon("clock") : ""}${escapeHtml(item.trail.text)}</span>
  </li>`).join("") + (hidden > 0
    ? `<li class="bd-ag-more"><button type="button" data-agenda-view="planner" data-agenda-focus="agenda">Ver mais ${hidden} ${hidden === 1 ? "item" : "itens"} ${bdIcon("arrow-right")}</button></li>`
    : "");
}

function bindBoardsToday() {
  const host = document.querySelector("#bdToday");
  if (!host || host.dataset.bound === "1") return;
  host.dataset.bound = "1";
  const go = (target) => {
    const add = target.dataset.agendaAdd;
    if (add) { openPlannerQuickAdd(add); return; }
    const view = target.dataset.agendaView;
    if (!view) return;
    setView(view);
    if (view === "planner") {
      if (target.dataset.agendaFocus === "tasks") setPlannerTab("list");
      if (target.dataset.agendaFocus === "agenda") { plannerDayDate = todayIso; setPlannerTab("day"); }
    }
    if (view === "finances") setFinBoardTab("automacao");
  };
  const onClick = (event) => {
    const target = event.target.closest("[data-agenda-view], [data-agenda-add]");
    if (target) go(target);
  };
  host.addEventListener("click", onClick);
  document.querySelector("#bdTodaySummary")?.addEventListener("click", onClick);
  host.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest(".bd-ag[data-agenda-view]");
    if (!target) return;
    event.preventDefault();
    go(target);
  });
}

function bdTrendHtml(pct, { inverse = false } = {}) {
  if (!Number.isFinite(pct)) return "";
  const up = pct >= 0;
  const good = inverse ? !up : up;
  const text = `${up ? "+" : "-"}${Math.abs(pct).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  return `<b class="${good ? "" : "down"}">${bdIcon(up ? "arrow-up" : "arrow-down")}${text}</b> vs. mês anterior`;
}

// Resultado do mês: quanto sobrou (ou faltou), a fatia da renda que já
// foi gasta numa barra só e as duas linhas de entrada/saída.
function renderBoardsResult(receitas, despesas) {
  const card = document.querySelector("#bdResult");
  const result = receitas - despesas;
  document.querySelector("#bdResIn").textContent = formatCurrency(receitas);
  document.querySelector("#bdResOut").textContent = formatCurrency(despesas);
  const totalEl = document.querySelector("#bdResTotal");
  totalEl.textContent = `${result > 0 ? "+ " : result < 0 ? "− " : ""}${formatCurrency(Math.abs(result))}`;
  if (!card) return;
  const negative = result < 0;
  card.classList.toggle("is-negative", negative);
  card.classList.toggle("is-empty", !receitas && !despesas);
  const label = document.querySelector("#bdResLabel");
  if (label) label.textContent = !receitas && !despesas ? "Sem movimentação no mês" : negative ? "Faltou no mês" : "Sobrou no mês";
  const spentPct = receitas > 0 ? (despesas / receitas) * 100 : despesas > 0 ? 100 : 0;
  const meter = document.querySelector("#bdResMeter");
  const bar = document.querySelector("#bdResMeterSpent");
  if (bar) {
    bar.style.width = `${Math.min(100, spentPct).toFixed(1)}%`;
    bar.className = spentPct > 100 ? "is-over" : spentPct >= 85 ? "is-warn" : "";
  }
  if (meter) meter.setAttribute("aria-label", receitas > 0 ? `Gastos somam ${Math.round(spentPct)}% das receitas do mês` : "Sem receitas registradas no mês");
  const outNote = document.querySelector("#bdResOutNote");
  if (outNote) outNote.textContent = receitas > 0 ? `${Math.round(spentPct)}% das receitas` : "Saídas do mês";
  const rate = document.querySelector("#bdResRate");
  if (rate) {
    const savings = receitas > 0 ? Math.round((result / receitas) * 100) : null;
    rate.hidden = savings === null;
    if (savings !== null) {
      rate.className = `bd-res-badge ${savings >= 20 ? "is-good" : savings >= 0 ? "is-ok" : "is-bad"}`;
      rate.textContent = savings >= 0 ? `Guardou ${savings}%` : `${Math.abs(savings)}% acima`;
      rate.title = savings >= 0 ? "Parte das receitas que sobrou no mês" : "Quanto os gastos passaram das receitas";
    }
  }
}

function renderBoardsDashboard() {
  if (!document.querySelector("#bdBalance")) return;
  const monthKey = todayIso.slice(0, 7);
  const entries = bdWorkspaceFinances();
  const monthEntries = entries.filter((f) => f.date.startsWith(monthKey));
  const receitas = monthEntries.filter((f) => f.type === "receita").reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const despesas = monthEntries.filter((f) => f.type === "despesa").reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const saldo = getCarryOverBalance(monthKey, activeWorkspaceId) + receitas - despesas;

  document.querySelector("#bdBalance").textContent = formatCurrency(saldo);
  document.querySelector("#bdSpend").textContent = formatCurrency(despesas);
  document.querySelector("#bdIncome").textContent = formatCurrency(receitas);

  // Saldo: variação contra o mesmo dia do mês anterior
  const prevMonthKey = getPreviousMonthKey(monthKey);
  const prevHasData = entries.some((f) => f.date.startsWith(prevMonthKey)) || isMonthClosed(prevMonthKey);
  const [py, pm] = prevMonthKey.split("-").map(Number);
  const prevDay = Math.min(Number(todayIso.slice(8, 10)), new Date(py, pm, 0).getDate());
  const prevBalance = bdBalanceOn(`${prevMonthKey}-${String(prevDay).padStart(2, "0")}`, entries);
  const trendEl = document.querySelector("#bdBalanceTrend");
  if (trendEl) trendEl.innerHTML = prevHasData && prevBalance ? bdTrendHtml(((saldo - prevBalance) / Math.abs(prevBalance)) * 100) : "Saldo do mês até hoje";

  // Gastos: limites por categoria comparam SÓ o que foi gasto nessas
  // categorias (QA 18/11: R$ 26 numa categoria limitada a R$ 100 aparecia
  // como "96% da meta" porque o total do mês era dividido pelo limite).
  const { limits: goalTotal, spent: limitedSpent, count: limitedCount } = finLimitedSpend(monthKey, activeWorkspaceId);
  const spendNote = document.querySelector("#bdSpendNote");
  const spendProgress = document.querySelector("#bdSpendProgress");
  const spendBar = document.querySelector("#bdSpendBar");
  if (goalTotal > 0) {
    const pct = Math.round((limitedSpent / goalTotal) * 100);
    spendNote.textContent = `${pct}% dos limites · ${formatCurrency(limitedSpent)} de ${formatCurrency(goalTotal)}`;
    spendNote.title = `Gasto nas ${limitedCount} categoria${limitedCount === 1 ? "" : "s"} com limite definido. O total do mês (${formatCurrency(despesas)}) inclui todas as categorias.`;
    spendProgress.hidden = false;
    spendBar.style.width = `${Math.min(100, pct)}%`;
    spendBar.className = pct > 100 ? "over" : pct >= 85 ? "warn" : "";
  } else {
    const prevSpend = entries.filter((f) => f.date.startsWith(prevMonthKey) && f.type === "despesa").reduce((s, f) => s + (Number(f.amount) || 0), 0);
    spendProgress.hidden = true;
    spendNote.innerHTML = prevSpend ? bdTrendHtml(((despesas - prevSpend) / prevSpend) * 100, { inverse: true }) : "Defina limites por categoria em Finanças";
  }

  const prevIncome = entries.filter((f) => f.date.startsWith(prevMonthKey) && f.type === "receita").reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const incomeTrend = document.querySelector("#bdIncomeTrend");
  if (incomeTrend) incomeTrend.innerHTML = prevIncome ? bdTrendHtml(((receitas - prevIncome) / prevIncome) * 100) : "Entradas do mês";

  renderBoardsResult(receitas, despesas);

  renderBoardsSparkline(bdBalanceSeries(30));
  renderBoardsEvolution();
  renderBoardsCategories(monthEntries);
  renderBoardsToday();

  updateBellDot();
  renderNotificationCenter();
  const chatRoot = document.querySelector("#pulseCommandResponse");
  if (chatRoot && !chatRoot.children.length) renderPulsinhoConversation();
}

// ── Central de notificações (sininho) ─────────────────────────
// Mostra o que pede atenção agora (tarefas atrasadas, agenda de hoje,
// contas, orçamento e metas) e o estado do push NESTE aparelho, com o
// passo a passo para ativar no celular. Os mesmos avisos chegam por push
// e WhatsApp pelo servidor (api/send-reminders.js).
function notificationCenterItems() {
  const items = [];
  const now = new Date();
  const nowHm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const tomorrow = offsetDate(1);
  for (const task of state.tasks || []) {
    if (!task || task.status === "Concluida" || task.status === "Cancelada" || !task.dueDate) continue;
    if (task.dueDate < todayIso) {
      items.push({ key: `task-late:${task.id}:${task.dueDate}`, group: "attention", icon: "alert", tone: "red", title: task.title, body: `Tarefa atrasada · venceu ${bdShortDate(task.dueDate)}`, view: "planner", focus: "tasks", sort: `0${task.dueDate}` });
    } else if (task.dueDate === todayIso) {
      const late = task.dueTime && task.dueTime < nowHm;
      items.push({ key: `task-today:${task.id}:${task.dueDate}`, group: "today", icon: late ? "alert" : "task-check", tone: late ? "red" : "violet", title: task.title, body: task.dueTime ? `Tarefa · ${late ? "era" : "vence"} às ${task.dueTime}` : "Tarefa · vence hoje", view: "planner", focus: "tasks", sort: `1${task.dueTime || "99"}` });
    } else if (task.dueDate === tomorrow) {
      items.push({ key: `task-tomorrow:${task.id}:${task.dueDate}`, group: "soon", icon: "task-check", tone: "violet", title: task.title, body: `Tarefa · amanhã${task.dueTime ? ` às ${task.dueTime}` : ""}`, view: "planner", focus: "tasks", sort: `2${task.dueTime || "99"}` });
    }
  }
  for (const event of state.events || []) {
    if (!event?.date) continue;
    if (event.date === todayIso && (!event.time || (event.endTime || event.time) >= nowHm)) {
      items.push({ key: `event:${event.id}:${event.date}`, group: "today", icon: "calendar", tone: "blue", title: event.title, body: event.time ? `Compromisso · ${event.time}${event.location && event.location !== "Sem local" ? ` · ${event.location}` : ""}` : "Compromisso · dia todo", view: "planner", focus: "agenda", sort: `1${event.time || "00"}` });
    } else if (event.date === tomorrow) {
      items.push({ key: `event:${event.id}:${event.date}`, group: "soon", icon: "calendar", tone: "blue", title: event.title, body: `Compromisso · amanhã${event.time ? ` às ${event.time}` : ""}`, view: "planner", focus: "agenda", sort: `2${event.time || "00"}` });
    }
  }
  for (const bill of bdAgendaItems().filter((item) => item.kind === "bill")) {
    const today = /hoje/i.test(bill.sub);
    items.push({ key: `bill:${bill.title}:${bill.sub}`, group: today ? "today" : "soon", icon: bill.icon, tone: today ? "red" : "amber", title: bill.title, body: `${bill.sub.split(" • ")[0]} · ${bill.trail.text}`, view: "finances", sort: `3${bill.sub}` });
  }
  const monthKey = todayIso.slice(0, 7);
  const monthEntries = bdWorkspaceFinances().filter((f) => f.date.startsWith(monthKey));
  const income = monthEntries.filter((f) => f.type === "receita").reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
  const spent = monthEntries.filter((f) => f.type === "despesa").reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
  if (income > 0 && spent / income >= 0.7) {
    const pct = Math.round((spent / income) * 100);
    items.push({ key: `budget:${monthKey}:${pct >= 90 ? 90 : 70}`, group: "attention", icon: "wallet", tone: pct >= 90 ? "red" : "amber", title: pct >= 90 ? "Orçamento no limite" : "Atenção ao orçamento", body: `Você já usou ${pct}% das receitas deste mês.`, view: "finances", sort: "05" });
  }
  for (const goal of state.goals || []) {
    const pct = Number(goal?.target) > 0 ? (Number(goal.current) / Number(goal.target)) * 100 : 0;
    if (pct >= 80 && pct < 100) items.push({ key: `goal:${goal.id}:80`, group: "soon", icon: "target", tone: "green", title: `Quase lá: ${goal.title}`, body: `Meta ${Math.round(pct)}% completa. Falta pouco!`, view: "planner", focus: "goals", sort: "4" });
  }
  return items.sort((a, b) => a.sort.localeCompare(b.sort));
}

function bellSeenKey() {
  return currentUser?.uid ? `pn_bell_seen:${currentUser.uid}` : "";
}
function readBellSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(bellSeenKey()) || "[]")); } catch { return new Set(); }
}
function writeBellSeen(keys) {
  try { if (bellSeenKey()) localStorage.setItem(bellSeenKey(), JSON.stringify([...keys].slice(-300))); } catch { /* sem armazenamento: só não lembra o que já foi visto */ }
}

function updateBellDot() {
  const dot = document.querySelector("#bdBellDot");
  if (!dot || !state) return;
  const seen = readBellSeen();
  const unseen = notificationCenterItems().filter((item) => !seen.has(item.key)).length;
  dot.hidden = unseen === 0;
  const bell = document.querySelector("#bdBellBtn");
  if (bell) bell.setAttribute("aria-label", unseen ? `Notificações: ${unseen} nova${unseen === 1 ? "" : "s"}` : "Notificações");
}

function pushDeviceStatus() {
  const ua = navigator.userAgent || "";
  const ios = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  const supported = "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  if (window.pushNotificationsAreRegistered?.() === true && state.appReminderOptIn !== false) return { code: "on", ios };
  if (ios && !standalone) return { code: "ios-install", ios };
  if (!supported) return { code: "unsupported", ios };
  if (Notification.permission === "denied") return { code: "denied", ios };
  return { code: "off", ios };
}

function renderPushCard() {
  const status = pushDeviceStatus();
  const whatsapp = state.whatsappReminderOptIn && state.whatsappLinkedPhone;
  const whatsappLine = `<button type="button" class="bd-notif-wa${whatsapp ? " is-on" : ""}" data-notif-go="whatsapp">${bdIcon("whatsapp")}<span>Lembretes no WhatsApp: <b>${whatsapp ? "ativos" : "desligados"}</b></span>${bdIcon("chev-right")}</button>`;
  if (status.code === "on") {
    return `<div class="bd-push is-on">
      <span class="bd-push-ico">${bdIcon("bell-ring")}</span>
      <div class="bd-push-copy"><strong>Push ativo neste aparelho</strong><small>Os avisos chegam mesmo com o app fechado.</small></div>
      <button type="button" class="bd-btn" data-notif-test>${bdIcon("send")}Testar</button>
    </div>${whatsappLine}`;
  }
  if (status.code === "ios-install") {
    return `<div class="bd-push is-setup">
      <span class="bd-push-ico">${bdIcon("smartphone")}</span>
      <div class="bd-push-copy"><strong>Receba no iPhone como um app</strong><small>A Apple só entrega notificações para o PulseNote instalado na Tela de Início.</small></div>
      <ol class="bd-push-steps">
        <li><span>1</span>Toque em ${bdIcon("share-ios")}<b>Compartilhar</b> no Safari</li>
        <li><span>2</span>Escolha <b>Adicionar à Tela de Início</b></li>
        <li><span>3</span>Abra pelo ícone e toque no sininho para ativar</li>
      </ol>
    </div>${whatsappLine}`;
  }
  if (status.code === "unsupported") {
    return `<div class="bd-push is-muted"><span class="bd-push-ico">${bdIcon("bell")}</span><div class="bd-push-copy"><strong>Este navegador não recebe push</strong><small>Use o Chrome, Edge ou Safari atualizado — ou instale o PulseNote como app.</small></div></div>${whatsappLine}`;
  }
  if (status.code === "denied") {
    return `<div class="bd-push is-warn"><span class="bd-push-ico">${bdIcon("alert")}</span><div class="bd-push-copy"><strong>Notificações bloqueadas</strong><small>${status.ios ? "No iPhone: Ajustes → Notificações → PulseNote → Permitir Notificações." : "Libere as notificações do site nas configurações do navegador (ícone de cadeado ao lado do endereço)."}</small></div></div>${whatsappLine}`;
  }
  return `<div class="bd-push is-off">
    <span class="bd-push-ico">${bdIcon("bell-ring")}</span>
    <div class="bd-push-copy"><strong>Ative os avisos neste aparelho</strong><small>Lembretes de tarefas, compromissos e contas, mesmo com o app fechado.</small></div>
    <button type="button" class="bd-btn bd-btn--primary" data-notif-enable>Ativar</button>
  </div>${whatsappLine}`;
}

let notifSeenAtOpen = new Set();
function renderNotificationCenter() {
  const panel = document.querySelector("#bdNotif");
  if (!panel || panel.hidden) return;
  const items = notificationCenterItems();
  const groups = [["attention", "Precisa de atenção"], ["today", "Hoje"], ["soon", "Em breve"]];
  const count = panel.querySelector("#bdNotifCount");
  if (count) { count.textContent = String(items.length); count.hidden = !items.length; }
  panel.querySelector("#bdNotifPush").innerHTML = renderPushCard();
  const list = panel.querySelector("#bdNotifList");
  list.innerHTML = items.length
    ? groups.map(([id, label]) => {
      const group = items.filter((item) => item.group === id);
      if (!group.length) return "";
      return `<section class="bd-notif-group"><h3>${label}</h3>${group.map((item) => `<button type="button" class="bd-notif-item" data-notif-view="${item.view}"${item.focus ? ` data-notif-focus="${item.focus}"` : ""}>
        <span class="bd-li-ico tone-${item.tone}">${bdIcon(item.icon)}</span>
        <span class="bd-notif-text"><strong>${escapeHtml(item.title || "")}</strong><small>${escapeHtml(item.body || "")}</small></span>
        ${notifSeenAtOpen.has(item.key) ? "" : '<i class="bd-notif-new" aria-label="Nova"></i>'}
      </button>`).join("")}</section>`;
    }).join("")
    : `<div class="bd-notif-empty"><span>${bdIcon("check-circle")}</span><strong>Tudo em dia!</strong><small>Sem pendências, compromissos ou contas pedindo atenção agora.</small></div>`;
}

function ensureNotificationCenter() {
  let panel = document.querySelector("#bdNotif");
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "bdNotif";
  panel.className = "bd-notif";
  panel.hidden = true;
  panel.innerHTML = `<div class="bd-notif-backdrop" data-notif-close></div>
    <section class="bd-notif-panel" role="dialog" aria-modal="true" aria-labelledby="bdNotifTitle">
      <span class="bd-notif-grab" aria-hidden="true"></span>
      <header class="bd-notif-head">
        <h2 id="bdNotifTitle">Notificações <span class="bd-notif-count" id="bdNotifCount" hidden></span></h2>
        <button type="button" class="bd-icon-btn" data-notif-close aria-label="Fechar">${bdIcon("x")}</button>
      </header>
      <div class="bd-notif-scroll">
        <div id="bdNotifPush"></div>
        <div id="bdNotifList" class="bd-notif-list"></div>
      </div>
      <footer class="bd-notif-foot"><button type="button" class="bd-link" data-notif-go="settings">${bdIcon("sliders")}Preferências de notificação</button></footer>
    </section>`;
  document.body.appendChild(panel);
  panel.addEventListener("click", async (event) => {
    if (event.target.closest("[data-notif-close]")) { closeNotificationCenter(); return; }
    const go = event.target.closest("[data-notif-go]");
    if (go) {
      closeNotificationCenter();
      setView("settings");
      requestAnimationFrame(() => openSettingsSection(go.dataset.notifGo === "whatsapp" ? "integracoes" : "notificacoes"));
      return;
    }
    const item = event.target.closest("[data-notif-view]");
    if (item) {
      closeNotificationCenter();
      setView(item.dataset.notifView);
      if (item.dataset.notifView === "planner") {
        if (item.dataset.notifFocus === "tasks") setPlannerTab("list");
        if (item.dataset.notifFocus === "agenda") setPlannerTab("day");
      }
      return;
    }
    const enable = event.target.closest("[data-notif-enable]");
    if (enable) {
      enable.disabled = true;
      const allowed = await window.requestNotificationPermission?.();
      if (allowed) { state.appReminderOptIn = true; saveState(); }
      renderNotificationCenter();
      renderWhatsAppSettings?.();
      return;
    }
    const test = event.target.closest("[data-notif-test]");
    if (test) {
      test.disabled = true;
      try {
        const result = await pulseApi("/api/pulsinho", { method: "POST", body: JSON.stringify({ action: "push-test" }) });
        showToast(result.accepted ? `Teste enviado para ${result.accepted} aparelho${result.accepted === 1 ? "" : "s"}. Confira a notificação! 🔔` : "O serviço de push não aceitou o envio. Tente ativar de novo neste aparelho.");
      } catch (error) {
        showToast(error?.code === "push_test_cooldown" ? "Aguarde um minutinho para testar de novo."
          : error?.code === "no_push_devices" ? "Nenhum aparelho com push ativo. Toque em Ativar neste aparelho."
            : "Não consegui enviar o teste agora. Tente novamente em instantes.");
      } finally {
        setTimeout(() => { test.disabled = false; }, 4000);
      }
    }
  });
  panel.addEventListener("keydown", (event) => { if (event.key === "Escape") closeNotificationCenter(); });
  return panel;
}

function openNotificationCenter() {
  const panel = ensureNotificationCenter();
  notifSeenAtOpen = readBellSeen();
  panel.hidden = false;
  document.body.classList.add("bd-notif-open");
  document.querySelector("#bdBellBtn")?.setAttribute("aria-expanded", "true");
  renderNotificationCenter();
  // Abrir a central conta como "visto": o ponto do sino some.
  writeBellSeen(new Set([...notifSeenAtOpen, ...notificationCenterItems().map((item) => item.key)]));
  updateBellDot();
  requestAnimationFrame(() => panel.querySelector(".bd-notif-head [data-notif-close]")?.focus({ preventScroll: true }));
}

function closeNotificationCenter() {
  const panel = document.querySelector("#bdNotif");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.body.classList.remove("bd-notif-open");
  const bell = document.querySelector("#bdBellBtn");
  bell?.setAttribute("aria-expanded", "false");
  bell?.focus({ preventScroll: true });
}

// ── Puxar para atualizar (app instalado no celular) ────────────
// No PWA não existe o "puxar" do navegador. Com a tela no topo, arrastar
// para baixo mostra o indicador; soltando depois do ponto, o app recarrega
// (busca a versão mais nova e os dados do servidor). Não age dentro de
// janelas, campos de texto ou listas que estejam roladas.
function bindPullToRefresh() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  if (!touch || !standalone || document.querySelector(".pn-ptr")) return;
  document.documentElement.classList.add("pn-ptr-enabled");
  const indicator = document.createElement("div");
  indicator.className = "pn-ptr";
  indicator.setAttribute("aria-hidden", "true");
  indicator.innerHTML = `<span class="pn-ptr-bubble">${bdIcon("refresh")}</span><span class="pn-ptr-label">Puxe para atualizar</span>`;
  document.body.appendChild(indicator);
  const label = indicator.querySelector(".pn-ptr-label");
  const THRESHOLD = 78;
  const MAX = 120;
  let startY = 0;
  let startX = 0;
  let pulling = false;
  let distance = 0;
  let refreshing = false;

  const blocked = (target) => {
    if (document.body.classList.contains("bd-notif-open") || document.body.classList.contains("st-drawer-open")) return true;
    if (target.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog'], .modal, .bn-form-wrap.is-open, .bn-detail-wrap:not([hidden]), .bd-chat-body, .bd-confirm")) return true;
    for (let el = target; el && el !== document.body; el = el.parentElement) {
      if (el.scrollTop > 0) return true;
    }
    return false;
  };
  const paint = () => {
    const progress = Math.min(1, distance / THRESHOLD);
    indicator.style.setProperty("--ptr-y", `${Math.min(distance, MAX) * 0.62}px`);
    indicator.style.setProperty("--ptr-rot", `${Math.round(progress * 300)}deg`);
    indicator.style.opacity = String(Math.min(1, distance / 30));
    indicator.classList.toggle("is-ready", distance >= THRESHOLD);
    if (label) label.textContent = distance >= THRESHOLD ? "Solte para atualizar" : "Puxe para atualizar";
  };
  const reset = () => {
    pulling = false;
    distance = 0;
    indicator.classList.add("is-settling");
    paint();
    setTimeout(() => indicator.classList.remove("is-settling", "is-visible"), 250);
  };

  window.addEventListener("touchstart", (event) => {
    if (refreshing || event.touches.length !== 1 || window.scrollY > 0 || blocked(event.target)) return;
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
    pulling = true;
    distance = 0;
  }, { passive: true });
  window.addEventListener("touchmove", (event) => {
    if (!pulling || refreshing) return;
    const dy = event.touches[0].clientY - startY;
    const dx = Math.abs(event.touches[0].clientX - startX);
    if (window.scrollY > 0 || dy <= 0 || dx > dy) {
      if (distance) reset(); else pulling = false;
      return;
    }
    distance = dy;
    indicator.classList.add("is-visible");
    indicator.classList.remove("is-settling");
    paint();
  }, { passive: true });
  window.addEventListener("touchend", () => {
    if (!pulling || refreshing) return;
    if (distance < THRESHOLD) { reset(); return; }
    refreshing = true;
    pulling = false;
    indicator.classList.add("is-refreshing", "is-settling");
    indicator.style.setProperty("--ptr-y", "54px");
    if (label) label.textContent = "Atualizando…";
    try { navigator.vibrate?.(8); } catch { /* sem vibração */ }
    // Grava o que estiver pendente antes de recarregar.
    try { if (ndCurrentNoteId) flushNoteDetailSave(); } catch { /* segue */ }
    setTimeout(() => window.location.reload(), 450);
  }, { passive: true });
  window.addEventListener("touchcancel", () => { if (pulling) reset(); }, { passive: true });
}

function toggleNotificationCenter() {
  const panel = document.querySelector("#bdNotif");
  if (panel && !panel.hidden) closeNotificationCenter();
  else openNotificationCenter();
}

window.addEventListener("pulsenote:push-status", () => renderNotificationCenter());

// App estático, sem zoom: o Safari do iPhone ignora "user-scalable=no" do
// viewport, então o gesto de pinça e o toque duplo são bloqueados aqui.
// Os campos já usam 16px no celular (sem o zoom automático ao tocar).
function lockPageZoom() {
  if (document.documentElement.dataset.zoomLocked === "1") return;
  document.documentElement.dataset.zoomLocked = "1";
  const stop = (event) => event.preventDefault();
  ["gesturestart", "gesturechange", "gestureend"].forEach((type) => document.addEventListener(type, stop, { passive: false }));
  document.addEventListener("touchmove", (event) => {
    if (event.touches.length > 1 || (typeof event.scale === "number" && event.scale !== 1)) event.preventDefault();
  }, { passive: false });
  // Toque duplo: resolvido no CSS (touch-action: manipulation), sem
  // atrasar ou perder toques rápidos em botões como +/−.
}

function bindBoardsShell() {
  lockPageZoom();
  requestAnimationFrame(() => syncTabbarInk());
  document.fonts?.ready?.then(() => syncTabbarInk());
  window.addEventListener("resize", debounce(() => syncTabbarInk(), 120), { passive: true });
  bindBoardsToday();
  bindBoardsCategories();
  bindPullToRefresh();
  bindKeyboardViewportRepair();
  // Intervalo do gráfico de evolução
  document.querySelector("#bdEvoRange")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-range]");
    if (!button) return;
    bdEvoRange = Number(button.dataset.range) || 30;
    document.querySelectorAll("#bdEvoRange button").forEach((item) => item.classList.toggle("active", item === button));
    renderBoardsEvolution();
  });
  const chart = document.querySelector("#bdEvoChart");
  if (chart && "ResizeObserver" in window) {
    let lastWidth = 0;
    let lastHeight = 0;
    new ResizeObserver(() => {
      if (Math.abs(chart.clientWidth - lastWidth) < 2 && Math.abs(chart.clientHeight - lastHeight) < 2) return;
      lastWidth = chart.clientWidth;
      lastHeight = chart.clientHeight;
      renderBoardsEvolution();
    }).observe(chart);
  }
  // Carrossel de KPIs (mobile): bolinhas acompanham a rolagem e levam ao cartão
  bdSetupPager(document.querySelector("#bdKpis"), document.querySelector("#bdKpiDots"), ".bd-kpi");
  // Busca recolhida em ícone
  const search = document.querySelector(".bd-search");
  const searchInput = document.querySelector("#globalSearch");
  document.querySelector("#bdSearchBtn")?.addEventListener("click", () => {
    const open = search.classList.toggle("open");
    if (open) searchInput?.focus();
    else if (searchInput?.value) { searchInput.value = ""; renderAll(); }
  });
  searchInput?.addEventListener("blur", () => { if (!searchInput.value.trim()) search?.classList.remove("open"); });
  searchInput?.addEventListener("keydown", (event) => { if (event.key === "Escape") { searchInput.blur(); search?.classList.remove("open"); } });
  // Sino → central de notificações (lista do dia + push neste aparelho)
  document.querySelector("#bdBellBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleNotificationCenter();
  });
  // Logo → Início
  document.querySelectorAll("[data-nav-home]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); setView("dashboard"); }));
  // Cartão do Pulsinho na lateral abre a conversa
  document.querySelector("[data-focus-chat]")?.addEventListener("click", () => {
    setView("dashboard");
    requestAnimationFrame(() => {
      document.querySelector("#bdChat")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      document.querySelector("#pulseCommandInput")?.focus({ preventScroll: true });
    });
  });
  // Menu "⋮" do Pulsinho: nova conversa ou escolher a IA.
  const chatMore = document.querySelector("#bdChatMore");
  const chatMenu = document.querySelector("#bdChatMenu");
  const closeChatMenu = () => {
    if (!chatMenu || chatMenu.hidden) return;
    chatMenu.hidden = true;
    chatMore?.setAttribute("aria-expanded", "false");
  };
  chatMore?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!chatMenu) return;
    chatMenu.hidden = !chatMenu.hidden;
    chatMore.setAttribute("aria-expanded", String(!chatMenu.hidden));
    if (!chatMenu.hidden) chatMenu.querySelector("button")?.focus();
  });
  chatMenu?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-chat-menu]");
    if (!item) return;
    closeChatMenu();
    if (item.dataset.chatMenu === "new") {
      pulsinhoConversation.length = 0;
      pendingPulsinhoAction = null;
      pendingPulsinhoActions = [];
      pulsinhoUndo.clear();
      persistPulsinhoConversation();
      pulsinhoIntroState = "pending";
      playPulsinhoIntro();
      document.querySelector("#pulseCommandInput")?.focus({ preventScroll: true });
    } else if (item.dataset.chatMenu === "ai") {
      setView("settings");
      requestAnimationFrame(() => openSettingsSection("inteligencia"));
    }
  });
  document.addEventListener("click", (event) => { if (!event.target.closest(".bd-chat-menu-wrap")) closeChatMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && chatMenu && !chatMenu.hidden) { closeChatMenu(); chatMore?.focus(); } });
  // Rolagem da conversa: botão para voltar à mensagem mais recente.
  const chatBody = document.querySelector("#pulseCommandResponse");
  chatBody?.addEventListener("scroll", updatePulsinhoJump, { passive: true });
  document.querySelector("#bdChatJump")?.addEventListener("click", () => {
    chatBody?.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
  });
  watchPulsinhoIntro();
  bindPulsinhoKeyboardFit();
  bindPulsinhoTeaser();
  renderPulsinhoTeaser({ keepIndex: false });
}

function renderDashboard() {
  const doneToday = state.tasks.filter((task) => task.completedAt === todayIso).length;
  const doneTotal = state.tasks.filter((task) => task.status === "Concluida").length;
  const activeTasks = state.tasks.filter((task) => task.status !== "Cancelada");
  const progress = activeTasks.length ? Math.round((doneTotal / activeTasks.length) * 100) : 0;
  const nextEvents = state.events.filter((event) => event.date >= todayIso && event.date <= offsetDate(7));

  // ── Resumo real do dia (sem gamificação) ──
  const pendingTasks = state.tasks.filter((t) => t.status === "Pendente" || t.status === "Em andamento").length;
  const monthKey = todayIso.slice(0, 7);
  const monthEntries = (state.finances || []).filter((f) => f.date.startsWith(monthKey) && (f.workspaceId || "personal") === activeWorkspaceId);
  const monthReceitas = monthEntries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const monthDespesas = monthEntries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
  const monthSaldo = getCarryOverBalance(monthKey, activeWorkspaceId) + monthReceitas - monthDespesas;
  const upcomingSorted = [...state.events].filter((e) => e.date >= todayIso).sort(sortEvent);
  const nextEvent = upcomingSorted[0];
  const topGoal = [...state.goals].filter((g) => g.current < g.target).sort((a, b) => (b.current / b.target) - (a.current / a.target))[0];

  const pendingEl = document.querySelector("#summaryTasksPending");
  if (pendingEl) pendingEl.textContent = pendingTasks;
  const saldoEl = document.querySelector("#summaryFinSaldo");
  if (saldoEl) { saldoEl.textContent = formatCurrencyWrappable(monthSaldo); saldoEl.style.color = monthSaldo >= 0 ? "var(--green)" : "var(--red)"; }
  fitCurrencyValues("summaryFinSaldo");
  const eventEl = document.querySelector("#summaryNextEvent");
  if (eventEl) eventEl.textContent = nextEvent ? `${nextEvent.title} · ${formatDate(nextEvent.date)}` : "Nenhum";
  const goalEl = document.querySelector("#summaryTopGoal");
  if (goalEl) goalEl.textContent = topGoal ? `${topGoal.title} (${Math.round((topGoal.current / topGoal.target) * 100)}%)` : "Nenhuma";

  // "Tarefas concluídas hoje" virou o detalhe do card de "Tarefas pendentes"
  // em vez de um card próprio — evita repetir a mesma ideia de tarefas
  // duas vezes lado a lado no dashboard.
  document.querySelector("#doneMetricDetail").textContent = `${doneToday} concluída${doneToday === 1 ? "" : "s"} hoje · ${doneTotal} no histórico`;
  document.querySelector("#progressMetric").textContent = `${progress}%`;
  document.querySelector("#eventMetric").textContent = `${nextEvents.length} nos próximos 7 dias`;
  document.querySelector("#scoreMetric").textContent = calculateXpStats().score;
  const { level, levelProgress } = calculateXpStats();
  document.querySelector("#levelMetric").textContent = `Nivel ${level}`;
  document.querySelector("#heroLevelLabel").textContent = `Nivel ${level}`;
  document.querySelector("#heroProgressBar").style.width = `${levelProgress}%`;
  document.querySelector("#heroProgressLabel").textContent = `${levelProgress}%`;
  document.querySelector("#heroQuestLabel").textContent =
    doneTotal > 0 ? "Sua rotina esta ganhando ritmo" : "Complete uma tarefa para iniciar sua sequencia";
  document.querySelector("#streakCount").textContent = `${calculateStreak()} dias`;

  renderList("#todayTasks", state.tasks.filter((task) => task.status !== "Concluida" && task.status !== "Cancelada").slice(0, 5), renderTaskRow, "Nenhuma tarefa pendente.", "empty-state-compact");
  renderList("#upcomingEvents", nextEvents.sort(sortEvent).slice(0, 5), renderEventRow, "Nenhum compromisso nos proximos dias.", "empty-state-compact");
  renderChart();
  renderGoalSummary();
  renderDashFinance();
  renderBoardsDashboard();
  renderPremiumDashboard({
    monthKey,
    monthEntries,
    monthReceitas,
    monthDespesas,
    monthSaldo,
  });
}

function renderPremiumDashboard({ monthKey, monthEntries, monthReceitas, monthDespesas, monthSaldo }) {
  const currentBalance = document.querySelector("#pulseCurrentBalance");
  if (!currentBalance) return;

  const now = new Date();
  const currentDay = now.getDate();
  const [year, month] = monthKey.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const recurring = Array.isArray(state.finRecurrents)
    ? state.finRecurrents.filter((item) => (item.workspaceId || "personal") === activeWorkspaceId)
    : [];
  const futureRecurring = recurring.filter((item) => {
    if (item.active === false || isRecurrentSkipped(item, monthKey)) return false;
    const dueDay = Math.min(Number(item.day) || 1, daysInMonth);
    if (dueDay <= currentDay) return false;
    return !(state.finances || []).some((entry) =>
      entry.date?.startsWith(monthKey)
      && entry.description === item.description
      && Number(entry.amount) === Number(item.amount)
      && (entry.workspaceId || "personal") === activeWorkspaceId
    );
  });
  const futureIncome = futureRecurring.filter((item) => item.type === "receita").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const futureExpense = futureRecurring.filter((item) => item.type !== "receita").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const projectedBalance = monthSaldo + futureIncome - futureExpense;
  const safetyReserve = Math.max(500, monthReceitas * 0.18);
  const safeSpend = Math.max(0, projectedBalance - safetyReserve);

  currentBalance.textContent = formatCurrency(monthSaldo);
  const projectedEl = document.querySelector("#pulseProjectedBalance");
  const safeSpendEl = document.querySelector("#pulseSafeSpend");
  if (projectedEl) {
    projectedEl.textContent = formatCurrency(projectedBalance);
    projectedEl.dataset.tone = projectedBalance >= 0 ? "positive" : "negative";
  }
  if (safeSpendEl) safeSpendEl.textContent = formatCurrency(safeSpend);

  const contextEl = document.querySelector("#pulseBalanceContext");
  if (contextEl) {
    const count = monthEntries.length;
    contextEl.textContent = `${count} ${count === 1 ? "lançamento" : "lançamentos"} considerado${count === 1 ? "" : "s"} neste mês`;
  }

  const futureSorted = [...futureRecurring].sort((a, b) => Number(a.day || 0) - Number(b.day || 0));
  const nextRecurring = futureSorted[0];
  const commitmentEl = document.querySelector("#pulseNextCommitment");
  if (commitmentEl) {
    commitmentEl.textContent = nextRecurring
      ? `Próximo compromisso: ${nextRecurring.description} · ${formatCurrency(Number(nextRecurring.amount || 0))} · dia ${Math.min(Number(nextRecurring.day) || 1, daysInMonth)}`
      : "Nenhum compromisso financeiro recorrente pendente neste mês.";
  }

  const recurringInsight = document.querySelector("#pulseRecurringInsight");
  const recurringDetail = document.querySelector("#pulseRecurringInsightDetail");
  if (recurringInsight) recurringInsight.textContent = futureRecurring.length
    ? `${futureRecurring.length} ${futureRecurring.length === 1 ? "recorrência prevista" : "recorrências previstas"}`
    : "Mês sem recorrências pendentes";
  if (recurringDetail) recurringDetail.textContent = futureRecurring.length
    ? `${formatCurrency(futureExpense)} em despesas e ${formatCurrency(futureIncome)} em receitas até o fechamento.`
    : "Cadastre contas recorrentes para tornar a projeção mais precisa.";

  renderPremiumForecast(monthKey, monthSaldo, futureRecurring);
  renderPremiumTodayAgenda();
  refreshDashboardForecast();
}

async function refreshDashboardForecast(force = false) {
  if (!currentUser || isLocalDesignPreview) return;
  const now = Date.now();
  if (!force && now - lastForecastFetchAt < 30000) return;
  lastForecastFetchAt = now;
  try {
    const params = new URLSearchParams({ workspaceId: activeWorkspaceId });
    const { forecast } = await pulseApi(`/api/finance-forecast?${params}`);
    if (!forecast) return;
    latestDashboardForecast = forecast;
    const current = document.querySelector("#pulseCurrentBalance");
    const projected = document.querySelector("#pulseProjectedBalance");
    const safe = document.querySelector("#pulseSafeSpend");
    const context = document.querySelector("#pulseBalanceContext");
    if (current) current.textContent = formatCurrency(forecast.currentBalance);
    if (projected) {
      projected.textContent = formatCurrency(forecast.projectedBalance);
      projected.dataset.tone = forecast.projectedBalance >= 0 ? "positive" : "negative";
    }
    if (safe) safe.textContent = formatCurrency(forecast.safeToSpend);
    if (context) context.textContent = forecast.confidence === "low"
      ? "Estimativa pelos lançamentos. Cadastre os saldos das contas para aumentar a precisão."
      : `Projeção até ${formatDate(forecast.horizonDate)} com contas e compromissos registrados`;
    const commitment = forecast.commitments?.[0];
    const commitmentEl = document.querySelector("#pulseNextCommitment");
    if (commitmentEl) commitmentEl.textContent = commitment
      ? `Próximo compromisso: ${commitment.description} · ${formatCurrency(commitment.amount)} · ${formatDate(commitment.date)}`
      : "Nenhum compromisso financeiro próximo até o fim do período.";
    renderPremiumForecastTimeline(forecast);
  } catch {
    // Mantém a projeção local já renderizada; falha de rede nunca esvazia o painel.
  }
}

function openDashboardForecastDetail() {
  const modal = document.querySelector("#pulseForecastDetailModal");
  if (!modal) return;
  const current = document.querySelector("#pulseForecastDetailCurrent");
  const projected = document.querySelector("#pulseForecastDetailProjected");
  const safe = document.querySelector("#pulseForecastDetailSafe");
  const sourceCurrent = document.querySelector("#pulseCurrentBalance")?.textContent || "R$ 0,00";
  const sourceProjected = document.querySelector("#pulseProjectedBalance")?.textContent || "R$ 0,00";
  const sourceSafe = document.querySelector("#pulseSafeSpend")?.textContent || "R$ 0,00";
  if (current) current.textContent = sourceCurrent;
  if (projected) projected.textContent = sourceProjected;
  if (safe) safe.textContent = sourceSafe;

  const timeline = document.querySelector("#pulseForecastTimeline");
  if (timeline) {
    timeline.replaceChildren();
    const commitments = Array.isArray(latestDashboardForecast?.commitments)
      ? latestDashboardForecast.commitments.slice(0, 6)
      : [];
    if (!commitments.length) {
      const empty = document.createElement("p");
      empty.className = "pulse-forecast-detail-empty";
      empty.textContent = "Nenhum compromisso futuro registrado para este período.";
      timeline.append(empty);
    } else {
      commitments.forEach((item) => {
        const row = document.createElement("div");
        row.className = "pulse-forecast-detail-row";
        const copy = document.createElement("div");
        const title = document.createElement("strong");
        const date = document.createElement("span");
        const amount = document.createElement("b");
        title.textContent = item.description || "Compromisso";
        date.textContent = item.date ? formatDate(item.date) : "Data não informada";
        amount.textContent = formatCurrency(Number(item.amount) || 0);
        copy.append(title, date);
        row.append(copy, amount);
        timeline.append(row);
      });
    }
  }
  modal.hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => document.querySelector("#pulseForecastDetailClose")?.focus());
}

function closeDashboardForecastDetail() {
  const modal = document.querySelector("#pulseForecastDetailModal");
  if (modal) modal.hidden = true;
  document.body.classList.remove("modal-open");
  document.querySelector(".pulse-forecast-visual")?.focus();
}

function renderPremiumForecastTimeline(forecast) {
  const line = document.querySelector("#pulseForecastLine");
  const area = document.querySelector("#pulseForecastArea");
  const point = document.querySelector("#pulseForecastPoint");
  const timeline = Array.isArray(forecast.timeline) ? forecast.timeline : [];
  if (!line || !area || !point || timeline.length < 1) return;
  const start = new Date(`${forecast.today}T12:00:00`);
  const end = new Date(`${forecast.horizonDate}T12:00:00`);
  const span = Math.max(1, (end - start) / 86400000);
  const values = timeline.map((item) => Number(item.balance) || 0);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = Math.max(1, max - min);
  const coords = timeline.map((item) => {
    const date = new Date(`${item.date}T12:00:00`);
    const day = Math.max(0, Math.min(span, (date - start) / 86400000));
    return [22 + (day / span) * 596, 198 - (((Number(item.balance) || 0) - min) / range) * 146];
  });
  if (coords.length === 1) coords.push([618, coords[0][1]]);
  const path = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];
  line.setAttribute("d", path);
  area.setAttribute("d", `${path} L${last[0].toFixed(1)} 218 L22 218 Z`);
  point.setAttribute("cx", last[0].toFixed(1));
  point.setAttribute("cy", last[1].toFixed(1));
}

function renderPremiumForecast(monthKey, startingBalance, futureRecurring) {
  const line = document.querySelector("#pulseForecastLine");
  const area = document.querySelector("#pulseForecastArea");
  const point = document.querySelector("#pulseForecastPoint");
  if (!line || !area || !point) return;

  const [, monthNumber] = monthKey.split("-").map(Number);
  const daysInMonth = new Date(Number(monthKey.slice(0, 4)), monthNumber, 0).getDate();
  const today = Math.min(new Date().getDate(), daysInMonth);
  const eventsByDay = new Map();
  for (const item of futureRecurring) {
    const day = Math.min(Number(item.day) || 1, daysInMonth);
    const signedAmount = Number(item.amount || 0) * (item.type === "receita" ? 1 : -1);
    eventsByDay.set(day, (eventsByDay.get(day) || 0) + signedAmount);
  }

  const points = [{ day: today, balance: startingBalance }];
  let running = startingBalance;
  for (let day = today + 1; day <= daysInMonth; day += 1) {
    running += eventsByDay.get(day) || 0;
    if (eventsByDay.has(day) || day === daysInMonth) points.push({ day, balance: running });
  }
  if (points.length === 1) points.push({ day: daysInMonth, balance: startingBalance });

  const balances = points.map((item) => item.balance);
  const minBalance = Math.min(...balances, 0);
  const maxBalance = Math.max(...balances, 1);
  const range = Math.max(1, maxBalance - minBalance);
  const xFor = (day) => 22 + ((day - today) / Math.max(1, daysInMonth - today)) * 596;
  const yFor = (balance) => 198 - ((balance - minBalance) / range) * 146;
  const coords = points.map((item) => [xFor(item.day), yFor(item.balance)]);
  const path = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];
  line.setAttribute("d", path);
  area.setAttribute("d", `${path} L${last[0].toFixed(1)} 218 L22 218 Z`);
  point.setAttribute("cx", last[0].toFixed(1));
  point.setAttribute("cy", last[1].toFixed(1));
}

function renderPremiumTodayAgenda() {
  const container = document.querySelector("#pulseTodayAgenda");
  if (!container) return;
  const todayTasks = (state.tasks || []).filter((task) =>
    task.dueDate === todayIso && task.status !== "Concluida" && task.status !== "Cancelada"
  ).map((task) => ({
    time: task.time || "Hoje",
    title: task.title,
    detail: `Tarefa · ${task.priority || "prioridade normal"}`,
  }));
  const todayEvents = (state.events || []).filter((event) => event.date === todayIso).map((event) => ({
    time: event.time || "Hoje",
    title: event.title,
    detail: event.location ? `Compromisso · ${event.location}` : "Compromisso",
  }));
  let items = [...todayEvents, ...todayTasks];
  if (!items.length) {
    items = (state.events || []).filter((event) => event.date > todayIso).sort(sortEvent).slice(0, 3).map((event) => ({
      time: formatDate(event.date),
      title: event.title,
      detail: event.location ? `Próximo · ${event.location}` : "Próximo compromisso",
    }));
  }
  items = items.sort((a, b) => String(a.time).localeCompare(String(b.time))).slice(0, 4);
  if (!items.length) {
    container.innerHTML = `<div class="pulse-empty">Seu dia está livre. Use “Adicionar” para planejar a próxima ação.</div>`;
    return;
  }
  container.innerHTML = items.map((item) => `
    <div class="pulse-timeline-item">
      <span class="pulse-timeline-time">${escapeHtml(item.time)}</span>
      <span class="pulse-timeline-node" aria-hidden="true"></span>
      <span class="pulse-timeline-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></span>
    </div>
  `).join("");
}

function renderDashFinance() {
  const el = document.querySelector("#dashFinancePanel");
  if (!el || !state.finances) return;
  const currentMonthKey = todayIso.slice(0, 7);
  const entries = state.finances.filter((f) => f.date.startsWith(currentMonthKey));
  const receitas = entries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const despesas = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
  const saldo = receitas - despesas;
  const usedPct = receitas > 0 ? Math.min(100, Math.round((despesas / receitas) * 100)) : 0;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">
      <div style="text-align:center;min-width:0;overflow:hidden"><div style="font-size:0.75rem;color:var(--muted);font-weight:600;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Receitas</div><strong id="dashFinReceitas" style="display:block;color:var(--green);font-size:1rem;font-weight:800;white-space:nowrap">${formatCurrencyWrappable(receitas)}</strong></div>
      <div style="text-align:center;min-width:0;overflow:hidden"><div style="font-size:0.75rem;color:var(--muted);font-weight:600;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Despesas</div><strong id="dashFinDespesas" style="display:block;color:var(--red);font-size:1rem;font-weight:800;white-space:nowrap">${formatCurrencyWrappable(despesas)}</strong></div>
      <div style="text-align:center;min-width:0;overflow:hidden"><div style="font-size:0.75rem;color:var(--muted);font-weight:600;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Saldo</div><strong id="dashFinSaldo" style="display:block;color:${saldo >= 0 ? "var(--green)" : "var(--red)"};font-size:1rem;font-weight:800;white-space:nowrap">${formatCurrencyWrappable(saldo)}</strong></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <div class="progress-track" style="flex:1;height:8px"><div style="width:${usedPct}%;height:100%;border-radius:999px;background:${usedPct > 80 ? "var(--red)" : usedPct > 60 ? "var(--orange)" : "var(--green)"};transition:width 400ms"></div></div>
      <span style="font-size:0.8rem;font-weight:700;color:var(--muted)">${usedPct}%</span>
    </div>
    ${
      entries.length
        ? entries
            .slice(0, 3)
            .map((f) => {
              const cat = findCategory(f.category);
              const isReceita = f.type === "receita";
              return `<div class="connector-row"><span style="font-size:0.88rem;font-weight:600;display:inline-flex;align-items:center;gap:5px">${isReceita ? icon("trendingUp", 13) : bdIcon(finCategoryIconAny(f.category, f.type))} ${escapeHtml(f.description)}</span><span style="font-weight:800;color:${isReceita ? "var(--green)" : "var(--red)"}">${isReceita ? "+" : "-"}${formatCurrency(f.amount)}</span></div>`;
            })
            .join("")
        : emptyStateCompactHtml({ iconName: "calendar", text: "Nada lançado este mês ainda." })
    }
  `;
  fitCurrencyValues("dashFinReceitas", "dashFinDespesas", "dashFinSaldo");
}

function calculateStreak() {
  let streak = 0;
  for (let days = 0; days < 30; days += 1) {
    const date = offsetDate(-days);
    if (state.tasks.some((task) => task.completedAt === date)) {
      streak += 1;
    } else if (days > 0) {
      break;
    }
  }
  return streak;
}

function renderChart() {
  const chart = document.querySelector("#chartBars");
  const days = [...Array(7)].map((_, index) => offsetDate(index - 6));
  const counts = days.map((date) => state.tasks.filter((task) => task.completedAt === date).length);
  const max = Math.max(1, ...counts);
  document.querySelector("#weeklySummary").textContent = `${counts.reduce((sum, count) => sum + count, 0)} concluidas`;
  chart.innerHTML = days
    .map((date, index) => {
      const label = safeFormatDate(`${date}T12:00:00`, { weekday: "short" }, "-");
      const height = 14 + (counts[index] / max) * 90;
      return `<div class="bar-item"><div class="bar" style="height:${height}px" title="${counts[index]} tarefas"></div><span>${label}</span></div>`;
    })
    .join("");
}

function renderGoalSummary() {
  renderList(
    "#goalSummary",
    state.goals.slice(0, 4),
    (goal) => {
      const percent = Math.min(100, Math.round((goal.current / goal.target) * 100));
      return `<div class="goal-row"><div><strong>${escapeHtml(goal.title)}</strong><div class="task-meta">${goal.current}/${goal.target}</div></div><span class="pill">${percent}%</span></div>`;
    },
    "Crie sua primeira meta.",
    "empty-state-compact"
  );
}

// ============================================================
// PLANNER (NOVO) — hub unificado inspirado no app Calendars.
// Não cria nenhum dado novo: só lê/escreve nos mesmos arrays de
// sempre (state.tasks, state.events, state.goals) através das
// MESMAS funções já usadas pelas telas antigas (toggleTask,
// deleteTask, deleteEvent, changeGoal, createTask...), então o
// comportamento e os dados salvos continuam idênticos — muda
// só a apresentação.
// ============================================================

// ── Sistema de ícones (estilo Lucide, um traço só, sem emoji) ──
// Substitui os emojis usados na primeira versão: o briefing de
// design pede um único conjunto de ícones consistente em peso e
// estilo, nunca emoji solto.
const ICONS = {
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  calendarWeek: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M16 2.5v4"/><path d="M8 2.5v4"/><path d="M3 10h18"/><path d="M8 14.5h.01"/><path d="M12 14.5h.01"/><path d="M16 14.5h.01"/>',
  calendarMonth: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M16 2.5v4"/><path d="M8 2.5v4"/><path d="M3 10h18"/><path d="M7.5 14.5h2"/><path d="M14.5 14.5h2"/><path d="M7.5 18h2"/><path d="M14.5 18h2"/>',
  notebook: '<rect x="5" y="3" width="15" height="18" rx="2.5"/><path d="M9 3v18"/><path d="M2.5 8h2.5"/><path d="M2.5 13h2.5"/><path d="M2.5 18h2.5"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.3 2.3 2.3L16 9.6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.3h8A2 2 0 0 1 21 9.3V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pencil: '<path d="M12 20h8"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  zap: '<path d="M12.5 2 4 13.5h6.5L11 22l8.5-11.5H13z"/>',
  flame: '<path d="M12 2.5c1 3 .3 4.6-1 6.2-1.3 1.6-2.5 2.9-2.5 5a3.5 3.5 0 0 0 7 0c0-1-.3-1.8-.8-2.5.8.6 1.8 1.8 1.8 3.8a5.5 5.5 0 0 1-11 0c0-4.5 3-6.2 4.5-9 .6-1 1.3-2.2 2-3.5z"/>',
  trophy: '<path d="M8 4h8v4a4 4 0 0 1-8 0z"/><path d="M8 5H4.5a2.5 2.5 0 0 0 0 5H8"/><path d="M16 5h3.5a2.5 2.5 0 0 1 0 5H16"/><path d="M10 13v3"/><path d="M14 13v3"/><path d="M7 21h10"/><path d="M8.5 21c0-2 1-3 3.5-3s3.5 1 3.5 3"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 8z"/><circle cx="12" cy="14" r="3.6"/>',
  trendingUp: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  arrowLeftRight: '<path d="m8 3-4 4 4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h12.5l-2 4.5L19.5 13H5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  alertTriangle: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9.5v4.3"/><path d="M12 17h.01"/>',
  calendarCheck: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/><path d="M8.5 14l2 2 4-4"/>',
  arrowRight: '<path d="M5 12h13.5"/><path d="m13 6 6.5 6-6.5 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 3.2"/>',
  mapPin: '<path d="M12 21.5s-7.2-6.6-7.2-11.4a7.2 7.2 0 0 1 14.4 0c0 4.8-7.2 11.4-7.2 11.4z"/><circle cx="12" cy="10.1" r="2.4"/>',
  trash: '<path d="M4 7h16"/><path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><path d="M8 7v13a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V7"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="M6 6 18 18"/>',
  inbox: '<path d="M21.5 12h-5.6l-1.8 3h-4.2l-1.8-3H2.5"/><path d="M5.6 5.3 2.5 12v6a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-6l-3.1-6.7A2 2 0 0 0 16.6 4H7.4a2 2 0 0 0-1.8 1.3z"/>',
  sparkle: '<path d="M11 2.5 12.6 7l4.4 1.6-4.4 1.6L11 14.7l-1.6-4.5L5 8.6l4.4-1.6z"/><path d="M18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  moreVertical: '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
};

function icon(name, size = 18, extraClass = "") {
  const body = ICONS[name] || ICONS.sparkle;
  return `<svg class="pn-icon ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

// ── Estado vazio premium (nunca caixa tracejada / texto seco) ──
function emptyStateHtml({ iconName = "sparkle", tone = "accent", title, desc, ctaLabel, ctaOnClick, secondaryLabel, secondaryOnClick, mascot = false, mascotBadgeIcon }) {
  // "mascot" é opt-in de propósito: só troca o ícone padrão pelo Pulsinho
  // nos lugares que pedirem explicitamente (hoje: Notas e Metas), sem
  // mudar nada nos outros estados vazios do app (Finanças, listas, etc.)
  // que continuam com o selo de ícone de sempre.
  const badge = mascot
    ? `<div class="empty-state-pro-mascot">
         <div class="pulsinho">
           <div class="pulsinho__face">
             <div class="pulsinho__eyes"><span class="pulsinho__eye"></span><span class="pulsinho__eye"></span></div>
             <svg class="pulsinho__pulse" viewBox="0 0 120 26"><path d="M0,13 L28,13 L36,3 L44,23 L52,13 L64,13 L70,6 L76,20 L82,13 L120,13"/></svg>
           </div>
         </div>
         ${mascotBadgeIcon ? `<span class="empty-state-pro-mascot-badge">${icon(mascotBadgeIcon, 12)}</span>` : ""}
       </div>`
    : `<div class="empty-state-pro-badge tone-${tone}">${icon(iconName, 26)}</div>`;
  return `
    <div class="empty-state-pro">
      ${badge}
      <h3>${title}</h3>
      <p>${desc}</p>
      ${ctaLabel ? `
        <div class="empty-state-pro-actions">
          <button class="primary-button" type="button" onclick="${ctaOnClick}">${icon("plus", 15)}<span>${ctaLabel}</span></button>
          ${secondaryLabel ? `<button class="ghost-button" type="button" onclick="${secondaryOnClick}">${secondaryLabel}</button>` : ""}
        </div>` : ""}
    </div>
  `;
}

// ── Variante compacta do estado vazio, para áreas pequenas dentro
// de uma tela já preenchida (ex.: um dia sem compromisso dentro da
// timeline) — continua com ícone, nunca texto seco isolado.
function emptyStateCompactHtml({ iconName = "sparkle", text, tone = "accent" }) {
  return `<div class="empty-state-compact-pro"><span class="tone-${tone}">${icon(iconName, 15)}</span><span>${text}</span></div>`;
}

// ── Planner (visual dos quadros) ────────────────────────────
// Lista = foco da semana + tarefas por grupo + compromissos da semana por hora
// + agenda do dia. Dia / Semana / Mês continuam existindo, com o mesmo visual.
let plannerAgendaMode = "events"; // events | tasks (painel "Agenda do dia")
let plannerFocusIndex = null; // null = primeira meta ainda não concluída
const plannerCollapsedGroups = new Set();
let plannerGroupsInitialised = false;
let plannerEditingTaskId = null;

const PLANNER_PRIORITY_LABEL = { Baixa: "Baixa", Media: "Média", Alta: "Alta", Urgente: "Urgente" };

function plannerShortDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return `${BD_WEEKDAYS[d.getDay()]}, ${d.getDate()} de ${BD_MONTHS[d.getMonth()]}`;
}

function plannerTimeRange(ev) {
  if (!ev.time) return "Sem horário";
  return ev.endTime && ev.endTime > ev.time ? `${ev.time} – ${ev.endTime}` : ev.time;
}

// Cor e ícone do compromisso pelo tipo (reunião azul, refeição verde, revisão
// roxa, saúde vermelha); o resto alterna de forma estável pelo id.
function plannerEventStyle(ev) {
  const text = `${ev.title || ""} ${ev.location || ""}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/(almoco|jantar|cafe|lanche|restaurante|happy|churrasco)/.test(text)) return { tone: "green", icon: "fork" };
  if (/(dentista|consulta|medic|exame|saude|academia|treino|terapia)/.test(text)) return { tone: "red", icon: "heart" };
  if (/(revisao|relatorio|documento|contrato|planejamento|planning|retrospectiva)/.test(text)) return { tone: "purple", icon: "note" };
  if (/(reuniao|alinhamento|time|call|daily|sync|entrevista|apresentacao|1:1)/.test(text)) return { tone: "blue", icon: "users" };
  let hash = 0;
  for (const ch of String(ev.id)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return { tone: ["blue", "green", "purple", "amber"][hash % 4], icon: "calendar" };
}

// ── Foco da semana ──────────────────────────────────────────
function plannerFocusGoal() {
  const goals = state.goals || [];
  if (!goals.length) return null;
  let index = plannerFocusIndex;
  if (index === null || index >= goals.length) {
    const firstOpen = goals.findIndex((g) => !goalStats(g).complete);
    index = firstOpen >= 0 ? firstOpen : 0;
  }
  return { goal: goals[index], index, total: goals.length };
}

// Progresso de uma meta. Com etapas nomeadas, elas mandam no progresso;
// sem etapas, vale o número de etapas escolhido ao criar (target).
function goalStats(goal) {
  const milestones = goal?.milestones || [];
  const named = milestones.length > 0;
  const total = named ? milestones.length : Math.max(1, Number(goal?.target) || 1);
  const done = named ? milestones.filter((m) => m.done).length : Math.min(total, Math.max(0, Number(goal?.current) || 0));
  const percent = Math.round((done / total) * 100);
  return { milestones, named, total, done, percent, remaining: total - done, complete: done >= total };
}

// Anel de progresso (SVG) usado no Foco e na lista de metas.
function goalRingHtml(stats, size = "lg") {
  const id = `gr${Math.random().toString(36).slice(2, 8)}`;
  return `<span class="pf-ring pf-ring--${size}${stats.complete ? " is-complete" : ""}" role="img" aria-label="${stats.percent}% concluído">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${stats.complete ? "#2fcf8b" : "#8b7bff"}"/><stop offset="1" stop-color="${stats.complete ? "#22c3a6" : "#22c3e6"}"/></linearGradient></defs>
      <circle class="pf-ring-track" cx="32" cy="32" r="26"/>
      <circle class="pf-ring-bar" cx="32" cy="32" r="26" pathLength="100" stroke="url(#${id})" style="--p:${stats.percent}"/>
    </svg>
    <span class="pf-ring-label">${stats.complete ? bdIcon("check") : `<b>${stats.percent}</b><small>%</small>`}</span>
  </span>`;
}

// Etapas: com nome viram chips marcáveis; sem nome, uma trilha de
// segmentos — tocar no 3º segmento marca "3 etapas feitas".
function goalStepsHtml(goal, stats, scope) {
  // No painel de metas as etapas nomeadas aparecem na lista expansível;
  // aqui fica só a trilha de progresso, para não repetir.
  if (stats.named && scope === "goal") {
    return `<div class="pf-segs is-static" role="img" aria-label="${stats.done} de ${stats.total} etapas">${stats.milestones.map((m) => `<span class="pf-seg${m.done ? " is-done" : ""}"></span>`).join("")}</div>`;
  }
  if (stats.named) {
    return `<ol class="pf-chips">${stats.milestones.map((m) => `<li><button type="button" class="pf-chip${m.done ? " is-done" : ""}" data-${scope}-action="toggle-ms" data-goal-id="${goal.id}" data-ms-id="${m.id}" aria-pressed="${m.done}">
      <i>${m.done ? bdIcon("check") : ""}</i><span>${escapeHtml(m.title)}</span></button></li>`).join("")}</ol>`;
  }
  if (stats.total > 14) {
    return `<div class="pf-track" role="img" aria-label="${stats.done} de ${stats.total} etapas"><i style="width:${stats.percent}%"></i></div>`;
  }
  return `<div class="pf-segs" role="group" aria-label="Etapas de ${escapeHtml(goal.title)}">${Array.from({ length: stats.total }, (_, i) => `<button type="button" class="pf-seg${i < stats.done ? " is-done" : ""}${i === stats.done ? " is-next" : ""}" data-${scope}-action="set-step" data-goal-id="${goal.id}" data-step="${i + 1}" aria-label="Etapa ${i + 1}${i < stats.done ? " (feita)" : ""}"></button>`).join("")}</div>`;
}

// Avança/volta uma etapa (marca o próximo marco ou soma no contador).
function stepGoal(goalId, delta) {
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;
  const before = goalStats(goal);
  if (before.named) {
    const list = goal.milestones;
    const target = delta > 0 ? list.find((m) => !m.done) : [...list].reverse().find((m) => m.done);
    if (!target) return;
    toggleGoalMilestone(goalId, target.id);
  } else {
    changeGoal(goalId, delta);
  }
  // (sem etapas nomeadas, changeGoal já comemora sozinho)
  if (before.named && delta > 0 && !before.complete && goalStats(state.goals.find((g) => g.id === goalId)).complete) {
    celebrate("Meta concluída! Mandou bem.");
  }
}

function setGoalStep(goalId, step) {
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;
  const stats = goalStats(goal);
  // Tocar na última etapa feita desfaz ela (fica fácil corrigir um toque).
  const next = step === stats.done ? step - 1 : step;
  updateGoalProgress(goalId, next);
  renderPlannerGoalsStrip();
  if (next >= stats.total && !stats.complete) celebrate("Meta concluída! Mandou bem.");
}

const GOAL_IDEAS = ["Ler 2 livros", "Correr 20 km", "Guardar R$ 500", "Estudar 10 horas"];

// Rótulo da semana do foco ("16–22 nov"): muda sozinho quando a semana vira.
function plannerFocusWeekLabel() {
  const days = getWeekDays(new Date(`${todayIso}T12:00:00`));
  const first = new Date(`${days[0]}T12:00:00`);
  const last = new Date(`${days[6]}T12:00:00`);
  return first.getMonth() === last.getMonth()
    ? `${first.getDate()}–${last.getDate()} ${BD_MONTHS[last.getMonth()]}`
    : `${first.getDate()} ${BD_MONTHS[first.getMonth()]} – ${last.getDate()} ${BD_MONTHS[last.getMonth()]}`;
}

let plannerFocusExpanded = false;
let plannerFocusPainted = { goalId: "", percent: 0 };
let plannerFocusAdvanceTimer = 0;

// Foco da semana — versão compacta: anel pequeno + título + trilha de
// etapas numa linha, e um único botão para avançar. As etapas nomeadas
// ficam recolhidas ("Ver etapas") para não empurrar a lista de tarefas.
function renderPlannerFocus() {
  const root = document.querySelector("#plannerFocus");
  if (!root) return;
  const focus = plannerFocusGoal();
  const week = plannerFocusWeekLabel();
  if (!focus) {
    plannerFocusPainted = { goalId: "", percent: 0 };
    root.innerHTML = `<div class="wf wf--empty">
      <span class="wf-empty-ico" aria-hidden="true">${bdIcon("target")}</span>
      <div class="wf-main">
        <span class="wf-kicker">Foco da semana <em>${escapeHtml(week)}</em></span>
        <h3>Escolha uma meta para acompanhar</h3>
      </div>
      <button type="button" class="bd-btn bd-btn--primary wf-cta" data-focus-action="new-goal">${bdIcon("plus")}<span>Criar meta</span></button>
      <div class="wf-ideas" role="group" aria-label="Ideias de meta">${GOAL_IDEAS.map((idea) => `<button type="button" class="wf-idea" data-focus-action="idea" data-idea="${escapeHtml(idea)}">${escapeHtml(idea)}</button>`).join("")}</div>
    </div>`;
    return;
  }
  const { goal, index, total } = focus;
  const stats = goalStats(goal);
  const nextMs = stats.named ? stats.milestones.find((m) => !m.done) : null;
  const status = stats.complete
    ? "Meta concluída"
    : `${stats.done} de ${stats.total} etapa${stats.total === 1 ? "" : "s"}${nextMs ? ` · próxima: ${nextMs.title}` : ` · falta${stats.remaining === 1 ? "" : "m"} ${stats.remaining}`}`;
  const sameGoal = plannerFocusPainted.goalId === goal.id;
  const fromPercent = sameGoal ? plannerFocusPainted.percent : 0;
  const pager = total > 1
    ? `<div class="wf-pager" role="group" aria-label="Trocar meta em foco">
        <button type="button" data-focus-action="prev" aria-label="Meta anterior">${bdIcon("chev-left")}</button>
        <span aria-live="polite">${index + 1}/${total}</span>
        <button type="button" data-focus-action="next" aria-label="Próxima meta">${bdIcon("chev-right")}</button>
      </div>`
    : "";
  // Trilha: cada segmento é uma etapa (tocar marca/desmarca). Mais de 14
  // etapas sem nome viram uma barra contínua.
  let track;
  if (stats.named) {
    track = `<div class="wf-track" role="group" aria-label="Etapas de ${escapeHtml(goal.title)}">${stats.milestones.map((m) => `<button type="button" class="wf-seg${m.done ? " is-done" : ""}${nextMs && m.id === nextMs.id ? " is-next" : ""}" data-focus-action="toggle-ms" data-goal-id="${goal.id}" data-ms-id="${m.id}" aria-pressed="${m.done}" aria-label="${m.done ? "Desmarcar" : "Concluir"} etapa: ${escapeHtml(m.title)}" title="${escapeHtml(m.title)}"></button>`).join("")}</div>`;
  } else if (stats.total <= 14) {
    track = `<div class="wf-track" role="group" aria-label="Etapas de ${escapeHtml(goal.title)}">${Array.from({ length: stats.total }, (_, i) => `<button type="button" class="wf-seg${i < stats.done ? " is-done" : ""}${i === stats.done ? " is-next" : ""}" data-focus-action="set-step" data-goal-id="${goal.id}" data-step="${i + 1}" aria-label="Etapa ${i + 1}${i < stats.done ? " (feita)" : ""}"></button>`).join("")}</div>`;
  } else {
    track = `<div class="wf-bar" role="img" aria-label="${stats.done} de ${stats.total} etapas"><i style="width:${stats.percent}%"></i></div>`;
  }
  const list = stats.named && plannerFocusExpanded
    ? `<ol class="wf-list">${stats.milestones.map((m) => `<li><button type="button" class="wf-item${m.done ? " is-done" : ""}" data-focus-action="toggle-ms" data-goal-id="${goal.id}" data-ms-id="${m.id}" aria-pressed="${m.done}"><i aria-hidden="true">${m.done ? bdIcon("check") : ""}</i><span>${escapeHtml(m.title)}</span></button></li>`).join("")}</ol>`
    : "";
  root.innerHTML = `<div class="wf${stats.complete ? " is-complete" : ""}${sameGoal ? "" : " is-fresh"}" data-goal="${goal.id}">
    <div class="wf-head">
      <span class="wf-kicker">${bdIcon("target")}Foco da semana <em>${escapeHtml(week)}</em></span>
      <div class="wf-tools">
        ${pager}
        <button type="button" class="wf-icon" data-focus-action="manage" aria-label="Todas as metas" title="Todas as metas">${bdIcon("dots-h")}</button>
      </div>
    </div>
    <div class="wf-body">
      <span class="wf-ring${stats.complete ? " is-complete" : ""}" role="img" aria-label="${stats.percent}% concluído">
        <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="wf-ring-track" cx="22" cy="22" r="18"/><circle class="wf-ring-bar" cx="22" cy="22" r="18" pathLength="100" style="--p:${fromPercent}"/></svg>
        <span>${stats.complete ? bdIcon("check") : `<b>${stats.percent}</b><small>%</small>`}</span>
      </span>
      <div class="wf-main">
        <h3 title="${escapeHtml(goal.title)}">${escapeHtml(goal.title)}</h3>
        <p>${escapeHtml(status)}</p>
      </div>
    </div>
    ${track}
    ${list}
    <div class="wf-foot">
      ${stats.named ? `<button type="button" class="wf-link" data-focus-action="expand" aria-expanded="${plannerFocusExpanded}">${plannerFocusExpanded ? "Ocultar etapas" : `Ver etapas (${stats.total})`}${bdIcon("chev-down")}</button>` : "<span></span>"}
      <div class="wf-actions">
        <button type="button" class="wf-icon" data-focus-action="step" data-goal-id="${goal.id}" data-delta="-1" aria-label="${stats.complete ? "Desfazer última etapa" : "Voltar uma etapa"}" title="${stats.complete ? "Desfazer última etapa" : "Voltar uma etapa"}"${stats.done ? "" : " disabled"}>${bdIcon("undo")}</button>
        ${stats.complete
          ? `<button type="button" class="bd-btn bd-btn--primary wf-advance" data-focus-action="new-goal">${bdIcon("plus")}<span>Nova meta</span></button>`
          : `<button type="button" class="bd-btn bd-btn--primary wf-advance" data-focus-action="step" data-goal-id="${goal.id}" data-delta="1">${bdIcon("check")}<span>Concluir etapa</span></button>`}
      </div>
    </div>
  </div>`;
  plannerFocusPainted = { goalId: goal.id, percent: stats.percent };
  // O anel anda do valor anterior até o novo (sem reiniciar do zero).
  const bar = root.querySelector(".wf-ring-bar");
  if (bar && fromPercent !== stats.percent) requestAnimationFrame(() => requestAnimationFrame(() => bar.style.setProperty("--p", stats.percent)));
}

// Concluiu a meta em foco e há outra em aberto: depois de comemorar, o foco
// passa sozinho para a próxima (sem precisar sair da tela nem recarregar).
function schedulePlannerFocusAdvance(goalId) {
  clearTimeout(plannerFocusAdvanceTimer);
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal || !goalStats(goal).complete) return;
  const nextIndex = state.goals.findIndex((g) => g.id !== goalId && !goalStats(g).complete);
  if (nextIndex < 0) return;
  plannerFocusAdvanceTimer = setTimeout(() => {
    const current = plannerFocusGoal();
    if (current?.goal?.id !== goalId || !goalStats(current.goal).complete) return;
    plannerFocusIndex = state.goals.findIndex((g) => g.id !== goalId && !goalStats(g).complete);
    if (plannerFocusIndex < 0) plannerFocusIndex = null;
    plannerFocusExpanded = false;
    renderPlannerGoalsStrip();
  }, 2600);
}

// ── Dica do Pulsinho (regras locais sobre os dados reais, sem chamar IA) ──
function renderPlannerTip() {
  const el = document.querySelector("#plannerTip");
  if (!el) return;
  const open = (t) => t.status !== "Concluida" && t.status !== "Cancelada";
  const overdue = state.tasks.filter((t) => open(t) && t.dueDate && t.dueDate < todayIso);
  const todayTasks = state.tasks.filter((t) => t.dueDate === todayIso && t.status !== "Cancelada");
  const todayPending = todayTasks.filter(open);
  const todayEvents = state.events.filter((e) => e.date === todayIso);
  const focus = plannerFocusGoal();
  const remaining = focus ? goalStats(focus.goal).remaining : 0;
  let text;
  if (focus && remaining > 0 && remaining <= 2) text = `Você está no ritmo! Falta${remaining === 1 ? "" : "m"} apenas ${remaining} etapa${remaining === 1 ? "" : "s"} para concluir seu foco da semana.`;
  else if (overdue.length) text = `Você tem ${overdue.length} tarefa${overdue.length === 1 ? "" : "s"} atrasada${overdue.length === 1 ? "" : "s"}. Que tal resolver a mais antiga primeiro?`;
  else if (todayTasks.length && !todayPending.length) text = "Tudo concluído por hoje. Ótimo trabalho!";
  else if (!todayTasks.length && !todayEvents.length) text = "Dia livre! Aproveite para planejar a semana.";
  else text = `Hoje você tem ${todayPending.length} tarefa${todayPending.length === 1 ? "" : "s"} e ${todayEvents.length} compromisso${todayEvents.length === 1 ? "" : "s"}. Comece pelo que tem prazo mais curto.`;
  el.innerHTML = `<div class="bp-tip-head">${bdIcon("sparkle")}<strong>Pulsinho</strong><span class="bd-badge">Dica</span></div><p>${escapeHtml(text)}</p>`;
}

// ── Tarefas por grupo ───────────────────────────────────────
// Lista organizada pelo que pede atenção primeiro: Atrasadas → Hoje →
// Amanhã → Esta semana → Mais adiante → Sem data. Grupos vazios somem.
function getPlannerTaskGroups() {
  const isOpen = (t) => t.status !== "Concluida" && t.status !== "Cancelada";
  const byDue = (a, b) => `${a.dueDate || "9999"}${a.dueTime || "99:99"}`.localeCompare(`${b.dueDate || "9999"}${b.dueTime || "99:99"}`) || (a.title || "").localeCompare(b.title || "");
  const weekEnd = getWeekDays(new Date(`${todayIso}T12:00:00`))[6];
  const today = state.tasks.filter((t) => t.dueDate === todayIso && t.status !== "Cancelada").sort((a, b) => Number(a.status === "Concluida") - Number(b.status === "Concluida") || byDue(a, b));
  const overdue = state.tasks.filter((t) => isOpen(t) && t.dueDate && t.dueDate < todayIso).sort(byDue);
  const tomorrow = state.tasks.filter((t) => isOpen(t) && t.dueDate === tomorrowIso).sort(byDue);
  const week = state.tasks.filter((t) => isOpen(t) && t.dueDate > tomorrowIso && t.dueDate <= weekEnd).sort(byDue);
  const later = state.tasks.filter((t) => isOpen(t) && t.dueDate > tomorrowIso && t.dueDate > weekEnd).sort(byDue);
  const undated = state.tasks.filter((t) => isOpen(t) && !t.dueDate).sort(byDue);
  return [
    { key: "overdue", label: "Atrasadas", items: overdue, tone: "red" },
    { key: "today", label: "Hoje", items: today, tone: "violet" },
    { key: "tomorrow", label: "Amanhã", items: tomorrow, tone: "blue" },
    { key: "week", label: "Esta semana", items: week, tone: "green" },
    { key: "later", label: "Mais adiante", items: later, tone: "muted" },
    { key: "undated", label: "Sem data", items: undated, tone: "muted" },
  ];
}

function renderPlannerList() {
  const root = document.querySelector("#plannerListBody");
  if (!root) return;
  const query = (elements.globalSearch.value || "").trim().toLowerCase();
  const groups = getPlannerTaskGroups().map((g) => ({ ...g, items: g.items.filter((t) => !query || (t.title || "").toLowerCase().includes(query)) }));
  if (!plannerGroupsInitialised) {
    plannerGroupsInitialised = true;
    // No celular abrem só os grupos que pedem ação agora.
    if (window.matchMedia("(max-width: 760px)").matches) ["week", "later", "undated"].forEach((key) => plannerCollapsedGroups.add(key));
  }
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  const countEl = document.querySelector("#plannerTaskCount");
  if (countEl) countEl.textContent = `${total} tarefa${total === 1 ? "" : "s"}`;
  if (!total) {
    root.innerHTML = emptyStateHtml({
      iconName: "inbox",
      title: query ? "Nada encontrado" : "Sua lista está limpa",
      desc: query ? "Nenhuma tarefa combina com a busca." : "Tarefas aparecem aqui, organizadas por prazo: atrasadas, hoje, amanhã e depois.",
      ctaLabel: query ? "" : "Adicionar tarefa",
      ctaOnClick: "openPlannerQuickAdd('task')",
    });
    return;
  }
  root.innerHTML = groups.filter((g) => g.items.length).map((g) => {
    const collapsed = plannerCollapsedGroups.has(g.key);
    const done = g.key === "today" ? g.items.filter((t) => t.status === "Concluida").length : 0;
    const meta = g.key === "today" && g.items.length
      ? `<span class="bp-group-meta">${done}/${g.items.length} feitas</span>`
      : `<span class="bp-group-count">${g.items.length}</span>`;
    return `<section class="bp-group bp-group--${g.tone}${g.key === "overdue" ? " is-overdue" : ""}${collapsed ? " is-collapsed" : ""}" data-group="${g.key}">
      <button type="button" class="bp-group-head" data-group-toggle="${g.key}" aria-expanded="${!collapsed}">
        <span class="bp-group-label">${g.label}</span>${meta}<span class="bp-group-caret">${bdIcon("chev-down")}</span>
      </button>
      ${g.key === "today" && g.items.length ? `<span class="bp-group-progress" aria-hidden="true"><i style="width:${Math.round((done / g.items.length) * 100)}%"></i></span>` : ""}
      <div class="bp-group-body">${g.items.map(renderPlannerTaskRow).join("")}</div>
    </section>`;
  }).join("");
}

function renderPlannerTaskRow(task) {
  const isDone = task.status === "Concluida";
  const overdue = !isDone && task.status !== "Cancelada" && task.dueDate && task.dueDate < todayIso;
  const subtasks = task.subtasks || [];
  const doneCount = subtasks.filter((s) => s.done).length;
  const detailsOpen = plannerExpandedTaskDetails.has(task.id);
  const priority = PLANNER_PRIORITY_LABEL[task.priority] ? task.priority : "Media";
  let due;
  if (!task.dueDate) due = `${bdIcon("clock")}Sem data`;
  else if (task.dueDate === todayIso) due = task.dueTime ? `${bdIcon("clock")}Até ${escapeHtml(task.dueTime)}` : (isDone ? "" : `${bdIcon("calendar")}Hoje`);
  else if (task.dueDate === offsetDate(1)) due = `${bdIcon("calendar")}Amanhã`;
  else due = `${bdIcon(overdue ? "alert" : "calendar")}${escapeHtml(plannerShortDate(task.dueDate))}`;
  const extras = [
    task.status === "Em andamento" ? `<em class="bp-status">Em andamento</em>` : "",
    task.recurrence ? `<span class="bp-meta" title="Repete">${bdIcon("repeat")}</span>` : "",
    subtasks.length ? `<span class="bp-meta" title="Checklist">${bdIcon("check-circle")}${doneCount}/${subtasks.length}</span>` : "",
  ].join("");
  return `<article class="bp-task${isDone ? " is-done" : ""}${overdue ? " is-overdue" : ""}" data-task-id="${task.id}" data-priority="${priority}">
    <div class="bp-task-head">
      <button type="button" class="bp-check${isDone ? " is-done" : ""}" onclick="toggleTask('${task.id}')" aria-pressed="${isDone}" aria-label="${isDone ? "Reabrir" : "Concluir"} tarefa: ${escapeHtml(task.title)}">${isDone ? bdIcon("check") : ""}</button>
      <button type="button" class="bp-task-title" title="${escapeHtml(task.title)}" onclick="toggleTaskDetails('${task.id}', event)" aria-expanded="${detailsOpen}"><span>${escapeHtml(task.title)}</span>${extras}</button>
      <span class="bp-chip bp-chip--${priority}">${PLANNER_PRIORITY_LABEL[priority]}</span>
      <span class="bp-due">${due}</span>
      <button type="button" class="bp-kebab" onclick="openPlannerTaskActions('${task.id}', event)" aria-label="Mais opções: ${escapeHtml(task.title)}">${bdIcon("dots-v")}</button>
    </div>
    <div class="task-subtasks ${detailsOpen ? "open" : ""}">
      ${subtasks.map((s) => `
        <div class="task-subtask-row">
          <button type="button" class="task-subtask-check ${s.done ? "done" : ""}" onclick="toggleSubtask('${task.id}','${s.id}', event)" aria-label="Alternar item">${s.done ? icon("check", 11) : ""}</button>
          <span class="${s.done ? "done" : ""}">${escapeHtml(s.title)}</span>
          <button type="button" class="mini-button" onclick="deleteSubtask('${task.id}','${s.id}', event)" aria-label="Remover item">${icon("x", 11)}</button>
        </div>`).join("") || `<p class="planner-goal-milestones-empty">Sem itens na checklist ainda.</p>`}
      <form class="planner-inline-add-form" onsubmit="return submitSubtaskForm('${task.id}', event)">
        <input type="text" maxlength="80" placeholder="Item da checklist..." autocomplete="off" />
        <button type="submit" class="mini-button" title="Adicionar item">${icon("plus", 13)}</button>
      </form>
    </div>
  </article>`;
}

// ── Compromissos ────────────────────────────────────────────
function renderPlannerEventRow(ev) {
  const style = plannerEventStyle(ev);
  return `<article class="bp-event ev-${style.tone}" data-event-id="${ev.id}">
    <span class="bp-event-ico">${bdIcon(style.icon)}</span>
    <button type="button" class="bp-event-main" onclick="openPlannerEventEditor('${ev.id}')">
      <strong>${escapeHtml(ev.title)}</strong>
      <small>${escapeHtml(plannerTimeRange(ev))}${ev.date ? ` · ${escapeHtml(plannerShortDate(ev.date))}` : ""}${ev.location && ev.location !== "Sem local" ? ` · ${escapeHtml(ev.location)}` : ""}</small>
    </button>
    <button type="button" class="bp-kebab" onclick="openPlannerEventActions('${ev.id}', event)" aria-label="Mais opções: ${escapeHtml(ev.title)}">${bdIcon("dots-v")}</button>
  </article>`;
}

// Agenda por hora da semana (cartões ficam na hora de início, lado a lado se coincidirem)
function renderPlannerWeekAgenda() {
  const root = document.querySelector("#plannerWeekAgenda");
  if (!root) return;
  const days = getWeekDays(new Date(`${todayIso}T12:00:00`));
  const rangeEl = document.querySelector("#plannerWeekRange");
  if (rangeEl) rangeEl.textContent = `${plannerShortDate(days[0])} – ${plannerShortDate(days[6])}`;
  const query = (elements.globalSearch.value || "").trim().toLowerCase();
  const events = state.events
    .filter((e) => days.includes(e.date) && e.time && (!query || (e.title || "").toLowerCase().includes(query)))
    .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const startOf = (e) => toMin(e.time);
  const endOf = (e) => (e.endTime && toMin(e.endTime) > startOf(e) ? toMin(e.endTime) : startOf(e) + 60);
  const first = events.length ? Math.floor(Math.min(...events.map(startOf)) / 60) : 9;
  const last = events.length ? Math.ceil(Math.max(...events.map(endOf)) / 60) : 18;
  const axisStart = Math.min(9, first);
  const axisEnd = Math.max(18, last);
  const ROW = 36;
  const multiDay = new Set(events.map((e) => e.date)).size > 1;
  // colunas para eventos que se sobrepõem no mesmo horário
  const placed = [];
  for (const e of events) {
    const used = placed.filter((p) => p.end > startOf(e) && p.start < endOf(e)).map((p) => p.col);
    let col = 0;
    while (used.includes(col)) col += 1;
    placed.push({ e, start: startOf(e), end: endOf(e), col });
  }
  const colsAt = (p) => Math.max(...placed.filter((q) => q.end > p.start && q.start < p.end).map((q) => q.col)) + 1;
  const hours = [];
  for (let h = axisStart; h <= axisEnd; h += 1) hours.push(`<div class="bp-hour" style="height:${ROW}px"><span>${String(h).padStart(2, "0")}:00</span></div>`);
  const cards = placed.map((p) => {
    const style = plannerEventStyle(p.e);
    const cols = colsAt(p);
    const top = ((p.start - axisStart * 60) / 60) * ROW + 2;
    const height = Math.max(32, ((p.end - p.start) / 60) * ROW - 4);
    return `<article class="bp-hour-event ev-${style.tone}" style="top:${top}px;height:${height}px;left:calc(${(p.col / cols) * 100}% + 2px);width:calc(${100 / cols}% - 4px)" data-event-id="${p.e.id}">
      <button type="button" class="bp-hour-main" onclick="openPlannerEventEditor('${p.e.id}')">
        <span class="bp-event-ico">${bdIcon(style.icon)}</span>
        <span><strong>${escapeHtml(p.e.title)}</strong><small>${escapeHtml(plannerTimeRange(p.e))}${multiDay ? ` · ${escapeHtml(plannerShortDate(p.e.date))}` : ""}</small></span>
      </button>
      <button type="button" class="bp-kebab" onclick="openPlannerEventActions('${p.e.id}', event)" aria-label="Mais opções: ${escapeHtml(p.e.title)}">${bdIcon("dots-v")}</button>
    </article>`;
  }).join("");
  root.innerHTML = `<div class="bp-hours-axis">${hours.join("")}</div><div class="bp-hours-events" style="height:${(axisEnd - axisStart + 1) * ROW}px">${cards}</div>${events.length ? "" : '<p class="bp-hours-empty">Sem compromissos com horário nesta semana.</p>'}`;
}

// ── Agenda do dia (painel da direita / "Compromissos de hoje" no celular) ──
function renderPlannerAgenda() {
  const body = document.querySelector("#plannerAgendaBody");
  if (!body) return;
  const isToday = plannerDayDate === todayIso;
  const events = state.events.filter((e) => e.date === plannerDayDate).sort(sortEvent);
  const tasks = state.tasks.filter((t) => t.dueDate === plannerDayDate && t.status !== "Cancelada")
    .sort((a, b) => Number(a.status === "Concluida") - Number(b.status === "Concluida") || (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99"));
  const set = (selector, value) => { const el = document.querySelector(selector); if (el) el.textContent = value; };
  set("#plannerAgendaTitle", isToday ? "Agenda do dia" : "Agenda");
  set("#plannerAgendaDate", plannerShortDate(plannerDayDate));
  set("#plannerAgendaEventsChip", `${events.length} compromisso${events.length === 1 ? "" : "s"}`);
  set("#plannerAgendaTasksChip", `${tasks.length} tarefa${tasks.length === 1 ? "" : "s"}`);
  document.querySelectorAll("[data-agenda-mode]").forEach((btn) => btn.classList.toggle("active", btn.dataset.agendaMode === plannerAgendaMode));
  const agendaTitle = document.querySelector("#plannerAgendaTitle");
  if (agendaTitle) agendaTitle.dataset.mobileTitle = isToday ? `Compromissos de hoje • ${events.length}` : `Compromissos • ${events.length}`;
  if (plannerAgendaMode === "tasks") {
    body.innerHTML = tasks.length ? tasks.map(renderPlannerTaskRow).join("") : emptyStateCompactHtml({ iconName: "calendarCheck", text: "Nenhuma tarefa para este dia." });
  } else {
    body.innerHTML = events.length
      ? events.map((ev) => {
          const style = plannerEventStyle(ev);
          return `<div class="bp-agenda-item"><span class="bp-agenda-time">${escapeHtml(ev.time || "—")}</span>
            <article class="bp-agenda-card ev-${style.tone}" data-event-id="${ev.id}">
              <button type="button" class="bp-agenda-main" onclick="openPlannerEventEditor('${ev.id}')"><strong>${escapeHtml(ev.title)}</strong><small>${escapeHtml(plannerTimeRange(ev))}${ev.location && ev.location !== "Sem local" ? ` · ${escapeHtml(ev.location)}` : ""}</small></button>
              <button type="button" class="bp-kebab" onclick="openPlannerEventActions('${ev.id}', event)" aria-label="Mais opções: ${escapeHtml(ev.title)}">${bdIcon("dots-v")}</button>
            </article></div>`;
        }).join("")
      : emptyStateCompactHtml({ iconName: "compass", text: "Nenhum compromisso neste dia." });
  }
}

function renderPlanner() {
  const mobileDate = document.querySelector("#plannerMobileDate span");
  if (mobileDate) mobileDate.textContent = bdFormatBoardDate();
  renderPlannerGoalsStrip();
  if (plannerActiveTab === "list") {
    renderPlannerList();
    renderPlannerWeekAgenda();
    renderPlannerAgenda();
  } else if (plannerActiveTab === "day") renderPlannerDay();
  else if (plannerActiveTab === "week") renderPlannerWeek();
  else if (plannerActiveTab === "month") renderPlannerMonth();
}

// Menu "⋮" do compromisso: editar ou excluir (um botão em vez de dois ícones soltos)
function closePlannerEventActions() {
  document.querySelector("#plannerEventActionsSheet")?.remove();
}

function openPlannerEventActions(id, event) {
  event?.stopPropagation();
  closePlannerEventActions();
  const ev = state.events.find((item) => item.id === id);
  if (!ev) return;
  const sheet = document.createElement("div");
  sheet.id = "plannerEventActionsSheet";
  sheet.className = "modal-backdrop";
  sheet.innerHTML = `<div class="modal-card planner-action-sheet" role="dialog" aria-modal="true">
    <div class="modal-header"><h2>${escapeHtml(ev.title)}</h2><button type="button" class="icon-button" id="plannerEventActionsClose" aria-label="Fechar">${icon("x", 18)}</button></div>
    <div class="modal-body planner-action-sheet-body">
      <p class="planner-action-sheet-label">${escapeHtml(plannerShortDate(ev.date))} · ${escapeHtml(plannerTimeRange(ev))}</p>
      <button type="button" class="planner-action-option" id="plannerEventActionsEdit"><span>Editar compromisso</span>${icon("pencil", 14)}</button>
      <button type="button" class="planner-action-danger" id="plannerEventActionsDelete">${icon("trash", 15)}<span>Excluir compromisso</span></button>
    </div></div>`;
  document.body.appendChild(sheet);
  const onKey = (e) => { if (e.key === "Escape") { closePlannerEventActions(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closePlannerEventActions(); });
  sheet.querySelector("#plannerEventActionsClose").addEventListener("click", closePlannerEventActions);
  sheet.querySelector("#plannerEventActionsEdit").addEventListener("click", () => { closePlannerEventActions(); openPlannerEventEditor(id); });
  sheet.querySelector("#plannerEventActionsDelete").addEventListener("click", () => { closePlannerEventActions(); deleteEvent(id); showToast("Compromisso excluído."); });
}

// Editar tarefa (título, prioridade, data, horário) reaproveitando o formulário de adicionar
function openPlannerTaskEditor(id) {
  const task = state.tasks.find((item) => item.id === id);
  const modal = document.querySelector("#plannerQuickAddModal");
  if (!task || !modal) return;
  plannerEditingEventId = null;
  plannerEditingTaskId = id;
  modal.hidden = false;
  document.querySelector("#plannerQuickAddModal h2").textContent = "Editar tarefa";
  document.querySelector("#plannerQuickAddForm [type='submit'] span").textContent = "Salvar alterações";
  setPlannerQuickAddType("task");
  document.querySelector("#pqaTitle").value = task.title || "";
  document.querySelector("#pqaTaskPriority").value = task.priority || "Media";
  document.querySelector("#pqaTaskDue").value = task.dueDate || "";
  document.querySelector("#pqaTaskTime").value = task.dueTime || "";
  setReminderChoice("#pqaTaskReminder", "#pqaTaskReminderMinutes", "#pqaTaskReminderCustom", task.reminder);
  document.querySelectorAll("#plannerQuickAddType button").forEach((b) => { b.hidden = b.dataset.quickType !== "task"; });
  setTimeout(() => document.querySelector("#pqaTitle")?.focus(), 50);
}

function setPlannerTab(tab) {
  plannerActiveTab = tab;
  const buttons = [...document.querySelectorAll("#plannerView .planner-tabs button[data-planner-tab]")];
  buttons.forEach((b) => {
    const on = b.dataset.plannerTab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  });
  // Indicador deslizante: a pílula ativa corre até a aba escolhida.
  const tabs = document.querySelector("#plannerView .planner-tabs");
  if (tabs) tabs.style.setProperty("--tab-i", String(Math.max(0, buttons.findIndex((b) => b.dataset.plannerTab === tab))));
  document.querySelectorAll("#plannerView .planner-subview").forEach((el) => {
    el.classList.toggle("active", el.dataset.plannerSubview === tab);
  });
  renderPlanner();
}

function bindPlannerNav() {
  const tabButtons = [...document.querySelectorAll("#plannerView .planner-tabs button[data-planner-tab]")];
  tabButtons.forEach((btn, index) => {
    btn.addEventListener("click", () => setPlannerTab(btn.dataset.plannerTab));
    // Setas do teclado trocam de aba (padrão de abas acessíveis).
    btn.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const next = tabButtons[(index + (event.key === "ArrowRight" ? 1 : tabButtons.length - 1)) % tabButtons.length];
      setPlannerTab(next.dataset.plannerTab);
      next.focus();
    });
  });
  const tabsEl = document.querySelector("#plannerView .planner-tabs");
  if (tabsEl && !tabsEl.querySelector(".bp-tab-ink")) {
    const ink = document.createElement("span");
    ink.className = "bp-tab-ink";
    ink.setAttribute("aria-hidden", "true");
    tabsEl.prepend(ink);
    tabsEl.style.setProperty("--tab-i", String(Math.max(0, tabButtons.findIndex((b) => b.classList.contains("active")))));
  }
  document.querySelector("#plannerDayPrev")?.addEventListener("click", () => changePlannerDay(-1));
  document.querySelector("#plannerDayNext")?.addEventListener("click", () => changePlannerDay(1));
  document.querySelector("#plannerDayToday")?.addEventListener("click", goToPlannerToday);
  document.querySelector("#plannerWeekPrev")?.addEventListener("click", () => changePlannerWeek(-1));
  document.querySelector("#plannerWeekNext")?.addEventListener("click", () => changePlannerWeek(1));
  document.querySelector("#plannerWeekToday")?.addEventListener("click", goToPlannerThisWeek);
  document.querySelector("#plannerMonthPrev")?.addEventListener("click", () => changePlannerMonth(-1));
  document.querySelector("#plannerMonthNext")?.addEventListener("click", () => changePlannerMonth(1));
  document.querySelector("#plannerMonthToday")?.addEventListener("click", goToPlannerThisMonth);
  bindPlannerMonth();
  document.querySelector("#plannerNewGoalBtn")?.addEventListener("click", () => { closePlannerGoalsModal(); openPlannerQuickAdd("goal"); });
  document.querySelector("#plannerNewTaskBtn")?.addEventListener("click", () => openPlannerQuickAdd("task"));

  // Agenda do dia: ‹ › e alternância compromissos/tarefas
  document.querySelector("#plannerAgendaPrev")?.addEventListener("click", () => changePlannerDay(-1));
  document.querySelector("#plannerAgendaNext")?.addEventListener("click", () => changePlannerDay(1));
  document.querySelectorAll("[data-agenda-mode]").forEach((btn) => btn.addEventListener("click", () => {
    plannerAgendaMode = btn.dataset.agendaMode;
    renderPlannerAgenda();
  }));

  // Grupos de tarefas (abrir/fechar)
  document.querySelector("#plannerListBody")?.addEventListener("click", (event) => {
    const head = event.target.closest("[data-group-toggle]");
    if (!head) return;
    const key = head.dataset.groupToggle;
    if (plannerCollapsedGroups.has(key)) plannerCollapsedGroups.delete(key);
    else plannerCollapsedGroups.add(key);
    renderPlannerList();
  });

  // Foco da semana: marcos, troca de meta e gerenciamento
  document.querySelector("#plannerFocus")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-focus-action]");
    if (!button) return;
    const action = button.dataset.focusAction;
    const count = state.goals.length;
    if (action === "toggle-ms") {
      const before = goalStats(state.goals.find((g) => g.id === button.dataset.goalId));
      toggleGoalMilestone(button.dataset.goalId, button.dataset.msId, event);
      if (!before.complete && goalStats(state.goals.find((g) => g.id === button.dataset.goalId)).complete) celebrate("Meta concluída! Mandou bem.");
    }
    else if (action === "step") stepGoal(button.dataset.goalId, Number(button.dataset.delta) || 0);
    else if (action === "set-step") setGoalStep(button.dataset.goalId, Number(button.dataset.step) || 0);
    else if (action === "expand") { plannerFocusExpanded = !plannerFocusExpanded; renderPlannerFocus(); }
    else if (action === "idea") {
      openPlannerQuickAdd("goal");
      const title = document.querySelector("#pqaTitle");
      if (title) title.value = button.dataset.idea || "";
    }
    else if (action === "manage") openPlannerGoalsModal();
    else if (action === "new-goal") openPlannerQuickAdd("goal");
    else if ((action === "prev" || action === "next") && count > 1) {
      const current = plannerFocusGoal()?.index ?? 0;
      plannerFocusIndex = (current + (action === "next" ? 1 : -1) + count) % count;
      plannerFocusExpanded = false;
      clearTimeout(plannerFocusAdvanceTimer);
      renderPlannerGoalsStrip();
    }
    if (["toggle-ms", "step", "set-step"].includes(action) && button.dataset.goalId) schedulePlannerFocusAdvance(button.dataset.goalId);
  });
  // Painel "Metas": ações dos cartões
  document.querySelector("#plannerGoalsStrip")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-goal-action]");
    if (!button) return;
    const id = button.dataset.goalId;
    const action = button.dataset.goalAction;
    if (action === "toggle-ms") {
      const before = goalStats(state.goals.find((g) => g.id === id));
      toggleGoalMilestone(id, button.dataset.msId, event);
      if (!before.complete && goalStats(state.goals.find((g) => g.id === id)).complete) celebrate("Meta concluída! Mandou bem.");
    } else if (action === "del-ms") deleteGoalMilestone(id, button.dataset.msId, event);
    else if (action === "step") stepGoal(id, Number(button.dataset.delta) || 0);
    else if (action === "set-step") setGoalStep(id, Number(button.dataset.step) || 0);
    else if (action === "expand") {
      togglePlannerGoalExpand(id, event);
      if (plannerExpandedGoals.has(id)) requestAnimationFrame(() => document.querySelector(`#plannerGoalsStrip [data-goal-id="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    } else if (action === "focus") {
      plannerFocusIndex = state.goals.findIndex((g) => g.id === id);
      renderPlannerGoalsStrip();
      showToast("Meta colocada em foco.");
    } else if (action === "delete") {
      const goal = state.goals.find((g) => g.id === id);
      if (!goal) return;
      const position = state.goals.indexOf(goal);
      deleteGoal(id);
      if (plannerFocusIndex !== null && plannerFocusIndex >= state.goals.length) plannerFocusIndex = null;
      renderPlannerGoalsStrip();
      // Desfazer em vez de pedir confirmação (confirm() falha no PWA do iPhone).
      showToast(`Meta “${goal.title}” excluída.`, {
        actionLabel: "Desfazer",
        onAction: () => { state.goals.splice(position, 0, goal); saveState(); renderAll(); renderPlannerGoalsStrip(); },
      });
    }
  });
  document.querySelector("#plannerGoalsClose")?.addEventListener("click", closePlannerGoalsModal);
  document.querySelector("#plannerGoalsModal")?.addEventListener("click", (event) => { if (event.target.id === "plannerGoalsModal") closePlannerGoalsModal(); });
}

function openPlannerGoalsModal() {
  const modal = document.querySelector("#plannerGoalsModal");
  if (!modal) return;
  modal.hidden = false;
  renderPlannerGoalsStrip();
}

function closePlannerGoalsModal() {
  const modal = document.querySelector("#plannerGoalsModal");
  if (modal) modal.hidden = true;
}

// ── Cor determinística por item (mesma paleta pastel das notas) —
// dá o efeito "colorido" do Calendars sem precisar de um campo novo
// de cor no compromisso.
function plannerColorTone(id) {
  const tones = [
    { bg: "var(--note-blue)", border: "var(--note-blue-border)" },
    { bg: "var(--note-green)", border: "var(--note-green-border)" },
    { bg: "var(--note-pink)", border: "var(--note-pink-border)" },
    { bg: "var(--note-purple)", border: "var(--note-purple-border)" },
    { bg: "var(--note-orange)", border: "var(--note-orange-border)" },
    { bg: "var(--note-teal)", border: "var(--note-teal-border)" },
    { bg: "var(--note-yellow)", border: "var(--note-yellow-border)" },
    { bg: "var(--note-red)", border: "var(--note-red-border)" },
  ];
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return tones[Math.abs(hash) % tones.length];
}

function noteColorTone(note) {
  const tones = {
    blue:   { bg: "var(--note-blue)", border: "var(--note-blue-border)" },
    green:  { bg: "var(--note-green)", border: "var(--note-green-border)" },
    pink:   { bg: "var(--note-pink)", border: "var(--note-pink-border)" },
    purple: { bg: "var(--note-purple)", border: "var(--note-purple-border)" },
    orange: { bg: "var(--note-orange)", border: "var(--note-orange-border)" },
    teal:   { bg: "var(--note-teal)", border: "var(--note-teal-border)" },
  };
  return tones[note?.color] || plannerColorTone(note?.id);
}

// ── Metas: fita horizontal compacta, sempre visível no topo do
// Planner, com marcos expansíveis (toque no card pra abrir/fechar) ──
function togglePlannerGoalExpand(id, event) {
  event?.stopPropagation();
  if (plannerExpandedGoals.has(id)) plannerExpandedGoals.delete(id);
  else plannerExpandedGoals.add(id);
  renderPlannerGoalsStrip();
}

function renderPlannerGoalsStrip() {
  renderPlannerFocus();
  renderPlannerTip();
  const root = document.querySelector("#plannerGoalsStrip");
  if (!root) return;
  const goals = state.goals;
  if (!goals.length) {
    // Sem botão aqui de propósito: o cabeçalho deste painel já tem um
    // "Nova meta" fixo logo acima — repetir o mesmo botão dentro do
    // estado vazio era redundante (dois botões idênticos, um em cima
    // do outro, fazendo exatamente a mesma coisa).
    root.innerHTML = emptyStateHtml({
      iconName: "target",
      title: "Defina sua primeira meta",
      desc: "Metas ficam fixadas aqui em cima, com marcos que você vai riscando conforme avança. Toque em \"Nova meta\" ali em cima pra criar a primeira.",
      mascot: true,
      mascotBadgeIcon: "target",
    });
    return;
  }
  const focusId = plannerFocusGoal()?.goal?.id;
  root.innerHTML = goals.map((goal) => goalManageCardHtml(goal, goal.id === focusId)).join("");
}

// Cartão de meta no painel "Metas": anel, trilha de etapas, controles
// grandes ao toque e as etapas nomeadas (expansíveis) com campo para
// adicionar mais. Sem prompt() nativo — não funciona no PWA do iPhone.
function goalManageCardHtml(goal, isFocus) {
  const stats = goalStats(goal);
  const expanded = plannerExpandedGoals.has(goal.id);
  const steps = expanded
    ? `<div class="gm-steps">
        ${stats.milestones.length
          ? `<ul class="gm-ms">${stats.milestones.map((m) => `<li class="${m.done ? "is-done" : ""}">
              <button type="button" class="gm-ms-check" data-goal-action="toggle-ms" data-goal-id="${goal.id}" data-ms-id="${m.id}" aria-pressed="${m.done}" aria-label="${m.done ? "Desmarcar" : "Concluir"} etapa: ${escapeHtml(m.title)}">${m.done ? bdIcon("check") : ""}</button>
              <span>${escapeHtml(m.title)}</span>
              <button type="button" class="gm-ms-del" data-goal-action="del-ms" data-goal-id="${goal.id}" data-ms-id="${m.id}" aria-label="Remover etapa ${escapeHtml(m.title)}">${bdIcon("x")}</button>
            </li>`).join("")}</ul>`
          : `<p class="gm-ms-empty">Dê nome às etapas para marcar uma a uma (ex.: “Capítulo 1”, “Primeiros 5 km”).</p>`}
        <form class="gm-add" onsubmit="return submitGoalMilestoneForm('${goal.id}', event)">
          <input type="text" maxlength="60" placeholder="Nova etapa…" autocomplete="off" enterkeyhint="done" aria-label="Nome da nova etapa" />
          <button type="submit" class="bd-btn bd-btn--primary" aria-label="Adicionar etapa">${bdIcon("plus")}</button>
        </form>
      </div>`
    : "";
  return `<article class="gm-card${stats.complete ? " is-complete" : ""}${expanded ? " is-expanded" : ""}" data-goal-id="${goal.id}">
    <div class="gm-top">
      ${goalRingHtml(stats, "sm")}
      <div class="gm-main">
        <strong>${escapeHtml(goal.title)}</strong>
        <small>${stats.complete ? "Concluída" : `${stats.done} de ${stats.total} etapa${stats.total === 1 ? "" : "s"}`}${isFocus ? ' · <b class="gm-focus-tag">em foco</b>' : ""}</small>
      </div>
      <button type="button" class="gm-icon gm-del" data-goal-action="delete" data-goal-id="${goal.id}" aria-label="Excluir meta ${escapeHtml(goal.title)}">${bdIcon("trash")}</button>
    </div>
    ${goalStepsHtml(goal, stats, "goal")}
    <div class="gm-controls">
      <div class="gm-stepper" role="group" aria-label="Ajustar progresso">
        <button type="button" data-goal-action="step" data-goal-id="${goal.id}" data-delta="-1" aria-label="Voltar uma etapa"${stats.done ? "" : " disabled"}>−</button>
        <span>${stats.done}/${stats.total}</span>
        <button type="button" data-goal-action="step" data-goal-id="${goal.id}" data-delta="1" aria-label="Avançar uma etapa"${stats.complete ? " disabled" : ""}>+</button>
      </div>
      <button type="button" class="gm-toggle" data-goal-action="expand" data-goal-id="${goal.id}" aria-expanded="${expanded}">${bdIcon("flag")}<span>${stats.named ? "Etapas" : "Nomear etapas"}</span>${bdIcon("chev-down")}</button>
      ${isFocus ? "" : `<button type="button" class="gm-icon" data-goal-action="focus" data-goal-id="${goal.id}" aria-label="Colocar em foco" title="Colocar em foco">${bdIcon("target")}</button>`}
    </div>
    ${steps}
  </article>`;
}

// Cria um marco a partir do input do próprio card (sem prompt() nativo —
// ver comentário acima). Mantém o goal expandido e devolve o foco ao
// campo pra permitir adicionar vários marcos em sequência rapidamente.
function submitGoalMilestoneForm(id, event) {
  event.preventDefault();
  const input = event.target.querySelector("input");
  const title = (input?.value || "").trim();
  if (!title) return false;
  const goal = state.goals.find((g) => g.id === id);
  if (!goal) return false;
  const hadNoNames = !(goal.milestones || []).length && ((Number(goal.target) || 0) > 1 || (Number(goal.current) || 0) > 0);
  addNamedGoalMilestone(goal, title);
  saveState();
  if (hadNoNames) showToast(`Etapas nomeadas. Seu progresso (${goal.current}/${goal.target}) foi mantido.`, { tone: "success" });
  renderPlannerGoalsStrip();
  renderGoals();
  const freshInput = document.querySelector(`[data-goal-id="${id}"] .gm-add input, [data-goal-id="${id}"] .planner-inline-add-form input`);
  freshInput?.focus();
  return false;
}

// ── Dia: navegador de data + checklist do dia + timeline por hora ──
function changePlannerDay(delta) {
  const date = new Date(`${plannerDayDate}T12:00:00`);
  date.setDate(date.getDate() + delta);
  plannerDayDate = toLocalIso(date);
  renderPlanner();
}

function goToPlannerToday() {
  plannerDayDate = todayIso;
  renderPlanner();
}

// Toca num dia da faixa horizontal (referência TaskifyAI: "F S S M T
// W T" com os números do mês, dia atual destacado) — pula direto pra
// aquele dia, sem precisar clicar em "próximo" várias vezes.
function selectPlannerDay(iso) {
  plannerDayDate = iso;
  renderPlanner();
}

function renderPlannerDayStrip() {
  const el = document.querySelector("#plannerDayStrip");
  if (!el) return;
  const WEEKDAY_LETTER = ["D", "S", "T", "Q", "Q", "S", "S"]; // Dom Seg Ter Qua Qui Sex Sáb
  const center = new Date(`${plannerDayDate}T12:00:00`);
  let html = "";
  for (let offset = -3; offset <= 3; offset++) {
    const d = new Date(center);
    d.setDate(d.getDate() + offset);
    const iso = toLocalIso(d);
    const isSelected = iso === plannerDayDate;
    const isToday = iso === todayIso;
    html += `
      <button class="planner-day-chip${isSelected ? " is-selected" : ""}${isToday && !isSelected ? " is-today" : ""}" onclick="selectPlannerDay('${iso}')">
        <span class="pdc-weekday">${WEEKDAY_LETTER[d.getDay()]}</span>
        <span class="pdc-num">${d.getDate()}</span>
      </button>
    `;
  }
  el.innerHTML = html;
}

function jumpPlannerToDay(date) {
  plannerDayDate = date;
  setPlannerTab("day");
}

function renderPlannerDay() {
  renderPlannerDayStrip();
  const label = document.querySelector("#plannerDayLabel");
  if (label) {
    const date = new Date(`${plannerDayDate}T12:00:00`);
    const relative = plannerDayDate === todayIso ? "Hoje" : plannerDayDate === tomorrowIso ? "Amanhã" : plannerDayDate === offsetDate(-1) ? "Ontem" : "";
    label.innerHTML = `${escapeHtml(`${PLANNER_WEEKDAY_NAMES[date.getDay()]}, ${date.getDate()} de ${BD_MONTHS_LONG[date.getMonth()].toLowerCase()}`)}${relative ? `<em class="bp-nav-tag${relative === "Hoje" ? " is-today" : ""}">${relative}</em>` : ""}`;
  }
  const dayToday = document.querySelector("#plannerDayToday");
  if (dayToday) dayToday.hidden = plannerDayDate === todayIso;

  const dayTasks = state.tasks.filter((t) => t.dueDate === plannerDayDate && t.status !== "Cancelada");
  const alldayRoot = document.querySelector("#plannerDayAllday");
  if (alldayRoot) {
    alldayRoot.innerHTML = dayTasks.length
      ? dayTasks.map(renderPlannerTaskRow).join("")
      : emptyStateCompactHtml({ iconName: "calendarCheck", text: "Nenhuma tarefa para este dia." });
  }

  const dayEvents = state.events.filter((e) => e.date === plannerDayDate).sort(sortEvent);
  const timeline = document.querySelector("#plannerDayTimeline");
  if (timeline) {
    const startHour = 6;
    const endHour = 23;
    // Cartões faziam parte de uma camada absoluta. Como os compromissos não
    // têm duração obrigatória, um título grande ou os botões podiam invadir
    // as linhas seguintes da agenda. A agenda agora agrupa os cartões dentro
    // do horário deles: cresce para baixo quando necessário, sem esconder
    // nenhum horário nem cobrir outro compromisso.
    const eventsByHour = new Map();
    const earlyEvents = [];
    const lateEvents = [];
    dayEvents.forEach((event) => {
      if (!event.time) return;
      const hour = Number(event.time.split(":")[0]);
      if (!Number.isFinite(hour) || hour < startHour) earlyEvents.push(event);
      else if (hour > endHour) lateEvents.push(event);
      else {
        const entries = eventsByHour.get(hour) || [];
        entries.push(event);
        eventsByHour.set(hour, entries);
      }
    });
    const renderTimelineEvent = (ev) => {
      const style = plannerEventStyle(ev);
      return `
        <article class="planner-event-block planner-event-block--interactive ev-${style.tone}" data-event-id="${ev.id}" onclick="openPlannerEventEditor('${ev.id}')">
          <div class="planner-event-block-main">
            <strong>${escapeHtml(plannerTimeRange(ev))} · ${escapeHtml(ev.title)}</strong>
            ${ev.location && ev.location !== "Sem local" ? `<span>${icon("mapPin", 11)}${escapeHtml(ev.location)}</span>` : ""}
            ${ev.notes ? `<small>${escapeHtml(ev.notes)}</small>` : ""}
          </div>
          <button type="button" class="bp-kebab" onclick="openPlannerEventActions('${ev.id}', event)" aria-label="Mais opções: ${escapeHtml(ev.title)}">${bdIcon("dots-v")}</button>
        </article>
      `;
    };
    const hourRows = [...Array(endHour - startHour + 1)]
      .map((_, i) => {
        const hour = startHour + i;
        const events = eventsByHour.get(hour) || [];
        return `<div class="planner-timeline-hour ${events.length ? "has-events" : ""}">
          <span>${String(hour).padStart(2, "0")}:00</span>
          <div class="planner-timeline-slot">
            <div class="planner-timeline-line"></div>
            ${events.length ? `<div class="planner-timeline-events">${events.map(renderTimelineEvent).join("")}</div>` : ""}
          </div>
        </div>`;
      })
      .join("");
    const noTimeEvents = dayEvents.filter((ev) => !ev.time);
    const noTimeHtml = noTimeEvents.length ? `<div class="planner-day-notime"><p class="planner-timeline-section-label">Sem horário</p>${noTimeEvents.map(renderPlannerEventRow).join("")}</div>` : "";
    const earlyHtml = earlyEvents.length ? `<div class="planner-day-notime"><p class="planner-timeline-section-label">Antes das ${String(startHour).padStart(2, "0")}:00</p>${earlyEvents.map(renderTimelineEvent).join("")}</div>` : "";
    const lateHtml = lateEvents.length ? `<div class="planner-day-notime"><p class="planner-timeline-section-label">Após ${String(endHour).padStart(2, "0")}:00</p>${lateEvents.map(renderTimelineEvent).join("")}</div>` : "";
    timeline.innerHTML = `
      ${noTimeHtml}
      ${earlyHtml}
      <div class="planner-timeline-wrap"><div class="planner-timeline-hours">${hourRows}</div></div>
      ${lateHtml}
      ${!dayEvents.length ? emptyStateCompactHtml({ iconName: "compass", text: "Nenhum compromisso neste dia." }) : ""}
    `;
  }
}

// ── Semana: 7 dias em agenda vertical, cada um levando pro Dia ──
function changePlannerWeek(delta) {
  const d = new Date(`${plannerWeekAnchor}T12:00:00`);
  d.setDate(d.getDate() + delta * 7);
  plannerWeekAnchor = toLocalIso(d);
  renderPlannerWeek();
}

function goToPlannerThisWeek() {
  plannerWeekAnchor = todayIso;
  renderPlannerWeek();
}

function renderPlannerWeek() {
  const anchorDate = new Date(`${plannerWeekAnchor}T12:00:00`);
  const days = getWeekDays(anchorDate);

  const label = document.querySelector("#plannerWeekLabel");
  if (label) {
    const first = new Date(`${days[0]}T12:00:00`);
    const last = new Date(`${days[6]}T12:00:00`);
    const sameMonth = first.getMonth() === last.getMonth();
    const fmtDay = (d) => safeFormatDate(d, { day: "2-digit" }, "--");
    const fmtMonthFull = safeFormatDate(last, { month: "long", year: "numeric" }, "");
    const current = days.includes(todayIso);
    label.innerHTML = `${escapeHtml(sameMonth
      ? `${first.getDate()} – ${last.getDate()} de ${BD_MONTHS_LONG[last.getMonth()].toLowerCase()}`
      : `${first.getDate()} ${BD_MONTHS[first.getMonth()]} – ${last.getDate()} ${BD_MONTHS[last.getMonth()]}`)}${current ? '<em class="bp-nav-tag is-today">Esta semana</em>' : ""}`;
    void fmtDay; void fmtMonthFull;
  }
  const weekToday = document.querySelector("#plannerWeekToday");
  if (weekToday) weekToday.hidden = days.includes(todayIso);

  const root = document.querySelector("#plannerWeekBody");
  if (!root) return;
  root.innerHTML = days
    .map((date) => {
      const dayTasks = state.tasks.filter((t) => t.dueDate === date && t.status !== "Cancelada" && t.status !== "Concluida");
      const dayEvents = state.events.filter((e) => e.date === date).sort(sortEvent);
      const isToday = date === todayIso;
      const d = new Date(`${date}T12:00:00`);
      let weekdayLabel = safeFormatDate(d, { weekday: "short" }, "-").replace(".", "");
      weekdayLabel = weekdayLabel.charAt(0).toUpperCase() + weekdayLabel.slice(1);
      const items = [...dayTasks.map((t) => ({ kind: "task", data: t })), ...dayEvents.map((e) => ({ kind: "event", data: e }))];
      return `
        <div class="planner-week-day ${isToday ? "is-today" : ""}">
          <button class="planner-week-day-header" type="button" onclick="jumpPlannerToDay('${date}')">
            <span class="planner-week-day-name">${weekdayLabel}</span>
            <span class="planner-week-day-num">${d.getDate()}</span>
            ${items.length ? `<span class="pill">${items.length}</span>` : ""}
            ${icon("chevronRight", 15, "planner-week-day-chevron")}
          </button>
          <div class="planner-week-day-body">
            ${
              items.length
                ? items.map((item) => (item.kind === "task" ? renderPlannerTaskRow(item.data) : renderPlannerEventRow(item.data))).join("")
                : emptyStateCompactHtml({ iconName: "sparkle", text: "Nada por aqui." })
            }
          </div>
        </div>
      `;
    })
    .join("");
}

// ── Mês: compromissos e tarefas visíveis, com excesso resumido ──
function changePlannerMonth(delta) {
  const d = new Date(`${plannerMonthAnchor}T12:00:00`);
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  plannerMonthAnchor = toLocalIso(d);
  renderPlannerMonth();
}

function goToPlannerThisMonth() {
  plannerMonthAnchor = todayIso;
  plannerMonthSelected = todayIso;
  renderPlannerMonth();
}

const PLANNER_WEEKDAY_NAMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

// Mês: grade compacta (no celular, bolinhas por tipo; no computador, os
// dois primeiros itens escritos) + a agenda do dia tocado logo abaixo.
// Tocar num dia só seleciona; "Abrir dia" leva para a lente Dia.
function plannerDayItems(date) {
  const events = state.events.filter((e) => e && e.date === date).sort(sortEvent);
  const tasks = state.tasks
    .filter((t) => t && t.dueDate === date && t.status !== "Cancelada")
    .sort((a, b) => Number(a.status === "Concluida") - Number(b.status === "Concluida") || (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99"));
  return { events, tasks };
}

function renderPlannerMonth() {
  const anchor = new Date(`${plannerMonthAnchor}T12:00:00`);
  const monthKey = plannerMonthAnchor.slice(0, 7);
  const label = document.querySelector("#plannerMonthLabel");
  if (label) {
    label.innerHTML = `${escapeHtml(`${BD_MONTHS_LONG[anchor.getMonth()]} de ${anchor.getFullYear()}`)}${monthKey === todayIso.slice(0, 7) ? '<em class="bp-nav-tag is-today">Este mês</em>' : ""}`;
  }
  const monthToday = document.querySelector("#plannerMonthToday");
  if (monthToday) monthToday.hidden = monthKey === todayIso.slice(0, 7);
  if (!plannerMonthSelected || plannerMonthSelected.slice(0, 7) !== monthKey) {
    plannerMonthSelected = monthKey === todayIso.slice(0, 7) ? todayIso : `${monthKey}-01`;
  }

  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const leadingBlanks = new Date(year, month, 1).getDay();
  const days = getMonthDays(anchor);

  const root = document.querySelector("#plannerMonthGrid");
  if (!root) return;

  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(`<div class="planner-month-cell is-blank" aria-hidden="true"></div>`);
  days.forEach((date) => {
    const { events, tasks } = plannerDayItems(date);
    const openTasks = tasks.filter((t) => t.status !== "Concluida");
    const late = openTasks.filter((t) => date < todayIso);
    const total = events.length + openTasks.length;
    const isToday = date === todayIso;
    const isSelected = date === plannerMonthSelected;
    const items = [
      ...events.map((event) => ({ label: `${event.time ? `${event.time} ` : ""}${event.title}`, kind: "event" })),
      ...openTasks.map((task) => ({ label: task.title, kind: date < todayIso ? "late" : "task" })),
    ];
    const visibleItems = items.slice(0, 2)
      .map((item) => `<span class="planner-month-item is-${item.kind}" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>`)
      .join("");
    const remaining = items.length - 2;
    const dots = [
      events.length ? '<i class="is-event"></i>' : "",
      openTasks.length - late.length > 0 ? '<i class="is-task"></i>' : "",
      late.length ? '<i class="is-late"></i>' : "",
    ].join("");
    const dateLabel = safeFormatDate(new Date(`${date}T12:00:00`), { day: "numeric", month: "long" }, date);
    const parts = [dateLabel];
    if (events.length) parts.push(`${events.length} ${events.length === 1 ? "compromisso" : "compromissos"}`);
    if (openTasks.length) parts.push(`${openTasks.length} ${openTasks.length === 1 ? "tarefa" : "tarefas"}`);
    cells.push(`<button class="planner-month-cell${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}${total ? " has-items" : ""}${date < todayIso ? " is-past" : ""}" type="button" data-month-day="${date}" aria-pressed="${isSelected}" aria-label="${escapeHtml(parts.join(", "))}">
        <span class="planner-month-cell-head">
          <span class="planner-month-daynum">${Number(date.slice(8, 10))}</span>
          ${total ? `<span class="planner-month-count">${total}</span>` : ""}
        </span>
        ${dots ? `<span class="planner-month-dots" aria-hidden="true">${dots}</span>` : ""}
        ${total ? `<span class="planner-month-items">${visibleItems}${remaining > 0 ? `<span class="planner-month-more">+${remaining}</span>` : ""}</span>` : ""}
      </button>`);
  });
  const trailing = (7 - (cells.length % 7)) % 7;
  for (let i = 0; i < trailing; i++) cells.push(`<div class="planner-month-cell is-blank" aria-hidden="true"></div>`);
  root.innerHTML = cells.join("");
  renderPlannerMonthDay();
}

function renderPlannerMonthDay() {
  const panel = document.querySelector("#plannerMonthDay");
  if (!panel) return;
  const date = plannerMonthSelected;
  const { events, tasks } = plannerDayItems(date);
  const d = new Date(`${date}T12:00:00`);
  const relative = date === todayIso ? "Hoje" : date === tomorrowIso ? "Amanhã" : date === offsetDate(-1) ? "Ontem" : "";
  const title = `${PLANNER_WEEKDAY_NAMES[d.getDay()]}, ${d.getDate()} de ${BD_MONTHS_LONG[d.getMonth()].toLowerCase()}`;
  const summary = [
    `${events.length} ${events.length === 1 ? "compromisso" : "compromissos"}`,
    `${tasks.length} ${tasks.length === 1 ? "tarefa" : "tarefas"}`,
  ].join(" · ");
  const body = events.length || tasks.length
    ? `${events.map(renderPlannerEventRow).join("")}${tasks.map(renderPlannerTaskRow).join("")}`
    : `<p class="bp-month-day-empty">${bdIcon("sparkle")}Nada marcado para este dia.</p>`;
  panel.innerHTML = `<header class="bp-month-day-head">
      <div><h3>${escapeHtml(title)}${relative ? ` <em class="bp-nav-tag${relative === "Hoje" ? " is-today" : ""}">${relative}</em>` : ""}</h3><p>${escapeHtml(summary)}</p></div>
      <div class="bp-month-day-actions">
        <button type="button" class="bd-icon-btn" data-month-add="${date}" aria-label="Adicionar neste dia" title="Adicionar neste dia">${bdIcon("plus")}</button>
        <button type="button" class="bp-month-open" data-month-open="${date}">Abrir dia${bdIcon("arrow-right")}</button>
      </div>
    </header>
    <div class="bp-month-day-body">${body}</div>`;
}

function selectPlannerMonthDay(date) {
  if (!date) return;
  const previous = plannerMonthSelected;
  plannerMonthSelected = date;
  document.querySelectorAll("#plannerMonthGrid [data-month-day]").forEach((cell) => {
    const on = cell.dataset.monthDay === date;
    cell.classList.toggle("is-selected", on);
    cell.setAttribute("aria-pressed", String(on));
  });
  renderPlannerMonthDay();
  if (previous !== date && !prefersReducedMotion()) {
    document.querySelector("#plannerMonthDay .bp-month-day-body")?.animate?.([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.2,.9,.3,1)" });
  }
}

function bindPlannerMonth() {
  const grid = document.querySelector("#plannerMonthGrid");
  if (!grid || grid.dataset.bound === "1") return;
  grid.dataset.bound = "1";
  grid.addEventListener("click", (event) => {
    const cell = event.target.closest("[data-month-day]");
    if (!cell) return;
    // Segundo toque no dia já selecionado abre a lente Dia.
    if (cell.dataset.monthDay === plannerMonthSelected && event.detail > 0 && cell.classList.contains("is-selected") && cell.dataset.tapped === "1") {
      jumpPlannerToDay(cell.dataset.monthDay);
      return;
    }
    grid.querySelectorAll("[data-tapped]").forEach((el) => delete el.dataset.tapped);
    cell.dataset.tapped = "1";
    selectPlannerMonthDay(cell.dataset.monthDay);
  });
  // Setas do teclado andam pelos dias.
  grid.addEventListener("keydown", (event) => {
    const cell = event.target.closest("[data-month-day]");
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!cell || !step) return;
    const cells = [...grid.querySelectorAll("[data-month-day]")];
    const next = cells[cells.indexOf(cell) + step];
    if (!next) return;
    event.preventDefault();
    selectPlannerMonthDay(next.dataset.monthDay);
    next.focus();
  });
  document.querySelector("#plannerMonthDay")?.addEventListener("click", (event) => {
    const open = event.target.closest("[data-month-open]");
    if (open) { jumpPlannerToDay(open.dataset.monthOpen); return; }
    const add = event.target.closest("[data-month-add]");
    if (add) openPlannerQuickAdd("task"); // a data já vem do dia selecionado
  });
}

// ── Adicionar rápido (Tarefa / Compromisso / Meta) num único modal ──
function openPlannerQuickAdd(type) {
  const modal = document.querySelector("#plannerQuickAddModal");
  if (!modal) return;
  plannerEditingEventId = null;
  plannerEditingTaskId = null;
  document.querySelectorAll("#plannerQuickAddType button").forEach((b) => { b.hidden = false; });
  document.querySelector("#plannerQuickAddModal h2").textContent = "Adicionar ao planner";
  document.querySelector("#plannerQuickAddForm [type='submit'] span").textContent = "Salvar";
  modal.hidden = false;
  setPlannerQuickAddType(type || (plannerActiveTab === "day" ? "event" : "task"));
  setTimeout(() => document.querySelector("#pqaTitle")?.focus(), 50);
}

function closePlannerQuickAdd() {
  const modal = document.querySelector("#plannerQuickAddModal");
  if (!modal) return;
  if (modal.contains(document.activeElement)) document.activeElement.blur();
  modal.hidden = true;
  repairViewportAfterOverlay();
  document.querySelector("#plannerQuickAddForm")?.reset();
  plannerEditingEventId = null;
  plannerEditingTaskId = null;
  document.querySelectorAll("#plannerQuickAddType button").forEach((b) => { b.hidden = false; });
}

function openPlannerEventEditor(id) {
  const ev = state.events.find((event) => event.id === id);
  if (!ev) return;
  const modal = document.querySelector("#plannerQuickAddModal");
  if (!modal) return;
  plannerEditingEventId = id;
  plannerEditingTaskId = null;
  modal.hidden = false;
  document.querySelectorAll("#plannerQuickAddType button").forEach((b) => { b.hidden = b.dataset.quickType !== "event"; });
  document.querySelector("#plannerQuickAddModal h2").textContent = "Editar compromisso";
  document.querySelector("#plannerQuickAddForm [type='submit'] span").textContent = "Salvar alterações";
  document.querySelector("#pqaTitle").value = ev.title || "";
  document.querySelector("#pqaEventDate").value = ev.date || todayIso;
  document.querySelector("#pqaEventTime").value = ev.time || "";
  document.querySelector("#pqaEventEndTime").value = ev.endTime || "";
  document.querySelector("#pqaEventLocation").value = ev.location === "Sem local" ? "" : (ev.location || "");
  document.querySelector("#pqaEventNotes").value = ev.notes || "";
  setReminderChoice("#pqaEventReminder", "#pqaEventReminderMinutes", "#pqaEventReminderCustom", ev.reminder);
  setPlannerQuickAddType("event");
  setTimeout(() => document.querySelector("#pqaTitle")?.focus(), 50);
}

function setPlannerQuickAddType(type) {
  document.querySelectorAll("#plannerQuickAddType button").forEach((b) => b.classList.toggle("active", b.dataset.quickType === type));
  document.querySelector("#pqaTaskFields").style.display = type === "task" ? "grid" : "none";
  document.querySelector("#pqaEventFields").style.display = type === "event" ? "block" : "none";
  document.querySelector("#pqaGoalFields").style.display = type === "goal" ? "block" : "none";
  const form = document.querySelector("#plannerQuickAddForm");
  form.dataset.type = type;
  const title = document.querySelector("#pqaTitle");
  if (title) title.placeholder = { task: "O que precisa ser feito?", event: "Nome do compromisso", goal: "Qual é a sua meta?" }[type] || "Título";
  const referenceDate = plannerActiveTab === "day" ? plannerDayDate : plannerActiveTab === "month" && activeView === "planner" ? plannerMonthSelected : todayIso;
  if (type === "task") {
    document.querySelector("#pqaTaskDue").value ||= referenceDate;
    document.querySelector("#pqaTaskTime").value ||= "09:00";
  }
  if (type === "event") {
    document.querySelector("#pqaEventDate").value ||= referenceDate;
    document.querySelector("#pqaEventTime").value ||= "09:00";
  }
}

function bindPlannerQuickAdd() {
  document.querySelector("#closePlannerQuickAdd")?.addEventListener("click", closePlannerQuickAdd);
  document.querySelector("#plannerQuickAddModal")?.addEventListener("click", (e) => {
    if (e.target.id === "plannerQuickAddModal") closePlannerQuickAdd();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.querySelector("#plannerQuickAddModal")?.hidden === false) closePlannerQuickAdd();
  });
  document.querySelectorAll("#plannerQuickAddType button").forEach((btn) => {
    btn.addEventListener("click", () => setPlannerQuickAddType(btn.dataset.quickType));
  });
  const bindReminderField = (selectSelector, customSelector, inputSelector) => {
    const reminderSelect = document.querySelector(selectSelector);
    const reminderCustom = document.querySelector(customSelector);
    const syncReminderField = () => {
      if (!reminderSelect || !reminderCustom) return;
      reminderCustom.hidden = reminderSelect.value !== "custom";
      if (!reminderCustom.hidden) document.querySelector(inputSelector)?.focus();
    };
    reminderSelect?.addEventListener("change", syncReminderField);
    syncReminderField();
  };
  bindReminderField("#pqaTaskReminder", "#pqaTaskReminderCustom", "#pqaTaskReminderMinutes");
  bindReminderField("#pqaEventReminder", "#pqaEventReminderCustom", "#pqaEventReminderMinutes");
  document.querySelector("#plannerQuickAddForm")?.addEventListener("submit", submitPlannerQuickAdd);
}

function submitPlannerQuickAdd(event) {
  event.preventDefault();
  const type = event.target.dataset.type || "task";
  const title = valueOf("#pqaTitle");
  if (!title) return;

  if (type === "task") {
    const priority = document.querySelector("#pqaTaskPriority").value;
    const due = document.querySelector("#pqaTaskDue").value || todayIso;
    const dueTime = document.querySelector("#pqaTaskTime").value || "";
    const reminder = readReminderChoice("#pqaTaskReminder", "#pqaTaskReminderMinutes");
    if (plannerEditingTaskId) {
      state.tasks = state.tasks.map((item) => item.id === plannerEditingTaskId ? { ...item, title, priority, dueDate: due, dueTime, reminder } : item);
      showToast("Tarefa atualizada.");
    } else {
      state.tasks.unshift(createTask(title, "Pendente", priority, due, "", dueTime, reminder));
      showToast("Tarefa adicionada.");
    }
  } else if (type === "event") {
    const date = document.querySelector("#pqaEventDate").value || todayIso;
    const time = document.querySelector("#pqaEventTime").value || "09:00";
    const endTimeRaw = document.querySelector("#pqaEventEndTime").value || "";
    if (endTimeRaw && endTimeRaw <= time) {
      showToast("O término precisa ser depois do início.");
      return;
    }
    const location = valueOf("#pqaEventLocation") || "Sem local";
    const reminder = readReminderChoice("#pqaEventReminder", "#pqaEventReminderMinutes");
    const notes = valueOf("#pqaEventNotes") || "";
    const eventRecord = { id: plannerEditingEventId || crypto.randomUUID(), title, date, time, location, reminder, notes };
    if (endTimeRaw) eventRecord.endTime = endTimeRaw;
    if (plannerEditingEventId) {
      state.events = state.events.map((item) => item.id === plannerEditingEventId ? eventRecord : item);
      showToast("Compromisso atualizado.");
    } else {
      state.events.push(eventRecord);
      showToast("Compromisso salvo.");
    }
  } else if (type === "goal") {
    const target = Number(document.querySelector("#pqaGoalTarget").value || 1);
    state.goals.unshift({ id: crypto.randomUUID(), title, target, current: 0, milestones: [] });
    showToast("Meta criada.");
  }

  saveState();
  closePlannerQuickAdd();
  renderAll();
}

// ── Notas (visual dos quadros) ──────────────────────────────
let notesSearchQuery = "";
let ndChecklistAdding = false;
const notesPanelMode = () => window.matchMedia("(min-width: 1181px)").matches;

// "hoje, 09:20" / "ontem, 17:42" / "22 de jan" a partir de updatedAt (ou da data de criação)
function noteWhen(note, { capital = false } = {}) {
  const iso = note.updatedAt || "";
  const dateIso = iso ? toLocalIso(new Date(iso)) : (note.createdAt || "");
  if (!dateIso) return "";
  const time = iso ? new Date(iso).toTimeString().slice(0, 5) : "";
  let label;
  if (dateIso === todayIso) label = time ? `hoje, ${time}` : "hoje";
  else if (dateIso === offsetDate(-1)) label = time ? `ontem, ${time}` : "ontem";
  else {
    const d = new Date(`${dateIso}T12:00:00`);
    label = `${d.getDate()} de ${BD_MONTHS[d.getMonth()]}`;
  }
  return capital ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

function noteIconFor(note) {
  const text = `${note.folder || ""} ${note.category || ""} ${note.title || ""}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/(estud|curso|leitura|livro|aula|faculdade)/.test(text)) return "book";
  if (/(financ|gasto|orcamento|dinheiro|conta)/.test(text)) return "bars";
  if (/(ideia|melhoria|brainstorm)/.test(text)) return "clipboard-list";
  if (/(reuni|trabalho|planej|projeto|trimestre|produto)/.test(text)) return "calendar";
  return "note";
}

function closeNotesFormSheet() {
  document.querySelector("#noteFormWrap")?.classList.remove("is-open");
  const backdrop = document.querySelector("#noteFormBackdrop");
  if (backdrop) backdrop.hidden = true;
}

// Criar nota = abrir uma nota em branco na mesma tela da nota aberta
// (como o Notas do iPhone/Keep): uma tela só para criar e editar. A nota
// nasce como rascunho (draft) — fica fora da biblioteca e, se a pessoa sair
// sem escrever nada, é descartada (nada de notas vazias por engano).
function openNotesFormSheet({ focusTitle = true } = {}) {
  startNewNote({ focusTitle });
}

function startNewNote({ focusTitle = true, openFolders = false } = {}) {
  const current = state.notes.find((n) => n.id === ndCurrentNoteId);
  if (current?.draft) {
    if (focusTitle) document.querySelector("#ndTitle")?.focus();
    if (openFolders) openNoteFolderSheet(current.id);
    return;
  }
  if (activeView !== "notes") setView("notes");
  const folder = notesFolderFilter !== "all" && notesFolderFilter !== "Sem pasta" ? notesFolderFilter : "Entrada";
  const now = new Date().toISOString();
  const note = {
    id: crypto.randomUUID(), title: "", description: "", descriptionHtml: "", category: "Geral", folder,
    tags: [], priority: "Media", checklist: [], attachments: [], goal: "", observations: "",
    color: "blue", textColor: "", favorite: false, createdAt: todayIso, updatedAt: now, convertedToTaskId: "", draft: true,
  };
  state.notes = [note, ...state.notes];
  openNoteDetail(note.id);
  if (focusTitle) setTimeout(() => document.querySelector("#ndTitle")?.focus({ preventScroll: true }), 90);
  if (openFolders) openNoteFolderSheet(note.id);
}
window.startNewNote = startNewNote;

// A nota aberta ainda é um rascunho sem nada escrito?
function ndDraftIsEmpty() {
  const note = state.notes.find((n) => n.id === ndCurrentNoteId);
  if (!note?.draft) return false;
  const title = document.querySelector("#ndTitle")?.value.trim();
  const text = noteHtmlToPlainText(sanitizeNoteHtml(document.querySelector("#ndBody")?.innerHTML || "")).trim();
  return !title && !text && !(note.checklist || []).some((item) => noteChecklistItemText(item).trim());
}

// Rascunho vira nota de verdade (com título tirado da 1ª linha, se faltar)
// ou é descartado se ficou vazio. Devolve "created", "discarded" ou null.
function finalizeNoteDraft(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note?.draft) return null;
  const text = String(note.description || "").trim();
  const items = (note.checklist || []).filter((item) => noteChecklistItemText(item).trim());
  const typed = String(note.title || "").trim();
  const hasTitle = Boolean(typed) && typed !== "Sem título";
  if (!hasTitle && !text && !items.length) {
    state.notes = state.notes.filter((n) => n.id !== id);
    queueNotePersist();
    return "discarded";
  }
  const title = hasTitle ? typed : (text.split("\n").find((line) => line.trim()) || noteChecklistItemText(items[0]) || "Sem título").trim().slice(0, 80);
  state.notes = state.notes.map((n) => {
    if (n.id !== id) return n;
    const { draft, ...rest } = n;
    return { ...rest, title, updatedAt: new Date().toISOString() };
  });
  if (notesFolderFilter !== "all" && notesFolderFilter !== ((note.folder || "").trim() || "Sem pasta")) notesFolderFilter = "all";
  queueNotePersist();
  return "created";
}

function renderNotes() {
  const filter = document.querySelector("#noteFilter").value;
  const searchQuery = (notesSearchQuery || elements.globalSearch.value || "").trim();
  const q = searchQuery.toLowerCase();
  // Rascunhos que ficaram para trás (app fechado no meio): viram nota ou
  // somem. O rascunho aberto agora não aparece na biblioteca.
  state.notes.filter((note) => note.draft && note.id !== ndCurrentNoteId).forEach((note) => finalizeNoteDraft(note.id));
  let notes = state.notes.filter((note) => !note.draft && (!q || ["title", "description", "category", "folder", "goal"].some((field) => String(note[field] || "").toLowerCase().includes(q))));
  if (filter === "favorite") notes = notes.filter((note) => note.favorite);
  if (["Alta", "Urgente"].includes(filter)) notes = notes.filter((note) => note.priority === filter);
  if (notesFolderFilter !== "all") notes = notes.filter((note) => ((note.folder || "").trim() || "Sem pasta") === notesFolderFilter);

  renderNoteFolders();

  const isFiltering = Boolean(searchQuery) || filter !== "all" || notesFolderFilter !== "all";
  renderList(
    "#notesList",
    notes,
    (note) => renderNoteCard(note, searchQuery),
    emptyStateHtml(
      isFiltering
        ? { iconName: "inbox", title: "Nada por aqui com esse filtro", desc: "Tente limpar a busca, trocar a pasta ou o filtro." }
        : { iconName: "notebook", title: "Sua primeira nota está a um toque", desc: "Ideias, lembretes e recados soltos: tudo cabe aqui.", ctaLabel: "Nova nota", ctaOnClick: "startNewNote()", mascot: true, mascotBadgeIcon: "notebook" }
    ),
    ""
  );

  // Computador: a nota aberta fica no painel da direita; abre a primeira se nenhuma estiver aberta.
  const empty = document.querySelector("#noteDetailEmpty");
  if (notesPanelMode()) {
    if (ndCurrentNoteId && !state.notes.some((n) => n.id === ndCurrentNoteId)) closeNoteDetailUI();
    if (!ndCurrentNoteId && notes.length && activeView === "notes") openNoteDetail(notes[0].id);
  }
  if (empty) empty.hidden = Boolean(ndCurrentNoteId);
}

// Pastas: "Todas (n)", uma por pasta (com contagem) e "+ Pasta".
function renderNoteFolders() {
  const root = document.querySelector("#noteFolders");
  if (!root) return;
  const counts = {};
  const saved = state.notes.filter((n) => !n.draft);
  saved.forEach((n) => {
    const key = (n.folder || "").trim() || "Sem pasta";
    counts[key] = (counts[key] || 0) + 1;
  });
  const folders = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, "pt-BR"));
  const chip = (value, label, count) => `<button type="button" class="bn-chip${notesFolderFilter === value ? " active" : ""}" data-note-folder="${escapeHtml(value)}" aria-pressed="${notesFolderFilter === value}">${escapeHtml(label)} <span>(${count})</span></button>`;
  root.innerHTML = [
    chip("all", "Todas", saved.length),
    ...folders.map((f) => chip(f, f, counts[f])),
    `<button type="button" class="bn-chip bn-chip--add" data-new-folder>${bdIcon("plus")}Pasta</button>`,
  ].join("");
}

function setNotesFolderFilter(folder) {
  notesFolderFilter = folder;
  renderNotes();
}

function renderNoteCard(note, searchQuery) {
  // A cor do cartão segue a prioridade: verde (baixa), âmbar (média),
  // laranja (alta) e vermelho (urgente) — sempre com o nome escrito junto.
  const prio = notePriorityKey(note.priority);
  const items = note.checklist || [];
  const done = items.filter(noteChecklistItemDone).length;
  const titleHtml = highlightMatch(escapeHtml(note.title || "Sem título"), searchQuery);
  const cleanHtml = note.descriptionHtml ? sanitizeNoteHtml(note.descriptionHtml) : "";
  const preview = cleanHtml && (noteHtmlToPlainText(cleanHtml) || !String(note.description || "").trim())
    ? cleanHtml
    : highlightMatch(escapeHtml(note.description || ""), searchQuery).replace(/\n/g, "<br>");
  const selected = note.id === ndCurrentNoteId && notesPanelMode();
  const complete = items.length > 0 && done === items.length;
  return `<article class="bn-card bn-card--${prio}${selected ? " is-selected" : ""}" style="--nc:var(--np-${prio})" data-note-id="${note.id}" tabindex="0" role="button" aria-label="Abrir nota ${escapeHtml(note.title || "")}" onclick="openNoteDetail('${note.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openNoteDetail('${note.id}')}">
    <header>
      <span class="bn-card-ico">${bdIcon(noteIconFor(note))}</span>
      <span class="bn-prio-chip">${bdIcon(prio === "urgente" ? "alert" : "flag")}${escapeHtml(notePriorityLabel(note.priority))}</span>
      <button type="button" class="bn-star${note.favorite ? " is-on" : ""}" onclick="event.stopPropagation(); toggleFavorite('${note.id}')" aria-pressed="${!!note.favorite}" aria-label="${note.favorite ? "Remover dos favoritos" : "Favoritar"}"><svg class="i" ${note.favorite ? 'fill="currentColor"' : ""}><use href="#i-star"/></svg></button>
    </header>
    <h4>${titleHtml}</h4>
    ${preview ? `<div class="bn-card-body">${preview}</div>` : ""}
    <footer>
      ${items.length ? `<span class="bn-card-check${complete ? " is-complete" : ""}">${bdIcon(complete ? "check-circle" : "check")}${done}/${items.length}</span>` : "<span></span>"}
      <span class="bn-when">${escapeHtml(noteWhen(note, { capital: true }))}</span>
    </footer>
  </article>`;
}

// Checklists criados nas versões antigas eram arrays de texto. As funções
// abaixo leem os dois formatos para que nenhuma nota existente desapareça
// quando o item passa a poder ser marcado dentro do detalhe.
function noteChecklistItemText(item) {
  return typeof item === "string" ? item : String(item?.text || "");
}

function noteChecklistItemDone(item) {
  return typeof item === "object" && !!item?.done;
}

// Envolve trechos que batem com a busca em <mark>, pra destacar visualmente
// onde o termo pesquisado aparece (só quando há uma busca ativa).
function highlightMatch(safeHtml, query) {
  const q = query.trim();
  if (!q) return safeHtml;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safeHtml.replace(new RegExp(`(${escaped})`, "ig"), "<mark class=\"pn-highlight\">$1</mark>");
}

// Exporta uma nota como arquivo Markdown (.md) pra guardar fora do app
function exportNoteMarkdown(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  let md = `# ${note.title}\n\n`;
  if (note.tags?.length) md += note.tags.map((t) => `#${t}`).join(" ") + "\n\n";
  if (note.description) md += `${note.description}\n\n`;
  if (note.checklist?.length) md += note.checklist.map((item) => `- [${noteChecklistItemDone(item) ? "x" : " "}] ${noteChecklistItemText(item)}`).join("\n") + "\n\n";
  if (note.observations) md += `> ${note.observations}\n`;

  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${note.title.replace(/[^\w\-]+/g, "_") || "nota"}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function editNote(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  resetNoteForm();
  document.querySelector("#noteId").value = note.id;
  document.querySelector("#noteTitle").value = note.title || "";
  document.querySelector("#noteDescription").value = note.description || "";
  setNoteEditorContent(note);
  document.querySelector("#noteCategory").value = note.category || "";
  document.querySelector("#noteTags").value = (note.tags || []).join(", ");
  document.querySelector("#noteGoal").value = note.goal || "";
  document.querySelector("#noteAttachments").value = (note.attachments || []).join(", ");
  document.querySelector("#noteObservations").value = note.observations || "";
  setNotePriorityUI(note.priority);
  document.querySelector("#noteColor").value = note.color || "blue";
  setNoteDraftTextColor(note.textColor || "");
  setNoteFolderValue(note.folder || "");
  noteDraftChecklist = (note.checklist || []).map((item) => ({
    id: typeof item === "object" && item.id ? item.id : crypto.randomUUID(),
    text: noteChecklistItemText(item),
    done: noteChecklistItemDone(item),
  }));
  renderNoteChecklistBuilder();

  // Editar abre a própria nota (a mesma tela de criar e ler).
  setView("notes");
  openNoteDetail(note.id);
}

function toggleFavorite(id) {
  state.notes = state.notes.map((note) => (note.id === id ? { ...note, favorite: !note.favorite } : note));
  renderNotes();
  queueNotePersist();
}

// Vira uma nota em tarefa — some não tinha nenhum retorno visível na
// tela de notas (só um toast rápido que passava despercebido, e a nota
// continuava idêntica na lista, dando a impressão de "não fez nada").
// Agora: marca a nota como já convertida (o cartão passa a mostrar
// "Virou tarefa ✓" em vez do botão, pra não converter de novo por
// engano e deixar claro que já aconteceu) e leva direto pro Planner,
// onde a tarefa nova já aparece.
function convertNoteToTask(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  if (note.convertedToTaskId) {
    showToast("Essa nota já virou tarefa — abrindo o Planner.");
    setView("planner");
    return;
  }
  const task = { ...createTask(note.title, "Pendente", note.priority, todayIso), sourceNoteId: note.id };
  state.tasks.unshift(task);
  note.convertedToTaskId = task.id;
  saveState();
  renderAll();
  celebrate("Tarefa criada a partir da nota!");
  setView("planner");
}

function deleteNote(id) {
  state.notes = state.notes.filter((note) => note.id !== id);
  saveState();
  renderAll();
  showToast("Nota excluída");
}

function deleteNoteWithUndo(id) {
  const index = state.notes.findIndex((note) => note.id === id);
  if (index < 0) return;
  const removed = state.notes[index];
  state.notes = state.notes.filter((note) => note.id !== id);
  saveState();
  renderAll();
  showToast("Nota excluída.", {
    actionLabel: "Desfazer",
    onAction: () => {
      if (state.notes.some((note) => note.id === removed.id)) return;
      const notes = [...state.notes];
      notes.splice(Math.min(index, notes.length), 0, removed);
      state.notes = notes;
      saveState();
      renderAll();
      showToast("Nota restaurada.");
    },
  });
}

// ══════════════════════════════════════════════════════════════════
// Nota em tela cheia (estilo iPhone Notes) — título + corpo com
// formatação de verdade (negrito, destaque colorido), aberta ao
// tocar num cartão da lista. `note.descriptionHtml` guarda o corpo
// formatado; `note.description` continua sendo o texto puro (dele
// derivado), pra busca/preview e pra notas antigas ou criadas pelo
// WhatsApp continuarem funcionando sem precisar de migração.
// ══════════════════════════════════════════════════════════════════
let ndCurrentNoteId = null;

// Só passamos pro contenteditable o que a gente mesmo gerou (negrito,
// itálico e destaque de cor) — filtra qualquer outra tag/atributo que
// apareça (colar de outro app, por exemplo), pra nunca guardar HTML
// arbitrário no Firestore. Preserva font-weight/font-style além de
// background-color no style: com "styleWithCSS" ligado (ver
// bindNoteDetail), alguns navegadores representam negrito/itálico
// como `<span style="font-weight/font-style:...">` em vez de
// `<b>`/`<i>` — sem isso aqui, o sanitizador jogaria essa formatação
// fora sem querer.
function sanitizeNoteHtml(html) {
  const allowedTags = new Set(["B", "STRONG", "I", "EM", "U", "UL", "OL", "LI", "A", "BR", "DIV", "SPAN", "MARK", "P", "FONT", "S", "STRIKE"]);
  const allowedStyles = ["color", "backgroundColor", "fontWeight", "fontStyle", "textDecorationLine"];
  const template = document.createElement("template");
  template.innerHTML = String(html || "");

  const clean = (root) => {
    [...root.childNodes].forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.includes("\u200B")) node.textContent = node.textContent.replace(/\u200B/g, "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        node.remove();
        return;
      }
      if (!allowedTags.has(node.tagName)) {
        node.replaceWith(document.createTextNode(node.textContent));
        return;
      }
      if (node.tagName === "FONT" && node.getAttribute("color")) node.style.color = node.getAttribute("color");
      const keptStyles = node.style
        ? allowedStyles.map((prop) => [prop, node.style[prop]]).filter(([prop, value]) => noteStyleValueKept(prop, value))
        : [];
      const href = node.tagName === "A" ? String(node.getAttribute("href") || "").trim() : "";
      [...node.attributes].forEach((attr) => node.removeAttribute(attr.name));
      keptStyles.forEach(([prop, value]) => { node.style[prop] = value; });
      if (node.tagName === "A") {
        if (/^(https?:\/\/|mailto:)/i.test(href)) {
          node.setAttribute("href", href);
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        } else {
          node.replaceWith(document.createTextNode(node.textContent));
          return;
        }
      }
      clean(node);
      // <span>/<font> sem estilo nenhum não muda nada: some, fica o texto.
      if ((node.tagName === "SPAN" || node.tagName === "FONT") && !node.attributes.length) node.replaceWith(...node.childNodes);
      // Marca-texto sem texto (sobra de um toque no botão) não vira nada.
      else if (node.tagName === "MARK" && !node.textContent.trim() && !node.querySelector("br")) node.remove();
    });
  };
  clean(template.content);
  return template.innerHTML;
}

// Cor CSS -> {r,g,b,a}. Aceita só #rgb, #rrggbb e rgb()/rgba(); nomes
// de cor e qualquer outra coisa voltam null (e são descartados).
function noteCssRgb(value) {
  const v = String(value || "").trim().toLowerCase();
  let m = v.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
}

// Ao formatar (lista, negrito, limpar…), o navegador costuma "copiar"
// a cor do tema para dentro do texto: branco no escuro, quase preto no
// claro. Gravada na nota, essa cor deixava o texto invisível ao trocar de
// tema — a nota parecia vazia. Só cores vivas (escolhidas pela pessoa:
// paleta de texto e marca-texto) são guardadas; cinzas, branco, preto e
// transparente saem e o texto volta a seguir o tema.
function noteColorIsVivid(value) {
  const c = noteCssRgb(value);
  if (!c || c.a < 0.08) return false;
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) >= 48;
}

function noteStyleValueKept(prop, value) {
  if (!value) return false;
  if (prop === "color" || prop === "backgroundColor") return noteColorIsVivid(value);
  if (prop === "textDecorationLine") return value !== "none";
  return true;
}

// Mesma limpeza, mas direto no editor aberto (sem trocar os nós, para
// não perder o cursor nem a seleção).
const NOTE_EDITOR_STYLE_PROPS = { color: "color", "background-color": "backgroundColor", "font-weight": "fontWeight", "font-style": "fontStyle", "text-decoration-line": "textDecorationLine" };
function scrubNoteEditorStyles(root) {
  root?.querySelectorAll("[style]").forEach((el) => {
    [...el.style].forEach((name) => {
      const prop = NOTE_EDITOR_STYLE_PROPS[name];
      if (!prop || !noteStyleValueKept(prop, el.style.getPropertyValue(name))) el.style.removeProperty(name);
    });
    if (!el.style.length) el.removeAttribute("style");
  });
}

// ══════════════════════════════════════════════════════════════════
// Formatação das notas — um único núcleo para "Nova nota" e nota aberta.
// O estado de cada botão vem do TEXTO onde o cursor está (não de um
// "lembrete" do último clique): por isso um botão nunca fica aceso à toa e
// dois botões só ficam acesos juntos quando o trecho tem as duas coisas
// (ex.: negrito + itálico). Listas são exclusivas (marcadores OU números).
// ══════════════════════════════════════════════════════════════════
const NOTE_ZWSP = "​";

function noteSelectionIn(editor) {
  const sel = window.getSelection();
  if (!editor || !sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const host = range.commonAncestorContainer;
  return host === editor || editor.contains(host) ? range : null;
}

function noteClosest(node, editor, test) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  while (el && el !== editor && el.nodeType === Node.ELEMENT_NODE) {
    if (test(el)) return el;
    el = el.parentNode;
  }
  return null;
}

function noteIsHighlightEl(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (el.tagName === "MARK") return true;
  const c = noteCssRgb(el.style?.backgroundColor);
  return Boolean(c && c.a > 0.08 && c.r > 200 && c.g > 170 && c.b < 170);
}

function noteColorHex(value) {
  const c = noteCssRgb(value);
  if (!c) return "";
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const NOTE_INLINE_TESTS = {
  bold: (el) => ["B", "STRONG"].includes(el.tagName) || /^(bold|[6-9]00)$/.test(el.style?.fontWeight || ""),
  italic: (el) => ["I", "EM"].includes(el.tagName) || el.style?.fontStyle === "italic",
  underline: (el) => el.tagName === "U" || /underline/.test(el.style?.textDecorationLine || el.style?.textDecoration || ""),
  strike: (el) => ["S", "STRIKE", "DEL"].includes(el.tagName) || /line-through/.test(el.style?.textDecorationLine || el.style?.textDecoration || ""),
};
const NOTE_INLINE_TAGS = { bold: "b", italic: "i", underline: "u", strike: "strike" };

// Posição do cursor como "quantos caracteres desde o início do texto".
// O iPhone às vezes descreve o MESMO ponto de outro jeito (fim do nó de
// texto x índice no elemento pai) logo depois do toque num botão; comparar
// por essa contagem evita que o botão "apague" antes de começar a digitar.
function noteCaretOffset(editor, range) {
  try {
    const head = document.createRange();
    head.setStart(editor, 0);
    head.setEnd(range.startContainer, range.startOffset);
    const fragment = head.cloneContents();
    const breaks = fragment.querySelectorAll ? fragment.querySelectorAll("br, li, div, p").length : 0;
    return `${head.toString().replace(new RegExp(NOTE_ZWSP, "g"), "").length}:${breaks}`;
  } catch {
    return "";
  }
}

function notePendingMatches(editor, range) {
  return Boolean(notePending && notePending.editor === editor && range && range.collapsed && notePending.offset && noteCaretOffset(editor, range) === notePending.offset);
}

function noteFormatState(editor) {
  const st = { bold: false, italic: false, underline: false, strike: false, highlight: false, ul: false, ol: false, color: "" };
  const range = noteSelectionIn(editor);
  if (!range) return st;
  const node = range.startContainer;
  const query = (cmd) => { try { return document.queryCommandState(cmd); } catch { return null; } };
  const dom = NOTE_INLINE_TESTS;
  // Lido da árvore do texto. O estilo "pendente" (tocar em B com o cursor
  // parado, antes de digitar) fica em notePending — o queryCommandState do
  // Chrome confunde sublinhado com riscado e acendia os dois.
  Object.keys(dom).forEach((key) => { st[key] = Boolean(noteClosest(node, editor, dom[key])); });
  if (notePendingMatches(editor, range)) Object.assign(st, notePending.values);
  void query;
  st.highlight = Boolean(noteClosest(node, editor, noteIsHighlightEl));
  const li = noteClosest(node, editor, (el) => el.tagName === "LI");
  const listTag = li?.parentElement?.tagName;
  st.ul = listTag === "UL";
  st.ol = listTag === "OL";
  const colored = noteClosest(node, editor, (el) => Boolean(el.style?.color || (el.tagName === "FONT" && el.getAttribute("color"))));
  if (colored) st.color = noteColorHex(colored.style?.color || colored.getAttribute("color"));
  if (notePendingMatches(editor, range) && "color" in notePending.values) st.color = notePending.values.color;
  return st;
}

function paintNoteToolbar(toolbar, editor, key) {
  if (!toolbar) return;
  const st = editor ? noteFormatState(editor) : null;
  const attr = key === "neCmd" ? "data-ne-cmd" : "data-nd-cmd";
  toolbar.querySelectorAll(`[${attr}][aria-pressed]`).forEach((button) => {
    const on = String(Boolean(st && st[button.dataset[key]]));
    if (button.getAttribute("aria-pressed") !== on) button.setAttribute("aria-pressed", on);
  });
  toolbar.querySelectorAll("[data-nd-color]").forEach((swatch) => {
    const on = Boolean(st && st.color && st.color === String(swatch.dataset.ndColor).toLowerCase());
    swatch.setAttribute("aria-pressed", String(on));
    swatch.classList.toggle("is-selected", on);
  });
  // O botão "Aa" ganha um tracinho na cor em uso — dá para ver a cor ativa
  // mesmo com o painel fechado, logo depois de escolher.
  const colorBtn = toolbar.querySelector('[data-nd-cmd="more"]');
  if (colorBtn) {
    const color = st && st.color ? st.color : "";
    if (color) colorBtn.style.setProperty("--cur-color", color); else colorBtn.style.removeProperty("--cur-color");
    colorBtn.classList.toggle("has-color", Boolean(color));
  }
}

// O editor "está em uso" quando tem o foco OU quando a seleção está nele
// (no iPhone o foco pisca ao tocar na barra, mas a seleção continua lá).
function noteEditorActive(editor) {
  return Boolean(editor && (document.activeElement === editor || noteSelectionIn(editor)));
}

function noteRestoreEditorSelection(editor, savedRange) {
  // Se o editor não perdeu o foco (o mousedown da barra é bloqueado), a
  // seleção atual vale — e preserva o estilo "pendente" do cursor (ex.:
  // negrito desligado antes de digitar). Só restaura quando o toque tirou
  // o foco do texto (iPhone).
  if (document.activeElement === editor && noteSelectionIn(editor)) return;
  editor.focus({ preventScroll: true });
  const sel = window.getSelection();
  if (savedRange && editor.contains(savedRange.commonAncestorContainer)) {
    sel.removeAllRanges();
    sel.addRange(savedRange);
  } else if (!noteSelectionIn(editor)) {
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    sel.removeAllRanges();
    sel.addRange(end);
  }
}

// Divide os textos nas pontas da seleção, para cada nó de texto ficar
// inteiro dentro ou inteiro fora dela.
function noteSplitRange(range) {
  let { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = range;
  if (ec.nodeType === Node.TEXT_NODE && eo > 0 && eo < ec.length) ec.splitText(eo);
  if (sc.nodeType === Node.TEXT_NODE && so > 0 && so < sc.length) {
    const rest = sc.splitText(so);
    if (ec === sc) { ec = rest; eo = rest.length; }
    sc = rest;
    so = 0;
  }
  range.setStart(sc, so);
  range.setEnd(ec, ec.nodeType === Node.TEXT_NODE ? Math.min(eo, ec.length) : eo);
}

function noteTextNodesIn(range, editor) {
  const nodes = [];
  const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
  const walker = document.createTreeWalker(editor.contains(root) || root === editor ? root : editor, NodeFilter.SHOW_TEXT);
  let node = walker.currentNode.nodeType === Node.TEXT_NODE ? walker.currentNode : walker.nextNode();
  while (node) {
    if (node.length && range.intersectsNode(node)) {
      const startsInside = node !== range.startContainer || range.startOffset < node.length;
      const endsInside = node !== range.endContainer || range.endOffset > 0;
      if (startsInside && endsInside && node.textContent.replace(new RegExp(NOTE_ZWSP, "g"), "").length) nodes.push(node);
    }
    node = walker.nextNode();
  }
  return nodes;
}

function noteMergeMarks(editor) {
  editor.querySelectorAll("mark").forEach((mark) => {
    if (!mark.isConnected) return;
    let next = mark.nextSibling;
    while (next && next.nodeName === "MARK") {
      while (next.firstChild) mark.appendChild(next.firstChild);
      const drop = next;
      next = next.nextSibling;
      drop.remove();
    }
  });
}

// Marca-texto de verdade (<mark>), ligando e desligando:
// - com trecho marcado: se tudo já estava marcado, desmarca; senão, marca;
// - só com o cursor: dentro do marca-texto, sai dele (o que for digitado
//   depois fica normal); fora, o que for digitado já sai marcado.
function noteToggleHighlight(editor) {
  const sel = window.getSelection();
  const range = noteSelectionIn(editor);
  if (!range) return;
  if (range.collapsed) {
    const hl = noteClosest(range.startContainer, editor, noteIsHighlightEl);
    const zw = document.createTextNode(NOTE_ZWSP);
    if (hl) {
      const tailRange = document.createRange();
      tailRange.setStart(range.startContainer, range.startOffset);
      tailRange.setEnd(hl, hl.childNodes.length);
      const tail = tailRange.extractContents();
      hl.after(zw);
      if (tail.textContent.replace(new RegExp(NOTE_ZWSP, "g"), "").length) {
        const rest = hl.cloneNode(false);
        rest.appendChild(tail);
        zw.after(rest);
      }
      if (!hl.textContent.replace(new RegExp(NOTE_ZWSP, "g"), "").length) hl.remove();
    } else {
      // Respeita o que foi ligado/desligado no cursor antes do marca-texto
      // (ex.: riscado desligado → o texto marcado não sai riscado).
      const pending = notePendingMatches(editor, range) ? notePending.values : {};
      let at = range;
      const offAncestors = Object.keys(pending).filter((key) => pending[key] === false)
        .map((key) => noteClosest(range.startContainer, editor, NOTE_INLINE_TESTS[key])).filter(Boolean);
      const outer = offAncestors.find((el) => offAncestors.every((other) => other === el || el.contains(other)));
      if (outer) {
        const tailRange = document.createRange();
        tailRange.setStart(range.startContainer, range.startOffset);
        tailRange.setEnd(outer, outer.childNodes.length);
        const tail = tailRange.extractContents();
        if (tail.textContent.replace(new RegExp(NOTE_ZWSP, "g"), "").length) {
          const rest = outer.cloneNode(false);
          rest.appendChild(tail);
          outer.after(rest);
        }
        at = document.createRange();
        at.setStartAfter(outer);
        at.collapse(true);
      }
      const mark = document.createElement("mark");
      let inner = mark;
      if (pending.color) {
        const tint = document.createElement("span");
        tint.style.color = pending.color;
        inner.appendChild(tint);
        inner = tint;
      }
      Object.keys(pending).filter((key) => pending[key] === true && NOTE_INLINE_TAGS[key]).forEach((key) => {
        if (noteClosest(at.startContainer, editor, NOTE_INLINE_TESTS[key])) return;
        const tag = document.createElement(NOTE_INLINE_TAGS[key]);
        inner.appendChild(tag);
        inner = tag;
      });
      inner.appendChild(zw);
      at.insertNode(mark);
    }
    notePending = null;
    const caret = document.createRange();
    caret.setStart(zw, 1);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    return;
  }
  noteSplitRange(range);
  const texts = noteTextNodesIn(range, editor);
  if (!texts.length) return;
  const allOn = texts.every((text) => noteClosest(text, editor, noteIsHighlightEl));
  if (allOn) noteUnhighlight(editor, texts);
  else texts.forEach((text) => {
    if (noteClosest(text, editor, noteIsHighlightEl)) return;
    const mark = document.createElement("mark");
    text.before(mark);
    mark.appendChild(text);
  });
  noteMergeMarks(editor);
  const after = document.createRange();
  after.setStart(texts[0], 0);
  after.setEnd(texts.at(-1), texts.at(-1).length);
  sel.removeAllRanges();
  sel.addRange(after);
}

// Tira o marca-texto só dos textos indicados (o resto do trecho continua marcado).
function noteUnhighlight(editor, texts) {
  const selected = new Set(texts);
  const holders = [...new Set(texts.map((text) => noteClosest(text, editor, noteIsHighlightEl)).filter(Boolean))];
  holders.forEach((holder) => {
    const inner = [];
    const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) { inner.push(node); node = walker.nextNode(); }
    const template = holder.cloneNode(false);
    holder.replaceWith(...holder.childNodes);
    inner.forEach((text) => {
      if (selected.has(text) || !text.textContent.replace(new RegExp(NOTE_ZWSP, "g"), "").length) return;
      const wrap = template.cloneNode(false);
      text.before(wrap);
      wrap.appendChild(text);
    });
  });
}

let notePending = null;
function noteApplyCommand(editor, cmd, value) {
  const exec = (name, arg) => { try { return document.execCommand(name, false, arg); } catch { return false; } };
  if (cmd === "highlight") { noteToggleHighlight(editor); return; }
  // iPhone (Safari): execCommand dispara "input" no meio da operação, e o
  // listener de input zera notePending. Por isso os estilos pendentes são
  // copiados ANTES do comando (antes: "null is not an object (evaluating
  // 'notePending.values')" ao tocar em Negrito/Cor com o cursor parado).
  if (cmd === "color") {
    const range = noteSelectionIn(editor);
    const caret = range && range.collapsed;
    const prevValues = caret && notePendingMatches(editor, range) ? { ...(notePending?.values || {}) } : {};
    exec("styleWithCSS", true);
    exec("foreColor", value);
    exec("styleWithCSS", false);
    if (caret) {
      const after = noteSelectionIn(editor);
      if (after) notePending = { editor, offset: noteCaretOffset(editor, after), values: { ...prevValues, color: noteColorHex(value) } };
    } else {
      notePending = null;
    }
    return;
  }
  const map = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough", ul: "insertUnorderedList", ol: "insertOrderedList" };
  if (!map[cmd]) return;
  const inline = ["bold", "italic", "underline", "strike"].includes(cmd);
  const range = noteSelectionIn(editor);
  const caret = inline && range && range.collapsed ? { node: range.startContainer, offset: range.startOffset } : null;
  const before = caret ? noteFormatState(editor)[cmd] : false;
  // Cópia feita antes do execCommand (ver comentário acima sobre o iPhone).
  const prevValues = caret && notePendingMatches(editor, range) ? { ...(notePending?.values || {}) } : {};
  // Tags simples (<b>, <i>, <u>, <strike>): o estado do botão é lido delas.
  exec("styleWithCSS", false);
  exec(map[cmd]);
  if (caret) {
    const after = noteSelectionIn(editor);
    if (after && after.collapsed) {
      notePending = { editor, offset: noteCaretOffset(editor, after), values: { ...prevValues, [cmd]: !before } };
    }
  } else {
    notePending = null;
  }
}

// Limpa negrito, itálico, sublinhado, riscado, cor e marca-texto do trecho
// (ou da nota inteira, quando não há trecho marcado).
function noteClearFormatting(editor, whole) {
  const sel = window.getSelection();
  if (whole) {
    const all = document.createRange();
    all.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(all);
  }
  try { document.execCommand("styleWithCSS", false, false); document.execCommand("removeFormat"); } catch { /* sem execCommand */ }
  const range = noteSelectionIn(editor);
  if (range && !range.collapsed) {
    noteSplitRange(range);
    const texts = noteTextNodesIn(range, editor);
    noteUnhighlight(editor, texts);
    const inline = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "FONT", "SPAN"]);
    texts.forEach((text) => {
      let el = text.parentNode;
      while (el && el !== editor && inline.has(el.tagName)) {
        const parent = el.parentNode;
        if ([...el.childNodes].every((child) => child.nodeType !== Node.ELEMENT_NODE || !child.textContent.trim() || texts.some((t) => child.contains(t)))) el.replaceWith(...el.childNodes);
        el = parent;
      }
    });
  }
  if (whole) {
    editor.querySelectorAll("b, strong, i, em, u, s, strike, mark, font").forEach((el) => el.replaceWith(...el.childNodes));
    editor.querySelectorAll("[style]").forEach((el) => el.removeAttribute("style"));
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    sel.removeAllRanges();
    sel.addRange(end);
  }
  editor.normalize();
}

// Mantida pelo nome antigo: marca-texto ativo onde está o cursor?
function noteHighlightActive() {
  const editor = [document.querySelector("#ndBody"), document.querySelector("#noteEditor")].find((el) => el && el === document.activeElement);
  return editor ? noteFormatState(editor).highlight : false;
}

// Corpo formatado -> texto puro (pra description/preview/busca), com
// quebras de linha preservadas — percorre a árvore em vez de regex
// nas tags (regex só trocando a tag de abertura por "\n" perdia a
// quebra entre um <div> e o elemento seguinte, grudando linhas).
function noteHtmlToPlainText(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const BLOCK_TAGS = new Set(["DIV", "P", "UL", "OL"]);
  let text = "";
  const walk = (root) => {
    root.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === "BR") {
          text += "\n";
        } else if (child.tagName === "LI") {
          // Listas viram texto legível (WhatsApp, busca e exportação).
          const ordered = child.parentElement?.tagName === "OL";
          const position = [...(child.parentElement?.children || [])].indexOf(child) + 1;
          if (text && !text.endsWith("\n")) text += "\n";
          text += ordered ? `${position}. ` : "• ";
          walk(child);
          text += "\n";
        } else {
          walk(child);
          if (BLOCK_TAGS.has(child.tagName) && !text.endsWith("\n")) text += "\n";
        }
      }
    });
  };
  walk(template.content);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Trava o scroll do fundo enquanto a nota em tela cheia está aberta.
// `overflow:hidden` no body sozinho NÃO é confiável em PWA instalado
// no iOS (a página por trás ainda "arrasta"/balança) — a técnica que
// funciona de verdade em todo lugar é fixar o body na posição atual.
let ndScrollY = 0;
// A nota aberta cobre a tela inteira, então basta impedir a rolagem do
// fundo com overflow. Antes o corpo virava position:fixed; no iPhone (app
// instalado, barra de status translúcida) isso às vezes deixava a página
// deslocada ao fechar, com uma faixa vazia abaixo da barra inferior.
function lockBackgroundScroll() {
  ndScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add("note-detail-open");
  document.documentElement.classList.add("pn-scroll-locked");
}
function unlockBackgroundScroll() {
  const active = document.activeElement;
  if (active && active !== document.body && typeof active.blur === "function") active.blur();
  document.body.classList.remove("note-detail-open");
  document.documentElement.classList.remove("pn-scroll-locked");
  // Limpa resíduos da versão anterior (caso a página tenha ficado travada).
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  window.scrollTo(0, ndScrollY);
  repairViewportAfterOverlay();
}

// Depois do teclado ou de uma tela cheia, o Safari do iPhone pode deixar a
// área visível deslocada (a barra inferior "sobe"). Forçar a rolagem para a
// mesma posição faz o navegador recalcular os elementos fixos.
// Em página curta (que não rola), rolar para a "mesma posição" não faz
// nada — por isso a página ganha 2px de altura por um instante, rola 1px
// e volta, o que obriga o Safari a reposicionar a barra inferior.
function repairViewportAfterOverlay() {
  const fix = () => {
    const root = document.documentElement;
    const y = Math.max(0, Math.min(window.scrollY, root.scrollHeight - window.innerHeight));
    const previous = document.body.style.minHeight;
    document.body.style.minHeight = "calc(100vh + 2px)";
    window.scrollTo(0, y + 1);
    window.scrollTo(0, y);
    requestAnimationFrame(() => { document.body.style.minHeight = previous; });
  };
  requestAnimationFrame(fix);
  setTimeout(fix, 360);
}

// Repara a tela sempre que o teclado do celular fecha (qualquer campo,
// em qualquer tela: planner, finanças, notas, chat…).
function bindKeyboardViewportRepair() {
  if (!("ontouchstart" in window) && !(navigator.maxTouchPoints > 0)) return;
  const editable = (el) => Boolean(el?.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, select, [contenteditable='true']"));
  let pending = null;
  document.addEventListener("focusout", (event) => {
    if (!editable(event.target)) return;
    clearTimeout(pending);
    pending = setTimeout(() => { if (!editable(document.activeElement)) repairViewportAfterOverlay(); }, 160);
  });
  const vv = window.visualViewport;
  if (vv) {
    let lastHeight = vv.height;
    vv.addEventListener("resize", () => {
      // Teclado fechando: a área visível volta a crescer bastante.
      if (vv.height - lastHeight > 120) repairViewportAfterOverlay();
      lastHeight = vv.height;
    });
  }
  // Janelas e folhas que se fecham (atributo hidden) também reparam.
  if ("MutationObserver" in window) {
    new MutationObserver((mutations) => {
      if (mutations.some((m) => m.target.hidden && m.target.matches?.(".modal-backdrop, .modal, .bn-detail-wrap, [role='dialog'], [aria-modal='true']"))) repairViewportAfterOverlay();
    }).observe(document.body, { attributes: true, attributeFilter: ["hidden"], subtree: true });
  }
}

// Salvamento da nota aberta — como no app Notas do iPhone (23/11/2026):
// enquanto a pessoa digita, formata ou seleciona, NADA é gravado (gravar
// no meio da edição gerava erros de seleção e de cursor). A nota é salva
// ao sair dela (voltar, trocar de nota, ir para outra área), no botão
// Salvar e, por segurança, quando a aba fecha ou o app vai para o fundo.
let ndSavedAt = null;
let ndDirty = false;
function flushNoteDetailSave({ persist = "idle" } = {}) {
  if (!ndCurrentNoteId) return false;
  const wasDirty = ndDirty;
  ndDirty = false;
  const title = document.querySelector("#ndTitle").value.trim() || "Sem título";
  const cleanHtml = sanitizeNoteHtml(document.querySelector("#ndBody").innerHTML);
  const plainText = noteHtmlToPlainText(cleanHtml);

  const existing = state.notes.find((n) => n.id === ndCurrentNoteId);
  if (!existing) return false;
  if (existing.title === title && existing.description === plainText && (existing.descriptionHtml || "") === cleanHtml) {
    // Texto igual, mas o checklist (que muda o estado direto) foi editado.
    if (wasDirty) {
      ndSavedAt = new Date();
      if (persist === "now") { notePersistQueued = false; saveState(); } else queueNotePersist();
      return true;
    }
    return false;
  }

  state.notes = state.notes.map((note) =>
    note.id === ndCurrentNoteId
      ? { ...note, title, description: plainText, descriptionHtml: cleanHtml, updatedAt: new Date().toISOString() }
      : note
  );
  ndSavedAt = new Date();
  if (persist === "now") { notePersistQueued = false; saveState(); }
  else queueNotePersist();
  return true;
}

// Cabeçalho da nota aberta: pasta, prioridade (toque para trocar) e
// última atualização como etiquetas; o texto completo fica em #ndMeta
// para leitores de tela.
function renderNoteDetailMeta(note) {
  const prio = notePriorityKey(note.priority);
  const folder = (note.folder || note.category || "Geral").trim();
  document.querySelector("#ndMeta").textContent =
    `${folder} • Prioridade ${notePriorityLabel(note.priority).toLowerCase()} • Atualizado ${noteWhen(note)}`;
  document.querySelector(".bn-detail-ico")?.style.setProperty("--nc", `var(--np-${prio})`);
  document.querySelector(".bn-detail")?.style.setProperty("--nc", `var(--np-${prio})`);
  // Uma linha de texto só ("● Baixa · Entrada · hoje, 15:53"): o toque abre
  // a folha de detalhes (prioridade, pasta e informações da nota).
  const chips = document.querySelector("#ndChips");
  if (chips) {
    const prioLabel = notePriorityLabel(note.priority);
    chips.innerHTML = `<button type="button" class="bn-nd-metaline" data-nd-details style="--c:var(--np-${prio})" aria-label="Prioridade ${escapeHtml(prioLabel)}, pasta ${escapeHtml(folder)}, atualizada ${escapeHtml(noteWhen(note))}. Toque para editar os detalhes"><span><i class="bn-nd-dot" aria-hidden="true"></i>${escapeHtml(prioLabel)}</span><span>${escapeHtml(folder)}</span><span>${escapeHtml(noteWhen(note))}</span></button>`;
  }
}

// Selo de salvamento da nota aberta:
//   editing → "Não salvo"    (há alterações; salvam ao sair ou em Salvar)
//   saving  → "Salvando…"    (a gravação começou)
//   saved   → "Salvo"        (a nuvem confirmou — evento pulsenote:synced)
//   local   → "Salvo no aparelho" (sem internet/sem sessão; sobe depois)
// O texto troca com fade ("Text states swap", transitions.dev).
const ND_STATUS_LABELS = { new: "Nova nota", editing: "Não salvo", saving: "Salvando…", saved: "Salvo", local: "Salvo no aparelho" };
function setNdStatus(mode) {
  const el = document.querySelector("#ndStatus");
  if (!el) return;
  const state = ND_STATUS_LABELS[mode] ? mode : "saving";
  if (el.dataset.state === state) return; // nada muda: sem repintar a cada tecla
  el.dataset.state = state;
  const label = el.querySelector("span");
  if (label) {
    label.textContent = ND_STATUS_LABELS[state];
    label.classList.remove("is-swap");
    void label.offsetWidth;
    label.classList.add("is-swap");
  }
  const time = ndSavedAt ? `${String(ndSavedAt.getHours()).padStart(2, "0")}:${String(ndSavedAt.getMinutes()).padStart(2, "0")}` : "";
  el.title = state === "saved" && time ? `Salvo na nuvem às ${time}`
    : state === "local" ? "Guardado neste aparelho. Sobe para a nuvem assim que a conexão voltar."
    : state === "editing" ? "As alterações são salvas quando você sai da nota ou toca em Salvar" : "";
  updateNdSaveButton();
}
function ndStatusIsSaved() {
  const s = document.querySelector("#ndStatus")?.dataset.state;
  return s === "saved" || s === "local";
}

// Resposta da sincronização: só marca "Salvo" se a nota estava salvando e
// nenhuma tecla nova chegou no meio do caminho.
let ndAwaitingSync = false;
let ndSyncFallbackTimer = 0;
window.addEventListener("pulsenote:synced", (event) => {
  const current = document.querySelector("#ndStatus")?.dataset.state;
  if (!ndAwaitingSync || !["saving", "local"].includes(current)) return;
  if (!event.detail?.ok && current === "local") return; // segue aguardando a próxima tentativa
  ndAwaitingSync = !event.detail?.ok;
  clearTimeout(ndSyncFallbackTimer);
  setNdStatus(event.detail?.ok ? "saved" : "local");
});

function updateNdSaveButton() {
  const button = document.querySelector("#ndSaveBtn");
  const label = document.querySelector("#ndSaveLabel");
  if (!button || !label) return;
  const saved = ndStatusIsSaved();
  if (state.notes.find((n) => n.id === ndCurrentNoteId)?.draft) {
    label.textContent = "Criar nota";
    button.classList.remove("is-saved");
    button.setAttribute("aria-label", "Criar a nota");
    return;
  }
  if (notesPanelMode()) {
    label.textContent = saved ? "Salvo" : "Salvar";
    button.classList.toggle("is-saved", saved);
    button.setAttribute("aria-label", saved ? "Todas as alterações estão salvas" : "Salvar alterações da nota");
  } else {
    label.textContent = "Concluir";
    button.classList.remove("is-saved");
    button.setAttribute("aria-label", "Concluir e voltar para a biblioteca");
  }
}

function updateNdCount() {
  const el = document.querySelector("#ndCount");
  const body = document.querySelector("#ndBody");
  if (!el || !body) return;
  const words = (body.innerText || "").trim().split(/\s+/).filter(Boolean).length;
  el.textContent = `${words} palavra${words === 1 ? "" : "s"}`;
}

function updateNdToolbarState() {
  const body = document.querySelector("#ndBody");
  paintNoteToolbar(document.querySelector("#noteDetailToolbar"), noteEditorActive(body) ? body : null, "ndCmd");
}

// Fora do texto, nenhum botão da barra fica "aceso".
function resetNdToolbarState() {
  paintNoteToolbar(document.querySelector("#noteDetailToolbar"), null, "ndCmd");
}

// Painéis da barra (cor do texto e link): só um aberto por vez.
function setNdPanel(name) {
  const morePanel = document.querySelector("#ndMorePanel");
  const linkForm = document.querySelector("#ndLinkForm");
  if (morePanel) morePanel.hidden = name !== "more";
  if (linkForm) linkForm.hidden = name !== "link";
  document.querySelector('#noteDetailToolbar [data-nd-cmd="more"]')?.setAttribute("aria-expanded", String(name === "more"));
  document.querySelector('#noteDetailToolbar [data-nd-cmd="link"]')?.setAttribute("aria-expanded", String(name === "link"));
  if (name !== "link") { const input = document.querySelector("#ndLinkInput"); if (input) input.value = ""; }
}

// Fecha a nota e só então segue para outra ação. No celular a nota tem uma
// entrada própria no histórico: history.back() é assíncrono, e trocar de
// tela antes do "popstate" chegar fazia o app voltar sozinho para Notas
// (era o que acontecia com "Virar tarefa").
let ndAfterClose = null;
function closeNoteDetailThen(next) {
  if (!ndCurrentNoteId) { next?.(); return; }
  const waitsForHistory = !notesPanelMode() && Boolean(history.state?.noteDetail);
  if (!waitsForHistory) {
    closeNoteDetail({ updateHistory: false });
    next?.();
    return;
  }
  let done = false;
  const run = () => { if (done) return; done = true; ndAfterClose = null; next?.(); };
  ndAfterClose = run;
  closeNoteDetail();
  setTimeout(run, 450); // reserva, caso o navegador não dispare popstate
}

// ── Abas da nota aberta: Anotação | Checklist ────────────────────
// Campos separados: a barra de formatação só vale para o texto, e o
// checklist tem a tela dele, sem se misturar com a anotação.
let ndTab = "text";
function moveNdTabInk() {
  const tabs = document.querySelector("#ndTabs");
  const active = tabs?.querySelector(`[data-nd-tab="${ndTab}"]`);
  const ink = tabs?.querySelector(".bn-nd-tab-ink");
  if (!tabs || !active || !ink || !active.offsetWidth) return;
  ink.style.setProperty("--x", `${active.offsetLeft}px`);
  ink.style.setProperty("--w", `${active.offsetWidth}px`);
}
function setNdTab(tab, { focus = false, animate = true } = {}) {
  const detail = document.querySelector("#noteDetailModal .bn-detail");
  if (!detail) return;
  const previous = ndTab;
  ndTab = tab === "check" ? "check" : "text";
  detail.dataset.tab = ndTab;
  document.querySelectorAll("#ndTabs [data-nd-tab]").forEach((button) => {
    const on = button.dataset.ndTab === ndTab;
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
  });
  moveNdTabInk();
  const note = state.notes.find((n) => n.id === ndCurrentNoteId);
  if (ndTab === "check") {
    setNdPanel(null);
    ndChecklistAdding = true;
    if (note) renderNoteDetailChecklist(note);
    if (focus || !(note?.checklist || []).length) {
      setTimeout(() => document.querySelector("#ndChecklistAddInput")?.focus({ preventScroll: true }), animate ? 120 : 0);
    }
  }
  if (animate && previous !== ndTab && !prefersReducedMotion()) {
    const panel = ndTab === "check" ? document.querySelector("#ndChecklistSection") : document.querySelector("#ndBody");
    const dir = ndTab === "check" ? 1 : -1;
    panel?.animate?.([{ opacity: 0, transform: `translateX(${dir * 18}px)` }, { opacity: 1, transform: "none" }], { duration: 300, easing: "cubic-bezier(.22,1,.36,1)" });
  }
}

function openNoteDetail(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  if (ndCurrentNoteId && ndCurrentNoteId !== id) {
    const savedId = ndCurrentNoteId;
    const flushed = flushNoteDetailSave();
    const draftResult = finalizeNoteDraft(savedId);
    // A nota anterior foi salva agora: atualiza o cartão dela na lista.
    if (flushed || draftResult) setTimeout(() => { renderNotes(); if (draftResult !== "discarded") flashNoteCard(savedId); }, 0);
  }
  const switching = Boolean(ndCurrentNoteId);
  ndCurrentNoteId = id;
  ndChecklistAdding = false;
  document.querySelector("#ndMenu")?.setAttribute("hidden", "");
  document.querySelector("#ndMenuBtn")?.setAttribute("aria-expanded", "false");
  setNdPanel(null);
  resetNdToolbarState();
  ndSavedAt = note.updatedAt ? new Date(note.updatedAt) : null;

  document.querySelector("#ndTitle").value = note.title || "";
  const body = document.querySelector("#ndBody");
  // Se o HTML guardado não tem texto nenhum (ex.: só "<br>") mas a nota
  // tem descrição — notas criadas pelo WhatsApp/IA ou salvas por versões
  // antigas —, o corpo mostra a descrição em vez de abrir vazio.
  const storedHtml = note.descriptionHtml ? sanitizeNoteHtml(note.descriptionHtml) : "";
  body.innerHTML = storedHtml && (noteHtmlToPlainText(storedHtml) || !String(note.description || "").trim())
    ? storedHtml
    : escapeHtml(note.description || "").replace(/\n/g, "<br>");

  renderNoteDetailChecklist(note);
  // Abre no Checklist quando a nota é só uma lista (sem texto).
  const onlyList = (note.checklist || []).length > 0 && !noteHtmlToPlainText(body.innerHTML).trim();
  setNdTab(onlyList ? "check" : "text", { animate: false });
  requestAnimationFrame(moveNdTabInk);

  renderNoteDetailMeta(note);
  setNdStatus(note.draft ? "new" : "saved");
  document.querySelector("#noteDetailModal .bn-detail")?.classList.toggle("is-new", Boolean(note.draft));
  updateNdSaveButton();
  updateNdCount();
  const detailIcon = document.querySelector(".bn-detail-ico use");
  if (detailIcon) detailIcon.setAttribute("href", `#i-${noteIconFor(note)}`);
  document.querySelector("#ndFavBtn").classList.toggle("is-fav", !!note.favorite);
  document.querySelector("#ndFavBtn svg").setAttribute("fill", note.favorite ? "currentColor" : "none");
  const favLabel = document.querySelector("#ndFavBtn span");
  if (favLabel) favLabel.textContent = note.favorite ? "Remover dos favoritos" : "Favoritar";

  const modal = document.querySelector("#noteDetailModal");
  const wasHidden = modal.hidden;
  modal.hidden = false;
  modal.classList.remove("is-leaving");
  const emptyPanel = document.querySelector("#noteDetailEmpty");
  if (emptyPanel) emptyPanel.hidden = true;
  document.querySelectorAll("#notesList .bn-card").forEach((card) => card.classList.toggle("is-selected", notesPanelMode() && card.dataset.noteId === id));
  const sheet = modal.querySelector(".bn-detail");
  if (!prefersReducedMotion() && sheet?.animate) {
    if (notesPanelMode()) {
      if (switching || wasHidden) sheet.querySelectorAll(".bn-nd-hero, .bn-detail-scroll").forEach((part) => part.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.2,.9,.3,1)" }));
    } else if (wasHidden) {
      sheet.animate([{ opacity: 0, transform: "translateY(28px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,.9,.25,1)" });
    }
  }
  // No computador a nota abre no painel ao lado: sem travar a rolagem nem criar histórico.
  if (notesPanelMode()) return;
  if (switching) return;
  lockBackgroundScroll();
  // Empurra um estado de histórico só pra isso — assim o gesto de
  // "voltar" do celular (ou o botão físico/gesto de voltar do
  // Android) também fecha a nota, em vez de sair do app inteiro ou
  // deixar a pessoa sem uma saída óbvia se algum toque não registrar.
  history.pushState({ ...(history.state || {}), pnView: activeView, noteDetail: true }, "");
}

function renderNoteDetailChecklist(note) {
  const section = document.querySelector("#ndChecklistSection");
  const list = document.querySelector("#ndChecklistItems");
  const summary = document.querySelector("#ndChecklistSummary");
  if (!section || !list || !summary) return;
  const items = note?.checklist || [];
  section.hidden = items.length === 0 && !ndChecklistAdding;
  updateNoteDetailChecklistProgress(note);
  list.innerHTML = items.map((item, index) => {
    const done = noteChecklistItemDone(item);
    const text = escapeHtml(noteChecklistItemText(item));
    return `<div class="bn-check-row${done ? " is-done" : ""}" data-check-index="${index}">
      <button type="button" class="bn-check-toggle" data-nd-check-toggle="${index}" aria-pressed="${done}" aria-label="${done ? "Desmarcar" : "Marcar"}: ${text}"><span class="bn-check-box">${done ? bdIcon("check") : ""}</span></button>
      <textarea class="bn-check-text" rows="1" data-nd-check-text="${index}" maxlength="120" autocomplete="off" enterkeyhint="done" aria-label="Item da checklist">${text}</textarea>
      <button type="button" class="bn-check-del" data-nd-check-del="${index}" aria-label="Remover “${text}”">${bdIcon("x")}</button>
    </div>`;
  }).join("");
  requestAnimationFrame(() => list.querySelectorAll(".bn-check-text").forEach(autosizeCheckText));
}

function updateNoteDetailChecklistProgress(note) {
  const section = document.querySelector("#ndChecklistSection");
  const summary = document.querySelector("#ndChecklistSummary");
  const progress = document.querySelector("#ndChecklistProgress");
  const progressBar = document.querySelector("#ndChecklistProgressBar");
  const items = note?.checklist || [];
  const completed = items.filter(noteChecklistItemDone).length;
  const pct = items.length ? Math.round((completed / items.length) * 100) : 0;
  section?.classList.toggle("is-complete", items.length > 0 && completed === items.length);
  section?.classList.toggle("is-empty", items.length === 0);
  if (summary) summary.textContent = !items.length ? "Checklist vazio" : completed === items.length ? "Tudo concluído" : `${items.length - completed} ${items.length - completed === 1 ? "item pendente" : "itens pendentes"}`;
  if (progress) progress.textContent = !items.length ? "Sem itens ainda" : completed === items.length ? "Tudo feito" : `${completed} de ${items.length} concluídos`;
  const tabCount = document.querySelector("#ndTabCount");
  if (tabCount) {
    tabCount.textContent = items.length ? `${completed}/${items.length}` : "";
    tabCount.classList.toggle("is-done", items.length > 0 && completed === items.length);
  }
  if (progressBar) progressBar.style.width = `${pct}%`;
}

function toggleNoteChecklistItem(noteId, index) {
  const note = state.notes.find((item) => item.id === noteId);
  if (!note || !note.checklist?.[index]) return;
  const current = note.checklist[index];
  const done = !noteChecklistItemDone(current);
  note.checklist[index] = {
    id: typeof current === "object" && current.id ? current.id : crypto.randomUUID(),
    text: noteChecklistItemText(current),
    done,
  };
  note.updatedAt = new Date().toISOString();
  // Atualiza só a linha tocada (sem recriar os campos de texto).
  const row = document.querySelector(`#ndChecklistItems [data-check-index="${index}"]`);
  if (row && ndCurrentNoteId === noteId) {
    row.classList.toggle("is-done", done);
    const toggle = row.querySelector("[data-nd-check-toggle]");
    toggle.setAttribute("aria-pressed", String(done));
    toggle.setAttribute("aria-label", `${done ? "Desmarcar" : "Marcar"}: ${noteChecklistItemText(current)}`);
    toggle.querySelector(".bn-check-box").innerHTML = done ? bdIcon("check") : "";
    if (done && !prefersReducedMotion()) toggle.querySelector(".bn-check-box")?.animate?.([{ transform: "scale(.6)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], { duration: 260, easing: "cubic-bezier(.3,1.5,.5,1)" });
    updateNoteDetailChecklistProgress(note);
  } else if (ndCurrentNoteId === noteId) {
    renderNoteDetailChecklist(note);
  }
  queueNotePersist();
  scheduleNotesListRefresh();
}

// A lista de cartões é redesenhada uma vez só, depois da sequência de
// toques (marcar vários itens seguidos não redesenha a tela a cada um).
let notesListRefreshTimer = 0;
function scheduleNotesListRefresh() {
  clearTimeout(notesListRefreshTimer);
  notesListRefreshTimer = setTimeout(() => renderNotes(), 260);
}

// Só cuida da parte visual (esconder modal, destravar scroll) — não
// mexe no histórico nem salva nada (isso é feito por quem chama esta
// função, ver comentário no listener de "popstate" mais abaixo sobre
// por que precisa ficar separado). Separado de closeNoteDetail() de
// propósito: essa função também é chamada pelo listener de
// "popstate" (botão/gesto de voltar do celular), e SE closeNoteDetail
// também chamasse history.back(), voltar pelo celular disparava um
// novo popstate, que chamava ela de novo, que chamava history.back()
// de novo — um loop.
function closeNoteDetailUI() {
  const modal = document.querySelector("#noteDetailModal");
  const sheet = modal?.querySelector(".bn-detail");
  const animateOut = modal && !modal.hidden && !notesPanelMode() && !prefersReducedMotion() && sheet?.animate;
  if (animateOut) {
    modal.classList.add("is-leaving");
    const anim = sheet.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(24px)" }], { duration: 200, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    const hide = () => { if (modal.classList.contains("is-leaving")) { modal.hidden = true; modal.classList.remove("is-leaving"); } anim.cancel(); };
    anim.finished.then(hide, hide);
  } else if (modal) {
    modal.hidden = true;
  }
  unlockBackgroundScroll();
  ndCurrentNoteId = null;
  const emptyPanel = document.querySelector("#noteDetailEmpty");
  if (emptyPanel) emptyPanel.hidden = false;
}

// Fecha a nota — SEMPRE guarda antes, não importa por onde a pessoa saiu
// (Concluir, voltar, toque fora). Atualiza só a lista de notas, depois que
// a tela já fechou (antes redesenhava o app inteiro e travava um instante).
function closeNoteDetail({ updateHistory = true } = {}) {
  if (!ndCurrentNoteId) return;
  const id = ndCurrentNoteId;
  const changed = flushNoteDetailSave();
  const draftResult = finalizeNoteDraft(id);
  closeNoteDetailUI();
  requestAnimationFrame(() => {
    renderNotes();
    if ((changed || draftResult === "created") && draftResult !== "discarded") flashNoteCard(id);
  });
  if (draftResult === "created") showToast("Nota criada");
  if (updateHistory && history.state && history.state.noteDetail) history.back();
  else if (!updateHistory) history.replaceState({ ...(history.state || {}), pnView: activeView, noteDetail: false }, "");
}

function saveNoteDetail() {
  if (!ndCurrentNoteId) return;
  // "Criar nota" sem nada escrito: avisa em vez de criar uma nota vazia.
  if (ndDraftIsEmpty()) {
    const title = document.querySelector("#ndTitle");
    title?.focus();
    if (!prefersReducedMotion()) document.querySelector("#noteDetailModal .bn-detail")?.animate?.([
      { transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" },
    ], { duration: 320, easing: "ease-in-out" });
    showToast("Escreva um título, um texto ou um item do checklist para criar a nota.");
    return;
  }
  if (notesPanelMode()) {
    clearTimeout(ndAutosaveTimer);
    const draftId = ndCurrentNoteId;
    let changed = flushNoteDetailSave({ persist: "now" });
    if (finalizeNoteDraft(draftId) === "created") {
      changed = true;
      document.querySelector("#noteDetailModal .bn-detail")?.classList.remove("is-new");
      const note = state.notes.find((n) => n.id === draftId);
      if (note) { document.querySelector("#ndTitle").value = note.title; renderNoteDetailMeta(note); }
      notePersistQueued = false;
      saveState();
      showToast("Nota criada");
      requestAnimationFrame(() => flashNoteCard(draftId));
    }
    if (changed && currentUser?.emailVerified && navigator.onLine) {
      ndAwaitingSync = true;
      setNdStatus("saving");
      clearTimeout(syncTimer);
      syncToServer(); // "Salvar agora" envia na hora, sem esperar o agendamento
    } else {
      setNdStatus(changed ? "local" : "saved");
    }
    if (changed) requestAnimationFrame(() => { renderNotes(); });
    const button = document.querySelector("#ndSaveBtn");
    if (typeof window.pnCelebrate === "function") window.pnCelebrate(button, { soft: !changed });
    else if (!prefersReducedMotion()) button?.animate?.([{ transform: "scale(1)" }, { transform: "scale(.96)" }, { transform: "scale(1)" }], { duration: 220, easing: "ease-out" });
    return;
  }
  clearTimeout(ndAutosaveTimer);
  // "Concluir": o botão comemora (check desenhado + faíscas) e a nota fecha
  // logo em seguida, para a animação ser vista antes de voltar à lista.
  if (typeof window.pnCelebrate === "function" && !prefersReducedMotion()) {
    if (saveNoteDetail.closing) return;
    saveNoteDetail.closing = true;
    window.pnCelebrate(document.querySelector("#ndSaveBtn"));
    setTimeout(() => { saveNoteDetail.closing = false; closeNoteDetail(); }, 380);
    return;
  }
  closeNoteDetail();
}
let ndAutosaveTimer = 0;

// "Mover para pasta": lista as pastas + campo para criar uma nova.
function openNoteFolderSheet(noteId) {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;
  document.querySelector("#noteFolderSheet")?.remove();
  const current = (note.folder || "").trim() || "Entrada";
  const folders = noteFolderOptions();
  if (!folders.includes(current)) folders.push(current);
  const sheet = document.createElement("div");
  sheet.id = "noteFolderSheet";
  sheet.className = "modal-backdrop";
  sheet.innerHTML = `<div class="modal-card planner-action-sheet bn-folder-sheet" role="dialog" aria-modal="true" aria-labelledby="noteFolderSheetTitle">
    <div class="modal-header"><h2 id="noteFolderSheetTitle">Mover para pasta</h2><button type="button" class="icon-button" data-close aria-label="Fechar">${bdIcon("x")}</button></div>
    <div class="modal-body planner-action-sheet-body">
      <div class="bn-folder-sheet-list" role="radiogroup" aria-label="Pastas">${folders.map((name) => `<button type="button" role="radio" class="planner-action-option${name === current ? " is-active" : ""}" aria-checked="${name === current}" data-move-folder="${escapeHtml(name)}"><span>${bdIcon("folder")}${escapeHtml(name)}</span>${name === current ? bdIcon("check") : ""}</button>`).join("")}</div>
      <form class="bn-folder-new is-sheet" data-folder-form>
        <input type="text" maxlength="40" placeholder="Nova pasta" autocomplete="off" enterkeyhint="done" aria-label="Nome da nova pasta" />
        <button type="submit" class="bd-btn bd-btn--primary">Criar e mover</button>
      </form>
    </div></div>`;
  document.body.appendChild(sheet);
  const close = () => { sheet.remove(); document.removeEventListener("keydown", onKey); repairViewportAfterOverlay(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  const move = (name) => {
    const target = state.notes.find((n) => n.id === noteId);
    if (!target) { close(); return; }
    const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!clean) return;
    const existing = noteFolderOptions().find((folder) => folder.toLocaleLowerCase("pt-BR") === clean.toLocaleLowerCase("pt-BR")) || clean;
    close();
    if ((target.folder || "Entrada") === existing) return;
    state.notes = state.notes.map((n) => (n.id === noteId ? { ...n, folder: existing, updatedAt: new Date().toISOString() } : n));
    if (ndCurrentNoteId === noteId) renderNoteDetailMeta(state.notes.find((n) => n.id === noteId));
    renderNotes();
    queueNotePersist();
    showToast(`Nota movida para ${existing}`);
  };
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet || e.target.closest("[data-close]")) { close(); return; }
    const option = e.target.closest("[data-move-folder]");
    if (option) move(option.dataset.moveFolder);
  });
  sheet.querySelector("[data-folder-form]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    if (!input.value.trim()) { input.focus(); return; }
    move(input.value);
  });
}

// Folha "Detalhes da nota": prioridade (escolha direta), pasta (abre
// "Mover para pasta") e informações — contagem de palavras e quando foi
// atualizada, que saíram do topo da nota.
function openNoteDetailsSheet(noteId) {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return;
  document.querySelector("#noteDetailsSheet")?.remove();
  const PRIOS = ["Baixa", "Media", "Alta", "Urgente"];
  const currentPrio = PRIOS.includes(note.priority) ? note.priority : "Media";
  const folder = (note.folder || "").trim() || "Entrada";
  const words = document.querySelector("#ndCount")?.textContent?.trim() || "";
  const sheet = document.createElement("div");
  sheet.id = "noteDetailsSheet";
  sheet.className = "modal-backdrop";
  sheet.innerHTML = `<div class="modal-card planner-action-sheet bn-details-sheet" role="dialog" aria-modal="true" aria-labelledby="noteDetailsSheetTitle">
    <div class="modal-header"><h2 id="noteDetailsSheetTitle">Detalhes da nota</h2><button type="button" class="icon-button" data-close aria-label="Fechar">${bdIcon("x")}</button></div>
    <div class="modal-body planner-action-sheet-body">
      <div class="bn-ds-label" id="ndsPrioLabel">Prioridade</div>
      <div class="bn-ds-prios" role="radiogroup" aria-labelledby="ndsPrioLabel">${PRIOS.map((p) => `<button type="button" role="radio" aria-checked="${p === currentPrio}" class="bn-ds-prio${p === currentPrio ? " is-on" : ""}" data-set-prio="${p}" style="--c:var(--np-${notePriorityKey(p)})"><i aria-hidden="true"></i>${escapeHtml(notePriorityLabel(p))}</button>`).join("")}</div>
      <div class="bn-ds-label">Pasta</div>
      <button type="button" class="planner-action-option bn-ds-folder" data-open-folders><span>${bdIcon("folder")}${escapeHtml(folder)}</span><span class="bn-ds-change">Mudar ${bdIcon("chev-right")}</span></button>
      <p class="bn-ds-info">${escapeHtml([words, `atualizada ${noteWhen(note)}`, "salva automaticamente"].filter(Boolean).join(" · "))}</p>
    </div></div>`;
  document.body.appendChild(sheet);
  const close = () => { sheet.remove(); document.removeEventListener("keydown", onKey); repairViewportAfterOverlay(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet || e.target.closest("[data-close]")) { close(); return; }
    const prio = e.target.closest("[data-set-prio]");
    if (prio) {
      const next = prio.dataset.setPrio;
      sheet.querySelectorAll("[data-set-prio]").forEach((b) => { const on = b === prio; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); });
      if (next !== note.priority) {
        flushNoteDetailSave();
        state.notes = state.notes.map((n) => (n.id === noteId ? { ...n, priority: next, updatedAt: new Date().toISOString() } : n));
        if (ndCurrentNoteId === noteId) renderNoteDetailMeta(state.notes.find((n) => n.id === noteId));
        queueNotePersist();
        scheduleNotesListRefresh();
      }
      return;
    }
    if (e.target.closest("[data-open-folders]")) { close(); openNoteFolderSheet(noteId); }
  });
  setTimeout(() => sheet.querySelector(".bn-ds-prio.is-on")?.focus({ preventScroll: true }), 30);
}

// Tela de Notas: atalhos do celular, busca própria, pastas e "+ Pasta".
function bindNotesBoard() {
  document.querySelector("#notesOpenForm")?.addEventListener("click", () => startNewNote());
  document.querySelector("#notesNewNote")?.addEventListener("click", () => startNewNote());
  document.querySelector("#notesCloseForm")?.addEventListener("click", closeNotesFormSheet);
  document.querySelector("#noteFormBackdrop")?.addEventListener("click", closeNotesFormSheet);
  document.querySelector("#notesOpenLibrary")?.addEventListener("click", (event) => {
    const library = document.querySelector("#notesLibrary");
    const open = !library.classList.contains("is-expanded");
    library.classList.toggle("is-expanded", open);
    event.currentTarget.setAttribute("aria-expanded", String(open));
    if (open) setTimeout(() => document.querySelector("#notesSearch")?.focus(), 50);
  });
  const search = document.querySelector("#notesSearch");
  search?.addEventListener("input", debounce(() => { notesSearchQuery = search.value; renderNotes(); }, 150));
  document.querySelector("#noteFolders")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-new-folder]")) {
      // Nova nota já com a folha de pastas aberta (lá dá para criar a pasta).
      startNewNote({ focusTitle: false, openFolders: true });
      return;
    }
    const chip = event.target.closest("[data-note-folder]");
    if (chip) setNotesFolderFilter(chip.dataset.noteFolder);
  });
}

function bindNoteDetail() {
  bindNotesBoard();
  const modal = document.querySelector("#noteDetailModal");
  const body = document.querySelector("#ndBody");
  if (!modal || !body) return;

  document.querySelector("#closeNoteDetail").addEventListener("click", closeNoteDetail);
  // Fecha ao tocar/clicar no fundo, mas não quando uma seleção de texto
  // começa no editor e termina fora do cartão. O clique sintetizado depois
  // de um drag também chegava ao backdrop e desmontava o editor.
  let backdropPointerId = null;
  modal.addEventListener("pointerdown", (event) => {
    backdropPointerId = event.target === modal && event.isPrimary && event.button === 0
      ? event.pointerId
      : null;
  });
  modal.addEventListener("pointerup", (event) => {
    const closeFromBackdrop = backdropPointerId === event.pointerId && event.target === modal;
    backdropPointerId = null;
    if (closeFromBackdrop) closeNoteDetail();
  });
  modal.addEventListener("pointercancel", () => { backdropPointerId = null; });

  document.querySelector("#ndSaveBtn").addEventListener("click", saveNoteDetail);

  // Sem salvamento automático durante a edição: digitar, formatar ou
  // selecionar só marca a nota como "Não salvo". Nada de timer, de gravar
  // no meio da digitação nem de mexer no estado do app enquanto se escreve.
  const markNdDirty = () => {
    ndAwaitingSync = false;
    ndDirty = true;
    setNdStatus("editing"); // retorna na hora se já estiver "Não salvo"
  };
  const onNdInput = () => { updateNdCount(); markNdDirty(); };
  body.addEventListener("input", () => { notePending = null; });
  document.querySelector("#ndTitle").addEventListener("input", onNdInput);
  document.querySelector("#ndTitle").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); body.focus(); }
  });
  body.addEventListener("input", onNdInput);
  window.addEventListener("resize", debounce(updateNdSaveButton, 150));

  // Linha de detalhes: abre a folha com prioridade, pasta e informações.
  // (Os seletores antigos de prioridade/pasta continuam atendidos.)
  document.querySelector("#ndChips")?.addEventListener("click", (event) => {
    const note = state.notes.find((n) => n.id === ndCurrentNoteId);
    if (!note) return;
    if (event.target.closest("[data-nd-details]")) {
      openNoteDetailsSheet(note.id);
    } else if (event.target.closest("[data-nd-prio]")) {
      const order = ["Baixa", "Media", "Alta", "Urgente"];
      const next = order[(order.indexOf(note.priority) + 1) % order.length] || "Media";
      flushNoteDetailSave();
      state.notes = state.notes.map((n) => (n.id === note.id ? { ...n, priority: next, updatedAt: new Date().toISOString() } : n));
      renderNoteDetailMeta(state.notes.find((n) => n.id === note.id));
      document.querySelector("#ndChips [data-nd-prio]")?.focus({ preventScroll: true });
      queueNotePersist();
      scheduleNotesListRefresh();
    } else if (event.target.closest("[data-nd-folder]")) {
      openNoteFolderSheet(note.id);
    }
  });

  // Excluir sem confirm() (falha no app instalado do iPhone): a nota sai
  // na hora e o aviso oferece "Desfazer", que devolve ela no mesmo lugar.
  document.querySelector("#ndDeleteBtn").addEventListener("click", () => {
    if (!ndCurrentNoteId) return;
    const id = ndCurrentNoteId;
    closeNoteDetailThen(() => deleteNoteWithUndo(id));
  });

  document.querySelector("#ndFavBtn").addEventListener("click", () => {
    if (!ndCurrentNoteId) return;
    toggleFavorite(ndCurrentNoteId);
    const note = state.notes.find((n) => n.id === ndCurrentNoteId);
    document.querySelector("#ndFavBtn").classList.toggle("is-fav", !!note?.favorite);
    document.querySelector("#ndFavBtn svg").setAttribute("fill", note?.favorite ? "currentColor" : "none");
    const favLabel = document.querySelector("#ndFavBtn span");
    if (favLabel) favLabel.textContent = note?.favorite ? "Remover dos favoritos" : "Favoritar";
    showToast(note?.favorite ? "Adicionada aos favoritos" : "Removida dos favoritos");
  });

  document.querySelector("#ndConvertTaskBtn").addEventListener("click", () => {
    if (!ndCurrentNoteId) return;
    const id = ndCurrentNoteId;
    closeNoteDetailThen(() => convertNoteToTask(id));
  });

  document.querySelector("#ndMoreFieldsBtn").addEventListener("click", () => {
    if (ndCurrentNoteId) openNoteFolderSheet(ndCurrentNoteId);
  });

  // ── Abas Anotação | Checklist ──
  const ndTabs = document.querySelector("#ndTabs");
  ndTabs?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-nd-tab]");
    if (button) setNdTab(button.dataset.ndTab);
  });
  ndTabs?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    setNdTab(ndTab === "text" ? "check" : "text");
    document.querySelector(`#ndTabs [data-nd-tab="${ndTab}"]`)?.focus();
  });
  window.addEventListener("resize", () => moveNdTabInk(), { passive: true });

  // ── Checklist da nota aberta: marcar, editar o texto, remover ──
  const checklistList = document.querySelector("#ndChecklistItems");
  const removeChecklistItem = (index) => {
    const note = state.notes.find((n) => n.id === ndCurrentNoteId);
    if (!note || !note.checklist?.[index]) return;
    const removed = note.checklist[index];
    note.checklist = note.checklist.filter((_, i) => i !== index);
    note.updatedAt = new Date().toISOString();
    if (!note.checklist.length && document.activeElement?.id !== "ndChecklistAddInput") ndChecklistAdding = false;
    renderNoteDetailChecklist(note);
    queueNotePersist();
    scheduleNotesListRefresh();
    showToast("Item removido", {
      actionLabel: "Desfazer",
      onAction: () => {
        const current = state.notes.find((n) => n.id === note.id);
        if (!current) return;
        const list = [...(current.checklist || [])];
        list.splice(Math.min(index, list.length), 0, removed);
        current.checklist = list;
        current.updatedAt = new Date().toISOString();
        if (ndCurrentNoteId === current.id) renderNoteDetailChecklist(current);
        queueNotePersist();
        scheduleNotesListRefresh();
      },
    });
  };
  checklistList?.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-nd-check-toggle]");
    if (toggle && ndCurrentNoteId) { toggleNoteChecklistItem(ndCurrentNoteId, Number(toggle.dataset.ndCheckToggle)); return; }
    const del = event.target.closest("[data-nd-check-del]");
    if (del) removeChecklistItem(Number(del.dataset.ndCheckDel));
  });
  checklistList?.addEventListener("input", (event) => {
    const input = event.target.closest("[data-nd-check-text]");
    const note = state.notes.find((n) => n.id === ndCurrentNoteId);
    const index = Number(input?.dataset.ndCheckText);
    if (!input || !note || !note.checklist?.[index]) return;
    if (/\n/.test(input.value)) input.value = input.value.replace(/\n+/g, " ");
    autosizeCheckText(input);
    const text = input.value.trim();
    if (!text) return; // vazio: decide ao sair do campo
    const current = note.checklist[index];
    note.checklist[index] = { id: typeof current === "object" && current.id ? current.id : crypto.randomUUID(), text, done: noteChecklistItemDone(current) };
    note.updatedAt = new Date().toISOString();
    markNdDirty(); // salva junto com a nota, ao sair ou em Salvar
  });
  checklistList?.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-nd-check-text]");
    if (!input) return;
    if (event.key === "Enter") { event.preventDefault(); document.querySelector("#ndChecklistAddInput")?.focus(); }
    if (event.key === "Escape") { event.preventDefault(); input.blur(); }
  });
  checklistList?.addEventListener("focusout", (event) => {
    const input = event.target.closest("[data-nd-check-text]");
    const note = state.notes.find((n) => n.id === ndCurrentNoteId);
    if (!input || !note) return;
    const index = Number(input.dataset.ndCheckText);
    if (!input.value.trim()) { removeChecklistItem(index); return; }
    input.value = noteChecklistItemText(note.checklist?.[index]);
  });

  // ── Barra de formatação ──────────────────────────────────────
  // Duas camadas para nunca perder a seleção ao tocar num botão:
  // preventDefault no mousedown e, como reforço, o último trecho válido.
  let ndSavedRange = null;
  const saveNdSelection = () => {
    const range = noteSelectionIn(body);
    if (range) ndSavedRange = range.cloneRange();
  };
  document.addEventListener("selectionchange", () => {
    if (!noteEditorActive(body)) return;
    saveNdSelection();
    updateNdToolbarState();
  });
  body.addEventListener("pointerdown", () => { if (notePending?.editor === body) notePending = null; });
  body.addEventListener("focus", () => {
    if (ndSavedRange && !body.contains(ndSavedRange.commonAncestorContainer)) ndSavedRange = null;
    updateNdToolbarState();
  });
  body.addEventListener("blur", () => setTimeout(() => {
    // Só apaga a barra quando o cursor saiu do texto de verdade (ex.: foi
    // para o título) — tocar num botão da barra não conta como sair.
    if (document.activeElement !== body && !noteSelectionIn(body)) resetNdToolbarState();
  }, 0));

  const toolbar = document.querySelector("#noteDetailToolbar");
  toolbar.addEventListener("mousedown", (e) => {
    if (e.target.closest("[data-nd-color], [data-nd-cmd]")) e.preventDefault();
  });
  toolbar.addEventListener("click", (e) => {
    const swatch = e.target.closest("[data-nd-color]");
    const toolBtn = e.target.closest("[data-nd-cmd]");
    if (!swatch && !toolBtn) return;
    const cmd = toolBtn?.dataset.ndCmd;

    if (cmd === "more" || cmd === "link") {
      const open = toolBtn.getAttribute("aria-expanded") === "true";
      setNdPanel(open ? null : cmd);
      if (!open && cmd === "link") setTimeout(() => document.querySelector("#ndLinkInput")?.focus(), 30);
      return;
    }
    if (cmd === "checklist") {
      // O checklist tem campo próprio: o botão leva para a aba dele, já
      // pronta para digitar o próximo item.
      setNdTab("check", { focus: true });
      return;
    }

    noteRestoreEditorSelection(body, ndSavedRange);
    const beforeHtml = body.innerHTML;
    if (cmd === "clear") {
      const range = noteSelectionIn(body);
      const whole = !range || range.collapsed;
      noteClearFormatting(body, whole);
      setNdPanel(null);
      if (whole && beforeHtml !== body.innerHTML) {
        const noteId = ndCurrentNoteId;
        showToast("Formatação removida", {
          actionLabel: "Desfazer",
          onAction: () => {
            if (ndCurrentNoteId !== noteId) return;
            body.innerHTML = sanitizeNoteHtml(beforeHtml);
            markNdDirty();
            updateNdCount();
          },
        });
      }
    } else if (swatch) {
      noteApplyCommand(body, "color", swatch.dataset.ndColor);
    } else if (cmd) {
      noteApplyCommand(body, cmd);
    }
    scrubNoteEditorStyles(body);
    saveNdSelection();
    if (beforeHtml !== body.innerHTML) markNdDirty();
    updateNdToolbarState();
    requestAnimationFrame(updateNdToolbarState);
    updateNdCount();
  });
  // Toque fora da barra fecha o painel de cor/link aberto.
  document.addEventListener("pointerdown", (event) => {
    if (event.target.closest("#noteDetailToolbar, #ndLinkForm")) return;
    if (!document.querySelector("#ndMorePanel")?.hidden || !document.querySelector("#ndLinkForm")?.hidden) setNdPanel(null);
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.querySelector("#ndMorePanel")?.hidden || !document.querySelector("#ndLinkForm")?.hidden) {
      event.stopPropagation();
      setNdPanel(null);
      body.focus({ preventScroll: true });
    }
  });

  // Link: aplica no trecho selecionado (ou insere o próprio endereço)
  document.querySelector("#ndLinkForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    let url = document.querySelector("#ndLinkInput").value.trim();
    if (!url) { document.querySelector("#ndLinkInput").focus(); return; }
    if (!/^(https?:\/\/|mailto:)/i.test(url)) url = `https://${url}`;
    noteRestoreEditorSelection(body, ndSavedRange);
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) document.execCommand("createLink", false, url);
    else document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>&nbsp;`);
    setNdPanel(null);
    scrubNoteEditorStyles(body);
    markNdDirty();
  });

  // Menu "⋮" da nota
  const menuBtn = document.querySelector("#ndMenuBtn");
  const menu = document.querySelector("#ndMenu");
  menuBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    setNdPanel(null);
    menu.hidden = !menu.hidden;
    menuBtn.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (event) => {
    if (menu && !menu.hidden && !event.target.closest(".bn-menu-wrap")) {
      menu.hidden = true;
      menuBtn?.setAttribute("aria-expanded", "false");
    }
  });
  menu?.addEventListener("click", () => { menu.hidden = true; menuBtn?.setAttribute("aria-expanded", "false"); });

  // Novo item da checklist direto na nota aberta
  document.querySelector("#ndChecklistAddForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#ndChecklistAddInput");
    const text = input.value.trim();
    const note = state.notes.find((n) => n.id === ndCurrentNoteId);
    if (!text || !note) { input.focus(); return; }
    note.checklist = [...(note.checklist || []), { id: crypto.randomUUID(), text, done: false }];
    note.updatedAt = new Date().toISOString();
    input.value = "";
    renderNoteDetailChecklist(note);
    queueNotePersist();
    scheduleNotesListRefresh();
    input.focus();
  });
  // Sair do campo de novo item sem itens: o checklist vazio volta a sumir.
  document.querySelector("#ndChecklistAddInput")?.addEventListener("blur", () => setTimeout(() => {
    const note = state.notes.find((n) => n.id === ndCurrentNoteId);
    const section = document.querySelector("#ndChecklistSection");
    if (!note || (note.checklist || []).length || section?.contains(document.activeElement)) return;
    ndChecklistAdding = false;
    renderNoteDetailChecklist(note);
  }, 120));

  // Gesto/botão físico de "voltar" do celular fecha a nota em vez de
  // sair do app — ver comentário em closeNoteDetailUI() sobre por que
  // isso chama a versão SEM history.back() (evita loop). Salva antes
  // de fechar pelo mesmo motivo de todo outro caminho de saída: voltar
  // pelo celular não pode jogar fora o que foi escrito.
  window.addEventListener("popstate", (event) => {
    if (!modal.hidden && ndCurrentNoteId) {
      const id = ndCurrentNoteId;
      const changed = flushNoteDetailSave();
      const draftResult = finalizeNoteDraft(id);
      closeNoteDetailUI();
      requestAnimationFrame(() => { renderNotes(); if ((changed || draftResult === "created") && draftResult !== "discarded") flashNoteCard(id); });
      if (draftResult === "created") showToast("Nota criada");
    }
    const view = event.state?.pnView;
    if (view && view !== activeView) setView(view, { fromHistory: true });
    if (ndAfterClose) ndAfterClose();
  });
}

function renderTasks() {
  const board = document.querySelector("#taskBoard");
  if (!board) return; // tela antiga de Tarefas removida — o Planner cobre tudo isso agora
  const tasks = queryFilter(state.tasks, ["title", "status", "priority", "dueDate"]);
  const activeTasks = state.tasks.filter((task) => task.status !== "Cancelada");
  const completed = activeTasks.filter((task) => task.status === "Concluida").length;
  const progress = activeTasks.length ? Math.round((completed / activeTasks.length) * 100) : 0;
  document.querySelector("#taskProgressBar").style.width = `${progress}%`;
  document.querySelector("#taskProgressLabel").textContent = `${progress}%`;

  // No mobile, a aba ativa determina qual coluna fica visível
  const activeTab = document.querySelector(".status-tab.active")?.dataset.statusTab || "Pendente";

  board.innerHTML = statusList
    .map((status) => {
      const columnTasks = tasks.filter((task) => task.status === status);
      const isActiveTab = status === activeTab ? "tab-active" : "";
      return `
        <section class="task-column ${isActiveTab}" data-status="${status}">
          <div class="column-title"><h2>${status}</h2><span class="pill">${columnTasks.length}</span></div>
          ${columnTasks.map(renderTaskRow).join("") || '<div class="empty-state">Sem itens.</div>'}
        </section>
      `;
    })
    .join("");

  document.querySelectorAll(".task-column").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      column.classList.add("drag-over");
    });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", () => {
      column.classList.remove("drag-over");
      updateTaskStatus(draggedTaskId, column.dataset.status);
    });
  });
}

function renderTaskRow(task) {
  const isDone = task.status === "Concluida";
  const subtasks = task.subtasks || [];
  const doneCount = subtasks.filter((s) => s.done).length;
  return `
    <article class="task-row" data-task-id="${task.id}">
      <div class="task-row-top">
        <button class="task-check ${isDone ? "is-done" : ""}" onclick="toggleTask('${task.id}')" title="Concluir">${isDone ? icon("check", 15) : ""}</button>
        <div class="task-title" style="${isDone ? "text-decoration:line-through;opacity:0.5;" : ""}" onclick="toggleTaskDetails('${task.id}', event)">${escapeHtml(task.title)}</div>
        <div class="task-row-actions">
          <button class="mini-button" onclick="openPlannerTaskActions('${task.id}', event)" title="Mais opções">${icon("moreVertical", 16)}</button>
        </div>
      </div>
      <div class="task-row-bottom">
        <span class="task-meta">${icon("calendarWeek", 12)}${formatDate(task.dueDate)}</span>
        <span class="priority-pill priority-${task.priority}">${escapeHtml(task.priority)}</span>
        <span class="status-pill status-${task.status.replace(" ", "-")}">${task.status}</span>
        <button class="mini-button task-subtasks-toggle" onclick="toggleTaskDetails('${task.id}', event)" style="margin-left:auto;padding:2px 8px;font-size:0.7rem">${icon("checkCircle", 12)} ${doneCount}/${subtasks.length}</button>
      </div>
      <div class="task-subtasks">
        ${subtasks.map((s) => `
          <div class="task-subtask-row">
            <button class="task-subtask-check ${s.done ? "done" : ""}" onclick="toggleSubtask('${task.id}','${s.id}', event)">${s.done ? icon("check", 11) : ""}</button>
            <span class="${s.done ? "done" : ""}">${escapeHtml(s.title)}</span>
            <button class="mini-button" onclick="deleteSubtask('${task.id}','${s.id}', event)" style="padding:0;width:22px;height:22px;margin-left:auto">${icon("x", 11)}</button>
          </div>`).join("") || `<div class="empty-state" style="padding:8px 0">Sem itens na checklist.</div>`}
        <button class="mini-button" onclick="addSubtask('${task.id}', event)" style="width:100%;margin-top:4px">${icon("plus", 13)} Item da checklist</button>
      </div>
    </article>
  `;
}

// Menu rápido para mudar o status de uma tarefa sem precisar arrastar
// (arrastar/soltar não funciona em telas de toque) — essencial no mobile.
function openTaskMoveMenu(taskId, event) {
  event?.stopPropagation();
  document.getElementById("taskMoveMenu")?.remove();

  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  const menu = document.createElement("div");
  menu.id = "taskMoveMenu";
  menu.style.cssText = `position:fixed;inset:0;z-index:550;background:rgba(0,0,0,0.4);
    backdrop-filter:blur(4px);display:grid;place-items:center;padding:20px`;

  menu.innerHTML = `
    <div style="background:var(--surface);border-radius:22px;padding:22px;width:100%;max-width:340px;
      box-shadow:0 20px 60px rgba(0,0,0,0.25);animation:fadeUp 180ms ease;
      max-height:90dvh;overflow-y:auto">
      <p style="font-size:0.8rem;font-weight:700;color:var(--muted);margin-bottom:4px">Mover tarefa</p>
      <h3 style="font-size:1rem;font-weight:800;color:var(--text);margin-bottom:16px">${escapeHtml(task.title)}</h3>
      <div style="display:grid;gap:8px">
        ${statusList.map((status) => `
          <button class="task-move-option" data-move-status="${status}"
            style="display:flex;align-items:center;justify-content:space-between;
            padding:12px 14px;border-radius:14px;border:1.5px solid ${status === task.status ? "var(--accent)" : "var(--line)"};
            background:${status === task.status ? "var(--accent-soft)" : "var(--surface2)"};
            color:${status === task.status ? "var(--accent)" : "var(--text)"};
            font-weight:700;font-size:0.9rem;cursor:pointer;width:100%">
            <span>${status}</span>
            ${status === task.status ? icon("check", 14) : ""}
          </button>
        `).join("")}
      </div>
      <button id="closeMoveMenu" style="width:100%;height:42px;margin-top:14px;border-radius:12px;
        background:var(--surface2);border:none;color:var(--text2);font-weight:600;cursor:pointer">Cancelar</button>
    </div>
  `;

  document.body.appendChild(menu);

  menu.addEventListener("click", (e) => { if (e.target === menu) menu.remove(); });
  document.getElementById("closeMoveMenu").addEventListener("click", () => menu.remove());

  menu.querySelectorAll(".task-move-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      updateTaskStatus(taskId, btn.dataset.moveStatus);
      menu.remove();
    });
  });
}

function dragTask(id) {
  draggedTaskId = id;
}

function toggleTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  const nextStatus = task.status === "Concluida" ? "Pendente" : "Concluida";
  updateTaskStatus(id, nextStatus);
}

function updateTaskStatus(id, status) {
  const previous = state.tasks.find((task) => task.id === id)?.status;
  state.tasks = state.tasks.map((task) =>
    task.id === id
      ? {
          ...task,
          status,
          completedAt: status === "Concluida" ? todayIso : "",
        }
      : task
  );
  saveState();
  renderAll();
  if (status === "Concluida" && previous !== "Concluida") {
    celebrate("Tarefa concluida. XP ganho.");
    const task = state.tasks.find((t) => t.id === id);
    if (task?.recurrence) spawnNextRecurringTask(task);
  }
}

// Cria automaticamente a próxima ocorrência de uma tarefa recorrente quando
// a atual é concluída — igual já acontece com lançamentos financeiros.
function spawnNextRecurringTask(task) {
  const base = task.dueDate ? new Date(task.dueDate + "T00:00:00") : new Date();
  const next = new Date(base);
  if (task.recurrence === "diaria") next.setDate(next.getDate() + 1);
  else if (task.recurrence === "semanal") next.setDate(next.getDate() + 7);
  else if (task.recurrence === "mensal") next.setMonth(next.getMonth() + 1);
  else return;

  const newTask = createTask(task.title, "Pendente", task.priority, toLocalIso(next));
  newTask.recurrence = task.recurrence;
  newTask.subtasks = (task.subtasks || []).map((s) => ({ ...s, id: crypto.randomUUID(), done: false }));
  state.tasks.unshift(newTask);
  saveState();
  renderAll();
}

// Alterna a recorrência de uma tarefa entre nenhuma → diária → semanal →
// mensal → nenhuma, num único botão (sem precisar de um modal extra).
function cycleTaskRecurrence(id, event) {
  event?.stopPropagation();
  const order = [null, "diaria", "semanal", "mensal"];
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  const idx = order.indexOf(task.recurrence || null);
  task.recurrence = order[(idx + 1) % order.length];
  saveState();
  renderTasks();
  renderPlanner();
  const labels = { diaria: "Repete diariamente", semanal: "Repete semanalmente", mensal: "Repete mensalmente" };
  showToast(task.recurrence ? labels[task.recurrence] : "Repetição desativada.");
}

// ── Subtarefas (checklist dentro da tarefa) ────────────────────
// O seletor não fica mais preso a ".task-row" — assim funciona tanto na
// tela antiga de Tarefas quanto nas linhas de tarefa do Planner, que
// usam o mesmo data-task-id.
// ── Preview de checklist na nota (Biblioteca de Anotações) ──
// O cartão da nota só mostra os 3 primeiros itens por padrão pra não
// ficar gigante — antes disso, os itens extras ("+N mais itens") eram só
// um texto estático, sem nenhum jeito de vê-los sem abrir "Editar". Agora
// é um botão de verdade que revela o resto ali mesmo, no cartão.
function toggleNoteChecklistPreview(btn) {
  const wrap = btn.closest(".checklist-preview");
  if (!wrap) return;
  const expanded = wrap.classList.toggle("expanded");
  const extraCount = wrap.querySelectorAll(".cl-item-extra").length;
  btn.textContent = expanded ? "Mostrar menos" : `+${extraCount} mais itens`;
}

function toggleTaskDetails(id, event) {
  event?.stopPropagation();
  if (plannerExpandedTaskDetails.has(id)) plannerExpandedTaskDetails.delete(id);
  else plannerExpandedTaskDetails.add(id);
  document.querySelector(`[data-task-id="${id}"] .task-subtasks`)?.classList.toggle("open", plannerExpandedTaskDetails.has(id));
}

function addSubtask(id, event) {
  event?.stopPropagation();
  const title = prompt("Nome do item da checklist:");
  if (!title || !title.trim()) return;
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  if (!task.subtasks) task.subtasks = [];
  task.subtasks.push({ id: crypto.randomUUID(), title: title.trim(), done: false });
  saveState();
  renderTasks();
  renderPlanner();
}

function toggleSubtask(taskId, subId, event) {
  event?.stopPropagation();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.subtasks = (task.subtasks || []).map((s) => (s.id === subId ? { ...s, done: !s.done } : s));
  saveState();
  renderTasks();
  renderPlanner();
}

function deleteSubtask(taskId, subId, event) {
  event?.stopPropagation();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.subtasks = (task.subtasks || []).filter((s) => s.id !== subId);
  saveState();
  renderTasks();
  renderPlanner();
}

// Substitui addSubtask (prompt() nativo) por um formulário inline que já
// fica dentro do próprio painel de checklist — funciona igual em qualquer
// navegador e também dentro do PWA instalado no iOS. Mantém a checklist
// aberta e devolve o foco ao campo pra permitir adicionar vários itens
// em sequência.
function submitSubtaskForm(id, event) {
  event.preventDefault();
  const input = event.target.querySelector("input");
  const title = (input?.value || "").trim();
  if (!title) return false;
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return false;
  if (!task.subtasks) task.subtasks = [];
  task.subtasks.push({ id: crypto.randomUUID(), title, done: false });
  saveState();
  renderTasks();
  renderPlanner();
  const freshInput = document.querySelector(`[data-task-id="${id}"] .planner-inline-add-form input`);
  freshInput?.focus();
  return false;
}

function deleteTask(id) {
  state.tasks = state.tasks.filter((task) => task.id !== id);
  saveState();
  renderAll();
}

// Menu único de ações de uma tarefa no Planner: status + repetição +
// excluir num só lugar. Substitui os 3 botões separados que existiam
// antes na linha (repetir / mover / excluir) por um único botão "⋮" —
// mesma capacidade, um terço da poluição visual.
const RECURRENCE_OPTIONS = [
  { value: "", label: "Não repete" },
  { value: "diaria", label: "Diariamente" },
  { value: "semanal", label: "Semanalmente" },
  { value: "mensal", label: "Mensalmente" },
];

function closePlannerTaskActions() {
  document.querySelector("#plannerTaskActionsSheet")?.remove();
  document.removeEventListener("keydown", handlePlannerTaskActionsEscape);
}

function handlePlannerTaskActionsEscape(event) {
  if (event.key === "Escape") closePlannerTaskActions();
}

function openPlannerTaskActions(taskId, event) {
  event?.stopPropagation();
  closePlannerTaskActions();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;

  const sheet = document.createElement("div");
  sheet.id = "plannerTaskActionsSheet";
  sheet.className = "modal-backdrop";
  sheet.innerHTML = `
    <div class="modal-card planner-action-sheet">
      <div class="modal-header">
        <h2>${escapeHtml(task.title)}</h2>
        <button class="icon-button" id="plannerTaskActionsClose">${icon("x", 18)}</button>
      </div>
      <div class="modal-body planner-action-sheet-body">
        <div>
          <p class="planner-action-sheet-label">Status</p>
          <div class="planner-action-sheet-options">
            ${statusList
              .map(
                (status) => `
              <button type="button" class="planner-action-option ${status === task.status ? "is-active" : ""}" data-status="${status}">
                <span>${status}</span>${status === task.status ? icon("check", 14) : ""}
              </button>`
              )
              .join("")}
          </div>
        </div>
        <div>
          <p class="planner-action-sheet-label">Repetição</p>
          <div class="planner-action-sheet-options">
            ${RECURRENCE_OPTIONS.map(
              (opt) => `
              <button type="button" class="planner-action-option ${(task.recurrence || "") === opt.value ? "is-active" : ""}" data-recurrence="${opt.value}">
                <span>${opt.label}</span>${(task.recurrence || "") === opt.value ? icon("check", 14) : ""}
              </button>`
            ).join("")}
          </div>
        </div>
        <button type="button" class="planner-action-option" id="plannerTaskActionsEdit"><span>Editar tarefa</span>${icon("pencil", 14)}</button>
        <button type="button" class="planner-action-danger" id="plannerTaskActionsDelete">${icon("trash", 15)}<span>Excluir tarefa</span></button>
      </div>
    </div>
  `;
  document.body.appendChild(sheet);
  document.addEventListener("keydown", handlePlannerTaskActionsEscape);

  sheet.addEventListener("click", (e) => { if (e.target === sheet) closePlannerTaskActions(); });
  sheet.querySelector("#plannerTaskActionsClose").addEventListener("click", closePlannerTaskActions);

  sheet.querySelectorAll("[data-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      updateTaskStatus(taskId, btn.dataset.status);
      closePlannerTaskActions();
    });
  });

  sheet.querySelectorAll("[data-recurrence]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = state.tasks.find((t) => t.id === taskId);
      if (!current) return closePlannerTaskActions();
      current.recurrence = btn.dataset.recurrence || null;
      saveState();
      renderTasks();
      renderPlanner();
      const labels = { diaria: "Repete diariamente", semanal: "Repete semanalmente", mensal: "Repete mensalmente" };
      showToast(current.recurrence ? labels[current.recurrence] : "Repetição desativada.");
      closePlannerTaskActions();
    });
  });

  sheet.querySelector("#plannerTaskActionsEdit").addEventListener("click", () => {
    closePlannerTaskActions();
    openPlannerTaskEditor(taskId);
  });

  sheet.querySelector("#plannerTaskActionsDelete").addEventListener("click", () => {
    deleteTask(taskId);
    closePlannerTaskActions();
  });
}

function renderCalendar() {
  const grid = document.querySelector("#calendarGrid");
  if (!grid) return; // tela antiga de Agenda removida — o Planner (Semana/Mês) cobre isso agora
  const current = new Date();
  document.querySelector("#monthLabel").textContent = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
  }).format(current);

  const days = calendarMode === "month" ? getMonthDays(current) : calendarMode === "week" ? getWeekDays(current) : [todayIso];
  grid.innerHTML = days
    .map((date) => {
      const events = state.events.filter((event) => event.date === date);
      return `<button class="calendar-day ${date === todayIso ? "today" : ""} ${events.length ? "has-event" : ""}" onclick="filterEventsByDate('${date}')"><strong>${new Date(`${date}T12:00:00`).getDate()}</strong><span class="task-meta">${events.length || ""}</span></button>`;
    })
    .join("");

  const events = queryFilter(state.events, ["title", "location", "notes"]).sort(sortEvent);
  renderList("#calendarEvents", events, renderEventRow, "Nenhum compromisso cadastrado.");
}

function getMonthDays(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const total = new Date(year, month + 1, 0).getDate();
  return [...Array(total)].map((_, index) => toLocalIso(new Date(year, month, index + 1)));
}

function getWeekDays(date) {
  const start = new Date(date);
  start.setDate(date.getDate() - date.getDay());
  return [...Array(7)].map((_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return toLocalIso(day);
  });
}

function filterEventsByDate(date) {
  const events = state.events.filter((event) => event.date === date).sort(sortEvent);
  renderList("#calendarEvents", events, renderEventRow, "Sem compromissos nesse dia.");
}

function renderEventRow(event) {
  const cd = countdownLabel(event.date, event.time);
  return `
    <article class="event-row" data-event-id="${event.id}">
      <div style="flex:1;min-width:0">
        <strong style="font-size:0.9rem">${escapeHtml(event.title)}</strong>
        <div class="event-meta">${icon("calendar", 12)}${formatDate(event.date)} às ${event.time} <span class="event-meta-dot">·</span> ${icon("mapPin", 12)}${escapeHtml(event.location)}</div>
      </div>
      <div class="tag-list" style="flex-shrink:0">
        <span class="event-countdown tone-${cd.tone}" data-event-date="${event.date}" data-event-time="${event.time}">
          <span class="event-countdown-dot"></span><span class="event-countdown-text">${escapeHtml(cd.text)}</span>
        </span>
        <button class="mini-button" onclick="deleteEvent('${event.id}')" title="Excluir" style="padding:0;width:28px;height:28px">${icon("trash", 14)}</button>
      </div>
    </article>
  `;
}

// Calcula quanto tempo falta (ou já passou) para um compromisso, em texto
// amigável. Retorna { text, tone } em vez de já embutir emoji/cor no texto,
// pra quem consome poder estilizar (ponto colorido + CSS) em vez de
// depender de emoji — que rendeririam diferente (ou feio, tipo o 📅 que
// alguns sistemas mostram como um ícone genérico de "dia 17") em cada
// aparelho/fonte.
function countdownLabel(date, time) {
  if (!date || !time) return { text: "", tone: "ok" };
  const target = new Date(`${date}T${time}`);
  const diffMs = target - new Date();
  const diffMin = Math.round(diffMs / 60000);

  if (diffMin <= 0 && diffMin > -30) return { text: "Agora", tone: "now" };
  if (diffMin <= -30) {
    const hoursAgo = Math.round(Math.abs(diffMin) / 60);
    return { text: hoursAgo >= 1 ? `Atrasado ${hoursAgo}h` : `Atrasado ${Math.abs(diffMin)}min`, tone: "late" };
  }
  if (diffMin < 60) return { text: `Faltam ${diffMin}min`, tone: "soon" };
  const hours = Math.floor(diffMin / 60);
  const minutes = diffMin % 60;
  if (hours < 24) return { text: `Faltam ${hours}h${minutes ? ` ${minutes}min` : ""}`, tone: "ok" };
  const days = Math.floor(hours / 24);
  return { text: `Faltam ${days} dia${days > 1 ? "s" : ""}`, tone: "ok" };
}

// Atualiza só o texto/cor dos contadores já na tela, sem re-renderizar a
// lista inteira (evita perder scroll/seleção e é muito mais leve do que
// chamar renderCalendar a cada minuto).
function updateEventCountdowns() {
  document.querySelectorAll(".event-countdown").forEach((el) => {
    const cd = countdownLabel(el.dataset.eventDate, el.dataset.eventTime);
    el.className = `event-countdown tone-${cd.tone}`;
    const textEl = el.querySelector(".event-countdown-text");
    if (textEl) textEl.textContent = cd.text;
  });
}

function sortEvent(first, second) {
  return `${first.date}${first.time}`.localeCompare(`${second.date}${second.time}`);
}

function deleteEvent(id) {
  state.events = state.events.filter((event) => event.id !== id);
  saveState();
  renderAll();
}

function renderGoals() {
  if (!document.querySelector("#goalsList")) return; // tela antiga de Metas removida — Planner + Perfil cobrem isso agora
  const goals = queryFilter(state.goals, ["title"]);
  renderList(
    "#goalsList",
    goals,
    (goal) => {
      const percent = Math.min(100, Math.round((goal.current / goal.target) * 100));
      const isComplete = goal.current >= goal.target;
      const milestones = goal.milestones || [];
      const msDone = milestones.filter((m) => m.done).length;
      const milestonesHtml = milestones.length
        ? `<div class="goal-milestones">
            ${milestones.map((m) => `
              <div class="goal-milestone-row">
                <button class="goal-milestone-check ${m.done ? "done" : ""}" onclick="toggleGoalMilestone('${goal.id}','${m.id}', event)">${m.done ? bdIcon("check") : ""}</button>
                <span class="${m.done ? "done" : ""}">${escapeHtml(m.title)}</span>
                <button class="mini-button" onclick="deleteGoalMilestone('${goal.id}','${m.id}', event)" style="padding:0;width:20px;height:20px;margin-left:auto" aria-label="Remover marco">${bdIcon("x")}</button>
              </div>`).join("")}
          </div>`
        : "";
      return `
        <article class="goal-card" data-goal-id="${goal.id}" style="${isComplete ? "border-color:var(--green);background:var(--green-soft);" : ""}">
          <div>
            <h2>${escapeHtml(goal.title)}</h2>
            <div class="task-meta">${goal.current}/${goal.target} etapas${isComplete ? " · concluída" : ""}${milestones.length ? ` · ${msDone}/${milestones.length} marcos` : ""}</div>
          </div>
          <div class="progress-track"><div style="width:${percent}%;background:${isComplete ? "var(--green)" : "linear-gradient(90deg,var(--accent),var(--purple))"}"></div></div>
          ${milestonesHtml}
          <div class="goal-controls">
            <button class="mini-button" onclick="changeGoal('${goal.id}', -1)">−</button>
            <span class="pill" style="${isComplete ? "background:var(--green);color:#fff;border-color:var(--green);" : ""}">${percent}%</span>
            <button class="mini-button" onclick="changeGoal('${goal.id}', 1)">+</button>
            <button class="mini-button" onclick="addGoalMilestone('${goal.id}', event)" title="Adicionar marco" aria-label="Adicionar marco">${bdIcon("flag")}</button>
            <button class="mini-button" onclick="deleteGoal('${goal.id}')" style="margin-left:auto" aria-label="Excluir meta">${bdIcon("trash")}</button>
          </div>
        </article>
      `;
    },
    elements.globalSearch.value.trim() ? "Nenhuma meta encontrada para essa busca." : "Nenhuma meta criada. Defina seu foco."
  );
  renderAchievements();
}

function changeGoal(id, delta) {
  const previous = state.goals.find((goal) => goal.id === id);
  state.goals = state.goals.map((goal) =>
    goal.id === id ? { ...goal, current: Math.max(0, Math.min(goal.target, goal.current + delta)) } : goal
  );
  saveState();
  renderAll();
  const updated = state.goals.find((goal) => goal.id === id);
  if (delta > 0 && previous && updated && previous.current < previous.target && updated.current >= updated.target) {
    celebrate("Meta concluida. Medalha desbloqueada.");
  }
}

function deleteGoal(id) {
  state.goals = state.goals.filter((goal) => goal.id !== id);
  saveState();
  renderAll();
}

function renderAchievements() {
  const achievements = getAchievementsList();
  document.querySelector("#achievementCount").textContent = `${achievements.filter((item) => item.unlocked).length}/${achievements.length}`;
  document.querySelector("#achievements").innerHTML = achievements
    .map(
      (item) => `
        <article class="achievement ${item.unlocked ? "unlocked" : ""}">
          <strong style="display:flex;align-items:center;gap:6px">${icon(item.iconName, 14)}${item.title}${item.unlocked ? icon("check", 12) : ""}</strong>
          <span class="task-meta">${item.detail}</span>
        </article>
      `
    )
    .join("");
}

function renderList(selector, items, renderer, emptyText, emptyClass = "empty-state") {
  const element = document.querySelector(selector);
  element.innerHTML = items.length ? items.map(renderer).join("") : `<div class="${emptyClass}">${emptyText}</div>`;
}

// Formata uma data (string "YYYY-MM-DD", Date já pronto, ou qualquer
// outro valor) sem derrubar a tela quando vier ausente/malformada — dado
// corrompido, campo vazio, ou uma data inválida que escapou de alguma
// validação (ex.: "2026-13-40"). ANTES, isso derrubava a tela INTEIRA
// com "date value is not finite in DateTimeFormat format()", travando
// telas sem nenhuma relação com o dado quebrado (o Início inteiro parava
// de renderizar por causa de UM compromisso com data ruim). Usado por
// todo formatador de data do app que recebe um valor vindo de
// tarefa/compromisso/lançamento salvo (não por `new Date()` fresco, que
// nunca é inválido).
function safeFormatDate(dateInput, options, fallback = "Data inválida") {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (!Number.isFinite(date.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat("pt-BR", options).format(date);
  } catch (err) {
    return fallback;
  }
}

function formatDate(value) {
  return safeFormatDate(`${value}T12:00:00`, { day: "2-digit", month: "short" }, "--/--");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Espera "delay" ms de silêncio antes de rodar "fn" — cada nova
// chamada cancela a anterior que ainda não rodou. Usado na busca
// global pra não redesenhar o app inteiro a cada tecla digitada.
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// options.actionLabel/onAction: botão no aviso (ex.: "Desfazer"), que
// fica um pouco mais na tela para dar tempo de tocar.
// Toast v2 — "Toast open/close" + "Success check" do transitions.dev.
// O tom (sucesso, alerta, informação, exclusão) vem de options.tone ou é
// deduzido da mensagem; emojis no começo das mensagens antigas são
// removidos — o ícone animado faz esse papel com o desenho do app.
const TOAST_EMOJI_TONE = [
  [/^(⚠️|⚠|🚨|❌|⛔)/u, "warn"],
  [/^(🗑️|🗑|🔓|🔌)/u, "delete"],
  [/^(✅|🎉|✨|✓|✔️|✏️|📊|📄|🔒|🔁|🚀|💜|👍|🔔)/u, "success"],
];
function toastTone(message, explicit) {
  if (explicit) return explicit;
  const text = String(message || "").trim();
  for (const [re, tone] of TOAST_EMOJI_TONE) if (re.test(text)) return tone;
  if (/\b(n[ãa]o foi poss[ií]vel|erro|falhou|inv[aá]lid|informe|escolha|preencha|digite|fechado\. reabra|ultrapassad|aten[cç][ãa]o)/i.test(text)) return "warn";
  if (/\b(exclu[ií]d|removid|apagad|desvinculad|cancelad)/i.test(text)) return "delete";
  if (/\b(salv|criad|atualizad|registrad|conclu[ií]d|pront|lançad|guardad|baixad|gerad|ativad|copiad|enviad|confirmad|restaurad|reabert)/i.test(text)) return "success";
  return "info";
}
function toastCleanText(message) {
  return String(message ?? "")
    .replace(/^(?:[\p{Extended_Pictographic}☀-➿️‍✓✔]+\s*)+/u, "")
    .replace(/\s*(?:[\p{Extended_Pictographic}️‍]+)\s*$/u, "")
    .trim();
}

function showToast(message, options = {}) {
  const textEl = document.getElementById("toastText") || elements.toast;
  const tone = toastTone(message, options.tone);
  textEl.textContent = toastCleanText(message) || String(message ?? "");
  const toastEl = elements.toast;
  const wasOpen = toastEl.classList.contains("show");
  toastEl.dataset.tone = tone;
  // Re-dispara o "Success check": volta ao estado "out" e, no próximo
  // frame, entra de novo (fade + rotate + blur + bob + traço).
  toastEl.querySelectorAll(".toast-glyph").forEach((glyph) => {
    glyph.dataset.state = "out";
    glyph.hidden = glyph.dataset.glyph !== tone;
  });
  const glyph = toastEl.querySelector(`.toast-glyph[data-glyph="${tone}"]`);
  requestAnimationFrame(() => requestAnimationFrame(() => { if (glyph) glyph.dataset.state = "in"; }));
  if (wasOpen) {
    toastEl.classList.remove("is-bump");
    void toastEl.offsetWidth;
    toastEl.classList.add("is-bump");
  }
  let action = elements.toast.querySelector(".toast-action");
  if (options.actionLabel && typeof options.onAction === "function") {
    if (!action) {
      action = document.createElement("button");
      action.type = "button";
      action.className = "toast-action";
      elements.toast.appendChild(action);
    }
    action.textContent = options.actionLabel;
    action.hidden = false;
    action.onclick = () => {
      action.hidden = true;
      elements.toast.classList.remove("show", "is-open", "has-action");
      options.onAction();
    };
    elements.toast.classList.add("has-action");
  } else {
    if (action) action.hidden = true;
    elements.toast.classList.remove("has-action");
  }
  const duration = options.duration || (options.actionLabel ? 5000 : tone === "warn" ? 3600 : 2600);
  toastEl.style.setProperty("--toast-life", `${duration}ms`);
  const timer = toastEl.querySelector(".toast-timer");
  if (timer) { timer.style.animation = "none"; void timer.offsetWidth; timer.style.animation = ""; }
  toastEl.classList.add("show", "is-open");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toastEl.classList.remove("show", "is-open", "has-action", "is-bump"), duration);
  if (!toastEl.dataset.bound) {
    toastEl.dataset.bound = "1";
    toastEl.addEventListener("click", (event) => {
      if (event.target.closest(".toast-action")) return;
      window.clearTimeout(showToast.timer);
      toastEl.classList.remove("show", "is-open", "has-action", "is-bump");
    });
  }
}
window.PulseNoteShowToast = showToast; // ponte para notifications.js (script externo ao módulo)

function celebrate(message) {
  showToast(message);
  const burst = document.createElement("div");
  burst.className = "celebration-burst";
  burst.innerHTML = `
    <span></span><span></span><span></span><span></span><span></span><span></span>
    <div class="pulsinho">
      <div class="pulsinho__face">
        <div class="pulsinho__eyes"><span class="pulsinho__eye"></span><span class="pulsinho__eye"></span></div>
        <svg class="pulsinho__pulse" viewBox="0 0 120 26"><path d="M0,13 L28,13 L36,3 L44,23 L52,13 L64,13 L70,6 L76,20 L82,13 L120,13"/></svg>
      </div>
    </div>
  `;
  document.body.appendChild(burst);
  window.setTimeout(() => burst.remove(), 900);
}

// ============================================================
//  FINANCES MODULE
// ============================================================

function getActiveFinMonth() {
  return finActiveMonth; // formato "YYYY-MM"
}

// Retorna o label localizado do mês (ex.: "Junho 2026")
function finMonthLabel(monthKey) {
  const [year, month] = String(monthKey || "").split("-").map(Number);
  return safeFormatDate(new Date(year, (month || 1) - 1, 1), { month: "long", year: "numeric" }, monthKey || "--");
}

// Retorna true se o mês está marcado como "fechado" pelo usuário
function isMonthClosed(monthKey, workspaceId = activeWorkspaceId) {
  return (state.monthClosures || []).some((c) => c.monthKey === monthKey && (c.workspaceId || "personal") === workspaceId);
}

// Garante que lançamentos num mês fechado sejam bloqueados (UI)
function assertMonthNotClosed(monthKey) {
  if (!isMonthClosed(monthKey)) return true;
  showToast("⚠️ Este mês está fechado. Reabra-o para editar.");
  return false;
}

// Retorna a chave (AAAA-MM) do mês imediatamente anterior ao informado
function getPreviousMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 2, 1); // m-1 = mês atual (índice 0), -1 = mês anterior
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Saldo que "sobrou" do mês imediatamente anterior, para entrar automaticamente
// no mês seguinte — só entra 1x (no mês seguinte), e só se aquele mês anterior
// estiver fechado. Se não houver fechamento anterior, não soma nada.
function getCarryOverBalance(monthKey, workspaceId = activeWorkspaceId) {
  const prevKey = getPreviousMonthKey(monthKey);
  const prevClosure = (state.monthClosures || []).find((c) => c.monthKey === prevKey && (c.workspaceId || "personal") === workspaceId);
  return prevClosure ? prevClosure.saldo : 0;
}

// Registra o fechamento do mês ativo com um snapshot completo do período
function closeMonth(monthKey, { silent = false, confirmed = false } = {}) {
  if (!requireFinanceWorkspaceEdit()) return;
  if (!state.monthClosures) state.monthClosures = [];
  if (isMonthClosed(monthKey)) { showToast("Mês já fechado.", { tone: "info" }); return; }
  const entries = (state.finances || []).filter((f) => f.date.startsWith(monthKey) && (f.workspaceId || "personal") === activeWorkspaceId);
  const receitas = entries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const despesas = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);

  if (!entries.length) {
    showToast("Nenhum lançamento no período para fechar.");
    return;
  }

  // Saldo que já vinha do mês anterior (se ele estiver fechado) + o resultado
  // deste mês. É esse total acumulado que fica salvo e vai "carregar" para o
  // mês seguinte quando ele for fechado.
  const saldoAnterior = getCarryOverBalance(monthKey);
  const saldoProprio  = receitas - despesas;
  const saldoFinal    = saldoAnterior + saldoProprio;

  const detalheSaldo = saldoAnterior !== 0
    ? `Saldo do mês: ${formatCurrency(saldoProprio)}\nSaldo acumulado (com o mês anterior): ${formatCurrency(saldoFinal)}`
    : `Saldo: ${formatCurrency(saldoProprio)}`;

  // QA 18/11: o confirm() nativo passava despercebido (alguns navegadores e
  // automações o aceitam sozinho). Agora o fechamento manual abre o painel do
  // app com o resumo, e avisa quando o mês ainda está em andamento.
  if (!silent && !confirmed) {
    const current = monthKey >= todayIso.slice(0, 7);
    finActionSheet({
      title: `Fechar ${finMonthLabel(monthKey)}?`,
      sub: `${current ? "O mês ainda está em andamento. " : ""}Saldo final de ${formatCurrency(saldoFinal)} (receitas ${formatCurrency(receitas)}, despesas ${formatCurrency(despesas)}) passa para o mês seguinte. Novos lançamentos ficam bloqueados até você reabrir.`,
      actions: [
        { label: current ? "Fechar mesmo assim" : "Fechar mês", icon: "lock", run: () => closeMonth(monthKey, { confirmed: true }) },
        { label: "Cancelar", icon: "x", run: () => {} },
      ],
    });
    return;
  }

  state.monthClosures.push({
    monthKey,
    workspaceId: activeWorkspaceId,
    closedAt: new Date().toISOString(),
    receitas,
    despesas,
    saldo: saldoFinal, // acumulado — é o que entra no mês seguinte
    entriesCount: entries.length,
    automatic: silent,
  });
  finLogActivity("closure", `Fechamento mensal concluído (${finMonthShort(monthKey)})`);
  saveState();
  renderFinances();
  if (silent) showToast(`🔒 ${finMonthLabel(monthKey)} foi fechado automaticamente. Saldo final: ${formatCurrency(saldoFinal)}.`);
  else showMonthCloseRecap(monthKey, receitas, despesas, saldoFinal);
}

// Fechar o mês é um momento natural de parar e olhar pro resultado —
// em vez de só um toast, o Pulsinho reage ao saldo final (o mesmo dado
// que já vira o card "Saldo" e a barra de orçamento), dando um resumo
// rápido antes de seguir pro próximo mês.
function showMonthCloseRecap(monthKey, receitas, despesas, saldoFinal) {
  document.querySelector("#monthCloseRecap")?.remove();
  const isPositive = saldoFinal >= 0;
  const mood = isPositive ? "happy" : "worried";
  const message = isPositive
    ? `Fechou no azul! O saldo de ${formatCurrency(saldoFinal)} segue automaticamente pro próximo mês.`
    : `Fechou no vermelho — o saldo de ${formatCurrency(saldoFinal)} vai começar o próximo mês já negativo.`;

  const overlay = document.createElement("div");
  overlay.id = "monthCloseRecap";
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `
    <div class="modal-card month-close-recap">
      <div class="modal-header">
        <h2>${finMonthLabel(monthKey)} fechado ${bdIcon("lock")}</h2>
        <button class="icon-button" id="closeMonthRecap">${icon("x", 18)}</button>
      </div>
      <div class="modal-body month-close-recap-body">
        <div class="pulsinho month-close-mascot mood-${mood}">
          <div class="pulsinho__face">
            <div class="pulsinho__eyes"><span class="pulsinho__eye"></span><span class="pulsinho__eye"></span></div>
            <svg class="pulsinho__pulse" viewBox="0 0 120 26"><path d="M0,13 L28,13 L36,3 L44,23 L52,13 L64,13 L70,6 L76,20 L82,13 L120,13"/></svg>
          </div>
        </div>
        <p class="month-close-recap-message">${message}</p>
        <div class="month-close-recap-stats">
          <div><span>Receitas</span><strong class="pos">${formatCurrency(receitas)}</strong></div>
          <div><span>Despesas</span><strong class="neg">${formatCurrency(despesas)}</strong></div>
          <div><span>Saldo final</span><strong class="${isPositive ? "pos" : "neg"}">${formatCurrency(saldoFinal)}</strong></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#closeMonthRecap").addEventListener("click", () => overlay.remove());
}

// Remove o fechamento do mês (reabre para edições)
function reopenMonth(monthKey) {
  if (!requireFinanceWorkspaceEdit()) return;
  if (!isMonthClosed(monthKey)) return;
  if (!confirm(`Reabrir ${finMonthLabel(monthKey)} para edição?`)) return;
  state.monthClosures = (state.monthClosures || []).filter((c) => !(c.monthKey === monthKey && (c.workspaceId || "personal") === activeWorkspaceId));
  saveState();
  renderFinances();
  showToast(`🔓 ${finMonthLabel(monthKey)} reaberto.`);
}

// ============================================================
// EXPORTAÇÃO — XLSX nativo (sem bibliotecas externas)
//
// O XLSX é um arquivo ZIP contendo XMLs no padrão OOXML. Geramos
// toda a estrutura aqui no navegador usando apenas APIs nativas
// (TextEncoder + Uint8Array) — sem SheetJS, sem CDN, sem servidor.
//
// Estrutura gerada:
//   [Content_Types].xml
//   _rels/.rels
//   xl/workbook.xml          (lista as 3 abas)
//   xl/_rels/workbook.xml.rels
//   xl/styles.xml            (7 estilos: header, receita, despesa,
//                             total, número, bold, default)
//   xl/sharedStrings.xml     (todas as strings únicas → índice)
//   xl/worksheets/sheet1.xml (Resumo)
//   xl/worksheets/sheet2.xml (Lançamentos)
//   xl/worksheets/sheet3.xml (Por Categoria)
// ============================================================

function buildXlsxBlob(monthKey) {
  const entries = (state.finances || [])
    .filter((f) => f.date.startsWith(monthKey) && (f.workspaceId || "personal") === activeWorkspaceId)
    .sort((a, b) => a.date.localeCompare(b.date));

  const label    = finMonthLabel(monthKey);
  const isClosed = isMonthClosed(monthKey);
  const receitas = entries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const despesas = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
  const saldo    = receitas - despesas;
  const geradoEm = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date());

  // Distribuição por categoria (despesas)
  const byCat = {};
  entries.filter((f) => f.type === "despesa").forEach((f) => {
    const cat = findCategory(f.category);
    if (!byCat[f.category]) byCat[f.category] = { label: cat.label.replace(/^\S+\s*/, ""), total: 0 };
    byCat[f.category].total += f.amount;
  });
  const catList = Object.values(byCat).sort((a, b) => b.total - a.total);

  // ── Shared strings (todas as strings são centralizadas aqui) ──
  const strIndex = new Map();
  const strings  = [];
  function s(str) {
    const k = String(str ?? "");
    if (!strIndex.has(k)) { strIndex.set(k, strings.length); strings.push(k); }
    return strIndex.get(k);
  }

  // Pre-warm strings usadas em múltiplos lugares
  s(""); s("Relatório Financeiro"); s(label); s("Status"); s("Fechado"); s("Aberto");
  s("Receitas"); s("Despesas"); s("Saldo"); s("Total de lançamentos"); s("Gerado em"); s(geradoEm);
  s("Data"); s("Descrição"); s("Categoria"); s("Tipo"); s("Valor (R$)");
  s("Receita"); s("Despesa");
  catList.forEach((c) => s(c.label));
  entries.forEach((f) => {
    s(formatDate(f.date));
    s(f.description || "");
    s(findCategory(f.category).label.replace(/^\S+\s*/, ""));
  });

  // ── Helpers para gerar o XML das células ──────────────────────
  // Índices de estilo (xl/styles.xml define nessa ordem exata):
  // 0 = default, 1 = header (bold, fundo azul), 2 = receita (verde),
  // 3 = despesa (vermelho), 4 = saldo (azul bold), 5 = número padrão,
  // 6 = número moeda BR
  const ST = { def: 0, hdr: 1, rec: 2, desp: 3, saldo: 4, num: 5, brl: 6, bold: 7 };

  function colRef(c) {
    // c = índice de coluna 0-based → letra(s) A, B, …, Z, AA, …
    let s2 = "";
    let n = c + 1;
    while (n > 0) { s2 = String.fromCharCode(64 + (n - 1) % 26 + 1) + s2; n = Math.floor((n - 1) / 26); }
    return s2;
  }

  // Célula de string compartilhada (tipo="s")
  function cs(col, row, strIdx, style = ST.def) {
    return `<c r="${colRef(col)}${row}" t="s" s="${style}"><v>${strIdx}</v></c>`;
  }
  // Célula de número
  function cn(col, row, value, style = ST.num) {
    return `<c r="${colRef(col)}${row}" s="${style}"><v>${value}</v></c>`;
  }
  // Célula de moeda (BRL)
  function cbrl(col, row, value, style = ST.brl) {
    return cn(col, row, value, style);
  }

  // ── Aba 1: Resumo ──────────────────────────────────────────────
  const sheet1Rows = [
    // Linha 1: Título
    `<row r="1">${cs(0,1,s("Relatório Financeiro"),ST.hdr)}${cs(1,1,s(label),ST.hdr)}</row>`,
    // Linha 2: Status
    `<row r="2">${cs(0,2,s("Status"),ST.bold)}${cs(1,2,s(isClosed ? "Fechado" : "Aberto"),isClosed ? ST.rec : ST.def)}</row>`,
    // Linha 3: Gerado em
    `<row r="3">${cs(0,3,s("Gerado em"),ST.bold)}${cs(1,3,s(geradoEm))}</row>`,
    // Linha 5: Totais
    `<row r="5">${cs(0,5,s("Receitas"),ST.hdr)}${cbrl(1,5,receitas,ST.rec)}</row>`,
    `<row r="6">${cs(0,6,s("Despesas"),ST.hdr)}${cbrl(1,6,despesas,ST.desp)}</row>`,
    `<row r="7">${cs(0,7,s("Saldo"),ST.hdr)}${cbrl(1,7,saldo,saldo >= 0 ? ST.rec : ST.desp)}</row>`,
    `<row r="8">${cs(0,8,s("Total de lançamentos"),ST.bold)}${cn(1,8,entries.length,ST.num)}</row>`,
  ];

  // ── Aba 2: Lançamentos ─────────────────────────────────────────
  const sheet2Rows = [
    `<row r="1">${cs(0,1,s("Data"),ST.hdr)}${cs(1,1,s("Descrição"),ST.hdr)}${cs(2,1,s("Categoria"),ST.hdr)}${cs(3,1,s("Tipo"),ST.hdr)}${cs(4,1,s("Valor (R$)"),ST.hdr)}</row>`,
    ...entries.map((f, i) => {
      const r = i + 2;
      const isRec = f.type === "receita";
      const valStyle = isRec ? ST.rec : ST.desp;
      const signedAmt = isRec ? f.amount : -f.amount;
      return `<row r="${r}">${cs(0,r,s(formatDate(f.date)))}${cs(1,r,s(f.description||""))}${cs(2,r,s(findCategory(f.category).label.replace(/^\S+\s*/, "")))}${cs(3,r,s(isRec ? "Receita" : "Despesa"),isRec ? ST.rec : ST.desp)}${cbrl(4,r,signedAmt,valStyle)}</row>`;
    }),
    // Linha de total
    (() => {
      const r = entries.length + 3;
      return `<row r="${r}">${cs(0,r,s("TOTAL"),ST.hdr)}${cs(1,r,s(""))}${cs(2,r,s(""))}${cs(3,r,s(""))}${cbrl(4,r,receitas-despesas,saldo>=0 ? ST.rec : ST.desp)}</row>`;
    })(),
  ];

  // ── Aba 3: Por Categoria ───────────────────────────────────────
  const sheet3Rows = [
    `<row r="1">${cs(0,1,s("Categoria"),ST.hdr)}${cs(1,1,s("Valor (R$)"),ST.hdr)}${cs(2,1,s("% das Despesas"),ST.hdr)}</row>`,
    ...catList.map((c, i) => {
      const r = i + 2;
      const pct = despesas > 0 ? Math.round((c.total / despesas) * 1000) / 10 : 0;
      return `<row r="${r}">${cs(0,r,s(c.label))}${cbrl(1,r,c.total,ST.desp)}${cn(2,r,pct,ST.num)}</row>`;
    }),
  ];

  // ── Shared strings XML ────────────────────────────────────────
  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map((str) => `<si><t xml:space="preserve">${str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</t></si>`).join("")}
</sst>`;

  // ── Styles ────────────────────────────────────────────────────
  // numFmtId 164 = "#,##0.00" (BR: precisamos substituir pontos/vírgulas
  // depois, mas no XLSX o separador depende das configurações locais do
  // Excel, então definimos o formato ISO como reserva e o Excel adapta)
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="3">
  <font><sz val="11"/><name val="Calibri"/><color rgb="FF1A1F2E"/></font>
  <font><sz val="11"/><b/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
  <font><sz val="11"/><b/><name val="Calibri"/><color rgb="FF1A1F2E"/></font>
</fonts>
<fills count="7">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF2C5282"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF1A4731"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF7B1D16"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF1E3A5F"/></patternFill></fill>
  <fill><patternFill patternType="none"/></fill>
</fills>
<borders count="2">
  <border/>
  <border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  <xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
  <xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
  <xf numFmtId="164" fontId="1" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/>
  <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function makeSheetXml(rows) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rows.join("")}</sheetData>
</worksheet>`;
  }

  // ── Montar o ZIP (OOXML = ZIP de XMLs) ───────────────────────
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Resumo" sheetId="1" r:id="rId1"/>
<sheet name="Lançamentos" sheetId="2" r:id="rId2"/>
<sheet name="Por Categoria" sheetId="3" r:id="rId3"/>
</sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
    "xl/styles.xml": stylesXml,
    "xl/sharedStrings.xml": ssXml,
    "xl/worksheets/sheet1.xml": makeSheetXml(sheet1Rows),
    "xl/worksheets/sheet2.xml": makeSheetXml(sheet2Rows),
    "xl/worksheets/sheet3.xml": makeSheetXml(sheet3Rows),
  };

  return zipFiles(files);
}

// Baixa o .xlsx gerado por buildXlsxBlob() — a função em si já existia
// (montava o arquivo certinho), só faltava um botão chamando ela e
// disparando o download de verdade no navegador.
function downloadXlsxReport(monthKey) {
  const blob = buildXlsxBlob(monthKey);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `relatorio-${monthKey}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast("📊 Excel baixado!");
}

// ── Gerador de ZIP puro em JS (sem pako/JSZip) ───────────────
// Implementação mínima do formato ZIP (RFC 1952 / PKZIP) suficiente
// para gerar OOXML válido: compressão STORED (método 0, sem deflate)
// — o Excel aceita ZIPs sem compressão perfeitamente e não precisamos
// de uma lib externa para deflate.
function zipFiles(filesObj) {
  const enc = new TextEncoder();

  function u32le(n) { return [(n)&0xff,(n>>8)&0xff,(n>>16)&0xff,(n>>24)&0xff]; }
  function u16le(n) { return [(n)&0xff,(n>>8)&0xff]; }

  function crc32(data) {
    let crc = 0xffffffff;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c;
      }
      return t;
    })());
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  const parts    = [];
  const central  = [];
  let   offset   = 0;

  for (const [name, content] of Object.entries(filesObj)) {
    const nameBytes = enc.encode(name);
    const dataBytes = typeof content === "string" ? enc.encode(content) : content;
    const crc       = crc32(dataBytes);
    const size      = dataBytes.length;

    const lhdr = [
      0x50,0x4b,0x03,0x04,  // Local file header signature
      ...u16le(20),          // Version needed (2.0)
      ...u16le(0),           // Flags
      ...u16le(0),           // Compression method: STORED
      ...u16le(0),           // Last mod time
      ...u16le(0),           // Last mod date
      ...u32le(crc),
      ...u32le(size),        // Compressed size
      ...u32le(size),        // Uncompressed size
      ...u16le(nameBytes.length),
      ...u16le(0),           // Extra field length
      ...nameBytes,
    ];

    parts.push(new Uint8Array(lhdr));
    parts.push(dataBytes);

    central.push({ nameBytes, crc, size, offset });
    offset += lhdr.length + size;
  }

  const cdStart = offset;
  for (const e of central) {
    const cd = [
      0x50,0x4b,0x01,0x02, // Central dir signature
      ...u16le(20),         // Version made by
      ...u16le(20),         // Version needed
      ...u16le(0),          // Flags
      ...u16le(0),          // Compression: STORED
      ...u16le(0),          // Mod time
      ...u16le(0),          // Mod date
      ...u32le(e.crc),
      ...u32le(e.size),
      ...u32le(e.size),
      ...u16le(e.nameBytes.length),
      ...u16le(0),          // Extra
      ...u16le(0),          // Comment
      ...u16le(0),          // Disk start
      ...u16le(0),          // Internal attrs
      ...u32le(0),          // External attrs
      ...u32le(e.offset),
      ...e.nameBytes,
    ];
    parts.push(new Uint8Array(cd));
    offset += cd.length;
  }

  const cdSize = offset - cdStart;
  const eocd = [
    0x50,0x4b,0x05,0x06,  // End of central dir
    ...u16le(0),           // Disk number
    ...u16le(0),           // Disk w/ central dir
    ...u16le(central.length),
    ...u16le(central.length),
    ...u32le(cdSize),
    ...u32le(cdStart),
    ...u16le(0),           // Comment length
  ];
  parts.push(new Uint8Array(eocd));

  const total = parts.reduce((s, p) => s + p.length, 0);
  const buf   = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { buf.set(p, pos); pos += p.length; }
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// ── Ponto de entrada do botão Exportar ───────────────────────
// Relatório mensal em HTML pensado para "Salvar como PDF": A4, tipografia
// limpa, KPIs com comparação ao mês anterior, leitura rápida ("Destaques"),
// gráficos em SVG e tabelas que não quebram no meio entre páginas.
function exportMonthReport(monthKey) {
  const inWs = (f) => (f.workspaceId || "personal") === activeWorkspaceId;
  const entries = (state.finances || []).filter((f) => f.date.startsWith(monthKey) && inWs(f))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) {
    showToast("Nenhum lançamento no período para exportar.");
    return;
  }

  const esc = escapeHtml;
  const money = (v) => formatCurrency(v);
  const label    = finMonthLabel(monthKey);
  const isClosed = isMonthClosed(monthKey);
  const ownerName = (getUser()?.name || "Usuário").split(" ").slice(0, 2).join(" ");
  const geradoEm = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date());

  const sum = (list, type) => list.filter((f) => f.type === type).reduce((s, f) => s + Number(f.amount || 0), 0);
  const receitas = sum(entries, "receita");
  const despesas = sum(entries, "despesa");
  const saldo    = receitas - despesas;
  const savingsPct = receitas > 0 ? (saldo / receitas) * 100 : 0;
  const usedPct  = receitas > 0 ? Math.min(100, Math.round((despesas / receitas) * 100)) : (despesas > 0 ? 100 : 0);

  // Histórico de 6 meses (gráfico) — o 5º item é o mês anterior.
  const months6 = [];
  const [ay, am] = monthKey.split("-").map(Number);
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(ay, am - 1 - i, 1);
    const mk = toLocalIso(d).slice(0, 7);
    const me = (state.finances || []).filter((f) => f.date.startsWith(mk) && inWs(f));
    months6.push({ mk, lbl: safeFormatDate(d, { month: "short" }, "-").replace(".", ""), r: sum(me, "receita"), d: sum(me, "despesa") });
  }
  const prev = months6[4];
  const hasPrev = prev.r > 0 || prev.d > 0;
  const delta = (now, before, goodWhenUp) => {
    if (!hasPrev || !before) return "";
    const pct = ((now - before) / Math.abs(before)) * 100;
    if (Math.abs(pct) < 0.5) return `<span class="kpi-delta">igual ao mês anterior</span>`;
    const up = pct > 0;
    const good = goodWhenUp ? up : !up;
    return `<span class="kpi-delta ${good ? "is-good" : "is-bad"}">${up ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}% vs ${esc(prev.lbl)}</span>`;
  };

  // Despesas por categoria
  const byCat = {};
  entries.filter((f) => f.type === "despesa").forEach((f) => {
    const cat = findCategory(f.category);
    if (!byCat[f.category]) byCat[f.category] = { id: f.category, label: finCatName(f.category), color: cat.color || "#8a9bb0", total: 0, count: 0 };
    byCat[f.category].total += Number(f.amount || 0);
    byCat[f.category].count += 1;
  });
  const catList = Object.values(byCat).sort((a, b) => b.total - a.total);
  const topTx = entries.filter((f) => f.type === "despesa").sort((a, b) => b.amount - a.amount).slice(0, 5);

  // Destaques (leitura rápida do mês)
  const now = new Date();
  const daysInMonth = new Date(ay, am, 0).getDate();
  const isCurrent = ay === now.getFullYear() && am === now.getMonth() + 1;
  const daysElapsed = isCurrent ? Math.max(1, now.getDate()) : daysInMonth;
  const dailyAvg = despesas / daysElapsed;
  const byDay = {};
  entries.filter((f) => f.type === "despesa").forEach((f) => { byDay[f.date] = (byDay[f.date] || 0) + Number(f.amount || 0); });
  const peakDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const insights = [];
  if (catList[0] && despesas > 0) insights.push({ t: "Maior categoria", v: catList[0].label, s: `${money(catList[0].total)} · ${((catList[0].total / despesas) * 100).toFixed(0)}% das despesas` });
  if (despesas > 0) insights.push({ t: "Gasto médio por dia", v: money(dailyAvg), s: isCurrent ? `em ${daysElapsed} dias até hoje` : `em ${daysInMonth} dias` });
  if (peakDay) insights.push({ t: "Dia de maior gasto", v: formatDate(peakDay[0]), s: money(peakDay[1]) });
  if (hasPrev && prev.d > 0) {
    const diff = despesas - prev.d;
    insights.push({ t: "Despesas vs mês anterior", v: `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${money(Math.abs(diff))}`, s: diff > 0 ? "gastou mais que no mês anterior" : diff < 0 ? "gastou menos que no mês anterior" : "mesmo valor do mês anterior", tone: diff > 0 ? "bad" : "good" });
  } else {
    insights.push({ t: "Lançamentos", v: String(entries.length), s: `${entries.filter((f) => f.type === "receita").length} receitas · ${entries.filter((f) => f.type === "despesa").length} despesas` });
  }

  // Gráfico de 6 meses: barras agrupadas com linhas de grade.
  const maxVal = Math.max(...months6.flatMap((m) => [m.r, m.d]), 1);
  // Escala "redonda" em 4 faixas (ex.: 2,5 mil · 5 mil · 7,5 mil · 10 mil).
  const niceMax = (() => {
    const raw = maxVal / 4;
    const p = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].find((m) => m * p >= raw) * p * 4;
  })();
  const cW = 560; const cH = 190; const left = 54; const top = 12; const bottom = 26;
  const plotH = cH - top - bottom; const plotW = cW - left - 8;
  const slot = plotW / months6.length; const bw = Math.min(26, slot * 0.28);
  const y = (v) => top + plotH - (v / niceMax) * plotH;
  const short = (v) => (v >= 1000 ? `${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil` : Math.round(v).toLocaleString("pt-BR"));
  const grid = [0, 0.25, 0.5, 0.75, 1].map((k) => {
    const gy = y(niceMax * k);
    return `<line x1="${left}" x2="${cW - 8}" y1="${gy}" y2="${gy}" stroke="#e7e9f2" stroke-width="1"${k ? ' stroke-dasharray="3 4"' : ""}/>
      <text x="${left - 8}" y="${gy + 3}" text-anchor="end" font-size="9" fill="#8b90a7">${short(niceMax * k)}</text>`;
  }).join("");
  const bars = months6.map((m, i) => {
    const cx = left + slot * i + slot / 2;
    const act = m.mk === monthKey;
    const rH = Math.max(m.r ? 2 : 0, y(0) - y(m.r));
    const dH = Math.max(m.d ? 2 : 0, y(0) - y(m.d));
    return `${act ? `<rect x="${cx - slot / 2 + 4}" y="${top}" width="${slot - 8}" height="${plotH}" rx="8" fill="#f3f1ff"/>` : ""}
      <rect x="${cx - bw - 2}" y="${y(0) - rH}" width="${bw}" height="${rH}" rx="4" fill="${act ? "#10b981" : "#a7e8cf"}"/>
      <rect x="${cx + 2}" y="${y(0) - dH}" width="${bw}" height="${dH}" rx="4" fill="${act ? "#f43f5e" : "#fbc2cd"}"/>
      <text x="${cx}" y="${cH - 8}" text-anchor="middle" font-size="10" font-weight="${act ? 700 : 500}" fill="${act ? "#4338ca" : "#8b90a7"}">${esc(m.lbl)}</text>`;
  }).join("");
  const svgNs = ["http:", "", "www.w3.org", "2000", "svg"].join("/");
  const chartSvg = `<svg viewBox="0 0 ${cW} ${cH}" xmlns="${svgNs}" role="img" aria-label="Receitas e despesas dos últimos 6 meses">${grid}${bars}</svg>`;

  // Rosca de categorias (com respiro entre fatias).
  let donutSvg = "";
  if (catList.length && despesas > 0) {
    const R = 62; const C = 2 * Math.PI * R;
    let acc = 0;
    const segs = catList.slice(0, 7).map((c) => {
      const len = (c.total / despesas) * C;
      const seg = `<circle r="${R}" cx="80" cy="80" fill="none" stroke="${c.color}" stroke-width="20" stroke-dasharray="${Math.max(0, len - 2)} ${C}" stroke-dashoffset="${-acc}" transform="rotate(-90 80 80)"/>`;
      acc += len;
      return seg;
    }).join("");
    const rest = catList.slice(7).reduce((s, c) => s + c.total, 0);
    const restSeg = rest > 0 ? `<circle r="${R}" cx="80" cy="80" fill="none" stroke="#cbd0e0" stroke-width="20" stroke-dasharray="${Math.max(0, (rest / despesas) * C - 2)} ${C}" stroke-dashoffset="${-acc}" transform="rotate(-90 80 80)"/>` : "";
    donutSvg = `<svg viewBox="0 0 160 160" xmlns="${svgNs}" role="img" aria-label="Despesas por categoria">
      <circle r="${R}" cx="80" cy="80" fill="none" stroke="#f1f2f8" stroke-width="20"/>${segs}${restSeg}
      <text x="80" y="74" text-anchor="middle" font-size="9.5" fill="#8b90a7" letter-spacing=".06em">DESPESAS</text>
      <text x="80" y="92" text-anchor="middle" font-size="14" font-weight="800" fill="#141729">${esc(money(despesas))}</text></svg>`;
  }

  const recurrents = (state.finRecurrents || []).filter((r) => r.type === "despesa" && inWs(r));
  const recurTotal = recurrents.reduce((s, r) => s + Number(r.amount || 0), 0);
  const goals = (state.finGoals || []).filter(inWs).map((g) => {
    const spent = byCat[g.categoryId]?.total || 0;
    const pct = g.limit > 0 ? Math.round((spent / g.limit) * 100) : 0;
    return { ...g, name: finCatName(g.categoryId), color: findCategory(g.categoryId).color || "#6c5ce7", spent, pct };
  });

  const txRow = (f) => {
    const isRec = f.type === "receita";
    const cat = findCategory(f.category);
    return `<tr>
      <td class="c-date">${esc(formatDate(f.date))}</td>
      <td class="c-desc">${esc(f.description || "Sem descrição")}</td>
      <td class="c-cat"><span class="dot" style="background:${esc(cat.color || "#8a9bb0")}"></span>${esc(finCatName(f.category))}</td>
      <td class="c-val ${isRec ? "is-in" : "is-out"}">${isRec ? "+" : "−"} ${esc(money(f.amount))}</td>
    </tr>`;
  };

  const logo = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12 2.5-6H21"/></svg>`;

  const htmlContent = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PulseNote · Relatório financeiro · ${esc(label)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--ink:#141729;--ink-2:#4a5068;--ink-3:#8b90a7;--line:#e7e9f2;--soft:#f6f7fb;--brand:#5b4ff5;--in:#059669;--out:#e11d48}
  html{background:#eceef5}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI Variable','Segoe UI',Roboto,sans-serif;color:var(--ink);font-size:12.5px;line-height:1.5;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
  .sheet{max-width:860px;margin:24px auto 48px;background:#fff;border-radius:18px;box-shadow:0 24px 60px -30px rgba(20,23,41,.35);overflow:hidden}
  /* Barra de ações (só na tela) */
  .actions{position:sticky;top:0;z-index:5;display:flex;justify-content:center;gap:8px;padding:12px;background:rgba(236,238,245,.86);backdrop-filter:blur(10px)}
  .actions button{font:inherit;font-weight:600;font-size:13px;border:0;border-radius:999px;padding:9px 18px;cursor:pointer}
  .btn-primary{background:var(--brand);color:#fff;box-shadow:0 8px 18px -10px rgba(91,79,245,.9)}
  .btn-ghost{background:#fff;color:var(--ink-2);box-shadow:inset 0 0 0 1px var(--line)}
  /* Capa */
  .cover{position:relative;padding:32px 40px 28px;color:#fff;background:radial-gradient(120% 140% at 100% 0%,#22d3ee33 0%,transparent 45%),linear-gradient(135deg,#1b1840 0%,#2b2470 55%,#4c35c9 100%)}
  .cover-top{display:flex;justify-content:space-between;align-items:center;gap:16px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:15px;letter-spacing:-.01em}
  .brand-mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(145deg,#7c6cff,#c07dff);box-shadow:0 6px 16px -6px rgba(124,108,255,.9)}
  .status{font-size:11px;font-weight:600;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22)}
  .status.is-closed{background:rgba(16,185,129,.2);border-color:rgba(16,185,129,.45)}
  .cover h1{margin-top:26px;font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.03em}
  .cover h1::first-letter{text-transform:uppercase}
  .cover p{margin-top:6px;font-size:12.5px;color:rgba(255,255,255,.72)}
  .cover-meter{margin-top:22px;display:grid;gap:7px}
  .cover-meter .row{display:flex;justify-content:space-between;gap:12px;font-size:11.5px;color:rgba(255,255,255,.78)}
  .cover-meter .row b{color:#fff}
  .meter{height:8px;border-radius:999px;background:rgba(255,255,255,.14);overflow:hidden}
  .meter i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#34d399,#22d3ee)}
  .meter.is-warn i{background:linear-gradient(90deg,#fbbf24,#fb7185)}
  /* KPIs */
  .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:22px 40px 6px}
  .kpi{border:1px solid var(--line);border-radius:14px;padding:13px 14px;background:#fff;min-width:0}
  .kpi-lbl{display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3)}
  .kpi-lbl i{width:8px;height:8px;border-radius:3px}
  .kpi-lbl.is-in i{background:var(--in)}.kpi-lbl.is-out i{background:var(--out)}.kpi-lbl.is-brand i{background:var(--brand)}
  .kpi-lbl.is-in,.kpi-lbl.is-out,.kpi-lbl.is-brand{color:var(--ink-3)}
  .kpi-val{margin-top:6px;font-size:19px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .kpi-delta{display:block;margin-top:3px;font-size:10.5px;font-weight:600;color:var(--ink-3)}
  .kpi-delta.is-good{color:var(--in)}.kpi-delta.is-bad{color:var(--out)}
  .is-in{color:var(--in)}.is-out{color:var(--out)}.is-brand{color:var(--brand)}
  /* Seções */
  section{padding:22px 40px 4px;break-inside:avoid}
  section.flow{break-inside:auto}
  .sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px;break-after:avoid}
  h2{font-size:14px;font-weight:750;letter-spacing:-.01em}
  .sec-head span{font-size:11px;color:var(--ink-3)}
  .card{border:1px solid var(--line);border-radius:16px;padding:16px 18px;background:#fff}
  /* Destaques */
  .insights{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .insight{border-radius:14px;padding:12px 14px;background:var(--soft);min-width:0}
  .insight small{display:block;font-size:10.5px;font-weight:600;color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em}
  .insight strong{display:block;margin-top:5px;font-size:14px;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .insight span{display:block;margin-top:2px;font-size:11px;color:var(--ink-2)}
  .insight.is-bad strong{color:var(--out)}.insight.is-good strong{color:var(--in)}
  /* Gráfico */
  .chart svg{display:block;width:100%;height:auto}
  .legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:8px;font-size:11px;color:var(--ink-2)}
  .legend span{display:inline-flex;align-items:center;gap:6px}
  .legend i{width:10px;height:10px;border-radius:3px}
  /* Categorias */
  .cats{display:grid;grid-template-columns:170px minmax(0,1fr);gap:22px;align-items:center}
  .cats svg{width:170px;height:170px;display:block}
  .cat-row{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(60px,1fr) 44px 92px;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid var(--soft)}
  .cat-row:last-child{border-bottom:0}
  .cat-name{display:flex;align-items:center;gap:8px;font-weight:600;min-width:0}
  .cat-name b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cat-name small{font-weight:500;color:var(--ink-3);font-size:10.5px;white-space:nowrap}
  .dot{display:inline-block;width:9px;height:9px;border-radius:3px;flex:none;margin-right:7px;vertical-align:middle}
  .cat-name .dot{margin:0}
  .bar{display:block;height:6px;border-radius:999px;background:var(--soft);overflow:hidden}
  .bar i{display:block;height:100%;border-radius:inherit}
  .cat-pct{text-align:right;color:var(--ink-3);font-size:11.5px}
  .cat-val{text-align:right;font-weight:700}
  /* Limites */
  .goal{display:grid;gap:6px;padding:8px 0}
  .goal + .goal{border-top:1px solid var(--soft)}
  .goal-top{display:flex;justify-content:space-between;gap:12px;font-size:12px}
  .goal-top b{font-weight:600}
  .goal-top span{color:var(--ink-3);white-space:nowrap}
  .goal-top span.over{color:var(--out);font-weight:700}
  /* Tabelas */
  table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
  thead{display:table-header-group}
  th{padding:9px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3);background:var(--soft)}
  th:first-child{border-radius:10px 0 0 10px}th:last-child{border-radius:0 10px 10px 0;text-align:right}
  td{padding:9px 12px;border-bottom:1px solid var(--soft);vertical-align:middle}
  tr{break-inside:avoid}
  tbody tr:last-child td{border-bottom:0}
  .c-date{white-space:nowrap;color:var(--ink-2);width:92px}
  .c-desc{font-weight:600;max-width:290px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .c-cat{white-space:nowrap;color:var(--ink-2)}
  .c-val{text-align:right;font-weight:700;white-space:nowrap}
  tfoot td{padding-top:12px;font-weight:700;border-top:1.5px solid var(--line);border-bottom:0}
  /* Recorrentes */
  .recur{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .recur div{border:1px solid var(--line);border-radius:12px;padding:11px 13px;min-width:0}
  .recur strong{display:block;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .recur span{display:block;font-size:11px;color:var(--ink-3)}
  .recur em{display:block;margin-top:4px;font-style:normal;font-weight:750;color:var(--out)}
  /* Rodapé */
  .foot{margin-top:24px;padding:16px 40px 26px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:10.5px;color:var(--ink-3);border-top:1px solid var(--line)}
  .foot b{color:var(--ink-2)}
  @media (max-width:720px){
    .sheet{margin:0;border-radius:0}
    .cover,.kpis,section,.foot{padding-left:18px;padding-right:18px}
    .kpis,.insights{grid-template-columns:repeat(2,minmax(0,1fr))}
    .cats{grid-template-columns:1fr;justify-items:center}
    .cats > div{width:100%}
    .cats > div:first-child{display:grid;place-items:center}
    .cat-row{grid-template-columns:minmax(0,1fr) 40px 86px}
    .cat-row .bar{display:none}
    .recur{grid-template-columns:repeat(2,minmax(0,1fr))}
    .c-cat{display:none}
    .c-desc{max-width:150px}
  }
  @page{size:A4;margin:12mm 11mm 14mm}
  @page{@bottom-right{content:"Página " counter(page) " de " counter(pages);font-size:9px;color:#8b90a7}}
  @media print{
    html{background:#fff}
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact;font-size:11.5px}
    .actions{display:none}
    .sheet{margin:0;max-width:none;border-radius:0;box-shadow:none;overflow:visible}
    .cover{border-radius:14px}
    .kpis,section,.foot{padding-left:2px;padding-right:2px}
    .kpis,.insights{grid-template-columns:repeat(4,minmax(0,1fr))}
    .cats{grid-template-columns:170px minmax(0,1fr);justify-items:stretch}
    .cat-row{grid-template-columns:minmax(0,1.3fr) minmax(60px,1fr) 44px 92px}
    .cat-row .bar{display:block}
    .c-cat{display:table-cell}
    .c-desc{max-width:290px}
  }
</style>
</head>
<body>
<div class="actions">
  <button class="btn-primary" type="button" onclick="window.print()">Salvar como PDF</button>
  <button class="btn-ghost" type="button" onclick="window.close()">Fechar</button>
</div>
<main class="sheet">
  <header class="cover">
    <div class="cover-top">
      <div class="brand"><span class="brand-mark">${logo}</span>PulseNote</div>
      <span class="status${isClosed ? " is-closed" : ""}">${isClosed ? "Mês fechado" : "Mês em aberto"}</span>
    </div>
    <h1>${esc(label)}</h1>
    <p>Relatório financeiro de ${esc(ownerName)} · ${entries.length} ${entries.length === 1 ? "lançamento" : "lançamentos"}</p>
    <div class="cover-meter">
      <div class="row"><span>Da renda do mês, você usou <b>${usedPct}%</b></span><span>${esc(money(despesas))} de ${esc(money(receitas))}</span></div>
      <div class="meter${usedPct >= 90 ? " is-warn" : ""}"><i style="width:${usedPct}%"></i></div>
    </div>
  </header>

  <div class="kpis">
    <div class="kpi"><div class="kpi-lbl is-in"><i></i>Receitas</div><div class="kpi-val is-in">${esc(money(receitas))}</div>${delta(receitas, prev.r, true)}</div>
    <div class="kpi"><div class="kpi-lbl is-out"><i></i>Despesas</div><div class="kpi-val is-out">${esc(money(despesas))}</div>${delta(despesas, prev.d, false)}</div>
    <div class="kpi"><div class="kpi-lbl is-brand"><i></i>Saldo</div><div class="kpi-val ${saldo >= 0 ? "" : "is-out"}">${esc(money(saldo))}</div>${hasPrev ? `<span class="kpi-delta">${esc(prev.lbl)}: ${esc(money(prev.r - prev.d))}</span>` : ""}</div>
    <div class="kpi"><div class="kpi-lbl is-brand"><i></i>Poupança</div><div class="kpi-val ${savingsPct >= 0 ? "is-brand" : "is-out"}">${savingsPct.toFixed(1).replace(".", ",")}%</div><span class="kpi-delta">da renda guardada</span></div>
  </div>

  <section>
    <div class="sec-head"><h2>Destaques do mês</h2></div>
    <div class="insights">
      ${insights.slice(0, 4).map((it) => `<div class="insight${it.tone ? ` is-${it.tone}` : ""}"><small>${esc(it.t)}</small><strong>${esc(it.v)}</strong><span>${esc(it.s)}</span></div>`).join("")}
    </div>
  </section>

  <section>
    <div class="sec-head"><h2>Receitas e despesas</h2><span>últimos 6 meses</span></div>
    <div class="card chart">${chartSvg}
      <div class="legend"><span><i style="background:#10b981"></i>Receitas</span><span><i style="background:#f43f5e"></i>Despesas</span><span><i style="background:#f3f1ff;box-shadow:inset 0 0 0 1px #d9d4ff"></i>Mês do relatório</span></div>
    </div>
  </section>

  ${catList.length ? `
  <section>
    <div class="sec-head"><h2>Para onde foi o dinheiro</h2><span>${catList.length} ${catList.length === 1 ? "categoria" : "categorias"}</span></div>
    <div class="card cats">
      <div>${donutSvg}</div>
      <div>
        ${catList.slice(0, 10).map((c) => {
          const pct = despesas > 0 ? (c.total / despesas) * 100 : 0;
          return `<div class="cat-row">
            <span class="cat-name"><span class="dot" style="background:${esc(c.color)}"></span><b>${esc(c.label)}</b><small>${c.count}×</small></span>
            <span class="bar"><i style="width:${Math.max(2, Math.round(pct))}%;background:${esc(c.color)}"></i></span>
            <span class="cat-pct">${pct.toFixed(0)}%</span>
            <span class="cat-val">${esc(money(c.total))}</span>
          </div>`;
        }).join("")}
      </div>
    </div>
  </section>` : ""}

  ${goals.length ? `
  <section>
    <div class="sec-head"><h2>Limites por categoria</h2><span>${goals.filter((g) => g.pct > 100).length} acima do limite</span></div>
    <div class="card">
      ${goals.map((g) => {
        const color = g.pct > 100 ? "#e11d48" : g.pct > 80 ? "#f59e0b" : "#10b981";
        return `<div class="goal">
          <div class="goal-top"><b><span class="dot" style="background:${esc(g.color)}"></span>${esc(g.name)}</b><span class="${g.pct > 100 ? "over" : ""}">${esc(money(g.spent))} de ${esc(money(g.limit))} · ${g.pct}%</span></div>
          <div class="bar"><i style="width:${Math.min(100, g.pct)}%;background:${color}"></i></div>
        </div>`;
      }).join("")}
    </div>
  </section>` : ""}

  ${topTx.length ? `
  <section>
    <div class="sec-head"><h2>Maiores despesas</h2><span>top ${topTx.length}</span></div>
    <div class="card"><table>
      <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Valor</th></tr></thead>
      <tbody>${topTx.map(txRow).join("")}</tbody>
    </table></div>
  </section>` : ""}

  <section class="flow">
    <div class="sec-head"><h2>Todos os lançamentos</h2><span>${entries.length} no mês</span></div>
    <div class="card"><table>
      <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Valor</th></tr></thead>
      <tbody>${entries.map(txRow).join("")}</tbody>
      <tfoot><tr><td colspan="3">Saldo do mês</td><td class="c-val ${saldo >= 0 ? "is-in" : "is-out"}">${esc(money(saldo))}</td></tr></tfoot>
    </table></div>
  </section>

  ${recurrents.length ? `
  <section>
    <div class="sec-head"><h2>Contas recorrentes</h2><span>${esc(money(recurTotal))} por mês</span></div>
    <div class="recur">
      ${recurrents.map((r) => `<div><strong>${esc(r.description || "Recorrente")}</strong><span>${esc(finCatName(r.categoryId))} · todo dia ${esc(String(r.day || "-"))}</span><em>${esc(money(r.amount))}</em></div>`).join("")}
    </div>
  </section>` : ""}

  <footer class="foot">
    <span><b>PulseNote</b> · Relatório gerado em ${esc(geradoEm)}</span>
    <span>${activeWorkspaceId === "personal" ? "Espaço pessoal" : "Espaço compartilhado"} · ${esc(label)}</span>
  </footer>
</main>
<script>
  // Abre a janela de impressão já com a página pronta. O botão
  // "Salvar como PDF" repete a ação.
  window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });
</script>
</body>
</html>`;

  const blob = new Blob([htmlContent], { type: "text/html" });
  const url  = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  if (!win) {
    // Pop-up bloqueado (comum no app instalado e no iPhone): baixa o arquivo.
    const link = document.createElement("a");
    link.href = url;
    link.download = `PulseNote-relatorio-${monthKey}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast("Relatório baixado. Abra o arquivo e toque em Salvar como PDF.");
    return;
  }
  showToast("Relatório aberto. Escolha “Salvar como PDF” na janela de impressão.");
}

// ============================================================
// CONTROLES DO NAVEGADOR DE MÊS EM FINANÇAS
// ============================================================
function bindFinanceMonthControls() {
  document.getElementById("finMonthPrev")?.addEventListener("click", () => {
    const [y, m] = finActiveMonth.split("-").map(Number);
    const d = new Date(y, m - 2, 1); // m-2 porque mês em JS é 0-based
    finActiveMonth = toLocalIso(d).slice(0, 7);
    renderFinances();
  });

  document.getElementById("finMonthNext")?.addEventListener("click", () => {
    const [y, m] = finActiveMonth.split("-").map(Number);
    const d = new Date(y, m, 1);
    finActiveMonth = toLocalIso(d).slice(0, 7);
    renderFinances();
  });

  document.getElementById("finCloseMonth")?.addEventListener("click", () => {
    closeMonth(finActiveMonth);
  });

  document.getElementById("finReopenMonth")?.addEventListener("click", () => {
    reopenMonth(finActiveMonth);
  });

  document.getElementById("finExportReport")?.addEventListener("click", () => {
    exportMonthReport(finActiveMonth);
  });

}

function updateGoalProgress(id, value, event) {
  event?.stopPropagation();
  const goal = state.goals.find((item) => item.id === id);
  if (!goal) return;
  const next = Math.max(0, Math.min(Number(goal.target) || 1, Number(value) || 0));
  const wasComplete = goal.current >= goal.target;
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
  mercado:      ["mercado","supermercado","mercadinho","hipermercado","atacadão","atacadao","assaí","assai","carrefour","pão de açúcar","pao de acucar","hortifruti","sacolão","sacolao","feira","açougue","acougue","quitanda","peixaria","empório","emporio"],
  transporte:   ["uber","99","ônibus","onibus","metro","metrô","táxi","taxi","passagem","estacionamento","pedágio","pedagio","sem parar","veloe","conectcar","patinete","bike compartilhada"],
  combustivel:  ["gasolina","combustível","combustivel","etanol","diesel","gnv","posto","abastecimento"],
  saude:        ["farmácia","farmacia","remédio","remedio","médico","medico","consulta","dentista","plano de saúde","plano de saude","exame","hospital","psicólogo","psicologo","terapia","fisioterapia","óculos","oculos","vacina","laboratório","laboratorio","ótica","otica","lente de contato"],
  academia:     ["academia","smart fit","bluefit","personal trainer","crossfit","pilates","yoga","musculação","musculacao","natação","natacao"],
  lazer:        ["cinema","show","viagem","bar","balada","streaming","jogo","passeio","ingresso","netflix","festa","parque","hospedagem","hotel","pousada","passeio turístico"],
  educacao:     ["curso","faculdade","livro","mensalidade escolar","escola","material escolar","apostila","aula","udemy","mensalidade da faculdade","pós-graduação","pos-graduacao","matrícula","matricula","material didático","material didatico"],
  moradia:      ["aluguel","condomínio","condominio","iptu","reforma","móveis","moveis","sofá","sofa"],
  contas:       ["conta de luz","conta de água","conta de agua","luz","água","agua","internet","gás","gas","conta de","celular","telefone","tv a cabo","wifi","energia","recarga","recarga do celular","recarga de celular","conta de celular","plano do celular","conta de internet"],
  manutencao:  ["oficina","mecânico","mecanico","manutenção do carro","manutencao do carro","manutenção","manutencao"],
  seguros:     ["seguro do carro","seguro"],
  impostos:    ["ipva","licenciamento"],
  roupas:       ["roupa","calça","calca","camisa","tênis","tenis","sapato","blusa","jaqueta","acessório","acessorio","bolsa","perfume"],
  assinaturas:  ["assinatura","spotify","amazon prime","youtube premium","mensalidade do","disney+","disney plus","hbo max","globoplay","apple music","icloud","google one"],
  salario:      ["salário","salario","contracheque","pagamento do trabalho","pagamento da empresa","holerite","13º","13o salario","decimo terceiro","décimo terceiro","férias","ferias","plr","participação nos lucros","participacao nos lucros","vale alimentação","vale alimentacao","vale refeição","vale refeicao","adiantamento salarial","pagamento do mês","pagamento do mes","folha de pagamento"],
  freelance:    ["freela","freelance","bico","job extra","trampo extra","projeto extra","cliente pagou","pagamento do cliente","serviço prestado","servico prestado","comissão","comissao","consultoria","diária","diaria","cachê","cache","honorários","honorarios","nota fiscal","trabalho extra"],
  investimentos:["dividendo","rendimento","investimento","ação","ações","cdb","tesouro direto","fii","fundo imobiliário","fundo imobiliario","juros recebidos","resgate","renda fixa","lucro","rendeu"],
  vendas:       ["venda","vendi","vendeu","olx","mercado livre","enjoei","marketplace","vendinha"],
  reembolso:    ["reembolso","ressarcimento","devolução","devolucao","estorno","cashback","restituição","restituicao","devolveram","me devolveu","pagou de volta"],
  presente:     ["presente","bônus","bonus","doação","doacao","mesada","ganhei de presente","pix de presente","mimo","vaquinha"],

  beleza: ["cabelo", "corte de cabelo", "cabeleireiro", "cabeleireira", "salão", "salao", "manicure", "pedicure", "barbearia", "barbeiro", "depilação", "depilacao", "estética", "estetica", "maquiagem", "sobrancelha", "unha", "skincare", "cosmético", "cosmetico", "barba", "escova", "progressiva", "depilação a laser", "perfumaria"],
  pet: ["ração", "racao", "veterinário", "veterinario", "petshop", "pet shop", "cachorro", "gato", "areia de gato", "banho e tosa", "antipulgas", "brinquedo do pet", "consulta veterinária", "consulta veterinaria", "petz", "cobasi", "pet"],
  pensao: ["pensão", "pensao", "auxílio", "auxilio", "bolsa família", "bolsa familia", "benefício", "beneficio", "inss", "aposentadoria", "seguro desemprego", "bpc"],
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
function fillExpenseFormFrom(result, source = "") {
  document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.toggle("active", b.dataset.finType === result.type));
  document.querySelector("#expenseType").value = result.type;
  document.querySelector(".fin-form-card")?.classList.toggle("is-receita", result.type === "receita");
  populateCategorySelect(result.categoryId, result.type);

  document.querySelector("#expenseAmount").value      = result.amount.toFixed(2).replace(".", ",");
  document.querySelector("#expenseDescription").value = result.description || "";
  document.querySelector("#expenseDate").value        = result.date;
  finPendingEntrySource = source;
  // Como a pessoa já categorizou essa descrição vale mais que o palpite.
  const learned = finLearnedCategory(result.description, result.type);
  if (learned && learned !== result.categoryId) populateCategorySelect(learned, result.type);
  finApplyRuleToForm(result.description);

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
    text.textContent = mode === "done" ? "Prontinho!" : "Pulsinho tá com a IA nisso...";
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
      fillExpenseFormFrom(data, "IA");
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
      fillExpenseFormFrom(local, "IA");
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
  const goal = (state.finGoals || []).find((g) => g.categoryId === categoryId && (g.workspaceId || "personal") === activeWorkspaceId);
  if (!goal || !goal.limit) return;

  const spent = (state.finances || [])
    .filter((f) => f.date.startsWith(monthKey) && f.type === "despesa" && f.category === categoryId && (f.workspaceId || "personal") === activeWorkspaceId)
    .reduce((s, f) => s + f.amount, 0);
  const pct = (spent / goal.limit) * 100;
  const cat = findCategory(categoryId);
  const label = cat.label.replace(/^\S+\s*/, "");

  const key100 = `${activeWorkspaceId}:${monthKey}:${categoryId}:100`;
  const key90  = `${activeWorkspaceId}:${monthKey}:${categoryId}:90`;

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
  if (!requireFinanceWorkspaceEdit()) return;
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
  const amount = parseMoneyInput(valueOf("#expenseAmount"));
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
            accountId: valueOf("#expenseAccount") || "",
            workspaceId: activeWorkspaceId,
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
      accountId: valueOf("#expenseAccount") || "",
      workspaceId: activeWorkspaceId,
    };
    state.finances.unshift(entry);
    const rule = finPendingRuleId ? (state.finRules || []).find((item) => item.id === finPendingRuleId) : null;
    if (rule && entry.category === rule.categoryId) {
      rule.hits = (Number(rule.hits) || 0) + 1;
      rule.lastRunAt = new Date().toISOString();
      finLogActivity("rule", `Regra executada: ${entry.description} (${formatCurrency(amount)})`);
    }
    if (finPendingEntrySource) finLogActivity("entry", `Lançamento via ${finPendingEntrySource}: ${formatCurrency(amount)}`);
    showToast(type === "receita" ? "Receita adicionada!" : "Despesa registrada!");
  }

  saveState();
  renderFinances();
  resetExpenseForm();
  if (type === "despesa") checkFinGoalAlert(categoryId, targetMonth);
}

// ── Categoria inteligente no formulário ──────────────────────
// Ordem: regra da pessoa → como ela já categorizou essa descrição antes
// → palavras-chave. Uma escolha manual nunca é sobrescrita.
const FIN_KEY_STOPWORDS = new Set(["de", "do", "da", "dos", "das", "no", "na", "nos", "nas", "em", "com", "o", "a", "os", "as", "e", "um", "uma", "pra", "para"]);
function finDescriptionKey(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !FIN_KEY_STOPWORDS.has(w)).join(" ").trim();
}

function finLearnedCategory(description, type) {
  const key = finDescriptionKey(description);
  if (key.length < 3) return "";
  const valid = new Set(getAllCategories(type).map((c) => c.id));
  const scores = new Map();
  (state.finances || []).slice(0, 800).forEach((entry, index) => {
    if (!entry || entry.type !== type || !valid.has(entry.category) || /^outros/.test(entry.category)) return;
    const other = finDescriptionKey(entry.description);
    if (!other) return;
    const exact = other === key;
    const near = !exact && key.length >= 5 && other.length >= 5 && (other.startsWith(`${key} `) || key.startsWith(`${other} `));
    if (!exact && !near) return;
    scores.set(entry.category, (scores.get(entry.category) || 0) + (exact ? 2 : 1) * (index < 20 ? 1.5 : 1));
  });
  let best = "";
  let bestScore = 0;
  for (const [id, score] of scores) if (score > bestScore) { best = id; bestScore = score; }
  return best;
}

function finKeywordCategory(description, type) {
  const working = ` ${String(description || "").toLowerCase()} `;
  let categoryId = "";
  let bestLen = 0;
  for (const cat of getAllCategories(type)) {
    const words = [...(FIN_CATEGORY_KEYWORDS[cat.id] || []), ...cat.label.replace(/^\S+\s*/, "").toLowerCase().split(/\s+/).filter((w) => w.length > 3)];
    for (const kw of words) {
      if (kw.length > bestLen && working.includes(kw)) { categoryId = cat.id; bestLen = kw.length; }
    }
  }
  return categoryId;
}

function finSuggestCategory(description, { announce = true } = {}) {
  const select = document.querySelector("#expenseCategory");
  if (!select || select.dataset.userPicked === "1" || valueOf("#expenseId")) return;
  if (finApplyRuleToForm(description)) return;
  const type = valueOf("#expenseType") || "despesa";
  const suggested = finLearnedCategory(description, type) || finKeywordCategory(description, type);
  if (!suggested || suggested === select.value) return;
  populateCategorySelect(suggested, type);
  if (announce) showToast(`Categoria sugerida: ${finCatName(suggested)}`);
}

function resetExpenseForm() {
  const pickedSelect = document.querySelector("#expenseCategory");
  if (pickedSelect) delete pickedSelect.dataset.userPicked;
  finPendingEntrySource = "";
  finPendingRuleId = "";
  document.querySelector("#expenseForm").reset();
  document.querySelector("#expenseId").value = "";
  document.querySelector("#expenseDate").value = todayIso;
  document.querySelector("#expenseType").value = "despesa";
  populateFinanceAccountSelect();
  document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.toggle("active", b.dataset.finType === "despesa"));
  document.querySelector(".fin-form-card")?.classList.remove("is-receita");
  populateCategorySelect(null, "despesa");
  // Restaura o texto do botão e título do formulário
  const submitLabel = document.querySelector("#finSubmitLabel");
  if (submitLabel) submitLabel.textContent = "Registrar";
  const cancelBtn = document.querySelector("#cancelEditExpense");
  if (cancelBtn) cancelBtn.hidden = true;
}

function editFinance(id) {
  const entry = state.finances.find((f) => f.id === id);
  if (!entry) return;
  if (!requireFinanceWorkspaceEdit(entry.workspaceId || "personal")) return;

  setView("finances");

  document.querySelector("#expenseId").value          = entry.id;
  document.querySelector("#expenseAmount").value       = String(entry.amount).replace(".", ",");
  document.querySelector("#expenseDescription").value  = entry.description || "";
  document.querySelector("#expenseDate").value         = entry.date;
  document.querySelector("#expenseType").value         = entry.type;
  setActiveFinanceWorkspace(entry.workspaceId || "personal");
  populateFinanceAccountSelect();
  document.querySelector("#expenseAccount").value      = entry.accountId || "";
  document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.toggle("active", b.dataset.finType === entry.type));
  document.querySelector(".fin-form-card")?.classList.toggle("is-receita", entry.type === "receita");

  populateCategorySelect(entry.category, entry.type);

  const submitLabel = document.querySelector("#finSubmitLabel");
  if (submitLabel) submitLabel.textContent = "Salvar alterações";
  const cancelBtn = document.querySelector("#cancelEditExpense");
  if (cancelBtn) cancelBtn.hidden = false;

  document.querySelector("#expenseAmount").focus();
  document.querySelector(".fin-form-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteFinance(id) {
  const entry = state.finances.find((f) => f.id === id);
  if (!entry || !requireFinanceWorkspaceEdit(entry.workspaceId || "personal")) return;
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
      // A largura do texto é proporcional ao tamanho da fonte: calcula o
      // tamanho certo de uma vez (antes reduzia 0,5px por vez, medindo a
      // cada passo — vários recálculos da página por valor).
      let fontPx = maxPx;
      if (el.scrollWidth > el.clientWidth + 0.5) {
        fontPx = Math.max(minPx, Math.floor((maxPx * (el.clientWidth / el.scrollWidth)) * 2) / 2);
        el.style.fontSize = `${fontPx}px`;
        if (el.scrollWidth > el.clientWidth + 0.5 && fontPx > minPx) {
          fontPx = Math.max(minPx, fontPx - 0.5);
          el.style.fontSize = `${fontPx}px`;
        }
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

// ============================================================
// Finanças — visual dos quadros (cabeçalho, resumo, Lançamentos, Análise)
// ============================================================
let finTxTypeFilter = "all";
let finTxCatFilter = "all";
let finTxAccountFilter = "all";
let finTxShowAll = false;
let finSelectedDay = null;
let finEvoRange = 180;
const FIN_TX_PREVIEW = 6;
const BD_MONTHS_LONG = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

function finMonthShort(monthKey) { // "dez/2024"
  const [y, m] = monthKey.split("-").map(Number);
  return `${BD_MONTHS[m - 1]}/${y}`;
}

function finMonthTitle(monthKey) { // "Jan de 2025"
  const [y, m] = monthKey.split("-").map(Number);
  const short = BD_MONTHS[m - 1];
  return `${short.charAt(0).toUpperCase()}${short.slice(1)} de ${y}`;
}

function finWorkspaceEntries(monthKey) {
  return (state.finances || []).filter((f) => f.date && f.date.startsWith(monthKey) && (f.workspaceId || "personal") === activeWorkspaceId);
}

function finMonthTotals(monthKey) {
  const entries = finWorkspaceEntries(monthKey);
  const r = entries.filter((f) => f.type === "receita").reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const d = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + (Number(f.amount) || 0), 0);
  return { r, d, saldo: getCarryOverBalance(monthKey, activeWorkspaceId) + r - d, count: entries.length };
}

function finCatName(catId) {
  return String(findCategory(catId).label || "Outros").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

// Ícones de finanças — um símbolo próprio por categoria e, antes dele, um
// ícone pelo que a pessoa escreveu na descrição ("Uber" → carro, "Luz" →
// raio, "Netflix" → TV), mesmo dentro de categorias amplas como Contas.
const FIN_CATEGORY_ICONS = {
  // Despesas
  moradia: "home", contas: "bolt", manutencao: "wrench",
  alimentacao: "fork", mercado: "cart", supermercado: "cart",
  transporte: "car", combustivel: "fuel",
  saude: "pill", academia: "dumbbell", beleza: "scissors",
  educacao: "graduation", lazer: "gamepad", eventos: "balloon", presentes: "gift",
  roupas: "shirt", tecnologia: "phone", assinaturas: "repeat", familia: "family",
  pet: "paw", viagem: "plane", investimentos_desp: "piggy", emprestimos: "bank",
  impostos: "receipt", seguros: "umbrella", doacoes: "hand-heart", outros: "dots-circle",
  // Receitas
  salario: "briefcase", freelance: "laptop", investimentos: "trend-up", vendas: "tag",
  aluguel_receb: "building", reembolso: "undo", premio: "trophy", emprestimo_receb: "bank",
  pensao: "family", presente: "gift", outros_receita: "coin",
};

// [regex na descrição normalizada, ícone, tipo opcional]. A ordem importa:
// do mais específico para o mais genérico.
const FIN_DESCRIPTION_ICONS = [
  [/\b(estorno|reembolso|devolucao|cashback)\b/, "undo"],
  [/\b(salario|holerite|adiantamento|13o|decimo terceiro|ferias|plr)\b/, "briefcase", "receita"],
  [/\b(freela|freelance|bico|job|projeto)\b/, "laptop", "receita"],
  [/\b(rendimento|dividendo|juros|cdb|tesouro|acoes|cripto|bitcoin)\b/, "trend-up"],
  [/\b(venda|vendi|vendido)\b/, "tag", "receita"],
  [/\b(premio|sorteio|loteria|mega ?sena|bolao)\b/, "trophy"],
  [/\b(netflix|spotify|deezer|prime video|amazon prime|disney|hbo|hbo max|globoplay|youtube|paramount|apple tv|crunchyroll|streaming)\b/, "tv"],
  [/\b(icloud|google one|chatgpt|claude|assinatura|mensalidade app)\b/, "repeat"],
  [/\b(luz|energia|eletrica|cemig|enel|light|copel|celesc|coelba|cpfl|equatorial|neoenergia)\b/, "bolt"],
  [/\b(agua|sabesp|copasa|cedae|sanepar|embasa|saneamento|esgoto)\b/, "droplet"],
  [/\b(gas|botijao|comgas|ultragaz|liquigas)\b/, "flame"],
  [/\b(internet|wi-?fi|fibra|banda larga|provedor)\b/, "wifi"],
  [/\b(celular|recarga|telefone|claro|vivo|tim|oi movel|chip|plano movel)\b/, "phone"],
  [/\b(condominio)\b/, "building"],
  [/\b(aluguel|financiamento casa|prestacao casa|iptu casa)\b/, "home"],
  [/\b(conserto|reforma|pedreiro|eletricista|encanador|manutencao|oficina|mecanico)\b/, "wrench"],
  [/\b(gasolina|etanol|alcool|diesel|combustivel|posto|abasteci\w*|gnv)\b/, "fuel"],
  [/\b(onibus|metro|trem|brt|passagem urbana|bilhete unico|vlt)\b/, "bus"],
  [/\b(uber|99|taxi|cabify|indriver|estacionamento|pedagio|ipva|lavagem carro|lava jato)\b/, "car"],
  [/\b(passagem aerea|voo|aereo|hotel|pousada|airbnb|hospedagem|viagem|milhas)\b/, "plane"],
  [/\b(ifood|rappi|delivery|ze delivery|aiqfome|99food)\b/, "bag"],
  [/\b(cafe|cafeteria|padaria|padoca|starbucks)\b/, "coffee"],
  [/\b(almoco|jantar|lanche|restaurante|pizza|hamburguer|burger|sushi|churrasco|bar|cerveja|marmita|acai|sorvete)\b/, "fork"],
  [/\b(mercado|supermercado|feira|hortifruti|sacolao|atacadao|assai|carrefour|acougue)\b/, "cart"],
  [/\b(farmacia|drogaria|remedio|medicamento|drogasil|pague menos|raia)\b/, "pill"],
  [/\b(medico|consulta|dentista|exame|hospital|clinica|plano de saude|unimed|terapia|psicologo|fisioterapia)\b/, "heart"],
  [/\b(academia|smart ?fit|crossfit|treino|personal|pilates|natacao|futebol|esporte)\b/, "dumbbell"],
  [/\b(cabelo|corte|barbearia|barbeiro|salao|manicure|unha|sobrancelha|depilacao|estetica|maquiagem|perfume|cosmetico)\b/, "scissors"],
  [/\b(cinema|show|ingresso|teatro|festival|evento|parque)\b/, "ticket"],
  [/\b(jogo|game|steam|playstation|psn|xbox|nintendo)\b/, "gamepad"],
  [/\b(festa|aniversario|casamento|formatura|confraternizacao)\b/, "balloon"],
  [/\b(presente|lembrancinha)\b/, "gift"],
  [/\b(roupa|camisa|camiseta|calca|bermuda|vestido|tenis|sapato|chinelo|bolsa|shein|renner|riachuelo|cea|zara)\b/, "shirt"],
  [/\b(notebook|computador|pc|monitor|fone|teclado|mouse|eletronico|iphone|smartphone|tablet|ipad)\b/, "laptop"],
  [/\b(curso|faculdade|escola|colegio|mensalidade escolar|material escolar|apostila|udemy|alura)\b/, "graduation"],
  [/\b(livro|livraria|kindle|ebook)\b/, "book"],
  [/\b(pet|racao|veterinario|vet|petshop|banho e tosa|cachorro|gato)\b/, "paw"],
  [/\b(filho|filha|bebe|fralda|creche|baba|mesada)\b/, "family"],
  [/\b(seguro)\b/, "umbrella"],
  [/\b(imposto|iptu|irpf|darf|taxa|multa|tarifa|cartorio)\b/, "receipt"],
  [/\b(doacao|dizimo|oferta|vaquinha|caridade)\b/, "hand-heart"],
  [/\b(emprestimo|parcela do emprestimo|consignado|divida|acordo)\b/, "bank"],
  [/\b(poupanca|investimento|aporte|reserva|guardei)\b/, "piggy"],
  [/\b(fatura|cartao)\b/, "card"],
  [/\b(pix recebido|transferencia recebida|recebi)\b/, "coin", "receita"],
];

function finCategoryIconName(catId) {
  return FIN_CATEGORY_ICONS[catId] || "";
}

function finDescriptionIconName(description, type) {
  const text = finNormalize(description);
  if (!text) return "";
  for (const [re, icon, onlyType] of FIN_DESCRIPTION_ICONS) {
    if (onlyType && onlyType !== type) continue;
    if (re.test(text)) return icon;
  }
  return "";
}

// Categoria personalizada: ícone SVG escolhido ao criá-la (campo `icon`) ou,
// nas categorias antigas que só têm emoji no rótulo, o SVG equivalente.
// A interface nunca exibe o emoji em si.
function finCustomCategoryIcon(catId) {
  if (!catId || FIN_CATEGORY_ICONS[catId]) return "";
  const custom = (state.customCategories || []).find((c) => c && c.id === catId);
  if (!custom) return "";
  if (custom.icon) return custom.icon;
  const first = String(custom.label || "").trim().split(/\s+/)[0] || "";
  if (!/\p{Extended_Pictographic}/u.test(first)) return "tag";
  return FIN_EMOJI_SVG[first] || FIN_EMOJI_SVG[first.replace(/️/g, "")] || "tag";
}

// Nome de ícone SVG para qualquer categoria (fixa ou personalizada).
function finCategoryIconAny(catId, type) {
  return finCategoryIconName(catId) || finCustomCategoryIcon(catId) || (type === "receita" ? "wallet" : "dots-circle");
}

function finTxIcon(entry) {
  return finDescriptionIconName(entry.description, entry.type)
    || finCategoryIconName(entry.category)
    || (entry.type === "receita" ? "wallet" : "dots-circle");
}

// HTML do ícone de um lançamento (respeita o emoji de categorias próprias
// quando a descrição não aponta um ícone mais específico).
function finTxIconHtml(entry) {
  const byText = finDescriptionIconName(entry.description, entry.type);
  if (byText) return bdIcon(byText);
  return bdIcon(finCategoryIconAny(entry.category, entry.type));
}

function finCategoryIconHtml(catId) {
  return bdIcon(finCategoryIconAny(catId));
}

function finTrendHtml(current, previous, { inverse = false, prevKey } = {}) {
  if (!previous) return `<span class="bf-trend-muted">Sem base em ${escapeHtml(finMonthShort(prevKey))}</span>`;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (!Number.isFinite(pct)) return "";
  const up = pct >= 0;
  const good = inverse ? !up : up;
  const text = `${up ? "+" : "-"}${Math.abs(pct).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  return `<b class="${good ? "good" : "bad"}">${bdIcon(up ? "arrow-up" : "arrow-down")}${text}</b> vs. ${escapeHtml(finMonthShort(prevKey))}`;
}

function finSparkline(svgSelector, values) {
  const svg = document.querySelector(svgSelector);
  if (!svg) return;
  if (values.length < 2 || values.every((v) => v === values[0])) { svg.innerHTML = ""; return; }
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const coords = values.map((v, i) => [2 + (i / (values.length - 1)) * 194, 52 - ((v - min) / span) * 40]);
  const line = bdSmoothPath(coords);
  const id = `${svg.id}Fill`;
  svg.innerHTML = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#25d388" stop-opacity=".42"/><stop offset="1" stop-color="#25d388" stop-opacity="0"/></linearGradient></defs><path d="${line} L200 60 L0 60 Z" fill="url(#${id})"/><path d="${line}" fill="none" stroke="#25d388" stroke-width="1.8" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
}

// "Como o mês está indo": sobra acumulada (receitas − despesas) dia a dia
// no mês escolhido, até hoje (ou até o fim, em meses passados). Começa no
// zero do dia 1; sobe com cada entrada e desce com cada gasto.
function finMonthPulseSeries(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const days = new Date(year, month, 0).getDate();
  const currentKey = todayIso.slice(0, 7);
  const net = new Array(days + 1).fill(0);
  let lastEntryDay = 0;
  bdWorkspaceFinances().forEach((entry) => {
    if (!entry.date.startsWith(monthKey)) return;
    const day = Number(entry.date.slice(8, 10));
    if (day >= 1 && day <= days) {
      net[day] += bdSignedAmount(entry);
      lastEntryDay = Math.max(lastEntryDay, day);
    }
  });
  // Até hoje — ou até o último lançamento já registrado no mês (um salário
  // agendado para o dia 22 também conta), para o fim da linha bater com o
  // "Resultado do mês" e com os valores dos cartões.
  const lastDay = monthKey === currentKey ? Math.max(Number(todayIso.slice(8, 10)), lastEntryDay) : monthKey < currentKey ? days : lastEntryDay;
  if (!lastDay) return [];
  const points = [0];
  let running = 0;
  for (let day = 1; day <= lastDay; day += 1) {
    running += net[day];
    points.push(running);
  }
  return points;
}

// Linha verde do cartão Receitas (mesma linguagem do Saldo no Início).
// A bolinha final é HTML, não SVG: com preserveAspectRatio="none" um
// círculo vira elipse, e encostado na borda do cartão ficava cortado.
function renderFinMonthPulse(monthKey) {
  const svg = document.querySelector("#finReceitasSpark");
  if (!svg) return;
  const card = svg.closest(".bf-kpi");
  let dot = card?.querySelector(".bf-spark-dot");
  const values = finMonthPulseSeries(monthKey);
  const hasMovement = values.some((value) => value !== 0);
  if (values.length < 2 || !hasMovement) {
    svg.innerHTML = "";
    dot?.remove();
    card?.classList.remove("has-pulse", "is-negative");
    svg.removeAttribute("aria-label");
    return;
  }
  const W = 200;
  const H = 60;
  const left = 2;
  const right = W - 12; // espaço para a bolinha final
  const top = 12;
  const bottom = H - 16; // folga para a bolinha (e o halo) não encostarem na borda
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const px = (i) => left + (i / (values.length - 1)) * (right - left);
  const py = (v) => bottom - ((v - min) / span) * (bottom - top);
  const coords = values.map((v, i) => [px(i), py(v)]);
  const line = bdSmoothPath(coords);
  const final = values.at(-1);
  const negative = final < 0;
  const color = negative ? "#ef4f6b" : "#25d388";
  const zeroY = py(0);
  const id = `${svg.id}Fill`;
  svg.innerHTML = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".4"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${min < 0 && max > 0 ? `<line x1="${left}" x2="${right}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="currentColor" stroke-opacity=".22" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : ""}
    <path d="${line} L${right} ${H} L${left} ${H} Z" fill="url(#${id})"/>
    <path class="bf-spark-line" d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Sobra do mês até agora: ${formatCurrency(final)}`);
  if (card) {
    if (!dot) {
      dot = document.createElement("i");
      dot.className = "bf-spark-dot";
      dot.setAttribute("aria-hidden", "true");
      card.appendChild(dot);
    }
    dot.style.setProperty("--fx", (right / W).toFixed(4));
    dot.style.setProperty("--fy", (py(final) / H).toFixed(4));
    dot.style.setProperty("--dot", color);
    dot.title = `Sobra do mês até agora: ${formatCurrency(final)}`;
    card.classList.add("has-pulse");
    card.classList.toggle("is-negative", negative);
  }
}

function finLastMonths(monthKey, count) {
  const [y, m] = monthKey.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => toLocalIso(new Date(y, m - count + i, 1)).slice(0, 7));
}

function renderFinKpis(monthKey) {
  const prevKey = getPreviousMonthKey(monthKey);
  const cur = finMonthTotals(monthKey);
  const prev = finMonthTotals(prevKey);
  const prevHas = prev.count > 0 || isMonthClosed(prevKey);
  const set = (sel, html) => { const el = document.querySelector(sel); if (el) el.innerHTML = html; };
  set("#finReceitasTrend", finTrendHtml(cur.r, prevHas ? prev.r : 0, { prevKey }));
  set("#finDespesasTrend", finTrendHtml(cur.d, prevHas ? prev.d : 0, { inverse: true, prevKey }));
  set("#finSaldoTrend", finTrendHtml(cur.saldo, prevHas ? prev.saldo : 0, { prevKey }));
  const months = finLastMonths(monthKey, 6).map(finMonthTotals);
  renderFinMonthPulse(monthKey);
  finSparkline("#finSaldoSpark", months.map((t) => t.saldo));

  // Contas compartilhadas: membros e espaços reais (api/finance-spaces)
  const spaces = sharedFinanceSpaces || [];
  const people = new Map();
  spaces.forEach((space) => (space.members || []).forEach((member) => {
    const key = member.email || member.uid || member.name;
    if (key && !people.has(key)) people.set(key, member.name || member.email || "?");
  }));
  const meta = document.querySelector("#finSharedKpiMeta");
  if (meta) meta.textContent = spaces.length
    ? `${people.size} membro${people.size === 1 ? "" : "s"} • ${spaces.length} conta${spaces.length === 1 ? "" : "s"}`
    : "Divida as finanças com seu par ou família";
  set("#finSharedKpiAvatars", `${[...people.values()].slice(0, 3).map((name) => `<span class="bf-av" title="${escapeHtml(name)}">${escapeHtml(bdInitials(name))}</span>`).join("")}<button type="button" class="bf-av bf-av--add" data-fin-shared-add aria-label="Criar ou abrir espaço compartilhado">${bdIcon("plus")}</button>`);
}

// Soma dos limites por categoria e do que foi gasto SÓ nessas categorias.
// Um limite de categoria nunca vira orçamento global do mês.
function finLimitedSpend(monthKey, workspaceId = activeWorkspaceId) {
  const goals = (state.finGoals || []).filter((g) => (g.workspaceId || "personal") === workspaceId && Number(g.limit) > 0);
  const ids = new Set(goals.map((g) => g.categoryId));
  const limits = goals.reduce((s, g) => s + (Number(g.limit) || 0), 0);
  const spent = (state.finances || [])
    .filter((f) => f.type === "despesa" && f.date?.startsWith(monthKey) && (f.workspaceId || "personal") === workspaceId && ids.has(f.category))
    .reduce((s, f) => s + (Number(f.amount) || 0), 0);
  return { limits, spent, count: ids.size };
}

function renderFinBudget(monthKey, receitas, despesas, saldo) {
  const { limits, spent: limitedSpent } = finLimitedSpend(monthKey, activeWorkspaceId);
  const base = limits > 0 ? limits : receitas;
  const used = limits > 0 ? limitedSpent : despesas;
  const pct = base > 0 ? Math.round((used / base) * 100) : 0;
  const set = (sel, text) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
  set("#finBudgetTitle", `Uso do orçamento (${finMonthShort(monthKey)})`);
  document.querySelector("#finBudgetTitle")?.insertAdjacentHTML("beforeend", ` <span class="bd-info" title="Gastos nas categorias com limite comparados à soma desses limites (ou todas as despesas comparadas às receitas, se não houver limites)">${bdIcon("info")}</span>`);
  set("#finBudgetText", base > 0 ? `${formatCurrency(used)} de ${formatCurrency(base)}${limits > 0 ? " nas categorias com limite" : ""}` : `${formatCurrency(despesas)} gastos`);
  set("#finBudgetPct", base > 0 ? `${pct}%` : "—");
  const bar = document.querySelector("#finProgressBar");
  if (bar) {
    bar.style.width = `${Math.min(100, pct)}%`;
    bar.style.background = "";
    bar.className = pct > 100 ? "over" : pct >= 85 ? "warn" : "";
  }
  set("#finUsedLabel", limits > 0 ? `${pct}% dos limites por categoria` : `${pct}% das receitas usadas`);
  const note = document.querySelector("#finMoodRow");
  let headline; let message; let tone;
  if (saldo < 0) { tone = "bad"; headline = "Saldo negativo"; message = "Saldo negativo neste mês. Vale rever as despesas."; }
  else if (!base) { tone = "neutral"; headline = "Sem orçamento definido"; message = "Defina limites por categoria em Controle para acompanhar aqui."; }
  else if (pct > 100) { tone = "bad"; headline = "Acima do orçamento"; message = `Você gastou ${pct}% ${limits > 0 ? "dos limites por categoria" : "das receitas do mês"}.`; }
  else if (pct >= 85) { tone = "warn"; headline = "Perto do limite"; message = `Você já usou ${pct}% ${limits > 0 ? "dos limites por categoria" : "das receitas do mês"}.`; }
  else { tone = "good"; headline = "Dentro do orçamento"; message = `Você gastou ${pct}% ${limits > 0 ? "dos limites por categoria" : "das receitas do mês"}.`; }
  set("#finBudgetHeadline", headline);
  set("#finMoodText", message);
  if (note) note.dataset.tone = tone;
  const ico = document.querySelector("#finMoodBlob use");
  if (ico) ico.setAttribute("href", tone === "good" ? "#i-check" : tone === "neutral" ? "#i-info" : "#i-alert");
}

function renderFinCategoryBars(entries, despesas, monthKey) {
  const title = document.querySelector("#finCatsTitle");
  if (title) title.textContent = `Gastos por categoria (${BD_MONTHS[Number(monthKey.slice(5, 7)) - 1]})`;
  const byCat = {};
  entries.filter((f) => f.type === "despesa").forEach((f) => { byCat[f.category] = (byCat[f.category] || 0) + f.amount; });
  const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const rows = sorted.slice(0, 5);
  const rest = sorted.slice(5).reduce((s, [, v]) => s + v, 0);
  if (rest) {
    const existing = rows.find(([id]) => id === "outros");
    if (existing) existing[1] += rest; else rows.push(["outros", rest]);
  }
  const root = document.querySelector("#finCategories");
  if (!root) return byCat;
  if (!rows.length) {
    root.innerHTML = '<div class="bd-empty">Sem despesas no período.</div>';
    return byCat;
  }
  const maxPct = Math.max(...rows.map(([, v]) => v / despesas));
  root.innerHTML = rows.map(([catId, total]) => {
    const pct = despesas > 0 ? total / despesas : 0;
    const label = finCatName(catId);
    return `<div class="bf-cat-row fin-cat-row" data-fin-category="${escapeHtml(catId)}" role="button" tabindex="0" title="${escapeHtml(label)} · ${escapeHtml(formatCurrency(total))}" aria-label="${escapeHtml(label)}: ${Math.round(pct * 100)}% (${escapeHtml(formatCurrency(total))}). Abrir lançamentos">
      <span class="bf-cat-ico">${finCategoryIconHtml(catId)}</span>
      <span class="bf-cat-name">${escapeHtml(label)}</span>
      <span class="bf-cat-track"><i style="width:${Math.max(4, (pct / maxPct) * 100).toFixed(1)}%"></i></span>
      <b>${Math.round(pct * 100)}%</b>
    </div>`;
  }).join("");
  return byCat;
}

function populateFinTxFilters(entries) {
  const cat = document.querySelector("#finTxCatFilter");
  const acc = document.querySelector("#finTxAccountFilter");
  const type = document.querySelector("#finTxTypeFilter");
  if (type) type.value = finTxTypeFilter;
  if (cat) {
    const ids = [...new Set(entries.map((f) => f.category).filter(Boolean))];
    if (finTxCatFilter !== "all" && !ids.includes(finTxCatFilter)) ids.push(finTxCatFilter);
    cat.innerHTML = `<option value="all">Todas as categorias</option>${ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(finCatName(id))}</option>`).join("")}`;
    cat.value = finTxCatFilter;
  }
  if (acc) {
    const accounts = (state.financeAccounts || []).filter((a) => !a.archived && (a.workspaceId || "personal") === activeWorkspaceId);
    acc.innerHTML = `<option value="all">Todas as contas</option><option value="none">Sem conta</option>${accounts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join("")}`;
    if (![...acc.options].some((o) => o.value === finTxAccountFilter)) finTxAccountFilter = "all";
    acc.value = finTxAccountFilter;
  }
}

function renderFinTxList(monthKey, entries, query) {
  populateFinTxFilters(entries);
  let list = entries;
  if (finSelectedDay && finSelectedDay.startsWith(monthKey)) {
    const projected = buildClientFinanceProjection(monthKey).projectedEntries.filter((item) => item.date === finSelectedDay);
    list = [...entries.filter((f) => f.date === finSelectedDay), ...projected];
  }
  if (finTxTypeFilter !== "all") list = list.filter((f) => f.type === finTxTypeFilter);
  if (finTxCatFilter !== "all") list = list.filter((f) => f.category === finTxCatFilter);
  if (finTxAccountFilter === "none") list = list.filter((f) => !f.accountId);
  else if (finTxAccountFilter !== "all") list = list.filter((f) => f.accountId === finTxAccountFilter);

  const chips = [];
  if (finCategoryDrilldown) chips.push(`<span>Categoria: <strong>${escapeHtml(finCatName(finCategoryDrilldown))}</strong></span><button type="button" onclick="clearFinanceCategory()">Limpar</button>`);
  if (finSelectedDay) chips.push(`<span>Dia: <strong>${escapeHtml(plannerShortDate(finSelectedDay))}</strong></span><button type="button" onclick="filterFinByDate('${finSelectedDay}')">Limpar</button>`);
  const filterRoot = document.querySelector("#finTransactionFilter");
  if (filterRoot) { filterRoot.hidden = !chips.length; filterRoot.innerHTML = chips.join(""); }

  const limit = finTxShowAll ? 50 : FIN_TX_PREVIEW;
  const toggle = document.querySelector("#finTxToggleAll");
  if (toggle) {
    toggle.hidden = list.length <= FIN_TX_PREVIEW;
    toggle.innerHTML = finTxShowAll ? `Ver menos ${bdIcon("chev-down")}` : `Ver todos ${bdIcon("arrow-right")}`;
  }
  const root = document.querySelector("#finTransactions");
  if (!root) return;
  root.innerHTML = list.length
    ? list.slice(0, limit).map(renderFinTransaction).join("")
    : `<div class="bd-empty">${query ? "Nenhum resultado para essa busca." : finSelectedDay ? "Sem registros ou previsões neste dia." : "Nenhum lançamento no período."}</div>`;
}

function renderFinTransaction(f) {
  const isReceita = f.type === "receita";
  const canEdit = !f.projected && canEditFinanceWorkspace(f.workspaceId || "personal");
  const [, mm, dd] = f.date.split("-");
  const date = `${Number(dd)} ${BD_MONTHS[Number(mm) - 1]}`;
  const ws = workspaceLabel(f.workspaceId || "personal").replace("Compartilhado · ", "");
  return `<article class="bf-tx${f.projected ? " is-projected" : ""}" data-fin-id="${f.id}">
    <span class="bf-tx-ico ${isReceita ? "in" : "out"}">${finTxIconHtml(f)}</span>
    <div class="bf-tx-main"><strong title="${escapeHtml(f.description)}">${escapeHtml(f.description || finCatName(f.category))}</strong><small>${escapeHtml(finCatName(f.category))}<span class="bf-tx-date-inline"> • ${date}</span>${(f.workspaceId || "personal") !== activeWorkspaceId ? `<span class="bf-tx-ws-inline"> • ${escapeHtml(ws)}</span>` : ""}${f.projected ? " • Previsto" : ""}</small></div>
    <span class="bf-ws-chip">${bdIcon("user")}${escapeHtml(ws)}</span>
    <span class="bf-tx-date">${date}</span>
    <span class="bf-tx-amt ${isReceita ? "in" : "out"}">${isReceita ? "+" : "-"} ${formatCurrency(f.amount)}</span>
    ${canEdit ? `<button type="button" class="bp-kebab" onclick="openFinTxActions('${f.id}', event)" aria-label="Mais opções: ${escapeHtml(f.description || "")}">${bdIcon("dots-h")}</button>` : '<span class="bf-tx-spacer"></span>'}
  </article>`;
}

function renderFinRecentMini(monthKey) {
  const root = document.querySelector("#finRecentMini");
  if (!root) return;
  const list = finWorkspaceEntries(monthKey).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  root.innerHTML = list.length ? list.map((f) => {
    const [, mm, dd] = f.date.split("-");
    const isIn = f.type === "receita";
    return `<div class="bf-mini"><span class="bf-tx-ico ${isIn ? "in" : "out"}">${finTxIconHtml(f)}</span><div><strong>${escapeHtml(f.description || finCatName(f.category))}</strong><small>${escapeHtml(finCatName(f.category))} • ${Number(dd)} ${BD_MONTHS[Number(mm) - 1]}</small></div><b class="${isIn ? "in" : "out"}">${isIn ? "+" : "-"} ${formatCurrency(f.amount)}</b></div>`;
  }).join("") : '<div class="bd-empty">Nenhum lançamento no mês.</div>';
}

function closeFinTxActions() { document.querySelector("#finTxActionsSheet")?.remove(); }
function openFinTxActions(id, event) {
  event?.stopPropagation();
  closeFinTxActions();
  const entry = state.finances.find((f) => f.id === id);
  if (!entry) return;
  const sheet = document.createElement("div");
  sheet.id = "finTxActionsSheet";
  sheet.className = "modal-backdrop";
  sheet.innerHTML = `<div class="modal-card planner-action-sheet" role="dialog" aria-modal="true" aria-labelledby="finTxActionsTitle">
    <div class="modal-header"><h2 id="finTxActionsTitle">${escapeHtml(entry.description || finCatName(entry.category))}</h2><button type="button" class="icon-button" data-close aria-label="Fechar">${bdIcon("x")}</button></div>
    <div class="modal-body planner-action-sheet-body">
      <p class="planner-action-sheet-label">${escapeHtml(plannerShortDate(entry.date))} · ${entry.type === "receita" ? "Receita" : "Despesa"} de ${escapeHtml(formatCurrency(entry.amount))}</p>
      <button type="button" class="planner-action-option" data-edit><span>Editar lançamento</span>${bdIcon("pencil")}</button>
      <button type="button" class="planner-action-danger" data-delete>${bdIcon("trash")}<span>Excluir lançamento</span></button>
    </div></div>`;
  document.body.appendChild(sheet);
  const onKey = (e) => { if (e.key === "Escape") { closeFinTxActions(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet || e.target.closest("[data-close]")) closeFinTxActions();
    else if (e.target.closest("[data-edit]")) { closeFinTxActions(); setFinBoardTab("lancamentos"); editFinance(id); }
    else if (e.target.closest("[data-delete]")) {
      closeFinTxActions();
      if (confirm(`Excluir “${entry.description || finCatName(entry.category)}”?`)) deleteFinance(id);
    }
  });
}

function renderFinCalendar(monthKey) {
  const grid = document.querySelector("#finCalGrid");
  if (!grid) return;
  const [year, month] = monthKey.split("-").map(Number);
  const calLabel = document.querySelector("#finCalMonthLabel");
  if (calLabel) calLabel.textContent = `${BD_MONTHS_LONG[month - 1]} de ${year}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const lead = new Date(year, month - 1, 1).getDay();
  const prevDays = new Date(year, month - 1, 0).getDate();
  const projection = buildClientFinanceProjection(monthKey);
  const cells = [];
  for (let i = lead - 1; i >= 0; i -= 1) cells.push(`<span class="bf-day is-out">${prevDays - i}</span>`);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dd = String(day).padStart(2, "0");
    const iso = `${monthKey}-${dd}`;
    const data = projection.days[dd] || {};
    const dots = [
      data.receita > 0 ? '<i class="in"></i>' : "",
      data.despesa > 0 ? '<i class="out"></i>' : "",
      !data.receita && !data.despesa && data.projected?.length ? '<i class="plan"></i>' : "",
    ].join("");
    const parts = [`${day} de ${BD_MONTHS_LONG[month - 1].toLowerCase()}`];
    if (data.receita > 0) parts.push(`entradas ${formatCurrency(data.receita)}`);
    if (data.despesa > 0) parts.push(`saídas ${formatCurrency(data.despesa)}`);
    if (data.projected?.length) parts.push(`${data.projected.length} previsto(s)`);
    parts.push(`saldo previsto ${formatCurrency(data.balance || 0)}`);
    cells.push(`<button type="button" class="bf-day${iso === todayIso ? " is-today" : ""}${iso === finSelectedDay ? " is-selected" : ""}" onclick="filterFinByDate('${iso}')" aria-pressed="${iso === finSelectedDay}" aria-label="${escapeHtml(parts.join(", "))}"><span>${day}</span><em>${dots}</em></button>`);
  }
  let next = 1;
  while (cells.length % 7) cells.push(`<span class="bf-day is-out">${next++}</span>`);
  grid.innerHTML = cells.join("");
}

function filterFinByDate(date) {
  finSelectedDay = finSelectedDay === date ? null : date;
  finTxShowAll = false;
  renderFinances();
}

// Gráfico de linha do saldo (mesmo desenho do Início), para qualquer contêiner.
function drawBalanceChart(host, range, gradientId, opts) {
  if (!host) return;
  const fromView = Boolean(opts?.fromView);
  const monthly = range > 120;
  const series = bdBalanceSeries(range);
  // Ao voltar para a tela: se os dados são os mesmos do último desenho,
  // não mede nada (ler a largura agora forçava recalcular a página inteira
  // no meio da troca). Mudança de tamanho é tratada pelo ResizeObserver.
  const dataSig = `${range}|${todayIso}|${series.length}|${series[0]?.value}|${series.at(-1)?.value}|${series.reduce((sum, p, i) => (sum + p.value * (i + 1)) % 1e12, 0)}`;
  if (fromView && host.dataset.pnDataSig === dataSig && host.firstElementChild) return;
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (!width || !height) return; // aba escondida: desenha de novo quando aparecer
  host.dataset.pnDataSig = dataSig;
  if (!bdWorkspaceFinances().length || !series.length) {
    host.dataset.pnSig = "";
    host.innerHTML = '<div class="bd-empty">Sem lançamentos no período. Registre uma receita ou despesa para ver a evolução.</div>';
    return;
  }
  // Mesmo tamanho, período e valores do último desenho: nada a refazer
  // (voltar ao Início redesenhava o gráfico inteiro a cada vez).
  const sig = `${width}x${height}|${dataSig}`;
  if (host.dataset.pnSig === sig && host.querySelector("svg")) return;
  host.dataset.pnSig = sig;
  const values = series.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const step = bdNiceStep((Math.max(rawMax - rawMin, Math.abs(rawMax) * 0.05, 100)) / 5);
  const yMin = Math.floor(rawMin / step) * step;
  let yMax = Math.ceil(rawMax / step) * step;
  if (yMax === yMin) yMax = yMin + step;
  const ticks = [];
  for (let value = yMin; value <= yMax + step / 2; value += step) ticks.push(value);
  // Margem esquerda do tamanho do maior rótulo (antes era fixa e cortava
  // "R$ -1.000.000"); direita/topo/base com folga para a bolinha do último
  // ponto (raio 4,5 + contorno 2) nunca encostar na borda.
  const DOT = 7;
  const longestTick = Math.max(...ticks.map((value) => bdAxisMoney(value).length));
  const pad = { left: Math.min(96, Math.max(48, Math.round(longestTick * 6.1) + 12)), right: DOT + 6, top: DOT + 6, bottom: 24 + DOT - 2 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const x = (i) => pad.left + (series.length === 1 ? plotW : (i / (series.length - 1)) * plotW);
  const y = (v) => pad.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const coords = series.map((p, i) => [x(i), y(p.value)]);
  const line = bdSmoothPath(coords);
  const area = `${line} L${coords.at(-1)[0].toFixed(1)} ${(pad.top + plotH).toFixed(1)} L${coords[0][0].toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`;
  const grid = ticks.map((value) => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text x="${pad.left - 8}" y="${(y(value) + 3.5).toFixed(1)}" text-anchor="end">${bdAxisMoney(value)}</text>`).join("");
  const labelCount = monthly ? Math.min(series.length, width < 420 ? 3 : 6) : (width < 420 ? 3 : 5);
  const labelIdx = [...new Set(Array.from({ length: labelCount }, (_, k) => Math.round((k / Math.max(labelCount - 1, 1)) * (series.length - 1))))];
  const xLabels = labelIdx.map((idx, k) => `<text x="${x(idx).toFixed(1)}" y="${height - 6}" text-anchor="${k === 0 ? "start" : k === labelIdx.length - 1 ? "end" : "middle"}">${bdPointLabel(series[idx], monthly)}</text>`).join("");
  const last = coords.at(-1);
  const tipText = formatCurrency(series.at(-1).value);
  const tipW = tipText.length * 6.6 + 18;
  // Etiqueta à esquerda da bolinha; acima dela quando há espaço, senão abaixo.
  const tipX = Math.min(Math.max(last[0] - tipW - 10, pad.left), width - tipW - 4);
  const tipY = last[1] - 34 >= 2 ? last[1] - 34 : Math.min(last[1] + 12, height - pad.bottom - 24);
  // A linha se desenha (e a área aparece) só quando o período muda ou na
  // primeira vez — redimensionar a janela não repete a animação.
  const drawIn = host.dataset.pnRange !== String(range);
  host.dataset.pnRange = String(range);
  host.dataset.pnChart = "";
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none" overflow="visible"${drawIn ? ' class="is-drawing"' : ""}>
    <defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee" stop-opacity=".38"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></linearGradient></defs>
    <g class="grid">${grid}</g>
    <path class="area" d="${area}" fill="url(#${gradientId})"/>
    <path class="line" d="${line}" pathLength="1"/>
    ${xLabels}
    <g class="tip"><rect x="${tipX.toFixed(1)}" y="${tipY.toFixed(1)}" width="${tipW.toFixed(1)}" height="24" rx="8"/><text x="${(tipX + tipW / 2).toFixed(1)}" y="${(tipY + 16).toFixed(1)}" text-anchor="middle">${escapeHtml(tipText)}</text></g>
    <circle class="dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4.5"/>
    <g class="hover" aria-hidden="true"><line class="guide" x1="0" x2="0" y1="${pad.top}" y2="${(pad.top + plotH).toFixed(1)}"/><circle class="hdot" cx="0" cy="0" r="5.5"/></g>
  </svg><div class="pn-chart-tip" aria-hidden="true"><small></small><strong></strong><em></em></div>`;
  host.setAttribute("aria-label", `Evolução do saldo: ${tipText} hoje`);
  host.__pnChart = { coords, series, monthly, padLeft: pad.left, plotW, plotTop: pad.top, plotH, width };
  bindBalanceChartHover(host);
}

// Passar o mouse (ou o dedo) no gráfico: uma linha-guia e um ponto correm
// até o dia mais próximo e uma etiqueta mostra data, saldo e a variação do
// dia. Tudo é só mover elementos já desenhados (nada de redesenhar o SVG
// a cada movimento), num quadro de animação por vez.
function bindBalanceChartHover(host) {
  if (host.dataset.pnHover) return;
  host.dataset.pnHover = "1";
  let frame = 0;
  let lastIndex = -1;
  let pointerX = 0;
  const hide = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    lastIndex = -1;
    host.classList.remove("is-hovering");
  };
  const paint = () => {
    frame = 0;
    const chart = host.__pnChart;
    const svg = host.querySelector("svg");
    if (!chart || !svg) return;
    const n = chart.series.length;
    const rel = Math.min(1, Math.max(0, (pointerX - chart.padLeft) / (chart.plotW || 1)));
    const index = n === 1 ? 0 : Math.round(rel * (n - 1));
    host.classList.add("is-hovering");
    if (index === lastIndex) return;
    lastIndex = index;
    const [cx, cy] = chart.coords[index];
    const guide = svg.querySelector(".hover .guide");
    const dot = svg.querySelector(".hover .hdot");
    guide?.setAttribute("x1", cx.toFixed(1));
    guide?.setAttribute("x2", cx.toFixed(1));
    dot?.setAttribute("cx", cx.toFixed(1));
    dot?.setAttribute("cy", cy.toFixed(1));
    const tip = host.querySelector(".pn-chart-tip");
    if (!tip) return;
    const point = chart.series[index];
    const prev = chart.series[index - 1];
    const delta = prev ? point.value - prev.value : 0;
    const [yy, mm, dd] = point.date.split("-").map(Number);
    tip.querySelector("small").textContent = chart.monthly ? `${BD_MONTHS[mm - 1]} de ${yy}` : `${dd} de ${BD_MONTHS[mm - 1]}`;
    tip.querySelector("strong").textContent = formatCurrency(point.value);
    const em = tip.querySelector("em");
    em.textContent = delta ? `${delta > 0 ? "+" : "−"}${formatCurrency(Math.abs(delta))} ${chart.monthly ? "no mês" : "no dia"}` : (chart.monthly ? "sem variação no mês" : "sem movimento no dia");
    em.className = delta > 0 ? "up" : delta < 0 ? "down" : "";
    const tipW = tip.offsetWidth || 140;
    const left = Math.min(Math.max(cx - tipW / 2, 0), chart.width - tipW);
    const top = Math.max(0, cy - tip.offsetHeight - 14);
    tip.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
  };
  host.addEventListener("pointermove", (event) => {
    const rect = host.getBoundingClientRect();
    pointerX = event.clientX - rect.left;
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: true });
  host.addEventListener("pointerleave", hide, { passive: true });
  host.addEventListener("pointercancel", hide, { passive: true });
}

function renderFinSaldoEvolution() {
  drawBalanceChart(document.querySelector("#finSaldoEvolution"), finEvoRange, "finEvoFill");
}

function renderFinChart6m() {
  const el = document.querySelector("#finChart6m");
  if (!el) return;
  const width = el.clientWidth;
  const height = el.clientHeight;
  if (!width || !height) return;
  const months = finLastMonths(finActiveMonth, 6);
  const data = months.map((mk) => ({ mk, lbl: `${BD_MONTHS[Number(mk.slice(5, 7)) - 1]}/${mk.slice(2, 4)}`, ...finMonthTotals(mk) }));
  if (!data.some((d) => d.r || d.d)) {
    el.innerHTML = '<div class="bd-empty">Sem movimentações nos últimos 6 meses.</div>';
    return;
  }
  const step = bdNiceStep(Math.max(...data.flatMap((d) => [d.r, d.d]), 1) / 5);
  const top = Math.ceil(Math.max(...data.flatMap((d) => [d.r, d.d]), 1) / step) * step;
  const pad = { left: 62, right: 8, top: 10, bottom: 24 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const groupW = plotW / data.length;
  const barW = Math.max(6, Math.min(18, groupW * 0.3));
  const grid = ticks.map((v) => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${pad.left - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${bdAxisMoney(v)}</text>`).join("");
  const bars = data.map((d, i) => {
    const cx = pad.left + groupW * i + groupW / 2;
    const active = d.mk === finActiveMonth;
    const bar = (v, xx, cls) => `<rect class="${cls}" x="${xx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, pad.top + plotH - y(v)).toFixed(1)}" rx="3"/>`;
    return `<g class="bf-cmp-group${active ? " is-active" : ""}" data-fin-month="${d.mk}" role="button" tabindex="0" aria-label="${escapeHtml(finMonthTitle(d.mk))}: receitas ${escapeHtml(formatCurrency(d.r))}, despesas ${escapeHtml(formatCurrency(d.d))}">
      <rect x="${(cx - groupW / 2).toFixed(1)}" y="${pad.top}" width="${groupW.toFixed(1)}" height="${plotH}" fill="transparent"/>
      ${bar(d.r, cx - barW - 1.5, "in")}${bar(d.d, cx + 1.5, "out")}
      <text x="${cx.toFixed(1)}" y="${height - 6}" text-anchor="middle">${d.lbl}</text>
      <title>${escapeHtml(finMonthTitle(d.mk))}: receitas ${escapeHtml(formatCurrency(d.r))}, despesas ${escapeHtml(formatCurrency(d.d))}</title>
    </g>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><g class="grid">${grid}</g>${bars}</svg>`;
}

// "Tabs sliding" (transitions.dev): uma pílula única desliza até a aba
// ativa em vez do sublinhado que pulava de uma aba para outra.
function finMoveTabIndicator() {
  const tabs = document.querySelector(".bf-tabs");
  const active = tabs?.querySelector(".fin-tab-btn.active");
  if (!tabs || !active) return;
  let pill = tabs.querySelector(".bf-tab-pill");
  if (!pill) {
    pill = document.createElement("span");
    pill.className = "bf-tab-pill";
    pill.setAttribute("aria-hidden", "true");
    tabs.prepend(pill);
    tabs.classList.add("has-pill");
  }
  const box = tabs.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  if (!rect.width) return;
  pill.style.setProperty("--x", `${rect.left - box.left + tabs.scrollLeft - tabs.clientLeft}px`);
  pill.style.setProperty("--w", `${rect.width}px`);
}
window.addEventListener("resize", () => finMoveTabIndicator());

// Entrada encenada (barras crescem, cartões sobem em cascata) só quando a
// pessoa troca de aba ou abre Finanças — nunca a cada salvamento.
function finPlayEntrance() {
  const board = document.querySelector(".bf");
  if (!board) return;
  // Reinicia a entrada sem forçar recálculo da página (antes: remover a
  // classe + ler offsetWidth = ~40ms de trava a cada abertura de Finanças).
  if (board.classList.contains("bf-anim")) {
    board.getAnimations({ subtree: true }).forEach((anim) => {
      if (typeof CSSAnimation !== "undefined" && anim instanceof CSSAnimation) anim.currentTime = 0;
    });
  } else {
    board.classList.add("bf-anim");
  }
  window.clearTimeout(finPlayEntrance.timer);
  finPlayEntrance.timer = window.setTimeout(() => board.classList.remove("bf-anim"), 1400);
}

function setFinBoardTab(target) {
  document.querySelectorAll(".fin-tab-btn").forEach((t) => {
    const active = t.dataset.finTab === target;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".fin-tab-panel").forEach((p) => { p.hidden = p.dataset.finPanel !== target; });
  const board = document.querySelector(".bf");
  if (board) board.dataset.tab = target;
  requestAnimationFrame(finMoveTabIndicator); // mede no quadro seguinte (sem trava)
  finPlayEntrance();
  const slot = document.querySelector(`[data-sim-slot="${target}"]`);
  const sim = document.querySelector("#finSimulatorCard");
  if (slot && sim && sim.parentElement !== slot) slot.appendChild(sim);
  const simLabel = document.querySelector('label[for="finSimulatorAmount"]');
  if (simLabel) simLabel.textContent = target === "controle" ? "Quanto você pode gastar hoje?" : "Quanto você pretende gastar?";
  if (target === "automacao" && finAutoOpen) setFinAutoSection("");
  if (target === "analise") requestAnimationFrame(() => { renderFinSaldoEvolution(); renderFinChart6m(); });
}

// Lê a foto/PDF do comprovante ou o áudio e preenche o formulário (mesma IA do WhatsApp).
const FIN_MEDIA_ERRORS = {
  ai_not_configured: "A leitura por IA ainda não foi configurada no servidor.",
  feature_disabled: "A leitura de comprovantes e áudios está desligada no momento.",
  maintenance: "O PulseNote está em manutenção. Tente de novo em instantes.",
  unauthorized: "Sua sessão expirou. Recarregue a página e entre de novo.",
  media_too_large: "Arquivo grande demais. Use uma foto ou um PDF de até 2,5 MB.",
  unsupported_media: "Formato não suportado. Use foto (JPG, PNG, WEBP), PDF ou áudio.",
  audio_not_understood: "Não consegui entender o áudio. Tente falar mais perto do microfone.",
  ai_rate_limited: "O limite da IA foi atingido por agora. Tente em alguns minutos.",
};

async function finCallParser(body) {
  const token = await currentUser?.getIdToken();
  const response = await fetch("/api/parse-transaction", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, categories: buildCategoryPayload(), today: todayIso }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw { handled: true, code: data.error, transcript: data.transcript };
  return data;
}

function finBlobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Fotos viram JPEG de até 1600px (cabe no limite de envio e lê melhor na IA).
async function finCompressImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { base64: await finBlobToBase64(file), mimeType: file.type || "image/jpeg" };
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  return { base64: await finBlobToBase64(blob), mimeType: "image/jpeg" };
}

function finMediaBusy(button, busy, text) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
  const label = button.querySelector("span");
  if (label && text) label.textContent = text;
}

async function handleFinReceipt(file) {
  const button = document.querySelector("#finReceiptBtn");
  if (!file) return;
  const isPdf = file.type === "application/pdf";
  if (!isPdf && !file.type.startsWith("image/")) { showToast(FIN_MEDIA_ERRORS.unsupported_media); return; }
  if (isPdf && file.size > 2.5 * 1024 * 1024) { showToast(FIN_MEDIA_ERRORS.media_too_large); return; }
  finMediaBusy(button, true, "Lendo comprovante…");
  try {
    const media = isPdf ? { base64: await finBlobToBase64(file), mimeType: "application/pdf" } : await finCompressImage(file);
    const data = await finCallParser({ mode: "image", imageBase64: media.base64, mimeType: media.mimeType });
    if (!data.amount) throw { handled: true, code: "unreadable" };
    fillExpenseFormFrom(data, "foto");
    showToast("Comprovante lido! Confira os dados e toque em Registrar.");
  } catch (err) {
    if (!err?.handled) console.error("Falha ao ler comprovante:", err);
    showToast(FIN_MEDIA_ERRORS[err?.code] || "Não consegui ler esse comprovante. Tente uma foto mais nítida ou preencha manualmente.");
  } finally {
    finMediaBusy(button, false, "Foto / PDF do comprovante");
  }
}

function bindFinanceBoard() {
  // Espaço + mês sobem para o cabeçalho (aparecem só na tela de Finanças)
  const slot = document.querySelector("#bdTopSlot");
  const controls = document.querySelector("#finTopControls");
  if (slot && controls) slot.append(controls);

  document.querySelector("#finWsSeg")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-workspace]");
    if (button) setActiveFinanceWorkspace(button.dataset.workspace);
  });

  const moreBtn = document.querySelector("#finMoreBtn");
  const moreMenu = document.querySelector("#finMoreMenu");
  moreBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
    moreBtn.setAttribute("aria-expanded", String(!moreMenu.hidden));
  });
  moreMenu?.addEventListener("click", () => { moreMenu.hidden = true; moreBtn?.setAttribute("aria-expanded", "false"); });
  document.addEventListener("click", (event) => {
    if (moreMenu && !moreMenu.hidden && !event.target.closest(".bf-more")) { moreMenu.hidden = true; moreBtn?.setAttribute("aria-expanded", "false"); }
  });

  document.querySelectorAll("[data-fin-cal]").forEach((button) => button.addEventListener("click", () => {
    document.querySelector(button.dataset.finCal === "-1" ? "#finMonthPrev" : "#finMonthNext")?.click();
  }));
  document.querySelector("#finMonthPrev")?.addEventListener("click", () => { finSelectedDay = null; });
  document.querySelector("#finMonthNext")?.addEventListener("click", () => { finSelectedDay = null; });

  const filterBind = (selector, setter) => document.querySelector(selector)?.addEventListener("change", (event) => { setter(event.target.value); finTxShowAll = false; renderFinances(); });
  filterBind("#finTxTypeFilter", (v) => { finTxTypeFilter = v; });
  filterBind("#finTxCatFilter", (v) => { finTxCatFilter = v; });
  filterBind("#finTxAccountFilter", (v) => { finTxAccountFilter = v; });
  document.querySelector("#finTxToggleAll")?.addEventListener("click", () => { finTxShowAll = !finTxShowAll; renderFinances(); });

  document.querySelector("#finEvoRange")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-range]");
    if (!button) return;
    finEvoRange = Number(button.dataset.range) || 180;
    document.querySelectorAll("#finEvoRange button").forEach((b) => b.classList.toggle("active", b === button));
    renderFinSaldoEvolution();
  });
  if ("ResizeObserver" in window) {
    for (const [selector, draw] of [["#finSaldoEvolution", renderFinSaldoEvolution], ["#finChart6m", renderFinChart6m]]) {
      const el = document.querySelector(selector);
      if (!el) continue;
      let lastWidth = 0;
      new ResizeObserver(() => { if (Math.abs(el.clientWidth - lastWidth) < 2) return; lastWidth = el.clientWidth; draw(); }).observe(el);
    }
  }

  document.querySelectorAll("[data-fin-goto]").forEach((button) => button.addEventListener("click", () => setFinBoardTab(button.dataset.finGoto)));
  document.querySelector("#finSharedKpi")?.addEventListener("click", (event) => {
    if (!event.target.closest("[data-fin-shared-add]")) return;
    setFinBoardTab("controle");
    requestAnimationFrame(() => document.querySelector("#finSharedSpacesList")?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  });

  bdSetupPager(document.querySelector("#finKpis"), document.querySelector("#finKpiDots"), ".bf-kpi");

  const receiptInput = document.querySelector("#finReceiptInput");
  document.querySelector("#finReceiptBtn")?.addEventListener("click", () => receiptInput?.click());
  receiptInput?.addEventListener("change", () => { handleFinReceipt(receiptInput.files?.[0]); receiptInput.value = ""; });
}

// Barra de escopo (QA 18/11): com categoria ou busca ativas, os cartões de
// Receitas/Despesas/Saldo mostram só esse recorte, enquanto o calendário
// segue com os totais gerais. A barra fica acima dos indicadores em todas as
// abas, cada cartão ganha o selo "Filtrado" e o calendário "Totais gerais".
function renderFinScope(query) {
  const bar = document.querySelector("#finScopeBar");
  const parts = [];
  if (finCategoryDrilldown) parts.push({ label: "Categoria", value: finCatName(finCategoryDrilldown), clear: "category" });
  if (query) parts.push({ label: "Busca", value: `“${query}”`, clear: "search" });
  const kpiFiltered = parts.length > 0;
  if (finSelectedDay) parts.push({ label: "Dia", value: plannerShortDate(finSelectedDay), clear: "day", listOnly: true });
  document.querySelectorAll("#finKpis .bf-kpi--in, #finKpis .bf-kpi--out, #finKpis .bf-kpi--bal").forEach((card) => {
    card.classList.toggle("is-scoped", kpiFiltered);
    let tag = card.querySelector(".bf-kpi-scope");
    if (kpiFiltered && !tag) {
      tag = document.createElement("span");
      tag.className = "bf-kpi-scope";
      tag.textContent = "Filtrado";
      card.querySelector(".bf-kpi-body > span")?.after(tag);
    } else if (!kpiFiltered) tag?.remove();
  });
  const calTag = document.querySelector("#finCalScopeTag");
  if (calTag) calTag.hidden = !parts.length;
  if (!bar) return;
  bar.hidden = !parts.length;
  if (!parts.length) { bar.innerHTML = ""; return; }
  const note = kpiFiltered
    ? "Receitas, despesas e saldo abaixo mostram só este recorte. O calendário continua com os totais gerais."
    : "O dia filtra só a lista de lançamentos. Os indicadores mostram o mês inteiro.";
  bar.innerHTML = `<span class="bf-scope-ico">${bdIcon("sliders")}</span>
    <div class="bf-scope-chips">${parts.map((p) => `<span class="bf-scope-chip${p.listOnly ? " is-soft" : ""}"><em>${escapeHtml(p.label)}</em><strong>${escapeHtml(p.value)}</strong><button type="button" data-fin-scope-clear="${p.clear}" aria-label="Remover filtro ${escapeHtml(p.label)}">${bdIcon("x")}</button></span>`).join("")}</div>
    <p class="bf-scope-note">${note}</p>
    <button type="button" class="bf-scope-reset" data-fin-scope-clear="all">Limpar tudo</button>`;
}

document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-fin-scope-clear]");
  if (!button) return;
  const what = button.dataset.finScopeClear;
  if (what === "category" || what === "all") finCategoryDrilldown = null;
  if (what === "day" || what === "all") finSelectedDay = null;
  if ((what === "search" || what === "all") && elements.globalSearch) elements.globalSearch.value = "";
  renderFinances();
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

  if (labelEl)  labelEl.textContent = finMonthTitle(monthKey);
  const workspaceEl = document.querySelector("#finWorkspaceSelect");
  if (workspaceEl) workspaceEl.value = activeWorkspaceId;
  if (badgeEl)  badgeEl.hidden = !closed;
  if (closeBtn) closeBtn.hidden = closed;
  if (reopenBtn) reopenBtn.hidden = !closed;
  // Formulário de novo lançamento desabilitado em mês fechado
  if (formCard) formCard.classList.toggle("month-closed", closed);

  // ── Filtra lançamentos do mês ativo ──────────────────────────
  let entries = [...state.finances]
    .filter((f) => f.date.startsWith(monthKey) && (f.workspaceId || "personal") === activeWorkspaceId)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (finCategoryDrilldown) entries = entries.filter((f) => f.category === finCategoryDrilldown);

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
  const saldoAnterior = getCarryOverBalance(monthKey, activeWorkspaceId);
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
  void usedPct;
  renderFinScope(query);
  renderFinBudget(monthKey, receitas, despesas, saldo);

  const byCat = renderFinCategoryBars(entries, despesas, monthKey);
  renderFinInsights(monthKey, entries, receitas, despesas, byCat);

  renderFinTxList(monthKey, entries, query);

  renderFinCalendar(monthKey);
  renderFinKpis(monthKey);
  renderFinRecentMini(monthKey);
  renderFinChart6m();
  renderFinSaldoEvolution();
  renderFinGoals();
  renderFinClosures();
  renderFinRecurrents();
  renderFinanceAccounts();
  renderCreditCards();
  renderFinAutomationExtras();
}

function populateFinanceAccountSelect() {
  const select = document.querySelector("#expenseAccount");
  if (!select) return;
  const selected = select.value;
  const accounts = (state.financeAccounts || []).filter((item) => !item.archived && (item.workspaceId || "personal") === activeWorkspaceId);
  select.innerHTML = `<option value="">Sem conta</option>${accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join("")}`;
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}



function renderFinInsights(monthKey, entries, receitas, despesas, byCat) {
  const root = document.querySelector("#finInsights");
  if (!root) return;

  const [year, month] = monthKey.split("-").map(Number);
  const previousKey = toLocalIso(new Date(year, month - 2, 1)).slice(0, 7);
  const previousExpenses = (state.finances || [])
    .filter((item) => item.date.startsWith(previousKey) && item.type === "despesa" && (item.workspaceId || "personal") === activeWorkspaceId)
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

function compactProjectedBalance(value) {
  const amount = Number(value) || 0;
  const absolute = Math.abs(amount);
  const compact = absolute >= 1000
    ? new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(absolute)
    : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(absolute);
  return `${amount < 0 ? "−" : ""}${compact}`;
}

function buildClientFinanceProjection(monthKey) {
  const builder = window.PulseFinanceProjection?.buildMonthProjection;
  if (!builder) return { days: {}, projectedEntries: [] };
  return builder({
    monthKey,
    workspaceId: activeWorkspaceId,
    startingBalance: getCarryOverBalance(monthKey, activeWorkspaceId),
    finances: state.finances,
    recurrents: state.finRecurrents,
    scheduledFinances: state.scheduledFinances,
    creditCards: state.creditCards,
  });
}

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
  if (description) description.placeholder = type === "receita" ? "Ex.: Salário de janeiro" : "Ex.: Almoço no restaurante";
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
  if (iconEl) {
    iconEl.innerHTML = bdIcon(finCategoryIconAny(select.value));
    iconEl.style.setProperty("--cat-color", cat.color || "var(--bd-primary)");
  }
  if (labelEl) labelEl.textContent = finCatName(select.value);
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
  modal.className = "cat-sheet-backdrop";

  modal.innerHTML = `
    <div class="cat-sheet t-modal" role="dialog" aria-modal="true" aria-labelledby="catSheetTitle">
      <div class="cat-sheet-head">
        <div>
          <h2 id="catSheetTitle">${type === "receita" ? "De onde veio" : "Categoria"}</h2>
          <p>Busque, escolha ou crie a categoria exata que você quer</p>
        </div>
        <button id="closeCategoryPicker" class="cat-sheet-close" type="button" aria-label="Fechar">${bdIcon("x")}</button>
      </div>
      <label class="cat-sheet-search">
        ${bdIcon("search")}
        <input id="categoryPickerSearch" placeholder="Buscar ou digitar uma categoria nova..." autocomplete="off" maxlength="24" aria-label="Buscar categoria"/>
      </label>
      <div id="categoryPickerList" class="cat-sheet-list" role="listbox" aria-label="Categorias"></div>
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
    select.dataset.userPicked = "1";
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
      const cleanLabel = finCatName(cat.id);
      return `
        <div class="cat-picker-row${isSelected ? " is-selected" : ""}" data-cat-id="${escapeHtml(cat.id)}" role="option" aria-selected="${isSelected}" tabindex="0"
          style="--cat-color:${cat.color}">
          <span class="cat-picker-icon">${bdIcon(finCategoryIconAny(cat.id, type))}</span>
          <span class="cat-picker-label">${escapeHtml(cleanLabel)}</span>
          ${isSelected ? `<span class="cat-picker-check">${bdIcon("check")}</span>` : ""}
          ${isCustom ? `<button type="button" class="cat-picker-delete" data-del-id="${escapeHtml(cat.id)}" title="Excluir categoria" aria-label="Excluir categoria ${escapeHtml(cleanLabel)}">${bdIcon("trash")}</button>` : ""}
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
          <p class="cat-picker-section-title">${bdIcon("star")}Mais usadas</p>
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
      <button type="button" id="categoryPickerCreate" class="cat-sheet-create" data-name="${escapeHtml(query.trim())}">
        <span class="cat-sheet-create-ico">${bdIcon("plus")}</span>
        <span>Criar categoria “${escapeHtml(query.trim())}”</span>
      </button>` : "";

    listEl.innerHTML = bodyHtml + emptyHtml + createHtml;

    listEl.querySelectorAll(".cat-picker-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".cat-picker-delete")) return;
        selectCategory(row.dataset.catId);
      });
      row.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.target.closest(".cat-picker-delete")) { e.preventDefault(); selectCategory(row.dataset.catId); }
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
  modal.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(); });
  requestAnimationFrame(() => modal.classList.add("is-open"));
}

// v2 Finanças: catálogo de ícones em SVG (traço único, mesmo desenho do
// resto do app) — no lugar da parede de emojis. Cada ícone guarda um
// "token" (o emoji antigo) só para manter o formato do rótulo salvo
// ("<token> Nome"), que o servidor e o WhatsApp já sabem ler; a interface
// nunca mais mostra o emoji, sempre o SVG.
const NEW_CATEGORY_ICON_GROUPS = [
  { key: "casa", label: "Casa", icons: [
    ["home", "casa moradia aluguel", "🏠"], ["bolt", "luz energia", "💡"], ["droplet", "água chuveiro", "🚿"],
    ["flame", "gás fogão", "🔥"], ["key", "chave aluguel imóvel", "🔑"], ["building", "condomínio prédio", "🏢"],
    ["wrench", "manutenção reforma conserto", "🔧"], ["leaf", "planta jardim limpeza", "🪴"], ["paint", "decoração pintura", "🎨"],
  ]},
  { key: "alimentacao", label: "Alimentação", icons: [
    ["cart", "mercado supermercado feira", "🛒"], ["fork", "restaurante refeição almoço", "🍽️"], ["coffee", "café padaria", "☕"],
    ["bag", "delivery ifood lanche", "🍔"],
  ]},
  { key: "transporte", label: "Transporte", icons: [
    ["car", "carro uber táxi estacionamento", "🚗"], ["fuel", "combustível gasolina posto", "⛽"], ["bus", "ônibus metrô trem", "🚌"],
    ["bike", "bicicleta moto patinete", "🚲"], ["plane", "viagem avião passagem", "✈️"],
  ]},
  { key: "saude", label: "Saúde e cuidado", icons: [
    ["pill", "remédio farmácia", "💊"], ["heart", "médico consulta saúde plano", "🩺"], ["tooth", "dentista", "🦷"],
    ["dumbbell", "academia treino esporte", "🏋️"], ["scissors", "beleza cabelo estética", "💅"],
  ]},
  { key: "lazer", label: "Lazer", icons: [
    ["film", "cinema filme streaming", "🎬"], ["music", "música show spotify", "🎵"], ["gamepad", "jogo videogame", "🎮"],
    ["ticket", "ingresso evento teatro", "🎟️"], ["balloon", "festa aniversário", "🎉"], ["camera", "fotografia hobby", "📷"],
    ["globe", "turismo passeio internacional", "🌍"],
  ]},
  { key: "estudo", label: "Estudo e trabalho", icons: [
    ["graduation", "faculdade curso escola", "🎓"], ["book", "livros leitura", "📚"], ["briefcase", "trabalho escritório", "💼"],
    ["laptop", "computador notebook home office", "💻"], ["phone", "celular telefone", "📱"], ["wifi", "internet wifi", "📶"],
    ["tv", "tv streaming assinatura", "📺"], ["cloud", "nuvem armazenamento", "☁️"],
  ]},
  { key: "compras", label: "Compras e pessoas", icons: [
    ["shirt", "roupa calçado moda", "👕"], ["gem", "joia acessório luxo", "💎"], ["gift", "presente", "🎁"],
    ["family", "família filhos", "👨‍👩‍👧"], ["baby", "bebê criança", "👶"], ["paw", "pet cachorro gato ração", "🐾"],
    ["hand-heart", "doação caridade dízimo", "🎗️"], ["box", "compras pacote clube", "📦"],
  ]},
  { key: "financas", label: "Dinheiro", icons: [
    ["piggy", "poupança reserva guardar", "💰"], ["bank", "banco empréstimo", "🏦"], ["card", "cartão crédito fatura", "💳"],
    ["receipt", "boleto conta imposto taxa", "🧾"], ["umbrella", "seguro proteção", "🛡️"], ["coin", "moeda dinheiro pix", "🪙"],
    ["trend-up", "investimento ações rendimento", "📈"], ["tag", "venda etiqueta", "🏷️"], ["trophy", "prêmio bônus", "🏆"],
    ["repeat", "assinatura recorrente", "🔁"],
  ]},
  { key: "outros", label: "Outros", icons: [
    ["star", "favorito especial", "⭐"], ["sparkle", "especial diverso", "✨"], ["flag", "importante marcador", "📌"],
    ["target", "meta objetivo", "🎯"], ["dots-circle", "outros geral", "❓"],
  ]},
];

// Lista única { svg, name, token } usada pela busca (procura em todos os grupos).
const NEW_CATEGORY_ICON_FLAT = NEW_CATEGORY_ICON_GROUPS.flatMap((g) =>
  g.icons.map(([svg, name, token]) => ({ svg, name, token, groupKey: g.key }))
);

// Emojis de categorias personalizadas antigas → ícone SVG equivalente.
const FIN_EMOJI_SVG = {
  "🏠":"home","💡":"bolt","🚿":"droplet","🔑":"key","🛋️":"home","🧹":"leaf","🪴":"leaf","📺":"tv","🧺":"shirt","🛏️":"home","🔥":"flame","🧯":"wrench","🪑":"home","🚪":"building",
  "🍔":"bag","🛒":"cart","🍕":"fork","☕":"coffee","🍷":"fork","🍺":"fork","🍰":"coffee","🥗":"fork","🍣":"fork","🥪":"fork","🍜":"fork","🍳":"fork","🧃":"coffee","🍽️":"fork",
  "🚗":"car","⛽":"fuel","🚕":"car","🚌":"bus","🚲":"bike","🛵":"bike","🅿️":"car","🚆":"bus","🚉":"bus","🛣️":"car","🚙":"car","🔧":"wrench",
  "💊":"pill","🏋️":"dumbbell","🧘":"heart","💅":"scissors","🦷":"tooth","👓":"heart","🩺":"heart","🧴":"scissors","🧠":"heart","😷":"pill","🩹":"pill","🏥":"heart",
  "🎬":"film","🎮":"gamepad","🎉":"balloon","🎵":"music","📷":"camera","⚽":"dumbbell","🎲":"gamepad","🎨":"paint","🎤":"music","🍿":"film","🎳":"ticket","🎯":"target","🎟️":"ticket",
  "🎓":"graduation","📚":"book","✏️":"book","🖊️":"book","🏫":"graduation","🧑‍🏫":"graduation","💻":"laptop","📖":"book","🧮":"book","🔬":"graduation",
  "💼":"briefcase","📈":"trend-up","📊":"trend-up","🗂️":"folder","📎":"briefcase","🧑‍💻":"laptop","🖨️":"laptop","📅":"calendar",
  "👗":"shirt","👟":"shirt","💍":"gem","🛍️":"bag","📱":"phone","🧸":"gift","👜":"bag","🕶️":"shirt","👔":"shirt","🎒":"bag","👕":"shirt",
  "🖥️":"laptop","🎧":"music","⌨️":"laptop","🖱️":"laptop","🔌":"bolt","🕹️":"gamepad","📡":"wifi","📶":"wifi",
  "🐾":"paw","🐶":"paw","🐱":"paw","🦴":"paw","🐠":"paw","🐦":"paw","🛁":"paw",
  "👶":"baby","👨‍👩‍👧":"family","🍼":"baby","🎠":"baby","🧑‍🍼":"baby","👵":"family",
  "🎁":"gift","🎂":"balloon","💐":"gift","🎈":"balloon","🎊":"balloon","💝":"gift",
  "💰":"piggy","🏦":"bank","🧾":"receipt","🛡️":"umbrella","💳":"card","📉":"trend-up","🎗️":"hand-heart","🪙":"coin","📑":"receipt","💸":"coin",
  "💹":"trend-up","💎":"gem","📄":"receipt","🏢":"building","🔁":"repeat","📰":"book","☁️":"cloud","📦":"box",
  "✈️":"plane","🧳":"plane","🗺️":"globe","🏖️":"sun","🏨":"building","🚢":"globe","🏔️":"globe","🗽":"globe","🚀":"plane","🌍":"globe",
  "❓":"dots-circle","⭐":"star","🔖":"tag","✨":"sparkle","🧩":"box","📌":"flag","🏷️":"tag","🏆":"trophy","🤝":"hand-heart","💵":"coin",
};

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
        <button class="icon-button" id="closeNewCategory" aria-label="Fechar">${bdIcon("x")}</button>
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
          <span class="new-category-badge">${bdIcon("info")}Vai valer apenas para ${isReceita ? "receitas" : "despesas"}</span>
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
          <span class="new-category-save-icon" aria-hidden="true">${bdIcon("plus")}</span>
          <span class="new-category-save-label">Criar categoria</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  let selectedSvg = groups[0].icons[0][0];
  let selectedEmoji = groups[0].icons[0][2];
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
    previewIconEl.innerHTML = bdIcon(selectedSvg);
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
        ? [{ label: "Resultados", icons: matches.map((it) => [it.svg, it.name, it.token]) }]
        : [];
    } else {
      sections = groups;
    }

    emojiNoResultsEl.hidden = sections.length > 0;
    emojiPickerEl.hidden = sections.length === 0;

    emojiPickerEl.innerHTML = sections.map((section) => `
      <div class="new-category-icon-section">
        <p class="new-category-icon-section-title">${escapeHtml(section.label)}</p>
        <div class="new-category-emoji-grid">
          ${section.icons.map(([svg, name, token]) => `
            <button type="button" class="cat-emoji-btn cat-svg-btn${svg === selectedSvg ? " active" : ""}" data-svg="${svg}" data-emoji="${token}" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}" aria-pressed="${svg === selectedSvg}">${bdIcon(svg)}</button>
          `).join("")}
        </div>
      </div>
    `).join("");

    emojiPickerEl.querySelectorAll(".cat-emoji-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedEmoji = btn.dataset.emoji;
        selectedSvg = btn.dataset.svg;
        emojiPickerEl.querySelectorAll(".cat-emoji-btn").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
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
      icon: selectedSvg,
      color: selectedColor,
      type: activeType,
    });
    saveState();

    populateCategorySelect(id, activeType);
    modal.remove();
    showToast(`Categoria “${name}” criada.`, { tone: "success" });
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
// ============================================================
// METAS DE GASTO POR CATEGORIA
// ============================================================

// Lista os meses já fechados, com atalho pra revisar/editar ou reabrir
// cada um sem precisar navegar mês a mês com as setas ‹ ›.



// ============================================================
// CONTROLE E AUTOMAÇÃO (quadros 07 e 08)
// Orçamentos por categoria (finGoals), metas financeiras (savingsGoals),
// contas, cartões, membros do espaço, recorrências, contas agendadas,
// regras (finRules), sugestões, fechamento automático e registro de
// atividade (finActivity). Tudo por espaço (workspaceId), como o resto.
// ============================================================
const FIN_BUDGET_TONES = { saude: "green", outros: "sky" };
const FIN_SAVINGS_TONES = { plane: "violet", piggy: "rose", house: "blue", car: "amber", book: "cyan", heart: "rose", star: "amber" };
const FIN_ACCOUNT_ICONS = { checking: "bank", savings: "piggy", cash: "wallet", investment: "coin", other: "card" };
const FIN_ACCOUNT_TYPES = { checking: "Conta corrente", savings: "Poupança", cash: "Carteira", investment: "Investimentos", other: "Outra conta" };
const FIN_AUTO_PREVIEW = { recur: 4, sched: 3, rules: 2, suggest: 3, log: 4 };
const finAutoShowAll = { recur: false, sched: false, rules: false, suggest: false, log: false };
let finAutoOpen = "";
let finClosuresShowAll = false;
let finPendingEntrySource = "";
let finPendingRuleId = "";

function finInWs(item) { return (item?.workspaceId || "personal") === activeWorkspaceId; }
function finDayMonth(iso) {
  const [, m, d] = String(iso || "").split("-").map(Number);
  return m && d ? `${String(d).padStart(2, "0")} ${BD_MONTHS[m - 1]}` : "";
}
function finSigned(type, amount) { return `${type === "receita" ? "+" : "−"} ${formatCurrency(Number(amount) || 0)}`; }
function finNormalize(text) { return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }
function finJoinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} e ${list[list.length - 1]}`;
}

// Folha de ações genérica (mesmo visual da folha dos lançamentos).
function finActionSheet({ title, sub = "", actions = [] }) {
  document.querySelector("#finActionSheet")?.remove();
  const sheet = document.createElement("div");
  sheet.id = "finActionSheet";
  sheet.className = "modal-backdrop";
  sheet.innerHTML = `<div class="modal-card planner-action-sheet" role="dialog" aria-modal="true" aria-labelledby="finActionSheetTitle">
    <div class="modal-header"><h2 id="finActionSheetTitle">${escapeHtml(title)}</h2><button type="button" class="icon-button" data-close aria-label="Fechar">${bdIcon("x")}</button></div>
    <div class="modal-body planner-action-sheet-body">
      ${sub ? `<p class="planner-action-sheet-label">${escapeHtml(sub)}</p>` : ""}
      ${actions.map((action, index) => action.danger
        ? `<button type="button" class="planner-action-danger" data-index="${index}">${bdIcon(action.icon || "trash")}<span>${escapeHtml(action.label)}</span></button>`
        : `<button type="button" class="planner-action-option" data-index="${index}"><span>${escapeHtml(action.label)}</span>${bdIcon(action.icon || "chev-right")}</button>`).join("")}
    </div></div>`;
  document.body.appendChild(sheet);
  const close = () => { sheet.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet || event.target.closest("[data-close]")) return close();
    const button = event.target.closest("[data-index]");
    if (!button) return;
    close();
    actions[Number(button.dataset.index)]?.run?.();
  });
  requestAnimationFrame(() => sheet.querySelector("[data-index]")?.focus());
}

function finOpenModal(selector) {
  const modal = document.querySelector(selector);
  if (!modal) return null;
  modal.hidden = false;
  requestAnimationFrame(() => modal.querySelector("input:not([type=hidden]):not([type=radio]), select")?.focus());
  return modal;
}
function finCloseModal(selector) { const modal = document.querySelector(selector); if (modal) modal.hidden = true; }

// ---------- Registro de atividade ----------
function finLogActivity(kind, text, workspaceId = activeWorkspaceId) {
  state.finActivity ||= [];
  state.finActivity.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), kind, text: String(text).slice(0, 140), workspaceId });
  if (state.finActivity.length > 60) state.finActivity.length = 60;
}

function finActivityItems() {
  const own = (state.finActivity || []).filter(finInWs).map((item) => ({ at: item.at, text: item.text, kind: item.kind }));
  const known = new Set(own.map((item) => item.text));
  const whatsapp = (state.finances || [])
    .filter((entry) => finInWs(entry) && entry.source === "whatsapp" && entry.createdAt)
    .map((entry) => ({ at: entry.createdAt, kind: "whatsapp", text: `Lançamento via WhatsApp: ${formatCurrency(entry.amount)}` }))
    .filter((item) => !known.has(item.text));
  return [...own, ...whatsapp].filter((item) => item.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function finActivityWhen(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const iso = toLocalIso(date);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (iso === todayIso) return `Hoje, ${time}`;
  if (iso === offsetDate(-1)) return `Ontem, ${time}`;
  return `${finDayMonth(iso)}, ${time}`;
}

function renderFinActivity() {
  const root = document.querySelector("#finActivityList");
  if (!root) return;
  const items = finActivityItems();
  const limit = finAutoShowAll.log ? 30 : FIN_AUTO_PREVIEW.log;
  finSetMore("log", items.length > FIN_AUTO_PREVIEW.log, finAutoShowAll.log ? "Mostrar menos" : "Ver histórico");
  const nav = document.querySelector("#finNavLog");
  if (nav) nav.textContent = items[0] ? `${finActivityWhen(items[0].at)} · ${items[0].text}` : "Sem atividade recente";
  root.innerHTML = items.length
    ? items.slice(0, limit).map((item) => `<li><time>${escapeHtml(finActivityWhen(item.at))}</time><span title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</span></li>`).join("")
    : '<li class="bf-empty-line">As ações automáticas e os lançamentos por WhatsApp, foto e áudio aparecem aqui.</li>';
}

// ---------- Orçamentos por categoria ----------
function finMonthExpensesByCategory(monthKey) {
  const byCat = {};
  (state.finances || []).filter((f) => f.date?.startsWith(monthKey) && f.type === "despesa" && finInWs(f))
    .forEach((f) => { byCat[f.category] = (byCat[f.category] || 0) + (Number(f.amount) || 0); });
  return byCat;
}

function renderFinGoals() {
  const el = document.querySelector("#finGoalsList");
  if (!el) return;
  const monthKey = getActiveFinMonth();
  const monthLabel = document.querySelector("#finBudgetsMonth");
  if (monthLabel) monthLabel.textContent = BD_MONTHS[Number(monthKey.slice(5, 7)) - 1];
  const goals = (state.finGoals || []).filter(finInWs);
  if (!goals.length) {
    el.innerHTML = `<div class="bf-empty">${bdIcon("target")}<strong>Defina limites por categoria</strong><span>Escolha uma categoria e um teto mensal — a barra avisa quando você se aproxima do limite.</span><button type="button" class="bf-ghost-btn" data-budget-edit="">${bdIcon("plus")}Criar limite</button></div>`;
    return;
  }
  const byCat = finMonthExpensesByCategory(monthKey);
  el.innerHTML = goals.map((goal) => {
    const spent = byCat[goal.categoryId] || 0;
    const limit = Number(goal.limit) || 0;
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    const tone = pct > 100 ? "red" : pct >= 90 ? "amber" : (FIN_BUDGET_TONES[goal.categoryId] || "blue");
    const name = finCatName(goal.categoryId);
    return `<button type="button" class="bf-brow is-${tone}" data-budget-edit="${escapeHtml(goal.categoryId)}" aria-label="${escapeHtml(`${name}: ${formatCurrency(spent)} de ${formatCurrency(limit)} (${pct}%)`)}">
      <span class="bf-brow-ico">${finCategoryIconHtml(goal.categoryId)}</span>
      <span class="bf-brow-name">${escapeHtml(name)}</span>
      <span class="bf-bar"><i style="width:${Math.min(100, pct)}%"></i></span>
      <span class="bf-brow-val">${formatCurrency(spent)} de ${formatCurrency(limit)}</span>
      <b class="bf-brow-pct">${pct}%${pct >= 90 ? bdIcon("alert") : ""}</b>
    </button>`;
  }).join("");
}

function deleteFinGoal(id) {
  if (!requireFinanceWorkspaceEdit()) return;
  state.finGoals = (state.finGoals || []).filter((g) => g.id !== id);
  saveState();
  renderFinances();
  showToast("Limite removido.");
}

function finExpenseCategoriesForGoals() {
  const seen = new Set();
  return getAllCategories("despesa").filter((cat) => (seen.has(cat.id) ? false : seen.add(cat.id)));
}

function openFinGoalsModal(categoryId = "") {
  if (!requireFinanceWorkspaceEdit()) return;
  const select = document.querySelector("#goalCategory");
  if (!select) return;
  const goals = (state.finGoals || []).filter(finInWs);
  select.innerHTML = finExpenseCategoriesForGoals().map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(finCatName(c.id))}${goals.some((g) => g.categoryId === c.id) ? " • com limite" : ""}</option>`).join("");
  const firstFree = finExpenseCategoriesForGoals().find((c) => !goals.some((g) => g.categoryId === c.id));
  select.value = categoryId || firstFree?.id || select.options[0]?.value || "";
  syncFinGoalsModal();
  finOpenModal("#finGoalsModal");
}

function syncFinGoalsModal() {
  const categoryId = valueOf("#goalCategory");
  const goal = (state.finGoals || []).find((g) => g.categoryId === categoryId && finInWs(g));
  const input = document.querySelector("#goalLimit");
  if (input) input.value = goal ? String(goal.limit) : "";
  const del = document.querySelector("#finDeleteGoal");
  if (del) { del.hidden = !goal; del.dataset.goalId = goal?.id || ""; }
  const current = document.querySelector("#finGoalsCurrent");
  const goals = (state.finGoals || []).filter(finInWs);
  if (current) current.innerHTML = goals.length
    ? `<span class="field-label">Limites atuais</span><div>${goals.map((g) => `<button type="button" class="bf-chip-btn${g.categoryId === categoryId ? " active" : ""}" data-goal-pick="${escapeHtml(g.categoryId)}">${escapeHtml(finCatName(g.categoryId))} · ${escapeHtml(formatCurrency(g.limit))}</button>`).join("")}</div>`
    : "";
}

function bindFinGoalsModal() {
  const modal = document.querySelector("#finGoalsModal");
  document.querySelector("#finOpenGoalsModal")?.addEventListener("click", () => openFinGoalsModal());
  document.querySelector("#finGoalsList")?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-budget-edit]");
    if (row) openFinGoalsModal(row.dataset.budgetEdit);
  });
  document.querySelector("#finCloseGoalsModal")?.addEventListener("click", () => { modal.hidden = true; });
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
    const pick = event.target.closest("[data-goal-pick]");
    if (pick) { document.querySelector("#goalCategory").value = pick.dataset.goalPick; syncFinGoalsModal(); }
  });
  document.querySelector("#goalCategory")?.addEventListener("change", syncFinGoalsModal);
  document.querySelector("#finDeleteGoal")?.addEventListener("click", (event) => {
    const id = event.currentTarget.dataset.goalId;
    if (!id) return;
    deleteFinGoal(id);
    syncFinGoalsModal();
  });
  document.querySelector("#finSaveGoal")?.addEventListener("click", () => {
    if (!requireFinanceWorkspaceEdit()) return;
    const catId = valueOf("#goalCategory");
    const limit = parseMoneyInput(valueOf("#goalLimit"));
    if (!catId || !limit || limit <= 0) { showToast("Escolha a categoria e informe o limite."); return; }
    state.finGoals ||= [];
    const existing = state.finGoals.find((g) => g.categoryId === catId && finInWs(g));
    if (existing) existing.limit = limit;
    else state.finGoals.push({ id: crypto.randomUUID(), categoryId: catId, limit, workspaceId: activeWorkspaceId });
    saveState();
    renderFinances();
    modal.hidden = true;
    showToast(`Limite de ${finCatName(catId)} salvo.`);
  });
}

// ---------- Metas financeiras (objetivos de economia) ----------
function renderFinSavings() {
  const root = document.querySelector("#finSavingsList");
  if (!root) return;
  const goals = (state.savingsGoals || []).filter(finInWs);
  if (!goals.length) {
    root.innerHTML = `<div class="bf-empty">${bdIcon("piggy")}<strong>Guarde para o que importa</strong><span>Crie uma meta — viagem, reserva de emergência, carro — e acompanhe quanto já foi guardado.</span><button type="button" class="bf-ghost-btn" data-savings-new>${bdIcon("plus")}Criar meta</button></div>`;
    return;
  }
  root.innerHTML = goals.map((goal) => {
    const target = Math.max(0, Number(goal.target) || 0);
    const saved = Math.max(0, Number(goal.saved) || 0);
    const pct = target > 0 ? Math.round((saved / target) * 100) : 0;
    const done = pct >= 100;
    return `<button type="button" class="bf-goal tone-${FIN_SAVINGS_TONES[goal.icon] || "violet"}${done ? " is-done" : ""}" data-savings-id="${escapeHtml(goal.id)}">
      <span class="bf-goal-ico">${bdIcon(goal.icon || "star")}</span>
      <span class="bf-goal-body">
        <strong>${escapeHtml(goal.name)}</strong>
        <span class="bf-goal-line"><span>${formatCurrency(saved)} de ${formatCurrency(target)}</span><b>${done ? "Concluída" : `${pct}%`}</b></span>
        <span class="bf-bar ${pct >= 75 ? "is-green" : "is-cyan"}"><i style="width:${Math.min(100, pct)}%"></i></span>
      </span>
    </button>`;
  }).join("");
}

function openFinSavingsModal(id = "") {
  if (!requireFinanceWorkspaceEdit()) return;
  const goal = (state.savingsGoals || []).find((g) => g.id === id);
  const form = document.querySelector("#finSavingsForm");
  form?.reset();
  document.querySelector("#savingsId").value = goal?.id || "";
  document.querySelector("#savingsName").value = goal?.name || "";
  const money = (value) => (Number(value) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.querySelector("#savingsTarget").value = goal ? money(goal.target) : "";
  document.querySelector("#savingsSaved").value = goal ? money(goal.saved) : "";
  const radio = document.querySelector(`input[name="savingsIcon"][value="${goal?.icon || "plane"}"]`);
  if (radio) radio.checked = true;
  document.querySelector("#savingsDelete").hidden = !goal;
  document.querySelector("#savingsDepositRow").hidden = !goal;
  document.querySelector("#finSavingsModalTitle").textContent = goal ? "Editar meta" : "Nova meta financeira";
  finOpenModal("#finSavingsModal");
}

function saveFinSavings(event) {
  event.preventDefault();
  if (!requireFinanceWorkspaceEdit()) return;
  const id = valueOf("#savingsId");
  const name = valueOf("#savingsName").trim();
  const target = parseMoneyInput(valueOf("#savingsTarget"));
  const saved = parseMoneyInput(valueOf("#savingsSaved")) || 0;
  const icon = document.querySelector('input[name="savingsIcon"]:checked')?.value || "star";
  if (name.length < 2 || !target || target <= 0 || saved < 0) { showToast("Informe o nome e o valor da meta."); return; }
  state.savingsGoals ||= [];
  const now = new Date().toISOString();
  const existing = state.savingsGoals.find((g) => g.id === id);
  if (existing) Object.assign(existing, { name, target, saved, icon, updatedAt: now });
  else state.savingsGoals.push({ id: crypto.randomUUID(), name, target, saved, icon, workspaceId: activeWorkspaceId, createdAt: now, updatedAt: now });
  saveState();
  renderFinSavings();
  finCloseModal("#finSavingsModal");
  showToast(existing ? "Meta atualizada." : "Meta criada!");
}

function depositFinSavings() {
  const goal = (state.savingsGoals || []).find((g) => g.id === valueOf("#savingsId"));
  const amount = parseMoneyInput(valueOf("#savingsDeposit"));
  if (!goal || !amount || amount <= 0) { showToast("Informe quanto você guardou."); return; }
  if (!requireFinanceWorkspaceEdit()) return;
  goal.saved = Math.round(((Number(goal.saved) || 0) + amount) * 100) / 100;
  goal.updatedAt = new Date().toISOString();
  finLogActivity("savings", `Meta “${goal.name}”: + ${formatCurrency(amount)}`);
  saveState();
  renderFinances();
  document.querySelector("#savingsSaved").value = (Number(goal.saved) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.querySelector("#savingsDeposit").value = "";
  showToast(goal.saved >= goal.target ? `🎉 Meta “${goal.name}” concluída!` : `${formatCurrency(amount)} guardados em “${goal.name}”.`);
}

function deleteFinSavings() {
  const goal = (state.savingsGoals || []).find((g) => g.id === valueOf("#savingsId"));
  if (!goal || !requireFinanceWorkspaceEdit()) return;
  if (!confirm(`Excluir a meta “${goal.name}”?`)) return;
  state.savingsGoals = state.savingsGoals.filter((g) => g.id !== goal.id);
  saveState();
  renderFinSavings();
  finCloseModal("#finSavingsModal");
  showToast("Meta excluída.");
}

// ---------- Contas ----------
function renderFinanceAccounts() {
  const root = document.querySelector("#finAccountsList");
  if (!root) return;
  populateFinanceAccountSelect();
  const accounts = (state.financeAccounts || []).filter((item) => !item.archived && finInWs(item));
  if (!accounts.length) {
    root.innerHTML = `<div class="bf-empty">${bdIcon("bank")}<strong>Nenhuma conta ainda</strong><span>Adicione suas contas para ver saldos separados e melhorar as projeções.</span></div>`;
    return;
  }
  root.innerHTML = accounts.map((account) => {
    const balance = Number(account.balance) || 0;
    return `<button type="button" class="bf-row bf-acc" data-account-id="${escapeHtml(account.id)}">
      <span class="bf-row-ico">${bdIcon(FIN_ACCOUNT_ICONS[account.type] || "card")}</span>
      <span class="bf-row-copy"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.institution || FIN_ACCOUNT_TYPES[account.type] || "Conta")}</small></span>
      <b class="bf-acc-bal${balance < 0 ? " is-neg" : ""}">${formatCurrency(balance)}</b>
      ${bdIcon("chev-right")}
    </button>`;
  }).join("");
}

function openFinAccountActions(id) {
  const account = (state.financeAccounts || []).find((item) => item.id === id);
  if (!account) return;
  const sub = `${FIN_ACCOUNT_TYPES[account.type] || "Conta"}${account.institution ? ` · ${account.institution}` : ""} · ${formatCurrency(account.balance || 0)}`;
  if (!canEditFinanceWorkspace(account.workspaceId || "personal")) return finActionSheet({ title: account.name, sub: `${sub} · somente leitura` });
  finActionSheet({ title: account.name, sub, actions: [
    { label: "Editar conta", icon: "pencil", run: () => editFinanceAccount(id) },
    { label: "Ver lançamentos desta conta", icon: "list", run: () => { finTxAccountFilter = id; setFinBoardTab("lancamentos"); renderFinances(); } },
    { label: "Arquivar conta", icon: "trash", danger: true, run: () => archiveFinanceAccount(id) },
  ] });
}

// ---------- Cartões ----------
// v2: cada cartão vira uma miniatura de cartão de verdade — gradiente do
// emissor, chip EMV, símbolo de aproximação e a bandeira desenhada em SVG
// (no lugar das antigas pílulas "nu"/"VISA" em texto).
const FIN_CARD_ISSUERS = [
  [/nubank|\bnu\b|roxinho/, "nu", "Nubank", ["9b2cf0", "5b0fb0", "33076e"]],
  [/itau|personnalite/, "itau", "Itaú", ["ff8a1f", "ec7000", "a84c00"]],
  [/\binter\b|banco inter/, "inter", "Inter", ["ff9d3c", "ff7a00", "d14d00"]],
  [/\bc6\b|c6 ?bank|carbon/, "c6", "C6 Bank", ["3a3a3f", "1c1c20", "0b0b0d"]],
  [/santander/, "santander", "Santander", ["ff3b3b", "ec0000", "9b0000"]],
  [/bradesco|next\b/, "bradesco", "Bradesco", ["e1194b", "cc092f", "80001b"]],
  [/banco do brasil|\bbb\b|ourocard/, "bb", "Banco do Brasil", ["1f5fd1", "0038a8", "00226b"]],
  [/caixa/, "caixa", "Caixa", ["1a7fd1", "005ca9", "003a6b"]],
  [/\bxp\b|xp investimentos/, "xp", "XP", ["2b2b2b", "151515", "000"]],
  [/btg/, "btg", "BTG", ["17345f", "0b1f3a", "050f1e"]],
  [/picpay/, "picpay", "PicPay", ["2be08a", "11c76f", "078a4b"]],
  [/mercado ?pago/, "mp", "Mercado Pago", ["2cc5ff", "00a5e6", "0063b0"]],
  [/neon/, "neon", "Neon", ["26f0ff", "00b8e6", "0067c7"]],
  [/\bwill\b|will bank/, "will", "Will Bank", ["ffe14d", "ffcc00", "d9a400"]],
  [/sicredi|sicoob/, "coop", "Cooperativa", ["5cc23a", "3fa110", "236a05"]],
  [/porto/, "porto", "Porto", ["2f7dd6", "1458a8", "0a3366"]],
];
const FIN_CARD_FALLBACK_TONES = [
  ["7c6cff", "5b4dff", "2c1fb8"], ["25c7d9", "118fb4", "0b5779"], ["f2557a", "c42d5d", "7a143a"],
  ["2fd08b", "16a26a", "0b6040"], ["ffad42", "f07f1a", "a14d06"], ["4b5875", "2c3448", "141a28"],
];

function finCardBrand(card) {
  const name = finNormalize(`${card.name || ""} ${card.institution || ""}`);
  const issuer = FIN_CARD_ISSUERS.find(([re]) => re.test(name));
  let network = card.network || "";
  if (!network) {
    if (/visa/.test(name)) network = "visa";
    else if (/master|mc\b/.test(name)) network = "master";
    else if (/amex|american/.test(name)) network = "amex";
    else if (/\belo\b/.test(name)) network = "elo";
    else if (/hiper/.test(name)) network = "hiper";
    else if (issuer && ["nu", "inter", "c6", "xp", "btg", "neon", "mp", "picpay"].includes(issuer[1])) network = "master";
    else if (issuer) network = "visa";
  }
  let tones;
  if (issuer) tones = issuer[3];
  else {
    const seed = [...String(card.name || "C")].reduce((s, ch) => s + ch.charCodeAt(0), 0);
    tones = FIN_CARD_FALLBACK_TONES[seed % FIN_CARD_FALLBACK_TONES.length];
  }
  return {
    cls: issuer ? issuer[1] : "generic",
    issuer: issuer ? issuer[2] : (card.name || "Cartão"),
    network,
    tones,
    light: issuer?.[1] === "will",
  };
}

// Bandeiras desenhadas em SVG (proporções aproximadas das marcas).
function finCardNetworkSvg(network) {
  switch (network) {
    case "master":
      return `<svg class="cc-net cc-net--master" viewBox="0 0 38 24" role="img" aria-label="Mastercard"><circle cx="14" cy="12" r="9" fill="rgb(235,0,27)"/><circle cx="24" cy="12" r="9" fill="rgb(247,158,27)"/><path d="M19 4.6a9 9 0 010 14.8 9 9 0 010-14.8z" fill="rgb(255,95,0)"/></svg>`;
    case "visa":
      return `<svg class="cc-net cc-net--visa" viewBox="0 0 50 16" role="img" aria-label="Visa"><text x="25" y="14" text-anchor="middle" fill="currentColor" font-family="Arial Black, Arial, sans-serif" font-size="16.5" font-weight="900" font-style="italic" letter-spacing="-.4">VISA</text></svg>`;
    case "elo":
      return `<svg class="cc-net cc-net--elo" viewBox="0 0 40 18" role="img" aria-label="Elo"><circle cx="8" cy="9" r="7" fill="none" stroke="rgb(255,203,5)" stroke-width="2.6" stroke-dasharray="14.6 29.4" transform="rotate(-150 8 9)"/><circle cx="8" cy="9" r="7" fill="none" stroke="rgb(0,164,224)" stroke-width="2.6" stroke-dasharray="14.6 29.4" transform="rotate(-30 8 9)"/><circle cx="8" cy="9" r="7" fill="none" stroke="rgb(239,65,35)" stroke-width="2.6" stroke-dasharray="14.6 29.4" transform="rotate(90 8 9)"/><text x="18" y="13.2" fill="currentColor" font-family="inherit" font-size="12" font-weight="800">elo</text></svg>`;
    case "amex":
      return `<svg class="cc-net cc-net--amex" viewBox="0 0 40 18" role="img" aria-label="American Express"><rect width="40" height="18" rx="3" fill="rgb(46,119,188)"/><text x="20" y="12.6" text-anchor="middle" fill="rgb(255,255,255)" font-family="inherit" font-size="8.6" font-weight="900" letter-spacing=".6">AMEX</text></svg>`;
    case "hiper":
      return `<svg class="cc-net cc-net--hiper" viewBox="0 0 46 16" role="img" aria-label="Hipercard"><rect width="46" height="16" rx="3" fill="rgb(179,19,27)"/><text x="23" y="11.3" text-anchor="middle" fill="rgb(255,255,255)" font-family="inherit" font-size="8" font-weight="800" font-style="italic">Hipercard</text></svg>`;
    default:
      return `<svg class="cc-net cc-net--other" viewBox="0 0 24 24" role="img" aria-label="Cartão" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M3 10h18"/></svg>`;
  }
}

const FIN_CARD_CHIP_SVG = `<svg class="cc-chip" viewBox="0 0 30 22" aria-hidden="true"><defs><linearGradient id="ccChipG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgb(251,231,168)"/><stop offset=".45" stop-color="rgb(217,178,90)"/><stop offset="1" stop-color="rgb(169,124,42)"/></linearGradient></defs><rect x=".5" y=".5" width="29" height="21" rx="4.5" fill="url(#ccChipG)" stroke="rgba(0,0,0,.18)"/><path d="M10 .5v6.500M20 .5v6.500M10 21.5V15M20 21.5V15M.5 7.500h9.500v7H.5M29.500 7.500H20v7h9.500M10 11h10" fill="none" stroke="rgba(90,60,10,.45)" stroke-width=".9"/></svg>`;

// Miniatura do cartão. size: "sm" (lista) | "lg" (prévia do formulário).
function finCardArtHtml(card, { size = "sm" } = {}) {
  const brand = finCardBrand(card);
  const [a, b, c] = brand.tones.map((hex) => "#" + hex);
  const issuer = escapeHtml(brand.issuer);
  const last4 = escapeHtml(card.last4 || "");
  return `<span class="bf-cc-art is-${size} is-${brand.cls}${brand.light ? " is-light" : ""} t-tilt" style="--cc-a:${a};--cc-b:${b};--cc-c:${c}" aria-hidden="true">
    <span class="bf-cc-face t-tilt-card">
      <span class="bf-cc-sheen"></span>
      ${size === "lg" ? `<span class="bf-cc-issuer">${issuer}</span>` : ""}
      ${FIN_CARD_CHIP_SVG}
      <svg class="cc-wave i" aria-hidden="true"><use href="#i-contactless"/></svg>
      ${size === "lg" ? `<span class="bf-cc-number">•••• •••• •••• ${last4 || "0000"}</span>` : last4 ? `<span class="bf-cc-last">${last4}</span>` : ""}
      ${finCardNetworkSvg(brand.network)}
      <span class="t-tilt-glare"></span>
    </span>
  </span>`;
}

// "3D tilt" do transitions.dev nas miniaturas: o cartão inclina em direção
// ao ponteiro com brilho que segue o cursor e volta suave ao sair.
function bindFinCardTilt(root) {
  if (!root || root.dataset.tiltBound || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  root.dataset.tiltBound = "1";
  const MAX = 14;
  root.addEventListener("pointermove", (event) => {
    const host = event.target.closest?.(".t-tilt");
    if (!host) return;
    const face = host.querySelector(".t-tilt-card");
    const r = host.getBoundingClientRect();
    const px = (event.clientX - r.left) / r.width;
    const py = (event.clientY - r.top) / r.height;
    host.style.setProperty("--tilt-rx", `${((0.5 - py) * MAX).toFixed(2)}deg`);
    host.style.setProperty("--tilt-ry", `${((px - 0.5) * MAX).toFixed(2)}deg`);
    host.style.setProperty("--tilt-gx", `${(px * 100).toFixed(1)}%`);
    host.style.setProperty("--tilt-gy", `${(py * 100).toFixed(1)}%`);
    host.classList.add("is-hover");
    face?.classList.add("is-tilting");
  });
  root.addEventListener("pointerout", (event) => {
    const host = event.target.closest?.(".t-tilt");
    if (!host || host.contains(event.relatedTarget)) return;
    host.style.setProperty("--tilt-rx", "0deg");
    host.style.setProperty("--tilt-ry", "0deg");
    host.classList.remove("is-hover");
    host.querySelector(".t-tilt-card")?.classList.remove("is-tilting");
  });
}

function finCardInvoiceInfo(card) {
  const open = (card.invoices || []).filter((invoice) => invoice.status !== "paid").sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const next = open.find((invoice) => invoice.dueDate >= todayIso) || open[0] || null;
  const committed = open.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
  const limit = Math.max(0, Number(card.limit || 0));
  return { open, next, committed, limit, usage: limit > 0 ? Math.min(100, Math.round((committed / limit) * 100)) : 0 };
}

function renderCreditCards() {
  const root = document.querySelector("#finCardsList");
  if (!root) return;
  const cards = (state.creditCards || []).filter((card) => !card.archived && finInWs(card));
  if (!cards.length) {
    root.innerHTML = `<div class="bf-empty">${bdIcon("card")}<strong>Nenhum cartão cadastrado</strong><span>Adicione um cartão para acompanhar faturas e parcelas.</span></div>`;
    return;
  }
  root.innerHTML = cards.map((card, index) => {
    const { next, committed, limit, usage } = finCardInvoiceInfo(card);
    const overdue = next && next.dueDate < todayIso;
    const due = next ? `${overdue ? "Venceu em" : "Vence em"} ${finDayMonth(next.dueDate)}` : `Vence dia ${card.dueDay}`;
    const tone = usage >= 90 ? "is-red" : usage >= 70 ? "is-amber" : "is-violet";
    const available = Math.max(0, limit - committed);
    return `<button type="button" class="bf-ccard v2" data-card-id="${escapeHtml(card.id)}" style="--i:${index}" aria-label="${escapeHtml(`${card.name}${card.last4 ? `, final ${card.last4}` : ""}. Fatura atual ${formatCurrency(next ? next.amount : 0)}, ${due}. ${usage}% do limite usado.`)}">
      ${finCardArtHtml(card)}
      <span class="bf-row-copy"><strong>${escapeHtml(card.name)}${card.last4 ? ` <em>•• ${escapeHtml(card.last4)}</em>` : ""}</strong><small>Fatura atual</small></span>
      <span class="bf-ccard-val"><b>${formatCurrency(next ? next.amount : 0)}</b><small${overdue ? ' class="is-late"' : ""}>${due}</small></span>
      ${limit > 0 ? `<span class="bf-ccard-usage"><span class="bf-bar ${tone}" style="--pct:${Math.min(100, usage)}"><i style="width:${Math.min(100, usage)}%"></i></span><small><span>${usage}% do limite</span><span>Disponível ${formatCurrency(available)}</span></small></span>` : ""}
    </button>`;
  }).join("");
  bindFinCardTilt(root);
}

function openFinCardActions(cardId) {
  const card = (state.creditCards || []).find((item) => item.id === cardId);
  if (!card) return;
  const { next, committed, usage, open } = finCardInvoiceInfo(card);
  const installments = open.flatMap((invoice) => invoice.purchases || []).filter((purchase) => Number(purchase.totalInstallments) > 1).length;
  const sub = `${formatCurrency(committed)} comprometidos · ${usage}% do limite${installments ? ` · ${installments} parcela${installments === 1 ? "" : "s"} futura${installments === 1 ? "" : "s"}` : ""}`;
  if (!canEditFinanceWorkspace(card.workspaceId || "personal")) return finActionSheet({ title: card.name, sub: `${sub} · somente leitura` });
  const actions = [{ label: "Adicionar compra", icon: "plus", run: () => openCreditCardPurchase(cardId) }];
  if (next) actions.push({ label: `Marcar fatura paga (${formatCurrency(next.amount)})`, icon: "check", run: () => payCreditCardInvoice(cardId, next.id) });
  actions.push({ label: "Arquivar cartão", icon: "trash", danger: true, run: () => archiveCreditCard(cardId) });
  finActionSheet({ title: `${card.name}${card.last4 ? ` • Final ${card.last4}` : ""}`, sub, actions });
}

// ---------- Membros do espaço compartilhado ----------
function finMemberSpace() {
  return sharedFinanceSpace(activeWorkspaceId) || sharedFinanceSpaces[0] || null;
}

function finIsMe(member) {
  const email = String(currentUser?.email || "").toLowerCase();
  return Boolean((member.uid && member.uid === currentUser?.uid) || (member.email && email && member.email.toLowerCase() === email));
}

function renderFinMembers() {
  const root = document.querySelector("#finMembersList");
  if (!root) return;
  const space = finMemberSpace();
  const roleLabel = { owner: "Administrador", editor: "Editor", viewer: "Leitor" };
  const row = (member, me) => `<div class="bf-member">
      <span class="bf-av">${escapeHtml(bdInitials(member.name || member.email || "?"))}</span>
      <span class="bf-member-name">${escapeHtml(member.name || member.email || "Membro")}${me ? " (você)" : ""}${member.role === "owner" ? `<span class="bf-crown" title="Administrador">${bdIcon("crown")}</span>` : ""}</span>
      <span class="bf-member-role">${roleLabel[member.role] || "Leitor"}</span>
    </div>`;
  if (!space) {
    const me = { name: currentUser?.displayName || state.profileName || "Você", email: currentUser?.email || "", role: "owner" };
    root.innerHTML = `${row(me, true)}
      <button type="button" class="bf-invite" data-members-invite>${bdIcon("plus")}<span>Convidar membro</span></button>
      <p class="bf-members-hint">Crie um espaço compartilhado para dividir só as finanças com seu par ou família.</p>`;
    return;
  }
  const owner = space.role === "owner";
  const members = [...(space.members || [])].sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : 0));
  root.innerHTML = `<p class="bf-members-space">${bdIcon(space.type === "family" ? "house" : "users")}<span>${escapeHtml(space.name)}</span>${space.id === activeWorkspaceId ? '<em>em uso</em>' : `<button type="button" class="bd-link" data-shared-action="open" data-space-id="${escapeHtml(space.id)}">Abrir</button>`}</p>
    ${members.map((member) => row(member, finIsMe(member))).join("")}
    ${owner ? `<button type="button" class="bf-invite" data-members-invite>${bdIcon("plus")}<span>Convidar membro</span></button>
    <form class="fin-shared-invite-form bf-invite-form" data-space-id="${escapeHtml(space.id)}" hidden><input type="email" name="email" autocomplete="email" placeholder="E-mail para convidar" aria-label="E-mail para convidar" required><select name="role" aria-label="Permissão"><option value="editor">Pode editar</option><option value="viewer">Somente leitura</option></select><button type="submit">Convidar</button></form>` : ""}`;
}

function openFinSpacesManager(open = true, { create = false } = {}) {
  const manager = document.querySelector("#finSpacesManager");
  if (!manager) return;
  manager.hidden = !open;
  document.querySelector("#finSpacesManage")?.setAttribute("aria-expanded", String(open));
  if (open && create) {
    const form = document.querySelector("#finCreateSpaceForm");
    if (form) { form.hidden = false; requestAnimationFrame(() => document.querySelector("#finSharedSpaceName")?.focus()); }
  }
}

// ---------- Recorrências ----------
function finRecurNext(rec) {
  const [y, m] = todayIso.slice(0, 7).split("-").map(Number);
  for (let offset = 0; offset < 14; offset += 1) {
    const date = new Date(y, m - 1 + offset, 1);
    const key = toLocalIso(date).slice(0, 7);
    if (isRecurrentSkipped(rec, key)) continue;
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const iso = `${key}-${String(Math.min(Number(rec.day) || 1, last)).padStart(2, "0")}`;
    if (offset === 0) {
      const launched = (state.finances || []).some((f) => f.date?.startsWith(key) && f.description === rec.description && Number(f.amount) === Number(rec.amount) && (f.workspaceId || "personal") === (rec.workspaceId || "personal"));
      if (launched || iso < todayIso) continue;
    }
    return iso;
  }
  return "";
}

function finRecurIcon(rec) {
  const text = finNormalize(`${rec.description} ${rec.categoryId}`);
  if (rec.type === "receita") return /salario/.test(text) ? "calendar" : "wallet";
  if (/academia|gym|crossfit|pilates/.test(text)) return "dumbbell";
  if (/condom/.test(text)) return "building";
  if (/fatura|cartao/.test(text)) return "card";
  return bdRecurringIcon(rec) === "card" ? (FIN_CATEGORY_ICONS[rec.categoryId] || "repeat") : bdRecurringIcon(rec);
}

function finSetMore(key, visible, label) {
  document.querySelectorAll(`[data-auto-more="${key}"]`).forEach((button) => {
    button.hidden = !visible;
    button.firstChild.textContent = `${label} `;
  });
}
function finSetCount(key, value) { document.querySelectorAll(`[data-count="${key}"]`).forEach((el) => { el.textContent = String(value); }); }

function renderFinRecurrents() {
  renderRecurringSuggestions();
  const el = document.querySelector("#finRecurList");
  if (!el) return;
  const recurrents = (state.finRecurrents || []).filter(finInWs);
  finSetCount("recur", recurrents.length);
  finSetMore("recur", recurrents.length > FIN_AUTO_PREVIEW.recur, finAutoShowAll.recur ? "Mostrar menos" : "Ver todas");
  const nav = document.querySelector("#finNavRecur");
  if (nav) nav.textContent = recurrents.length ? finJoinNames(recurrents.slice(0, 4).map((r) => r.description)) + (recurrents.length > 4 ? "…" : "") : "Nenhuma cadastrada";
  if (!recurrents.length) {
    el.innerHTML = `<div class="bf-empty">${bdIcon("repeat")}<strong>Automatize o que se repete</strong><span>Assinaturas, salário, aluguel — cadastre uma vez e o lançamento entra sozinho no dia.</span></div>`;
    return;
  }
  const canEdit = canEditFinanceWorkspace();
  const list = finAutoShowAll.recur ? recurrents : recurrents.slice(0, FIN_AUTO_PREVIEW.recur);
  el.innerHTML = list.map((r) => {
    const paused = r.active === false;
    const skipped = !paused && isRecurrentSkipped(r, finActiveMonth);
    const next = paused ? "" : finRecurNext(r);
    return `<div class="bf-arow${paused ? " is-paused" : ""}" data-recur-id="${escapeHtml(r.id)}">
      <span class="bf-row-ico">${bdIcon(finRecurIcon(r))}</span>
      <strong class="bf-arow-name" title="${escapeHtml(r.description)}">${escapeHtml(r.description)}</strong>
      <span class="bf-chip ${paused ? "is-off" : skipped ? "is-warn" : "is-on"}">${paused ? "Pausada" : skipped ? "Pulada" : "Ativa"}</span>
      <span class="bf-arow-next">${next ? `Próx: ${finDayMonth(next)}` : paused ? "—" : `Dia ${r.day}`}</span>
      <b class="bf-amt is-${r.type === "receita" ? "in" : "out"}">${finSigned(r.type, r.amount)}</b>
      ${canEdit ? `<button type="button" class="bf-icon-btn" data-recur-pause="${escapeHtml(r.id)}" aria-label="${paused ? "Retomar" : "Pausar"} ${escapeHtml(r.description)}" title="${paused ? "Retomar" : "Pausar"}">${bdIcon(paused ? "play" : "pause")}</button>
      <button type="button" class="bf-icon-btn" data-recur-menu="${escapeHtml(r.id)}" aria-haspopup="true" aria-label="Mais ações">${bdIcon("dots-h")}</button>` : ""}
    </div>`;
  }).join("");
}

function toggleRecurrentPause(id) {
  const rec = (state.finRecurrents || []).find((r) => r.id === id);
  if (!rec || !requireFinanceWorkspaceEdit(rec.workspaceId || "personal")) return;
  rec.active = rec.active === false;
  finLogActivity("recurring", `Recorrência ${rec.active ? "retomada" : "pausada"}: ${rec.description}`, rec.workspaceId || "personal");
  saveState();
  renderFinances();
  showToast(rec.active ? `“${rec.description}” voltou a ser lançada automaticamente.` : `“${rec.description}” pausada. Nada será lançado até você retomar.`);
}

// ---------- Sugestões inteligentes ----------
function renderRecurringSuggestions() {
  const root = document.querySelector("#finRecurringSuggestions");
  if (!root) return;
  const suggestions = canEditFinanceWorkspace() ? recurringSuggestionsForWorkspace() : [];
  const count = suggestions.length;
  finSetCount("suggest", count);
  finSetMore("suggest", count > FIN_AUTO_PREVIEW.suggest, finAutoShowAll.suggest ? "Mostrar menos" : "Revisar todas");
  const text = count ? `${count} ${count === 1 ? "recorrência aguardando" : "recorrências aguardando"} confirmação.` : "Nenhuma sugestão pendente.";
  const action = document.querySelector("#finSuggestActionText");
  if (action) action.textContent = text;
  const nav = document.querySelector("#finNavSuggest");
  if (nav) nav.textContent = text.replace(/\.$/, "");
  if (!count) {
    root.innerHTML = `<div class="bf-empty">${bdIcon("sparkle")}<strong>Nenhuma sugestão agora</strong><span>Quando um gasto se repetir em meses diferentes, ele aparece aqui para virar recorrência.</span></div>`;
    return;
  }
  const list = finAutoShowAll.suggest ? suggestions : suggestions.slice(0, FIN_AUTO_PREVIEW.suggest);
  root.innerHTML = list.map((suggestion) => `<div class="bf-srow">
      <span class="bf-row-ico">${bdIcon("sparkle")}</span>
      <button type="button" class="bf-srow-copy" data-review-recurring="${escapeHtml(suggestion.key)}" title="Revisar antes de confirmar"><strong>${escapeHtml(suggestion.description)}</strong><small>Detectada ${suggestion.occurrences}x (${formatCurrency(suggestion.amount)})</small></button>
      <button type="button" class="bf-confirm" data-confirm-recurring="${escapeHtml(suggestion.key)}">Confirmar</button>
    </div>`).join("");
}

function confirmRecurringSuggestion(key) {
  if (!requireFinanceWorkspaceEdit()) return;
  const suggestion = recurringSuggestionsForWorkspace().find((item) => item.key === key);
  if (!suggestion) return renderRecurringSuggestions();
  state.finRecurrents ||= [];
  state.finRecurrents.push({
    id: crypto.randomUUID(), description: suggestion.description, amount: suggestion.amount, type: suggestion.type,
    categoryId: suggestion.categoryId || (suggestion.type === "receita" ? "outros_receita" : "outros"),
    day: suggestion.day, workspaceId: activeWorkspaceId, skippedMonths: [],
  });
  finLogActivity("suggestion", `Sugestão confirmada: ${suggestion.description}`);
  saveState();
  renderFinances();
  showToast(`“${suggestion.description}” virou recorrência (todo dia ${suggestion.day}).`);
}

// ---------- Contas agendadas ----------
function finScheduledItems() {
  const scheduled = (state.scheduledFinances || [])
    .filter((item) => finInWs(item) && !["cancelled", "paid"].includes(item.status) && item.date)
    .map((item) => ({ kind: "scheduled", id: item.id, date: item.date, description: item.description || "Conta agendada", amount: Number(item.amount) || 0, type: item.type === "receita" ? "receita" : "despesa", icon: /condom/.test(finNormalize(item.description)) ? "building" : finTxIcon({ description: item.description, category: item.categoryId || item.category }) }));
  const invoices = (state.creditCards || []).filter((card) => !card.archived && finInWs(card)).flatMap((card) =>
    (card.invoices || []).filter((invoice) => invoice.status !== "paid" && invoice.dueDate && Number(invoice.amount) > 0)
      .map((invoice) => ({ kind: "invoice", id: invoice.id, cardId: card.id, date: invoice.dueDate, description: `Fatura ${card.name}`, amount: Number(invoice.amount) || 0, type: "despesa", icon: "card" })));
  return [...scheduled, ...invoices].sort((a, b) => a.date.localeCompare(b.date));
}

function renderFinScheduled() {
  const root = document.querySelector("#finScheduledList");
  if (!root) return;
  const items = finScheduledItems();
  finSetCount("sched", items.length);
  finSetMore("sched", items.length > FIN_AUTO_PREVIEW.sched, finAutoShowAll.sched ? "Mostrar menos" : "Ver todas");
  const nav = document.querySelector("#finNavSched");
  if (nav) nav.textContent = items.length ? finJoinNames(items.slice(0, 3).map((item) => item.description)) : "Nada agendado";
  if (!items.length) {
    root.innerHTML = `<div class="bf-empty">${bdIcon("calendar")}<strong>Nada agendado</strong><span>Agende boletos e contas avulsas — eles entram na projeção do “Posso gastar?”.</span><button type="button" class="bf-ghost-btn" data-sched-new>${bdIcon("plus")}Agendar conta</button></div>`;
    return;
  }
  const list = finAutoShowAll.sched ? items : items.slice(0, FIN_AUTO_PREVIEW.sched);
  root.innerHTML = list.map((item) => {
    const late = item.date < todayIso;
    return `<button type="button" class="bf-row bf-sched" data-sched-kind="${item.kind}" data-sched-id="${escapeHtml(item.id)}"${item.cardId ? ` data-card-id="${escapeHtml(item.cardId)}"` : ""}>
      <span class="bf-row-ico">${bdIcon(item.icon)}</span>
      <span class="bf-row-copy"><strong>${escapeHtml(item.description)}</strong><small${late ? ' class="is-late"' : ""}>${late ? "Vencida" : "Venc"}: ${finDayMonth(item.date)}</small></span>
      <b class="bf-amt is-${item.type === "receita" ? "in" : "out"}">${finSigned(item.type, item.amount)}</b>
    </button>`;
  }).join("");
}

function openFinScheduledActions(button) {
  if (button.dataset.schedKind === "invoice") return openFinCardActions(button.dataset.cardId);
  const item = (state.scheduledFinances || []).find((entry) => entry.id === button.dataset.schedId);
  if (!item) return;
  const sub = `Vence em ${finDayMonth(item.date)} · ${finSigned(item.type, item.amount)}`;
  if (!canEditFinanceWorkspace(item.workspaceId || "personal")) return finActionSheet({ title: item.description, sub: `${sub} · somente leitura` });
  finActionSheet({ title: item.description, sub, actions: [
    { label: item.type === "receita" ? "Marcar como recebida" : "Marcar como paga", icon: "check", run: () => settleFinScheduled(item.id) },
    { label: "Cancelar agendamento", icon: "trash", danger: true, run: () => cancelFinScheduled(item.id) },
  ] });
}

function settleFinScheduled(id) {
  const item = (state.scheduledFinances || []).find((entry) => entry.id === id);
  if (!item || !requireFinanceWorkspaceEdit(item.workspaceId || "personal")) return;
  if (isMonthClosed(todayIso.slice(0, 7), item.workspaceId || "personal")) { showToast("O mês atual está fechado. Reabra-o para registrar o pagamento."); return; }
  state.finances ||= [];
  state.finances.unshift({
    id: crypto.randomUUID(), type: item.type === "receita" ? "receita" : "despesa", amount: Number(item.amount) || 0,
    category: item.categoryId || item.category || (item.type === "receita" ? "outros_receita" : "outros"),
    description: item.description, date: todayIso, workspaceId: item.workspaceId || "personal", scheduledId: item.id,
  });
  item.status = "paid";
  item.paidAt = new Date().toISOString();
  finLogActivity("scheduled", `Conta paga: ${item.description} (${formatCurrency(item.amount)})`, item.workspaceId || "personal");
  saveState();
  renderFinances();
  lastForecastFetchAt = 0;
  refreshDashboardForecast(true);
  showToast(`“${item.description}” registrada nos lançamentos de hoje.`);
}

function cancelFinScheduled(id) {
  const item = (state.scheduledFinances || []).find((entry) => entry.id === id);
  if (!item || !requireFinanceWorkspaceEdit(item.workspaceId || "personal")) return;
  if (!confirm(`Cancelar o agendamento “${item.description}”?`)) return;
  item.status = "cancelled";
  item.updatedAt = new Date().toISOString();
  saveState();
  renderFinances();
  showToast("Agendamento cancelado.");
}

function openFinSchedModal() {
  if (!requireFinanceWorkspaceEdit()) return;
  document.querySelector("#finSchedForm")?.reset();
  document.querySelector("#schedDate").value = offsetDate(7);
  syncFinCategoryOptions("#schedCategory", "despesa");
  finOpenModal("#finSchedModal");
}

function syncFinCategoryOptions(selector, type, selected = "") {
  const select = document.querySelector(selector);
  if (!select) return;
  select.innerHTML = getAllCategories(type).map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(finCatName(c.id))}</option>`).join("");
  if (selected && [...select.options].some((option) => option.value === selected)) select.value = selected;
}

function saveFinScheduled(event) {
  event.preventDefault();
  if (!requireFinanceWorkspaceEdit()) return;
  const description = valueOf("#schedDesc").trim();
  const amount = parseMoneyInput(valueOf("#schedAmount"));
  const date = valueOf("#schedDate");
  const type = valueOf("#schedType") === "receita" ? "receita" : "despesa";
  if (description.length < 2 || !amount || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast("Preencha descrição, valor e vencimento."); return; }
  state.scheduledFinances ||= [];
  state.scheduledFinances.push({ id: crypto.randomUUID(), description, amount, date, type, categoryId: valueOf("#schedCategory"), status: "scheduled", workspaceId: activeWorkspaceId, createdAt: new Date().toISOString() });
  finLogActivity("scheduled", `Conta agendada: ${description} (${finDayMonth(date)})`);
  saveState();
  renderFinances();
  lastForecastFetchAt = 0;
  refreshDashboardForecast(true);
  finCloseModal("#finSchedModal");
  showToast("Conta agendada.");
}

// ---------- Regras de automação ----------
function finRuleTitle(rule) {
  if (rule.name) return rule.name;
  return `Se a descrição contiver “${rule.match}”, classificar como ${rule.type === "receita" ? "receita" : "despesa"}`;
}

function finMatchRule(description) {
  const text = finNormalize(description);
  if (!text) return null;
  return (state.finRules || []).find((rule) => finInWs(rule) && rule.active !== false && rule.match && text.includes(finNormalize(rule.match))) || null;
}

// Aplica a primeira regra que combina com a descrição ao formulário.
function finApplyRuleToForm(description) {
  const rule = finMatchRule(description);
  if (!rule) { finPendingRuleId = ""; return null; }
  const type = rule.type === "receita" ? "receita" : "despesa";
  document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.toggle("active", b.dataset.finType === type));
  document.querySelector("#expenseType").value = type;
  document.querySelector(".fin-form-card")?.classList.toggle("is-receita", type === "receita");
  populateCategorySelect(rule.categoryId, type);
  finPendingRuleId = rule.id;
  return rule;
}

function renderFinRules() {
  const root = document.querySelector("#finRulesList");
  if (!root) return;
  const rules = (state.finRules || []).filter(finInWs);
  finSetCount("rules", rules.length);
  finSetMore("rules", rules.length > FIN_AUTO_PREVIEW.rules, finAutoShowAll.rules ? "Mostrar menos" : "Ver todas");
  const nav = document.querySelector("#finNavRules");
  if (nav) nav.textContent = rules.length ? `Ex.: ${finRuleTitle(rules[0])}` : "Nenhuma regra criada";
  if (!rules.length) {
    root.innerHTML = `<div class="bf-empty">${bdIcon("bolt")}<strong>Crie sua primeira regra</strong><span>Ex.: tudo que tiver “Uber” na descrição vira Transporte automaticamente.</span></div>`;
    return;
  }
  const canEdit = canEditFinanceWorkspace();
  const list = finAutoShowAll.rules ? rules : rules.slice(0, FIN_AUTO_PREVIEW.rules);
  root.innerHTML = list.map((rule) => {
    const paused = rule.active === false;
    return `<div class="bf-rrow${paused ? " is-paused" : ""}">
      <span class="bf-row-ico">${bdIcon(rule.type === "receita" ? "arrow-down" : "bolt")}</span>
      <span class="bf-row-copy"><strong>${escapeHtml(finRuleTitle(rule))}</strong><small>Categoria: ${escapeHtml(finCatName(rule.categoryId))}${rule.hits ? ` · usada ${rule.hits}x` : ""}</small></span>
      <span class="bf-chip ${paused ? "is-off" : "is-on"}">${paused ? "Pausada" : "Ativa"}</span>
      ${canEdit ? `<button type="button" class="bf-icon-btn" data-rule-pause="${escapeHtml(rule.id)}" aria-label="${paused ? "Retomar" : "Pausar"} regra" title="${paused ? "Retomar" : "Pausar"}">${bdIcon(paused ? "play" : "pause")}</button>
      <button type="button" class="bf-icon-btn" data-rule-menu="${escapeHtml(rule.id)}" aria-label="Mais ações">${bdIcon("dots-h")}</button>` : ""}
    </div>`;
  }).join("");
}

function openFinRuleModal(id = "") {
  if (!requireFinanceWorkspaceEdit()) return;
  const rule = (state.finRules || []).find((item) => item.id === id);
  document.querySelector("#finRuleForm")?.reset();
  document.querySelector("#ruleId").value = rule?.id || "";
  document.querySelector("#ruleMatch").value = rule?.match || "";
  document.querySelector("#ruleName").value = rule?.name || "";
  document.querySelector("#ruleType").value = rule?.type || "despesa";
  syncFinCategoryOptions("#ruleCategory", rule?.type || "despesa", rule?.categoryId);
  document.querySelector("#ruleDelete").hidden = !rule;
  document.querySelector("#finRuleModalTitle").textContent = rule ? "Editar regra" : "Nova regra";
  finOpenModal("#finRuleModal");
}

function saveFinRule(event) {
  event.preventDefault();
  if (!requireFinanceWorkspaceEdit()) return;
  const id = valueOf("#ruleId");
  const match = valueOf("#ruleMatch").trim();
  const type = valueOf("#ruleType") === "receita" ? "receita" : "despesa";
  const categoryId = valueOf("#ruleCategory");
  const name = valueOf("#ruleName").trim();
  if (match.length < 2 || !categoryId) { showToast("Informe o texto e a categoria da regra."); return; }
  state.finRules ||= [];
  const existing = state.finRules.find((rule) => rule.id === id);
  if (existing) Object.assign(existing, { match, type, categoryId, name, updatedAt: new Date().toISOString() });
  else state.finRules.push({ id: crypto.randomUUID(), match, type, categoryId, name, active: true, hits: 0, workspaceId: activeWorkspaceId, createdAt: new Date().toISOString() });
  saveState();
  renderFinRules();
  finCloseModal("#finRuleModal");
  showToast(existing ? "Regra atualizada." : "Regra criada! Ela vale para os próximos lançamentos.");
}

function deleteFinRule(id) {
  const rule = (state.finRules || []).find((item) => item.id === id);
  if (!rule || !requireFinanceWorkspaceEdit()) return;
  if (!confirm(`Excluir a regra “${finRuleTitle(rule)}”?`)) return;
  state.finRules = state.finRules.filter((item) => item.id !== id);
  saveState();
  renderFinRules();
  finCloseModal("#finRuleModal");
  showToast("Regra excluída.");
}

function toggleFinRule(id) {
  const rule = (state.finRules || []).find((item) => item.id === id);
  if (!rule || !requireFinanceWorkspaceEdit()) return;
  rule.active = rule.active === false;
  saveState();
  renderFinRules();
  showToast(rule.active ? "Regra retomada." : "Regra pausada.");
}

// ---------- Ingestão (WhatsApp, foto, áudio) ----------
function renderFinIngest() {
  const root = document.querySelector("#finIngestList");
  if (!root) return;
  const linked = Boolean(state.whatsappLinkedPhone);
  const rows = [
    { key: "whatsapp", icon: "whatsapp", title: "WhatsApp", sub: linked ? "Ativa • Lê gastos e recibos" : "Registre gastos mandando mensagem", chip: linked ? '<span class="bf-chip is-on">Conectado</span>' : '<span class="bf-chip is-link">Conectar</span>' },
    { key: "photo", icon: "camera", title: "Foto", sub: "Ativa • Lê notas e boletos", chip: '<span class="bf-chip is-on">Ativo</span>' },
    { key: "audio", icon: "mic", title: "Áudio", sub: linked ? "Pelo WhatsApp • Mande um áudio para o Pulsinho" : "Pelo WhatsApp • Conecte para lançar falando", chip: linked ? '<span class="bf-chip is-on">Ativo</span>' : '<span class="bf-chip is-link">Conectar</span>' },
  ];
  root.innerHTML = rows.map((row) => `<button type="button" class="bf-row bf-ingest" data-ingest="${row.key}">
      <span class="bf-row-ico${row.key === "whatsapp" ? " is-wa" : ""}">${bdIcon(row.icon)}</span>
      <span class="bf-row-copy"><strong>${row.title}</strong><small>${row.sub}</small></span>${row.chip}
    </button>`).join("");
}

function openFinIngest(key) {
  // Áudio é recebido pelo WhatsApp (o app não grava mais áudio).
  if (key === "whatsapp" || key === "audio") {
    setView("settings");
    requestAnimationFrame(() => document.querySelector("#whatsappLinkedBlock")?.closest("section, .panel, .settings-card")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return;
  }
  setFinBoardTab("lancamentos");
  requestAnimationFrame(() => document.querySelector("#finReceiptBtn")?.click());
}

// ---------- Fechamento mensal ----------
function renderFinAutoClose() {
  const root = document.querySelector("#finAutoCloseCard");
  if (!root) return;
  const auto = Boolean(state.financialSettings?.autoCloseMonth);
  const mode = document.querySelector("#finAutoCloseMode");
  if (mode) mode.textContent = auto ? "automático" : "manual";
  const nav = document.querySelector("#finNavClose");
  if (nav) nav.textContent = auto ? "Automático · todo dia 1" : "Manual · feche quando quiser";
  const monthKey = getActiveFinMonth();
  const closed = isMonthClosed(monthKey);
  const canEdit = canEditFinanceWorkspace();
  root.innerHTML = `<div class="bf-close-row">
      <span class="bf-row-ico">${bdIcon("calendar")}</span>
      <span class="bf-row-copy"><strong>Fechar mês e gerar resumo</strong><small>${auto ? "Todo dia 1, ao abrir o PulseNote" : "Ative para fechar o mês anterior sozinho"}</small></span>
      <button type="button" class="bf-chip bf-chip-toggle ${auto ? "is-on" : "is-off"}" id="finAutoCloseToggle" role="switch" aria-checked="${auto}"${canEdit ? "" : " disabled"}>${auto ? "Ativa" : "Desligada"}</button>
    </div>
    ${canEdit && !closed ? `<button type="button" class="bf-ghost-btn bf-close-now" data-close-now>${bdIcon("lock")}Fechar ${escapeHtml(finMonthLabel(monthKey))} agora</button>` : ""}`;
}

function renderFinClosures() {
  const el = document.querySelector("#finClosuresList");
  if (!el) return;
  const closures = (state.monthClosures || []).filter(finInWs).sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  if (!closures.length) { el.innerHTML = ""; return; }
  const canEdit = canEditFinanceWorkspace();
  const list = finClosuresShowAll ? closures : closures.slice(0, 2);
  el.innerHTML = `<span class="bf-closures-label">Meses fechados</span>${list.map((c) => `
    <div class="bf-closure">
      <span>${escapeHtml(finMonthShort(c.monthKey))}</span>
      <b class="${c.saldo >= 0 ? "is-in" : "is-out"}">${formatCurrency(c.saldo)}</b>
      <button type="button" class="bd-link" onclick="goToFinMonth('${c.monthKey}')">Ver</button>
      ${canEdit ? `<button type="button" class="bd-link" onclick="reopenMonth('${c.monthKey}')">Reabrir</button>` : ""}
    </div>`).join("")}${closures.length > 2 ? `<button type="button" class="bd-link bf-closures-more" data-closures-more>${finClosuresShowAll ? "Mostrar menos" : `Ver todos (${closures.length})`}</button>` : ""}`;
}

// Fecha o mês anterior sozinho quando a opção está ligada (roda ao abrir o app).
function autoCloseFinMonths() {
  if (!state.financialSettings?.autoCloseMonth) return;
  const previous = getPreviousMonthKey(todayIso.slice(0, 7));
  if (isMonthClosed(previous) || !canEditFinanceWorkspace()) return;
  const hasEntries = (state.finances || []).some((f) => f.date?.startsWith(previous) && finInWs(f));
  if (hasEntries) closeMonth(previous, { silent: true });
}

// ---------- Navegação mobile da Automação ----------
function setFinAutoSection(key = "") {
  finAutoOpen = key;
  const board = document.querySelector("#finAutoBoard");
  if (board) board.dataset.open = key;
  // O botão flutuante muda de ação conforme a seção: o nome acessível
  // acompanha (antes ficava sempre "Nova recorrência").
  const fab = document.querySelector("#finAutoFab");
  if (fab) {
    const label = { rules: "Nova regra", sched: "Agendar conta", suggest: "Revisar sugestões" }[key] || "Nova recorrência";
    fab.setAttribute("aria-label", label);
    fab.title = label;
  }
  if (key) requestAnimationFrame(() => document.querySelector(`[data-auto-sec="${key}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function renderFinAutomationExtras() {
  renderFinSavings();
  renderFinMembers();
  renderFinScheduled();
  renderFinRules();
  renderFinIngest();
  renderFinAutoClose();
  renderFinActivity();
}

function bindFinControlBoard() {
  if (bindFinControlBoard.bound) return;
  bindFinControlBoard.bound = true;
  const on = (selector, type, handler) => document.querySelector(selector)?.addEventListener(type, handler);

  // Metas financeiras
  on("#finOpenSavingsModal", "click", () => openFinSavingsModal());
  on("#finSavingsList", "click", (event) => {
    const row = event.target.closest("[data-savings-id]");
    if (row) openFinSavingsModal(row.dataset.savingsId);
    else if (event.target.closest("[data-savings-new]")) openFinSavingsModal();
  });
  on("#finSavingsForm", "submit", saveFinSavings);
  on("#savingsDepositBtn", "click", depositFinSavings);
  on("#savingsDelete", "click", deleteFinSavings);

  // Contas, cartões e membros
  on("#finAccountsList", "click", (event) => { const row = event.target.closest("[data-account-id]"); if (row) openFinAccountActions(row.dataset.accountId); });
  on("#finCardsList", "click", (event) => { const row = event.target.closest("[data-card-id]"); if (row) openFinCardActions(row.dataset.cardId); });
  on("#finSpacesManage", "click", () => openFinSpacesManager(document.querySelector("#finSpacesManager")?.hidden !== false));
  on("#finSpacesManagerClose", "click", () => openFinSpacesManager(false));
  on("#finSpacesManager", "click", (event) => { if (event.target.id === "finSpacesManager") openFinSpacesManager(false); });
  on("#finMembersList", "submit", inviteToFinanceSpace);
  on("#finMembersList", "click", (event) => {
    if (event.target.closest("[data-shared-action]")) return handleSharedSpaceAction(event);
    if (!event.target.closest("[data-members-invite]")) return;
    const form = document.querySelector("#finMembersList .bf-invite-form");
    if (form) { form.hidden = !form.hidden; if (!form.hidden) form.querySelector("input")?.focus(); }
    else openFinSpacesManager(true, { create: true });
  });

  // Automação
  on("#finOpenRuleModal", "click", () => openFinRuleModal());
  on("#finRuleForm", "submit", saveFinRule);
  on("#ruleDelete", "click", () => deleteFinRule(valueOf("#ruleId")));
  on("#ruleType", "change", () => syncFinCategoryOptions("#ruleCategory", valueOf("#ruleType")));
  on("#finRulesList", "click", (event) => {
    const pause = event.target.closest("[data-rule-pause]");
    if (pause) return toggleFinRule(pause.dataset.rulePause);
    const menu = event.target.closest("[data-rule-menu]");
    if (!menu) return;
    const rule = (state.finRules || []).find((item) => item.id === menu.dataset.ruleMenu);
    if (rule) finActionSheet({ title: finRuleTitle(rule), sub: `Categoria: ${finCatName(rule.categoryId)}`, actions: [
      { label: "Editar regra", icon: "pencil", run: () => openFinRuleModal(rule.id) },
      { label: "Excluir regra", icon: "trash", danger: true, run: () => deleteFinRule(rule.id) },
    ] });
  });
  on("#finOpenSchedModal", "click", openFinSchedModal);
  on("#finSchedForm", "submit", saveFinScheduled);
  on("#schedType", "change", () => syncFinCategoryOptions("#schedCategory", valueOf("#schedType")));
  on("#finScheduledList", "click", (event) => {
    if (event.target.closest("[data-sched-new]")) return openFinSchedModal();
    const row = event.target.closest("[data-sched-kind]");
    if (row) openFinScheduledActions(row);
  });
  on("#finRecurList", "click", (event) => {
    const pause = event.target.closest("[data-recur-pause]");
    if (pause) return toggleRecurrentPause(pause.dataset.recurPause);
    const menu = event.target.closest("[data-recur-menu]");
    if (menu) { event.stopPropagation(); openRecurrentActionMenu(menu, menu.dataset.recurMenu); }
  });
  on("#finRecurringSuggestions", "click", (event) => {
    const confirmBtn = event.target.closest("[data-confirm-recurring]");
    if (confirmBtn) return confirmRecurringSuggestion(confirmBtn.dataset.confirmRecurring);
    const review = event.target.closest("[data-review-recurring]");
    if (review) reviewRecurringSuggestion(review.dataset.reviewRecurring);
  });
  on("#finReviewSuggestions", "click", () => {
    if (window.matchMedia("(max-width: 760px)").matches) return setFinAutoSection("suggest");
    const section = document.querySelector('[data-auto-sec="suggest"]');
    section?.scrollIntoView({ behavior: "smooth", block: "center" });
    section?.classList.remove("is-flash");
    requestAnimationFrame(() => section?.classList.add("is-flash"));
  });
  on("#finIngestList", "click", (event) => { const row = event.target.closest("[data-ingest]"); if (row) openFinIngest(row.dataset.ingest); });
  on("#finAutoCloseCard", "click", (event) => {
    if (event.target.closest("[data-close-now]")) return closeMonth(getActiveFinMonth());
    if (!event.target.closest("#finAutoCloseToggle") || !requireFinanceWorkspaceEdit()) return;
    state.financialSettings ||= { safetyReserve: 0 };
    state.financialSettings.autoCloseMonth = !state.financialSettings.autoCloseMonth;
    saveState();
    renderFinAutoClose();
    if (state.financialSettings.autoCloseMonth) {
      showToast("Fechamento automático ligado: todo dia 1 o mês anterior é fechado com resumo.");
      autoCloseFinMonths();
    } else showToast("Fechamento automático desligado.");
  });
  on("#finClosuresList", "click", (event) => {
    if (!event.target.closest("[data-closures-more]")) return;
    finClosuresShowAll = !finClosuresShowAll;
    renderFinClosures();
  });
  document.querySelectorAll("[data-auto-more]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.autoMore;
    finAutoShowAll[key] = !finAutoShowAll[key];
    renderFinances();
  }));
  document.querySelectorAll("[data-auto-open]").forEach((button) => button.addEventListener("click", () => setFinAutoSection(button.dataset.autoOpen)));
  document.querySelectorAll("[data-auto-back]").forEach((button) => button.addEventListener("click", () => setFinAutoSection("")));
  on("#finAutoFab", "click", () => {
    if (finAutoOpen === "rules") return openFinRuleModal();
    if (finAutoOpen === "sched") return openFinSchedModal();
    if (finAutoOpen === "suggest") return setFinAutoSection("suggest");
    document.querySelector("#finOpenRecurModal")?.click();
  });
  // Mobile: o "Posso gastar?" da aba Controle abre/fecha tocando no título.
  document.querySelector("#finSimulatorCard .fin-simulator-copy")?.addEventListener("click", () => {
    const card = document.querySelector("#finSimulatorCard");
    if (!card?.closest('[data-sim-slot="controle"]') || !window.matchMedia("(max-width: 760px)").matches) return;
    card.classList.toggle("is-open");
    if (card.classList.contains("is-open")) document.querySelector("#finSimulatorAmount")?.focus();
  });
  if (isLocalDesignPreview && designPreviewMode !== "empty") {
    const simInput = document.querySelector("#finSimulatorAmount");
    if (simInput && !simInput.value) { simInput.value = "500,00"; runFinanceSimulation(); }
  }

  // Modais novos: fechar no X e no fundo
  for (const id of ["#finSavingsModal", "#finRuleModal", "#finSchedModal"]) {
    const modal = document.querySelector(id);
    modal?.addEventListener("click", (event) => { if (event.target === modal || event.target.closest("[data-modal-close]")) modal.hidden = true; });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const id of ["#finSavingsModal", "#finRuleModal", "#finSchedModal", "#finGoalsModal"]) finCloseModal(id);
    openFinSpacesManager(false);
  });

  // Regras: ao terminar de digitar a descrição, já sugere tipo e categoria.
  on("#expenseDescription", "change", (event) => {
    if (valueOf("#expenseId")) return;
    const rule = finMatchRule(event.target.value);
    if (rule && document.querySelector("#expenseCategory")?.dataset.userPicked !== "1") {
      finApplyRuleToForm(event.target.value);
      showToast(`Regra aplicada: ${finCatName(rule.categoryId)}.`);
      return;
    }
    finSuggestCategory(event.target.value);
  });
  // Enquanto digita: sugere em silêncio (o aviso aparece ao terminar).
  let finSuggestTimer = 0;
  on("#expenseDescription", "input", (event) => {
    window.clearTimeout(finSuggestTimer);
    finSuggestTimer = window.setTimeout(() => finSuggestCategory(event.target.value, { announce: false }), 500);
  });
}

// ============================================================
// LANÇAMENTOS RECORRENTES
// ============================================================
function recurringSuggestionsForWorkspace() {
  const detector = window.PulseRecurringDetector?.detectRecurringSuggestions;
  if (typeof detector !== "function") return [];
  return detector({
    finances: state.finances || [],
    recurrents: state.finRecurrents || [],
    workspaceId: activeWorkspaceId,
  });
}


function reviewRecurringSuggestion(key) {
  if (!requireFinanceWorkspaceEdit()) return;
  const suggestion = recurringSuggestionsForWorkspace().find((item) => item.key === key);
  if (!suggestion) {
    renderRecurringSuggestions();
    return;
  }

  document.querySelector("#finOpenRecurModal")?.click();
  const type = document.querySelector("#recurType");
  type.value = suggestion.type;
  type.dispatchEvent(new Event("change", { bubbles: true }));
  document.querySelector("#recurDesc").value = suggestion.description;
  document.querySelector("#recurAmount").value = String(suggestion.amount.toFixed(2));
  document.querySelector("#recurDay").value = String(suggestion.day);
  const category = document.querySelector("#recurCategory");
  if ([...category.options].some((option) => option.value === suggestion.categoryId)) {
    category.value = suggestion.categoryId;
  }
  document.querySelector("#recurDesc")?.focus();
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
  if (!requireFinanceWorkspaceEdit()) return;
  closeRecurrentActionMenu();
  const rec = (state.finRecurrents || []).find((r) => r.id === id);
  if (!rec) return;
  const skipped = isRecurrentSkipped(rec, finActiveMonth);

  const menu = document.createElement("div");
  menu.className = "fin-recur-menu";
  menu.innerHTML = `
    <button type="button" data-action="apply">${bdIcon("play")}<span>Lançar agora</span></button>
    <button type="button" data-action="toggleSkip">${skipped ? `${bdIcon("undo")}<span>Reativar neste mês</span>` : `${bdIcon("arrow-right")}<span>Pular este mês</span>`}</button>
    <button type="button" data-action="delete" class="danger">${bdIcon("trash")}<span>Excluir recorrência</span></button>
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
  if (!requireFinanceWorkspaceEdit(rec.workspaceId || "personal")) return;
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
  const rec = (state.finRecurrents || []).find((r) => r.id === id);
  if (!rec || !requireFinanceWorkspaceEdit(rec.workspaceId || "personal")) return;
  state.finRecurrents = (state.finRecurrents || []).filter((r) => r.id !== id);
  saveState();
  renderFinRecurrents();
  showToast("Recorrente removido.");
}

function applyRecurrent(id) {
  const rec = (state.finRecurrents || []).find((r) => r.id === id);
  if (!rec) return;
  if (!requireFinanceWorkspaceEdit(rec.workspaceId || "personal")) return;
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
    workspaceId: rec.workspaceId || "personal",
  });
  finLogActivity("recurring", `Recorrência lançada: ${rec.description} (${formatCurrency(rec.amount)})`, rec.workspaceId || "personal");
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
    if (!requireFinanceWorkspaceEdit()) return;
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
    state.finRecurrents.push({ id: crypto.randomUUID(), description: desc, amount, type, categoryId: catId, day, workspaceId: activeWorkspaceId, skippedMonths: [] });
    finLogActivity("recurring", `Recorrência criada: ${desc} (todo dia ${day})`);
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
  const [, , dd] = today.split("-").map(Number);
  let applied = false;
  let toastDelay = 0;
  (state.finRecurrents || []).forEach((rec) => {
    const workspaceId = rec.workspaceId || "personal";
    if (!canEditFinanceWorkspace(workspaceId)) return;
    if (isMonthClosed(monthKey, workspaceId)) return;
    if (rec.day !== dd) return;
    if (rec.active === false) return;
    if (isRecurrentSkipped(rec, monthKey)) return;
    const alreadyLaunched = (state.finances || []).some(
      (f) => f.date === today && f.description === rec.description && f.amount === rec.amount && (f.workspaceId || "personal") === workspaceId
    );
    if (alreadyLaunched) return;
    state.finances.unshift({
      id: crypto.randomUUID(),
      type: rec.type,
      amount: rec.amount,
      category: rec.categoryId,
      description: rec.description,
      date: today,
      workspaceId,
    });
    applied = true;
    finLogActivity("recurring", `Recorrência lançada: ${rec.description} (${formatCurrency(rec.amount)})`, workspaceId);
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
window.openNotesFormSheet = openNotesFormSheet;
window.openFinTxActions = openFinTxActions;
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
window.openPlannerEventActions = openPlannerEventActions;
window.submitGoalMilestoneForm = submitGoalMilestoneForm;
window.submitSubtaskForm = submitSubtaskForm;
window.updateGoalProgress = updateGoalProgress;

// Mesma causa raiz, encontrada durante a auditoria fora do Planner —
// corrigidas de brinde por serem idênticas e triviais (uma linha cada):
// "Editar perfil" no Perfil e os chips de pasta nas Notas também
// silenciosamente não faziam nada.
window.setView = setView;
window.setNotesFolderFilter = setNotesFolderFilter;

// Só no modo de demonstração (QA visual): injeta uma resposta do
// servidor no chat do Pulsinho sem login nem rede.
if (isLocalDesignPreview) {
  window.__pulsinhoPreview = (question, payload) => {
    pulsinhoConversation.push({ role: "user", content: question });
    handlePulsinhoPayload(payload);
  };
}

