// auth.js — Autenticação PulseNote via Firebase
// ============================================================
// Controla login, cadastro e recuperação de senha.
// Usado pelas páginas: login.html e forgot-password.html
// ============================================================

import { auth } from "./firebase-init.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ── Traduz códigos de erro do Firebase para mensagens em PT-BR ─
function translateAuthError(code) {
  const map = {
    "auth/email-already-in-use": "Este e-mail já está cadastrado.",
    "auth/invalid-email": "E-mail inválido.",
    "auth/weak-password": "A senha deve ter pelo menos 6 caracteres.",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
    "auth/network-request-failed": "Erro de conexão. Verifique sua internet.",
    "auth/user-disabled": "Esta conta foi desativada.",
    "auth/missing-password": "Informe sua senha.",
  };
  return map[code] || "Ocorreu um erro. Tente novamente.";
}

// ── Já está logado? Pula direto para o app ──────────────────────
// (evita o usuário logado ver a tela de login de novo)
let authCheckDone = false;
onAuthStateChanged(auth, (user) => {
  if (authCheckDone) return; // só redireciona na primeira checagem
  authCheckDone = true;

  const onLoginPage = window.location.pathname.endsWith("login.html");
  if (user && onLoginPage) {
    window.location.replace("index.html");
  }
});

// ════════════════════════════════════════════════════════════
//  TABS (login.html) — alterna entre Entrar / Criar conta
// ════════════════════════════════════════════════════════════
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
  document.querySelectorAll(".auth-form").forEach((f) => f.classList.remove("active-form"));
  const form = document.getElementById(target === "login" ? "loginForm" : "registerForm");
  if (form) {
    form.classList.add("active-form");
    form.querySelector("input")?.focus();
  }
}

// ════════════════════════════════════════════════════════════
//  Mostrar/ocultar senha
// ════════════════════════════════════════════════════════════
document.querySelectorAll(".toggle-pw").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    btn.textContent = input.type === "password" ? "👁️" : "🙈";
  });
});

// ════════════════════════════════════════════════════════════
//  Medidor de força da senha
// ════════════════════════════════════════════════════════════
["regPassword", "newPassword"].forEach((id) => {
  const input = document.getElementById(id);
  if (input) input.addEventListener("input", () => updateStrength(input.value));
});

function updateStrength(pw) {
  const fill = document.getElementById("pwStrengthFill");
  const label = document.getElementById("pwStrengthLabel");
  if (!fill || !label) return;

  let score = 0;
  if (pw.length >= 6) score++;
  if (pw.length >= 10) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  const levels = [
    { w: "0%", color: "#e8ecf2", text: "" },
    { w: "25%", color: "#ff3b30", text: "Fraca" },
    { w: "50%", color: "#ff9500", text: "Regular" },
    { w: "75%", color: "#ffcc00", text: "Boa" },
    { w: "100%", color: "#34c759", text: "Forte 💪" },
  ];

  const lvl = levels[Math.min(score, 4)];
  fill.style.width = pw.length === 0 ? "0%" : lvl.w;
  fill.style.background = lvl.color;
  label.textContent = pw.length === 0 ? "" : lvl.text;
  label.style.color = lvl.color;
}

// ════════════════════════════════════════════════════════════
//  Helpers de UI compartilhados
// ════════════════════════════════════════════════════════════
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
  btn.querySelector(".btn-text").hidden = loading;
  btn.querySelector(".btn-spinner").hidden = !loading;
}

// ════════════════════════════════════════════════════════════
//  LOGIN
// ════════════════════════════════════════════════════════════
const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("loginError");
    setLoading("loginBtn", true);

    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;

    try {
      await signInWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged vai cuidar do redirecionamento,
      // mas forçamos aqui para resposta imediata:
      window.location.replace("index.html");
    } catch (err) {
      showError("loginError", translateAuthError(err.code));
      setLoading("loginBtn", false);
    }
  });
}

// ════════════════════════════════════════════════════════════
//  CADASTRO
// ════════════════════════════════════════════════════════════
const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("registerError");

    const name = document.getElementById("regName").value.trim();
    const email = document.getElementById("regEmail").value.trim();
    const password = document.getElementById("regPassword").value;
    const confirm = document.getElementById("regPasswordConfirm").value;

    if (name.length < 2) {
      showError("registerError", "Informe seu nome completo.");
      return;
    }
    if (password !== confirm) {
      showError("registerError", "As senhas não conferem.");
      return;
    }

    setLoading("registerBtn", true);

    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      // Salva o nome no perfil do Firebase Auth
      await updateProfile(credential.user, { displayName: name });

      window.location.replace("index.html");
    } catch (err) {
      showError("registerError", translateAuthError(err.code));
      setLoading("registerBtn", false);
    }
  });
}

// ════════════════════════════════════════════════════════════
//  ESQUECI MINHA SENHA (forgot-password.html)
// ════════════════════════════════════════════════════════════
const forgotForm = document.getElementById("forgotForm");
if (forgotForm) {
  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("forgotError");
    setLoading("forgotBtn", true);

    const email = document.getElementById("forgotEmail").value.trim();

    try {
      await sendPasswordResetEmail(auth, email, {
        // Depois de redefinir, o Firebase manda o usuário pra esta URL
        url: window.location.origin + "/login.html",
      });
      document.getElementById("stepEmail").hidden = true;
      document.getElementById("stepSuccess").hidden = false;
    } catch (err) {
      // Por segurança, mesmo se o e-mail não existir, mostramos sucesso
      // (não revelamos quais e-mails estão cadastrados)
      if (err.code === "auth/invalid-email") {
        showError("forgotError", "E-mail inválido.");
        setLoading("forgotBtn", false);
        return;
      }
      document.getElementById("stepEmail").hidden = true;
      document.getElementById("stepSuccess").hidden = false;
    }
  });
}
