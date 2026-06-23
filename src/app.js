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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  setDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const BASE_STORAGE_KEY = "pulsenote-state-v1";

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
function showSyncStatus(status) {
  let el = document.getElementById("syncStatus");
  if (!el) {
    el = document.createElement("div");
    el.id = "syncStatus";
    el.style.cssText = `
      position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      padding:7px 16px;border-radius:999px;font-size:0.78rem;font-weight:700;
      z-index:9999;transition:opacity 300ms;pointer-events:none;
      background:var(--surface,#fff);border:1.5px solid var(--line,#e8ecf2);
      box-shadow:0 4px 16px rgba(0,0,0,0.1);color:var(--text2,#4a5568);
    `;
    document.body.appendChild(el);
  }
  const states = {
    saving:  { text: "⏳ Salvando...",          color: "var(--accent,#4f8ef7)" },
    saved:   { text: "✅ Salvo na nuvem",       color: "var(--green,#34c759)"  },
    offline: { text: "📵 Sem conexão (local)",  color: "var(--orange,#ff9500)" },
    error:   { text: "❌ Erro ao salvar",       color: "var(--red,#ff3b30)"    },
  };
  const s = states[status] || states.saved;
  el.textContent   = s.text;
  el.style.color   = s.color;
  el.style.opacity = "1";
  if (status === "saved") setTimeout(() => { el.style.opacity = "0"; }, 1800);
}

// ── Salva o state atual no Firestore (documento do usuário) ───
async function syncToServer() {
  if (!currentUser || !state) return;
  showSyncStatus("saving");
  try {
    await setDoc(doc(db, "userData", currentUser.uid), {
      data: state,
      updatedAt: new Date().toISOString(),
    });
    const key = getStorageKey();
    if (key) localStorage.setItem(key, JSON.stringify(state));
    showSyncStatus("saved");
  } catch (err) {
    console.error("Erro ao salvar no Firestore:", err);
    showSyncStatus(navigator.onLine ? "error" : "offline");
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
          setDoc(userDocRef, { data: state, updatedAt: new Date().toISOString() })
            .catch((err) => console.error("Erro ao criar documento inicial:", err));
        }

        renderAll(); // re-renderiza com os dados confirmados do servidor

        if (!resolved) { resolved = true; resolve(); }
      },
      (err) => {
        console.error("Erro ao escutar Firestore:", err);
        showSyncStatus("error");
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

const expenseCategories = [
  { id: "alimentacao", label: "🍔 Alimentação",  color: "#ff9500" },
  { id: "transporte",  label: "🚗 Transporte",   color: "#5ac8fa" },
  { id: "saude",       label: "💊 Saúde",        color: "#ff3b30" },
  { id: "lazer",       label: "🎬 Lazer",        color: "#af52de" },
  { id: "educacao",    label: "📚 Educação",     color: "#34c759" },
  { id: "moradia",     label: "🏠 Moradia",      color: "#ff6b6b" },
  { id: "roupas",      label: "👗 Roupas",       color: "#ff2d55" },
  { id: "assinaturas", label: "🔁 Assinaturas",  color: "#5856d6" },
  { id: "outros",      label: "📦 Outros",       color: "#8a9bb0" },
];

// Retorna categorias fixas + categorias criadas pelo usuário
function getAllCategories() {
  const custom = state.customCategories || [];
  return [...expenseCategories, ...custom];
}

function findCategory(catId) {
  return getAllCategories().find((c) => c.id === catId) || { label: "📦 Outros", color: "#8a9bb0" };
}
const themeList = ["sunny", "ocean", "candy", "forest", "night"];
const themeNames = {
  sunny: "Sol",
  ocean: "Oceano",
  candy: "Doce",
  forest: "Floresta",
  night: "Noite",
};

const todayIso = new Date().toISOString().slice(0, 10);
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

const elements = {
  viewTitle: document.querySelector("#viewTitle"),
  todayLabel: document.querySelector("#todayLabel"),
  globalSearch: document.querySelector("#globalSearch"),
  themeSelect: document.querySelector("#themeSelect"),
  themeSelectMobile: document.querySelector("#themeSelectMobile"),
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
        background:linear-gradient(145deg,#4f8ef7,#af52de);
        display:grid;place-items:center;font-size:1.5rem;
        box-shadow:0 6px 20px rgba(79,142,247,0.35)">⚡</div>
      <strong style="font-size:1.1rem;font-weight:800;color:var(--text,#1a1f2e);
        font-family:-apple-system,sans-serif">PulseNote</strong>
      <div style="width:32px;height:3px;border-radius:999px;
        background:var(--line,#e8ecf2);overflow:hidden">
        <div style="height:100%;border-radius:inherit;
          background:linear-gradient(90deg,#4f8ef7,#af52de);
          animation:loadingBar 1.2s ease-in-out infinite alternate;width:60%"></div>
      </div>
    </div>
    <style>@keyframes loadingBar{from{transform:translateX(-100%)}to{transform:translateX(180%)}}</style>
  `;
  document.body.appendChild(overlay);

  // Aguarda o Firebase confirmar sessão e carregar dados do Firestore
  await appReady;

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

  state.theme = normalizeTheme(state.theme);
  applyTheme(state.theme);
  bindNavigation();
  bindForms();
  bindActions();
  bindSettingsView();
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
      <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#4f8ef7,#af52de);
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
    <button class="dropdown-item" id="dropdownTheme">🎨 Trocar tema</button>
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

  document.getElementById("dropdownTheme").addEventListener("click", () => {
    closeDropdown();
    document.querySelector("#themeSelectMobile")?.focus();
  });
}

// Lê um arquivo de imagem, redimensiona e comprime no navegador (canvas),
// retornando uma Data URL (base64) pronta para salvar dentro do próprio
// documento do usuário no Firestore. Isso evita depender do Firebase
// Storage (que hoje exige o plano pago "Blaze" para funcionar) — a foto
// vai junto com o resto dos dados do usuário, do mesmo jeito que notas e
// tarefas, e sincroniza automaticamente entre dispositivos.
function fileToCompressedDataUrl(file) {
  const MAX_BYTES = 700_000; // bem abaixo do limite de 1 MB por documento do Firestore

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
}

// Atualiza todos os pontos da UI que exibem o avatar do usuário
function updateAllAvatars(photoURL) {
  // Botão principal no topbar
  const mainBtn = document.querySelector(".user-avatar-btn");
  if (mainBtn) {
    mainBtn.innerHTML = `<img src="${photoURL}"
      style="width:100%;height:100%;object-fit:cover;border-radius:50%" alt=""/>`;
  }
  // Mini avatar no dropdown
  const dropdownAvatar = document.querySelector(".user-dropdown-header div");
  if (dropdownAvatar) {
    dropdownAvatar.innerHTML = `<img src="${photoURL}"
      style="width:100%;height:100%;object-fit:cover" alt=""/>`;
  }
  // Avatar grande na página de Configurações
  const previewEl = document.getElementById("settingsAvatarPreview");
  if (previewEl) {
    previewEl.innerHTML = `<img src="${photoURL}" alt="Foto de perfil"/>`;
  }
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
  if (!parsed.theme) parsed.theme = "sunny";
  if (parsed.profilePhoto === undefined) parsed.profilePhoto = null;
  return parsed;
}

// Estado inicial para contas novas (primeiro acesso, sem nenhum documento
// no Firestore ainda). Começa zerado de propósito — cada usuário deve
// preencher seus próprios dados, sem nenhum conteúdo de exemplo pré-salvo.
function loadDefaultState() {
  return {
    theme: "sunny",
    profilePhoto: null,
    notes: [],
    tasks: [],
    events: [],
    goals: [],
    finances: [],
    customCategories: [],
  };
}

// Salva mudanças localmente de imediato e agenda o envio para o Firestore
// (debounce de 1.2s — evita gravar a cada tecla digitada, por exemplo)
function saveState() {
  const key = getStorageKey();
  if (key) localStorage.setItem(key, JSON.stringify(state));
  scheduleSyncToServer();
}

function normalizeTheme(theme) {
  if (theme === "light") return "sunny";
  if (theme === "dark") return "night";
  return themeList.includes(theme) ? theme : "sunny";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = normalizeTheme(theme);
  if (elements.themeSelect) {
    elements.themeSelect.value = normalizeTheme(theme);
  }
  if (elements.themeSelectMobile) {
    elements.themeSelectMobile.value = normalizeTheme(theme);
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
  };
}

function offsetDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function bindNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelectorAll("[data-view-shortcut]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewShortcut));
  });
}

function bindForms() {
  document.querySelector("#noteForm").addEventListener("submit", saveNote);
  document.querySelector("#resetNoteForm").addEventListener("click", resetNoteForm);
  document.querySelector("#suggestNote").addEventListener("click", suggestNoteMetadata);
  document.querySelector("#noteFilter").addEventListener("change", renderNotes);
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

  // Popula o select de categorias (fixas + customizadas) na primeira carga
  populateCategorySelect();

  // Botão "+ Nova categoria"
  const newCatBtn = document.querySelector("#newCategoryBtn");
  if (newCatBtn) newCatBtn.addEventListener("click", openNewCategoryPrompt);

  // Botão "Cancelar edição" (some quando não está editando)
  const cancelEditBtn = document.querySelector("#cancelEditExpense");
  if (cancelEditBtn) cancelEditBtn.addEventListener("click", resetExpenseForm);

  // Finance type toggle
  document.querySelectorAll("[data-fin-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelector("#expenseType").value = btn.dataset.finType;
    });
  });

  // Finance month filter chips
  document.querySelectorAll("[data-fin-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-fin-filter]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      renderFinances();
    });
  });
}

function bindActions() {
  document.querySelector("#themeToggle").addEventListener("click", () => {
    const currentIndex = themeList.indexOf(normalizeTheme(state.theme));
    state.theme = themeList[(currentIndex + 1) % themeList.length];
    applyTheme(state.theme);
    saveState();
    showToast(`Tema ${themeNames[state.theme]} aplicado.`);
  });

  [elements.themeSelect, elements.themeSelectMobile].forEach((select) => {
    select.addEventListener("change", (event) => {
      state.theme = event.target.value;
      applyTheme(state.theme);
      saveState();
      showToast(`Tema ${themeNames[state.theme]} aplicado.`);
    });
  });

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
  state.events.push({
    id: crypto.randomUUID(),
    title: valueOf("#eventTitle"),
    date: valueOf("#eventDate"),
    time: valueOf("#eventTime"),
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
  });
  event.target.reset();
  document.querySelector("#goalTarget").value = 5;
  saveState();
  renderAll();
  showToast("Meta criada.");
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
}

function suggestNoteMetadata() {
  const text = `${valueOf("#noteTitle")} ${valueOf("#noteDescription")}`.toLowerCase();
  const category = text.includes("reuniao") || text.includes("projeto") ? "Trabalho" : text.includes("estudo") ? "Estudos" : "Pessoal";
  const priority = text.includes("urgente") || text.includes("prazo") ? "Urgente" : text.includes("importante") ? "Alta" : "Media";
  document.querySelector("#noteCategory").value = category;
  document.querySelector("#notePriority").value = priority;
  if (!valueOf("#noteTags")) {
    document.querySelector("#noteTags").value = [category.toLowerCase(), priority.toLowerCase()].join(", ");
  }
  showToast("Sugestoes aplicadas.");
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

  document.querySelector("#doneMetric").textContent = doneToday;
  document.querySelector("#doneMetricDetail").textContent = `${doneTotal} no historico`;
  document.querySelector("#progressMetric").textContent = `${progress}%`;
  document.querySelector("#eventMetric").textContent = nextEvents.length;
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

  renderList("#todayTasks", state.tasks.filter((task) => task.status !== "Concluida" && task.status !== "Cancelada").slice(0, 5), renderTaskRow, "Nenhuma tarefa pendente.");
  renderList("#upcomingEvents", nextEvents.sort(sortEvent).slice(0, 5), renderEventRow, "Nenhum compromisso nos proximos dias.");
  renderChart();
  renderGoalSummary();
  renderDashFinance();
}

function renderDashFinance() {
  const el = document.querySelector("#dashFinancePanel");
  if (!el || !state.finances) return;
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const entries = state.finances.filter((f) => f.date.startsWith(currentMonthKey));
  const receitas = entries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const despesas = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
  const saldo = receitas - despesas;
  const usedPct = receitas > 0 ? Math.min(100, Math.round((despesas / receitas) * 100)) : 0;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">
      <div style="text-align:center"><div style="font-size:0.75rem;color:var(--muted);font-weight:600;margin-bottom:2px">Receitas</div><strong style="color:var(--green);font-size:1rem;font-weight:800">${formatCurrency(receitas)}</strong></div>
      <div style="text-align:center"><div style="font-size:0.75rem;color:var(--muted);font-weight:600;margin-bottom:2px">Despesas</div><strong style="color:var(--red);font-size:1rem;font-weight:800">${formatCurrency(despesas)}</strong></div>
      <div style="text-align:center"><div style="font-size:0.75rem;color:var(--muted);font-weight:600;margin-bottom:2px">Saldo</div><strong style="color:${saldo >= 0 ? "var(--green)" : "var(--red)"};font-size:1rem;font-weight:800">${formatCurrency(saldo)}</strong></div>
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
      const height = 18 + (counts[index] / max) * 150;
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
    "Crie sua primeira meta."
  );
}

function renderNotes() {
  const filter = document.querySelector("#noteFilter").value;
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

      return `
        <article class="note-card">
          <header>
            <div>
              <h3>${escapeHtml(note.title)}</h3>
              <div class="note-meta">${escapeHtml(note.category)} · ${formatDate(note.createdAt)}</div>
            </div>
            <button class="mini-button" onclick="toggleFavorite('${note.id}')" title="Favoritar" style="font-size:1.1rem;background:none;border:none;padding:0;width:30px;height:30px;display:grid;place-items:center;flex-shrink:0;border-radius:50%;">${note.favorite ? "⭐" : "☆"}</button>
          </header>
          ${note.description ? `<p>${escapeHtml(note.description)}</p>` : ""}
          ${checklistHtml}
          ${tagsHtml}
          <div class="tag-list" style="margin-top:4px">
            <span class="priority-pill priority-${note.priority}">${note.priority}</span>
          </div>
          <div class="card-actions">
            <button onclick="editNote('${note.id}')">✏️ Editar</button>
            <button onclick="convertNoteToTask('${note.id}')">➡️ Tarefa</button>
            <button onclick="deleteNote('${note.id}')">🗑️</button>
          </div>
        </article>
      `;
    },
    "Nenhuma anotação encontrada. Crie a primeira! ✨"
  );
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
  document.querySelector("#noteChecklist").value = note.checklist.join("\n");
  document.querySelector("#noteAttachments").value = note.attachments.join(", ");
  document.querySelector("#noteGoal").value = note.goal;
  document.querySelector("#noteObservations").value = note.observations;
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
  return `
    <article class="task-row" draggable="true" ondragstart="dragTask('${task.id}')">
      <div class="task-main">
        <button class="task-check" onclick="toggleTask('${task.id}')" title="Concluir" style="${isDone ? "background:var(--green);border-color:var(--green);color:#fff;" : ""}">${isDone ? "✓" : ""}</button>
        <div>
          <div class="task-title" style="${isDone ? "text-decoration:line-through;opacity:0.5;" : ""}">${escapeHtml(task.title)}</div>
          <div class="task-meta">${formatDate(task.dueDate)} · ${escapeHtml(task.priority)}</div>
        </div>
      </div>
      <div class="tag-list">
        <span class="status-pill status-${task.status.replace(" ", "-")}">${task.status}</span>
        <button class="mini-button" onclick="openTaskMoveMenu('${task.id}', event)" title="Mover para outra coluna" style="padding:0;width:28px;height:28px;">↔️</button>
        <button class="mini-button" onclick="deleteTask('${task.id}')" title="Excluir" style="padding:0;width:28px;height:28px;">🗑️</button>
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
  }
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
  return [...Array(total)].map((_, index) => new Date(year, month, index + 1).toISOString().slice(0, 10));
}

function getWeekDays(date) {
  const start = new Date(date);
  start.setDate(date.getDate() - date.getDay());
  return [...Array(7)].map((_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function filterEventsByDate(date) {
  const events = state.events.filter((event) => event.date === date).sort(sortEvent);
  renderList("#calendarEvents", events, renderEventRow, "Sem compromissos nesse dia.");
}

function renderEventRow(event) {
  return `
    <article class="event-row">
      <div style="flex:1;min-width:0">
        <strong style="font-size:0.9rem">${escapeHtml(event.title)}</strong>
        <div class="event-meta">📅 ${formatDate(event.date)} às ${event.time} · 📍 ${escapeHtml(event.location)}</div>
      </div>
      <div class="tag-list" style="flex-shrink:0">
        <span class="pill" style="background:var(--orange-soft);color:var(--orange);border-color:var(--orange)">⏰ ${event.reminder}min</span>
        <button class="mini-button" onclick="deleteEvent('${event.id}')" title="Excluir" style="padding:0;width:28px;height:28px">🗑️</button>
      </div>
    </article>
  `;
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
      return `
        <article class="goal-card" style="${isComplete ? "border-color:var(--green);background:var(--green-soft);" : ""}">
          <div>
            <h2>${escapeHtml(goal.title)}</h2>
            <div class="task-meta">${goal.current}/${goal.target} etapas ${isComplete ? "🎉" : ""}</div>
          </div>
          <div class="progress-track"><div style="width:${percent}%;background:${isComplete ? "var(--green)" : "linear-gradient(90deg,var(--accent),var(--purple))"}"></div></div>
          <div class="goal-controls">
            <button class="mini-button" onclick="changeGoal('${goal.id}', -1)">−</button>
            <span class="pill" style="${isComplete ? "background:var(--green);color:#fff;border-color:var(--green);" : ""}">${percent}%</span>
            <button class="mini-button" onclick="changeGoal('${goal.id}', 1)">+</button>
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

function renderList(selector, items, renderer, emptyText) {
  const element = document.querySelector(selector);
  element.innerHTML = items.length ? items.map(renderer).join("") : `<div class="empty-state">${emptyText}</div>`;
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
  const active = document.querySelector("[data-fin-filter].active");
  if (!active) return "current";
  return active.dataset.finFilter; // "current", "all", or "YYYY-MM"
}

function saveExpense(event) {
  event.preventDefault();
  const editId = valueOf("#expenseId");
  const type = document.querySelector("#expenseType").value || "despesa";
  const amount = parseFloat(valueOf("#expenseAmount").replace(",", "."));
  if (isNaN(amount) || amount <= 0) { showToast("Informe um valor válido."); return; }

  if (!state.finances) state.finances = [];

  if (editId) {
    // Modo edição: atualiza o registro existente
    state.finances = state.finances.map((f) =>
      f.id === editId
        ? {
            ...f,
            type,
            amount,
            category: valueOf("#expenseCategory") || "outros",
            description: valueOf("#expenseDescription") || (type === "receita" ? "Receita" : "Despesa"),
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
      category: valueOf("#expenseCategory") || "outros",
      description: valueOf("#expenseDescription") || (type === "receita" ? "Receita" : "Despesa"),
      date: valueOf("#expenseDate") || todayIso,
    };
    state.finances.unshift(entry);
    showToast(type === "receita" ? "💰 Receita adicionada!" : "💸 Despesa registrada!");
  }

  saveState();
  renderFinances();
  resetExpenseForm();
}

function resetExpenseForm() {
  document.querySelector("#expenseForm").reset();
  document.querySelector("#expenseId").value = "";
  document.querySelector("#expenseDate").value = todayIso;
  document.querySelector("#expenseType").value = "despesa";
  document.querySelectorAll("[data-fin-type]").forEach((b) => b.classList.toggle("active", b.dataset.finType === "despesa"));
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

  populateCategorySelect(entry.category);

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

function renderFinances() {
  if (!document.querySelector("#financesView")) return;
  if (!state.finances) state.finances = [];

  const monthFilter = getActiveFinMonth();
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  let entries = [...state.finances].sort((a, b) => b.date.localeCompare(a.date));
  if (monthFilter === "all") {
    // sem filtro de mês — mostra tudo
  } else {
    entries = entries.filter((f) => f.date.startsWith(currentMonthKey));
  }

  // Aplica a busca global (por descrição ou categoria)
  const query = elements.globalSearch.value.trim().toLowerCase();
  if (query) {
    entries = entries.filter((f) => {
      const cat = findCategory(f.category);
      return (f.description || "").toLowerCase().includes(query)
          || cat.label.toLowerCase().includes(query);
    });
  }

  const receitas  = entries.filter((f) => f.type === "receita").reduce((s, f) => s + f.amount, 0);
  const despesas  = entries.filter((f) => f.type === "despesa").reduce((s, f) => s + f.amount, 0);
  const saldo     = receitas - despesas;
  const usedPct   = receitas > 0 ? Math.min(100, Math.round((despesas / receitas) * 100)) : 0;

  document.querySelector("#finReceitas").textContent  = formatCurrency(receitas);
  document.querySelector("#finDespesas").textContent  = formatCurrency(despesas);
  document.querySelector("#finSaldo").textContent     = formatCurrency(saldo);
  document.querySelector("#finSaldoCard").style.setProperty("--saldo-color", saldo >= 0 ? "var(--green)" : "var(--red)");
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
    ? entries.slice(0, 30).map((f) => renderFinTransaction(f)).join("")
    : `<div class="empty-state">${query ? "Nenhum resultado para essa busca 🔍" : "Nenhum registro no período 📭"}</div>`;

  document.querySelector("#finTransactions").innerHTML = listHtml;

  renderFinCalendar(currentMonthKey, entries);
}

function renderFinTransaction(f) {
  const cat = findCategory(f.category);
  const isReceita = f.type === "receita";
  return `
    <article class="fin-transaction">
      <div class="fin-tx-icon" style="background:${isReceita ? "var(--green-soft)" : cat.color + "22"};color:${isReceita ? "var(--green)" : cat.color}">
        ${isReceita ? "💰" : cat.label.split(" ")[0]}
      </div>
      <div class="fin-tx-info">
        <strong>${escapeHtml(f.description)}</strong>
        <span class="task-meta">${isReceita ? "Receita" : cat.label.replace(/^.\s/, "")} · ${formatDate(f.date)}</span>
      </div>
      <div class="fin-tx-amount ${isReceita ? "receita" : "despesa"}">
        ${isReceita ? "+" : "-"}${formatCurrency(f.amount)}
      </div>
      <button class="mini-button" onclick="editFinance('${f.id}')" title="Editar" style="padding:0;width:26px;height:26px;flex-shrink:0">✏️</button>
      <button class="mini-button" onclick="deleteFinance('${f.id}')" title="Excluir" style="padding:0;width:26px;height:26px;flex-shrink:0">🗑️</button>
    </article>`;
}

function renderFinCalendar(monthKey, entries) {
  const grid = document.querySelector("#finCalGrid");
  if (!grid) return;
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

// Preenche o <select> de categorias com as fixas + customizadas do usuário.
// Se selectedId for passado, marca essa opção como selecionada.
function populateCategorySelect(selectedId) {
  const select = document.querySelector("#expenseCategory");
  if (!select) return;
  const current = selectedId || select.value;
  select.innerHTML = getAllCategories()
    .map((cat) => `<option value="${cat.id}">${cat.label}</option>`)
    .join("");
  if (current) select.value = current;
}

function openNewCategoryPrompt() {
  const modal = document.createElement("div");
  modal.id = "newCategoryModal";
  modal.style.cssText = `position:fixed;inset:0;z-index:600;background:rgba(0,0,0,0.45);
    backdrop-filter:blur(6px);display:grid;place-items:center;padding:20px`;

  const colorOptions = ["#ff9500","#5ac8fa","#ff3b30","#af52de","#34c759","#ff6b6b","#ff2d55","#5856d6","#00c7be","#8a9bb0"];
  const emojiOptions  = ["🔁","💡","🎮","🐾","✈️","🎁","🏋️","📱","🧾","🛠️","🍷","🚀"];

  modal.innerHTML = `
    <div style="background:var(--surface);border-radius:24px;padding:26px;width:100%;max-width:380px;
      box-shadow:0 20px 60px rgba(0,0,0,0.25);animation:fadeUp 200ms ease;
      max-height:90dvh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
        <h2 style="font-size:1.1rem;font-weight:800;color:var(--text)">Nova categoria</h2>
        <button id="closeNewCategory" style="width:30px;height:30px;border-radius:10px;
          background:var(--surface2);border:none;font-size:1rem;cursor:pointer;color:var(--text2)">✕</button>
      </div>

      <label style="display:grid;gap:5px;font-size:0.82rem;font-weight:600;color:var(--muted);margin-bottom:12px">
        Nome da categoria
        <input id="newCatName" placeholder="Ex.: Assinaturas" maxlength="24"
          style="min-height:44px;border:1.5px solid var(--line);border-radius:12px;
          padding:8px 12px;background:var(--surface2);color:var(--text);font-size:0.92rem;width:100%"/>
      </label>

      <p style="font-size:0.8rem;font-weight:600;color:var(--muted);margin-bottom:8px">Ícone</p>
      <div id="emojiPicker" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px">
        ${emojiOptions.map((e, i) => `
          <button class="cat-emoji-btn ${i === 0 ? "active" : ""}" data-emoji="${e}"
            style="width:38px;height:38px;border-radius:10px;font-size:1.1rem;
            border:2px solid ${i === 0 ? "var(--accent)" : "var(--line)"};
            background:var(--surface2);cursor:pointer">${e}</button>
        `).join("")}
      </div>

      <p style="font-size:0.8rem;font-weight:600;color:var(--muted);margin-bottom:8px">Cor</p>
      <div id="colorPicker" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">
        ${colorOptions.map((c, i) => `
          <button class="cat-color-btn ${i === 0 ? "active" : ""}" data-color="${c}"
            style="width:30px;height:30px;border-radius:50%;background:${c};cursor:pointer;
            border:3px solid ${i === 0 ? "var(--text)" : "transparent"}"></button>
        `).join("")}
      </div>

      <div id="newCategoryError" style="color:var(--red,#ff3b30);font-size:0.84rem;font-weight:600;
        display:none;background:var(--red-soft,#ffeeed);padding:10px 12px;border-radius:10px;margin-bottom:12px"></div>

      <button id="saveNewCategory" style="height:48px;border-radius:14px;background:var(--accent);
        color:#fff;font-weight:700;font-size:0.95rem;border:none;cursor:pointer;width:100%">
        Criar categoria
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  let selectedEmoji = emojiOptions[0];
  let selectedColor = colorOptions[0];

  modal.querySelectorAll(".cat-emoji-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      modal.querySelectorAll(".cat-emoji-btn").forEach((b) => b.style.borderColor = "var(--line)");
      btn.style.borderColor = "var(--accent)";
      selectedEmoji = btn.dataset.emoji;
    });
  });

  modal.querySelectorAll(".cat-color-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      modal.querySelectorAll(".cat-color-btn").forEach((b) => b.style.borderColor = "transparent");
      btn.style.borderColor = "var(--text)";
      selectedColor = btn.dataset.color;
    });
  });

  document.getElementById("closeNewCategory").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

  document.getElementById("saveNewCategory").addEventListener("click", () => {
    const name = document.getElementById("newCatName").value.trim();
    const errEl = document.getElementById("newCategoryError");
    if (!name) {
      errEl.textContent = "Digite um nome para a categoria.";
      errEl.style.display = "block";
      return;
    }

    const id = "custom_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24) + "_" + Date.now().toString(36);

    if (!state.customCategories) state.customCategories = [];
    state.customCategories.push({
      id,
      label: `${selectedEmoji} ${name}`,
      color: selectedColor,
    });
    saveState();

    populateCategorySelect(id);
    modal.remove();
    showToast(`✅ Categoria "${name}" criada!`);
  });
}

// Abre direto a tela certa quando o app é aberto via atalho do PWA
// (ex: pressionar e segurar o ícone na tela inicial → "Nova tarefa")
function handlePwaShortcutAction() {
  const action = new URLSearchParams(window.location.search).get("action");
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
      }
    }
    // Limpa o parâmetro da URL para não reabrir a mesma ação ao recarregar
    history.replaceState(null, "", window.location.pathname);
  }

  // Se o usuário tocar numa notificação enquanto o app já está aberto em
  // outra aba, o Service Worker manda essa mensagem em vez de abrir uma
  // nova janela — assim navegamos direto para a tela certa.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "open-view" && event.data.view) {
        setView(event.data.view);
      }
    });
  }
}

window.editNote = editNote;
window.toggleFavorite = toggleFavorite;
window.convertNoteToTask = convertNoteToTask;
window.deleteNote = deleteNote;
window.dragTask = dragTask;
window.toggleTask = toggleTask;
window.openTaskMoveMenu = openTaskMoveMenu;
window.deleteTask = deleteTask;
window.filterEventsByDate = filterEventsByDate;
window.deleteEvent = deleteEvent;
window.changeGoal = changeGoal;
window.deleteGoal = deleteGoal;
window.deleteFinance = deleteFinance;
window.editFinance = editFinance;
window.filterFinByDate = filterFinByDate;
