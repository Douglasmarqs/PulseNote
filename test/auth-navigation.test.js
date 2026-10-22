const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = (file) => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
const withoutImports = (code) => code.replace(/^import[\s\S]*?;\r?\n/gm, "");

function fakeElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    hidden: false,
    value: "",
    listeners,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    querySelector: () => null,
    setAttribute() {},
    focus() {},
  };
}

function authHarness(search, options = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  const googleButton = fakeElement();
  const navigations = [];
  const calls = [];
  let onAuthChange;
  const auth = { currentUser: options.currentUser || null };
  const location = {
    search,
    pathname: "/login",
    replace: (target) => navigations.push(target),
  };
  const document = {
    getElementById: element,
    querySelector: () => null,
    querySelectorAll: (selector) => selector === "[data-google-signin]" ? [googleButton] : [],
  };
  vm.runInNewContext(withoutImports(source("auth.js")), {
    auth,
    googleProvider: {},
    document,
    window: { location },
    localStorage: { setItem() {} },
    URLSearchParams,
    console: { error() {} },
    onAuthStateChanged: (_auth, callback) => { onAuthChange = callback; return () => {}; },
    getRedirectResult: async () => options.redirectResult || null,
    signInWithPopup: async () => { calls.push("google-popup"); return { user: { uid: "google-user" } }; },
    signInWithRedirect: async () => { calls.push("google-redirect"); },
    signInWithEmailAndPassword: async () => { calls.push("email-login"); return { user: { uid: "email-user" } }; },
    signOut: async () => { calls.push("sign-out"); auth.currentUser = null; },
    createUserWithEmailAndPassword: async () => ({ user: {} }),
    sendPasswordResetEmail: async () => {},
    sendEmailVerification: async () => {},
    updateProfile: async () => {},
  }, { filename: "src/auth.js" });
  return { auth, calls, element, googleButton, navigations, onAuthChange };
}

test("somente next=/admin altera o destino; URLs externas e rotas desconhecidas caem em /app", () => {
  const cases = [
    ["?next=%2Fadmin", "/admin"],
    ["", "/app"],
    ["?next=%2Fapp", "/app"],
    ["?next=https%3A%2F%2Fevil.example%2Fadmin", "/app"],
    ["?next=%2F%2Fevil.example", "/app"],
    ["?next=%2Fapi%2Fadmin", "/app"],
    ["?next=%2Fadmin%2Fusers", "/app"],
    ["?next=%2Fadmin%3Fx%3D1", "/app"],
  ];
  for (const [search, expected] of cases) {
    const harness = authHarness(search);
    harness.onAuthChange({ uid: "already-signed-in" });
    assert.deepEqual(harness.navigations, [expected], `search=${search}`);
  }
});

test("login iniciado pelo admin retorna ao admin com Google e com e-mail/senha", async () => {
  const google = authHarness("?next=%2Fadmin", { currentUser: { uid: "old-user" } });
  await google.googleButton.listeners.get("click")();
  assert.deepEqual(google.calls, ["sign-out", "google-popup"]);
  assert.deepEqual(google.navigations, ["/admin"]);

  const email = authHarness("?next=%2Fadmin");
  email.element("loginEmail").value = "admin@example.com";
  email.element("loginPassword").value = "example-password";
  await email.element("loginForm").listeners.get("submit")({ preventDefault() {} });
  assert.deepEqual(email.calls, ["email-login"]);
  assert.deepEqual(email.navigations, ["/admin"]);
});

test("trocar conta administrativa não redireciona automaticamente a sessão antiga", async () => {
  const harness = authHarness("?next=%2Fadmin&switch=1", { currentUser: { uid: "old-user" } });
  harness.onAuthChange(harness.auth.currentUser);
  assert.deepEqual(harness.navigations, []);
  await harness.googleButton.listeners.get("click")();
  assert.deepEqual(harness.calls, ["sign-out", "google-popup"]);
  assert.deepEqual(harness.navigations, ["/admin"]);
});

test("retorno do redirecionamento Google também respeita o destino administrativo", async () => {
  const harness = authHarness("?next=%2Fadmin", { redirectResult: { user: { uid: "google-user" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.navigations, ["/admin"]);
});

test("primeira visita pelo admin mostra Entrar, não Criar conta", () => {
  const html = source("login.html");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((code) => code.includes('new URLSearchParams(location.search).get("next")'));
  assert.ok(script, "script de seleção inicial da aba de autenticação");
  for (const [search, expected] of [["?next=%2Fadmin", "login"], ["", "register"]]) {
    const loginTab = fakeElement();
    const registerTab = fakeElement();
    const loginForm = fakeElement();
    const registerForm = fakeElement();
    loginTab.dataset = { tab: "login" };
    registerTab.dataset = { tab: "register" };
    loginForm.id = "loginForm";
    registerForm.id = "registerForm";
    loginTab.classList.add("active");
    loginForm.classList.add("active-form");
    vm.runInNewContext(script, {
      location: { search },
      URLSearchParams,
      localStorage: { getItem: () => null },
      document: {
        querySelectorAll: (selector) => selector === ".auth-tab"
          ? [loginTab, registerTab] : [loginForm, registerForm],
      },
    }, { filename: "src/login.html:inline-script" });
    assert.equal(loginTab.classList.contains("active"), expected === "login", search);
    assert.equal(registerTab.classList.contains("active"), expected === "register", search);
    assert.equal(loginForm.classList.contains("active-form"), expected === "login", search);
    assert.equal(registerForm.classList.contains("active-form"), expected === "register", search);
  }
});

test("portão administrativo oferece entrada com retorno e troca de conta após 403", async () => {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, fakeElement());
    return elements.get(selector);
  };
  let onAuthChange;
  vm.runInNewContext(withoutImports(source("admin.js")), {
    auth: {},
    onAuthStateChanged: (_auth, callback) => { onAuthChange = callback; },
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden" }) }),
    URLSearchParams,
    setTimeout,
    clearTimeout,
    window: {},
  }, { filename: "src/admin.js" });

  await onAuthChange(null);
  assert.match(element("#adGate").innerHTML, /href="\/login\?next=%2Fadmin"/);

  await onAuthChange({ email: "other@example.com", getIdToken: async () => "token" });
  assert.match(element("#adGate").innerHTML, /href="\/login\?next=%2Fadmin&amp;switch=1"/);
  assert.match(element("#adGate").innerHTML, /href="\/app"/);
  assert.equal(element("#adContent").hidden, true);
});
