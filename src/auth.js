// auth.js — Autenticação PulseNote via Firebase

import { auth, googleProvider } from "./firebase-init.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateProfile,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Marca este navegador como "já usado antes" — assim, na próxima visita à
// tela de login, mostramos "Bem-vindo de volta" em vez da mensagem de
// boas-vindas de quem nunca usou o PulseNote aqui (ver script no login.html).
const KNOWN_DEVICE_KEY = "pulsenote_known_device";
function markDeviceAsKnown() {
  try { localStorage.setItem(KNOWN_DEVICE_KEY, "1"); } catch (e) {}
}

// ── Tradução de erros Firebase → PT-BR (cobre todos os casos conhecidos) ──
function translateAuthError(code) {
  const map = {
    // Cadastro
    "auth/email-already-in-use":        "Este e-mail já está cadastrado. Tente fazer login.",
    "auth/invalid-email":               "E-mail inválido. Verifique o formato.",
    "auth/weak-password":               "Senha muito fraca. Use pelo menos 6 caracteres.",
    "auth/operation-not-allowed":       "Cadastro por e-mail não está ativado. Fale com o administrador.",
    // Login
    "auth/user-not-found":              "E-mail não encontrado. Verifique ou crie uma conta.",
    "auth/wrong-password":              "Senha incorreta. Tente novamente.",
    "auth/invalid-credential":          "E-mail ou senha incorretos.",
    "auth/user-disabled":               "Esta conta foi desativada.",
    // Domínio / configuração
    "auth/unauthorized-domain":         "Este domínio não está autorizado no Firebase. Adicione-o em Authentication → Settings → Authorized domains.",
    "auth/configuration-not-found":     "Firebase não configurado corretamente. Verifique o firebase-config.js.",
    // Rede / limite
    "auth/too-many-requests":           "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
    "auth/network-request-failed":      "Sem conexão. Verifique sua internet e tente novamente.",
    // Campos
    "auth/missing-password":            "Informe sua senha.",
    "auth/missing-email":               "Informe seu e-mail.",
    "auth/internal-error":              "Erro interno do Firebase. Tente novamente em instantes.",
    // Login com Google
    "auth/popup-closed-by-user":        "Janela do Google fechada antes de concluir o login.",
    "auth/cancelled-popup-request":     "Login cancelado.",
    "auth/popup-blocked":               "O navegador bloqueou a janela do Google. Tentando outro método...",
    "auth/account-exists-with-different-credential":
      "Já existe uma conta com este e-mail usando login por senha. Entre com e-mail e senha.",
  };
  return map[code] || `Erro inesperado (${code}). Tente novamente.`;
}

// ── LOGIN / CADASTRO COM GOOGLE ─────────────────────────────────
// Mesmo botão serve para login e cadastro: se a conta Google ainda não
// existe no PulseNote, o Firebase a cria automaticamente — e como o
// Google já confirmou o e-mail, a pessoa não precisa verificar de novo.
//
// "prompt: select_account" (configurado em firebase-init.js) é o que faz
// o Google sempre abrir a tela de "Escolher uma conta" — igual em outros
// sites — em vez de logar direto com a conta que já está ativa no
// navegador. Antes de abrir o popup, também encerramos qualquer sessão
// do Firebase que tenha ficado pendente neste navegador, pra garantir que
// o fluxo comece sempre limpo (sem "herdar" a conta anterior).
async function signInWithGoogle() {
  ["loginError", "registerError"].forEach(hideError);
  try {
    if (auth.currentUser) {
      try { await signOut(auth); } catch (e) {}
    }
    await signInWithPopup(auth, googleProvider);
    markDeviceAsKnown();
    window.location.replace("index.html");
  } catch (err) {
    console.error("Google sign-in error:", err.code, err.message);
    // Pop-up bloqueado/indisponível (comum em PWA instalado e navegadores
    // dentro de apps) → tenta de novo com redirecionamento de página inteira
    if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") {
      try { await signInWithRedirect(auth, googleProvider); return; }
      catch (redirectErr) { console.error("Google redirect error:", redirectErr); }
    }
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
    const visibleForm = document.querySelector(".auth-form.active-form");
    const targetError = visibleForm?.id === "registerForm" ? "registerError" : "loginError";
    showError(targetError, translateAuthError(err.code));
  }
}

document.querySelectorAll("[data-google-signin]").forEach((btn) => {
  btn.addEventListener("click", signInWithGoogle);
});

// Se o login com Google caiu no fluxo de redirecionamento (fallback acima),
// confirma o resultado quando a página recarregar.
getRedirectResult(auth).then((result) => {
  if (result?.user) {
    markDeviceAsKnown();
    window.location.replace("index.html");
  }
}).catch((err) => {
  if (err?.code) console.error("Erro ao concluir login com Google:", err.code, err.message);
});

// ── Guard: já logado → vai direto para o app ──────────────────
const unsubscribeAuthCheck = onAuthStateChanged(auth, (user) => {
  unsubscribeAuthCheck();
  const path = window.location.pathname;
  const isAuthPage = path.endsWith("login.html")
    || path === "/"
    || path.endsWith("/");
  if (user && isAuthPage) {
    markDeviceAsKnown();
    window.location.replace("index.html");
  }
});

// ── Helpers UI ─────────────────────────────────────────────────
function showError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}
function hideError(elId) {
  const el = document.getElementById(elId);
  if (el) el.hidden = true;
}
function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  const text    = btn.querySelector(".btn-text");
  const spinner = btn.querySelector(".btn-spinner");
  if (text)    text.hidden    = loading;
  if (spinner) spinner.hidden = !loading;
}

// ── Tabs ───────────────────────────────────────────────────────
document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});
document.querySelectorAll("[data-switch]").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.switch));
});

function switchTab(target) {
  document.querySelectorAll(".auth-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === target)
  );
  document.querySelectorAll(".auth-form").forEach((f) =>
    f.classList.remove("active-form")
  );
  const form = document.getElementById(target === "login" ? "loginForm" : "registerForm");
  if (form) {
    form.classList.add("active-form");
    form.querySelector("input")?.focus();
  }
}

// ── Toggle senha visível/oculta ────────────────────────────────
document.querySelectorAll(".toggle-pw").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    btn.textContent = input.type === "password" ? "👁️" : "🙈";
  });
});

// ── Medidor de força da senha ──────────────────────────────────
const pwInput = document.getElementById("regPassword");
if (pwInput) pwInput.addEventListener("input", () => updateStrength(pwInput.value));

function updateStrength(pw) {
  const fill  = document.getElementById("pwStrengthFill");
  const label = document.getElementById("pwStrengthLabel");
  if (!fill || !label) return;
  let score = 0;
  if (pw.length >= 6)            score++;
  if (pw.length >= 10)           score++;
  if (/[A-Z]/.test(pw))         score++;
  if (/[0-9]/.test(pw))         score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const levels = [
    { w: "0%",   color: "#e8ecf2", text: "" },
    { w: "25%",  color: "#ff3b30", text: "Fraca" },
    { w: "50%",  color: "#ff9500", text: "Regular" },
    { w: "75%",  color: "#ffcc00", text: "Boa" },
    { w: "100%", color: "#34c759", text: "Forte 💪" },
  ];
  const lvl = levels[Math.min(score, 4)];
  fill.style.width      = pw.length === 0 ? "0%" : lvl.w;
  fill.style.background = lvl.color;
  label.textContent     = pw.length === 0 ? "" : lvl.text;
  label.style.color     = lvl.color;
}

// ── LOGIN ──────────────────────────────────────────────────────
const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("loginError");
    setLoading("loginBtn", true);
    const email    = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    try {
      await signInWithEmailAndPassword(auth, email, password);
      markDeviceAsKnown();
      window.location.replace("index.html");
    } catch (err) {
      console.error("Login error:", err.code, err.message);
      showError("loginError", translateAuthError(err.code));
      setLoading("loginBtn", false);
    }
  });
}

// ── CADASTRO ───────────────────────────────────────────────────
const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("registerError");

    const name    = document.getElementById("regName").value.trim();
    const email   = document.getElementById("regEmail").value.trim();
    const pw      = document.getElementById("regPassword").value;
    const confirm = document.getElementById("regPasswordConfirm").value;

    // Validações no front antes de chamar o Firebase
    if (name.length < 2) {
      showError("registerError", "Informe seu nome completo.");
      return;
    }
    if (!email.includes("@")) {
      showError("registerError", "Informe um e-mail válido.");
      return;
    }
    if (pw.length < 6) {
      showError("registerError", "A senha deve ter pelo menos 6 caracteres.");
      return;
    }
    if (pw !== confirm) {
      showError("registerError", "As senhas não conferem.");
      return;
    }

    setLoading("registerBtn", true);
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, pw);
      await updateProfile(credential.user, { displayName: name });
      // Envia o e-mail de confirmação. Se isso falhar (ex: rede instável),
      // a tela de verificação dentro do app tem um botão "Reenviar e-mail",
      // então não bloqueamos o cadastro por causa disso.
      try { await sendEmailVerification(credential.user); }
      catch (verifyErr) { console.error("Erro ao enviar verificação:", verifyErr); }
      // Cadastro OK → vai para o app (que vai exigir a confirmação do e-mail)
      markDeviceAsKnown();
      window.location.replace("index.html");
    } catch (err) {
      console.error("Register error:", err.code, err.message);
      showError("registerError", translateAuthError(err.code));
      setLoading("registerBtn", false);
    }
  });
}

// ── ESQUECI MINHA SENHA ────────────────────────────────────────
const forgotForm = document.getElementById("forgotForm");
if (forgotForm) {
  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("forgotError");
    setLoading("forgotBtn", true);
    const email = document.getElementById("forgotEmail").value.trim();
    try {
      await sendPasswordResetEmail(auth, email, {
        url: window.location.origin + "/login.html",
      });
      markDeviceAsKnown();
      document.getElementById("stepEmail").hidden   = true;
      document.getElementById("stepSuccess").hidden = false;
    } catch (err) {
      console.error("Reset error:", err.code, err.message);
      if (err.code === "auth/invalid-email") {
        showError("forgotError", "Informe um e-mail válido.");
        setLoading("forgotBtn", false);
        return;
      }
      // Qualquer outro erro: mostramos sucesso por segurança (não revelamos e-mails cadastrados)
      document.getElementById("stepEmail").hidden   = true;
      document.getElementById("stepSuccess").hidden = false;
    }
  });
}
