// auth.js — Autenticação PulseNote via Firebase
// Usado em: login.html e forgot-password.html

import { auth } from "./firebase-init.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ── Tradução de erros Firebase para PT-BR ──────────────────────
function translateAuthError(code) {
  const map = {
    "auth/email-already-in-use":   "Este e-mail já está cadastrado.",
    "auth/invalid-email":          "E-mail inválido.",
    "auth/weak-password":          "A senha deve ter pelo menos 6 caracteres.",
    "auth/user-not-found":         "E-mail ou senha incorretos.",
    "auth/wrong-password":         "E-mail ou senha incorretos.",
    "auth/invalid-credential":     "E-mail ou senha incorretos.",
    "auth/too-many-requests":      "Muitas tentativas. Aguarde alguns minutos.",
    "auth/network-request-failed": "Erro de conexão. Verifique sua internet.",
    "auth/user-disabled":          "Esta conta foi desativada.",
    "auth/missing-password":       "Informe sua senha.",
    "auth/missing-email":          "Informe seu e-mail.",
  };
  return map[code] || "Ocorreu um erro inesperado. Tente novamente.";
}

// ── Guard: se já está logado na login.html, vai direto para o app ──
// Usa unsubscribe para não ficar escutando após redirecionar
const unsubscribeAuthCheck = onAuthStateChanged(auth, (user) => {
  unsubscribeAuthCheck(); // para de escutar depois da primeira checagem
  const isLoginPage = window.location.pathname.endsWith("login.html")
    || window.location.pathname === "/"
    || window.location.pathname.endsWith("/");
  if (user && isLoginPage) {
    window.location.replace("index.html");
  }
});

// ── Tabs: alterna entre Entrar / Criar conta ───────────────────
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
  const formId = target === "login" ? "loginForm" : "registerForm";
  const form = document.getElementById(formId);
  if (form) {
    form.classList.add("active-form");
    form.querySelector("input")?.focus();
  }
}

// ── Toggle mostrar/ocultar senha ───────────────────────────────
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
  if (pw.length >= 6)               score++;
  if (pw.length >= 10)              score++;
  if (/[A-Z]/.test(pw))            score++;
  if (/[0-9]/.test(pw))            score++;
  if (/[^A-Za-z0-9]/.test(pw))    score++;

  const levels = [
    { w: "0%",   color: "#e8ecf2", text: "" },
    { w: "25%",  color: "#ff3b30", text: "Fraca" },
    { w: "50%",  color: "#ff9500", text: "Regular" },
    { w: "75%",  color: "#ffcc00", text: "Boa" },
    { w: "100%", color: "#34c759", text: "Forte 💪" },
  ];
  const lvl             = levels[Math.min(score, 4)];
  fill.style.width      = pw.length === 0 ? "0%" : lvl.w;
  fill.style.background = lvl.color;
  label.textContent     = pw.length === 0 ? "" : lvl.text;
  label.style.color     = lvl.color;
}

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
      window.location.replace("index.html");
    } catch (err) {
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

    if (name.length < 2) {
      showError("registerError", "Informe seu nome completo.");
      return;
    }
    if (pw !== confirm) {
      showError("registerError", "As senhas não conferem.");
      return;
    }
    if (pw.length < 6) {
      showError("registerError", "A senha deve ter pelo menos 6 caracteres.");
      return;
    }

    setLoading("registerBtn", true);
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, pw);
      await updateProfile(credential.user, { displayName: name });
      window.location.replace("index.html");
    } catch (err) {
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
      document.getElementById("stepEmail").hidden   = true;
      document.getElementById("stepSuccess").hidden = false;
    } catch (err) {
      // Por segurança, não revelamos se o e-mail existe ou não
      if (err.code === "auth/invalid-email") {
        showError("forgotError", "Informe um e-mail válido.");
        setLoading("forgotBtn", false);
        return;
      }
      // Para qualquer outro erro (e-mail não existe, etc), mostramos sucesso
      document.getElementById("stepEmail").hidden   = true;
      document.getElementById("stepSuccess").hidden = false;
    }
  });
}
