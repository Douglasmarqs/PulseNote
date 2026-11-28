import { auth } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { renderPlanCards, renderIntervalToggle, PLAN_ACCENTS } from "./plan-cards.js";

// ════════════════════════════════════════════════════════════════════
// PulseNote · Painel administrativo
// Toda permissão é conferida pelo servidor (/api/admin). Aqui a interface
// só esconde o que o papel não pode fazer e explica cada ação.
// ════════════════════════════════════════════════════════════════════

const FEATURE_LABELS = {
  whatsapp: ["WhatsApp", "Comandos, lançamentos e consultas por mensagem"],
  aiParsing: ["Interpretação com IA", "Reconhecimento inteligente de texto"],
  reminders: ["Lembretes", "Agendamento de notificações e avisos"],
  autopilot: ["Pulse Autopilot", "Sugestões úteis com confirmação do usuário"],
  mediaRecognition: ["Fotos, áudio e PDF", "Leitura de comprovantes, boletos, documentos e comandos de voz"],
  whatsappReminders: ["Lembretes no WhatsApp", "Avisos agendados enviados para o número vinculado"],
  pushNotifications: ["Notificações push", "Avisos entregues mesmo com o aplicativo fechado"],
  pdfReports: ["Relatórios em PDF", "Geração e envio de relatórios financeiros pelo WhatsApp"],
};
const FEATURE_GROUPS = [
  ["Comunicação e alertas", ["whatsapp", "reminders", "whatsappReminders", "pushNotifications"]],
  ["Automação e inteligência", ["aiParsing", "mediaRecognition", "autopilot"]],
  ["Relatórios", ["pdfReports"]],
];
const AREA_LABELS = { dashboard: "Início", planner: "Planner", notes: "Notas", finances: "Finanças", autopilot: "Autopilot", profile: "Perfil", settings: "Configurações" };
// Abreviações dos papéis para a tabela de permissões no celular.
const ROLE_SHORT = { owner: "Prop.", admin: "Adm.", finance: "Fin.", support: "Sup.", viewer: "Leit." };

const SECTION_LABELS = {
  overview: "Visão geral", users: "Usuários", subscriptions: "Acessos e testes", plans: "Estúdio de planos", charges: "Cobranças",
  features: "Recursos", integrations: "Integrações", security: "Equipe e segurança", settings: "Operação",
};
const SECTION_SUBTITLES = {
  overview: "Usuários, planos, cobranças e a operação do PulseNote em um só lugar.",
  users: "Busque, selecione e gerencie o acesso de cada pessoa.",
  subscriptions: "Teste grátis, regra de quem está sem plano e prazos acabando.",
  plans: "Crie, precifique e publique. A prévia mostra exatamente o que a pessoa vê no app para assinar.",
  charges: "Cobranças, recebimentos e como o dinheiro chega até você.",
  features: "Ligue ou desligue recursos para todos os usuários.",
  integrations: "Credenciais, eventos e saúde dos serviços.",
  security: "Quem acessa o painel e o que cada papel pode fazer.",
  settings: "Manutenção e funcionamento do app.",
};
const AUDIT_LABELS = {
  admin_access_granted: ["Acesso ao painel concedido", "shield"],
  admin_access_revoked: ["Acesso ao painel removido", "shield"],
  config_updated: ["Configurações alteradas", "gear"],
  maintenance_enabled: ["Manutenção ativada", "wrench"],
  maintenance_disabled: ["Manutenção encerrada", "wrench"],
  plan_saved: ["Plano salvo", "layers"],
  plans_reordered: ["Ordem da vitrine alterada", "grip"],
  entitlement_set: ["Plano de usuário alterado", "repeat"],
  access_assign: ["Plano atribuído", "layers"],
  access_trial: ["Teste grátis concedido", "gift"],
  access_trial_auto: ["Teste automático iniciado", "gift"],
  access_extend: ["Prazo estendido", "hourglass"],
  access_pause: ["Acesso pausado", "pause"],
  access_resume: ["Acesso retomado", "play"],
  access_remove: ["Plano removido", "trash"],
  manual_charge_created: ["Cobrança criada", "receipt"],
  manual_charge_updated: ["Cobrança atualizada", "wallet"],
  user_disabled: ["Conta desativada", "user"],
  user_enabled: ["Conta reativada", "user"],
};
const INTEGRATION_BADGES = { firebase: ["F", "#f5a623"], whatsapp: ["W", "#25d366"], gemini: ["G", "#4f8cff"], "ai-gateway": ["IA", "#8b7bff"], qstash: ["Q", "#22c3ee"], stripe: ["S", "#635bff"] };
const SEGMENTS = [
  ["plan", "Com plano", "#16a768"],
  ["trial", "Em teste", "#f5a623"],
  ["none", "Plano gratuito", "#7d88a8"],
  ["attention", "Vencidos ou pausados", "#e5484d"],
  ["disabled", "Desativados", "#4b5679"],
];
const USER_FILTERS = [
  ["all", "Todos"], ["plan", "Com plano"], ["trial", "Em teste"], ["none", "Plano gratuito"],
  ["attention", "Vencidos/pausados"], ["pending", "Cobrança pendente"], ["disabled", "Desativados"],
];
const ROLE_INFO = {
  owner: ["Proprietário", "Tudo, inclusive a equipe"],
  admin: ["Administrador", "Tudo, exceto a equipe"],
  finance: ["Financeiro", "Planos, cobranças e acessos"],
  support: ["Suporte", "Testes, prazos e planos dos usuários"],
  viewer: ["Leitura", "Só visualiza"],
};
const PERMISSION_LABELS = [
  ["view", "Ver painel, usuários e relatórios"],
  ["users.access", "Dar teste, atribuir plano, estender e remover"],
  ["charges.manage", "Criar e baixar cobranças"],
  ["plans.manage", "Criar e editar planos"],
  ["users.status", "Desativar ou reativar contas"],
  ["config.manage", "Recursos, manutenção, Pix e regras de acesso"],
  ["admins.manage", "Gerenciar a equipe do painel"],
];
const ROLE_PERMISSIONS_UI = {
  owner: ["view", "users.access", "users.status", "plans.manage", "charges.manage", "config.manage", "admins.manage"],
  admin: ["view", "users.access", "users.status", "plans.manage", "charges.manage", "config.manage"],
  finance: ["view", "users.access", "plans.manage", "charges.manage"],
  support: ["view", "users.access"],
  viewer: ["view"],
};
const ERROR_MESSAGES = {
  permission_denied: "Seu papel não permite essa ação.",
  owner_required: "Só o proprietário principal pode fazer isso.",
  cannot_change_owner: "O proprietário e a sua própria conta não podem ser alterados aqui.",
  role_managed_by_server: "Essa pessoa já é administradora pela configuração do servidor.",
  verified_email_required: "A conta precisa ter o e-mail confirmado.",
  "auth/user-not-found": "Não existe conta com esse e-mail.",
  user_not_found: "Conta não encontrada.",
  plan_required: "Escolha um plano.",
  plan_unavailable: "Esse plano não está ativo.",
  invalid_days: "Informe uma quantidade de dias válida.",
  invalid_valid_until: "A data de fim precisa ser hoje ou depois.",
  too_many_users: "Selecione no máximo 200 pessoas por vez.",
  uids_required: "Selecione ao menos uma pessoa.",
  invalid_charge: "Confira o valor, o vencimento e o prazo da cobrança.",
  charge_already_finalized: "Essa cobrança já foi finalizada.",
  invalid_access_policy: "Escolha um plano gratuito ativo.",
  invalid_trial: "Escolha um plano ativo e de 1 a 90 dias.",
  invalid_plan: "Confira o identificador e o nome do plano.",
  invalid_plan_billing: "Confira o preço e o Stripe Price ID.",
  invalid_plan_ai_limit: "Conversas com IA: número de 0 a 5000.",
  cannot_disable_admin: "Não é possível desativar um administrador.",
  cannot_disable_self: "Você não pode desativar a própria conta.",
  internal_error: "Erro no servidor. Tente de novo em instantes.",
  unauthorized: "Sua sessão expirou. Entre novamente.",
};
const state = {
  user: null, me: null, config: null, plans: [], directory: [], directoryAt: 0, selection: new Set(),
  userFilter: "all", userSearch: "", userPlanFilter: "", userSort: "recent", userLimit: 30,
  charges: [], chargeFilter: "pending", chargeSearch: "", accessTab: "trial", admins: [], audit: [],
  integrations: null, currentSection: "overview", loadSequence: 0, authSequence: 0, isOwner: false, dashboard: null, growthRange: 30,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector, root = document) => (typeof root?.querySelectorAll === "function" ? [...root.querySelectorAll(selector)] : []);

// ── Tema e ambiente ──────────────────────────────────────────────────
function storageGet(key) { try { return globalThis.localStorage?.getItem(key) || null; } catch { return null; } }
function storageSet(key, value) { try { globalThis.localStorage?.setItem(key, value); } catch { /* sem armazenamento */ } }

function applyTheme(choice = storageGet("pulsenote-theme") || "aurora") {
  const normalized = choice === "light" ? "light" : choice === "eclipse" ? "eclipse" : "aurora";
  document.documentElement?.setAttribute("data-theme", normalized);
  storageSet("pulsenote-theme", normalized);
  $("#adThemeButton")?.setAttribute("aria-label", normalized === "light" ? "Ativar tema escuro" : "Ativar tema claro");
  if ($("#adThemeButton")) $("#adThemeButton").innerHTML = icon(normalized === "light" ? "moon" : "sun");
}

function renderEnvironmentLabel(hostname = globalThis.location?.hostname || "") {
  const label = $("#adEnvironment");
  if (!label) return;
  if (hostname === "pulse-note-5erj.vercel.app") {
    label.textContent = "Ambiente de produção";
    return;
  }
  label.textContent = /^(?:localhost|127\.0\.0\.1)$/.test(hostname) ? "Ambiente local" : "Ambiente de prévia";
}

applyTheme();
renderEnvironmentLabel();

// ── Utilidades ───────────────────────────────────────────────────────
function icon(id) {
  return `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function initials(value) {
  return String(value || "PN").split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "PN";
}

function money(cents) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format((Number(cents) || 0) / 100);
}

function parseMoney(raw) {
  const clean = String(raw || "").trim().replace(/\s|R\$/g, "");
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  if (!normalized) return 0;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return NaN;
  return Math.round(Number(normalized) * 100);
}

function readableDate(value) {
  if (!value) return "—";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(date).replace(/\./g, "");
}

function shortDate(value) {
  if (!value) return "";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(date);
}

function readableTimestamp(value) {
  if (!value) return "nenhuma atividade registrada";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "data indisponível" : new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function relativeTime(value) {
  if (!value) return "nunca";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.min(0, Math.round((date.getTime() - Date.now()) / 1000));
  if (seconds > -60) return "agora mesmo";
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === "minute") return formatter.format(Math.round(seconds / size), unit);
  }
  return "agora";
}

// Data e hora por extenso curto: "28 nov 2026, 18:59" (ano some quando é o atual).
function dateTimeShort(value, { time = true } = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const text = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: sameYear ? undefined : "numeric", hour: time ? "2-digit" : undefined, minute: time ? "2-digit" : undefined, timeZone: "America/Sao_Paulo" }).format(date);
  return text.replace(/\./g, "").replace(" de ", " ").replace(" de ", " ");
}

function daysSince(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

// Quão recente foi o último uso: cor + rótulo (hoje, semana, mês, inativa).
function freshness(value) {
  if (!value) return { tone: "is-never", label: "Nunca usou o app" };
  const days = daysSince(value);
  if (days === null) return { tone: "is-never", label: "Sem registro" };
  const hours = (Date.now() - new Date(value).getTime()) / 3600000;
  if (hours < 24) return { tone: "is-hot", label: "Ativa hoje" };
  if (days <= 7) return { tone: "is-warm", label: "Ativa nesta semana" };
  if (days <= 30) return { tone: "is-cool", label: "Ativa neste mês" };
  return { tone: "is-cold", label: `Inativa há ${plural(days, "dia", "dias")}` };
}

function tenureText(value) {
  const days = daysSince(value);
  if (days === null) return "";
  if (days < 1) return "conta nova, de hoje";
  if (days < 60) return `${plural(days, "dia", "dias")} de conta`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${plural(months, "mês", "meses")} de conta`;
  return `${plural(Math.floor(days / 365.25), "ano", "anos")} de conta`;
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function plural(count, one, many) {
  return `${Number(count).toLocaleString("pt-BR")} ${count === 1 ? one : many}`;
}

function errorText(error) {
  const code = error?.message || "";
  return ERROR_MESSAGES[code] || (code.startsWith("HTTP") ? "Falha de comunicação com o servidor." : code || "Algo deu errado.");
}

function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

function can(permission) {
  return Boolean(state.me?.permissions?.includes(permission));
}

function toast(message, isError = false) {
  const element = $("#adToast");
  if (!element) return;
  element.innerHTML = `<span class="ad-toast-ico">${icon(isError ? "alert" : "check")}</span><span>${escapeHtml(message)}</span>`;
  element.classList.toggle("is-error", isError);
  element.hidden = false;
  element.classList.remove("is-in");
  void element.offsetWidth;
  element.classList.add("is-in");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 5500);
}

function setLoadError(message = "") {
  const banner = $("#adLoadError");
  banner.hidden = !message;
  $("#adLoadErrorText").textContent = message;
}

function closeMenu() {
  $("#pnRail").classList.remove("is-open");
  $("#adMenuBackdrop").hidden = true;
  $("#adMenuButton").setAttribute("aria-expanded", "false");
  $("#adMenuButton").setAttribute("aria-label", "Abrir menu");
}

// Prévia local (QA visual): só com ?designPreview=1 em localhost ou nas
// prévias do projeto — o domínio oficial não corresponde, então em produção
// isto é sempre falso. Usa dados inventados (admin-preview.js), sem login.
const PREVIEW = (() => {
  try {
    const host = globalThis.location?.hostname || "";
    const flag = new URLSearchParams(globalThis.location?.search || "").get("designPreview") === "1";
    return flag && (/^(?:localhost|127\.0\.0\.1)$/.test(host) || /^pulse-note-5erj-[a-z0-9-]+-douglas-projects-c831a9fc\.vercel\.app$/i.test(host));
  } catch { return false; }
})();
let previewModule = null;

async function request(action, body, query = {}) {
  if (PREVIEW) {
    previewModule ||= await import("./admin-preview.js");
    return previewModule.previewRequest(action, body, query);
  }
  const token = await state.user.getIdToken();
  const params = new URLSearchParams({ action, ...query });
  const response = await fetch(`/api/admin?${params}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

// Esconde o que o papel não permite (o servidor recusa de qualquer jeito).
function applyPermissions() {
  for (const element of $$("[data-perm]")) {
    const allowed = can(element.dataset.perm);
    if (element.tagName === "FORM") {
      element.classList.toggle("is-readonly", !allowed);
      for (const field of $$("input, select, textarea, button", element)) field.disabled = !allowed;
      let note = element.querySelector(".ac-readonly-note");
      if (!allowed && !note) {
        note = document.createElement("p");
        note.className = "ac-readonly-note";
        note.innerHTML = `${icon("lock")}Seu papel permite só visualizar esta parte.`;
        element.prepend(note);
      } else if (allowed && note) note.remove();
    } else element.hidden = !allowed;
  }
}

// ── Modal e confirmação ──────────────────────────────────────────────
let modalCleanup = null;
function openModal({ kicker = "", title, body, actions = [], wide = false, onOpen, icon: iconName = "", tone = "" }) {
  const modal = $("#adModal");
  $("#adModalKicker").textContent = kicker;
  const badge = $("#adModalIco");
  if (badge) { badge.className = `ac-modal-ico ${tone}`; badge.innerHTML = iconName ? icon(iconName) : ""; badge.hidden = !iconName; }
  $("#adModalTitle").textContent = title;
  $("#adModalBody").innerHTML = body;
  modal.classList.toggle("is-wide", wide);
  const foot = $("#adModalFoot");
  foot.innerHTML = actions.map((action, index) => `<button type="button" class="${action.kind === "primary" ? "ad-primary-button" : action.kind === "danger" ? "ad-primary-button is-danger" : "ad-subtle-button"}" data-modal-action="${index}" ${action.primary || (action.kind && index === actions.length - 1) ? "data-modal-primary" : ""}>${action.label}</button>`).join("");
  for (const button of $$("[data-modal-action]", foot)) {
    button.addEventListener("click", async () => {
      const action = actions[Number(button.dataset.modalAction)];
      if (!action?.onClick) return closeModal();
      button.disabled = true;
      const original = button.innerHTML;
      if (action.busy) button.textContent = action.busy;
      try {
        const keepOpen = await action.onClick();
        if (!keepOpen) closeModal();
      } catch (error) {
        toast(errorText(error), true);
      } finally {
        button.disabled = false;
        button.innerHTML = original;
      }
    });
  }
  modal.hidden = false;
  if ($("#adToast")) $("#adToast").hidden = true;
  document.documentElement.classList.add("ac-modal-open");
  modalCleanup = onOpen?.($("#adModalBody")) || null;
  // No celular não abre o teclado sozinho (no iPhone isso também dava zoom
  // na página); o foco vai para a janela, para leitores de tela.
  if (isTouchDevice()) setTimeout(() => $("#adModalTitle")?.focus({ preventScroll: true }), 30);
  else setTimeout(() => $("#adModalBody").querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea")?.focus(), 30);
}

function closeModal() {
  const modal = $("#adModal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.documentElement.classList.remove("ac-modal-open");
  if (typeof modalCleanup === "function") modalCleanup();
  modalCleanup = null;
}

function confirmDialog({ title, message, confirmLabel = "Confirmar", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      kicker: "CONFIRMAÇÃO", title, icon: danger ? "alert" : "check-circle", tone: danger ? "is-red" : "is-accent",
      body: `<p class="ac-confirm-text">${message}</p>`,
      actions: [
        { label: "Cancelar", onClick: () => { answered = true; resolve(false); } },
        { label: confirmLabel, kind: danger ? "danger" : "primary", onClick: () => { answered = true; resolve(true); } },
      ],
      onOpen: () => () => { if (!answered) resolve(false); },
    });
  });
}

// ── Visão geral ──────────────────────────────────────────────────────
function trendHtml(current, previous, suffix = "vs. 30 dias anteriores") {
  const now = Number(current) || 0;
  const before = Number(previous) || 0;
  if (!before) return now ? `<b class="is-up">${icon("arrow-up")}${now.toLocaleString("pt-BR")}</b> novos em 30 dias` : "Sem variação no período";
  const pct = ((now - before) / before) * 100;
  const up = pct >= 0;
  return `<b class="${up ? "is-up" : "is-down"}">${icon(up ? "arrow-up" : "arrow-down")}${up ? "+" : ""}${pct.toFixed(1).replace(".", ",")}%</b> ${suffix}`;
}

function sparkPath(values, width = 120, height = 44) {
  const list = values.length > 1 ? values : [0, ...values, 0];
  const min = Math.min(...list);
  const max = Math.max(...list);
  const span = max - min || 1;
  const points = list.map((value, index) => [index * (width / (list.length - 1)), height - 6 - ((value - min) / span) * (height - 14)]);
  const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return { line, area: `${line} L${width} ${height} L0 ${height} Z` };
}

function renderAdminWelcome(user = state.user) {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(now));
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const firstName = String(user?.displayName || user?.email?.split("@")[0] || "Administrador").trim().split(/\s+/)[0];
  $("#adGreeting").textContent = `${greeting}, ${firstName}.`;
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "numeric", month: "short", year: "numeric" }).formatToParts(now);
  const part = (type) => (parts.find((item) => item.type === type)?.value || "").replace(".", "");
  const weekday = part("weekday");
  $("#adCurrentDate").textContent = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${part("day")} de ${part("month")} de ${part("year")}`;
}

function renderKpis(metrics = {}, segments = {}) {
  const set = (index, value, sub, series) => {
    const valueEl = $(`#adKpi${index}Value`);
    if (!valueEl) return;
    valueEl.textContent = value;
    $(`#adKpi${index}Sub`).innerHTML = sub;
    const spark = $(`#adKpi${index}Spark`);
    if (spark) {
      if (series?.length > 1) {
        const { line, area } = sparkPath(series);
        spark.innerHTML = `<defs><linearGradient id="adSpark${index}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".35"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#adSpark${index})"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
      } else spark.innerHTML = "";
    }
  };
  const users = Number(metrics.users) || 0;
  const active = Number(metrics.activeUsers30d) || 0;
  const withPlan = Number(segments.plan) || 0;
  const trial = Number(segments.trial) || 0;
  const growth = (state.dashboard?.accountsByDay || []).slice(-30).map((entry) => Number(entry.total) || 0);
  set(1, users.toLocaleString("pt-BR"), `${active.toLocaleString("pt-BR")} ativos em 30 dias · ${trendHtml(metrics.newUsers30d, metrics.newUsersPrev30d, "contas novas")}`, growth);
  set(2, withPlan.toLocaleString("pt-BR"), users ? `<b class="is-up">${Math.round((withPlan / users) * 100)}%</b> das contas${segments.expiringSoon ? ` · ${segments.expiringSoon} vencem em 7 dias` : ""}` : "Nenhuma conta ainda", null);
  set(3, trial.toLocaleString("pt-BR"), segments.trialEndingSoon ? `<b class="is-down">${plural(segments.trialEndingSoon, "acaba", "acabam")}</b> em até 3 dias` : trial ? "Nenhum acabando nos próximos dias" : "Ninguém em teste agora", null);
  set(4, money(metrics.mrrCents ?? 0), trendHtml(metrics.revenueCents30d, metrics.revenuePrevCents30d, "recebido vs. 30 dias anteriores"), null);
}

function renderAlerts() {
  const root = $("#adAlerts");
  if (!root) return;
  const segments = state.dashboard?.segments || {};
  const alerts = [];
  if (segments.overdueCharges) alerts.push(["is-danger", "receipt", `${plural(segments.overdueCharges, "cobrança vencida", "cobranças vencidas")} aguardando pagamento.`, "Ver cobranças", "data-go=\"charges\""]);
  if (segments.trialEndingSoon) alerts.push(["is-warn", "gift", `${plural(segments.trialEndingSoon, "teste grátis acaba", "testes grátis acabam")} em até 3 dias.`, "Ver testes", "data-access-tab=\"ending\""]);
  if (segments.expiringSoon) alerts.push(["is-warn", "hourglass", `${plural(segments.expiringSoon, "plano vence", "planos vencem")} nos próximos 7 dias.`, "Ver prazos", "data-access-tab=\"ending\""]);
  const pendingIntegrations = (state.dashboard?.integrations || []).filter((item) => !item.configured).length;
  if (pendingIntegrations) alerts.push(["is-info", "link", `${plural(pendingIntegrations, "integração pendente", "integrações pendentes")} de configuração.`, "Ver integrações", "data-go=\"integrations\""]);
  // "Atenção hoje": um cartão só, com cada pendência e o atalho para resolver
  // (antes eram faixas largas empilhadas que empurravam o painel para baixo).
  root.innerHTML = `<header class="st-attn-head"><h3>Atenção hoje</h3>${alerts.length ? `<span class="st-attn-count">${alerts.length}</span>` : ""}</header>
    ${alerts.length ? `<ul class="st-attn-list">${alerts.map(([tone, iconName, text, label, attr]) => `<li class="st-attn-item ${tone}"><span class="st-attn-ico">${icon(iconName)}</span><span class="st-attn-text">${escapeHtml(text)}</span><button type="button" class="st-attn-btn" aria-label="${escapeHtml(label)}" ${attr}><span>${escapeHtml(label)}</span>${icon("arrow-right")}</button></li>`).join("")}</ul>`
      : `<div class="st-attn-ok">${icon("check-circle")}<span><strong>Tudo em dia</strong><small>Nenhuma cobrança vencida, teste acabando ou integração pendente.</small></span></div>`}`;
  root.hidden = false;
}

function segmentCounts() {
  const segments = state.dashboard?.segments || {};
  return { plan: segments.plan || 0, trial: segments.trial || 0, none: segments.none || 0, attention: (segments.paused || 0) + (segments.expired || 0), disabled: segments.disabled || 0 };
}

function renderSegments() {
  const bar = $("#adSegBar");
  const legend = $("#adSegLegend");
  if (!bar || !legend) return;
  const counts = segmentCounts();
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  bar.innerHTML = total ? SEGMENTS.filter(([key]) => counts[key]).map(([key, label, color]) => `<span style="--w:${((counts[key] / total) * 100).toFixed(2)}%;--c:${color}" title="${escapeHtml(label)}: ${counts[key]}"></span>`).join("") : `<span class="is-empty"></span>`;
  legend.innerHTML = SEGMENTS.map(([key, label, color]) => `<button type="button" class="ac-legend-item" data-user-segment="${key}"><i style="--c:${color}"></i><span>${escapeHtml(label)}</span><strong>${counts[key].toLocaleString("pt-BR")}</strong><small>${total ? Math.round((counts[key] / total) * 100) : 0}%</small></button>`).join("");
}

// Ícones em SVG (traço único, mesmo desenho do app) no lugar dos símbolos
// de texto ◆ ◉ ✦ ✧ ▣ que renderizavam diferente em cada sistema.
const AD_GLYPHS = {
  firebase: '<path d="M6 19.5L8.6 4.2l3.200 6"/><path d="M6 19.5l7.800-13 1.900 3.600"/><path d="M6 19.5l7 3.300 5.800-3.300-2-12.300z"/>',
  whatsapp: '<path d="M4.500 19.500l1.100-3.700A8 8 0 1112 20a8 8 0 01-3.700-.9z"/><path d="M9.200 8.800c.3 2.600 2.300 4.600 4.900 5.200l1.100-1.300-1.700-1-1 .8a4.600 4.600 0 01-2.100-2.100l.8-1-1-1.700z"/>',
  gemini: '<path d="M12 3c.6 4.700 4.300 8.400 9 9-4.700.6-8.400 4.300-9 9-.6-4.700-4.300-8.400-9-9 4.700-.6 8.400-4.300 9-9z"/>',
  qstash: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 10h8M8 14h5"/><circle cx="17" cy="14" r="1"/>',
  stripe: '<rect x="3" y="6" width="18" height="12" rx="2.500"/><path d="M3 10h18M7 15h3"/>',
  "ai-gateway": '<path d="M12 3.500l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><path d="M18.500 15.500l.8 1.900 1.900.8-1.900.8-.8 1.900-.8-1.900-1.900-.8 1.900-.8z"/>',
  activity: '<path d="M3 12h4l2.500-6 4 12 2.500-6H21"/>',
  chat: '<path d="M4.500 19.500l1.100-3.700A8 8 0 1112 20a8 8 0 01-3.700-.9z"/>',
  bell: '<path d="M6 10a6 6 0 0112 0c0 5 2 6.500 2 6.500H4S6 15 6 10"/><path d="M10.300 20a2 2 0 003.400 0"/>',
  generic: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.500 2"/>',
};
function adGlyph(name) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${AD_GLYPHS[name] || AD_GLYPHS.generic}</svg>`;
}

function renderOperations(metrics) {
  $("#adOperationsSummary").innerHTML = [
    ["activity", metrics.usersWithSavedChanges30d ?? 0, "usuários com atividade"],
    ["chat", metrics.whatsappReceived30d ?? 0, "mensagens no WhatsApp"],
    ["bell", metrics.reminderDeliveriesAccepted30d ?? 0, "lembretes aceitos"],
  ].map(([glyph, value, label]) => `<div class="ad-operation"><span aria-hidden="true">${adGlyph(glyph)}</span><div><strong>${Number(value).toLocaleString("pt-BR")}</strong><small>${label} nos últimos 30 dias</small></div></div>`).join("");
  if ($("#adLastRefresh")) $("#adLastRefresh").textContent = `Dados das ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date())}`;
}

function renderGrowth(range = state.growthRange) {
  const root = $("#adGrowthChart");
  if (!root) return;
  const entries = (state.dashboard?.accountsByDay || []).slice(-range);
  if (entries.length < 2) { root.innerHTML = `<div class="ad-empty">Ainda não há histórico suficiente.</div>`; return; }
  const width = Math.max(280, Math.round(root.clientWidth || 640));
  const height = Math.max(180, Math.round(root.clientHeight || 220));
  const pad = { left: 46, right: 14, top: 18, bottom: 28 };
  const values = entries.map((entry) => Number(entry.total) || 0);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const step = Math.max(1, Math.ceil(((maxValue - minValue) || Math.max(1, maxValue)) / 4));
  const low = Math.max(0, Math.floor(minValue / step) * step - (minValue === maxValue ? step : 0));
  const high = low + step * 5;
  const x = (index) => pad.left + (index * (width - pad.left - pad.right)) / (entries.length - 1);
  const y = (value) => pad.top + (1 - (value - low) / (high - low)) * (height - pad.top - pad.bottom);
  const line = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
  const grid = Array.from({ length: 6 }, (_, index) => low + step * index).map((value) => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text x="${pad.left - 8}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end">${value.toLocaleString("pt-BR")}</text>`).join("");
  const ticks = 5;
  const labels = Array.from({ length: ticks }, (_, index) => Math.round((index * (entries.length - 1)) / (ticks - 1))).map((index) => {
    const label = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(new Date(`${entries[index].date}T12:00:00`)).replace(".", "").replace(" de ", " ");
    return `<text x="${x(index).toFixed(1)}" y="${height - 6}" text-anchor="middle">${escapeHtml(label)}</text>`;
  }).join("");
  const last = values[values.length - 1];
  const lx = x(values.length - 1);
  const ly = y(last);
  state.growthGeom = { xs: values.map((_, index) => x(index)), ys: values.map((value) => y(value)), values, dates: entries.map((entry) => entry.date), width, height, top: pad.top, bottom: height - pad.bottom };
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="ad-growth-svg"><defs><linearGradient id="adGrowthFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee" stop-opacity=".32"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></linearGradient><linearGradient id="adGrowthLine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f80ff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><g class="ad-grid">${grid}</g><path d="${line} L${lx.toFixed(1)} ${height - pad.bottom} L${pad.left} ${height - pad.bottom} Z" fill="url(#adGrowthFill)"/><path d="${line}" fill="none" stroke="url(#adGrowthLine)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/><g class="ad-axis">${labels}</g></svg><span class="ad-growth-dot" style="left:${((lx / width) * 100).toFixed(2)}%;top:${((ly / height) * 100).toFixed(2)}%"></span><span class="ad-growth-tip" style="left:${((lx / width) * 100).toFixed(2)}%;top:${((ly / height) * 100).toFixed(2)}%">${last.toLocaleString("pt-BR")}</span>`;
}

// Leitura do gráfico: linha vertical que acompanha o ponteiro, ponto e caixa
// com data e total do dia mais próximo (mouse, toque e teclado ←/→).
function bindGrowthCrosshair() {
  const root = $("#adGrowthChart");
  if (!root?.dataset || typeof root.addEventListener !== "function" || root.dataset.crosshair) return;
  root.dataset.crosshair = "1";
  root.tabIndex = 0;
  let focusIndex = -1;
  const show = (index) => {
    const geom = state.growthGeom;
    if (!geom || index < 0 || index >= geom.values.length) return;
    focusIndex = index;
    let layer = root.querySelector(".st-cross");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "st-cross";
      layer.innerHTML = `<i class="st-cross-line"></i><b class="st-cross-dot"></b><span class="st-cross-tip"><strong></strong><small></small></span>`;
      root.appendChild(layer);
    }
    const left = (geom.xs[index] / geom.width) * 100;
    const top = (geom.ys[index] / geom.height) * 100;
    layer.style.setProperty("--x", `${left}%`);
    layer.style.setProperty("--y", `${top}%`);
    layer.style.setProperty("--t", `${(geom.top / geom.height) * 100}%`);
    layer.style.setProperty("--b", `${100 - (geom.bottom / geom.height) * 100}%`);
    layer.classList.toggle("is-right", left > 62);
    const date = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${geom.dates[index]}T12:00:00`));
    layer.querySelector("strong").textContent = `${geom.values[index].toLocaleString("pt-BR")} contas`;
    const clean = date.replace(/\./g, "");
    layer.querySelector("small").textContent = clean.charAt(0).toUpperCase() + clean.slice(1);
    layer.hidden = false;
    root.classList.add("is-reading");
  };
  const hide = () => { const layer = root.querySelector(".st-cross"); if (layer) layer.hidden = true; root.classList.remove("is-reading"); };
  const nearest = (clientX) => {
    const geom = state.growthGeom;
    const rect = root.querySelector("svg")?.getBoundingClientRect();
    if (!geom || !rect) return -1;
    const px = ((clientX - rect.left) / rect.width) * geom.width;
    let best = 0;
    geom.xs.forEach((value, index) => { if (Math.abs(value - px) < Math.abs(geom.xs[best] - px)) best = index; });
    return best;
  };
  root.addEventListener("pointermove", (event) => show(nearest(event.clientX)));
  root.addEventListener("pointerdown", (event) => show(nearest(event.clientX)));
  root.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") hide(); });
  root.addEventListener("keydown", (event) => {
    const geom = state.growthGeom;
    if (!geom || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const last = geom.values.length - 1;
    const start = focusIndex < 0 ? last : focusIndex;
    show(event.key === "Home" ? 0 : event.key === "End" ? last : Math.max(0, Math.min(last, start + (event.key === "ArrowRight" ? 1 : -1))));
  });
  root.addEventListener("blur", hide);
}

function renderPlanBreakdown(data = state.dashboard) {
  const root = $("#adPlanBreakdown");
  if (!root || !data) return;
  const metrics = data.metrics || {};
  const plans = Array.isArray(data.planBreakdown) ? data.planBreakdown : [];
  const total = plans.reduce((sum, item) => sum + item.count, 0);
  root.innerHTML = plans.length ? plans.slice(0, 5).map((item) => {
    const pct = total ? (item.count / total) * 100 : 0;
    return `<div class="ad-plan-bar"><span>${escapeHtml(item.name)}</span><b>${item.count.toLocaleString("pt-BR")}</b><i><em style="width:${pct.toFixed(1)}%"></em></i><small>${pct.toFixed(1).replace(".", ",")}%</small></div>`;
  }).join("") : `<div class="ad-empty">Nenhum plano ativo ainda.</div>`;
  const pending = data.segments?.pendingCents || 0;
  $("#adSubsTotals").innerHTML = `<div><dt>Receita mensal (MRR)</dt><dd>${money(metrics.mrrCents ?? 0)}</dd></div><div><dt>Recebido (30 dias)</dt><dd>${money(metrics.revenueCents30d ?? 0)}</dd></div><div><dt>A receber</dt><dd>${money(pending)}</dd></div>`;
}

function auditWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(date);
  const dayKey = (item) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(item);
  if (dayKey(date) === dayKey(new Date())) return `Hoje, ${time}`;
  if (dayKey(date) === dayKey(new Date(Date.now() - 86400000))) return `Ontem, ${time}`;
  return `${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "America/Sao_Paulo" }).format(date).replace(".", "")}, ${time}`;
}

function auditRow(event) {
  const [label, iconName] = AUDIT_LABELS[event.action] || [String(event.action || "Ação administrativa").replace(/_/g, " "), "list"];
  const target = event.details?.email || (event.target && event.target !== "global" && event.target.length < 40 ? event.target : "");
  const extra = event.details?.planId ? ` · ${event.details.planId}` : event.details?.validUntil ? ` · até ${shortDate(event.details.validUntil)}` : "";
  return `<div class="ad-audit-row"><span class="ad-audit-ico">${icon(iconName)}</span><span class="ad-audit-copy"><strong>${escapeHtml(label)}${target ? `: <em>${escapeHtml(target)}</em>` : ""}</strong><small>${escapeHtml(event.actorEmail || "Administrador")}${escapeHtml(extra)}</small></span><time datetime="${escapeHtml(event.at || "")}">${escapeHtml(auditWhen(event.at))}</time></div>`;
}

function renderAccessChart(entries = []) {
  const root = $("#adAccessChart");
  if (!root) return;
  const visible = entries.slice(-14);
  const max = Math.max(1, ...visible.map((entry) => Number(entry.users) || 0));
  const total = visible.reduce((sum, entry) => sum + (Number(entry.users) || 0), 0);
  root.innerHTML = `<div class="ad-chart-summary"><strong>${total.toLocaleString("pt-BR")}</strong><span>contas pelo último acesso nos últimos 14 dias</span></div><div class="ad-bars">${visible.map((entry, index) => {
    const value = Number(entry.users) || 0;
    // No celular a data vai curta (11/11) para caber embaixo da barra.
    const label = new Intl.DateTimeFormat("pt-BR", isCompact() ? { day: "2-digit", month: "2-digit" } : { day: "2-digit", month: "short" }).format(new Date(`${entry.date}T12:00:00`));
    return `<div class="ad-bar-column" title="${escapeHtml(label)}: ${value}"><span class="ad-bar-value">${value || ""}</span><i style="--bar:${Math.max(value ? 10 : 2, Math.round((value / max) * 100))}%"></i>${index % 2 === 0 ? `<small>${escapeHtml(label)}</small>` : "<small aria-hidden=\"true\">&nbsp;</small>"}</div>`;
  }).join("")}</div><p class="ad-data-note">Cada conta aparece só no dia do acesso mais recente.</p>`;
}

function renderJourney(journey = {}) {
  const root = $("#adJourney");
  if (!root) return;
  const steps = [["accounts", "Conta criada"], ["savedData", "Usou o produto"], ["whatsappLinked", "Vinculou WhatsApp"], ["remindersConfigured", "Configurou lembretes"], ["planAssigned", "Possui plano ativo"]];
  const maximum = Math.max(1, Number(journey.accounts) || 0);
  root.innerHTML = steps.map(([key, label], index) => {
    const value = Number(journey[key]) || 0;
    const percent = Math.min(100, Math.round((value / maximum) * 100));
    return `<div class="ad-journey-step"><span class="ad-step-index">0${index + 1}</span><div><span><strong>${escapeHtml(label)}</strong><b>${value.toLocaleString("pt-BR")}</b></span><i><em style="width:${percent}%"></em></i><small>${percent}% das contas</small></div></div>`;
  }).join("");
}

function renderUsageFlow(flow = {}) {
  const root = $("#adUsageFlow");
  if (!root) return;
  const topAreas = Array.isArray(flow.topAreas) ? flow.topAreas : [];
  const topTransitions = Array.isArray(flow.topTransitions) ? flow.topTransitions : [];
  if (!flow.trackedUsers || !topAreas.length) {
    root.innerHTML = `<div class="ad-empty">Os primeiros acessos aparecerão aqui, sem expor conteúdo pessoal.</div>`;
    return;
  }
  const max = Math.max(1, ...topAreas.map((item) => Number(item.count) || 0));
  root.innerHTML = `<div class="ad-flow-summary"><strong>${Number(flow.trackedUsers || 0).toLocaleString("pt-BR")}</strong><span>usuários observados</span></div><div class="ad-flow-areas">${topAreas.map((item) => `<div><span>${escapeHtml(AREA_LABELS[item.key] || item.key)}</span><i><em style="width:${Math.round(((Number(item.count) || 0) / max) * 100)}%"></em></i><b>${Number(item.count || 0).toLocaleString("pt-BR")}</b></div>`).join("")}</div>${topTransitions.length ? `<div class="ad-flow-transitions"><small>Caminhos mais usados</small>${topTransitions.slice(0, 3).map((item) => { const [from, to] = String(item.key || "").split(">"); return `<span>${escapeHtml(AREA_LABELS[from] || from || "Origem")} → ${escapeHtml(AREA_LABELS[to] || to || "Destino")} <b>${Number(item.count || 0).toLocaleString("pt-BR")}</b></span>`; }).join("")}</div>` : ""}`;
}

function renderAudit(events) {
  const root = $("#adAuditPreview");
  if (!events?.length) { root.className = "ad-empty"; root.textContent = "Nenhuma ação registrada ainda."; return; }
  root.className = "ad-audit-list";
  root.innerHTML = events.slice(0, 6).map(auditRow).join("");
}

const AUDIT_GROUPS = [
  ["all", "Tudo", () => true],
  ["access", "Acessos", (action) => /^access_|^entitlement_|^user_/.test(action)],
  ["charges", "Cobranças", (action) => /charge/.test(action)],
  ["plans", "Planos", (action) => /^plan/.test(action)],
  ["team", "Equipe", (action) => /^admin_access/.test(action)],
  ["system", "Sistema", (action) => /^config_|^maintenance_/.test(action)],
];
state.auditFilter = "all";

function auditTone(action = "") {
  if (/remove|pause|disabled|revoked|maintenance_enabled/.test(action)) return "is-danger";
  if (/trial/.test(action)) return "is-trial";
  if (/charge/.test(action)) return "is-money";
  if (/granted|enabled|resume|maintenance_disabled/.test(action)) return "is-good";
  return "is-plan";
}

function auditEventHtml(event, order) {
  const [label, iconName] = AUDIT_LABELS[event.action] || [String(event.action || "Ação administrativa").replace(/_/g, " "), "list"];
  const person = state.directory.find((user) => (event.target && user.uid === event.target) || (event.details?.email && user.email === event.details.email));
  const who = event.details?.email || person?.email || (event.target && !["global", "plans"].includes(event.target) && event.target.length < 40 ? (state.plans.find((plan) => plan.id === event.target)?.name || event.target) : "");
  const planName = event.details?.planId ? (state.plans.find((plan) => plan.id === event.details.planId)?.name || event.details.planId) : "";
  const bits = [planName && planName !== who ? planName : "", event.details?.days ? `${event.details.days} dias` : "", event.details?.validUntil ? `até ${shortDate(event.details.validUntil)}` : "", event.details?.amountCents ? money(event.details.amountCents) : ""].filter(Boolean).join(" · ");
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date(event.at));
  const tag = person ? "button" : "div";
  return `<li style="--i:${order}"><${tag} ${person ? `type="button" data-audit-user="${escapeHtml(person.uid)}" title="Abrir a ficha"` : ""} class="pf-event au-event ${auditTone(event.action)}"><span class="pf-event-dot">${icon(iconName)}</span><div><strong>${escapeHtml(label)}${who ? ` <em>${escapeHtml(who)}</em>` : ""}</strong><small>${escapeHtml([bits, `por ${event.actorEmail || "Administrador"}`].filter(Boolean).join(" — "))}</small></div><time datetime="${escapeHtml(event.at || "")}">${escapeHtml(time)}</time></${tag}></li>`;
}

function renderAuditFull() {
  const list = $("#adAuditFull");
  if (!list) return;
  const query = String($("#adAuditSearch")?.value || "").trim().toLowerCase();
  const matchesQuery = (event) => !query || [AUDIT_LABELS[event.action]?.[0], event.action, event.actorEmail, event.details?.email, event.target].some((value) => String(value || "").toLowerCase().includes(query));
  const filters = $("#adAuditFilters");
  if (filters) filters.innerHTML = AUDIT_GROUPS.map(([key, text, test]) => {
    const count = state.audit.filter((event) => matchesQuery(event) && test(event.action || "")).length;
    return `<button type="button" class="${state.auditFilter === key ? "is-on" : ""}" aria-pressed="${state.auditFilter === key}" data-audit-filter="${key}">${text}<em>${count}</em></button>`;
  }).join("");
  const test = AUDIT_GROUPS.find(([key]) => key === state.auditFilter)?.[2] || (() => true);
  const events = state.audit.filter((event) => matchesQuery(event) && test(event.action || ""));
  if (!events.length) { list.innerHTML = `<div class="pf-empty">${icon("search")}<strong>Nada encontrado</strong><span>Tente outro filtro ou outra busca.</span></div>`; return; }
  let current = "";
  let order = 0;
  list.innerHTML = `<ol class="pf-timeline au-timeline">${events.map((event) => {
    const dayLabel = historyDayLabel(event.at);
    const header = dayLabel !== current ? `<li class="pf-day" style="--i:${Math.min(order++, 12)}">${escapeHtml((current = dayLabel))}</li>` : "";
    return header + auditEventHtml(event, Math.min(order++, 12));
  }).join("")}</ol>`;
}

async function openAuditDrawer() {
  const drawer = $("#adAuditDrawer");
  const list = $("#adAuditFull");
  if (!drawer || !list) return;
  list.innerHTML = `<div class="pf-skel"><i></i><i></i><i></i><i></i></div>`;
  if (drawer.parentElement !== document.body && document.body) document.body.appendChild(drawer);
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  drawer.inert = false;
  const scrim = $("#adDrawerScrim");
  if (scrim) scrim.hidden = false;
  drawerFocusIn(drawer, "#adAuditDrawerClose");
  try {
    const [data] = await Promise.all([request("audit"), state.directory.length ? null : loadDirectory().catch(() => {})]);
    state.audit = data.events || [];
    drawer.querySelector(".pf")?.classList.add("is-entering");
    renderAuditFull();
    setTimeout(() => drawer.querySelector(".pf")?.classList.remove("is-entering"), 1200);
  } catch (error) {
    list.innerHTML = `<div class="pf-error">${icon("alert")}<strong>Não foi possível carregar a auditoria</strong><span>${escapeHtml(errorText(error))}</span></div>`;
  }
}

function closeAuditDrawer() {
  const drawer = $("#adAuditDrawer");
  drawer?.classList.remove("is-open");
  drawer?.setAttribute("aria-hidden", "true");
  if (drawer) drawer.inert = true;
  if (!$("#adUserDrawer")?.classList.contains("is-open") && $("#adDrawerScrim")) $("#adDrawerScrim").hidden = true;
  drawerFocusBack();
}

function bindAuditDrawer() {
  const drawer = $("#adAuditDrawer");
  if (!drawer || typeof drawer.addEventListener !== "function") return;
  drawer.addEventListener("click", (event) => {
    const target = event.target;
    if (typeof target?.closest !== "function") return;
    const filter = target.closest("[data-audit-filter]");
    if (filter) { state.auditFilter = filter.dataset.auditFilter; renderAuditFull(); return; }
    const person = target.closest("[data-audit-user]");
    if (person) { closeAuditDrawer(); openUserDrawer(person.dataset.auditUser); }
  });
  drawer.addEventListener("scroll", (event) => {
    if (!event.target.classList?.contains("pf-body")) return;
    drawer.querySelector(".pf")?.classList.toggle("is-scrolled", event.target.scrollTop > 24);
  }, { capture: true, passive: true });
}

function renderIntegrationRows(data, selector, compact = false) {
  if (compact) {
    const pending = data.integrations.filter((item) => !item.configured).length;
    const summary = $("#adHealthSummary");
    if (summary) {
      summary.className = `ad-health-summary ${pending ? "is-warn" : ""}`;
      summary.innerHTML = `${icon(pending ? "alert" : "check-circle")}${pending ? `${pending} ${pending === 1 ? "integração pendente" : "integrações pendentes"}` : "Tudo operacional"}`;
    }
    $(selector).innerHTML = data.integrations.map((item) => {
      const [letter, color] = INTEGRATION_BADGES[item.id] || [String(item.label || "?")[0], "#7d88a8"];
      return `<button type="button" class="ad-health-row" data-go="integrations" title="${escapeHtml(item.detail || "")}"><span class="ad-health-badge" style="--c:${color}">${escapeHtml(letter)}</span><span class="ad-health-name">${escapeHtml(item.label)}</span><span class="ad-health-status ${item.configured ? "" : "is-warn"}"><i></i>${item.configured ? "Operacional" : "Pendente"}</span>${icon("chev-right")}</button>`;
    }).join("");
    return;
  }
  $(selector).innerHTML = data.integrations.map((item) => {
    const detail = item.id === "qstash"
      ? `Última execução: ${readableTimestamp(item.lastRunAt)} · ${item.runStatus === "ok" ? "sem falhas" : item.runStatus === "unknown" ? "sem histórico" : item.runStatus}`
      : item.id === "whatsapp" ? `Último evento: ${readableTimestamp(item.lastEventAt)} · ${Number(item.recentFailures || 0)} falha(s) na amostra recente` : item.detail;
    return `<div class="ad-integration"><span class="ad-integration-icon" aria-hidden="true">${adGlyph(item.id)}</span><span class="ad-integration-content"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(detail)}</small></span><span class="ad-pill ${item.configured ? "" : "is-warn"}">${item.configured ? "Configurado" : "Pendente"}</span></div>`;
  }).join("");
  $("#adIntegrationNote").textContent = data.note || "";
  const deliveries = Array.isArray(data.reminderDeliveries) ? data.reminderDeliveries : [];
  const channelLabel = { whatsapp: "WhatsApp", push: "Push", unknown: "Canal antigo" };
  const statusLabel = { accepted: "Aceito pela API", failed: "Falhou", processing: "Processando", unknown: "Sem estado" };
  const providerLabel = { sent: "Enviado pela Meta", delivered: "Entregue no aparelho", read: "Lido", failed: "Recusado pela Meta" };
  $("#adReminderDeliveries").innerHTML = deliveries.length ? deliveries.map((delivery) => {
    const visibleStatus = delivery.providerStatus || delivery.status;
    const label = providerLabel[delivery.providerStatus] || statusLabel[delivery.status] || visibleStatus;
    return `<div class="ad-delivery"><span class="ad-delivery-channel">${escapeHtml(channelLabel[delivery.channel] || delivery.channel)}</span><span class="ad-delivery-copy"><strong>${escapeHtml(delivery.notificationKey || "Lembrete")}</strong><small>${escapeHtml(userLabelByUid(delivery.uid))} · ${escapeHtml(readableTimestamp(delivery.providerUpdatedAt || delivery.attemptedAt))}${delivery.error ? ` · ${escapeHtml(delivery.error)}` : ""}</small></span><span class="ad-pill ${visibleStatus === "failed" ? "is-danger" : ["accepted", "sent"].includes(visibleStatus) ? "is-warn" : ""}">${escapeHtml(label)}</span></div>`;
  }).join("") : `<div class="ad-empty">Nenhuma tentativa de lembrete registrada ainda.</div>`;
}

function renderStripeStatus() {
  const stripe = state.integrations?.integrations?.find((item) => item.id === "stripe");
  const box = $("#adBillingStatus");
  if (!stripe || !box) return;
  box.innerHTML = `<span class="ad-provider-logo">S</span><div><strong>Stripe</strong><small>${stripe.configured ? "Conectado: cartão e Pix pelo checkout, com confirmação automática." : "Não conectado: cadastre STRIPE_SECRET_KEY e STRIPE_WEBHOOK_SECRET na Vercel. Enquanto isso, use o Pix direto."}</small></div><span class="ad-pill ${stripe.configured ? "" : "is-warn"}">${stripe.configured ? "Conectado" : "Pendente"}</span>`;
}

function userLabelByUid(uid) {
  if (!uid) return "Registro antigo";
  const user = state.directory.find((item) => item.uid === uid);
  return user ? (user.email || user.displayName || uid) : `Usuário ${uid.slice(0, 8)}…`;
}

// ── Usuários ─────────────────────────────────────────────────────────
function statusInfo(user) {
  const left = Number.isInteger(user.daysLeft) ? user.daysLeft : null;
  switch (user.segment) {
    case "disabled": return ["is-off", "Desativado"];
    case "trial": return [left !== null && left <= 3 ? "is-warn" : "is-trial", left === null ? "Em teste" : left <= 0 ? "Teste acaba hoje" : `Teste · ${plural(left, "dia", "dias")}`];
    case "trial_ended": return ["is-danger", "Teste encerrado"];
    case "plan": return [left !== null && left <= 7 ? "is-warn" : "is-on", user.validUntil ? `Ativo até ${shortDate(user.validUntil)}` : "Ativo"];
    case "expired": return ["is-danger", "Vencido"];
    case "paused": return ["is-warn", "Pausado"];
    case "cancelled": return ["is-off", "Cancelado"];
    default: return ["is-muted", "Plano gratuito"];
  }
}

function avatarHtml(user, size = "") {
  const label = user.displayName || user.email || "?";
  return user.photoURL
    ? `<span class="ac-avatar ${size}"><img src="${escapeHtml(user.photoURL)}" alt="" referrerpolicy="no-referrer" loading="lazy" /></span>`
    : `<span class="ac-avatar ${size}">${escapeHtml(initials(label))}</span>`;
}

function matchesFilter(user, filter) {
  if (filter === "all") return true;
  if (filter === "attention") return ["expired", "paused", "cancelled", "trial_ended"].includes(user.segment);
  if (filter === "pending") return user.pending?.count > 0;
  return user.segment === filter;
}

function filteredUsers() {
  const query = state.userSearch.trim().toLowerCase();
  const list = state.directory.filter((user) => matchesFilter(user, state.userFilter)
    && (!state.userPlanFilter || user.planId === state.userPlanFilter)
    && (!query || `${user.displayName} ${user.email}`.toLowerCase().includes(query)));
  const by = {
    recent: (a, b) => String(b.lastActiveAt || b.lastSignInAt || "").localeCompare(String(a.lastActiveAt || a.lastSignInAt || "")),
    new: (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    name: (a, b) => String(a.displayName || a.email).localeCompare(String(b.displayName || b.email), "pt-BR"),
    expiry: (a, b) => String(a.validUntil || "9999").localeCompare(String(b.validUntil || "9999")),
  };
  return list.sort(by[state.userSort] || by.recent);
}

function renderUserFilters() {
  const root = $("#adUserFilters");
  if (!root) return;
  root.innerHTML = USER_FILTERS.map(([key, label]) => {
    const count = state.directory.filter((user) => matchesFilter(user, key)).length;
    return `<button type="button" role="tab" class="${state.userFilter === key ? "is-active" : ""}" aria-selected="${state.userFilter === key}" data-user-filter="${key}">${escapeHtml(label)}<span>${count.toLocaleString("pt-BR")}</span></button>`;
  }).join("");
}

function seenCell(user) {
  const access = user.lastActiveAt || user.lastSignInAt;
  const fresh = freshness(access);
  return `<span class="ux-seen ${fresh.tone}" title="${escapeHtml(`${fresh.label}${access ? ` · ${readableTimestamp(access)}` : ""}`)}"><i aria-hidden="true"></i><span><b>${escapeHtml(access ? relativeTime(access) : "nunca")}</b><small>${escapeHtml(access ? dateTimeShort(access) : "sem acesso registrado")}</small></span></span>`;
}

function userRowHtml(user, { selectable = true, compact = false } = {}) {
  const [tone, label] = statusInfo(user);
  const checked = state.selection.has(user.uid);
  const access = user.lastActiveAt || user.lastSignInAt;
  return `<div class="ac-row ${checked ? "is-selected" : ""}" role="row" data-uid="${escapeHtml(user.uid)}">
    ${selectable ? `<label class="ac-cell ac-check" role="cell"><input type="checkbox" data-select-user="${escapeHtml(user.uid)}" ${checked ? "checked" : ""} aria-label="Selecionar ${escapeHtml(user.email || user.uid)}" /></label>` : ""}
    <button type="button" class="ac-cell ac-usercell" role="cell" data-user-detail="${escapeHtml(user.uid)}">${avatarHtml(user)}<span><strong>${escapeHtml(user.displayName || user.email || "Sem nome")}${user.admin ? ` <em class="ac-tag">Equipe</em>` : ""}</strong><small>${escapeHtml(user.email || user.uid)}</small></span></button>
    <span class="ac-cell" role="cell" data-label="Plano">${user.planName ? `<span class="ac-chip">${escapeHtml(user.planName)}</span>` : `<span class="ac-chip is-muted">—</span>`}</span>
    <span class="ac-cell" role="cell" data-label="Situação"><span class="ac-status ${tone}"><i></i>${escapeHtml(label)}</span></span>
    <span class="ac-cell" role="cell" data-label="Último acesso">${seenCell(user)}</span>
    ${compact ? "" : `<span class="ac-cell ux-born" role="cell" data-label="Conta criada"><b>${escapeHtml(user.createdAt ? relativeTime(user.createdAt) : "—")}</b><small>${escapeHtml(dateTimeShort(user.createdAt, { time: false }))}</small></span>`}
    ${compact ? "" : `<span class="ac-cell" role="cell" data-label="Cobrança">${user.pending?.count ? `<span class="ac-chip is-warn">${money(user.pending.cents)}</span>` : `<span class="ac-muted">—</span>`}</span>`}
    <span class="ac-cell ac-actions" role="cell"><button type="button" class="ac-icon-btn" data-user-detail="${escapeHtml(user.uid)}" aria-label="Gerenciar ${escapeHtml(user.email || "usuário")}">${icon("dots-h")}</button></span>
  </div>`;
}

function renderUsers() {
  renderUserFilters();
  const list = $("#adUsersList");
  if (!list) return;
  const users = filteredUsers();
  const visible = users.slice(0, state.userLimit);
  const allVisibleSelected = visible.length > 0 && visible.every((user) => state.selection.has(user.uid));
  list.innerHTML = visible.length
    ? `<div class="ac-row ac-head" role="row"><label class="ac-cell ac-check" role="columnheader"><input type="checkbox" id="adSelectAll" ${allVisibleSelected ? "checked" : ""} aria-label="Selecionar todos os exibidos" /></label><span class="ac-cell" role="columnheader">Usuário</span><span class="ac-cell" role="columnheader">Plano</span><span class="ac-cell" role="columnheader">Situação</span><span class="ac-cell" role="columnheader">Último acesso</span><span class="ac-cell" role="columnheader">Conta criada</span><span class="ac-cell" role="columnheader">Cobrança</span><span class="ac-cell" role="columnheader"></span></div>${visible.map((user) => userRowHtml(user)).join("")}`
    : `<div class="ad-empty">${state.directory.length ? "Nenhum usuário encontrado com esses filtros." : "Carregando usuários…"}</div>`;
  $("#adUsersPageLabel").textContent = users.length ? `Mostrando ${visible.length.toLocaleString("pt-BR")} de ${users.length.toLocaleString("pt-BR")}` : "";
  $("#adUsersNext").hidden = visible.length >= users.length;
  renderBulkBar();
  renderUsersPreview();
}

function renderUsersPreview() {
  const root = $("#adUsersPreview");
  if (!root) return;
  const recent = [...state.directory].sort((a, b) => String(b.lastActiveAt || b.lastSignInAt || "").localeCompare(String(a.lastActiveAt || a.lastSignInAt || ""))).slice(0, 6);
  root.innerHTML = recent.length
    ? `<div class="ac-table ac-table--compact" role="table">${recent.map((user) => userRowHtml(user, { selectable: false, compact: true })).join("")}</div>`
    : `<div class="ad-empty">Nenhuma conta ainda.</div>`;
  const title = $("#adUsersCardTitle");
  if (title) title.textContent = "Atividade recente";
}

function renderBulkBar() {
  const bar = $("#adBulkBar");
  if (!bar) return;
  const count = state.selection.size;
  bar.hidden = !count || state.currentSection !== "users";
  $("#adBulkCount").textContent = count.toLocaleString("pt-BR");
}

function exportUsersCsv() {
  const users = filteredUsers();
  const header = ["Nome", "E-mail", "Plano", "Situação", "Válido até", "Criado em", "Último acesso", "Cobrança pendente (R$)"];
  const rows = users.map((user) => [user.displayName, user.email, user.planName || "", statusInfo(user)[1], user.validUntil || "", (user.createdAt || "").slice(0, 10), (user.lastActiveAt || user.lastSignInAt || "").slice(0, 10), ((user.pending?.cents || 0) / 100).toFixed(2).replace(".", ",")]);
  const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
  link.download = `pulsenote-usuarios-${todayIso()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

// Foco do teclado: entra na gaveta ao abrir e volta para quem abriu ao fechar.
let drawerOpener = null;
function drawerFocusIn(drawer, closeSelector) {
  const active = globalThis.document?.activeElement;
  if (active && drawer.contains?.(active)) return; // já aberta (recarga): não rouba o foco
  if (active) drawerOpener = active;
  $(closeSelector)?.focus?.({ preventScroll: true });
}
function drawerFocusBack() {
  const opener = drawerOpener;
  drawerOpener = null;
  if (opener?.isConnected) opener.focus?.({ preventScroll: true });
}

// ── Ficha da pessoa (gaveta) ─────────────────────────────────────────
// Cabeçalho fixo que encolhe ao rolar, cartão do plano, ações com motivo
// quando indisponíveis, abas (Resumo, Cobranças, Histórico, Conta) e
// navegação para a pessoa anterior/próxima sem fechar.
const DRAWER_TABS = [["summary", "Resumo"], ["charges", "Cobranças"], ["history", "Histórico"], ["account", "Conta"]];
const SOURCE_LABELS = { manual: "Atribuído pela equipe", trial: "Teste grátis", stripe: "Assinatura Stripe", charge: "Cobrança paga" };
state.drawer = { uid: null, tab: "summary", detail: null, fresh: false, lastSig: "" };

function drawerList() {
  const list = state.currentSection === "users" ? filteredUsers() : state.directory;
  return list.length ? list : state.directory;
}

async function openUserDrawer(uid, { keepTab = false } = {}) {
  const user = state.directory.find((item) => item.uid === uid);
  if (!user) return;
  if ($("#adAuditDrawer")?.classList.contains("is-open")) closeAuditDrawer();
  const drawer = $("#adUserDrawer");
  const switching = state.drawer.uid !== uid;
  if (switching) { state.drawer.detail = null; state.drawer.fresh = true; if (!keepTab) state.drawer.tab = "summary"; }
  state.drawer.uid = uid;
  drawer.dataset.uid = uid;
  renderUserDrawer(user, state.drawer.detail);
  if (!drawer.classList.contains("is-open")) {
    drawer.classList.add("is-open");
    drawer.setAttribute("aria-hidden", "false");
    drawer.inert = false;
    const scrim = $("#adDrawerScrim");
    if (scrim) scrim.hidden = false;
    drawerFocusIn(drawer, "#adUserDrawerClose");
  }
  if (!state.plans.length) loadPlans().then(() => { if (state.drawer.uid === uid) renderUserDrawer(user, state.drawer.detail); }).catch(() => {});
  try {
    const detail = await request("user-detail", undefined, { uid });
    if (state.drawer.uid !== uid) return;
    state.drawer.detail = detail;
    renderUserDrawer(state.directory.find((item) => item.uid === uid) || user, detail);
  } catch (error) {
    if (state.drawer.uid === uid) $("#adDrawerDetail").innerHTML = `<div class="pf-error">${icon("alert")}<strong>Não foi possível carregar a ficha</strong><span>${escapeHtml(errorText(error))}</span><button type="button" class="ad-subtle-button" data-drawer-retry>Tentar de novo</button></div>`;
  }
}

function stepUserDrawer(delta) {
  const list = drawerList();
  const index = list.findIndex((item) => item.uid === state.drawer.uid);
  const next = list[index + delta];
  if (!next) return;
  const body = $("#adDrawerDetail");
  body?.classList.remove("pf-slide-up", "pf-slide-down");
  openUserDrawer(next.uid, { keepTab: true });
  const fresh = $("#adDrawerDetail");
  if (fresh) { void fresh.offsetWidth; fresh.classList.add(delta > 0 ? "pf-slide-up" : "pf-slide-down"); }
}

function userPlanInfo(user, detail) {
  const plan = state.plans.find((item) => item.id === user.planId) || null;
  const entitlement = detail?.entitlement || null;
  const left = Number.isInteger(user.daysLeft) ? user.daysLeft : null;
  let progress = null;
  const start = entitlement?.trialStartedAt && user.source === "trial" ? new Date(entitlement.trialStartedAt) : null;
  if (start && user.validUntil) {
    const end = new Date(`${user.validUntil}T23:59:59`);
    const total = Math.max(1, Math.round((end - start) / 86400000));
    const used = Math.min(total, Math.max(0, total - Math.max(0, left ?? 0)));
    progress = { pct: Math.round((used / total) * 100), label: `Dia ${Math.min(total, used + 1)} de ${total}` };
  }
  return { plan, entitlement, left, progress };
}

function planPriceText(plan) {
  if (!plan) return "";
  if (!plan.priceCents) return "Grátis";
  return `${money(plan.priceCents)}${plan.billingInterval === "year" ? "/ano" : "/mês"}`;
}

function drawerPlanCard(user, detail) {
  const { plan, left, progress } = userPlanInfo(user, detail);
  const accent = plan?.accent || "slate";
  if (!user.planId) {
    const rule = state.config?.access?.noPlan === "plan" ? state.plans.find((item) => item.id === state.config.access.noPlanPlanId) : null;
    return `<div class="pf-plan is-free pc-accent-slate" style="--i:0"><div class="pf-plan-top"><span class="pf-kicker">Plano atual</span>${rule ? `<span class="pf-plan-price">${escapeHtml(planPriceText(rule))}</span>` : ""}</div>
      <strong class="pf-plan-name">${rule ? escapeHtml(rule.name) : "Acesso completo"}</strong>
      <p class="pf-plan-line">${icon("info")}${rule ? "Sem plano próprio: segue a regra padrão de quem está sem plano." : "Sem plano próprio: a regra padrão libera tudo para quem está sem plano."}</p></div>`;
  }
  const when = user.validUntil
    ? left === null ? `Vale até ${readableDate(user.validUntil)}`
      : left >= 0 ? `${left === 0 ? "Vence hoje" : `Faltam ${plural(left, "dia", "dias")}`} · até ${shortDate(user.validUntil)}`
        : `Venceu há ${plural(-left, "dia", "dias")} · em ${shortDate(user.validUntil)}`
    : "Sem data de fim";
  return `<div class="pf-plan pc-accent-${escapeHtml(accent)} ${user.status === "paused" ? "is-paused" : ""}" style="--i:0">
    <div class="pf-plan-top"><span class="pf-kicker">${user.source === "trial" ? "Em teste grátis" : "Plano atual"}</span>${plan ? `<span class="pf-plan-price">${escapeHtml(planPriceText(plan))}</span>` : ""}</div>
    <strong class="pf-plan-name">${escapeHtml(user.planName || plan?.name || user.planId)}</strong>
    <p class="pf-plan-line">${icon("clock")}${escapeHtml(when)}</p>
    ${progress ? `<div class="pf-meter" role="img" aria-label="${escapeHtml(progress.label)}"><i style="--to:${progress.pct}%"></i></div><small class="pf-meter-label">${escapeHtml(progress.label)} do teste</small>` : ""}
    <div class="pf-plan-foot"><span>${icon(user.source === "stripe" ? "card" : user.source === "trial" ? "gift" : user.source === "charge" ? "receipt" : "user")}${escapeHtml(SOURCE_LABELS[detail?.entitlement?.source || user.source] || "Origem não registrada")}</span>${plan ? `<span>${icon("sparkle")}${escapeHtml(aiLimitLabel(plan))}</span>` : ""}</div>
    ${user.source === "stripe" ? `<p class="pf-note">${icon("info")}Cobrado pelo Stripe: mudar o plano aqui não cancela a assinatura lá.</p>` : ""}
  </div>`;
}

function drawerActions(user) {
  const paused = user.status === "paused";
  const items = [
    ["assign", "layers", user.planId ? "Trocar plano" : "Atribuir plano", "Plano e prazo", "users.access"],
    ["trial", "gift", "Dar teste", "7, 14 ou 30 dias", "users.access"],
    user.planId && ["extend", "hourglass", "Estender prazo", user.validUntil ? `Vence em ${shortDate(user.validUntil)}` : "Definir um vencimento", "users.access"],
    user.planId && [paused ? "resume" : "pause", paused ? "play" : "pause", paused ? "Retomar" : "Pausar", paused ? "Volta a valer na hora" : "Bloqueia sem apagar", "users.access"],
    ["charge", "receipt", "Cobrar", user.pending?.count ? `${money(user.pending.cents)} já a receber` : "Pix ou cartão no app", "charges.manage"],
  ].filter((item) => item && can(item[4]));
  if (!items.length) return "";
  return `<div class="pf-block" style="--i:1"><div class="pf-block-head"><span>Ações</span></div><div class="pf-actions">${items.map(([op, iconName, text, hint, , blocked]) => `<button type="button" class="pf-action" data-user-op="${op}" ${blocked ? `disabled title="${escapeHtml(blocked)}"` : ""}><span class="pf-action-ico">${icon(iconName)}</span><span class="pf-action-copy"><strong>${escapeHtml(text)}</strong><small>${escapeHtml(blocked || hint)}</small></span>${blocked ? icon("lock") : icon("chev-right")}</button>`).join("")}</div></div>`;
}

function drawerSummary(user, detail) {
  const activity = detail.activity || {};
  const { plan } = userPlanInfo(user, detail);
  const aiLimit = plan ? (Number.isInteger(plan.aiDailyLimit) ? plan.aiDailyLimit : plan.priceCents ? 200 : 10) : 10;
  const aiToday = Number(detail.aiToday) || 0;
  const aiPct = aiLimit ? Math.min(100, Math.round((aiToday / aiLimit) * 100)) : 0;
  const stat = (iconName, value, name) => `<div class="pf-stat"><span class="pf-stat-ico">${icon(iconName)}</span><strong data-count="${Number(value) || 0}">${(Number(value) || 0).toLocaleString("pt-BR")}</strong><small>${name}</small></div>`;
  const channel = (on, iconName, text) => `<span class="pf-channel ${on ? "is-on" : ""}">${icon(iconName)}${escapeHtml(text)}<i>${on ? "ligado" : "desligado"}</i></span>`;
  return `${drawerPlanCard(user, detail)}${drawerActions(user)}
    <div class="pf-block" style="--i:2"><div class="pf-block-head"><span>Uso no app</span><small>Só totais · conteúdo pessoal fica privado</small></div>
      <div class="pf-stats">${stat("check-circle", activity.tasks, "Tarefas")}${stat("note", activity.notes, "Notas")}${stat("calendar", activity.events, "Compromissos")}${stat("trend", activity.goals, "Metas")}${stat("wallet", activity.finances, "Lançamentos")}${stat("sparkle", aiToday, "Conversas IA hoje")}</div>
      <div class="pf-ai"><div><strong>Pulsinho hoje</strong><small>${aiLimit ? `${aiToday.toLocaleString("pt-BR")} de ${aiLimit.toLocaleString("pt-BR")} conversas` : `${aiToday.toLocaleString("pt-BR")} conversas · sem limite`}</small></div><div class="pf-meter ${aiPct >= 90 ? "is-hot" : ""}"><i style="--to:${aiLimit ? aiPct : 4}%"></i></div></div>
    </div>
    <div class="pf-block" style="--i:3"><div class="pf-block-head"><span>Linha da conta</span><small>${escapeHtml(tenureText(user.createdAt))}</small></div>
      ${drawerJourney(user, detail)}
      <div class="pf-channels">${channel(detail.whatsappLinked, "whatsapp", "WhatsApp")}${channel(detail.whatsappReminderEnabled, "clock", "Lembretes no WhatsApp")}${channel(detail.pushEnabled, "phone", "Notificações push")}</div>
    </div>
    ${drawerDanger(user, 4)}`;
}

function drawerDanger(user, order) {
  const items = [];
  if (user.planId && can("users.access")) items.push(`<button type="button" class="pf-danger-btn" data-user-op="remove">${icon("trash")}<span><strong>Remover plano</strong><small>Volta para a regra de quem está sem plano</small></span></button>`);
  if (can("users.status") && !user.admin) items.push(`<button type="button" class="pf-danger-btn" data-action="status" data-disabled="${!user.disabled}" data-direct-uid="${escapeHtml(user.uid)}">${icon(user.disabled ? "play" : "lock")}<span><strong>${user.disabled ? "Reativar conta" : "Desativar conta"}</strong><small>${user.disabled ? "O acesso volta na hora" : "Bloqueia app e WhatsApp sem apagar dados"}</small></span></button>`);
  return items.length ? `<div class="pf-block pf-danger" style="--i:${order}"><div class="pf-block-head"><span>Zona de cuidado</span></div>${items.join("")}</div>` : "";
}

function drawerCharges(user, detail) {
  const charges = detail.charges || [];
  const manage = can("charges.manage");
  const pending = charges.filter((charge) => charge.status === "manual_pending");
  const paid = charges.filter((charge) => ["manual_received", "paid"].includes(charge.status));
  const sum = (list) => list.reduce((total, charge) => total + (Number(charge.amountCents) || 0), 0);
  const head = `<div class="pf-totals" style="--i:0"><div><small>A receber</small><strong>${money(sum(pending))}</strong><span>${plural(pending.length, "cobrança", "cobranças")}</span></div><div><small>Recebido</small><strong>${money(sum(paid))}</strong><span>${plural(paid.length, "pagamento", "pagamentos")}</span></div>${manage ? `<button type="button" class="ad-primary-button" data-user-op="charge">${icon("plus")}Nova cobrança</button>` : ""}</div>`;
  if (!charges.length) return `${head}<div class="pf-empty" style="--i:1">${icon("receipt")}<strong>Nenhuma cobrança ainda</strong><span>Quando você cobrar, a pessoa vê em Configurações → Plano e paga por Pix ou cartão.</span></div>`;
  return `${head}<div class="pf-charges">${charges.map((charge, index) => {
    const open = charge.status === "manual_pending";
    const overdue = open && charge.dueDate && charge.dueDate < todayIso();
    return `<article class="pf-charge ${overdue ? "is-overdue" : ""}" data-charge-id="${escapeHtml(charge.id)}" style="--i:${Math.min(index + 1, 8)}">
      <div class="pf-charge-main"><strong>${money(charge.amountCents)}</strong>${chargeStatusChip(charge)}</div>
      <p>${escapeHtml(charge.note || "Cobrança")}</p>
      <small>${charge.createdAt ? `Criada ${escapeHtml(shortDate(charge.createdAt))}` : ""}${charge.dueDate ? ` · vence ${escapeHtml(shortDate(charge.dueDate))}` : ""}${charge.paidAt ? ` · paga ${escapeHtml(shortDate(charge.paidAt))}` : ""}${charge.planId && charge.grantDays ? ` · libera ${escapeHtml(state.plans.find((plan) => plan.id === charge.planId)?.name || charge.planId)} por ${charge.grantDays} dias` : ""}</small>
      ${open ? `<div class="pf-charge-acts"><button type="button" class="ad-subtle-button" data-copy-pay="${escapeHtml(charge.id)}">${icon("copy")}Copiar link</button>${manage ? `<button type="button" class="ad-subtle-button" data-charge-status="manual_received">${icon("check")}Recebida</button><button type="button" class="ad-subtle-button is-danger-text" data-charge-status="manual_cancelled">Cancelar</button>` : ""}</div>` : ""}
    </article>`;
  }).join("")}</div>`;
}

function historyDayLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sem data";
  const key = (item) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(item);
  if (key(date) === key(new Date())) return "Hoje";
  if (key(date) === key(new Date(Date.now() - 86400000))) return "Ontem";
  const text = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric", timeZone: "America/Sao_Paulo" }).format(date).replace(/\./g, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function drawerHistoryItems(user, detail) {
  const planName = (id) => state.plans.find((plan) => plan.id === id)?.name || id;
  const items = (detail.history || []).map((event) => {
    const [label, iconName] = AUDIT_LABELS[event.action] || [String(event.action || "Ação").replace(/_/g, " "), "list"];
    const bits = [event.details?.planId ? planName(event.details.planId) : "", event.details?.days ? `${event.details.days} dias` : "", event.details?.validUntil ? `até ${shortDate(event.details.validUntil)}` : ""].filter(Boolean);
    const tone = /remove|pause|disabled|revoked/.test(event.action) ? "is-danger" : /trial/.test(event.action) ? "is-trial" : /charge/.test(event.action) ? "is-money" : "is-plan";
    return { at: event.at, icon: iconName, tone, title: label, sub: [bits.join(" · "), event.actorEmail ? `por ${event.actorEmail}` : ""].filter(Boolean).join(" — ") };
  });
  for (const charge of detail.charges || []) {
    if (charge.createdAt) items.push({ at: charge.createdAt, icon: "receipt", tone: "is-money", title: `Cobrança de ${money(charge.amountCents)} criada`, sub: charge.note || "" });
    if (charge.paidAt) items.push({ at: charge.paidAt, icon: "check-circle", tone: "is-good", title: `Pagamento de ${money(charge.amountCents)} recebido`, sub: charge.note || "" });
  }
  if (user.createdAt) items.push({ at: user.createdAt, icon: "user-plus", tone: "is-good", title: "Conta criada", sub: user.provider === "google" ? "Entrou com Google" : "Entrou com e-mail e senha" });
  return items.filter((item) => item.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function drawerHistory(user, detail) {
  const items = drawerHistoryItems(user, detail);
  if (!items.length) return `<div class="pf-empty" style="--i:0">${icon("list")}<strong>Sem histórico</strong><span>As ações da equipe nesta conta aparecem aqui.</span></div>`;
  let current = "";
  let order = 0;
  return `<ol class="pf-timeline">${items.map((item) => {
    const dayLabel = historyDayLabel(item.at);
    const header = dayLabel !== current ? `<li class="pf-day" style="--i:${Math.min(order++, 10)}">${escapeHtml((current = dayLabel))}</li>` : "";
    const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date(item.at));
    return `${header}<li class="pf-event ${item.tone}" style="--i:${Math.min(order++, 10)}"><span class="pf-event-dot">${icon(item.icon)}</span><div><strong>${escapeHtml(item.title)}</strong>${item.sub ? `<small>${escapeHtml(item.sub)}</small>` : ""}</div><time datetime="${escapeHtml(item.at)}">${escapeHtml(time)}</time></li>`;
  }).join("")}</ol>`;
}

function drawerAccount(user, detail) {
  const row = (label, value, copy = "") => `<div class="pf-kv"><dt>${label}</dt><dd>${value}${copy ? `<button type="button" class="pf-copy" data-copy-text="${escapeHtml(copy)}" aria-label="Copiar ${escapeHtml(label.toLowerCase())}">${icon("copy")}</button>` : ""}</dd></div>`;
  const last = detail.lastActiveAt || user.lastActiveAt;
  return `<div class="pf-block" style="--i:0"><div class="pf-block-head"><span>Dados da conta</span></div><dl class="pf-kvs">
      ${row("E-mail", escapeHtml(user.email || "—"), user.email || "")}
      ${row("Entrada", user.provider === "google" ? "Google" : "E-mail e senha")}
      ${row("E-mail confirmado", user.emailVerified ? `<span class="ac-status is-on"><i></i>Sim</span>` : `<span class="ac-status is-warn"><i></i>Não</span>`)}
      ${row("Criada em", `${user.createdAt ? `<span class="pf-when"><b>${escapeHtml(dateTimeShort(user.createdAt))}</b><small>${escapeHtml(relativeTime(user.createdAt))}</small></span>` : "—"}`)}
      ${row("Último login", `${user.lastSignInAt ? `<span class="pf-when"><b>${escapeHtml(dateTimeShort(user.lastSignInAt))}</b><small>${escapeHtml(relativeTime(user.lastSignInAt))}</small></span>` : "—"}`)}
      ${row("Último uso", `${last ? `<span class="pf-when"><b>${escapeHtml(dateTimeShort(last))}</b><small>${escapeHtml(relativeTime(last))}</small></span>` : "—"}${last && detail.lastArea ? ` <span class="pf-area">${escapeHtml(AREA_LABELS[detail.lastArea] || detail.lastArea)}</span>` : ""}`)}
      ${row("ID da conta", `<code>${escapeHtml(user.uid)}</code>`, user.uid)}
    </dl></div>${drawerDanger(user, 1)}`;
}

function drawerSkeleton() {
  return `<div class="pf-skel"><i class="is-card"></i><i></i><i></i><i class="is-short"></i><i></i></div>`;
}

function drawerVitals(user, detail) {
  const used = detail?.lastActiveAt || user.lastActiveAt;
  const fresh = freshness(used);
  const area = detail?.lastArea ? AREA_LABELS[detail.lastArea] || detail.lastArea : "";
  const tile = (cls, iconName, title, big, small, tip) => `<div class="pf-vital ${cls}" title="${escapeHtml(tip)}"><span class="pf-vital-ico">${icon(iconName)}</span><small>${title}</small><strong>${escapeHtml(big)}</strong><span>${escapeHtml(small)}</span></div>`;
  return `<div class="pf-vitals">
    ${tile(`is-seen ${fresh.tone}`, "clock", "Último acesso", used ? relativeTime(used) : "Nunca", used ? [dateTimeShort(used), area].filter(Boolean).join(" · ") : "Ainda não usou o app", used ? readableTimestamp(used) : "")}
    ${tile("is-born", "user-plus", "Conta criada", user.createdAt ? relativeTime(user.createdAt) : "—", user.createdAt ? readableDate(user.createdAt) : "", user.createdAt ? `${readableTimestamp(user.createdAt)} · ${tenureText(user.createdAt)}` : "")}
    ${tile("is-login", "key", "Último login", user.lastSignInAt ? relativeTime(user.lastSignInAt) : "—", user.lastSignInAt ? dateTimeShort(user.lastSignInAt) : "", user.lastSignInAt ? `${readableTimestamp(user.lastSignInAt)} · ${user.provider === "google" ? "Google" : "e-mail e senha"}` : "")}
  </div>`;
}

// Linha da conta: da criação até hoje, com o último login e o último uso.
function drawerJourney(user, detail) {
  const start = new Date(user.createdAt || 0).getTime();
  const now = Date.now();
  if (!user.createdAt || !(now > start)) return "";
  const pos = (value) => (value ? Math.max(0, Math.min(100, ((new Date(value).getTime() - start) / (now - start)) * 100)) : null);
  const used = detail.lastActiveAt || user.lastActiveAt;
  const use = pos(used);
  const login = pos(user.lastSignInAt);
  const area = detail.lastArea ? AREA_LABELS[detail.lastArea] || detail.lastArea : "";
  return `<div class="pf-journey">
    <div class="pf-track" role="img" aria-label="Conta criada ${escapeHtml(dateTimeShort(user.createdAt, { time: false }))}, último uso ${escapeHtml(used ? relativeTime(used) : "nunca")}">
      <i class="pf-track-fill" style="--to:${use ?? 0}%"></i>
      ${login !== null ? `<span class="pf-mark is-login" style="--at:${login.toFixed(1)}%"></span>` : ""}
      ${use !== null ? `<span class="pf-mark is-use" style="--at:${use.toFixed(1)}%"></span>` : ""}
    </div>
    <div class="pf-track-ends"><span>${icon("user-plus")}Criada ${escapeHtml(dateTimeShort(user.createdAt, { time: false }))}</span><span>Hoje</span></div>
    <ul class="pf-legend">
      <li><i class="is-use"></i><span>Último uso do app</span><b>${escapeHtml(used ? relativeTime(used) : "nunca")}</b><small>${escapeHtml(used ? [dateTimeShort(used), area].filter(Boolean).join(" · ") : "")}</small></li>
      <li><i class="is-login"></i><span>Último login</span><b>${escapeHtml(user.lastSignInAt ? relativeTime(user.lastSignInAt) : "—")}</b><small>${escapeHtml(dateTimeShort(user.lastSignInAt))}</small></li>
    </ul>
  </div>`;
}

function renderUserDrawer(user, detail) {
  const [tone, label] = statusInfo(user);
  const fresh = freshness(detail?.lastActiveAt || user.lastActiveAt);
  const list = drawerList();
  const index = list.findIndex((item) => item.uid === user.uid);
  const tab = state.drawer.tab;
  const counts = { charges: detail?.charges?.length || 0, history: detail ? drawerHistoryItems(user, detail).length : 0 };
  const root = $("#adUserDrawerContent");
  if (!root) return;
  const panel = !detail ? drawerSkeleton()
    : tab === "charges" ? drawerCharges(user, detail)
      : tab === "history" ? drawerHistory(user, detail)
        : tab === "account" ? drawerAccount(user, detail)
          : drawerSummary(user, detail);
  const signature = `${user.planId}|${user.status}|${user.validUntil}|${user.segment}`;
  const changed = state.drawer.lastSig && state.drawer.lastSig.split("#")[0] === user.uid && state.drawer.lastSig.split("#")[1] !== signature;
  const scroller = root.querySelector(".pf-body");
  const keepScroll = scroller && !state.drawer.fresh ? scroller.scrollTop : 0;
  root.innerHTML = `<div class="pf ${state.drawer.fresh && detail ? "is-entering" : ""}">
    <header class="pf-head">
      <div class="pf-bar">
        <div class="pf-nav">${list.length > 1 ? `<button type="button" class="pf-icon" data-drawer-step="-1" ${index <= 0 ? "disabled" : ""} aria-label="Pessoa anterior" title="Anterior (K)">${icon("chev-up")}</button><button type="button" class="pf-icon" data-drawer-step="1" ${index < 0 || index >= list.length - 1 ? "disabled" : ""} aria-label="Próxima pessoa" title="Próxima (J)">${icon("chev-down")}</button><span>${index >= 0 ? `${(index + 1).toLocaleString("pt-BR")} de ${list.length.toLocaleString("pt-BR")}` : ""}</span>` : ""}</div>
        <button type="button" class="pf-icon pf-close" id="adUserDrawerClose" aria-label="Fechar ficha">${icon("x")}</button>
      </div>
      <div class="pf-id">
        <span class="pf-avatar ${tone}">${avatarHtml(user, "is-lg")}</span>
        <div class="pf-who">
          <h2 id="adUserDrawerTitle">${escapeHtml(user.displayName || user.email || "Usuário")}</h2>
          ${user.email ? `<button type="button" class="pf-mail" data-copy-text="${escapeHtml(user.email)}" title="Copiar e-mail"><span>${escapeHtml(user.email)}</span>${icon("copy")}</button>` : ""}
          <div class="pf-chips"><span class="ac-status ${tone}"><i></i>${escapeHtml(label)}</span><span class="pf-fresh ${fresh.tone}"><i></i>${escapeHtml(fresh.label)}</span>${user.admin ? `<span class="pf-tag">${icon("shield")}Equipe</span>` : ""}${user.disabled ? `<span class="pf-tag is-danger">${icon("lock")}Desativada</span>` : ""}${user.pending?.count ? `<span class="pf-tag is-warn">${icon("receipt")}${money(user.pending.cents)} a receber</span>` : ""}</div>
        </div>
      </div>
      ${drawerVitals(user, detail)}
      <nav class="pf-tabs" role="tablist" aria-label="Seções da ficha">${DRAWER_TABS.map(([key, text]) => `<button type="button" role="tab" id="pf-tab-${key}" aria-selected="${key === tab}" aria-controls="adDrawerDetail" tabindex="${key === tab ? 0 : -1}" data-drawer-tab="${key}">${text}${counts[key] ? `<em>${counts[key]}</em>` : ""}</button>`).join("")}<i class="pf-ink" aria-hidden="true"></i></nav>
    </header>
    <div class="pf-body" id="adDrawerDetail" role="tabpanel" aria-labelledby="pf-tab-${tab}"><div class="pf-panel ${changed ? "is-updated" : ""}">${panel}</div></div>
  </div>`;
  const body = root.querySelector(".pf-body");
  if (keepScroll) body.scrollTop = keepScroll;
  placeDrawerInk();
  if (detail && state.drawer.fresh) { if (typeof globalThis.requestAnimationFrame === "function") animateCounts(root); state.drawer.fresh = false; }
  state.drawer.lastSig = `${user.uid}#${signature}`;
}

function placeDrawerInk() {
  const nav = $("#adUserDrawer .pf-tabs");
  const active = nav?.querySelector("[aria-selected=true]");
  const ink = nav?.querySelector(".pf-ink");
  if (!active || !ink || typeof active.getBoundingClientRect !== "function") return;
  const a = active.getBoundingClientRect();
  const n = nav.getBoundingClientRect();
  ink.style.width = `${a.width}px`;
  ink.style.transform = `translateX(${a.left - n.left + nav.scrollLeft}px)`;
}

function animateCounts(root) {
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  for (const element of $$("[data-count]", root)) {
    const target = Number(element.dataset.count) || 0;
    if (target < 2) continue;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 650);
      element.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))).toLocaleString("pt-BR");
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

function setDrawerTab(tab, { focus = false } = {}) {
  if (!DRAWER_TABS.some(([key]) => key === tab) || tab === state.drawer.tab) return;
  const order = DRAWER_TABS.map(([key]) => key);
  const forward = order.indexOf(tab) > order.indexOf(state.drawer.tab);
  state.drawer.tab = tab;
  const user = state.directory.find((item) => item.uid === state.drawer.uid);
  if (!user) return;
  renderUserDrawer(user, state.drawer.detail);
  const body = $("#adDrawerDetail");
  if (body) { body.scrollTop = 0; body.querySelector(".pf-panel")?.classList.add(forward ? "pf-tab-next" : "pf-tab-prev"); }
  if (focus) $(`#pf-tab-${tab}`)?.focus({ preventScroll: true });
}

function closeUserDrawer() {
  const drawer = $("#adUserDrawer");
  drawer?.classList.remove("is-open");
  drawer?.setAttribute("aria-hidden", "true");
  if (drawer) drawer.inert = true;
  if (drawer) delete drawer.dataset.uid;
  const scrim = $("#adDrawerScrim");
  if (scrim) scrim.hidden = true;
  state.drawer.uid = null;
  state.drawer.lastSig = "";
  drawerFocusBack();
}

function bindUserDrawer() {
  const drawer = $("#adUserDrawer");
  if (!drawer || typeof drawer.addEventListener !== "function") return;
  $("#adDrawerScrim")?.addEventListener("click", () => { closeUserDrawer(); closeAuditDrawer(); });
  drawer.addEventListener("click", (event) => {
    const target = event.target;
    if (typeof target?.closest !== "function") return;
    if (target.closest("#adUserDrawerClose")) { closeUserDrawer(); return; }
    const tab = target.closest("[data-drawer-tab]");
    if (tab) { setDrawerTab(tab.dataset.drawerTab); return; }
    const step = target.closest("[data-drawer-step]");
    if (step && !step.disabled) { stepUserDrawer(Number(step.dataset.drawerStep)); return; }
    const copy = target.closest("[data-copy-text]");
    if (copy) { copyText(copy.dataset.copyText, "Copiado."); return; }
    if (target.closest("[data-drawer-retry]") && state.drawer.uid) openUserDrawer(state.drawer.uid, { keepTab: true });
  });
  drawer.addEventListener("keydown", (event) => {
    const tab = event.target.closest?.("[data-drawer-tab]");
    if (tab && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      const keys = DRAWER_TABS.map(([key]) => key);
      const next = keys[(keys.indexOf(state.drawer.tab) + (event.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length];
      setDrawerTab(next, { focus: true });
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName || "") || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "j" || event.key === "J") { event.preventDefault(); stepUserDrawer(1); }
    if (event.key === "k" || event.key === "K") { event.preventDefault(); stepUserDrawer(-1); }
  });
  drawer.addEventListener("scroll", (event) => {
    if (!event.target.classList?.contains("pf-body")) return;
    drawer.querySelector(".pf")?.classList.toggle("is-scrolled", event.target.scrollTop > 24);
  }, { capture: true, passive: true });
  if (typeof window?.addEventListener === "function") window.addEventListener("resize", placeDrawerInk, { passive: true });
}

// ── Ações de acesso (individual ou em lote) ──────────────────────────
function planOptions(selected = "", { includePrivate = true, placeholder = "Escolha um plano" } = {}) {
  const plans = state.plans.filter((plan) => plan.active !== false && (includePrivate || plan.visibility !== "private"));
  return `<option value="">${escapeHtml(placeholder)}</option>${plans.map((plan) => `<option value="${escapeHtml(plan.id)}" ${plan.id === selected ? "selected" : ""}>${escapeHtml(plan.name)} · ${plan.priceCents ? money(plan.priceCents) : "grátis"}${plan.visibility === "private" ? " · privado" : ""}</option>`).join("")}`;
}

const ACCESS_COPY = {
  assign: ["ATRIBUIR PLANO", "Atribuir plano", "Atribuir", "layers", "is-accent"],
  trial: ["TESTE GRÁTIS", "Dar teste grátis", "Dar teste", "gift", "is-cyan"],
  extend: ["PRAZO", "Estender prazo", "Estender", "hourglass", "is-green"],
  pause: ["PAUSAR", "Pausar acesso", "Pausar", "pause", "is-yellow"],
  resume: ["RETOMAR", "Retomar acesso", "Retomar", "play", "is-green"],
  remove: ["REMOVER", "Remover plano", "Remover plano", "trash", "is-red"],
};

function dayChips(name, values, selected) {
  return `<div class="ac-daychips" role="group">${values.map((value) => `<label><input type="radio" name="${name}" value="${value}" ${value === selected ? "checked" : ""} /><span>${value === 365 ? "1 ano" : `${value} dias`}</span></label>`).join("")}<label class="ac-daychips-custom"><input type="radio" name="${name}" value="custom" /><span>Outro</span><input type="number" min="1" max="730" step="1" name="${name}Custom" placeholder="dias" aria-label="Quantidade de dias" /></label></div>`;
}

function readDays(body, name) {
  const choice = body.querySelector(`input[name="${name}"]:checked`)?.value;
  return choice === "custom" ? Number(body.querySelector(`input[name="${name}Custom"]`)?.value) : Number(choice);
}

// Quem recebe a ação: uma pessoa (com plano atual) ou um grupo empilhado.
function whoCard(users) {
  if (users.length === 1) {
    const [user] = users;
    const [tone, label] = statusInfo(user);
    return `<div class="mx-who">${avatarHtml(user)}<span><strong>${escapeHtml(user.displayName || user.email || "Conta")}</strong><small>${escapeHtml(user.email || "")}</small></span><span class="ac-status ${tone}"><i></i>${escapeHtml(label)}</span></div>`;
  }
  return `<div class="mx-who is-many"><span class="mx-stack">${users.slice(0, 5).map((user) => avatarHtml(user, "is-sm")).join("")}${users.length > 5 ? `<span class="ac-avatar is-sm mx-more">+${users.length - 5}</span>` : ""}</span><span><strong>${users.length.toLocaleString("pt-BR")} pessoas</strong><small>${escapeHtml(users.slice(0, 2).map((user) => user.displayName || user.email).join(", "))}${users.length > 2 ? " e outras" : ""}</small></span></div>`;
}

// Planos em cartões (cor, preço, privado, atual) no lugar da lista suspensa.
function planPicker(selected, currentId = "") {
  const plans = state.plans.filter((plan) => plan.active !== false);
  if (!plans.length) return `<p class="ac-warn">${icon("alert")}Nenhum plano ativo. Crie um no Estúdio de planos.</p>`;
  return `<div class="mx-plans" role="radiogroup" aria-label="Plano">${plans.map((plan) => `<label class="mx-plan pc-accent-${escapeHtml(plan.accent || "violet")}"><input type="radio" name="planId" value="${escapeHtml(plan.id)}" ${plan.id === selected ? "checked" : ""} /><span><i class="mx-swatch" aria-hidden="true"></i><strong>${escapeHtml(plan.name)}</strong><small>${plan.priceCents ? escapeHtml(planPriceText(plan)) : "Grátis"}</small>${plan.id === currentId ? `<em>Atual</em>` : plan.visibility === "private" ? `<em>Privado</em>` : ""}</span></label>`).join("")}</div>`;
}

function addDaysIso(baseIso, days) {
  const base = baseIso && baseIso >= todayIso() ? new Date(`${baseIso}T12:00:00`) : new Date(`${todayIso()}T12:00:00`);
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function openAccessModal(op, uids) {
  if (!uids.length) return toast("Selecione ao menos uma pessoa.", true);
  const [kicker, title, confirmLabel, iconName, tone] = ACCESS_COPY[op];
  const users = uids.map((uid) => state.directory.find((item) => item.uid === uid)).filter(Boolean);
  const single = users.length === 1 ? users[0] : null;
  const stripeCount = users.filter((user) => user.source === "stripe").length;
  const withoutPlan = users.filter((user) => !user.planId).length;
  const noPlanRule = state.config?.access?.noPlan === "plan" ? `o plano gratuito "${escapeHtml(state.plans.find((plan) => plan.id === state.config.access.noPlanPlanId)?.name || state.config.access.noPlanPlanId)}"` : "o acesso completo";
  let body = whoCard(users);
  if (op === "assign") body += `<div class="ac-field"><span class="ac-label">Plano</span>${planPicker(single?.planId || "", single?.planId || "")}</div>
    <div class="ac-field"><span class="ac-label">Duração</span><div class="ac-daychips" role="group"><label><input type="radio" name="until" value="none" checked /><span>Sem data de fim</span></label><label><input type="radio" name="until" value="30" /><span>30 dias</span></label><label><input type="radio" name="until" value="90" /><span>90 dias</span></label><label><input type="radio" name="until" value="365" /><span>1 ano</span></label><label class="ac-daychips-custom"><input type="radio" name="until" value="date" /><span>Até</span><input type="date" name="validUntil" min="${todayIso()}" aria-label="Data de fim" /></label></div></div>`;
  if (op === "trial") body += `<div class="ac-field"><span class="ac-label">Plano do teste</span>${planPicker(state.config?.trial?.planId || state.plans.find((plan) => plan.priceCents)?.id || "")}</div><div class="ac-field"><span class="ac-label">Duração</span>${dayChips("days", [7, 14, 30], 7)}</div>`;
  if (op === "extend") body += `<div class="ac-field"><span class="ac-label">Adicionar</span>${dayChips("days", [7, 30, 90, 365], 30)}</div>`;
  if (op === "pause") body += `<p class="ac-confirm-text">Os recursos do plano ficam bloqueados até você retomar. Nada é apagado.</p>`;
  if (op === "resume") body += `<p class="ac-confirm-text">O plano volta a valer imediatamente, com o mesmo prazo de antes.</p>`;
  if (op === "remove") body += `<p class="ac-confirm-text">${single ? "A pessoa volta" : "As pessoas voltam"} para a regra de quem está sem plano: ${noPlanRule}.</p>`;
  body += `<div class="mx-result" id="adAccessResult" aria-live="polite"></div>`;
  if (op === "extend" && withoutPlan) body += `<p class="ac-hint">${icon("info")}${plural(withoutPlan, "pessoa sem plano será ignorada", "pessoas sem plano serão ignoradas")}.</p>`;
  if (stripeCount && ["remove", "pause", "assign"].includes(op)) body += `<p class="ac-warn">${icon("alert")}${plural(stripeCount, "pessoa paga", "pessoas pagam")} pelo Stripe. Isso não cancela a assinatura lá: cancele também no painel do Stripe para parar a cobrança.</p>`;

  const readPlan = (form) => state.plans.find((plan) => plan.id === form.querySelector("input[name=planId]:checked")?.value) || null;
  const readUntil = (form) => {
    const choice = form.querySelector("input[name=until]:checked")?.value || "none";
    if (choice === "none") return null;
    if (choice === "date") return form.querySelector("input[name=validUntil]").value || "";
    return addDaysIso(todayIso(), Number(choice));
  };
  const describe = (form) => {
    const who = single ? "" : ` para ${users.length.toLocaleString("pt-BR")} pessoas`;
    if (op === "assign") {
      const plan = readPlan(form);
      if (!plan) return ["", "Escolha um plano para ver o resultado."];
      const until = readUntil(form);
      return [`Atribuir ${plan.name}`, `${escapeHtml(plan.name)}${until ? ` até <strong>${escapeHtml(readableDate(until))}</strong>` : " <strong>sem data de fim</strong>"}${who}. O acesso muda na hora.`];
    }
    if (op === "trial") {
      const plan = readPlan(form);
      const days = readDays(form, "days");
      if (!plan || !(days > 0)) return ["", "Escolha o plano e os dias."];
      return [`Dar ${plural(days, "dia", "dias")} de ${plan.name}`, `Teste do ${escapeHtml(plan.name)} até <strong>${escapeHtml(readableDate(addDaysIso(todayIso(), days)))}</strong>${who}. Depois volta para ${noPlanRule} automaticamente.`];
    }
    if (op === "extend") {
      const days = readDays(form, "days");
      if (!(days > 0)) return ["", "Informe a quantidade de dias."];
      if (single?.validUntil) return [`Estender +${days} dias`, `Vencimento: ${escapeHtml(readableDate(single.validUntil))} → <strong>${escapeHtml(readableDate(addDaysIso(single.validUntil, days)))}</strong>`];
      return [`Estender +${days} dias`, `Soma <strong>${plural(days, "dia", "dias")}</strong> ao prazo atual${who} (a partir de hoje para quem já venceu).`];
    }
    return [confirmLabel, ""];
  };
  openModal({
    kicker, title, body, icon: iconName, tone,
    actions: [
      { label: "Cancelar" },
      { label: confirmLabel, kind: op === "remove" ? "danger" : "primary", busy: "Aplicando…", primary: true, onClick: async () => {
        const form = $("#adModalBody");
        const payload = { op, uids };
        if (op === "assign" || op === "trial") {
          payload.planId = form.querySelector("input[name=planId]:checked")?.value || "";
          if (!payload.planId) { toast("Escolha um plano.", true); return true; }
        }
        if (op === "assign") {
          const until = readUntil(form);
          if (until === "") { toast("Escolha a data de fim.", true); return true; }
          if (until) payload.validUntil = until;
        }
        if (op === "trial" || op === "extend") {
          payload.days = readDays(form, "days");
          if (!Number.isInteger(payload.days) || payload.days < 1) { toast("Informe a quantidade de dias.", true); return true; }
        }
        const result = await request("access-apply", payload);
        const skipped = result.skipped?.length ? ` · ${plural(result.skipped.length, "ignorada", "ignoradas")}` : "";
        toast(`${title}: ${plural(result.applied.length, "conta atualizada", "contas atualizadas")}${skipped}.`);
        state.selection.clear();
        await refreshAfterChange();
        return false;
      } },
    ],
    onOpen: (modalBody) => {
      const update = () => {
        const [label, text] = describe(modalBody);
        const result = modalBody.querySelector("#adAccessResult");
        if (result) { result.innerHTML = text ? `${icon("arrow-right")}<span>${text}</span>` : ""; result.hidden = !text; }
        const button = $("#adModalFoot [data-modal-primary]");
        if (button && label) button.textContent = label;
      };
      modalBody.addEventListener("change", (event) => {
        if (event.target.name === "validUntil" || event.target.name === "daysCustom") {
          const radio = event.target.closest("label")?.querySelector("input[type=radio]");
          if (radio) radio.checked = true;
        }
        update();
      });
      modalBody.addEventListener("input", (event) => {
        if (event.target.name === "daysCustom") { const radio = event.target.closest("label")?.querySelector("input[type=radio]"); if (radio) radio.checked = true; }
        update();
      });
      update();
    },
  });
}

async function refreshAfterChange() {
  await Promise.allSettled([loadDirectory(true), state.currentSection === "overview" ? loadDashboard() : null, state.currentSection === "plans" ? loadPlans() : null]);
  const drawer = $("#adUserDrawer");
  if (drawer?.classList.contains("is-open") && drawer.dataset.uid) openUserDrawer(drawer.dataset.uid, { keepTab: true });
  if (state.currentSection === "subscriptions") renderAccessTracking();
}

// ── Cobranças ────────────────────────────────────────────────────────
function payLink(chargeId) {
  return `${globalThis.location?.origin || "https://pulse-note-5erj.vercel.app"}/app?pay=${encodeURIComponent(chargeId)}`;
}

async function copyText(text, message = "Copiado.") {
  try { await navigator.clipboard.writeText(text); toast(message); } catch { toast("Não foi possível copiar automaticamente.", true); }
}

function chargeStatusChip(charge) {
  const overdue = charge.status === "manual_pending" && charge.dueDate && charge.dueDate < todayIso();
  const map = { manual_pending: [overdue ? "is-danger" : "is-warn", overdue ? "Vencida" : "Pendente"], manual_received: ["is-on", "Recebida"], paid: ["is-on", "Paga"], manual_cancelled: ["is-off", "Cancelada"], failed: ["is-danger", "Falhou"] };
  const [tone, label] = map[charge.status] || ["is-muted", charge.status];
  return `<span class="ac-status ${tone}"><i></i>${label}</span>`;
}

function userPickerHtml() {
  return `<div class="ac-picker"><label class="ac-search">${icon("search")}<input type="search" id="adPickerSearch" placeholder="Buscar por nome ou e-mail" autocomplete="off" /></label><div class="ac-picker-list" id="adPickerList"></div><small class="ac-muted" id="adPickerCount">Ninguém selecionado</small></div>`;
}

function bindUserPicker(body, picked) {
  const render = () => {
    const query = String(body.querySelector("#adPickerSearch")?.value || "").trim().toLowerCase();
    const users = state.directory.filter((user) => !user.disabled && (!query || `${user.displayName} ${user.email}`.toLowerCase().includes(query))).slice(0, 60);
    body.querySelector("#adPickerList").innerHTML = users.length ? users.map((user) => `<label class="ac-pick"><input type="checkbox" value="${escapeHtml(user.uid)}" ${picked.has(user.uid) ? "checked" : ""} />${avatarHtml(user, "is-sm")}<span><strong>${escapeHtml(user.displayName || user.email)}</strong><small>${escapeHtml(user.email)}</small></span></label>`).join("") : `<div class="ad-empty">Ninguém encontrado.</div>`;
    body.querySelector("#adPickerCount").textContent = picked.size ? `${plural(picked.size, "pessoa selecionada", "pessoas selecionadas")}` : "Ninguém selecionado";
  };
  body.querySelector("#adPickerSearch")?.addEventListener("input", render);
  body.querySelector("#adPickerList")?.addEventListener("change", (event) => {
    if (event.target.checked) picked.add(event.target.value); else picked.delete(event.target.value);
    render();
  });
  render();
}

async function openChargeModal(initialUids = []) {
  if (!state.plans.length) await loadPlans().catch(() => {});
  if (!state.directory.length) await loadDirectory().catch(() => {});
  const picked = new Set(initialUids);
  const requestId = newRequestId();
  const body = `${initialUids.length ? whoCard(initialUids.map((uid) => state.directory.find((item) => item.uid === uid)).filter(Boolean)) : userPickerHtml()}
    <div class="ac-seg" role="radiogroup" aria-label="Tipo de cobrança"><label><input type="radio" name="kind" value="plan" checked /><span>${icon("layers")}Plano</span></label><label><input type="radio" name="kind" value="custom" /><span>${icon("receipt")}Valor avulso</span></label></div>
    <div data-kind="plan" class="ac-kind"><div class="ac-field"><span class="ac-label">Plano</span>${planPicker("")}</div><div class="ad-form-row"><label class="ac-field">Valor (R$)<input name="planAmount" inputmode="decimal" placeholder="preço do plano" /></label><label class="ac-field">Libera quantos dias<input name="grantDays" type="number" min="1" max="730" step="1" placeholder="30" /></label></div><p class="ac-hint">${icon("info")}Quando a cobrança for paga, o plano é liberado (ou estendido) automaticamente por esse número de dias.</p></div>
    <div data-kind="custom" class="ac-kind" hidden><label class="ac-field">Valor (R$)<input name="amount" inputmode="decimal" placeholder="0,00" /></label></div>
    <div class="ad-form-row"><label class="ac-field">Descrição<input name="note" maxlength="300" placeholder="Ex.: Plano Pro · dezembro" /></label><label class="ac-field">Vencimento<input name="dueDate" type="date" min="${todayIso()}" /></label></div>
    <p class="ac-summary" id="adChargeSummary"></p>`;
  openModal({
    kicker: "NOVA COBRANÇA", title: "Cobrar", body, wide: !initialUids.length, icon: "receipt", tone: "is-pink",
    actions: [
      { label: "Cancelar" },
      { label: "Criar cobrança", kind: "primary", busy: "Criando…", onClick: async () => {
        const form = $("#adModalBody");
        const uids = [...picked];
        if (!uids.length) { toast("Escolha quem vai receber a cobrança.", true); return true; }
        const kind = form.querySelector("input[name=kind]:checked").value;
        const payload = { uids, requestId, note: form.querySelector("input[name=note]").value.trim(), dueDate: form.querySelector("input[name=dueDate]").value || null };
        if (kind === "plan") {
          payload.planId = form.querySelector("input[name=planId]:checked")?.value || "";
          if (!payload.planId) { toast("Escolha o plano.", true); return true; }
          const amount = parseMoney(form.querySelector("input[name=planAmount]").value);
          if (Number.isNaN(amount)) { toast("Valor inválido.", true); return true; }
          if (amount) payload.amountCents = amount;
          const grant = form.querySelector("input[name=grantDays]").value;
          if (grant) payload.grantDays = Number(grant);
        } else {
          const amount = parseMoney(form.querySelector("input[name=amount]").value);
          if (!amount || Number.isNaN(amount)) { toast("Informe o valor da cobrança.", true); return true; }
          payload.amountCents = amount;
        }
        const result = await request("charge-bulk", payload);
        await Promise.allSettled([loadCharges(), loadDirectory(true)]);
        state.selection.clear();
        renderUsers();
        showChargeCreated(result);
        return true;
      } },
    ],
    onOpen: (modalBody) => {
      if (!initialUids.length) bindUserPicker(modalBody, picked);
      const summary = () => {
        const kind = modalBody.querySelector("input[name=kind]:checked").value;
        for (const element of $$("[data-kind]", modalBody)) element.hidden = element.dataset.kind !== kind;
        const plan = state.plans.find((item) => item.id === modalBody.querySelector("input[name=planId]:checked")?.value);
        const amountInput = modalBody.querySelector("input[name=planAmount]");
        if (plan && !amountInput.dataset.touched) amountInput.value = plan.priceCents ? (plan.priceCents / 100).toFixed(2).replace(".", ",") : "";
        const grantInput = modalBody.querySelector("input[name=grantDays]");
        if (plan && !grantInput.dataset.touched) grantInput.value = plan.billingInterval === "year" ? 365 : 30;
        const cents = kind === "plan" ? parseMoney(amountInput.value) : parseMoney(modalBody.querySelector("input[name=amount]").value);
        const count = picked.size;
        modalBody.querySelector("#adChargeSummary").innerHTML = count && cents > 0
          ? `${icon("receipt")}${plural(count, "cobrança", "cobranças")} de <strong>${money(cents)}</strong>${count > 1 ? ` · total <strong>${money(cents * count)}</strong>` : ""}`
          : "";
      };
      modalBody.addEventListener("input", (event) => { if (event.target.name === "planAmount" || event.target.name === "grantDays") event.target.dataset.touched = "1"; summary(); });
      modalBody.addEventListener("change", summary);
      summary();
    },
  });
}

function showChargeCreated(result) {
  const created = result.created || [];
  const rows = created.slice(0, 8).map((item) => `<div class="ac-mini-row"><span><strong>${escapeHtml(userLabelByUid(item.uid))}</strong><small>${escapeHtml(payLink(item.id))}</small></span><button type="button" class="ac-icon-btn" data-copy-pay="${escapeHtml(item.id)}" aria-label="Copiar link">${icon("copy")}</button></div>`).join("");
  openModal({
    kicker: "PRONTO", icon: "check-circle", tone: "is-green", title: `${plural(created.length, "cobrança criada", "cobranças criadas")}`,
    body: `<p class="ac-confirm-text">Cada pessoa já vê a cobrança no app, em <strong>Configurações → Plano</strong>, com o botão de pagar. Se quiser avisar por WhatsApp ou e-mail, envie o link:</p>${rows ? `<div class="ac-mini-list">${rows}</div>` : ""}${created.length > 8 ? `<p class="ac-muted">E mais ${created.length - 8}. Os links também ficam na lista de cobranças.</p>` : ""}${result.skipped?.length ? `<p class="ac-warn">${icon("alert")}${plural(result.skipped.length, "pessoa ignorada", "pessoas ignoradas")} (conta inexistente ou cobrança repetida).</p>` : ""}`,
    actions: [{ label: "Fechar", kind: "primary" }],
  });
}

function renderChargeStats() {
  const root = $("#adChargeStats");
  if (!root) return;
  const today = todayIso();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const pending = state.charges.filter((charge) => charge.status === "manual_pending");
  const overdue = pending.filter((charge) => charge.dueDate && charge.dueDate < today);
  const received = state.charges.filter((charge) => ["paid", "manual_received"].includes(charge.status));
  const received30 = received.filter((charge) => String(charge.paidAt || charge.updatedAt || charge.createdAt || "") >= since);
  const sum = (list) => list.reduce((total, charge) => total + (Number(charge.amountCents) || 0), 0);
  root.innerHTML = [
    ["is-warn", "hourglass", "A receber", money(sum(pending)), plural(pending.length, "cobrança pendente", "cobranças pendentes")],
    ["is-danger", "alert", "Vencidas", money(sum(overdue)), plural(overdue.length, "cobrança", "cobranças")],
    ["is-on", "check-circle", "Recebido (30 dias)", money(sum(received30)), plural(received30.length, "pagamento", "pagamentos")],
    ["is-violet", "bank", "Recebido (total)", money(sum(received)), "nas últimas 300 cobranças"],
  ].map(([tone, iconName, label, value, sub]) => `<article class="ac-stat ${tone}"><span class="ac-stat-ico">${icon(iconName)}</span><div><span>${label}</span><strong>${value}</strong><small>${sub}</small></div></article>`).join("");
}

function renderCharges() {
  renderChargeStats();
  const filters = [["pending", "Pendentes"], ["overdue", "Vencidas"], ["paid", "Recebidas"], ["cancelled", "Canceladas"], ["all", "Todas"]];
  const today = todayIso();
  const match = (charge, key) => key === "all" || (key === "pending" && charge.status === "manual_pending")
    || (key === "overdue" && charge.status === "manual_pending" && charge.dueDate && charge.dueDate < today)
    || (key === "paid" && ["paid", "manual_received"].includes(charge.status)) || (key === "cancelled" && ["manual_cancelled", "failed"].includes(charge.status));
  $("#adChargeFilters").innerHTML = filters.map(([key, label]) => `<button type="button" role="tab" class="${state.chargeFilter === key ? "is-active" : ""}" data-charge-filter="${key}">${label}<span>${state.charges.filter((charge) => match(charge, key)).length}</span></button>`).join("");
  const query = state.chargeSearch.trim().toLowerCase();
  const list = state.charges.filter((charge) => match(charge, state.chargeFilter) && (!query || `${charge.email || userLabelByUid(charge.uid)} ${charge.note || ""}`.toLowerCase().includes(query)));
  const manage = can("charges.manage");
  $("#adChargesList").innerHTML = list.length
    ? `<div class="ac-row ac-head ac-charge-row" role="row"><span class="ac-cell">Pessoa</span><span class="ac-cell">Descrição</span><span class="ac-cell">Valor</span><span class="ac-cell">Vencimento</span><span class="ac-cell">Situação</span><span class="ac-cell"></span></div>${list.map((charge) => `<div class="ac-row ac-charge-row" role="row" data-charge-id="${escapeHtml(charge.id)}">
      <span class="ac-cell ac-usercell-static"><strong>${escapeHtml(charge.email || userLabelByUid(charge.uid))}</strong><small>${charge.source === "stripe" ? "Assinatura Stripe" : charge.provider === "stripe" ? "Pago pelo Stripe" : "Criada no painel"} · ${escapeHtml(shortDate(charge.createdAt))}</small></span>
      <span class="ac-cell" data-label="Descrição">${escapeHtml(charge.note || (charge.source === "stripe" ? "Fatura da assinatura" : "—"))}${charge.planId && charge.grantDays ? `<small class="ac-muted"> · libera ${charge.grantDays} dias</small>` : ""}</span>
      <span class="ac-cell ac-strong" data-label="Valor">${money(charge.amountCents)}</span>
      <span class="ac-cell ac-muted" data-label="Vencimento">${charge.dueDate ? escapeHtml(readableDate(charge.dueDate)) : "—"}</span>
      <span class="ac-cell" data-label="Situação">${chargeStatusChip(charge)}</span>
      <span class="ac-cell ac-actions">${charge.status === "manual_pending" ? `<button type="button" class="ac-icon-btn" data-copy-pay="${escapeHtml(charge.id)}" title="Copiar link de pagamento" aria-label="Copiar link de pagamento">${icon("copy")}</button>${manage ? `<button type="button" class="ac-text-btn" data-charge-status="manual_received">Recebida</button><button type="button" class="ac-text-btn is-danger" data-charge-status="manual_cancelled">Cancelar</button>` : ""}` : ""}</span>
    </div>`).join("")}`
    : `<div class="ad-empty">${state.charges.length ? "Nenhuma cobrança neste filtro." : "Nenhuma cobrança ainda. Selecione pessoas em Usuários e toque em Cobrar."}</div>`;
}

// ── Acessos e testes ─────────────────────────────────────────────────
function renderAccessForms() {
  const config = state.config;
  if (!config) return;
  for (const select of $$(".ac-plan-select")) {
    const current = select.closest("form")?.id === "adTrialForm" ? config.trial?.planId : config.access?.noPlanPlanId;
    select.innerHTML = planOptions(current || "");
  }
  const trialForm = $("#adTrialForm");
  if (trialForm?.elements) {
    trialForm.elements.enabled.checked = config.trial?.enabled === true;
    trialForm.elements.days.value = config.trial?.days || 7;
    $("#adTrialSince").textContent = config.trial?.enabled ? `Ligado desde ${readableTimestamp(config.trial.enabledAt)}` : "Desligado";
  }
  const policy = $("#adAccessPolicyForm");
  if (policy?.elements) {
    for (const radio of $$("input[name=noPlan]", policy)) radio.checked = radio.value === (config.access?.noPlan || "full");
    policy.elements.noPlanPlanId.disabled = config.access?.noPlan !== "plan" || !can("config.manage");
  }
  applyPermissions();
}

function renderAccessTracking() {
  const tabs = [
    ["trial", "Em teste", (user) => user.segment === "trial"],
    ["ending", "Acabando", (user) => (user.segment === "trial" && user.daysLeft !== null && user.daysLeft <= 3) || (user.segment === "plan" && user.daysLeft !== null && user.daysLeft <= 7)],
    ["attention", "Vencidos e pausados", (user) => ["expired", "paused", "cancelled", "trial_ended"].includes(user.segment)],
    ["plan", "Com plano", (user) => user.segment === "plan"],
  ];
  const root = $("#adAccessTabs");
  if (!root) return;
  root.innerHTML = tabs.map(([key, label, test]) => `<button type="button" role="tab" class="${state.accessTab === key ? "is-active" : ""}" data-access-tab="${key}">${label}<span>${state.directory.filter(test).length}</span></button>`).join("");
  const [, , test] = tabs.find(([key]) => key === state.accessTab) || tabs[0];
  const list = state.directory.filter(test).sort((a, b) => String(a.validUntil || "9999").localeCompare(String(b.validUntil || "9999")));
  const manage = can("users.access");
  $("#adSubscriptionsList").innerHTML = list.length
    ? list.map((user) => {
      const [tone, label] = statusInfo(user);
      return `<div class="ac-row ac-track-row" data-uid="${escapeHtml(user.uid)}"><button type="button" class="ac-cell ac-usercell" data-user-detail="${escapeHtml(user.uid)}">${avatarHtml(user)}<span><strong>${escapeHtml(user.displayName || user.email)}</strong><small>${escapeHtml(user.email)}</small></span></button><span class="ac-cell" data-label="Plano"><span class="ac-chip">${escapeHtml(user.planName || "—")}</span></span><span class="ac-cell" data-label="Situação"><span class="ac-status ${tone}"><i></i>${escapeHtml(label)}</span></span><span class="ac-cell ac-actions">${manage ? `${user.planId ? `<button type="button" class="ac-text-btn" data-quick-extend="${escapeHtml(user.uid)}" data-days="7">+7 dias</button>` : ""}<button type="button" class="ac-text-btn" data-user-detail="${escapeHtml(user.uid)}">Gerenciar</button>` : ""}</span></div>`;
    }).join("")
    : `<div class="ad-empty">Ninguém nesta lista agora.</div>`;
}

// ── Planos · Estúdio ─────────────────────────────────────────────────
// Lista na ordem da vitrine (arrastar ou setas), editor em abas e prévia
// ao vivo com o MESMO componente do app (plan-cards.js). Nada é gravado
// até "Salvar plano"; trocar de plano com alterações pede confirmação.
const ACCENT_LABELS = { violet: "Violeta", blue: "Azul", green: "Verde", amber: "Âmbar", rose: "Rosa", slate: "Grafite" };
const BADGE_SUGGESTIONS = ["Mais popular", "Melhor custo-benefício", "Recomendado", "Novo"];
const PLAN_TABS = [["showcase", "Vitrine", "palette"], ["price", "Preço", "tag"], ["features", "Recursos", "sliders"], ["publish", "Publicação", "rocket"]];
const MAX_BENEFITS = 12;
state.studio = { id: null, draft: null, original: "", tab: "showcase", mode: "plan", device: "phone", interval: "month", dragId: null, orderTimer: null };

function aiLimitLabel(plan) {
  if (Number.isInteger(plan.aiDailyLimit)) return plan.aiDailyLimit === 0 ? "IA sem limite" : `IA ${plan.aiDailyLimit}/dia`;
  return plan.priceCents ? "IA 200/dia" : "IA 10/dia";
}

function planFeatureEnabled(plan, key) {
  if (typeof plan?.features?.[key] === "boolean") return plan.features[key];
  if (key === "mediaRecognition") return plan?.features?.aiParsing === true && plan?.features?.whatsapp === true;
  if (key === "whatsappReminders") return plan?.features?.reminders === true && plan?.features?.whatsapp === true;
  if (key === "pushNotifications") return plan?.features?.reminders === true;
  if (key === "pdfReports") return plan?.features?.whatsapp === true;
  return false;
}

const centsToField = (cents) => (Number(cents) > 0 ? (Number(cents) / 100).toFixed(2).replace(".", ",") : "");
const slugify = (value) => String(value || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function planToDraft(plan) {
  const features = Object.fromEntries(Object.keys(FEATURE_LABELS).map((key) => [key, plan ? planFeatureEnabled(plan, key) : true]));
  return {
    id: plan?.id || "", isNew: !plan, name: plan?.name || "", description: plan?.description || "", tagline: plan?.tagline || "",
    benefits: Array.isArray(plan?.benefits) ? [...plan.benefits] : [], badge: plan?.badge || "", highlight: plan?.highlight === true,
    accent: plan?.accent || "violet", ctaLabel: plan?.ctaLabel || "", order: Number.isInteger(plan?.order) ? plan.order : (Math.max(0, ...state.plans.map((item) => Number(item.order) || 0)) + 10),
    priceCents: Number(plan?.priceCents) || 0, billingInterval: plan?.billingInterval === "year" ? "year" : "month",
    yearlyPriceCents: Number(plan?.yearlyPriceCents) || 0, stripePriceId: plan?.stripePriceId || "", stripePriceIdYear: plan?.stripePriceIdYear || "",
    trialDays: Number(plan?.trialDays) || 0, aiDailyLimit: Number.isInteger(plan?.aiDailyLimit) ? plan.aiDailyLimit : null,
    visibility: plan?.visibility === "private" ? "private" : "public", active: plan?.active !== false, features,
    subscribers: plan?.subscribers || { active: 0, trial: 0 }, updatedAt: plan?.updatedAt || null,
  };
}
const draftSignature = (draft) => JSON.stringify({ ...draft, subscribers: undefined, updatedAt: undefined, isNew: undefined, benefits: draft.benefits.map((item) => item.trim()).filter(Boolean) });
const studioDirty = () => Boolean(state.studio.draft) && draftSignature(state.studio.draft) !== state.studio.original;

function yearlySavings(draft) {
  if (draft.billingInterval === "year" || !draft.priceCents || !draft.yearlyPriceCents) return 0;
  const full = draft.priceCents * 12;
  return draft.yearlyPriceCents < full ? Math.round(((full - draft.yearlyPriceCents) / full) * 100) : 0;
}

// Como o app vai receber este rascunho (mesma forma do /api/billing).
function draftAsPublic(draft) {
  const yearly = draft.billingInterval === "month" && draft.yearlyPriceCents > 0 ? draft.yearlyPriceCents : null;
  return {
    id: draft.id || "novo", name: draft.name || "Novo plano", description: draft.description, tagline: draft.tagline,
    benefits: draft.benefits.map((item) => item.trim()).filter(Boolean), badge: draft.badge, highlight: draft.highlight, accent: draft.accent,
    ctaLabel: draft.ctaLabel, order: draft.order, priceCents: draft.priceCents, yearlyPriceCents: yearly, yearlySavingsPct: yearlySavings(draft),
    billingInterval: draft.billingInterval, trialDays: draft.trialDays, aiDailyLimit: draft.aiDailyLimit, features: draft.features,
    checkoutAvailable: Boolean(draft.stripePriceId), checkoutAvailableYear: Boolean(yearly && draft.stripePriceIdYear),
  };
}

function renderPlansStats() {
  const root = $("#adPlansStats");
  if (!root) return;
  const pub = state.plans.filter((plan) => plan.active !== false && plan.visibility !== "private").length;
  const priv = state.plans.filter((plan) => plan.visibility === "private").length;
  const subs = state.plans.reduce((sum, plan) => sum + (plan.subscribers?.active || 0), 0);
  const trial = state.plans.reduce((sum, plan) => sum + (plan.subscribers?.trial || 0), 0);
  const mrr = state.dashboard?.metrics?.mrrCents;
  root.innerHTML = [[pub, "na vitrine"], [priv, priv === 1 ? "privado" : "privados"], [subs, "assinantes"], [trial, "em teste"], ...(Number.isFinite(mrr) ? [[money(mrr), "MRR"]] : [])]
    .map(([value, label]) => `<div><strong>${typeof value === "number" ? value.toLocaleString("pt-BR") : escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
}

function renderPlanList() {
  const root = $("#adPlansList");
  if (!root) return;
  const manage = can("plans.manage");
  const list = state.plans.map((plan, index) => {
    const subs = plan.subscribers || { active: 0, trial: 0 };
    const price = plan.priceCents ? `${money(plan.priceCents)}/${plan.billingInterval === "year" ? "ano" : "mês"}` : "Grátis";
    const active = state.studio.id === plan.id;
    return `<li class="ps-item${active ? " is-active" : ""}${plan.active === false ? " is-inactive" : ""}" data-plan-id="${escapeHtml(plan.id)}" ${manage ? 'draggable="true"' : ""}>
      ${manage ? `<span class="ps-grip" aria-hidden="true">${icon("grip")}</span>` : ""}
      <button type="button" class="ps-item-main" data-select-plan="${escapeHtml(plan.id)}" aria-current="${active}">
        <span class="ps-swatch pc-accent-${escapeHtml(plan.accent || "violet")}" aria-hidden="true"></span>
        <span class="ps-item-copy"><strong>${escapeHtml(plan.name)}${plan.highlight ? `<em class="ps-star" title="Em destaque">${icon("sparkle")}</em>` : ""}</strong><small>${escapeHtml(price)} · ${subs.active} ${subs.active === 1 ? "ativo" : "ativos"}${subs.trial ? ` · ${subs.trial} em teste` : ""}</small></span>
        <span class="ps-item-tags">${plan.active === false ? `<span class="ac-chip is-off">Inativo</span>` : plan.visibility === "private" ? `<span class="ac-chip is-muted">${icon("lock")}Privado</span>` : `<span class="ac-chip is-on">${icon("eye")}Público</span>`}</span>
      </button>
      ${manage ? `<span class="ps-move"><button type="button" data-move-plan="up" aria-label="Subir ${escapeHtml(plan.name)}" ${index === 0 ? "disabled" : ""}>${icon("chev-up")}</button><button type="button" data-move-plan="down" aria-label="Descer ${escapeHtml(plan.name)}" ${index === state.plans.length - 1 ? "disabled" : ""}>${icon("chev-down")}</button></span>` : ""}
    </li>`;
  }).join("");
  const draftItem = state.studio.draft?.isNew ? `<li class="ps-item is-active is-new"><span class="ps-grip" aria-hidden="true">${icon("plus")}</span><span class="ps-item-main"><span class="ps-swatch pc-accent-${escapeHtml(state.studio.draft.accent)}" aria-hidden="true"></span><span class="ps-item-copy"><strong>${escapeHtml(state.studio.draft.name || "Novo plano")}</strong><small>Rascunho · ainda não salvo</small></span></span></li>` : "";
  root.innerHTML = list || draftItem ? `${list}${draftItem}` : `<li class="ad-empty">Nenhum plano ainda. Crie o primeiro em “Novo plano”.</li>`;
}

function field(label, control, hint = "") {
  return `<label class="ps-field"><span class="ps-label">${label}</span>${control}${hint ? `<small class="ps-hint">${hint}</small>` : ""}</label>`;
}

function benefitsEditor(draft) {
  return `<div class="ps-benefits" id="psBenefits">${draft.benefits.map((item, index) => `<div class="ps-benefit" data-benefit-row="${index}">
      <span class="ps-benefit-tick" aria-hidden="true">${icon("check")}</span>
      <input type="text" maxlength="90" value="${escapeHtml(item)}" data-benefit="${index}" aria-label="Vantagem ${index + 1}" placeholder="Ex.: Pulsinho no WhatsApp" />
      <button type="button" class="ps-mini" data-benefit-move="up" data-index="${index}" aria-label="Subir vantagem" ${index === 0 ? "disabled" : ""}>${icon("chev-up")}</button>
      <button type="button" class="ps-mini" data-benefit-move="down" data-index="${index}" aria-label="Descer vantagem" ${index === draft.benefits.length - 1 ? "disabled" : ""}>${icon("chev-down")}</button>
      <button type="button" class="ps-mini is-danger" data-benefit-remove="${index}" aria-label="Remover vantagem">${icon("x")}</button>
    </div>`).join("")}
    ${draft.benefits.length < MAX_BENEFITS ? `<button type="button" class="ps-add" data-benefit-add>${icon("plus")}Adicionar vantagem<small>${draft.benefits.length}/${MAX_BENEFITS}</small></button>` : `<small class="ps-hint">Limite de ${MAX_BENEFITS} vantagens.</small>`}
    ${!draft.benefits.length ? `<small class="ps-hint">${icon("info")}Sem vantagens escritas, a vitrine lista os recursos ligados na aba Recursos.</small>` : ""}
  </div>`;
}

function editorPanel(tab, draft) {
  if (tab === "showcase") return `
    <div class="ps-grid-2">${field("Nome do plano", `<input name="name" maxlength="80" value="${escapeHtml(draft.name)}" placeholder="Pro" required />`)}
      ${field("Texto do botão", `<input name="ctaLabel" maxlength="28" value="${escapeHtml(draft.ctaLabel)}" placeholder="Assinar ${escapeHtml(draft.name || "o plano")}" />`, "Vazio usa “Assinar” + nome.")}</div>
    ${field("Chamada", `<input name="tagline" maxlength="90" value="${escapeHtml(draft.tagline)}" placeholder="Tudo para quem quer ir além" />`, "Uma frase curta abaixo do nome.")}
    ${field("Descrição interna", `<input name="description" maxlength="300" value="${escapeHtml(draft.description)}" placeholder="Usada quando não há chamada e na lista de planos" />`)}
    <div class="ps-field"><span class="ps-label">Vantagens <small>na ordem em que aparecem</small></span>${benefitsEditor(draft)}</div>
    <div class="ps-grid-2">
      <div class="ps-field"><span class="ps-label">Selo</span><input name="badge" maxlength="24" value="${escapeHtml(draft.badge)}" placeholder="Sem selo" /><div class="ps-suggest">${BADGE_SUGGESTIONS.map((text) => `<button type="button" data-badge-pick="${escapeHtml(text)}" class="${draft.badge === text ? "is-on" : ""}">${escapeHtml(text)}</button>`).join("")}</div></div>
      <div class="ps-field"><span class="ps-label">Cor do plano</span><div class="ps-swatches" role="radiogroup" aria-label="Cor do plano">${PLAN_ACCENTS.map((accent) => `<label class="ps-swatch-pick pc-accent-${accent}" title="${ACCENT_LABELS[accent]}"><input type="radio" name="accent" value="${accent}" ${draft.accent === accent ? "checked" : ""} /><span aria-hidden="true"></span><em>${ACCENT_LABELS[accent]}</em></label>`).join("")}</div></div>
    </div>
    <label class="ac-switch ac-switch--row ps-switch"><input type="checkbox" name="highlight" ${draft.highlight ? "checked" : ""} /><span class="ac-switch-ui" aria-hidden="true"></span><span><strong>Destacar na vitrine</strong><small>Borda em degradê, botão cheio e leve elevação. Use em um plano só.</small></span></label>`;
  if (tab === "price") {
    const savings = yearlySavings(draft);
    return `
    <div class="ps-grid-2">${field("Preço", `<span class="ps-money"><em>R$</em><input name="price" inputmode="decimal" value="${centsToField(draft.priceCents)}" placeholder="0,00 = grátis" /></span>`)}
      <div class="ps-field"><span class="ps-label">Ciclo do preço</span><div class="ps-seg ps-seg--field" role="radiogroup"><label><input type="radio" name="billingInterval" value="month" ${draft.billingInterval === "month" ? "checked" : ""} /><span>Mensal</span></label><label><input type="radio" name="billingInterval" value="year" ${draft.billingInterval === "year" ? "checked" : ""} /><span>Anual</span></label></div></div></div>
    <div class="ps-callout${draft.billingInterval === "year" ? " is-muted" : ""}" id="psYearlyBox">
      <div class="ps-grid-2">${field("Preço do plano anual (opcional)", `<span class="ps-money"><em>R$</em><input name="yearlyPrice" inputmode="decimal" value="${centsToField(draft.yearlyPriceCents)}" placeholder="ex.: 299,00" ${draft.billingInterval === "year" ? "disabled" : ""} /></span>`, "Ativa a opção Mensal/Anual na vitrine.")}
        <div class="ps-savings" id="psSavings">${savings ? `<strong>−${savings}%</strong><span>de economia no anual</span>` : draft.yearlyPriceCents && draft.billingInterval === "month" ? `<strong class="is-warn">0%</strong><span>o anual não está mais barato que 12 meses</span>` : `<strong>—</strong><span>sem preço anual</span>`}</div></div>
    </div>
    <div class="ps-grid-2">${field("Dias grátis no checkout", `<input name="trialDays" type="number" min="0" max="60" step="1" value="${draft.trialDays || ""}" placeholder="0" />`, "Só para quem nunca assinou. A cobrança começa depois.")}
      ${field("Conversas com IA por dia", `<input name="aiDailyLimit" type="number" min="0" max="5000" step="1" value="${Number.isInteger(draft.aiDailyLimit) ? draft.aiDailyLimit : ""}" placeholder="padrão (10 grátis · 200 pago)" />`, "0 = sem limite.")}</div>
    <div class="ps-field"><span class="ps-label">Stripe (pagamento automático)</span>
      <div class="ps-grid-2">${field("Price ID mensal", `<input name="stripePriceId" maxlength="128" value="${escapeHtml(draft.stripePriceId)}" placeholder="price_…" autocomplete="off" spellcheck="false" />`)}
        ${field("Price ID anual", `<input name="stripePriceIdYear" maxlength="128" value="${escapeHtml(draft.stripePriceIdYear)}" placeholder="price_…" autocomplete="off" spellcheck="false" ${draft.billingInterval === "year" || !draft.yearlyPriceCents ? "disabled" : ""} />`)}</div>
      <div class="ps-checklist" id="psStripeCheck"></div></div>`;
  }
  if (tab === "features") return `
    <div class="ad-core-features"><strong>Sempre incluído</strong><span>Planner e tarefas</span><span>Notas</span><span>Finanças</span><span>Metas</span></div>
    ${FEATURE_GROUPS.map(([group, keys]) => `<fieldset class="ac-feature-group"><legend>${escapeHtml(group)}</legend>${keys.map((key) => `<label class="ac-switch ac-switch--row"><input type="checkbox" name="feature-${key}" ${draft.features[key] ? "checked" : ""} /><span class="ac-switch-ui" aria-hidden="true"></span><span><strong>${escapeHtml(FEATURE_LABELS[key][0])}</strong><small>${escapeHtml(FEATURE_LABELS[key][1])}</small></span></label>`).join("")}</fieldset>`).join("")}
    <p class="ps-hint">${icon("info")}Um recurso desligado em Produto → Recursos fica desligado para todos, mesmo marcado aqui.</p>`;
  const usedAs = [
    state.config?.trial?.enabled && state.config.trial.planId === draft.id ? "Plano do teste automático de novas contas" : "",
    state.config?.access?.noPlan === "plan" && state.config.access.noPlanPlanId === draft.id ? "Plano de quem está sem plano" : "",
  ].filter(Boolean);
  return `
    <div class="ps-cards" role="radiogroup" aria-label="Visibilidade">
      <label class="ps-choice"><input type="radio" name="visibility" value="public" ${draft.visibility === "public" ? "checked" : ""} /><span>${icon("eye")}<strong>Público</strong><small>Aparece na vitrine do app para assinar.</small></span></label>
      <label class="ps-choice"><input type="radio" name="visibility" value="private" ${draft.visibility === "private" ? "checked" : ""} /><span>${icon("lock")}<strong>Privado</strong><small>Só a equipe atribui (parcerias, cortesias).</small></span></label>
    </div>
    <label class="ac-switch ac-switch--row ps-switch"><input type="checkbox" name="active" ${draft.active ? "checked" : ""} /><span class="ac-switch-ui" aria-hidden="true"></span><span><strong>Plano ativo</strong><small>Desligado, ninguém novo recebe e quem tem perde os recursos do plano.</small></span></label>
    <div class="ps-grid-2">${field("Identificador", `<input name="id" maxlength="40" value="${escapeHtml(draft.id)}" placeholder="gerado pelo nome" pattern="[a-z0-9_-]{2,40}" ${draft.isNew ? "" : "readonly"} spellcheck="false" />`, draft.isNew ? "Letras minúsculas, números e hífen. Não muda depois." : "Fixo: é como o sistema reconhece o plano.")}
      <div class="ps-field"><span class="ps-label">Quem usa hoje</span><div class="ps-usage"><div><strong>${(draft.subscribers.active || 0).toLocaleString("pt-BR")}</strong><span>ativos</span></div><div><strong>${(draft.subscribers.trial || 0).toLocaleString("pt-BR")}</strong><span>em teste</span></div></div></div></div>
    ${usedAs.length ? `<ul class="ps-usedas">${usedAs.map((text) => `<li>${icon("link")}${escapeHtml(text)}</li>`).join("")}</ul>` : ""}
    ${draft.updatedAt ? `<p class="ps-hint">${icon("clock")}Atualizado ${escapeHtml(relativeTime(draft.updatedAt))}.</p>` : ""}`;
}

function renderStripeChecklist() {
  const root = $("#psStripeCheck");
  const draft = state.studio.draft;
  if (!root || !draft) return;
  const stripe = state.integrations?.integrations?.find((item) => item.id === "stripe");
  const items = draft.priceCents || draft.yearlyPriceCents ? [
    [Boolean(stripe?.configured), stripe?.configured ? "Stripe conectado ao servidor" : "Stripe ainda não conectado (Integrações)"],
    [Boolean(draft.stripePriceId) || !draft.priceCents, draft.stripePriceId ? "Botão Assinar ativo (mensal)" : "Sem Price ID mensal: o app mostra “Em breve”"],
    ...(draft.billingInterval === "month" && draft.yearlyPriceCents ? [[Boolean(draft.stripePriceIdYear), draft.stripePriceIdYear ? "Anual pronto para assinar" : "Sem Price ID anual: “Em breve” no anual"]] : []),
  ] : [[true, "Plano gratuito: não precisa de Stripe"]];
  root.innerHTML = items.map(([ok, text]) => `<span class="${ok ? "is-ok" : "is-warn"}">${icon(ok ? "check-circle" : "alert")}${escapeHtml(text)}</span>`).join("");
}

function renderPlanEditor() {
  const root = $("#adPlanEditor");
  if (!root) return;
  const draft = state.studio.draft;
  if (!draft) {
    root.innerHTML = `<div class="ps-empty">${icon("layers")}<strong>Selecione um plano</strong><span>Ou crie um novo para começar a vender.</span></div>`;
    return;
  }
  const manage = can("plans.manage");
  root.innerHTML = `
    <div class="ps-editor-head">
      <div><span class="ps-kicker">${draft.isNew ? "NOVO PLANO" : "EDITANDO"}</span><h3>${escapeHtml(draft.name || "Novo plano")}</h3><small>${draft.isNew ? "Rascunho — só passa a existir ao salvar" : `${escapeHtml(draft.id)} · ${draft.visibility === "private" ? "privado" : "público"}${draft.active ? "" : " · inativo"}`}</small></div>
      ${manage && !draft.isNew ? `<button type="button" class="ad-subtle-button ps-dup" data-plan-dup>${icon("dup")}Duplicar</button>` : ""}
    </div>
    <div class="ps-tabs" role="tablist" aria-label="Partes do plano">${PLAN_TABS.map(([key, label, iconName]) => `<button type="button" role="tab" id="psTab-${key}" aria-controls="psPanel-${key}" aria-selected="${state.studio.tab === key}" class="${state.studio.tab === key ? "is-active" : ""}" data-plan-tab="${key}">${icon(iconName)}<span>${label}</span></button>`).join("")}<i class="ps-tab-ink" aria-hidden="true"></i></div>
    <form class="ps-form${manage ? "" : " is-readonly"}" id="adPlanForm" novalidate>
      ${manage ? "" : `<p class="ac-readonly-note">${icon("lock")}Seu papel permite só visualizar os planos.</p>`}
      ${PLAN_TABS.map(([key]) => `<section class="ps-panel" role="tabpanel" id="psPanel-${key}" aria-labelledby="psTab-${key}" ${state.studio.tab === key ? "" : "hidden"}>${editorPanel(key, draft)}</section>`).join("")}
    </form>
    ${manage ? `<footer class="ps-savebar"><span class="ps-dirty" id="psDirty"></span><button type="button" class="ad-subtle-button" data-plan-discard>Descartar</button><button type="button" class="ad-primary-button" data-plan-save>${icon("check")}Salvar plano</button></footer>` : ""}`;
  if (!manage) for (const element of $$("input, select, textarea, button:not([data-plan-tab])", root.querySelector("#adPlanForm"))) element.disabled = true;
  positionTabInk(false);
  renderStripeChecklist();
  syncDirty();
}

function positionTabInk(animate = true) {
  const tabs = $(".ps-tabs");
  const active = tabs?.querySelector(".is-active");
  const ink = tabs?.querySelector(".ps-tab-ink");
  if (!active || !ink) return;
  if (!animate) ink.style.transition = "none";
  ink.style.width = `${active.offsetWidth}px`;
  ink.style.transform = `translateX(${active.offsetLeft}px)`;
  if (!animate) requestAnimationFrame(() => { ink.style.transition = ""; });
}

function syncDirty() {
  const dirty = studioDirty();
  const badge = $("#psDirty");
  if (badge) {
    badge.className = `ps-dirty${dirty ? " is-dirty" : ""}`;
    badge.innerHTML = dirty ? `<i></i>Alterações não salvas` : state.studio.draft?.isNew ? `<i></i>Rascunho` : `${icon("check")}Tudo salvo`;
  }
  $("[data-plan-discard]")?.toggleAttribute("disabled", !dirty);
  $(".ps-savebar")?.classList.toggle("is-dirty", dirty);
}

let previewFrame = 0;
function renderPlanPreview() {
  cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => {
    const root = $("#adPlanPreview");
    if (!root) return;
    const { draft, mode, interval } = state.studio;
    const current = draft ? draftAsPublic(draft) : null;
    let list = [];
    if (mode === "all") {
      list = state.plans.filter((plan) => plan.active !== false && plan.visibility !== "private" && plan.id !== draft?.id).map((plan) => draftAsPublic(planToDraft(plan)));
      if (current && draft.active && draft.visibility !== "private") list.push(current);
      list.sort((a, b) => (a.order - b.order) || (a.priceCents - b.priceCents));
    } else if (current) list = [current];
    const toggle = mode === "all" ? renderIntervalToggle(list, interval) : "";
    root.innerHTML = list.length
      ? `${toggle ? `<div class="ps-frame-toggle">${toggle}</div>` : ""}${renderPlanCards(list, { interval, preview: true, focusId: mode === "all" ? current?.id : null })}`
      : `<div class="pc-empty">${draft && (draft.visibility === "private" || !draft.active) ? "Este plano não aparece na vitrine (privado ou inativo)." : "Nada para mostrar."}</div>`;
    const note = $("#adPlanPreviewNote");
    if (note) note.innerHTML = draft && draft.visibility === "private" ? `${icon("lock")}Privado: só aparece para quem já tem este plano.` : draft && !draft.active ? `${icon("pause")}Inativo: fora da vitrine.` : `${icon("eye")}Como aparece no app em Configurações → Plano e na página Planos.`;
  });
}

function selectPlan(id, { force = false } = {}) {
  const plan = state.plans.find((item) => item.id === id) || null;
  const go = () => {
    state.studio.id = plan?.id || null;
    state.studio.draft = plan ? planToDraft(plan) : null;
    state.studio.original = state.studio.draft ? draftSignature(state.studio.draft) : "";
    renderPlanList();
    renderPlanEditor();
    renderPlanPreview();
  };
  if (!force && studioDirty() && id !== state.studio.id) {
    return confirmDialog({ title: "Descartar alterações?", message: `As mudanças em <strong>${escapeHtml(state.studio.draft.name || "este plano")}</strong> ainda não foram salvas.`, confirmLabel: "Descartar e trocar", danger: true }).then((ok) => { if (ok) go(); });
  }
  go();
  return Promise.resolve();
}

async function startNewPlan(from = null) {
  if (studioDirty()) {
    const ok = await confirmDialog({ title: "Descartar alterações?", message: "Há mudanças não salvas no plano aberto.", confirmLabel: "Descartar", danger: true });
    if (!ok) return;
  }
  const draft = planToDraft(from);
  draft.isNew = true;
  draft.subscribers = { active: 0, trial: 0 };
  draft.updatedAt = null;
  if (from) { draft.name = `${from.name} (cópia)`; draft.id = slugify(`${from.id}-copia`); draft.highlight = false; draft.order = Math.max(0, ...state.plans.map((item) => Number(item.order) || 0)) + 10; }
  else { draft.id = ""; }
  state.studio.id = null;
  state.studio.draft = draft;
  state.studio.original = "";
  state.studio.tab = "showcase";
  renderPlanList();
  renderPlanEditor();
  renderPlanPreview();
  if (state.currentSection !== "plans") showSection("plans");
  setTimeout(() => $("#adPlanForm [name=name]")?.focus(), 60);
}

// Lê um campo do editor para o rascunho.
function readDraftField(target) {
  const draft = state.studio.draft;
  if (!draft || !target?.name && !target?.dataset?.benefit) return;
  if (target.dataset.benefit !== undefined) { draft.benefits[Number(target.dataset.benefit)] = target.value; return; }
  const name = target.name;
  if (name === "price") { const cents = parseMoney(target.value); target.classList.toggle("is-invalid", Number.isNaN(cents)); if (!Number.isNaN(cents)) draft.priceCents = cents; }
  else if (name === "yearlyPrice") { const cents = parseMoney(target.value); target.classList.toggle("is-invalid", Number.isNaN(cents)); if (!Number.isNaN(cents)) draft.yearlyPriceCents = cents; }
  else if (name === "trialDays") draft.trialDays = Math.max(0, Math.min(60, Number(target.value) || 0));
  else if (name === "aiDailyLimit") draft.aiDailyLimit = target.value.trim() === "" ? null : Number(target.value);
  else if (name.startsWith("feature-")) draft.features[name.slice(8)] = target.checked;
  else if (["highlight", "active"].includes(name)) draft[name] = target.checked;
  else if (name === "id") { draft.id = slugify(target.value); }
  else if (name === "name") { draft.name = target.value; if (draft.isNew && !$("#adPlanForm [name=id]")?.dataset.touched) { draft.id = slugify(target.value); const idInput = $("#adPlanForm [name=id]"); if (idInput) idInput.value = draft.id; } }
  else if (["tagline", "description", "badge", "ctaLabel", "stripePriceId", "stripePriceIdYear"].includes(name)) draft[name] = target.value;
  else if (["accent", "visibility", "billingInterval"].includes(name)) draft[name] = target.value;
}

function refreshPriceDerived() {
  const draft = state.studio.draft;
  const box = $("#psSavings");
  if (box) {
    const savings = yearlySavings(draft);
    box.innerHTML = savings ? `<strong>−${savings}%</strong><span>de economia no anual</span>` : draft.yearlyPriceCents && draft.billingInterval === "month" ? `<strong class="is-warn">0%</strong><span>o anual não está mais barato que 12 meses</span>` : `<strong>—</strong><span>sem preço anual</span>`;
  }
  const yearlyOn = draft.billingInterval === "month";
  $("#psYearlyBox")?.classList.toggle("is-muted", !yearlyOn);
  const yearlyInput = $("#adPlanForm [name=yearlyPrice]");
  if (yearlyInput) yearlyInput.disabled = !yearlyOn;
  const yearlyPrice = $("#adPlanForm [name=stripePriceIdYear]");
  if (yearlyPrice) yearlyPrice.disabled = !yearlyOn || !draft.yearlyPriceCents;
  renderStripeChecklist();
}

async function savePlanDraft() {
  const draft = state.studio.draft;
  if (!draft) return;
  const id = slugify(draft.id || draft.name);
  const benefits = draft.benefits.map((item) => item.trim()).filter(Boolean);
  const problems = [];
  if (!draft.name.trim()) problems.push(["showcase", "Dê um nome ao plano."]);
  if (id.length < 2) problems.push(["publish", "Identificador precisa de 2 a 40 letras/números."]);
  if ($$("#adPlanForm input.is-invalid").length) problems.push(["price", "Confira os valores (use até duas casas decimais)."]);
  if (draft.aiDailyLimit !== null && (!Number.isInteger(draft.aiDailyLimit) || draft.aiDailyLimit < 0 || draft.aiDailyLimit > 5000)) problems.push(["price", "Conversas com IA: número de 0 a 5000."]);
  if (draft.stripePriceId && !/^price_[A-Za-z0-9]+$/.test(draft.stripePriceId.trim())) problems.push(["price", "Price ID mensal deve começar com price_."]);
  if (draft.stripePriceIdYear && !/^price_[A-Za-z0-9]+$/.test(draft.stripePriceIdYear.trim())) problems.push(["price", "Price ID anual deve começar com price_."]);
  if (draft.isNew && state.plans.some((plan) => plan.id === id)) problems.push(["publish", "Já existe um plano com esse identificador."]);
  if (problems.length) {
    state.studio.tab = problems[0][0];
    renderPlanEditor();
    toast(problems[0][1], true);
    return;
  }
  const original = state.plans.find((plan) => plan.id === id);
  const subscribers = (original?.subscribers?.active || 0) + (original?.subscribers?.trial || 0);
  const changedAccess = original && ((original.active !== false) !== draft.active || Object.keys(FEATURE_LABELS).some((key) => planFeatureEnabled(original, key) !== draft.features[key]));
  if (changedAccess && subscribers) {
    const ok = await confirmDialog({ title: "Mudar o acesso de quem já tem o plano?", message: `Recursos ou situação do plano mudam para <strong>${plural(subscribers, "pessoa", "pessoas")}</strong> imediatamente.`, confirmLabel: "Salvar mesmo assim" });
    if (!ok) return;
  }
  if (draft.highlight && state.plans.some((plan) => plan.highlight && plan.id !== id && plan.active !== false && plan.visibility !== "private")) {
    toast("Dica: já existe outro plano em destaque. Um destaque só costuma vender melhor.");
  }
  const button = $("[data-plan-save]");
  if (button) { button.disabled = true; button.textContent = "Salvando…"; }
  try {
    await request("plan-save", {
      id, name: draft.name.trim(), description: draft.description, tagline: draft.tagline, benefits, badge: draft.badge, highlight: draft.highlight,
      accent: draft.accent, ctaLabel: draft.ctaLabel, order: draft.order, priceCents: draft.priceCents, billingInterval: draft.billingInterval,
      yearlyPriceCents: draft.billingInterval === "month" && draft.yearlyPriceCents ? draft.yearlyPriceCents : null,
      stripePriceId: draft.stripePriceId.trim(), stripePriceIdYear: draft.billingInterval === "month" && draft.yearlyPriceCents ? draft.stripePriceIdYear.trim() : "",
      trialDays: draft.trialDays, aiDailyLimit: draft.aiDailyLimit, visibility: draft.visibility, active: draft.active, features: draft.features,
    });
    toast(draft.isNew ? `Plano ${draft.name.trim()} criado.` : "Plano salvo. A vitrine do app já mostra a nova versão.");
    state.studio.id = id;
    state.studio.draft = null;
    await loadPlans();
  } catch (error) {
    toast(errorText(error), true);
    if (button) { button.disabled = false; button.innerHTML = `${icon("check")}Salvar plano`; }
  }
}

function persistPlanOrder() {
  clearTimeout(state.studio.orderTimer);
  state.studio.orderTimer = setTimeout(async () => {
    try {
      await request("plan-order", { ids: state.plans.map((plan) => plan.id) });
      state.plans.forEach((plan, index) => { plan.order = (index + 1) * 10; });
      if (state.studio.draft && !state.studio.draft.isNew) {
        const wasDirty = studioDirty();
        state.studio.draft.order = state.plans.find((plan) => plan.id === state.studio.draft.id)?.order ?? state.studio.draft.order;
        if (!wasDirty) state.studio.original = draftSignature(state.studio.draft);
      }
      renderPlanPreview();
      toast("Ordem da vitrine atualizada.");
    } catch (error) { toast(errorText(error), true); await loadPlans(); }
  }, 450);
}

function movePlan(id, delta) {
  const index = state.plans.findIndex((plan) => plan.id === id);
  const next = index + delta;
  if (index < 0 || next < 0 || next >= state.plans.length) return;
  const [moved] = state.plans.splice(index, 1);
  state.plans.splice(next, 0, moved);
  renderPlanList();
  const row = $(`#adPlansList [data-plan-id="${CSS.escape(id)}"]`);
  row?.animate?.([{ transform: `translateY(${delta > 0 ? -18 : 18}px)`, opacity: .6 }, { transform: "none", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.16, 1, .3, 1)" });
  row?.querySelector(`[data-move-plan="${delta > 0 ? "down" : "up"}"]:not(:disabled)`)?.focus();
  persistPlanOrder();
}

function openShowcaseModal() {
  const plans = state.plans.filter((plan) => plan.active !== false && plan.visibility !== "private").map((plan) => draftAsPublic(planToDraft(plan)));
  let interval = "month";
  const draw = (body) => {
    body.querySelector(".ps-showcase-toggle").innerHTML = renderIntervalToggle(plans, interval);
    body.querySelector(".ps-showcase-cards").innerHTML = renderPlanCards(plans, { interval, preview: true });
  };
  openModal({
    kicker: "VITRINE DO APP", title: "Como a pessoa vê os planos", wide: true,
    body: `<div class="pc-scope ps-showcase"><p class="ac-confirm-text">Ordem, preços e textos exatamente como no app (Configurações → Plano e página Planos). Planos privados e inativos não aparecem.</p><div class="ps-showcase-toggle"></div><div class="ps-showcase-cards"></div></div>`,
    actions: [{ label: "Fechar", kind: "primary" }],
    onOpen: (body) => {
      draw(body);
      const onClick = (event) => { const button = event.target.closest?.("[data-plan-interval]"); if (button) { interval = button.dataset.planInterval; draw(body); } };
      body.addEventListener("click", onClick);
      return () => body.removeEventListener("click", onClick);
    },
  });
  $("#adModal")?.classList.add("is-showcase");
}

function renderPlans() {
  renderPlansStats();
  if (state.studio.draft?.isNew) { renderPlanList(); renderPlanPreview(); }
  else {
    const keep = state.plans.some((plan) => plan.id === state.studio.id) ? state.studio.id : state.plans[0]?.id || null;
    if (!studioDirty() || !state.studio.draft) {
      state.studio.id = keep;
      const plan = state.plans.find((item) => item.id === keep);
      state.studio.draft = plan ? planToDraft(plan) : null;
      state.studio.original = state.studio.draft ? draftSignature(state.studio.draft) : "";
      renderPlanEditor();
    }
    renderPlanList();
    renderPlanPreview();
  }
  const filter = $("#adUserPlanFilter");
  if (filter) filter.innerHTML = `<option value="">Todos os planos</option>${state.plans.map((plan) => `<option value="${escapeHtml(plan.id)}" ${state.userPlanFilter === plan.id ? "selected" : ""}>${escapeHtml(plan.name)}</option>`).join("")}`;
}

function bindPlanStudio() {
  const section = $("#pn-console-plans");
  if (!section) return;
  section.addEventListener("click", (event) => {
    const target = event.target;
    const select = target.closest("[data-select-plan]");
    if (select) { selectPlan(select.dataset.selectPlan); return; }
    const move = target.closest("[data-move-plan]");
    if (move) { movePlan(move.closest("[data-plan-id]").dataset.planId, move.dataset.movePlan === "up" ? -1 : 1); return; }
    const tab = target.closest("[data-plan-tab]");
    if (tab) {
      state.studio.tab = tab.dataset.planTab;
      for (const button of $$("[data-plan-tab]", section)) { const on = button === tab; button.classList.toggle("is-active", on); button.setAttribute("aria-selected", String(on)); }
      for (const panel of $$(".ps-panel", section)) panel.hidden = panel.id !== `psPanel-${state.studio.tab}`;
      positionTabInk();
      if (state.studio.tab === "price") renderStripeChecklist();
      return;
    }
    const badge = target.closest("[data-badge-pick]");
    if (badge) {
      const input = $("#adPlanForm [name=badge]");
      const value = state.studio.draft.badge === badge.dataset.badgePick ? "" : badge.dataset.badgePick;
      state.studio.draft.badge = value;
      if (input) input.value = value;
      for (const item of $$("[data-badge-pick]", section)) item.classList.toggle("is-on", item.dataset.badgePick === value);
      syncDirty(); renderPlanPreview(); return;
    }
    const draft = state.studio.draft;
    if (target.closest("[data-benefit-add]") && draft) { draft.benefits.push(""); rerenderBenefits(draft.benefits.length - 1); return; }
    const remove = target.closest("[data-benefit-remove]");
    if (remove && draft) { draft.benefits.splice(Number(remove.dataset.benefitRemove), 1); rerenderBenefits(); return; }
    const bmove = target.closest("[data-benefit-move]");
    if (bmove && draft) {
      const index = Number(bmove.dataset.index);
      const next = index + (bmove.dataset.benefitMove === "up" ? -1 : 1);
      [draft.benefits[index], draft.benefits[next]] = [draft.benefits[next], draft.benefits[index]];
      rerenderBenefits(next);
      return;
    }
    if (target.closest("[data-plan-save]")) { savePlanDraft(); return; }
    if (target.closest("[data-plan-discard]")) {
      if (state.studio.draft?.isNew) { state.studio.draft = null; renderPlans(); return; }
      selectPlan(state.studio.id, { force: true });
      toast("Alterações descartadas.");
      return;
    }
    if (target.closest("[data-plan-dup]")) { startNewPlan(state.plans.find((plan) => plan.id === state.studio.id)); return; }
    const mode = target.closest("[data-preview-mode]");
    if (mode) { state.studio.mode = mode.dataset.previewMode; segOn(mode); renderPlanPreview(); return; }
    const device = target.closest("[data-preview-device]");
    if (device) { state.studio.device = device.dataset.previewDevice; segOn(device); $(".ps-stage").dataset.device = state.studio.device; return; }
    const interval = target.closest("[data-preview-interval]") || target.closest("#adPlanPreview [data-plan-interval]");
    if (interval) {
      state.studio.interval = interval.dataset.previewInterval || interval.dataset.planInterval;
      for (const button of $$("[data-preview-interval]", section)) button.classList.toggle("is-on", button.dataset.previewInterval === state.studio.interval);
      renderPlanPreview();
    }
  });
  const onEdit = (event) => {
    if (!event.target.closest("#adPlanForm")) return;
    if (event.target.name === "id") event.target.dataset.touched = "1";
    readDraftField(event.target);
    if (["name"].includes(event.target.name)) { const title = $(".ps-editor-head h3"); if (title) title.textContent = state.studio.draft.name || "Novo plano"; if (state.studio.draft.isNew) renderPlanList(); }
    if (["accent"].includes(event.target.name) && state.studio.draft.isNew) renderPlanList();
    if (["price", "yearlyPrice", "billingInterval", "stripePriceId", "stripePriceIdYear"].includes(event.target.name)) refreshPriceDerived();
    if (event.target.name === "badge") for (const item of $$("[data-badge-pick]", section)) item.classList.toggle("is-on", item.dataset.badgePick === event.target.value);
    syncDirty();
    renderPlanPreview();
  };
  section.addEventListener("input", onEdit);
  section.addEventListener("change", onEdit);
  // Arrastar para reordenar (mouse); no toque, as setas fazem o mesmo.
  const list = $("#adPlansList");
  list?.addEventListener("dragstart", (event) => {
    const item = event.target.closest?.("[data-plan-id]");
    if (!item) return;
    state.studio.dragId = item.dataset.planId;
    item.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.dataset.planId);
  });
  list?.addEventListener("dragover", (event) => {
    const over = event.target.closest?.("[data-plan-id]");
    if (!over || !state.studio.dragId || over.dataset.planId === state.studio.dragId) return;
    event.preventDefault();
    const rect = over.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    for (const item of $$(".ps-item", list)) item.classList.remove("drop-before", "drop-after");
    over.classList.add(after ? "drop-after" : "drop-before");
  });
  list?.addEventListener("drop", (event) => {
    event.preventDefault();
    const over = event.target.closest?.("[data-plan-id]");
    const dragId = state.studio.dragId;
    if (!over || !dragId || over.dataset.planId === dragId) return;
    const after = over.classList.contains("drop-after");
    const [moved] = state.plans.splice(state.plans.findIndex((plan) => plan.id === dragId), 1);
    const target = state.plans.findIndex((plan) => plan.id === over.dataset.planId);
    state.plans.splice(after ? target + 1 : target, 0, moved);
    renderPlanList();
    persistPlanOrder();
  });
  list?.addEventListener("dragend", () => { state.studio.dragId = null; for (const item of $$(".ps-item", list)) item.classList.remove("is-dragging", "drop-before", "drop-after"); });
  $("#adPlansShowcase")?.addEventListener("click", openShowcaseModal);
  if (typeof window?.addEventListener === "function") window.addEventListener("beforeunload", (event) => { if (studioDirty()) { event.preventDefault(); event.returnValue = ""; } });
}

function segOn(button) {
  for (const item of $$("button", button.parentElement)) item.classList.toggle("is-on", item === button);
}

function rerenderBenefits(focusIndex = null) {
  const box = $("#psBenefits");
  if (!box) return;
  box.outerHTML = benefitsEditor(state.studio.draft);
  if (focusIndex !== null) $(`#psBenefits [data-benefit="${focusIndex}"]`)?.focus();
  syncDirty();
  renderPlanPreview();
}

// ── Recursos, operação e equipe ──────────────────────────────────────
function renderConfig() {
  if (!state.config) return;
  const config = state.config;
  const maintenance = config.maintenance || {};
  $("#adMaintenanceStatus").className = `ad-pill ${maintenance.enabled ? "is-danger" : ""}`;
  $("#adMaintenanceStatus").textContent = maintenance.enabled ? "Ativo" : "Desativado";
  $("#adMaintenanceBanner").hidden = !maintenance.enabled;
  $("#adNavMaintenanceBadge").hidden = !maintenance.enabled;
  $("#adFeatureSwitches").innerHTML = FEATURE_GROUPS.map(([group, keys]) => `<fieldset class="ac-feature-group"><legend>${escapeHtml(group)}</legend>${keys.map((key) => `<label class="ac-switch ac-switch--row"><input type="checkbox" name="${key}" ${config.features[key] ? "checked" : ""} /><span class="ac-switch-ui" aria-hidden="true"></span><span><strong>${escapeHtml(FEATURE_LABELS[key][0])}</strong><small>${escapeHtml(FEATURE_LABELS[key][1])}</small></span></label>`).join("")}</fieldset>`).join("");
  const form = $("#adSettingsForm");
  if (form?.elements) {
    form.elements.maintenance.checked = maintenance.enabled === true;
    form.elements.maintenanceMessage.value = maintenance.message || "";
    form.elements.maintenanceEta.value = maintenance.eta || "";
    form.elements.allowAdmins.checked = maintenance.allowAdmins !== false;
  }
  $("#adMaintPill").className = `ad-pill ${maintenance.enabled ? "is-danger" : ""}`;
  $("#adMaintPill").textContent = maintenance.enabled ? `Ativa desde ${shortDate(maintenance.startedAt) || "agora"}` : "App no ar";
  $("#adMaintCard")?.classList.toggle("is-active", maintenance.enabled === true);
  $("#adMaintOn").hidden = maintenance.enabled === true;
  $("#adMaintOff").hidden = maintenance.enabled !== true;
  renderMaintenancePreview();
  const payment = $("#adPaymentForm");
  if (payment?.elements) {
    payment.elements.pixKey.value = config.payment?.pixKey || "";
    payment.elements.pixHolder.value = config.payment?.pixHolder || "";
    payment.elements.instructions.value = config.payment?.instructions || "";
  }
  renderAccessForms();
  renderAlerts();
  applyPermissions();
}

function renderMaintenancePreview() {
  const form = $("#adSettingsForm");
  if (!form?.elements) return;
  $("#adMaintPreviewMsg").textContent = form.elements.maintenanceMessage.value || "O PulseNote está em manutenção. Tente novamente em breve.";
  const eta = form.elements.maintenanceEta.value.trim();
  $("#adMaintPreviewEta").hidden = !eta;
  $("#adMaintPreviewEta").textContent = eta ? `Previsão de retorno: ${eta}` : "";
}

async function saveMaintenance(enabled) {
  const form = $("#adSettingsForm");
  const data = await request("config-update", { maintenance: { enabled, message: form.elements.maintenanceMessage.value, eta: form.elements.maintenanceEta.value, allowAdmins: form.elements.allowAdmins.checked } });
  state.config = data.config;
  renderConfig();
}

function renderAdmins() {
  const root = $("#adAdminsList");
  if (!root) return;
  const owner = state.isOwner;
  root.innerHTML = state.admins.length ? state.admins.map((admin) => {
    const editable = owner && !admin.owner && admin.source !== "environment" && admin.uid !== state.user?.uid;
    return `<div class="ac-team-row"><span class="ac-avatar">${escapeHtml(initials(admin.displayName || admin.email))}</span><span class="ac-team-copy"><strong>${escapeHtml(admin.displayName || admin.email)}${admin.uid === state.user?.uid ? ` <em class="ac-tag">Você</em>` : ""}</strong><small>${escapeHtml(admin.email)}${admin.source === "environment" ? " · definido no servidor" : admin.lastSignInAt ? ` · último login ${escapeHtml(relativeTime(admin.lastSignInAt))}` : ""}</small></span>
      ${editable ? `<select class="ac-select ac-role-select" data-role-uid="${escapeHtml(admin.uid)}" aria-label="Papel de ${escapeHtml(admin.email)}">${["admin", "finance", "support", "viewer"].map((role) => `<option value="${role}" ${admin.role === role ? "selected" : ""}>${ROLE_INFO[role][0]}</option>`).join("")}</select><button type="button" class="ac-icon-btn is-danger" data-revoke-admin="${escapeHtml(admin.uid)}" aria-label="Remover acesso de ${escapeHtml(admin.email)}" title="Remover acesso">${icon("trash")}</button>` : `<span class="ac-chip ${admin.owner ? "is-on" : ""}">${admin.owner ? icon("crown") : ""}${escapeHtml(ROLE_INFO[admin.role]?.[0] || "Administrador")}</span>`}
    </div>`;
  }).join("") : `<div class="ad-empty">Só você por enquanto.</div>`;
  $("#adAdminForm").hidden = !owner;
  $("#adAdminFormLocked").hidden = owner;
  const roles = ["owner", "admin", "finance", "support", "viewer"];
  $("#adRolesMatrix").innerHTML = `<div class="ac-matrix-row ac-matrix-head"><span>Permissão</span>${roles.map((role) => `<span title="${escapeHtml(ROLE_INFO[role][0])}: ${escapeHtml(ROLE_INFO[role][1])}" data-short="${escapeHtml(ROLE_SHORT[role] || ROLE_INFO[role][0].slice(0, 4))}">${ROLE_INFO[role][0]}</span>`).join("")}</div>${PERMISSION_LABELS.map(([key, label]) => `<div class="ac-matrix-row"><span>${escapeHtml(label)}</span>${roles.map((role) => `<span>${ROLE_PERMISSIONS_UI[role].includes(key) ? `<b class="is-yes">${icon("check")}</b>` : `<b class="is-no">—</b>`}</span>`).join("")}</div>`).join("")}`;
}

// ── Paleta de comandos (Ctrl/⌘ K) ────────────────────────────────────
// Busca pessoas, planos, telas e ações de qualquer lugar do painel.
const SECTION_ICONS = { overview: "home", users: "users", subscriptions: "gift", plans: "layers", charges: "wallet", features: "sliders", integrations: "link", security: "shield", settings: "wrench" };
const cmd = { items: [], index: 0, lastFocus: null };
const normalizeText = (value) => String(value || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function commandItems(query) {
  const q = normalizeText(query.trim());
  const match = (...values) => !q || values.some((value) => normalizeText(value).includes(q));
  const actions = [
    ["plan", "Novo plano", "Criar e publicar no estúdio", "plus", "plans.manage", () => startNewPlan(null)],
    ["charge", "Nova cobrança", "Cobrar uma ou várias pessoas", "receipt", "charges.manage", () => openChargeModal([])],
    ["showcase", "Ver vitrine do app", "Como a pessoa vê os planos", "eye", null, async () => { if (!state.plans.length) await loadPlans(); openShowcaseModal(); }],
    ["csv", "Exportar usuários (CSV)", "Lista filtrada atual", "download", null, async () => { if (!state.directory.length) await loadDirectory(); exportUsersCsv(); }],
    ["maint", state.config?.maintenance?.enabled ? "Encerrar manutenção" : "Ativar manutenção", "Operação do app", "wrench", "config.manage", () => showSection("settings")],
    ["theme", "Alternar tema claro/escuro", "Aparência do painel", "sun", null, () => applyTheme(document.documentElement.dataset.theme === "light" ? "aurora" : "light")],
    ["app", "Abrir meu PulseNote", "Voltar ao aplicativo", "external", null, () => { globalThis.location.href = "/app"; }],
  ].filter(([, , , , perm]) => !perm || can(perm)).filter(([, title, sub]) => match(title, sub))
    .map(([id, title, sub, iconName, , run]) => ({ group: "Ações", id: `a-${id}`, title, sub, icon: iconName, run }));
  const sections = Object.entries(SECTION_LABELS).filter(([key, label]) => match(label, SECTION_SUBTITLES[key]))
    .map(([key, label]) => ({ group: "Ir para", id: `s-${key}`, title: label, sub: SECTION_SUBTITLES[key], icon: SECTION_ICONS[key], run: () => showSection(key) }));
  const plans = q ? state.plans.filter((plan) => match(plan.name, plan.id, plan.tagline)).slice(0, 4)
    .map((plan) => ({ group: "Planos", id: `p-${plan.id}`, title: plan.name, sub: `${plan.priceCents ? `${money(plan.priceCents)}/${plan.billingInterval === "year" ? "ano" : "mês"}` : "Grátis"} · ${plan.visibility === "private" ? "privado" : "público"}`, icon: "layers", run: async () => { await showSection("plans"); selectPlan(plan.id); } })) : [];
  const people = q.length >= 2 ? state.directory.filter((user) => match(user.displayName, user.email)).slice(0, 6)
    .map((user) => ({ group: "Pessoas", id: `u-${user.uid}`, title: user.displayName || user.email, sub: `${user.email} · ${statusInfo(user)[1]}`, avatar: user, run: async () => { if (state.currentSection !== "users") await showSection("users"); openUserDrawer(user.uid); } })) : [];
  return q ? [...people, ...plans, ...actions, ...sections] : [...actions.slice(0, 4), ...sections];
}

function renderCommandList() {
  const list = $("#adCmdList");
  if (!list) return;
  const items = cmd.items;
  if (!items.length) { list.innerHTML = `<div class="st-cmd-empty">${icon("search")}Nada encontrado. Tente um nome, e-mail ou plano.</div>`; return; }
  let group = "";
  list.innerHTML = items.map((item, index) => {
    const head = item.group !== group ? `<div class="st-cmd-group" role="presentation">${escapeHtml((group = item.group))}</div>` : "";
    return `${head}<button type="button" role="option" id="adCmd-${index}" class="st-cmd-item${index === cmd.index ? " is-active" : ""}" aria-selected="${index === cmd.index}" data-cmd-index="${index}">
      ${item.avatar ? avatarHtml(item.avatar, "is-sm") : `<span class="st-cmd-ico">${icon(item.icon)}</span>`}
      <span class="st-cmd-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.sub || "")}</small></span>${icon("arrow-right")}</button>`;
  }).join("");
  $("#adCmdInput")?.setAttribute("aria-activedescendant", `adCmd-${cmd.index}`);
  list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
}

function openCommand() {
  const box = $("#adCmd");
  if (!box || !box.hidden || $(".ad-shell")?.classList.contains("is-locked")) return;
  cmd.lastFocus = document.activeElement;
  box.hidden = false;
  document.documentElement.classList.add("st-cmd-open");
  const input = $("#adCmdInput");
  input.value = "";
  cmd.index = 0;
  cmd.items = commandItems("");
  renderCommandList();
  requestAnimationFrame(() => input.focus());
  if (!state.directory.length) loadDirectory().then(() => { if (!box.hidden && input.value) { cmd.items = commandItems(input.value); renderCommandList(); } }).catch(() => {});
}

function closeCommand() {
  const box = $("#adCmd");
  if (!box || box.hidden) return;
  box.classList.add("is-leaving");
  setTimeout(() => { box.hidden = true; box.classList.remove("is-leaving"); document.documentElement.classList.remove("st-cmd-open"); }, prefersReducedMotionAdmin() ? 0 : 140);
  cmd.lastFocus?.focus?.({ preventScroll: true });
}

function runCommand(index) {
  const item = cmd.items[index];
  if (!item) return;
  closeCommand();
  Promise.resolve(item.run()).catch((error) => toast(errorText(error), true));
}

const prefersReducedMotionAdmin = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function bindCommandPalette() {
  $("#adCmdTrigger")?.addEventListener("click", openCommand);
  document.addEventListener("keydown", (event) => {
    const typing = event.target?.closest?.("input, textarea, select, [contenteditable]");
    if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if ($("#adCmd").hidden) openCommand(); else closeCommand(); return; }
    if (event.key === "/" && !typing && $("#adCmd")?.hidden && $("#adModal")?.hidden) { event.preventDefault(); openCommand(); }
  });
  $("#adCmdInput")?.addEventListener("input", (event) => { cmd.items = commandItems(event.target.value); cmd.index = 0; renderCommandList(); });
  $("#adCmdInput")?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!cmd.items.length) return;
      cmd.index = (cmd.index + (event.key === "ArrowDown" ? 1 : -1) + cmd.items.length) % cmd.items.length;
      renderCommandList();
    } else if (event.key === "Enter") { event.preventDefault(); runCommand(cmd.index); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCommand(); }
  });
  $("#adCmd")?.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-cmd-close]")) { closeCommand(); return; }
    const button = event.target.closest?.("[data-cmd-index]");
    if (button) runCommand(Number(button.dataset.cmdIndex));
  });
  $("#adCmdList")?.addEventListener("pointermove", (event) => {
    const button = event.target.closest?.("[data-cmd-index]");
    if (!button || Number(button.dataset.cmdIndex) === cmd.index) return;
    cmd.index = Number(button.dataset.cmdIndex);
    for (const item of $$(".st-cmd-item", $("#adCmdList"))) { const on = item === button; item.classList.toggle("is-active", on); item.setAttribute("aria-selected", String(on)); }
  });
}

function bindQuickActions() {
  $("#adQuick")?.addEventListener("click", async (event) => {
    const action = event.target.closest?.("[data-quick]")?.dataset.quick;
    if (!action) return;
    try {
      if (action === "charge") await openChargeModal([]);
      if (action === "plan") await startNewPlan(null);
      if (action === "trial") { state.userFilter = "none"; await showSection("users"); toast("Selecione as pessoas na lista e toque em “Dar teste”."); }
      if (action === "showcase") { if (!state.plans.length) await loadPlans(); openShowcaseModal(); }
    } catch (error) { toast(errorText(error), true); }
  });
}

// ── Carregamento ─────────────────────────────────────────────────────
function renderDashboardData(data) {
  state.dashboard = data;
  renderKpis(data.metrics || {}, data.segments || {});
  renderOperations(data.metrics || {});
  renderSegments();
  renderGrowth();
  renderPlanBreakdown(data);
  renderAccessChart(data.lastAccessByDay);
  renderJourney(data.journey);
  renderUsageFlow(data.usageFlow);
  renderAudit(data.recentAudit);
  renderAlerts();
  const segments = data.segments || {};
  const trialBadge = $("#adNavTrialBadge");
  if (trialBadge) { trialBadge.hidden = !segments.trialEndingSoon; trialBadge.textContent = segments.trialEndingSoon || ""; }
  const chargeBadge = $("#adNavChargesBadge");
  if (chargeBadge) { chargeBadge.hidden = !segments.pendingCharges; chargeBadge.textContent = segments.pendingCharges || ""; }
  const usersBadge = $("#adNavUsersBadge");
  if (usersBadge) { usersBadge.hidden = !data.metrics?.users; usersBadge.textContent = Number(data.metrics?.users || 0).toLocaleString("pt-BR"); }
}

async function loadDashboard() { renderDashboardData(await request("dashboard")); }

async function loadDirectory(force = false) {
  if (!force && state.directory.length && Date.now() - state.directoryAt < 60000) { renderUsers(); return; }
  const data = await request("directory");
  state.directory = data.users || [];
  state.directoryAt = Date.now();
  for (const uid of [...state.selection]) if (!state.directory.some((user) => user.uid === uid)) state.selection.delete(uid);
  renderUsers();
  if (state.currentSection === "subscriptions") renderAccessTracking();
}

async function loadPlans() {
  const data = await request("plans");
  state.plans = data.plans || [];
  renderPlans();
  renderAccessForms();
}

async function loadConfig() {
  const data = await request("settings");
  state.config = data.config;
  renderConfig();
  renderPlans();
}

async function loadCharges() {
  const data = await request("charges");
  state.charges = data.charges || [];
  renderCharges();
}

async function loadIntegrations() {
  const data = await request("integrations");
  state.integrations = data;
  renderIntegrationRows(data, "#adIntegrationsPreview", true);
  renderIntegrationRows(data, "#adIntegrationsList");
  renderStripeStatus();
}

async function loadAdmins() {
  const data = await request("admins");
  state.admins = data.admins || [];
  state.isOwner = data.isOwner === true;
  renderAdmins();
}

function isTouchDevice() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

// Celular: o título da seção sai da barra do topo (que fica fixa e fina)
// e vai para o começo do conteúdo; no computador volta para o topo.
function placeHeading() {
  const heading = document.querySelector(".ad-topbar .ad-heading, .ad-main > .ad-heading");
  const topbar = document.querySelector(".ad-topbar");
  const main = document.querySelector(".ad-main");
  if (!heading || !topbar || !main || typeof main.insertBefore !== "function" || typeof topbar.querySelector !== "function") return;
  if (isCompact()) {
    if (heading.parentElement !== main) main.insertBefore(heading, main.firstChild);
  } else if (heading.parentElement !== topbar) {
    topbar.insertBefore(heading, topbar.querySelector(".ad-topbar-actions"));
  }
}

function syncMobileTabs() {
  const active = document.querySelector?.("#adMobileTabs .is-active");
  if (!active || !isCompact()) return;
  const bar = $("#adMobileTabs");
  if (!bar || typeof bar.scrollTo !== "function") return;
  const left = active.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2;
  bar.scrollTo?.({ left: Math.max(0, left), behavior: "smooth" });
}

function isCompact() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 820px)").matches;
}

async function showSection(section) {
  if (!SECTION_LABELS[section]) return;
  state.currentSection = section;
  const sequence = ++state.loadSequence;
  $("#adPageTitle").textContent = section === "overview" ? (isCompact() ? "Administração" : "Visão geral") : SECTION_LABELS[section];
  $("#adPageSubtitle").textContent = section === "overview" && isCompact() ? "Gerencie a operação do PulseNote." : SECTION_SUBTITLES[section];
  document.querySelectorAll(".pn-console-view").forEach((element) => element.classList.toggle("is-active", element.id === `pn-console-${section}`));
  document.querySelectorAll("[data-section]").forEach((button) => button.classList.toggle("is-active", button.dataset.section === section));
  closeMenu();
  syncMobileTabs();
  setLoadError();
  renderBulkBar();
  globalThis.scrollTo?.({ top: 0, behavior: "smooth" });
  const loads = {
    overview: [loadDashboard, loadDirectory, loadIntegrations, loadConfig],
    users: [loadPlans, loadDirectory],
    subscriptions: [loadPlans, loadConfig, loadDirectory],
    plans: [loadConfig, loadPlans],
    charges: [loadCharges, loadConfig, loadIntegrations, loadDirectory],
    features: [loadConfig],
    integrations: [loadIntegrations],
    security: [loadAdmins],
    settings: [loadConfig],
  };
  const results = await Promise.allSettled(loads[section].map((load) => load()));
  if (sequence !== state.loadSequence) return;
  if (section === "subscriptions") renderAccessTracking();
  const failed = results.find((result) => result.status === "rejected");
  if (failed) setLoadError(`Não foi possível carregar ${SECTION_LABELS[section].toLowerCase()}: ${errorText(failed.reason)}`);
}

// ── Eventos ──────────────────────────────────────────────────────────
// Painel estático, sem zoom de pinça (o Safari do iPhone ignora
// user-scalable=no do viewport). Toque duplo é resolvido no CSS.
function lockPageZoom() {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  const stop = (event) => event.preventDefault();
  ["gesturestart", "gesturechange", "gestureend"].forEach((type) => document.addEventListener(type, stop, { passive: false }));
  document.addEventListener("touchmove", (event) => {
    if (event.touches?.length > 1) event.preventDefault();
  }, { passive: false });
}

function bindNavigation() {
  lockPageZoom();
  $("#adMobileTabs").innerHTML = Object.entries(SECTION_LABELS).map(([key, label]) => `<button type="button" data-section="${key}"${key === (state.currentSection || "overview") ? ' class="is-active"' : ""}>${label}</button>`).join("");
  $("#adMobileTabs").setAttribute("role", "navigation");
  placeHeading();
  let resizeTimer = null;
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { placeHeading(); syncMobileTabs(); if (!isCompact()) closeMenu(); }, 120);
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (typeof target?.closest !== "function") return;
    const section = target.closest("[data-section]")?.dataset.section || target.closest("[data-go]")?.dataset.go;
    if (section) showSection(section);
    const segment = target.closest("[data-user-segment]")?.dataset.userSegment;
    if (segment) { state.userFilter = segment; state.userLimit = 30; showSection("users"); }
    const accessTab = target.closest("[data-access-tab]")?.dataset.accessTab;
    if (accessTab) {
      state.accessTab = accessTab;
      if (state.currentSection !== "subscriptions") showSection("subscriptions"); else renderAccessTracking();
    }
  });
  $("#adMenuButton").addEventListener("click", () => {
    const open = $("#pnRail").classList.toggle("is-open");
    $("#adMenuButton").setAttribute("aria-expanded", String(open));
    $("#adMenuButton").setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
    $("#adMenuBackdrop").hidden = !open;
  });
  $("#adMenuBackdrop").addEventListener("click", closeMenu);
  $("#adThemeButton").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "aurora" : "light"));
  $("#adSectionRetry").addEventListener("click", () => showSection(state.currentSection));
  $("#adRefreshButton")?.addEventListener("click", async () => { state.directoryAt = 0; await showSection(state.currentSection); toast("Dados atualizados."); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("#adCmd") && !$("#adCmd").hidden) { closeCommand(); return; }
    if ($("#adModal") && !$("#adModal").hidden) { closeModal(); return; }
    if ($("#adUserDrawer")?.classList.contains("is-open")) { closeUserDrawer(); return; }
    if ($("#adAuditDrawer")?.classList.contains("is-open")) { closeAuditDrawer(); return; }
    if ($("#pnRail").classList.contains("is-open")) { closeMenu(); $("#adMenuButton").focus(); }
  });
}

function bindActions() {
  // Busca e filtros de usuários
  $("#adUserEmail").addEventListener("input", (event) => { state.userSearch = event.target.value; state.userLimit = 30; renderUsers(); });
  $("#adUserSearch").addEventListener("submit", (event) => event.preventDefault());
  $("#adUserClear").addEventListener("click", () => { $("#adUserEmail").value = ""; state.userSearch = ""; renderUsers(); });
  $("#adUsersNext").addEventListener("click", () => { state.userLimit += 30; renderUsers(); });
  $("#adUserPlanFilter")?.addEventListener("change", (event) => { state.userPlanFilter = event.target.value; state.userLimit = 30; renderUsers(); });
  $("#adUserSort")?.addEventListener("change", (event) => { state.userSort = event.target.value; renderUsers(); });
  $("#adUsersExport")?.addEventListener("click", exportUsersCsv);
  $("#adUserFilters")?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-user-filter]");
    if (!button) return;
    state.userFilter = button.dataset.userFilter;
    state.userLimit = 30;
    renderUsers();
  });
  $("#adUsersList")?.addEventListener("change", (event) => {
    if (event.target.id === "adSelectAll") {
      const visible = filteredUsers().slice(0, state.userLimit);
      for (const user of visible) { if (event.target.checked) state.selection.add(user.uid); else state.selection.delete(user.uid); }
      renderUsers();
      return;
    }
    const uid = event.target.dataset?.selectUser;
    if (!uid) return;
    if (event.target.checked) state.selection.add(uid); else state.selection.delete(uid);
    event.target.closest(".ac-row")?.classList.toggle("is-selected", event.target.checked);
    renderBulkBar();
  });
  $("#adBulkClear")?.addEventListener("click", () => { state.selection.clear(); renderUsers(); });
  $("#adBulkBar")?.addEventListener("click", (event) => {
    const op = event.target.closest?.("[data-bulk]")?.dataset.bulk;
    if (!op) return;
    const uids = [...state.selection];
    if (op === "charge") openChargeModal(uids); else openAccessModal(op, uids);
  });

  // Visão geral
  $("#adAuditRefresh").addEventListener("click", async () => { try { await loadDashboard(); toast("Atividade atualizada."); } catch (error) { toast(errorText(error), true); } });
  $("#adAuditAll")?.addEventListener("click", openAuditDrawer);
  $("#adAuditDrawerClose")?.addEventListener("click", closeAuditDrawer);
  $("#adAuditSearch")?.addEventListener("input", renderAuditFull);
  $("#adGrowthRange")?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-range]");
    if (!button) return;
    state.growthRange = Number(button.dataset.range) || 30;
    for (const item of $$("[data-range]", event.currentTarget)) item.classList.toggle("is-active", item === button);
    renderGrowth();
  });
  if (typeof ResizeObserver === "function" && $("#adGrowthChart")) {
    let lastWidth = 0;
    new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (width && Math.abs(width - lastWidth) > 4 && state.dashboard) { lastWidth = width; renderGrowth(); }
    }).observe($("#adGrowthChart"));
  }
  $("#adOvTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-ov]");
    if (!button) return;
    for (const item of $$("[data-ov]", event.currentTarget)) {
      item.classList.toggle("is-active", item === button);
      item.setAttribute("aria-selected", String(item === button));
    }
    $("#adOvGrid").dataset.ovActive = button.dataset.ov;
  });
  $("#adKpis")?.addEventListener("scroll", (event) => {
    const el = event.currentTarget;
    const index = Math.round((el.scrollLeft / Math.max(1, el.scrollWidth - el.clientWidth)) * 2);
    for (const [dotIndex, dot] of $$("i", $("#adKpiDots")).entries()) dot.classList.toggle("is-on", dotIndex === index);
  }, { passive: true });
  $("#adModal")?.addEventListener("click", (event) => { if (event.target.closest?.("[data-modal-close]")) closeModal(); });

  // Cliques gerais (detalhes, ações individuais, cobranças, equipe)
  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (typeof target?.closest !== "function") return;
    const detail = target.closest("[data-user-detail]");
    if (detail && !target.closest("#adModal")) { openUserDrawer(detail.dataset.userDetail); return; }
    const userOp = target.closest("[data-user-op]");
    if (userOp && !userOp.disabled) {
      const uid = $("#adUserDrawer")?.dataset.uid;
      if (!uid) return;
      if (userOp.dataset.userOp === "charge") openChargeModal([uid]); else openAccessModal(userOp.dataset.userOp, [uid]);
      return;
    }
    const copyPay = target.closest("[data-copy-pay]");
    if (copyPay) { copyText(payLink(copyPay.dataset.copyPay), "Link de pagamento copiado."); return; }
    const quickExtend = target.closest("[data-quick-extend]");
    if (quickExtend) {
      quickExtend.disabled = true;
      try {
        await request("access-apply", { op: "extend", uids: [quickExtend.dataset.quickExtend], days: Number(quickExtend.dataset.days) || 7 });
        toast("Prazo estendido em 7 dias.");
        await loadDirectory(true);
        renderAccessTracking();
      } catch (error) { toast(errorText(error), true); quickExtend.disabled = false; }
      return;
    }
    const statusButton = target.closest('[data-action="status"]');
    if (statusButton) {
      const uid = statusButton.dataset.directUid;
      const disabled = statusButton.dataset.disabled === "true";
      const ok = await confirmDialog(disabled
        ? { title: "Desativar conta?", message: "A pessoa perde o acesso ao PulseNote (app e WhatsApp) até você reativar. Os dados não são apagados.", confirmLabel: "Desativar", danger: true }
        : { title: "Reativar conta?", message: "O acesso da pessoa volta imediatamente.", confirmLabel: "Reativar" });
      if (!ok) return;
      try { await request("user-update", { uid, disabled }); toast(disabled ? "Conta desativada." : "Conta reativada."); await refreshAfterChange(); } catch (error) { toast(errorText(error), true); }
      return;
    }
    const chargeButton = target.closest("[data-charge-status]");
    if (chargeButton) {
      const id = chargeButton.closest("[data-charge-id]")?.dataset.chargeId;
      const charge = state.charges.find((item) => item.id === id) || state.drawer.detail?.charges?.find((item) => item.id === id);
      if (!charge) return;
      const received = chargeButton.dataset.chargeStatus === "manual_received";
      const ok = await confirmDialog(received
        ? { title: "Marcar como recebida?", message: `Confirme que ${money(charge.amountCents)} de ${escapeHtml(charge.email || userLabelByUid(charge.uid))} caiu na sua conta.${charge.planId && charge.grantDays ? ` O plano será liberado por ${charge.grantDays} dias.` : ""}`, confirmLabel: "Marcar recebida" }
        : { title: "Cancelar cobrança?", message: "A cobrança some do app da pessoa.", confirmLabel: "Cancelar cobrança", danger: true });
      if (!ok) return;
      try {
        const result = await request("charge-update", { id, status: chargeButton.dataset.chargeStatus });
        toast(received ? (result.granted ? `Recebida. Plano liberado até ${shortDate(result.granted.validUntil)}.` : "Cobrança marcada como recebida.") : "Cobrança cancelada.");
        await Promise.allSettled([loadCharges(), loadDirectory(true)]);
        if (chargeButton.closest("#adUserDrawer") && state.drawer.uid) openUserDrawer(state.drawer.uid, { keepTab: true });
      } catch (error) { toast(errorText(error), true); }
      return;
    }
    const chargeFilter = target.closest("[data-charge-filter]");
    if (chargeFilter) { state.chargeFilter = chargeFilter.dataset.chargeFilter; renderCharges(); return; }
    const revokeAdmin = target.closest("[data-revoke-admin]");
    if (revokeAdmin) {
      const admin = state.admins.find((item) => item.uid === revokeAdmin.dataset.revokeAdmin);
      const ok = await confirmDialog({ title: "Remover do painel?", message: `${escapeHtml(admin?.email || "Esta pessoa")} perde o acesso ao painel na hora. A conta do PulseNote continua normal.`, confirmLabel: "Remover acesso", danger: true });
      if (!ok) return;
      try { await request("admin-role-set", { uid: revokeAdmin.dataset.revokeAdmin, enabled: false }); toast("Acesso ao painel removido."); await loadAdmins(); } catch (error) { toast(errorText(error), true); }
    }
  });

  document.addEventListener("change", async (event) => {
    const roleSelect = event.target.closest?.("[data-role-uid]");
    if (!roleSelect) return;
    const admin = state.admins.find((item) => item.uid === roleSelect.dataset.roleUid);
    const ok = await confirmDialog({ title: "Trocar papel?", message: `${escapeHtml(admin?.email || "")} passa a ser ${ROLE_INFO[roleSelect.value][0]} (${ROLE_INFO[roleSelect.value][1].toLowerCase()}). A pessoa precisará entrar de novo.`, confirmLabel: "Trocar papel" });
    if (!ok) { roleSelect.value = admin?.role || "admin"; return; }
    try { await request("admin-role-set", { uid: roleSelect.dataset.roleUid, enabled: true, role: roleSelect.value }); toast("Papel atualizado."); await loadAdmins(); } catch (error) { toast(errorText(error), true); await loadAdmins(); }
  });

  // Planos e cobranças
  $("#adNewPlan")?.addEventListener("click", () => startNewPlan(null));
  $("#adNewCharge")?.addEventListener("click", () => openChargeModal([]));
  $("#adChargeSearch")?.addEventListener("input", (event) => { state.chargeSearch = event.target.value; renderCharges(); });
  $("#adPaymentForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const data = await request("config-update", { payment: { pixKey: form.elements.pixKey.value, pixHolder: form.elements.pixHolder.value, instructions: form.elements.instructions.value } });
      state.config = data.config; renderConfig(); toast("Dados do Pix salvos.");
    } catch (error) { toast(errorText(error), true); }
  });

  // Acessos e testes
  $("#adTrialForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const enabled = form.elements.enabled.checked;
    if (enabled && !form.elements.planId.value) return toast("Escolha o plano do teste.", true);
    try {
      const data = await request("config-update", { trial: { enabled, planId: form.elements.planId.value, days: Number(form.elements.days.value) } });
      state.config = data.config; renderConfig(); toast(enabled ? "Teste automático ligado para novas contas." : "Teste automático desligado.");
    } catch (error) { toast(errorText(error), true); }
  });
  $("#adAccessPolicyForm")?.addEventListener("change", (event) => {
    if (event.target.name === "noPlan") event.currentTarget.elements.noPlanPlanId.disabled = event.target.value !== "plan";
  });
  $("#adAccessPolicyForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const noPlan = form.querySelector("input[name=noPlan]:checked")?.value || "full";
    const ok = await confirmDialog({ title: "Mudar a regra de quem está sem plano?", message: noPlan === "plan" ? "Quem não tem plano passa a ter só os recursos do plano gratuito escolhido — imediatamente." : "Quem não tem plano volta a ter acesso completo.", confirmLabel: "Aplicar regra" });
    if (!ok) return;
    try {
      const data = await request("config-update", { access: { noPlan, noPlanPlanId: form.elements.noPlanPlanId.value } });
      state.config = data.config; renderConfig(); toast("Regra atualizada.");
    } catch (error) { toast(errorText(error), true); }
  });

  // Recursos
  $("#adFeaturesForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const features = Object.fromEntries(Object.keys(FEATURE_LABELS).map((key) => [key, form.elements[key].checked]));
    const off = Object.keys(FEATURE_LABELS).filter((key) => state.config.features[key] && !features[key]);
    if (off.length) {
      const ok = await confirmDialog({ title: "Desligar para todos?", message: `${off.map((key) => FEATURE_LABELS[key][0]).join(", ")} deixa de funcionar para todos os usuários agora.`, confirmLabel: "Desligar", danger: true });
      if (!ok) return;
    }
    try { const data = await request("config-update", { features }); state.config = data.config; renderConfig(); toast("Recursos atualizados."); } catch (error) { toast(errorText(error), true); }
  });

  // Operação (manutenção)
  $("#adSettingsForm").addEventListener("input", renderMaintenancePreview);
  $("#adSettingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await saveMaintenance(state.config?.maintenance?.enabled === true); toast("Texto da manutenção salvo."); } catch (error) { toast(errorText(error), true); }
  });
  $("#adMaintOn")?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Tirar o app do ar?", message: "Todos os usuários (app e WhatsApp) passam a ver a mensagem de manutenção até você encerrar. Nenhum dado é apagado.", confirmLabel: "Ativar manutenção", danger: true });
    if (!ok) return;
    try { await saveMaintenance(true); toast("Manutenção ativada."); } catch (error) { toast(errorText(error), true); }
  });
  $("#adMaintOff")?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Encerrar manutenção?", message: "O PulseNote volta ao ar para todos imediatamente.", confirmLabel: "Encerrar manutenção" });
    if (!ok) return;
    try { await saveMaintenance(false); toast("Manutenção encerrada. App no ar."); } catch (error) { toast(errorText(error), true); }
  });

  // Equipe
  $("#adAdminForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = form.elements.email.value.trim().toLowerCase();
    const role = form.elements.role.value;
    const ok = await confirmDialog({ title: "Dar acesso ao painel?", message: `${escapeHtml(email)} entra como <strong>${ROLE_INFO[role][0]}</strong>: ${ROLE_INFO[role][1].toLowerCase()}.`, confirmLabel: "Dar acesso" });
    if (!ok) return;
    try { await request("admin-role-set", { email, enabled: true, role }); toast("Pessoa adicionada à equipe."); form.reset(); await loadAdmins(); } catch (error) { toast(errorText(error), true); }
  });
}

bindNavigation();
bindActions();
bindPlanStudio();
bindUserDrawer();
bindAuditDrawer();
bindCommandPalette();
bindQuickActions();
bindGrowthCrosshair();
if (isCompact()) {
  $("#adPageTitle").textContent = "Administração";
  $("#adPageSubtitle").textContent = "Gerencie a operação do PulseNote.";
}

async function handleAuthUser(user) {
  const sequence = ++state.authSequence;
  state.user = user;
  // A resposta de uma sessão anterior nunca deve reabrir o painel após logout
  // ou troca de conta enquanto a validação da nova sessão ainda está pendente.
  $(".ad-shell").classList.add("is-locked");
  $("#adContent").hidden = true;
  $("#adGate").hidden = false;
  closeMenu();
  if (!user) {
    $("#adAccount").textContent = "Não conectado";
    $("#adGate").innerHTML = `Entre no PulseNote para acessar a administração. <a href="/login?next=%2Fadmin">Entrar com sua conta</a>`;
    return;
  }
  $("#adAccount").textContent = "Verificando acesso";
  $("#adGate").textContent = "Verificando acesso administrativo…";
  try {
    await user.getIdToken(true);
    if (sequence !== state.authSequence || state.user !== user) return;
    const data = await request("dashboard");
    if (sequence !== state.authSequence || state.user !== user) return;
    const me = await request("me").catch(() => ({ role: "viewer", permissions: ["view"] }));
    if (sequence !== state.authSequence || state.user !== user) return;
    state.me = me;
    state.isOwner = me.isOwner === true;
    $(".ad-shell").classList.remove("is-locked");
    $("#adGate").hidden = true;
    $("#adContent").hidden = false;
    $("#adAccount").textContent = user.email || "Administrador";
    $("#adSession").textContent = "Acesso administrativo";
    $("#adAdminName").textContent = user.displayName || user.email || "Administrador";
    $("#adAdminAvatar").textContent = initials(user.displayName || user.email);
    $("#adAdminRole").textContent = ROLE_INFO[me.role]?.[0] || "Administrador";
    renderAdminWelcome(user);
    if ($("#adTopAvatar")) $("#adTopAvatar").textContent = initials(user.displayName || user.email);
    applyPermissions();
    renderDashboardData(data);
    const results = await Promise.allSettled([loadDirectory(), loadPlans(), loadIntegrations(), loadConfig(), loadAdmins()]);
    if (sequence !== state.authSequence || state.user !== user) return;
    const failed = results.find((result) => result.status === "rejected");
    if (failed) setLoadError(`Parte do painel não carregou: ${errorText(failed.reason)}`);
  } catch (error) {
    if (sequence !== state.authSequence || state.user !== user) return;
    $(".ad-shell").classList.add("is-locked");
    $("#adContent").hidden = true;
    $("#adGate").hidden = false;
    $("#adAccount").textContent = error.status === 403 ? (user.email || "Acesso não autorizado") : "Falha na verificação";
    $("#adGate").innerHTML = error.status === 403
      ? `Esta conta não tem permissão administrativa. <a href="/login?next=%2Fadmin&amp;switch=1">Entrar com outra conta</a> ou <a href="/app">voltar ao aplicativo</a>.`
      : `Não foi possível validar o acesso agora. <button type="button" id="adRetry">Tentar novamente</button>`;
    $("#adRetry")?.addEventListener("click", () => location.reload());
  }
}

if (PREVIEW) {
  document.documentElement.classList.add("ad-preview");
  import("./admin-preview.js").then((module) => { previewModule = module; handleAuthUser(module.previewUser); });
} else {
  onAuthStateChanged(auth, handleAuthUser);
}
