// ============================================================
// PulseNote — Autenticação e sincronização via Firebase
// ============================================================
import { auth, db } from "./firebase-init.js";
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
  setDoc,
  deleteDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
  const isDark = choice === "aurora" || (choice !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const meta = document.getElementById("themeColorMeta");
  if (meta) meta.setAttribute("content", isDark ? "#060a18" : "#f5f7fa");
  // Mantém o <meta name="color-scheme"> alinhado ao tema escolhido, para que
  // selects, calendário nativo, barra de rolagem etc. nunca fiquem brancos
  // por cima de um app configurado como escuro (ver comentário no <head>).
  const csMeta = document.getElementById("colorSchemeMeta");
  if (csMeta) csMeta.setAttribute("content", isDark ? "dark" : "light");
}

function applyTheme(choice) {
  if (choice === "light" || choice === "aurora") {
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
    return t === "light" || t === "aurora" ? t : "system";
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

// Número (com DDI) do WhatsApp do PulseNote, mostrado em Configurações >
// Integrações. TROQUE pelo número real assim que ele estiver ativo —
// hoje aponta pro número de teste do Meta for Developers (Configuração
// da API > "De"). Formato livre, é só texto exibido pra pessoa.
const WHATSAPP_BOT_NUMBER = "+1 555 150 1087";

// Retorna a chave de cache ISOLADA para o usuário atual.
// Isso é essencial: sem isso, o navegador misturaria os dados em cache
// de contas diferentes logadas no mesmo dispositivo.
function getStorageKey() {
  return currentUser ? `${BASE_STORAGE_KEY}:${currentUser.uid}` : null;
}

let currentUser   = null;   // objeto do usuário logado (Firebase Auth)
let unsubscribeDoc = null;  // função para parar de "escutar" o Firestore
let syncTimer      = null;

// ── Helpers de usuário (substituem getToken/getUser antigos) ──
function getUser() {
  if (!currentUser) return null;
  return {
    id: currentUser.uid,
    name: currentUser.displayName || "Usuário",
    email: currentUser.email,
  };
}

// ── Indicador visual de status de sincronização ───────────────
// Agora clicável: se a última sincronização falhou, tocar/clicar no
// indicador tenta salvar de novo na hora (em vez de esperar o próximo
// debounce, que só dispara com uma nova alteração do usuário).
let _lastSyncStatus = "saved";
function showSyncStatus(status, detail) {
  let el = document.getElementById("syncStatus");
  if (!el) {
    el = document.createElement("div");
    el.id = "syncStatus";
    el.className = "sync-status";
    el.addEventListener("click", () => {
      if (_lastSyncStatus === "error" || _lastSyncStatus === "offline") {
        _syncRetries = 0;
        syncToServer();
      }
    });
    document.body.appendChild(el);
  }
  _lastSyncStatus = status;
  const states = {
    saving:  { text: "⏳ Salvando..." },
    saved:   { text: "✅ Salvo na nuvem" },
    offline: { text: "📵 Sem conexão — toque para tentar de novo" },
    error:   { text: `❌ ${detail || "Erro ao salvar"} — toque para tentar de novo` },
  };
  const s = states[status] || states.saved;
  el.textContent = s.text;
  el.dataset.status = status;
  el.classList.add("is-visible");
  el.classList.toggle("is-actionable", status === "error" || status === "offline");
  clearTimeout(showSyncStatus._hideTimer);
  if (status === "saved") {
    showSyncStatus._hideTimer = setTimeout(() => el.classList.remove("is-visible"), 1800);
  }
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

// Tradução de erros comuns do Firestore/Auth para algo que a pessoa
// consiga entender e agir (em vez de "Erro ao salvar" sem contexto).
function friendlySyncError(err) {
  const code = err?.code || "";
  if (code.includes("permission-denied")) return "Sem permissão para salvar. Faça login novamente";
  if (code.includes("unauthenticated")) return "Sessão expirada. Faça login novamente";
  if (code.includes("unavailable") || code.includes("network")) return "Sem conexão com o servidor";
  if (code.includes("resource-exhausted") || err?.message?.includes("exceeds the maximum")) return "Dados grandes demais para salvar";
  // Antes caía sempre em "Erro ao salvar" genérico, sem pista nenhuma do que
  // houve — quem visse o aviso não tinha como saber se era regra do
  // Firestore, dado inválido, etc. Agora mostra o motivo cru (código ou
  // mensagem original) junto, pra dar algo concreto para investigar.
  const raw = code || err?.message;
  return raw ? `Erro ao salvar (${raw})` : "Erro ao salvar";
}

// ── Salva o state atual no Firestore (documento do usuário) ───
// Guard triplo antes de qualquer escrita:
// 1. currentUser existe (usuário logado)
// 2. e-mail verificado (evita erros de permissão para contas não confirmadas)
// 3. state existe e é um objeto válido
// Sem esse guard, chamadas durante a inicialização (antes do onAuthStateChanged
// terminar) disparavam "Erro ao salvar" mesmo sem nenhuma ação do usuário.
let _syncRetries = 0;
async function syncToServer() {
  if (!currentUser || !currentUser.emailVerified || !state) return;

  // Documento único por usuário: se ele crescer demais (fotos grandes,
  // muitos anos de lançamentos), o Firestore recusa a escrita (limite de
  // 1 MiB por documento). Detectamos isso ANTES de tentar gravar, para
  // mostrar um aviso útil em vez de ficar tentando de novo sem sucesso.
  const clean = stripUndefinedDeep(state);
  const approxBytes = new Blob([JSON.stringify(clean)]).size;
  if (approxBytes > 900_000) {
    showSyncStatus("error", "Dados grandes demais para salvar (reduza a foto de perfil ou registros antigos)");
    const key = getStorageKey();
    if (key) localStorage.setItem(key, JSON.stringify(state));
    return;
  }

  showSyncStatus("saving");
  try {
    await setDoc(doc(db, "userData", currentUser.uid), {
      data: clean,
      updatedAt: new Date().toISOString(),
    });
    const key = getStorageKey();
    if (key) localStorage.setItem(key, JSON.stringify(state));
    showSyncStatus("saved");
    _syncRetries = 0; // reset ao ter sucesso
  } catch (err) {
    console.error("Erro ao salvar no Firestore:", err);
    const key = getStorageKey();
    if (key) localStorage.setItem(key, JSON.stringify(state)); // nunca perde o dado localmente
    if (!navigator.onLine) {
      showSyncStatus("offline");
      return;
    }
    // Retry com backoff exponencial (máx 3 tentativas, 2s/4s/8s)
    if (_syncRetries < 3) {
      _syncRetries++;
      const delay = Math.pow(2, _syncRetries) * 1000;
      showSyncStatus("saving"); // mantém "Salvando..." durante retry
      setTimeout(syncToServer, delay);
    } else {
      _syncRetries = 0;
      showSyncStatus("error", friendlySyncError(err));
    }
  }
}

function scheduleSyncToServer() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncToServer, 1200);
}

// Mostra avisos quando a conexão cai ou volta
window.addEventListener("offline", () => showSyncStatus("offline"));
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
    window.location.replace("login.html");
  }
}

// ── Guarda de autenticação + carregamento em tempo real ───────
// Esta é a peça central: o app só é exibido depois de confirmar
// que existe um usuário logado, e os dados vêm sempre do Firestore.
const appReady = new Promise((resolve) => {
  let resolved = false; // garante que resolve() é chamado apenas uma vez

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace("login.html");
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

    renderAll(); // mostra algo imediatamente (cache ou defaults) enquanto busca o Firestore

    const userDocRef = doc(db, "userData", user.uid);

    // onSnapshot escuta mudanças em tempo real no Firestore.
    // É chamado: (1) imediatamente com os dados atuais, (2) toda vez
    // que outro dispositivo/aba salvar algo novo para ESTE MESMO usuário.
    unsubscribeDoc = onSnapshot(
      userDocRef,
      (snapshot) => {
        if (snapshot.exists()) {
          const remote = snapshot.data().data;
          if (remote && typeof remote === "object") {
            state = normalizeState(remote);
            const k = getStorageKey();
            if (k) localStorage.setItem(k, JSON.stringify(state));
          }
        } else {
          // Documento ainda não existe no Firestore para este usuário
          // (primeiro login dele). Cria agora com os dados padrão/cache atual.
          setDoc(userDocRef, { data: stripUndefinedDeep(state), updatedAt: new Date().toISOString() })
            .catch((err) => {
              console.error("Erro ao criar documento inicial:", err);
              showSyncStatus("error", friendlySyncError(err));
            });
        }

        renderAll(); // re-renderiza com os dados confirmados do servidor

        if (!resolved) { resolved = true; resolve(); }
      },
      (err) => {
        console.error("Erro ao escutar Firestore:", err);
        showSyncStatus("error", friendlySyncError(err));
        if (!resolved) { resolved = true; resolve(); } // segue com cache local/defaults
      }
    );
  });
});

const statusList = ["Pendente", "Em andamento", "Concluida", "Cancelada"];
const viewTitles = {
  dashboard: "Seu dia em foco ✨",
  notes: "Anotações",
  tasks: "Tarefas",
  calendar: "Agenda",
  goals: "Metas e conquistas",
  finances: "Finanças",
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
  { id: "alimentacao", label: "🍔 Restaurante/Delivery", color: "#ff9500", group: "Alimentação" },
  { id: "mercado",     label: "🛒 Mercado",              color: "#ff9f0a", group: "Alimentação" },
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
  { id: "vendas",       label: "🏷️ Vendas",          color: "#ff9500", group: "Vendas" },
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

// O state começa com os valores padrão "de fábrica". Ele só é substituído
// pelos dados reais do usuário DEPOIS que o Firebase confirma o login
// (dentro do bloco onAuthStateChanged, em appReady) — nunca antes disso.
let state = loadDefaultState();

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
// Mês ativo na view de Finanças. Formato "YYYY-MM". Começa no mês atual.
let finActiveMonth = todayIso.slice(0, 7);

const elements = {
  viewTitle: document.querySelector("#viewTitle"),
  todayLabel: document.querySelector("#todayLabel"),
  globalSearch: document.querySelector("#globalSearch"),
  toast: document.querySelector("#toast"),
};

document.addEventListener("DOMContentLoaded", async () => {
  // Mostra overlay de carregamento enquanto o Firebase autentica
  const overlay = document.createElement("div");
  overlay.id = "appLoadingOverlay";
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;z-index:9998;background:var(--bg,#f5f7fa);
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">
      <div style="width:52px;height:52px;border-radius:16px;
        background:linear-gradient(145deg,#6c5ce7,#af52de);
        display:grid;place-items:center;font-size:1.5rem;
        box-shadow:0 6px 20px rgba(79,142,247,0.35)">⚡</div>
      <strong style="font-size:1.1rem;font-weight:800;color:var(--text,#1a1f2e);
        font-family:-apple-system,sans-serif">PulseNote</strong>
      <div style="width:32px;height:3px;border-radius:999px;
        background:var(--line,#e8ecf2);overflow:hidden">
        <div style="height:100%;border-radius:inherit;
          background:linear-gradient(90deg,#6c5ce7,#af52de);
          animation:loadingBar 1.2s ease-in-out infinite alternate;width:60%"></div>
      </div>
    </div>
    <style>@keyframes loadingBar{from{transform:translateX(-100%)}to{transform:translateX(180%)}}</style>
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
  const icon = hour < 12 ? "☀️" : hour < 18 ? "🌤️" : "🌙";
  const dateStr = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(now);

  const user = getUser();
  const firstName = user?.name?.split(" ")[0] || "Usuário";
  elements.todayLabel.textContent = `${greeting}, ${firstName} ${icon}  ·  ${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)}`;

  renderProfileButton(user);

  // Inicia o agendador de notificações (só dispara de fato se o
  // usuário já tiver concedido permissão anteriormente)
  if (window.startNotificationScheduler) window.startNotificationScheduler();

  // Atualiza os contadores "Faltam Xh Ymin" da Agenda a cada 30s, em tempo real
  setInterval(updateEventCountdowns, 30000);

  bindNavigation();
  bindForms();
  bindActions();
  bindSettingsView();
  bindThemeToggle();
  bindFinTabs();
  bindFinanceMonthControls();
  bindFinGoalsModal();
  bindFinRecurModal();
  bindGlobalPalette();
  autoApplyRecurrents();
  renderAll();
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
    ? `<img src="${photoURL}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="foto"/>`
    : initial;

  // O botão fica no topbar; o dropdown é anexado direto no <body> —
  // assim ele nunca fica "preso" num container estreito que quebra
  // o posicionamento no mobile (bug do print: dropdown cortado à esquerda).
  wrapper.innerHTML = `
    <button class="user-avatar-btn" id="profileBtn" title="${user?.name || "Perfil"}" style="overflow:hidden">
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
          ? `<img src="${photoURL}" style="width:100%;height:100%;object-fit:cover" alt=""/>`
          : initial}
      </div>
      <div style="min-width:0">
        <strong style="display:block;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${user?.name || "Usuário"}</strong>
        <span style="font-size:0.78rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block">${user?.email || ""}</span>
      </div>
    </div>
    <button class="dropdown-item" id="dropdownProfile">⚙️ Configurações</button>
    <button class="dropdown-item" id="dropdownNotifications">
      ${window.notificationsAreEnabled?.() ? "🔔 Notificações ativadas" : "🔕 Ativar notificações"}
    </button>
    <button class="dropdown-item danger" id="dropdownLogout">🚪 Sair da conta</button>
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
    showSyncStatus("saving");
    try { await syncToServer(); } finally { await logout(); }
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
    ? `<img src="${photoURL}" alt="Foto de perfil"/>`
    : initial;

  renderWhatsAppSettings();
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

  if (state.whatsappLinkedPhone) {
    linkedBlock.hidden   = false;
    unlinkedBlock.hidden = true;
    const phoneLabel = document.getElementById("whatsappLinkedPhoneLabel");
    if (phoneLabel) phoneLabel.textContent = `+${state.whatsappLinkedPhone}`;
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
      showSettingsMsg("✅ Foto atualizada!", "success");
      showToast("✅ Foto de perfil atualizada!");
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
      showSettingsMsg("✅ Nome atualizado!", "success");
      showToast("✅ Perfil atualizado!");
    } catch (err) {
      console.error("Erro ao salvar nome:", err);
      showSettingsMsg(`Erro ao salvar nome: ${err.message}`, "error");
    }
  });

  // ── Trocar senha ────────────────────────────────────────────────
  document.getElementById("settingsPasswordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideSettingsMsg();
    const currentPw = document.getElementById("settingsCurrentPw").value;
    const newPw     = document.getElementById("settingsNewPw").value;

    if (!currentPw) { showSettingsMsg("Informe a senha atual.", "error"); return; }
    if (!newPw || newPw.length < 6) { showSettingsMsg("A nova senha deve ter pelo menos 6 caracteres.", "error"); return; }

    try {
      const credential = EmailAuthProvider.credential(currentUser.email, currentPw);
      await reauthenticateWithCredential(currentUser, credential);
      await updatePassword(currentUser, newPw);

      document.getElementById("settingsCurrentPw").value = "";
      document.getElementById("settingsNewPw").value     = "";
      showSettingsMsg("✅ Senha alterada com sucesso!", "success");
      showToast("✅ Senha alterada!");
    } catch (err) {
      const messages = {
        "auth/wrong-password":        "Senha atual incorreta.",
        "auth/invalid-credential":    "Senha atual incorreta.",
        "auth/requires-recent-login": "Por segurança, faça login novamente antes de trocar a senha.",
        "auth/weak-password":         "A nova senha é muito fraca.",
      };
      showSettingsMsg(messages[err.code] || `Erro: ${err.message}`, "error");
    }
  });

  // ── Sair da conta ───────────────────────────────────────────────
  document.getElementById("settingsLogoutBtn").addEventListener("click", async () => {
    if (!confirm("Deseja sair da sua conta?")) return;
    await syncToServer();
    await logout();
  });

  // ── WhatsApp: gerar código de vinculação ──────────────────────────
  document.getElementById("settingsWhatsappGenerateBtn")?.addEventListener("click", () => {
    hideSettingsMsg();
    const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
    state.whatsappLinkCode = code;
    state.whatsappLinkCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min
    saveState();
    renderWhatsAppSettings();
    showToast("📲 Código gerado! Envie a mensagem pelo WhatsApp em até 10 minutos.");
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
      showSettingsMsg("✅ WhatsApp desvinculado.", "success");
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
    showToast("⬇️ Backup exportado!");
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
        showSettingsMsg("✅ Backup importado com sucesso!", "success");
        showToast("✅ Dados restaurados do backup!");
      } catch (err) {
        console.error("Erro ao importar backup:", err);
        showSettingsMsg("Não foi possível ler esse arquivo. Confira se é um backup válido do PulseNote.", "error");
      }
    };
    reader.readAsText(file);
  });

  // ── Excluir conta permanentemente ─────────────────────────────────
  document.getElementById("settingsDeleteAccountBtn")?.addEventListener("click", async () => {
    hideSettingsMsg();
    if (!confirm("Tem certeza que quer excluir sua conta? Todos os seus dados (notas, tarefas, agenda, metas e finanças) serão apagados PERMANENTEMENTE. Essa ação não pode ser desfeita.")) return;

    const pw = prompt("Por segurança, digite sua senha atual para confirmar a exclusão:");
    if (!pw) return;

    try {
      const credential = EmailAuthProvider.credential(currentUser.email, pw);
      await reauthenticateWithCredential(currentUser, credential);

      await deleteDoc(doc(db, "userData", currentUser.uid)).catch((err) => {
        console.warn("Não foi possível apagar os dados no Firestore (a conta será excluída mesmo assim):", err);
      });

      const key = getStorageKey();
      if (key) localStorage.removeItem(key);

      await deleteUser(currentUser);
      window.location.replace("login.html");
    } catch (err) {
      const messages = {
        "auth/wrong-password":        "Senha incorreta.",
        "auth/invalid-credential":    "Senha incorreta.",
        "auth/requires-recent-login": "Por segurança, saia e entre na conta novamente antes de excluí-la.",
      };
      showSettingsMsg(messages[err.code] || `Erro ao excluir conta: ${err.message}`, "error");
    }
  });
}

// Atualiza todos os pontos da UI que exibem o avatar do usuário.
// Se não houver foto, cai de volta para a inicial do nome (em vez de
// deixar um ícone de imagem quebrada).
function updateAllAvatars(photoURL) {
  const initial = (getUser()?.name || "U").charAt(0).toUpperCase();
  const content = photoURL
    ? `<img src="${photoURL}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" alt=""/>`
    : initial;
  const contentNoRadius = photoURL
    ? `<img src="${photoURL}" style="width:100%;height:100%;object-fit:cover" alt=""/>`
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
      ? `<img src="${photoURL}" alt="Foto de perfil"/>`
      : initial;
  }
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
  if (parsed.profilePhoto === undefined) parsed.profilePhoto = null;
  // Vínculo com WhatsApp (ver bindSettingsView > "Integrações" e
  // api/whatsapp-webhook.js): código de 6 dígitos gerado no app e
  // confirmado quando a pessoa manda "vincular 123456" pelo WhatsApp.
  if (parsed.whatsappLinkCode === undefined) parsed.whatsappLinkCode = null;
  if (parsed.whatsappLinkCodeExpiresAt === undefined) parsed.whatsappLinkCodeExpiresAt = null;
  if (parsed.whatsappLinkedPhone === undefined) parsed.whatsappLinkedPhone = null;
  // Retrocompatibilidade: lançamentos, tarefas e metas antigos não tinham
  // esses campos — garantimos que existam pra não quebrar o restante do app.
  parsed.tasks.forEach((t) => { if (!t.subtasks) t.subtasks = []; if (t.recurrence === undefined) t.recurrence = null; });
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
    whatsappLinkCode: null,
    whatsappLinkCodeExpiresAt: null,
    whatsappLinkedPhone: null,
  };
}

// Salva mudanças localmente de imediato e agenda o envio para o Firestore
// (debounce de 1.2s — evita gravar a cada tecla digitada, por exemplo)
function saveState() {
  const key = getStorageKey();
  if (key) localStorage.setItem(key, JSON.stringify(state));
  // Só agenda sync se já temos usuário autenticado e verificado.
  // Sem esse guard, calls do renderAll() durante inicialização
  // disparavam syncToServer() sem currentUser, causando erro de
  // permissão no Firestore e o banner "❌ Erro ao salvar".
  if (currentUser && currentUser.emailVerified) {
    scheduleSyncToServer();
  }
}


function createTask(title, status = "Pendente", priority = "Media", dueDate = todayIso, completedAt = "") {
  return {
    id: crypto.randomUUID(),
    title,
    status,
    priority,
    dueDate,
    createdAt: todayIso,
    completedAt,
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
    button.addEventListener("click", () => setView(button.dataset.viewShortcut));
  });
  initDashPanelCollapse();
}

// Painéis do início (Prioridades do dia, Próximos compromissos,
// Desempenho semanal, Foco da semana) podem ser minimizados — o estado
// fica salvo no localStorage por painel, então a tela continua do jeito
// que a pessoa deixou da última vez que abriu o app.
function initDashPanelCollapse() {
  document.querySelectorAll(".dash-panel").forEach((panel) => {
    const id = panel.dataset.panelId;
    const btn = panel.querySelector("[data-collapse-toggle]");
    if (!id || !btn) return;
    const storageKey = `pn_dash_collapsed_${id}`;
    const setCollapsed = (collapsed) => {
      panel.classList.toggle("is-collapsed", collapsed);
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.title = collapsed ? "Expandir" : "Minimizar";
    };
    setCollapsed(localStorage.getItem(storageKey) === "1");
    btn.addEventListener("click", () => {
      const collapsed = !panel.classList.contains("is-collapsed");
      setCollapsed(collapsed);
      localStorage.setItem(storageKey, collapsed ? "1" : "0");
    });
  });
}

function bindForms() {
  document.querySelector("#noteForm").addEventListener("submit", saveNote);
  document.querySelector("#resetNoteForm").addEventListener("click", resetNoteForm);
  document.querySelector("#noteFilter").addEventListener("change", renderNotes);
  bindNoteQuickControls();
  enableAutogrowTextareas();
  document.querySelector("#taskForm").addEventListener("submit", saveTask);
  document.querySelector("#eventForm").addEventListener("submit", saveEvent);
  document.querySelector("#goalForm").addEventListener("submit", saveGoal);
  document.querySelector("#quickAddTask").addEventListener("click", () => {
    setView("tasks");
    document.querySelector("#taskTitle").focus();
  });
  elements.globalSearch.addEventListener("input", renderAll);

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

function openPaletteResult(i) {
  const r = window.__paletteResults?.[i];
  if (!r) return;
  document.querySelector("#globalPaletteModal").hidden = true;
  setView(r.type);
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

function setView(view) {
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
  document.querySelector(`#${view}View`).classList.add("active-view");
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
}

function saveNote(event) {
  event.preventDefault();
  const id = document.querySelector("#noteId").value;
  const payload = {
    id: id || crypto.randomUUID(),
    title: valueOf("#noteTitle"),
    description: valueOf("#noteDescription"),
    category: valueOf("#noteCategory") || "Geral",
    folder: valueOf("#noteFolder") || "Entrada",
    tags: splitValues(valueOf("#noteTags")),
    priority: valueOf("#notePriority"),
    checklist: splitLines(valueOf("#noteChecklist")),
    attachments: splitValues(valueOf("#noteAttachments")),
    goal: valueOf("#noteGoal"),
    observations: valueOf("#noteObservations"),
    favorite: state.notes.find((note) => note.id === id)?.favorite || false,
    createdAt: state.notes.find((note) => note.id === id)?.createdAt || todayIso,
  };

  state.notes = id ? state.notes.map((note) => (note.id === id ? payload : note)) : [payload, ...state.notes];
  saveState();
  resetNoteForm();
  renderAll();
  showToast(id ? "Anotacao atualizada." : "Anotacao criada.");
}

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
      if (!confirm(`⚠️ Você já tem "${conflict.title}" às ${conflict.time} nesse dia, bem perto desse horário. Adicionar mesmo assim?`)) return;
    }
  }

  state.events.push({
    id: crypto.randomUUID(),
    title: valueOf("#eventTitle"),
    date,
    time,
    location: valueOf("#eventLocation") || "Sem local",
    reminder: Number(valueOf("#eventReminder")),
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
  if (!goal.milestones) goal.milestones = [];
  goal.milestones.push({ id: crypto.randomUUID(), title: title.trim(), done: false });
  saveState();
  renderGoals();
}

function toggleGoalMilestone(goalId, msId, event) {
  event?.stopPropagation();
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;
  goal.milestones = (goal.milestones || []).map((m) => (m.id === msId ? { ...m, done: !m.done } : m));
  saveState();
  renderGoals();
}

function deleteGoalMilestone(goalId, msId, event) {
  event?.stopPropagation();
  const goal = state.goals.find((g) => g.id === goalId);
  if (!goal) return;
  goal.milestones = (goal.milestones || []).filter((m) => m.id !== msId);
  saveState();
  renderGoals();
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

function resetNoteForm() {
  document.querySelector("#noteForm").reset();
  document.querySelector("#noteId").value = "";
  document.querySelector("#notePriority").value = "Media";
  document.querySelectorAll("#notePriorityPicker .note-priority-dot").forEach((d) =>
    d.classList.toggle("active", d.dataset.priority === "Media")
  );
  document.querySelector("#noteChecklistField").hidden = true;
  document.querySelector("#noteChecklistToggle").classList.remove("active");
  document.querySelector(".note-more-details").open = false;
  document.querySelectorAll("#noteForm textarea.autogrow").forEach((t) => (t.style.height = "auto"));
}

function bindNoteQuickControls() {
  // Seletor de prioridade por bolinhas coloridas (substitui o <select> visível)
  document.querySelectorAll("#notePriorityPicker .note-priority-dot").forEach((dot) => {
    dot.addEventListener("click", () => {
      document.querySelectorAll("#notePriorityPicker .note-priority-dot").forEach((d) => d.classList.remove("active"));
      dot.classList.add("active");
      document.querySelector("#notePriority").value = dot.dataset.priority;
    });
  });

  // Mostra/esconde o campo de checklist sob demanda
  const toggleBtn = document.querySelector("#noteChecklistToggle");
  const field = document.querySelector("#noteChecklistField");
  if (toggleBtn && field) {
    toggleBtn.addEventListener("click", () => {
      field.hidden = !field.hidden;
      toggleBtn.classList.toggle("active", !field.hidden);
      if (!field.hidden) document.querySelector("#noteChecklist").focus();
    });
  }
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

function renderAll() {
  setDefaultDates();
  renderDashboard();
  renderNotes();
  renderTasks();
  renderCalendar();
  renderGoals();
  renderFinances();
  renderSettings();
  refreshProfileAvatar();
}

function setDefaultDates() {
  document.querySelector("#taskDue").value ||= todayIso;
  document.querySelector("#eventDate").value ||= todayIso;
  document.querySelector("#eventTime").value ||= "09:00";
  const expDate = document.querySelector("#expenseDate");
  if (expDate) expDate.value ||= todayIso;
}

function queryFilter(items, fields) {
  const query = elements.globalSearch.value.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) => fields.some((field) => String(item[field] || "").toLowerCase().includes(query)));
}

function renderDashboard() {
  const doneToday = state.tasks.filter((task) => task.completedAt === todayIso).length;
  const doneTotal = state.tasks.filter((task) => task.status === "Concluida").length;
  const activeTasks = state.tasks.filter((task) => task.status !== "Cancelada");
  const progress = activeTasks.length ? Math.round((doneTotal / activeTasks.length) * 100) : 0;
  const nextEvents = state.events.filter((event) => event.date >= todayIso && event.date <= offsetDate(7));
  const score = doneTotal * 25 + state.goals.reduce((sum, goal) => sum + goal.current * 10, 0);

  // ── Resumo real do dia (sem gamificação) ──
  const pendingTasks = state.tasks.filter((t) => t.status === "Pendente" || t.status === "Em andamento").length;
  const monthKey = todayIso.slice(0, 7);
  const monthEntries = (state.finances || []).filter((f) => f.date.startsWith(monthKey));
  const monthReceitas = monthEntries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const monthDespesas = monthEntries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
  const monthSaldo = getCarryOverBalance(monthKey) + monthReceitas - monthDespesas;
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
  document.querySelector("#scoreMetric").textContent = score;
  const level = Math.max(1, Math.floor(score / 150) + 1);
  const levelProgress = Math.min(100, Math.round(((score % 150) / 150) * 100));
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
    ${entries.slice(0, 3).map((f) => {
      const cat = findCategory(f.category);
      const isReceita = f.type === "receita";
      return `<div class="connector-row"><span style="font-size:0.88rem;font-weight:600">${isReceita ? "💰" : cat.label.split(" ")[0]} ${escapeHtml(f.description)}</span><span style="font-weight:800;color:${isReceita ? "var(--green)" : "var(--red)"}">${isReceita ? "+" : "-"}${formatCurrency(f.amount)}</span></div>`;
    }).join("")}
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
      const label = new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(new Date(`${date}T12:00:00`));
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

function renderNotes() {
  const filter = document.querySelector("#noteFilter").value;
  const searchQuery = elements.globalSearch.value.trim();
  let notes = queryFilter(state.notes, ["title", "description", "category", "folder", "goal"]);
  if (filter === "favorite") notes = notes.filter((note) => note.favorite);
  if (["Alta", "Urgente"].includes(filter)) notes = notes.filter((note) => note.priority === filter);

  renderList(
    "#notesList",
    notes,
    (note) => {
      // Build checklist preview (max 3 items)
      const checklistHtml = note.checklist && note.checklist.length
        ? `<div class="checklist-preview">${note.checklist.slice(0, 3).map((item) =>
            `<div class="cl-item">
              <span class="cl-check">✓</span>
              <span class="cl-text">${escapeHtml(item)}</span>
            </div>`
          ).join("")}${note.checklist.length > 3 ? `<div class="cl-item"><span class="task-meta">+${note.checklist.length - 3} mais itens</span></div>` : ""}</div>`
        : "";

      const tagsHtml = note.tags && note.tags.length
        ? `<div class="tag-list">${note.tags.slice(0,3).map((t) => `<span class="pill">#${escapeHtml(t)}</span>`).join("")}</div>`
        : "";

      const words = (note.description || "").trim().split(/\s+/).filter(Boolean).length;
      const readingMin = Math.max(1, Math.round(words / 200));
      const wordCountHtml = words > 0 ? `<small class="task-meta" style="display:block;margin-top:2px">${words} palavras · ${readingMin} min de leitura</small>` : "";

      const titleHtml = highlightMatch(escapeHtml(note.title), searchQuery);
      const descHtml = note.description ? `<p>${highlightMatch(escapeHtml(note.description), searchQuery)}</p>` : "";

      return `
        <article class="note-card">
          <header>
            <div>
              <h3>${titleHtml}</h3>
              <div class="note-meta">${escapeHtml(note.category)} · ${formatDate(note.createdAt)}</div>
            </div>
            <button class="mini-button" onclick="toggleFavorite('${note.id}')" title="Favoritar" style="font-size:1.1rem;background:none;border:none;padding:0;width:30px;height:30px;display:grid;place-items:center;flex-shrink:0;border-radius:50%;">${note.favorite ? "⭐" : "☆"}</button>
          </header>
          ${descHtml}
          ${wordCountHtml}
          ${checklistHtml}
          ${tagsHtml}
          <div class="tag-list" style="margin-top:4px">
            <span class="priority-pill priority-${note.priority}">${note.priority}</span>
          </div>
          <div class="card-actions">
            <button onclick="editNote('${note.id}')">✏️ Editar</button>
            <button onclick="convertNoteToTask('${note.id}')">➡️ Tarefa</button>
            <button class="danger-action" onclick="deleteNote('${note.id}')" title="Excluir" aria-label="Excluir">🗑️</button>
          </div>
        </article>
      `;
    },
    "Nenhuma anotação encontrada. Crie a primeira! ✨"
  );
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
  if (note.checklist?.length) md += note.checklist.map((item) => `- [ ] ${item}`).join("\n") + "\n\n";
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
  document.querySelector("#noteId").value = note.id;
  document.querySelector("#noteTitle").value = note.title;
  document.querySelector("#noteDescription").value = note.description;
  document.querySelector("#noteCategory").value = note.category;
  document.querySelector("#noteFolder").value = note.folder;
  document.querySelector("#noteTags").value = note.tags.join(", ");
  document.querySelector("#notePriority").value = note.priority;
  document.querySelectorAll("#notePriorityPicker .note-priority-dot").forEach((d) =>
    d.classList.toggle("active", d.dataset.priority === note.priority)
  );
  document.querySelector("#noteChecklist").value = note.checklist.join("\n");
  document.querySelector("#noteAttachments").value = note.attachments.join(", ");
  document.querySelector("#noteGoal").value = note.goal;
  document.querySelector("#noteObservations").value = note.observations;

  // Mostra a checklist se a nota já tiver itens
  const hasChecklist = note.checklist && note.checklist.length > 0;
  document.querySelector("#noteChecklistField").hidden = !hasChecklist;
  document.querySelector("#noteChecklistToggle").classList.toggle("active", hasChecklist);

  // Abre "Mais detalhes" automaticamente se algum campo opcional já tiver valor
  const hasExtra = note.category || note.folder || (note.tags && note.tags.length) || note.goal || (note.attachments && note.attachments.length) || note.observations;
  document.querySelector(".note-more-details").open = Boolean(hasExtra);

  enableAutogrowTextareas();
  setView("notes");
  document.querySelector("#noteTitle").focus();
}

function toggleFavorite(id) {
  state.notes = state.notes.map((note) => (note.id === id ? { ...note, favorite: !note.favorite } : note));
  saveState();
  renderAll();
}

function convertNoteToTask(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  state.tasks.unshift({ ...createTask(note.title, "Pendente", note.priority, todayIso), sourceNoteId: note.id });
  saveState();
  renderAll();
  celebrate("Anotacao convertida em tarefa.");
}

function deleteNote(id) {
  state.notes = state.notes.filter((note) => note.id !== id);
  saveState();
  renderAll();
  showToast("Anotacao excluida.");
}

function renderTasks() {
  const tasks = queryFilter(state.tasks, ["title", "status", "priority", "dueDate"]);
  const board = document.querySelector("#taskBoard");
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
  const recIcon = task.recurrence ? "🔁" : "🔄";
  const recTitle = task.recurrence
    ? `Repete: ${{ diaria: "diariamente", semanal: "semanalmente", mensal: "mensalmente" }[task.recurrence]} (toque pra mudar)`
    : "Sem repetição (toque pra ativar)";
  return `
    <article class="task-row" data-task-id="${task.id}" draggable="true" ondragstart="dragTask('${task.id}')">
      <div class="task-row-top">
        <button class="task-check" onclick="toggleTask('${task.id}')" title="Concluir" style="${isDone ? "background:var(--green);border-color:var(--green);color:#fff;" : ""}">${isDone ? "✓" : ""}</button>
        <div class="task-title" style="${isDone ? "text-decoration:line-through;opacity:0.5;" : ""}" onclick="toggleTaskDetails('${task.id}', event)">${escapeHtml(task.title)}</div>
        <div class="task-row-actions">
          <button class="mini-button" onclick="cycleTaskRecurrence('${task.id}', event)" title="${recTitle}" style="padding:0;width:28px;height:28px;${task.recurrence ? "color:var(--accent);" : ""}">${recIcon}</button>
          <button class="mini-button" onclick="openTaskMoveMenu('${task.id}', event)" title="Mover para outra coluna" style="padding:0;width:28px;height:28px;">↔️</button>
          <button class="mini-button" onclick="deleteTask('${task.id}')" title="Excluir" style="padding:0;width:28px;height:28px;">🗑️</button>
        </div>
      </div>
      <div class="task-row-bottom">
        <span class="task-meta">📅 ${formatDate(task.dueDate)}</span>
        <span class="priority-pill priority-${task.priority}">${escapeHtml(task.priority)}</span>
        <span class="status-pill status-${task.status.replace(" ", "-")}">${task.status}</span>
        <button class="mini-button task-subtasks-toggle" onclick="toggleTaskDetails('${task.id}', event)" style="margin-left:auto;padding:2px 8px;font-size:0.7rem">☑ ${doneCount}/${subtasks.length}</button>
      </div>
      <div class="task-subtasks">
        ${subtasks.map((s) => `
          <div class="task-subtask-row">
            <button class="task-subtask-check ${s.done ? "done" : ""}" onclick="toggleSubtask('${task.id}','${s.id}', event)">${s.done ? "✓" : ""}</button>
            <span class="${s.done ? "done" : ""}">${escapeHtml(s.title)}</span>
            <button class="mini-button" onclick="deleteSubtask('${task.id}','${s.id}', event)" style="padding:0;width:22px;height:22px;margin-left:auto">✕</button>
          </div>`).join("") || `<div class="empty-state" style="padding:8px 0">Sem itens na checklist.</div>`}
        <button class="mini-button" onclick="addSubtask('${task.id}', event)" style="width:100%;margin-top:4px">+ Item da checklist</button>
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
            ${status === task.status ? "<span>✓</span>" : ""}
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
  const labels = { diaria: "Repete diariamente", semanal: "Repete semanalmente", mensal: "Repete mensalmente" };
  showToast(task.recurrence ? `🔁 ${labels[task.recurrence]}` : "Repetição desativada.");
}

// ── Subtarefas (checklist dentro da tarefa) ────────────────────
function toggleTaskDetails(id, event) {
  event?.stopPropagation();
  document.querySelector(`.task-row[data-task-id="${id}"] .task-subtasks`)?.classList.toggle("open");
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
}

function toggleSubtask(taskId, subId, event) {
  event?.stopPropagation();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.subtasks = (task.subtasks || []).map((s) => (s.id === subId ? { ...s, done: !s.done } : s));
  saveState();
  renderTasks();
}

function deleteSubtask(taskId, subId, event) {
  event?.stopPropagation();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.subtasks = (task.subtasks || []).filter((s) => s.id !== subId);
  saveState();
  renderTasks();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter((task) => task.id !== id);
  saveState();
  renderAll();
}

function renderCalendar() {
  const current = new Date();
  document.querySelector("#monthLabel").textContent = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
  }).format(current);

  const grid = document.querySelector("#calendarGrid");
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
  return `
    <article class="event-row" data-event-id="${event.id}">
      <div style="flex:1;min-width:0">
        <strong style="font-size:0.9rem">${escapeHtml(event.title)}</strong>
        <div class="event-meta">📅 ${formatDate(event.date)} às ${event.time} · 📍 ${escapeHtml(event.location)}</div>
      </div>
      <div class="tag-list" style="flex-shrink:0">
        <span class="event-countdown" data-event-date="${event.date}" data-event-time="${event.time}">${countdownLabel(event.date, event.time)}</span>
        <button class="mini-button" onclick="deleteEvent('${event.id}')" title="Excluir" style="padding:0;width:28px;height:28px">🗑️</button>
      </div>
    </article>
  `;
}

// Calcula quanto tempo falta (ou já passou) para um compromisso, em texto amigável.
function countdownLabel(date, time) {
  if (!date || !time) return "";
  const target = new Date(`${date}T${time}`);
  const diffMs = target - new Date();
  const diffMin = Math.round(diffMs / 60000);

  if (diffMin <= 0 && diffMin > -30) return "🔴 Agora";
  if (diffMin <= -30) {
    const hoursAgo = Math.round(Math.abs(diffMin) / 60);
    return hoursAgo >= 1 ? `⚠️ Atrasado ${hoursAgo}h` : `⚠️ Atrasado ${Math.abs(diffMin)}min`;
  }
  if (diffMin < 60) return `🟠 Faltam ${diffMin}min`;
  const hours = Math.floor(diffMin / 60);
  const minutes = diffMin % 60;
  if (hours < 24) return `🟢 Faltam ${hours}h${minutes ? ` ${minutes}min` : ""}`;
  const days = Math.floor(hours / 24);
  return `🟢 Faltam ${days} dia${days > 1 ? "s" : ""}`;
}

// Atualiza só o texto dos contadores já na tela, sem re-renderizar a lista inteira
// (evita perder scroll/seleção e é muito mais leve do que chamar renderCalendar a cada minuto).
function updateEventCountdowns() {
  document.querySelectorAll(".event-countdown").forEach((el) => {
    el.textContent = countdownLabel(el.dataset.eventDate, el.dataset.eventTime);
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
                <button class="goal-milestone-check ${m.done ? "done" : ""}" onclick="toggleGoalMilestone('${goal.id}','${m.id}', event)">${m.done ? "✓" : ""}</button>
                <span class="${m.done ? "done" : ""}">${escapeHtml(m.title)}</span>
                <button class="mini-button" onclick="deleteGoalMilestone('${goal.id}','${m.id}', event)" style="padding:0;width:20px;height:20px;margin-left:auto">✕</button>
              </div>`).join("")}
          </div>`
        : "";
      return `
        <article class="goal-card" data-goal-id="${goal.id}" style="${isComplete ? "border-color:var(--green);background:var(--green-soft);" : ""}">
          <div>
            <h2>${escapeHtml(goal.title)}</h2>
            <div class="task-meta">${goal.current}/${goal.target} etapas ${isComplete ? "🎉" : ""}${milestones.length ? ` · ${msDone}/${milestones.length} marcos` : ""}</div>
          </div>
          <div class="progress-track"><div style="width:${percent}%;background:${isComplete ? "var(--green)" : "linear-gradient(90deg,var(--accent),var(--purple))"}"></div></div>
          ${milestonesHtml}
          <div class="goal-controls">
            <button class="mini-button" onclick="changeGoal('${goal.id}', -1)">−</button>
            <span class="pill" style="${isComplete ? "background:var(--green);color:#fff;border-color:var(--green);" : ""}">${percent}%</span>
            <button class="mini-button" onclick="changeGoal('${goal.id}', 1)">+</button>
            <button class="mini-button" onclick="addGoalMilestone('${goal.id}', event)" title="Adicionar marco">🚩</button>
            <button class="mini-button" onclick="deleteGoal('${goal.id}')" style="margin-left:auto">🗑️</button>
          </div>
        </article>
      `;
    },
    elements.globalSearch.value.trim() ? "Nenhuma meta encontrada para essa busca." : "Nenhuma meta criada. Defina seu foco! 🎯"
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
  const done = state.tasks.filter((task) => task.status === "Concluida").length;
  const favorites = state.notes.filter((note) => note.favorite).length;
  const completedGoals = state.goals.filter((goal) => goal.current >= goal.target).length;
  const achievements = [
    { title: "Primeiro check-in", detail: "Concluir uma tarefa", icon: "🏅", unlocked: done >= 1 },
    { title: "Dia produtivo", detail: "Concluir três tarefas", icon: "🔥", unlocked: done >= 3 },
    { title: "Biblioteca viva", detail: "Favoritar uma anotação", icon: "⭐", unlocked: favorites >= 1 },
    { title: "Meta batida", detail: "Completar uma meta", icon: "🎯", unlocked: completedGoals >= 1 },
  ];
  document.querySelector("#achievementCount").textContent = `${achievements.filter((item) => item.unlocked).length}/${achievements.length}`;
  document.querySelector("#achievements").innerHTML = achievements
    .map(
      (item) => `
        <article class="achievement ${item.unlocked ? "unlocked" : ""}">
          <strong>${item.icon} ${item.title}${item.unlocked ? " ✓" : ""}</strong>
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

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(`${value}T12:00:00`));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 2200);
}
window.PulseNoteShowToast = showToast; // ponte para notifications.js (script externo ao módulo)

function celebrate(message) {
  showToast(message);
  const burst = document.createElement("div");
  burst.className = "celebration-burst";
  burst.innerHTML = "<span></span><span></span><span></span><span></span><span></span><span></span>";
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
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" })
    .format(new Date(year, month - 1, 1));
}

// Retorna true se o mês está marcado como "fechado" pelo usuário
function isMonthClosed(monthKey) {
  return (state.monthClosures || []).some((c) => c.monthKey === monthKey);
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
function getCarryOverBalance(monthKey) {
  const prevKey = getPreviousMonthKey(monthKey);
  const prevClosure = (state.monthClosures || []).find((c) => c.monthKey === prevKey);
  return prevClosure ? prevClosure.saldo : 0;
}

// Registra o fechamento do mês ativo com um snapshot completo do período
function closeMonth(monthKey) {
  if (!state.monthClosures) state.monthClosures = [];
  if (isMonthClosed(monthKey)) { showToast("✓ Mês já fechado."); return; }

  const entries = (state.finances || []).filter((f) => f.date.startsWith(monthKey));
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

  if (!confirm(`Fechar ${finMonthLabel(monthKey)}?\nReceitas: ${formatCurrency(receitas)}\nDespesas: ${formatCurrency(despesas)}\n${detalheSaldo}\n\nEsse saldo será somado automaticamente ao mês seguinte. Depois de fechar, não será possível adicionar ou editar lançamentos neste mês sem reabri-lo.`)) return;

  state.monthClosures.push({
    monthKey,
    closedAt: new Date().toISOString(),
    receitas,
    despesas,
    saldo: saldoFinal, // acumulado — é o que entra no mês seguinte
    entriesCount: entries.length,
  });
  saveState();
  renderFinances();
  showToast(`🔒 ${finMonthLabel(monthKey)} fechado com sucesso!`);
}

// Remove o fechamento do mês (reabre para edições)
function reopenMonth(monthKey) {
  if (!isMonthClosed(monthKey)) return;
  if (!confirm(`Reabrir ${finMonthLabel(monthKey)} para edição?`)) return;
  state.monthClosures = (state.monthClosures || []).filter((c) => c.monthKey !== monthKey);
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
    .filter((f) => f.date.startsWith(monthKey))
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
function exportMonthReport(monthKey) {
  const entries = (state.finances || []).filter((f) => f.date.startsWith(monthKey))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) {
    showToast("Nenhum lançamento no período para exportar.");
    return;
  }

  const label    = finMonthLabel(monthKey);
  const isClosed = isMonthClosed(monthKey);
  const userName = (getUser()?.name || "Usuário").split(" ").slice(0, 2).join(" ");
  const geradoEm = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long", year: "numeric" }).format(new Date());

  const receitas = entries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const despesas = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
  const saldo    = receitas - despesas;
  const savings  = receitas > 0 ? ((saldo / receitas) * 100).toFixed(1) : "0";
  const usedPct  = receitas > 0 ? Math.min(100, Math.round((despesas / receitas) * 100)) : 0;

  // Agrupamento por categoria (despesas)
  const byCat = {};
  entries.filter((f) => f.type === "despesa").forEach((f) => {
    const cat = findCategory(f.category);
    if (!byCat[f.category]) byCat[f.category] = { label: cat.label.replace(/^\S+\s*/, ""), icon: cat.label.split(" ")[0], color: cat.color, total: 0, count: 0 };
    byCat[f.category].total += f.amount;
    byCat[f.category].count++;
  });
  const catList = Object.values(byCat).sort((a, b) => b.total - a.total);

  // Top 5 maiores transações
  const topTx = [...entries].sort((a, b) => b.amount - a.amount).slice(0, 5);

  // Histórico 6 meses (para o gráfico de barras SVG)
  const months6 = [];
  const [ay, am] = monthKey.split("-").map(Number);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(ay, am - 1 - i, 1);
    const mk = toLocalIso(d).slice(0, 7);
    const me = (state.finances || []).filter((f) => f.date.startsWith(mk));
    const mr = me.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
    const md = me.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
    const lbl = new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(d);
    months6.push({ mk, lbl, r: mr, d: md });
  }
  const maxVal = Math.max(...months6.flatMap((m) => [m.r, m.d]), 1);

  // SVG do gráfico de barras
  const barW = 28; const gap = 4; const gW = barW * 2 + gap; const pH = 120; const pPad = 16;
  const svgBars = months6.map((m, i) => {
    const x     = pPad + i * (gW + 14);
    const rH    = Math.max(3, (m.r / maxVal) * pH);
    const dH    = Math.max(3, (m.d / maxVal) * pH);
    const isAct = m.mk === monthKey;
    return `<rect x="${x}" y="${pH + pPad - rH}" width="${barW}" height="${rH}" rx="3" fill="${isAct ? "#34c759" : "#d1fae5"}"/>
      <rect x="${x + barW + gap}" y="${pH + pPad - dH}" width="${barW}" height="${dH}" rx="3" fill="${isAct ? "#ff3b30" : "#fee2e2"}"/>
      <text x="${x + barW}" y="${pH + pPad + 14}" text-anchor="middle" font-size="9" fill="#8a9bb0">${m.lbl}</text>`;
  }).join("");
  const chartSvg = `<svg viewBox="0 0 ${pPad*2 + months6.length*(gW+14)} ${pH+pPad+20}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">${svgBars}</svg>`;

  // Donut SVG (categorias)
  let donutSvg = "";
  if (catList.length && despesas > 0) {
    const cx = 70; const cy = 70; const r = 55; const iR = 35;
    let angle = -Math.PI / 2;
    const segments = catList.slice(0, 6).map((c) => {
      const slice = (c.total / despesas) * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle); const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + slice); const y2 = cy + r * Math.sin(angle + slice);
      const xi1 = cx + iR * Math.cos(angle + slice); const yi1 = cy + iR * Math.sin(angle + slice);
      const xi2 = cx + iR * Math.cos(angle); const yi2 = cy + iR * Math.sin(angle);
      const large = slice > Math.PI ? 1 : 0;
      const path = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${xi1} ${yi1} A ${iR} ${iR} 0 ${large} 0 ${xi2} ${yi2} Z`;
      angle += slice;
      return `<path d="${path}" fill="${c.color}"/>`;
    }).join("");
    donutSvg = `<svg viewBox="0 0 140 140" xmlns="http://www.w3.org/2000/svg" style="width:140px;height:140px">${segments}<text x="70" y="66" text-anchor="middle" font-size="10" fill="#8a9bb0">Total</text><text x="70" y="80" text-anchor="middle" font-size="12" font-weight="700" fill="#1a1f2e">${formatCurrency(despesas).replace("R$","")}</text></svg>`;
  }

  // Recorrentes do usuário para a seção de assinaturas
  const recurrents = (state.finRecurrents || []).filter((r) => r.type === "despesa");

  // Metas e quanto foi usado
  const goals = (state.finGoals || []).map((g) => {
    const cat = findCategory(g.categoryId);
    const spent = byCat[g.categoryId]?.total || 0;
    const pct = g.limit > 0 ? Math.min(150, Math.round((spent / g.limit) * 100)) : 0;
    return { ...g, cat, spent, pct };
  });

  const htmlContent = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<title>Relatório PulseNote — ${label}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;background:#fff;color:#1a1f2e;font-size:13px;line-height:1.5}
  .page{max-width:900px;margin:0 auto;padding:40px 40px 60px}
  /* Header */
  .rpt-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:20px;border-bottom:3px solid #6c5ce7}
  .rpt-brand{display:flex;align-items:center;gap:12px}
  .rpt-brand-mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(145deg,#6c5ce7,#af52de);display:grid;place-items:center;font-size:1.4rem}
  .rpt-brand-name{font-size:1.2rem;font-weight:800;color:#1a1f2e}
  .rpt-brand-sub{font-size:0.72rem;color:#8a9bb0;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  .rpt-header-right{text-align:right}
  .rpt-month{font-size:1.4rem;font-weight:800;color:#6c5ce7}
  .rpt-meta{font-size:0.72rem;color:#8a9bb0;line-height:1.8}
  /* Secção */
  .section{margin-bottom:28px}
  .section-title{font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#8a9bb0;margin-bottom:12px}
  /* Resumo: 4 cards */
  .summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}
  .summary-card{border:1.5px solid #e8ecf2;border-radius:14px;padding:14px 16px}
  .summary-card .lbl{font-size:0.7rem;text-transform:uppercase;letter-spacing:.06em;font-weight:700;color:#8a9bb0;margin-bottom:4px}
  .summary-card .val{font-size:1.35rem;font-weight:800;letter-spacing:-0.03em}
  .green{color:#34c759}.red{color:#ff3b30}.blue{color:#6c5ce7}
  /* Barra */
  .bar-wrap{background:#f0f4f8;border-radius:999px;height:8px;overflow:hidden;margin:4px 0}
  .bar-fill{height:100%;border-radius:inherit;transition:width .3s}
  /* Gráfico 6 meses */
  .chart-section{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:center;margin-bottom:28px;border:1.5px solid #e8ecf2;border-radius:16px;padding:20px}
  /* Categorias */
  .cat-section{display:grid;grid-template-columns:140px 1fr;gap:20px;align-items:center;margin-bottom:28px;border:1.5px solid #e8ecf2;border-radius:16px;padding:20px}
  .cat-list{display:grid;gap:8px}
  .cat-row{display:flex;align-items:center;gap:8px}
  .cat-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .cat-name{flex:1;font-size:0.82rem;font-weight:600}
  .cat-pct{font-size:0.75rem;color:#8a9bb0;width:38px;text-align:right;flex-shrink:0}
  .cat-val{font-size:0.82rem;font-weight:700;color:#ff3b30;width:78px;text-align:right;flex-shrink:0}
  /* Tabela de lançamentos: o wrapper (.tbl-scroll) rola na horizontal em
     telas estreitas em vez de deixar a tabela espremer/cortar conteúdo —
     min-width garante que colunas não fiquem ilegíveis nem quebrem linha
     no meio de um valor, mas a descrição trunca com "..." se for longa. */
  .tbl-scroll{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{width:100%;min-width:520px;border-collapse:collapse;font-size:0.8rem}
  thead tr{background:#f0f4f8}
  th{padding:8px 10px;text-align:left;font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8a9bb0;white-space:nowrap}
  td{padding:9px 10px;border-top:1px solid #f0f4f8}
  td:nth-child(2){max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  td:last-child, th:last-child{white-space:nowrap}
  .badge{display:inline-block;border-radius:999px;padding:2px 8px;font-size:0.68rem;font-weight:700;white-space:nowrap}
  .badge-r{background:#e5f9ec;color:#34c759}
  .badge-d{background:#ffeeed;color:#ff3b30}
  /* Metas */
  .goal-row{margin-bottom:10px}
  .goal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:10px}
  .goal-name{font-size:0.82rem;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .goal-val{font-size:0.78rem;color:#8a9bb0;white-space:nowrap;flex-shrink:0}
  .goal-val.over{color:#ff3b30;font-weight:700}
  /* Recorrentes */
  .recur-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .recur-card{border:1.5px solid #e8ecf2;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:4px;min-width:0}
  .recur-card strong{font-size:0.88rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .recur-card span{font-size:0.72rem;color:#8a9bb0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .recur-card .rv{font-size:1rem;font-weight:800;color:#ff3b30}
  /* Footer */
  .rpt-footer{margin-top:36px;padding-top:16px;border-top:1px solid #e8ecf2;display:flex;justify-content:space-between;align-items:center;font-size:0.7rem;color:#8a9bb0;flex-wrap:wrap;gap:8px}

  /* ---- Responsivo: relatório aberto/impresso a partir do celular ---- */
  @media (max-width: 680px) {
    .page{padding:24px 16px 40px}
    .rpt-header{flex-direction:column;gap:14px}
    .rpt-header-right{text-align:left}
    .summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
    .chart-section{grid-template-columns:1fr}
    .cat-section{grid-template-columns:1fr}
    .recur-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
    td:nth-child(2){max-width:140px}
  }
  @media (max-width: 420px) {
    .summary-grid{grid-template-columns:1fr}
    .recur-grid{grid-template-columns:1fr}
  }
  /* Print */
  @media print{
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .page{padding:20px 24px 40px}
    .summary-grid{grid-template-columns:repeat(4,1fr)}
  }
  @page{margin:15mm;size:A4}
</style>
</head>
<body>
<div class="page">

  <!-- CABEÇALHO -->
  <div class="rpt-header">
    <div class="rpt-brand">
      <div class="rpt-brand-mark">⚡</div>
      <div>
        <div class="rpt-brand-name">PulseNote</div>
        <div class="rpt-brand-sub">Relatório Financeiro Mensal</div>
      </div>
    </div>
    <div class="rpt-header-right">
      <div class="rpt-month">${label}</div>
      <div class="rpt-meta">
        Titular <strong>${escapeHtml(userName)}</strong><br>
        ${isClosed ? "✓ Mês fechado" : "Em aberto"} · Gerado em ${geradoEm}
      </div>
    </div>
  </div>

  <!-- RESUMO: 4 CARDS -->
  <div class="summary-grid">
    <div class="summary-card">
      <div class="lbl">Saldo do mês</div>
      <div class="val ${saldo >= 0 ? "green" : "red"}">${formatCurrency(saldo)}</div>
    </div>
    <div class="summary-card">
      <div class="lbl">Receitas</div>
      <div class="val green">${formatCurrency(receitas)}</div>
    </div>
    <div class="summary-card">
      <div class="lbl">Despesas</div>
      <div class="val red">${formatCurrency(despesas)}</div>
    </div>
    <div class="summary-card">
      <div class="lbl">Taxa de poupança</div>
      <div class="val blue">${savings}%</div>
    </div>
  </div>

  <!-- GRÁFICO 6 MESES -->
  <div class="section">
    <div class="section-title">Receitas × Despesas — Últimos 6 meses</div>
    <div class="chart-section">
      <div style="flex:1">${chartSvg}</div>
      <div style="display:grid;gap:8px">
        <div style="display:flex;align-items:center;gap:6px;font-size:0.78rem">
          <span style="width:12px;height:12px;border-radius:3px;background:#34c759;display:inline-block"></span> Receitas
        </div>
        <div style="display:flex;align-items:center;gap:6px;font-size:0.78rem">
          <span style="width:12px;height:12px;border-radius:3px;background:#ff3b30;display:inline-block"></span> Despesas
        </div>
        <div style="margin-top:8px;font-size:0.72rem;color:#8a9bb0">Mês atual destacado</div>
      </div>
    </div>
  </div>

  <!-- DISTRIBUIÇÃO POR CATEGORIA -->
  ${catList.length ? `
  <div class="section">
    <div class="section-title">Para onde foi o dinheiro — R$ ${formatCurrency(despesas).replace("R$ ","")} em despesas</div>
    <div class="cat-section">
      <div>${donutSvg}</div>
      <div class="cat-list">
        ${catList.slice(0, 8).map((c) => {
          const pct = despesas > 0 ? ((c.total / despesas) * 100).toFixed(1) : 0;
          const barPct = Math.min(100, Math.round(c.total / despesas * 100));
          return `<div class="cat-row">
            <span class="cat-dot" style="background:${c.color}"></span>
            <span class="cat-name">${c.icon} ${escapeHtml(c.label)}</span>
            <span class="cat-pct">${pct}%</span>
            <div style="flex:1;min-width:60px"><div class="bar-wrap"><div class="bar-fill" style="width:${barPct}%;background:${c.color}"></div></div></div>
            <span class="cat-val">${formatCurrency(c.total)}</span>
          </div>`;
        }).join("")}
      </div>
    </div>
  </div>` : ""}

  <!-- METAS POR CATEGORIA -->
  ${goals.length ? `
  <div class="section">
    <div class="section-title">Metas de gasto por categoria</div>
    <div style="border:1.5px solid #e8ecf2;border-radius:16px;padding:20px">
      ${goals.map((g) => {
        const barColor = g.pct > 100 ? "#ff3b30" : g.pct > 80 ? "#ff9500" : "#34c759";
        return `<div class="goal-row">
          <div class="goal-header">
            <span class="goal-name">${g.cat.label}</span>
            <span class="goal-val ${g.pct > 100 ? "over" : ""}">${formatCurrency(g.spent)} / ${formatCurrency(g.limit)} (${g.pct}%)</span>
          </div>
          <div class="bar-wrap"><div class="bar-fill" style="width:${Math.min(100,g.pct)}%;background:${barColor}"></div></div>
        </div>`;
      }).join("")}
    </div>
  </div>` : ""}

  <!-- TOP TRANSAÇÕES -->
  <div class="section">
    <div class="section-title">Maiores transações do mês</div>
    <div style="border:1.5px solid #e8ecf2;border-radius:16px;overflow:hidden">
      <div class="tbl-scroll">
      <table>
        <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th style="text-align:right">Valor</th></tr></thead>
        <tbody>
          ${topTx.map((f) => {
            const cat = findCategory(f.category);
            const isRec = f.type === "receita";
            return `<tr>
              <td>${formatDate(f.date)}</td>
              <td style="font-weight:600">${escapeHtml(f.description || "")}</td>
              <td>${cat.label}</td>
              <td><span class="badge ${isRec ? "badge-r" : "badge-d"}">${isRec ? "Receita" : "Despesa"}</span></td>
              <td style="text-align:right;font-weight:700;color:${isRec ? "#34c759" : "#ff3b30"}">${isRec ? "+" : "-"}${formatCurrency(f.amount)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- TODOS OS LANÇAMENTOS -->
  <div class="section">
    <div class="section-title">Todos os lançamentos (${entries.length})</div>
    <div style="border:1.5px solid #e8ecf2;border-radius:16px;overflow:hidden">
      <div class="tbl-scroll">
      <table>
        <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th style="text-align:right">Valor</th></tr></thead>
        <tbody>
          ${entries.map((f) => {
            const cat = findCategory(f.category);
            const isRec = f.type === "receita";
            return `<tr>
              <td>${formatDate(f.date)}</td>
              <td>${escapeHtml(f.description || "")}</td>
              <td>${cat.label.replace(/^\S+\s*/, "")}</td>
              <td><span class="badge ${isRec ? "badge-r" : "badge-d"}">${isRec ? "R" : "D"}</span></td>
              <td style="text-align:right;font-weight:700;color:${isRec ? "#34c759" : "#ff3b30"}">${isRec ? "+" : "-"}${formatCurrency(f.amount)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- RECORRENTES -->
  ${recurrents.length ? `
  <div class="section">
    <div class="section-title">Lançamentos recorrentes cadastrados</div>
    <div class="recur-grid">
      ${recurrents.map((r) => {
        const cat = findCategory(r.categoryId);
        return `<div class="recur-card">
          <strong>${escapeHtml(r.description)}</strong>
          <span>${cat.label} · Dia ${r.day}</span>
          <span class="rv">-${formatCurrency(r.amount)}/mês</span>
        </div>`;
      }).join("")}
    </div>
  </div>` : ""}

  <!-- FOOTER -->
  <div class="rpt-footer">
    <span>PulseNote · pulsenote.app</span>
    <span>Gerado em ${geradoEm}</span>
  </div>

</div>
<script>window.onload = () => window.print();</script>
</body>
</html>`;

  const blob = new Blob([htmlContent], { type: "text/html" });
  const url  = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  showToast("📄 Relatório gerado! Use Ctrl+P / salvar como PDF.");
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

// ── Lançamento por texto (heurística local — sem IA externa) ───
// Interpreta uma frase livre (ex.: "almoço 32 reais ontem") só com
// expressões regulares e listas de palavras-chave, tudo dentro do
// navegador — nenhum texto sai do dispositivo do usuário.
const FIN_CATEGORY_KEYWORDS = {
  alimentacao:  ["almoço","almoco","jantar","lanche","mercado","supermercado","restaurante","comida","ifood","padaria","café","cafe","pizza","hambúrguer","hamburguer","feira","churrasco","marmita","delivery","açaí","acai","sorvete","doces","rappi","padoca","brunch","sushi"],
  transporte:   ["uber","99","gasolina","combustível","combustivel","ônibus","onibus","metro","metrô","táxi","taxi","passagem","estacionamento","pedágio","pedagio","posto","oficina","seguro do carro","ipva","licenciamento","manutenção do carro","manutencao do carro","mecânico","mecanico"],
  saude:        ["farmácia","farmacia","remédio","remedio","médico","medico","consulta","dentista","plano de saúde","plano de saude","exame","hospital","academia","psicólogo","psicologo","terapia","fisioterapia","óculos","oculos","vacina","laboratório","laboratorio"],
  lazer:        ["cinema","show","viagem","bar","balada","streaming","jogo","passeio","ingresso","netflix","festa","parque","hospedagem","hotel","pousada","passeio turístico"],
  educacao:     ["curso","faculdade","livro","mensalidade escolar","escola","material escolar","apostila","aula","udemy","mensalidade da faculdade","pós-graduação","pos-graduacao"],
  moradia:      ["aluguel","condomínio","condominio","luz","água","agua","internet","gás","gas","iptu","reforma","conta de","celular","telefone","tv a cabo","wifi","manutenção","manutencao"],
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
      showToast("✨ Preenchido pela IA! Confira os dados e clique em Registrar.");
    } catch (err) {
      // Se a IA falhar por qualquer motivo (cota grátis esgotada, sem
      // internet, backend ainda não configurado...), caímos para o
      // reconhecimento local — assim o recurso nunca trava de vez.
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
    showToast(type === "receita" ? "💰 Receita adicionada!" : "💸 Despesa registrada!");
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
            <span class="fin-cat-label">${cat.label}</span>
          </div>
          <div class="fin-cat-bar-wrap">
            <div class="fin-cat-bar" style="width:${pct}%;background:${cat.color}20;outline:2px solid ${cat.color}40"></div>
          </div>
          <span class="fin-cat-value">${formatCurrency(total)}</span>
        </div>`;
    }).join("") || `<div class="empty-state" style="padding:12px">Sem despesas no período</div>`;

  document.querySelector("#finCategories").innerHTML = catHtml;

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
          <span class="task-meta fin-tx-meta">${catName} · ${formatDate(f.date)}</span>
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
          <p class="cat-picker-section-title">⭐ Mais usadas</p>
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

    const emptyHtml = filtered.length ? "" : `
      <div style="text-align:center;padding:20px 10px;color:var(--muted);font-size:0.85rem">
        Nenhuma categoria encontrada.
      </div>`;

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
  "#ff9500","#ff9f0a","#ffd60a","#ff6b6b","#ff3b30","#ff375f","#ff2d55","#ff6482",
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

    // Pequeno feedback de "salvando → salvo" antes de fechar, pra deixar
    // claro que a ação foi concluída (em vez do modal simplesmente sumir).
    saveBtn.classList.add("is-loading");
    saveBtn.disabled = true;
    setTimeout(() => {
      populateCategorySelect(id, activeType);
      modal.remove();
      showToast(`✅ Categoria "${name}" criada!`);
    }, 260);
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
      setView("tasks");
      setTimeout(() => document.querySelector("#taskTitle")?.focus(), 200);
    } else if (action === "new-expense") {
      setView("finances");
      setTimeout(() => document.querySelector("#expenseAmount")?.focus(), 200);
    } else if (action.startsWith("open-")) {
      // Vem de um clique em notificação do sistema (ver sw.js)
      const view = action.replace("open-", "");
      if (["dashboard", "notes", "tasks", "calendar", "goals", "finances"].includes(view)) {
        setView(view);
        if (itemFromUrl) highlightItem(itemFromUrl);
      }
    }
    // Limpa o parâmetro da URL para não reabrir a mesma ação ao recarregar
    history.replaceState(null, "", window.location.pathname);
  }

  // Se o usuário tocar numa notificação enquanto o app já está aberto em
  // outra aba, o Service Worker manda essa mensagem em vez de abrir uma
  // nova janela — assim navegamos direto para a tela certa (e para o item
  // exato, quando a notificação se referia a um só item).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "open-view" && event.data.view) {
        setView(event.data.view);
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
    const lbl = new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(new Date(y, m - 1, 1));
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

  const bars = data.map((item, i) => {
    const x = i * groupW + pad;
    const rH = Math.max(2, (item.r / maxVal) * H);
    const dH = Math.max(2, (item.d / maxVal) * H);
    const isActive = item.mk === finActiveMonth;
    return `
      <rect x="${x}" y="${H - rH + pad}" width="${barW}" height="${rH}" rx="2" fill="${isActive ? "var(--green)" : "var(--green-soft)"}" stroke="${isActive ? "var(--green)" : "none"}" stroke-width="1"/>
      <rect x="${x + barW + gap}" y="${H - dH + pad}" width="${barW}" height="${dH}" rx="2" fill="${isActive ? "var(--red)" : "var(--red-soft)"}" stroke="${isActive ? "var(--red)" : "none"}" stroke-width="1"/>
      <text x="${x + barW}" y="${H + pad + 10}" text-anchor="middle" font-size="5" fill="var(--muted)" font-family="inherit">${item.lbl}</text>`;
  }).join("");

  const legendLine = `
    <rect x="${pad}" y="${H + pad + 14}" width="6" height="4" rx="1" fill="var(--green)"/>
    <text x="${pad + 8}" y="${H + pad + 18}" font-size="4.5" fill="var(--muted)" font-family="inherit">Receitas</text>
    <rect x="${pad + 36}" y="${H + pad + 14}" width="6" height="4" rx="1" fill="var(--red)"/>
    <text x="${pad + 44}" y="${H + pad + 18}" font-size="4.5" fill="var(--muted)" font-family="inherit">Despesas</text>`;

  el.innerHTML = `<svg viewBox="0 0 ${totalW + pad * 2} ${H + pad * 2 + 22}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">${bars}${legendLine}</svg>`;
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
    const lbl = new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(new Date(y, m - 1, 1));
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
  const areaD = `${pathD} L ${last.x.toFixed(2)} ${(pad + H).toFixed(2)} L ${points[0].x.toFixed(2)} ${(pad + H).toFixed(2)} Z`;

  const dots = points.map((p) => {
    const isActive = p.mk === finActiveMonth;
    const color = p.saldo >= 0 ? "var(--green)" : "var(--red)";
    return `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${isActive ? 2.1 : 1.4}" fill="${color}" stroke="var(--surface)" stroke-width="0.6"/>`;
  }).join("");

  const labels = points.map((p) =>
    `<text x="${p.x.toFixed(2)}" y="${(pad + H + 8).toFixed(2)}" text-anchor="middle" font-size="4.5" fill="var(--muted)" font-family="inherit">${p.lbl}</text>`
  ).join("");

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H + pad * 2 + 10}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
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
    el.innerHTML = `<div class="empty-state">Nenhuma meta definida.<br>Adicione limites por categoria.</div>`;
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
          <span class="fin-goal-label">${cat.label}</span>
          <span class="fin-goal-val" style="color:${color}">${formatCurrency(spent)} / ${formatCurrency(g.limit)}</span>
          <button class="icon-button" style="padding:2px 6px;font-size:0.7rem" onclick="deleteFinGoal('${g.id}')">✕</button>
        </div>
        <div class="progress-track" style="height:6px;margin-top:4px">
          <div style="width:${pct}%;height:100%;border-radius:999px;background:${color};transition:width 400ms"></div>
        </div>
        <span style="font-size:0.72rem;color:var(--muted)">${over ? "⚠️ Limite ultrapassado!" : `${pct}% usado`}</span>
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
    el.innerHTML = `<div class="empty-state">Nenhum mês fechado ainda.</div>`;
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
      .map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
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
    el.innerHTML = `<div class="empty-state">Nenhum lançamento recorrente.<br>Adicione assinaturas, salário, aluguel…</div>`;
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
          <span class="task-meta">Dia ${r.day} · ${cat.label.replace(/^\S+\s*/, "")}${skipped ? ` · pulado em ${finMonthLabel(finActiveMonth)}` : ""}</span>
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
    catSel.innerHTML = getAllCategories(type).map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
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
  // o que disparava um ciclo de sync desnecessário ao abrir o app e
  // causava o banner "❌ Erro ao salvar" quando o Firestore estava lento
  // ou offline.
  if (applied) saveState();
}

window.editNote = editNote;
window.toggleFavorite = toggleFavorite;
window.convertNoteToTask = convertNoteToTask;
window.deleteNote = deleteNote;
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
