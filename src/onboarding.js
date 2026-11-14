// onboarding.js — Configuração inicial (3 passos + tela de sucesso).
// ============================================================
// Mostrada uma única vez para contas novas (sem dados). O estado vive no
// próprio state do app (onboardingDone / preferredWorkspace /
// notificationPrefs), então sincroniza com o Firestore como o resto.
//
// Passo 1 — Espaço: define o espaço de trabalho inicial.
// Passo 2 — WhatsApp: mesmo vínculo de Configurações (código + wa.me).
// Passo 3 — Notificações: quatro categorias, respeitadas pelo app e pelo
//           servidor de lembretes (ver notification-prefs.js).
// ============================================================
import { NOTIFICATION_PREF_KEYS, normalizeNotificationPrefs } from "./notification-prefs.js";

export const ONBOARDING_SPACES = [
  { id: "personal", label: "Pessoal", icon: "user", description: "Organize sua rotina, metas e finanças individuais." },
  { id: "family", label: "Família", icon: "users", description: "Planeje a rotina, despesas e compromissos em conjunto." },
  { id: "business", label: "Empresa", icon: "briefcase", description: "Gerencie tarefas, projetos e finanças do seu negócio." },
];

export const ONBOARDING_NOTIFICATIONS = [
  { key: "tasks", icon: "bell", label: "Lembretes de tarefas" },
  { key: "agenda", icon: "calendar", label: "Compromissos da agenda" },
  { key: "spending", icon: "bars", label: "Alertas de gastos" },
  { key: "dailySummary", icon: "star", label: "Resumo diário da rotina" },
];

const STEP_LABELS = ["Espaço", "WhatsApp", "Notificações"];

// Quem já usa o app (tem qualquer dado) nunca deve ver a configuração inicial.
export function hasUserData(state) {
  if (!state || typeof state !== "object") return false;
  const lists = ["tasks", "notes", "events", "goals", "finances", "financeAccounts", "finRecurrents"];
  return lists.some((key) => Array.isArray(state[key]) && state[key].length > 0) || Boolean(state.whatsappLinkedPhone);
}

export function shouldShowOnboarding(state) {
  return Boolean(state) && state.onboardingDone !== true;
}

export function spaceLabel(spaceId) {
  return ONBOARDING_SPACES.find((space) => space.id === spaceId)?.label || "Pessoal";
}

// 5531987654321 → "+55 31 98765-4321" (celular) | 553187654321 → "+55 31 8765-4321"
export function formatWhatsappPhone(digits) {
  const value = String(digits || "").replace(/\D/g, "");
  if (!value) return "";
  const match = value.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return match ? `+55 ${match[1]} ${match[2]}-${match[3]}` : `+${value}`;
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

function miniStepper(cardStep) {
  return `<ol class="bdo-mini" aria-hidden="true">${STEP_LABELS.map((label, index) => {
    const n = index + 1;
    const status = n < cardStep ? "done" : n === cardStep ? "active" : "todo";
    return `<li class="${status}"><span>${status === "done" ? icon("check") : n}</span><em>${label}</em></li>`;
  }).join("")}</ol>`;
}

function topStepper(current) {
  return `<ol class="bdo-top-steps" aria-label="Etapas">${STEP_LABELS.map((label, index) => {
    const n = index + 1;
    const status = n < current ? "done" : n === current ? "active" : "todo";
    return `<li class="${status}"${n === current ? ' aria-current="step"' : ""}><span>${status === "done" ? icon("check") : n}</span><em>${label}</em></li>`;
  }).join("")}</ol>`;
}

// ctx: { root, getState, patchState, setWorkspace, startWhatsappLink, requestPush,
//        botNumber, openView, toast, firstName }
export function createOnboarding(ctx) {
  const view = { open: false, step: 1, space: "personal", prefs: normalizeNotificationPrefs(null), done: false };
  const root = ctx.root;
  let bound = false;

  const state = () => ctx.getState() || {};
  const linkedPhone = () => state().whatsappLinkedPhone || "";
  const pendingCode = () => {
    const s = state();
    return s.whatsappLinkCode && s.whatsappLinkCodeExpiresAt && new Date(s.whatsappLinkCodeExpiresAt).getTime() > Date.now()
      ? { code: s.whatsappLinkCode, expiresAt: s.whatsappLinkCodeExpiresAt } : null;
  };

  function cardStep1() {
    return `<section class="bdo-card${cls(1)}" data-card="1" aria-label="Passo 1: espaço">
      ${miniStepper(1)}
      <h3><span class="only-d">1. Escolha seu espaço de trabalho</span><span class="only-m">Qual é o seu espaço?</span></h3>
      <p class="bdo-lead"><span class="only-d">Selecione como você pretende usar o PulseNote agora.<br/>Você pode criar outros espaços depois.</span><span class="only-m">Escolha como você pretende usar o PulseNote agora.</span></p>
      <div class="bdo-options" role="radiogroup" aria-label="Espaço de trabalho">
        ${ONBOARDING_SPACES.map((space) => `<button type="button" class="bdo-option${view.space === space.id ? " selected" : ""}" role="radio" aria-checked="${view.space === space.id}" data-ob-space="${space.id}">
          <span class="bdo-option-ico">${icon(space.icon)}</span>
          <span class="bdo-option-text"><strong>${space.label}</strong><small>${space.description}</small></span>
          <span class="bdo-radio" aria-hidden="true"></span>
        </button>`).join("")}
      </div>
      <div class="bdo-actions end">
        <button type="button" class="bd-btn bd-btn--primary" data-ob="next">Próximo ${icon("arrow-right")}</button>
      </div>
    </section>`;
  }

  function cardStep2() {
    const phone = linkedPhone();
    const pending = pendingCode();
    const waitingMinutes = pending ? Math.max(1, Math.round((new Date(pending.expiresAt).getTime() - Date.now()) / 60000)) : 0;
    return `<section class="bdo-card${cls(2)}" data-card="2" aria-label="Passo 2: WhatsApp">
      ${miniStepper(2)}
      <h3><span class="only-d">2. Conecte seu WhatsApp</span><span class="only-m">Conecte seu WhatsApp</span></h3>
      <p class="bdo-lead">Integre seu WhatsApp para capturar tarefas, compromissos e gastos por mensagem.</p>
      <div class="bdo-wa-box${phone ? " is-linked" : ""}">
        <span class="bdo-wa-ico">${icon("whatsapp")}</span>
        <span class="bdo-wa-text"><strong>${phone ? "WhatsApp conectado" : "Conectar WhatsApp"}</strong>${phone ? `<small>${esc(formatWhatsappPhone(phone))}</small>` : ""}</span>
        ${phone ? `<span class="bdo-chip">Conectado</span>` : ""}
      </div>
      <ul class="bdo-checks">
        <li>${icon("check")}Envie tarefas, lembretes e gastos</li>
        <li>${icon("check")}Funciona 24/7 com a IA do PulseNote</li>
        <li>${icon("check")}Seguro e privado</li>
      </ul>
      ${!phone && pending ? `<div class="bdo-code" role="status">
        <p>Envie <b>vincular ${esc(pending.code)}</b> para <b>${esc(ctx.botNumber)}</b> no WhatsApp. O código vale por mais ${waitingMinutes} min. Esta tela atualiza sozinha quando o vínculo for confirmado.</p>
      </div>` : ""}
      <div class="bdo-actions">
        ${phone
          ? `<button type="button" class="bd-btn bd-btn--primary" data-ob="next">Próximo ${icon("arrow-right")}</button>`
          : `<button type="button" class="bd-btn bd-btn--primary" data-ob="whatsapp">${pending ? "Abrir WhatsApp de novo" : "Conectar WhatsApp"} ${icon("external")}</button>`}
      </div>
      <div class="bdo-links">
        <button type="button" class="bdo-skip" data-ob="back">${icon("arrow-left")}Voltar</button>
        ${phone ? "" : `<button type="button" class="bdo-skip" data-ob="next">Pular por enquanto</button>`}
      </div>
    </section>`;
  }

  function cardStep3() {
    return `<section class="bdo-card${cls(3)}" data-card="3" aria-label="Passo 3: notificações">
      ${miniStepper(3)}
      <h3><span class="only-d">3. Preferências de notificações</span><span class="only-m">Preferências de notificações</span></h3>
      <p class="bdo-lead">Escolha como o PulseNote deve te avisar sobre o que importa.</p>
      <div class="bdo-toggles">
        ${ONBOARDING_NOTIFICATIONS.map((item) => `<div class="bdo-toggle">
          <span class="bdo-toggle-ico">${icon(item.icon)}</span>
          <span class="bdo-toggle-label" id="bdoLbl-${item.key}">${item.label}</span>
          <button type="button" class="bdo-switch${view.prefs[item.key] ? " on" : ""}" role="switch" aria-checked="${view.prefs[item.key]}" aria-labelledby="bdoLbl-${item.key}" data-ob-pref="${item.key}"><i></i></button>
        </div>`).join("")}
      </div>
      <div class="bdo-actions">
        <button type="button" class="bd-btn bdo-back-btn" data-ob="back">${icon("arrow-left")}Voltar</button>
        <button type="button" class="bd-btn bd-btn--primary" data-ob="finish">Concluir configuração</button>
      </div>
    </section>`;
  }

  function cls(step) {
    return view.step === step ? " is-active" : step < view.step ? " is-done" : " is-todo";
  }

  function renderWizard() {
    return `<div class="bdo-panel" data-step="${view.step}">
      <header class="bdo-head">
        <button type="button" class="bdo-back-arrow" data-ob="${view.step === 1 ? "skip" : "back"}" aria-label="${view.step === 1 ? "Pular configuração" : "Voltar"}">${icon("arrow-left")}</button>
        <div class="bdo-title"><h2 id="bdoTitle">Configuração inicial</h2><p>Deixe o PulseNote com a sua cara. Leva menos de 2 minutos.</p></div>
        ${topStepper(view.step)}
      </header>
      <div class="bdo-progress" role="progressbar" aria-valuemin="1" aria-valuemax="3" aria-valuenow="${view.step}" aria-label="Passo ${view.step} de 3">
        <span>Passo ${view.step} de 3</span>
        <div class="bdo-bars">${[1, 2, 3].map((n) => `<i class="${n <= view.step ? "on" : ""}"></i>`).join("")}</div>
      </div>
      <div class="bdo-cards">${cardStep1()}${cardStep2()}${cardStep3()}</div>
    </div>`;
  }

  function renderDone() {
    const phone = linkedPhone();
    return `<div class="bdo-panel bdo-done" role="status">
      <span class="bdo-done-ico">${icon("check")}</span>
      <h2 id="bdoTitle">${phone ? "WhatsApp conectado<br/>com sucesso!" : "Tudo pronto,<br/>" + esc(ctx.firstName()) + "!"}</h2>
      <p>Seu PulseNote está pronto para organizar sua rotina com a ajuda da IA.</p>
      <ul class="bdo-summary">
        <li><span class="bdo-sum-ico">${icon("whatsapp")}</span><span><strong>WhatsApp</strong><small>${phone ? esc(formatWhatsappPhone(phone)) : "Não conectado"}</small></span>${phone ? `<span class="bdo-chip">Conectado</span>` : `<button type="button" class="bdo-chip bdo-chip--btn" data-ob="settings">Conectar</button>`}</li>
        <li><span class="bdo-sum-ico">${icon("pulse-line")}</span><span><strong>Conversas com IA</strong><small>Ativada</small></span><span class="bdo-chip">Ativa</span></li>
        <li><span class="bdo-sum-ico">${icon(ONBOARDING_SPACES.find((s) => s.id === view.space)?.icon || "user")}</span><span><strong>Espaço atual</strong><small>${esc(spaceLabel(view.space))}</small></span></li>
      </ul>
      <button type="button" class="bd-btn bd-btn--primary bdo-wide" data-ob="enter">Entrar no PulseNote ${icon("arrow-right")}</button>
      <button type="button" class="bd-btn bdo-wide" data-ob="invite">${icon("user-plus")}Convidar família</button>
    </div>`;
  }

  function render() {
    if (!view.open) { root.hidden = true; root.innerHTML = ""; document.body.classList.remove("bdo-open"); return; }
    const focusKey = document.activeElement?.dataset?.obSpace || document.activeElement?.dataset?.obPref || document.activeElement?.dataset?.ob || "";
    root.hidden = false;
    document.body.classList.add("bdo-open");
    root.innerHTML = view.done ? renderDone() : renderWizard();
    if (focusKey) {
      const next = root.querySelector(`[data-ob-space="${focusKey}"], [data-ob-pref="${focusKey}"], .is-active [data-ob="${focusKey}"]`);
      next?.focus({ preventScroll: true });
    }
  }

  function goTo(step) { view.step = Math.min(3, Math.max(1, step)); render(); }

  async function finish() {
    const anyOn = NOTIFICATION_PREF_KEYS.some((key) => view.prefs[key]);
    const patch = { onboardingDone: true, preferredWorkspace: view.space, notificationPrefs: { ...view.prefs } };
    if (anyOn) {
      let allowed = false;
      try { allowed = Boolean(await ctx.requestPush()); } catch { allowed = false; }
      patch.appReminderOptIn = allowed;
      if (!allowed) ctx.toast("Os avisos no aparelho estão bloqueados. Você pode ativá-los depois em Configurações.");
    }
    ctx.setWorkspace(view.space);
    ctx.patchState(patch);
    view.done = true;
    render();
  }

  function skip() {
    if (!window.confirm("Pular a configuração inicial? Você pode ajustar tudo depois em Configurações.")) return;
    ctx.patchState({ onboardingDone: true });
    close();
  }

  function close() { view.open = false; view.done = false; render(); }

  function onClick(event) {
    const spaceBtn = event.target.closest("[data-ob-space]");
    if (spaceBtn) { view.space = spaceBtn.dataset.obSpace; render(); return; }
    const prefBtn = event.target.closest("[data-ob-pref]");
    if (prefBtn) { const key = prefBtn.dataset.obPref; view.prefs[key] = !view.prefs[key]; render(); return; }
    const action = event.target.closest("[data-ob]")?.dataset.ob;
    if (!action) return;
    if (action === "next") goTo(view.step + 1);
    else if (action === "back") goTo(view.step - 1);
    else if (action === "whatsapp") { ctx.startWhatsappLink(); render(); }
    else if (action === "finish") finish();
    else if (action === "skip") skip();
    else if (action === "enter") { close(); ctx.openView("dashboard"); }
    else if (action === "invite") { close(); ctx.openView("finances", { focus: "#finSharedSpacesList" }); }
    else if (action === "settings") { close(); ctx.openView("settings"); }
  }

  function bind() {
    if (bound) return;
    bound = true;
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && view.open && !view.done) skip();
    });
  }

  return {
    // Chamado a cada snapshot do app: abre para conta nova, atualiza o passo do
    // WhatsApp quando o vínculo chega pelo webhook e nunca reabre para quem terminou.
    sync() {
      bind();
      const s = state();
      if (!view.open) {
        if (!shouldShowOnboarding(s)) return;
        view.open = true;
        view.step = 1;
        view.space = ONBOARDING_SPACES.some((space) => space.id === s.preferredWorkspace) ? s.preferredWorkspace : "personal";
        view.prefs = normalizeNotificationPrefs(s.notificationPrefs);
        render();
        return;
      }
      if (!view.done) render();
    },
    // Somente QA visual (?designPreview=1&onboarding=1|2|3|done)
    preview(step) {
      bind();
      view.open = true;
      view.done = step === "done";
      view.step = view.done ? 3 : Math.min(3, Math.max(1, Number(step) || 1));
      render();
    },
    isOpen: () => view.open,
    close,
    _view: view,
  };
}
