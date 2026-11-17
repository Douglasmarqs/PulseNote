import { auth } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

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
  overview: "Visão geral", users: "Usuários", subscriptions: "Acessos e testes", plans: "Planos", charges: "Cobranças",
  features: "Recursos", integrations: "Integrações", security: "Equipe e segurança", settings: "Operação",
};
const SECTION_SUBTITLES = {
  overview: "Usuários, planos, cobranças e a operação do PulseNote em um só lugar.",
  users: "Busque, selecione e gerencie o acesso de cada pessoa.",
  subscriptions: "Teste grátis, regra de quem está sem plano e prazos acabando.",
  plans: "Preços, recursos e quem pode ver cada oferta.",
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
  ["none", "Sem plano", "#7d88a8"],
  ["attention", "Vencidos ou pausados", "#e5484d"],
  ["disabled", "Desativados", "#4b5679"],
];
const USER_FILTERS = [
  ["all", "Todos"], ["plan", "Com plano"], ["trial", "Em teste"], ["none", "Sem plano"],
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
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === "minute") return formatter.format(Math.round(seconds / size), unit);
  }
  return "agora";
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
  element.textContent = message;
  element.classList.toggle("is-error", isError);
  element.hidden = false;
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

async function request(action, body, query = {}) {
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
function openModal({ kicker = "", title, body, actions = [], wide = false, onOpen }) {
  const modal = $("#adModal");
  $("#adModalKicker").textContent = kicker;
  $("#adModalTitle").textContent = title;
  $("#adModalBody").innerHTML = body;
  modal.classList.toggle("is-wide", wide);
  const foot = $("#adModalFoot");
  foot.innerHTML = actions.map((action, index) => `<button type="button" class="${action.kind === "primary" ? "ad-primary-button" : action.kind === "danger" ? "ad-primary-button is-danger" : "ad-subtle-button"}" data-modal-action="${index}">${action.label}</button>`).join("");
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
      kicker: "CONFIRMAÇÃO", title,
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
  root.innerHTML = alerts.map(([tone, iconName, text, label, attr]) => `<div class="ac-alert ${tone}">${icon(iconName)}<span>${escapeHtml(text)}</span><button type="button" class="ac-alert-btn" ${attr}>${escapeHtml(label)} ${icon("arrow-right")}</button></div>`).join("");
  root.hidden = !alerts.length;
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

function renderOperations(metrics) {
  $("#adOperationsSummary").innerHTML = [
    ["✦", metrics.usersWithSavedChanges30d ?? 0, "usuários com atividade"],
    ["◉", metrics.whatsappReceived30d ?? 0, "mensagens no WhatsApp"],
    ["⌁", metrics.reminderDeliveriesAccepted30d ?? 0, "lembretes aceitos"],
  ].map(([symbol, value, label]) => `<div class="ad-operation"><span aria-hidden="true">${symbol}</span><div><strong>${Number(value).toLocaleString("pt-BR")}</strong><small>${label} nos últimos 30 dias</small></div></div>`).join("");
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
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="ad-growth-svg"><defs><linearGradient id="adGrowthFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee" stop-opacity=".32"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></linearGradient><linearGradient id="adGrowthLine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f80ff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><g class="ad-grid">${grid}</g><path d="${line} L${lx.toFixed(1)} ${height - pad.bottom} L${pad.left} ${height - pad.bottom} Z" fill="url(#adGrowthFill)"/><path d="${line}" fill="none" stroke="url(#adGrowthLine)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/><g class="ad-axis">${labels}</g></svg><span class="ad-growth-dot" style="left:${((lx / width) * 100).toFixed(2)}%;top:${((ly / height) * 100).toFixed(2)}%"></span><span class="ad-growth-tip" style="left:${((lx / width) * 100).toFixed(2)}%;top:${((ly / height) * 100).toFixed(2)}%">${last.toLocaleString("pt-BR")}</span>`;
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

function renderAuditFull() {
  const list = $("#adAuditFull");
  if (!list) return;
  const query = String($("#adAuditSearch")?.value || "").trim().toLowerCase();
  const events = state.audit.filter((event) => !query || [AUDIT_LABELS[event.action]?.[0], event.action, event.actorEmail, event.details?.email, event.target].some((value) => String(value || "").toLowerCase().includes(query)));
  list.innerHTML = events.length ? events.map(auditRow).join("") : `<div class="ad-empty">Nenhuma ação encontrada.</div>`;
}

async function openAuditDrawer() {
  const drawer = $("#adAuditDrawer");
  const list = $("#adAuditFull");
  if (!drawer || !list) return;
  list.innerHTML = `<div class="ad-empty">Carregando…</div>`;
  if (drawer.parentElement !== document.body && document.body) document.body.appendChild(drawer);
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  try {
    const data = await request("audit");
    state.audit = data.events || [];
    renderAuditFull();
  } catch (error) {
    list.innerHTML = `<div class="ad-empty">Não foi possível carregar a auditoria: ${escapeHtml(errorText(error))}</div>`;
  }
}

function closeAuditDrawer() {
  $("#adAuditDrawer")?.classList.remove("is-open");
  $("#adAuditDrawer")?.setAttribute("aria-hidden", "true");
}

function renderIntegrationRows(data, selector, compact = false) {
  const symbols = { firebase: "◆", whatsapp: "◉", gemini: "✦", qstash: "▣", stripe: "$", "ai-gateway": "✧" };
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
    return `<div class="ad-integration"><span class="ad-integration-icon" aria-hidden="true">${symbols[item.id] || "◇"}</span><span class="ad-integration-content"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(detail)}</small></span><span class="ad-pill ${item.configured ? "" : "is-warn"}">${item.configured ? "Configurado" : "Pendente"}</span></div>`;
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
    default: return ["is-muted", "Sem plano"];
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

function userRowHtml(user, { selectable = true, compact = false } = {}) {
  const [tone, label] = statusInfo(user);
  const checked = state.selection.has(user.uid);
  const access = user.lastActiveAt || user.lastSignInAt;
  return `<div class="ac-row ${checked ? "is-selected" : ""}" role="row" data-uid="${escapeHtml(user.uid)}">
    ${selectable ? `<label class="ac-cell ac-check" role="cell"><input type="checkbox" data-select-user="${escapeHtml(user.uid)}" ${checked ? "checked" : ""} aria-label="Selecionar ${escapeHtml(user.email || user.uid)}" /></label>` : ""}
    <button type="button" class="ac-cell ac-usercell" role="cell" data-user-detail="${escapeHtml(user.uid)}">${avatarHtml(user)}<span><strong>${escapeHtml(user.displayName || user.email || "Sem nome")}${user.admin ? ` <em class="ac-tag">Equipe</em>` : ""}</strong><small>${escapeHtml(user.email || user.uid)}</small></span></button>
    <span class="ac-cell" role="cell" data-label="Plano">${user.planName ? `<span class="ac-chip">${escapeHtml(user.planName)}</span>` : `<span class="ac-chip is-muted">—</span>`}</span>
    <span class="ac-cell" role="cell" data-label="Situação"><span class="ac-status ${tone}"><i></i>${escapeHtml(label)}</span></span>
    <span class="ac-cell ac-muted" role="cell" data-label="Último acesso" title="${escapeHtml(readableTimestamp(access))}">${escapeHtml(relativeTime(access))}</span>
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
    ? `<div class="ac-row ac-head" role="row"><label class="ac-cell ac-check" role="columnheader"><input type="checkbox" id="adSelectAll" ${allVisibleSelected ? "checked" : ""} aria-label="Selecionar todos os exibidos" /></label><span class="ac-cell" role="columnheader">Usuário</span><span class="ac-cell" role="columnheader">Plano</span><span class="ac-cell" role="columnheader">Situação</span><span class="ac-cell" role="columnheader">Último acesso</span><span class="ac-cell" role="columnheader">Cobrança</span><span class="ac-cell" role="columnheader"></span></div>${visible.map((user) => userRowHtml(user)).join("")}`
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

// ── Gaveta do usuário ────────────────────────────────────────────────
async function openUserDrawer(uid) {
  const user = state.directory.find((item) => item.uid === uid);
  if (!user) return;
  const drawer = $("#adUserDrawer");
  renderUserDrawer(user, null);
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  drawer.dataset.uid = uid;
  try {
    const detail = await request("user-detail", undefined, { uid });
    if (drawer.dataset.uid === uid) renderUserDrawer(user, detail);
  } catch (error) {
    if (drawer.dataset.uid === uid) $("#adDrawerDetail").innerHTML = `<div class="ad-empty">Não foi possível carregar os detalhes: ${escapeHtml(errorText(error))}</div>`;
  }
}

function renderUserDrawer(user, detail) {
  const [tone, label] = statusInfo(user);
  const entitlement = detail?.entitlement;
  const activity = detail?.activity || {};
  const sourceLabel = { manual: "Atribuído pela equipe", trial: "Teste grátis", stripe: "Assinatura Stripe", charge: "Cobrança paga" };
  const quick = [
    ["assign", "layers", user.planId ? "Trocar plano" : "Atribuir plano", "users.access"],
    ["trial", "gift", "Dar teste", "users.access"],
    ["extend", "hourglass", "Estender prazo", "users.access", !user.planId],
    [user.status === "paused" ? "resume" : "pause", user.status === "paused" ? "play" : "pause", user.status === "paused" ? "Retomar" : "Pausar", "users.access", !user.planId],
    ["charge", "receipt", "Cobrar", "charges.manage"],
    ["remove", "trash", "Remover plano", "users.access", !user.planId],
  ].filter(([, , , permission]) => can(permission));
  const stat = (name, value) => `<div class="ad-detail-stat"><strong>${Number(value || 0).toLocaleString("pt-BR")}</strong><span>${name}</span></div>`;
  const charges = detail?.charges || [];
  $("#adUserDrawerContent").innerHTML = `
    <div class="ac-drawer-head">${avatarHtml(user, "is-lg")}<div><h2 id="adUserDrawerTitle">${escapeHtml(user.displayName || user.email || "Usuário")}</h2><p>${escapeHtml(user.email || user.uid)}</p><div class="ac-drawer-chips"><span class="ac-status ${tone}"><i></i>${escapeHtml(label)}</span>${user.planName ? `<span class="ac-chip">${escapeHtml(user.planName)}</span>` : ""}${user.admin ? `<span class="ac-chip">Equipe</span>` : ""}</div></div></div>
    ${quick.length ? `<div class="ac-quick">${quick.map(([op, iconName, text, , disabled]) => `<button type="button" class="ac-quick-btn ${op === "remove" ? "is-danger" : ""}" data-user-op="${op}" ${disabled ? "disabled" : ""}>${icon(iconName)}<span>${escapeHtml(text)}</span></button>`).join("")}</div>` : ""}
    <section><h3>Acesso</h3><dl class="ad-detail-list">
      <div><dt>Plano</dt><dd>${escapeHtml(user.planName || "Sem plano (segue a regra padrão)")}</dd></div>
      <div><dt>Situação</dt><dd>${escapeHtml(label)}</dd></div>
      <div><dt>Válido até</dt><dd>${user.validUntil ? `${escapeHtml(readableDate(user.validUntil))}${Number.isInteger(user.daysLeft) ? ` <small>(${user.daysLeft >= 0 ? `faltam ${plural(user.daysLeft, "dia", "dias")}` : `venceu há ${plural(-user.daysLeft, "dia", "dias")}`})</small>` : ""}` : user.planId ? "Sem data de fim" : "—"}</dd></div>
      <div><dt>Origem</dt><dd>${escapeHtml(sourceLabel[entitlement?.source || user.source] || "—")}</dd></div>
    </dl></section>
    <div id="adDrawerDetail">${detail ? `
      <section><h3>Cobranças</h3>${charges.length ? `<div class="ac-mini-list">${charges.map((charge) => `<div class="ac-mini-row"><span><strong>${money(charge.amountCents)}</strong><small>${escapeHtml(charge.note || "Cobrança")}${charge.dueDate ? ` · vence ${escapeHtml(shortDate(charge.dueDate))}` : ""}</small></span>${chargeStatusChip(charge)}${charge.status === "manual_pending" ? `<button type="button" class="ac-icon-btn" data-copy-pay="${escapeHtml(charge.id)}" title="Copiar link de pagamento" aria-label="Copiar link de pagamento">${icon("copy")}</button>` : ""}</div>`).join("")}</div>` : `<p class="ac-muted">Nenhuma cobrança para esta conta.</p>`}</section>
      <section><h3>Uso (totais)</h3><div class="ad-detail-grid">${stat("Tarefas", activity.tasks)}${stat("Notas", activity.notes)}${stat("Compromissos", activity.events)}${stat("Metas", activity.goals)}${stat("Lançamentos", activity.finances)}${stat("Conversas IA hoje", detail.aiToday)}</div><p class="ad-data-note">Só totais. O conteúdo pessoal continua privado.</p></section>
      <section><h3>Canais</h3><div class="ad-channel-list"><span class="${detail.whatsappLinked ? "is-on" : ""}"><i></i>WhatsApp ${detail.whatsappLinked ? "vinculado" : "não vinculado"}</span><span class="${detail.whatsappReminderEnabled ? "is-on" : ""}"><i></i>Lembretes no WhatsApp</span><span class="${detail.pushEnabled ? "is-on" : ""}"><i></i>Notificações push</span></div></section>
      <section><h3>Conta</h3><dl class="ad-detail-list"><div><dt>Criada em</dt><dd>${escapeHtml(readableTimestamp(user.createdAt))}</dd></div><div><dt>Último uso do app</dt><dd>${escapeHtml(readableTimestamp(detail.lastActiveAt || user.lastActiveAt))}${detail.lastArea ? ` <small>· ${escapeHtml(AREA_LABELS[detail.lastArea] || detail.lastArea)}</small>` : ""}</dd></div><div><dt>Último login</dt><dd>${escapeHtml(readableTimestamp(user.lastSignInAt))}</dd></div><div><dt>Entrada</dt><dd>${user.provider === "google" ? "Google" : "E-mail e senha"}${user.emailVerified ? " · e-mail confirmado" : " · e-mail não confirmado"}</dd></div></dl></section>
      ${can("users.status") && !user.admin ? `<div class="ad-drawer-actions"><button class="ad-subtle-button ${user.disabled ? "" : "is-danger-text"}" type="button" data-action="status" data-disabled="${!user.disabled}" data-direct-uid="${escapeHtml(user.uid)}">${user.disabled ? "Reativar conta" : "Desativar conta"}</button></div>` : ""}
    ` : `<div class="ac-skeleton"><i></i><i></i><i></i></div>`}</div>`;
}

function closeUserDrawer() {
  const drawer = $("#adUserDrawer");
  drawer?.classList.remove("is-open");
  drawer?.setAttribute("aria-hidden", "true");
  if (drawer) delete drawer.dataset.uid;
}

// ── Ações de acesso (individual ou em lote) ──────────────────────────
function planOptions(selected = "", { includePrivate = true, placeholder = "Escolha um plano" } = {}) {
  const plans = state.plans.filter((plan) => plan.active !== false && (includePrivate || plan.visibility !== "private"));
  return `<option value="">${escapeHtml(placeholder)}</option>${plans.map((plan) => `<option value="${escapeHtml(plan.id)}" ${plan.id === selected ? "selected" : ""}>${escapeHtml(plan.name)} · ${plan.priceCents ? money(plan.priceCents) : "grátis"}${plan.visibility === "private" ? " · privado" : ""}</option>`).join("")}`;
}

function whoLabel(uids) {
  if (uids.length === 1) {
    const user = state.directory.find((item) => item.uid === uids[0]);
    return escapeHtml(user?.email || user?.displayName || "esta conta");
  }
  return `${uids.length.toLocaleString("pt-BR")} pessoas`;
}

const ACCESS_COPY = {
  assign: ["ATRIBUIR PLANO", "Atribuir plano", "Atribuir"],
  trial: ["TESTE GRÁTIS", "Dar teste grátis", "Dar teste"],
  extend: ["PRAZO", "Estender prazo", "Estender"],
  pause: ["PAUSAR", "Pausar acesso", "Pausar"],
  resume: ["RETOMAR", "Retomar acesso", "Retomar"],
  remove: ["REMOVER", "Remover plano", "Remover plano"],
};

function dayChips(name, values, selected) {
  return `<div class="ac-daychips" role="group">${values.map((value) => `<label><input type="radio" name="${name}" value="${value}" ${value === selected ? "checked" : ""} /><span>${value === 365 ? "1 ano" : `${value} dias`}</span></label>`).join("")}<label class="ac-daychips-custom"><input type="radio" name="${name}" value="custom" /><span>Outro</span><input type="number" min="1" max="730" step="1" name="${name}Custom" placeholder="dias" aria-label="Quantidade de dias" /></label></div>`;
}

function readDays(body, name) {
  const choice = body.querySelector(`input[name="${name}"]:checked`)?.value;
  return choice === "custom" ? Number(body.querySelector(`input[name="${name}Custom"]`)?.value) : Number(choice);
}

function openAccessModal(op, uids) {
  if (!uids.length) return toast("Selecione ao menos uma pessoa.", true);
  const [kicker, title, confirmLabel] = ACCESS_COPY[op];
  const users = uids.map((uid) => state.directory.find((item) => item.uid === uid)).filter(Boolean);
  const stripeCount = users.filter((user) => user.source === "stripe").length;
  const withoutPlan = users.filter((user) => !user.planId).length;
  let body = `<p class="ac-modal-who">Para <strong>${whoLabel(uids)}</strong></p>`;
  if (op === "assign") body += `<label class="ac-field">Plano<select name="planId">${planOptions(users.length === 1 ? users[0].planId || "" : "")}</select></label>
    <fieldset class="ac-field"><legend>Duração</legend><label class="ac-radio-inline"><input type="radio" name="until" value="none" checked /> Sem data de fim</label><label class="ac-radio-inline"><input type="radio" name="until" value="date" /> Até <input type="date" name="validUntil" min="${todayIso()}" /></label></fieldset>
    <p class="ac-hint">${icon("info")}O acesso muda na hora. Use "Cobrar" se quiser que a pessoa pague por este plano.</p>`;
  if (op === "trial") body += `<label class="ac-field">Plano do teste<select name="planId">${planOptions(state.config?.trial?.planId || "")}</select></label><div class="ac-field"><span class="ac-label">Duração</span>${dayChips("days", [7, 14, 30], 7)}</div>
    <p class="ac-hint">${icon("info")}Quando o teste acabar, a pessoa volta para a regra de quem está sem plano — automaticamente.</p>`;
  if (op === "extend") body += `<div class="ac-field"><span class="ac-label">Adicionar</span>${dayChips("days", [7, 30, 90, 365], 30)}</div>
    <p class="ac-hint">${icon("info")}Soma ao prazo atual (ou a partir de hoje, se já venceu).${withoutPlan ? ` ${plural(withoutPlan, "pessoa sem plano será ignorada", "pessoas sem plano serão ignoradas")}.` : ""}</p>`;
  if (op === "pause") body += `<p class="ac-confirm-text">Os recursos do plano ficam bloqueados até você retomar. Nada é apagado.</p>`;
  if (op === "resume") body += `<p class="ac-confirm-text">O plano volta a valer imediatamente.</p>`;
  if (op === "remove") body += `<p class="ac-confirm-text">A pessoa volta para a regra de quem está sem plano (${state.config?.access?.noPlan === "plan" ? `plano gratuito "${escapeHtml(state.plans.find((plan) => plan.id === state.config.access.noPlanPlanId)?.name || state.config.access.noPlanPlanId)}"` : "acesso completo"}).</p>`;
  if (stripeCount && ["remove", "pause", "assign"].includes(op)) body += `<p class="ac-warn">${icon("alert")}${plural(stripeCount, "pessoa paga", "pessoas pagam")} pelo Stripe. Isso não cancela a assinatura lá — cancele também no painel do Stripe para parar a cobrança.</p>`;
  openModal({
    kicker, title, body,
    actions: [
      { label: "Cancelar" },
      { label: confirmLabel, kind: op === "remove" ? "danger" : "primary", busy: "Aplicando…", onClick: async () => {
        const form = $("#adModalBody");
        const payload = { op, uids };
        if (op === "assign" || op === "trial") {
          payload.planId = form.querySelector("select[name=planId]").value;
          if (!payload.planId) { toast("Escolha um plano.", true); return true; }
        }
        if (op === "assign" && form.querySelector("input[name=until]:checked")?.value === "date") {
          payload.validUntil = form.querySelector("input[name=validUntil]").value;
          if (!payload.validUntil) { toast("Escolha a data de fim.", true); return true; }
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
  });
}

async function refreshAfterChange() {
  await Promise.allSettled([loadDirectory(true), state.currentSection === "overview" ? loadDashboard() : null, state.currentSection === "plans" ? loadPlans() : null]);
  const drawer = $("#adUserDrawer");
  if (drawer?.classList.contains("is-open") && drawer.dataset.uid) openUserDrawer(drawer.dataset.uid);
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
  const body = `${initialUids.length ? `<p class="ac-modal-who">Para <strong>${whoLabel(initialUids)}</strong></p>` : userPickerHtml()}
    <div class="ac-seg" role="radiogroup" aria-label="Tipo de cobrança"><label><input type="radio" name="kind" value="plan" checked /><span>${icon("layers")}Plano</span></label><label><input type="radio" name="kind" value="custom" /><span>${icon("receipt")}Valor avulso</span></label></div>
    <div data-kind="plan" class="ac-kind"><label class="ac-field">Plano<select name="planId">${planOptions("", { placeholder: "Escolha o plano a cobrar" })}</select></label><div class="ad-form-row"><label class="ac-field">Valor (R$)<input name="planAmount" inputmode="decimal" placeholder="preço do plano" /></label><label class="ac-field">Libera quantos dias<input name="grantDays" type="number" min="1" max="730" step="1" placeholder="30" /></label></div><p class="ac-hint">${icon("info")}Quando a cobrança for paga, o plano é liberado (ou estendido) automaticamente por esse número de dias.</p></div>
    <div data-kind="custom" class="ac-kind" hidden><label class="ac-field">Valor (R$)<input name="amount" inputmode="decimal" placeholder="0,00" /></label></div>
    <div class="ad-form-row"><label class="ac-field">Descrição<input name="note" maxlength="300" placeholder="Ex.: Plano Pro · dezembro" /></label><label class="ac-field">Vencimento<input name="dueDate" type="date" min="${todayIso()}" /></label></div>
    <p class="ac-summary" id="adChargeSummary"></p>`;
  openModal({
    kicker: "NOVA COBRANÇA", title: "Cobrar", body, wide: !initialUids.length,
    actions: [
      { label: "Cancelar" },
      { label: "Criar cobrança", kind: "primary", busy: "Criando…", onClick: async () => {
        const form = $("#adModalBody");
        const uids = [...picked];
        if (!uids.length) { toast("Escolha quem vai receber a cobrança.", true); return true; }
        const kind = form.querySelector("input[name=kind]:checked").value;
        const payload = { uids, requestId, note: form.querySelector("input[name=note]").value.trim(), dueDate: form.querySelector("input[name=dueDate]").value || null };
        if (kind === "plan") {
          payload.planId = form.querySelector("select[name=planId]").value;
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
        const plan = state.plans.find((item) => item.id === modalBody.querySelector("select[name=planId]").value);
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
    kicker: "PRONTO", title: `${plural(created.length, "cobrança criada", "cobranças criadas")}`,
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

// ── Planos ───────────────────────────────────────────────────────────
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

function renderPlans() {
  const root = $("#adPlansList");
  if (!root) return;
  root.innerHTML = state.plans.length ? state.plans.map((plan) => {
    const enabled = Object.keys(FEATURE_LABELS).filter((key) => planFeatureEnabled(plan, key));
    const subs = plan.subscribers || { active: 0, trial: 0 };
    const isDefault = state.config?.access?.noPlan === "plan" && state.config.access.noPlanPlanId === plan.id;
    const isTrial = state.config?.trial?.enabled && state.config.trial.planId === plan.id;
    return `<article class="ac-plan ${plan.active === false ? "is-inactive" : ""}">
      <header><div><h3>${escapeHtml(plan.name)}</h3><small>${escapeHtml(plan.id)}</small></div><div class="ac-plan-pills"><span class="ac-chip ${plan.visibility === "private" ? "is-muted" : "is-on"}">${icon(plan.visibility === "private" ? "lock" : "eye")}${plan.visibility === "private" ? "Privado" : "Público"}</span>${plan.active === false ? `<span class="ac-chip is-off">Inativo</span>` : ""}</div></header>
      <div class="ac-plan-price"><strong>${plan.priceCents ? money(plan.priceCents) : "Grátis"}</strong>${plan.priceCents ? `<small>/${plan.billingInterval === "year" ? "ano" : "mês"}</small>` : ""}</div>
      <p>${escapeHtml(plan.description || "Sem descrição.")}</p>
      <div class="ac-plan-stats"><span><strong>${subs.active}</strong> ativos</span><span><strong>${subs.trial}</strong> em teste</span></div>
      <ul class="ac-plan-features">${enabled.slice(0, 5).map((key) => `<li>${icon("check")}${escapeHtml(FEATURE_LABELS[key][0])}</li>`).join("")}${enabled.length > 5 ? `<li class="ac-muted">+${enabled.length - 5} recursos</li>` : ""}${!enabled.length ? `<li class="ac-muted">Só o essencial (planner, notas, finanças)</li>` : ""}</ul>
      <div class="ac-plan-meta"><span>${aiLimitLabel(plan)}</span><span>${plan.stripePriceId ? "Checkout Stripe" : "Sem checkout"}</span>${isDefault ? "<span>Plano dos sem plano</span>" : ""}${isTrial ? "<span>Plano do teste</span>" : ""}</div>
      ${can("plans.manage") ? `<button type="button" class="ad-outline-button" data-edit-plan="${escapeHtml(plan.id)}">Editar</button>` : ""}
    </article>`;
  }).join("") : `<div class="ad-empty">Nenhum plano criado ainda. Crie o primeiro em "Novo plano".</div>`;
  const filter = $("#adUserPlanFilter");
  if (filter) filter.innerHTML = `<option value="">Todos os planos</option>${state.plans.map((plan) => `<option value="${escapeHtml(plan.id)}" ${state.userPlanFilter === plan.id ? "selected" : ""}>${escapeHtml(plan.name)}</option>`).join("")}`;
}

function openPlanModal(plan = null) {
  const value = (key, fallback = "") => escapeHtml(plan?.[key] ?? fallback);
  const features = FEATURE_GROUPS.map(([group, keys]) => `<fieldset class="ac-feature-group"><legend>${escapeHtml(group)}</legend>${keys.map((key) => `<label class="ac-switch ac-switch--row"><input type="checkbox" name="feature-${key}" ${plan ? (planFeatureEnabled(plan, key) ? "checked" : "") : "checked"} /><span class="ac-switch-ui" aria-hidden="true"></span><span><strong>${escapeHtml(FEATURE_LABELS[key][0])}</strong><small>${escapeHtml(FEATURE_LABELS[key][1])}</small></span></label>`).join("")}</fieldset>`).join("");
  openModal({
    kicker: plan ? "EDITAR PLANO" : "NOVO PLANO", title: plan ? plan.name : "Criar plano", wide: true,
    body: `<div class="ad-form-row"><label class="ac-field">Nome<input name="name" maxlength="80" value="${value("name")}" placeholder="Pro" /></label><label class="ac-field">Identificador<input name="id" maxlength="40" value="${value("id")}" placeholder="pro" ${plan ? "readonly" : ""} pattern="[a-z0-9_-]{2,40}" /></label></div>
      <label class="ac-field">Descrição<textarea name="description" maxlength="300" rows="2" placeholder="O que este plano entrega">${value("description")}</textarea></label>
      <div class="ad-form-row"><label class="ac-field">Preço (R$)<input name="price" inputmode="decimal" value="${plan?.priceCents ? (plan.priceCents / 100).toFixed(2).replace(".", ",") : ""}" placeholder="0,00 = grátis" /></label><label class="ac-field">Ciclo<select name="billingInterval"><option value="month">Mensal</option><option value="year" ${plan?.billingInterval === "year" ? "selected" : ""}>Anual</option></select></label></div>
      <div class="ad-form-row"><label class="ac-field">Quem vê<select name="visibility"><option value="public">Público — aparece para assinar</option><option value="private" ${plan?.visibility === "private" ? "selected" : ""}>Privado — só a equipe atribui</option></select></label><label class="ac-field">Conversas com IA por dia<input name="aiDailyLimit" type="number" min="0" max="5000" step="1" value="${Number.isInteger(plan?.aiDailyLimit) ? plan.aiDailyLimit : ""}" placeholder="padrão (10 grátis · 200 pago)" /></label></div>
      <label class="ac-field">Stripe Price ID (opcional)<input name="stripePriceId" maxlength="128" value="${value("stripePriceId")}" placeholder="price_... — ativa o botão Assinar no app" autocomplete="off" /></label>
      <div class="ad-core-features"><strong>Sempre incluído</strong><span>Planner e tarefas</span><span>Notas</span><span>Finanças</span><span>Metas</span></div>
      ${features}
      <label class="ac-switch ac-switch--row"><input type="checkbox" name="active" ${plan?.active === false ? "" : "checked"} /><span class="ac-switch-ui" aria-hidden="true"></span><span><strong>Plano ativo</strong><small>Desativado, ninguém novo recebe e quem tem perde os recursos.</small></span></label>`,
    actions: [
      { label: "Cancelar" },
      { label: "Salvar plano", kind: "primary", busy: "Salvando…", onClick: async () => {
        const form = $("#adModalBody");
        const field = (name) => form.querySelector(`[name="${name}"]`);
        const id = String(field("id").value || field("name").value).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        const priceCents = parseMoney(field("price").value);
        if (!field("name").value.trim() || id.length < 2) { toast("Dê um nome ao plano.", true); return true; }
        if (Number.isNaN(priceCents)) { toast("Preço inválido (use até duas casas decimais).", true); return true; }
        const aiRaw = field("aiDailyLimit").value.trim();
        const features = Object.fromEntries(Object.keys(FEATURE_LABELS).map((key) => [key, field(`feature-${key}`).checked]));
        if (aiRaw !== "" && (!Number.isInteger(Number(aiRaw)) || Number(aiRaw) < 0 || Number(aiRaw) > 5000)) { toast("Conversas com IA: número de 0 a 5000.", true); return true; }
        // Lê tudo antes de qualquer confirmação (a confirmação usa o mesmo modal).
        const payload = { id, name: field("name").value, description: field("description").value, priceCents,
          billingInterval: field("billingInterval").value, visibility: field("visibility").value, stripePriceId: field("stripePriceId").value.trim(),
          aiDailyLimit: aiRaw === "" ? null : Number(aiRaw), active: field("active").checked, features };
        const changedAccess = plan && ((plan.active !== false) !== payload.active || Object.keys(FEATURE_LABELS).some((key) => planFeatureEnabled(plan, key) !== features[key]));
        if (changedAccess && (plan.subscribers?.active || plan.subscribers?.trial)) {
          const ok = await confirmDialog({ title: "Alterar recursos do plano?", message: `Isso muda o acesso de ${plural((plan.subscribers.active || 0) + (plan.subscribers.trial || 0), "pessoa", "pessoas")} imediatamente.`, confirmLabel: "Salvar mesmo assim" });
          if (!ok) return false;
        }
        await request("plan-save", payload);
        toast("Plano salvo.");
        await loadPlans();
        return false;
      } },
    ],
    onOpen: (body) => {
      if (plan) return null;
      const name = body.querySelector("[name=name]");
      const id = body.querySelector("[name=id]");
      name.addEventListener("input", () => { if (!id.dataset.touched) id.value = name.value.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); });
      id.addEventListener("input", () => { id.dataset.touched = "1"; });
      return null;
    },
  });
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
  $("#adPageTitle").textContent = section === "overview" ? (isCompact() ? "Administração" : "Administração do PulseNote") : SECTION_LABELS[section];
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
  $("#adUserDrawerClose")?.addEventListener("click", closeUserDrawer);
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
    const editPlan = target.closest("[data-edit-plan]");
    if (editPlan) { openPlanModal(state.plans.find((plan) => plan.id === editPlan.dataset.editPlan)); return; }
    const chargeButton = target.closest("[data-charge-status]");
    if (chargeButton) {
      const id = chargeButton.closest("[data-charge-id]")?.dataset.chargeId;
      const charge = state.charges.find((item) => item.id === id);
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
  $("#adNewPlan")?.addEventListener("click", () => openPlanModal(null));
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
if (isCompact()) {
  $("#adPageTitle").textContent = "Administração";
  $("#adPageSubtitle").textContent = "Gerencie a operação do PulseNote.";
}

onAuthStateChanged(auth, async (user) => {
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
});
