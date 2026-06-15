// auth.js — PulseNote authentication client
const API = "http://localhost:3001/api";

// ── Token helpers ──────────────────────────────────────────────
function saveSession(token, user) {
  localStorage.setItem("pn_token", token);
  localStorage.setItem("pn_user", JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem("pn_token");
  localStorage.removeItem("pn_user");
}

function getToken() { return localStorage.getItem("pn_token"); }
function getUser()  { return JSON.parse(localStorage.getItem("pn_user") || "null"); }

// Redirect to app if already logged in
if (window.location.pathname.includes("login.html") || window.location.pathname === "/" || window.location.pathname.endsWith("login.html")) {
  if (getToken()) window.location.replace("index.html");
}

// ── Tab switching ──────────────────────────────────────────────
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
  document.querySelectorAll(".auth-form").forEach((f) => {
    f.classList.remove("active-form");
  });
  const form = document.getElementById(target === "login" ? "loginForm" : "registerForm");
  if (form) {
    form.classList.add("active-form");
    form.querySelector("input")?.focus();
  }
}

// ── Password visibility toggle ──────────────────────────────────
document.querySelectorAll(".toggle-pw").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    btn.textContent = input.type === "password" ? "👁️" : "🙈";
  });
});

// ── Password strength meter ─────────────────────────────────────
const pwInputs = ["regPassword", "newPassword"];
pwInputs.forEach((id) => {
  const input = document.getElementById(id);
  if (!input) return;
  input.addEventListener("input", () => updateStrength(input.value));
});

function updateStrength(pw) {
  const fill  = document.getElementById("pwStrengthFill");
  const label = document.getElementById("pwStrengthLabel");
  if (!fill || !label) return;

  let score = 0;
  if (pw.length >= 6)                       score++;
  if (pw.length >= 10)                      score++;
  if (/[A-Z]/.test(pw))                     score++;
  if (/[0-9]/.test(pw))                     score++;
  if (/[^A-Za-z0-9]/.test(pw))             score++;

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

// ── Shared: show error ──────────────────────────────────────────
function showError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.hidden      = false;
}

function hideError(elId) {
  const el = document.getElementById(elId);
  if (el) el.hidden = true;
}

// ── Shared: loading state ───────────────────────────────────────
function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector(".btn-text").hidden   = loading;
  btn.querySelector(".btn-spinner").hidden = !loading;
}

// ── LOGIN ───────────────────────────────────────────────────────
const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("loginError");
    setLoading("loginBtn", true);

    const email    = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;

    try {
      const res  = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        showError("loginError", data.error || "Erro ao entrar.");
        return;
      }

      saveSession(data.token, data.user);
      window.location.replace("index.html");
    } catch {
      showError("loginError", "Erro de conexão. Verifique se o servidor está rodando.");
    } finally {
      setLoading("loginBtn", false);
    }
  });
}

// ── REGISTER ────────────────────────────────────────────────────
const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError("registerError");

    const name     = document.getElementById("regName").value.trim();
    const email    = document.getElementById("regEmail").value.trim();
    const password = document.getElementById("regPassword").value;
    const confirm  = document.getElementById("regPasswordConfirm").value;

    if (password !== confirm) {
      showError("registerError", "As senhas não conferem.");
      return;
    }

    setLoading("registerBtn", true);

    try {
      const res  = await fetch(`${API}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        showError("registerError", data.error || "Erro ao criar conta.");
        return;
      }

      saveSession(data.token, data.user);
      window.location.replace("index.html");
    } catch {
      showError("registerError", "Erro de conexão. Verifique se o servidor está rodando.");
    } finally {
      setLoading("registerBtn", false);
    }
  });
}
