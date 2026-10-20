import { auth } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const FEATURE_LABELS = {
  whatsapp: ["WhatsApp", "Comandos, lançamentos e consultas por mensagem"],
  aiParsing: ["Interpretação com IA", "Reconhecimento inteligente de texto"],
  reminders: ["Lembretes", "Agendamento de notificações e avisos"],
  autopilot: ["Pulse Autopilot", "Sugestões úteis com confirmação do usuário"],
};
const SECTION_LABELS = {
  overview: "Visão geral", users: "Usuários", plans: "Planos", subscriptions: "Assinaturas", charges: "Cobranças",
  features: "Recursos", integrations: "Integrações", security: "Segurança", settings: "Configurações",
};
const SECTION_SUBTITLES = {
  overview: "Gerencie usuários, planos, cobranças e a operação do PulseNote.",
  users: "Pesquise contas, controle acesso e atribua planos.",
  plans: "Defina preços e recursos disponíveis em cada oferta.",
  subscriptions: "Acompanhe concessões manuais e assinaturas do provedor.",
  charges: "Monitore pagamentos e registros financeiros administrativos.",
  features: "Ative ou suspenda recursos globais do produto.",
  integrations: "Acompanhe credenciais, eventos e saúde dos serviços.",
  security: "Gerencie administradores e revise o acesso privilegiado.",
  settings: "Controle manutenção e configurações operacionais.",
};
const state = { user: null, config: null, plans: [], users: [], admins: [], usersNextPageToken: null, currentSection: "overview", loadSequence: 0, authSequence: 0, isOwner: false };
const $ = (selector) => document.querySelector(selector);

function applyTheme(choice = globalThis.localStorage?.getItem("pulsenote-theme") || "aurora") {
  const normalized = choice === "light" ? "light" : choice === "eclipse" ? "eclipse" : "aurora";
  document.documentElement?.setAttribute("data-theme", normalized);
  globalThis.localStorage?.setItem("pulsenote-theme", normalized);
  $("#adThemeButton")?.setAttribute("aria-label", normalized === "light" ? "Ativar tema escuro" : "Ativar tema claro");
  if ($("#adThemeButton")) $("#adThemeButton").textContent = normalized === "light" ? "☾" : "☼";
}

applyTheme();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function toast(message, isError = false) {
  const element = $("#adToast");
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

function readableDate(value) {
  if (!value) return "—";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function readableTimestamp(value) {
  if (!value) return "nenhuma atividade registrada";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "data indisponível" : new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function renderAdminWelcome(user = state.user) {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false,
  }).format(now));
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  const firstName = String(user?.displayName || user?.email?.split("@")[0] || "Administrador").trim().split(/\s+/)[0];
  $("#adGreeting").textContent = `${greeting}, ${firstName}. Tudo sob controle.`;
  $("#adCurrentDate").textContent = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long",
  }).format(now);
}

function renderStats(metrics) {
  const items = [
    ["♧", "Usuários ativos", metrics.users, "Contas no Firebase Auth"],
    ["▣", "Assinaturas", metrics.activeSubscriptions ?? 0, "Acessos ativos por plano"],
    ["$", "Receita registrada", money(metrics.revenueCents30d ?? 0), "Recebimentos confirmados em 30 dias"],
    ["↗", "Integrações saudáveis", `${metrics.integrationsHealthy ?? 0}/${metrics.integrationsTotal ?? 0}`, "Serviços com credenciais completas"],
  ];
  $("#adStats").innerHTML = items.map(([icon, label, count, subtitle]) =>
    `<div class="ad-stat"><span class="ad-stat-icon" aria-hidden="true">${icon}</span><div><span class="ad-stat-label">${label}</span><strong>${typeof count === "number" ? count.toLocaleString("pt-BR") : escapeHtml(count)}</strong><small>${subtitle}</small></div></div>`
  ).join("");
  $("#adOperationsSummary").innerHTML = [
    ["✦", metrics.usersWithSavedChanges30d ?? 0, "usuários com atividade"],
    ["◉", metrics.whatsappReceived30d ?? 0, "mensagens no WhatsApp"],
    ["⌁", metrics.reminderDeliveriesAccepted30d ?? 0, "lembretes aceitos"],
  ].map(([symbol, value, label]) => `<div class="ad-operation"><span aria-hidden="true">${symbol}</span><div><strong>${Number(value).toLocaleString("pt-BR")}</strong><small>${label} nos últimos 30 dias</small></div></div>`).join("");
  if ($("#adLastRefresh")) $("#adLastRefresh").textContent = `Dados atualizados às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(new Date())}`;
}

function renderAudit(events) {
  const root = $("#adAuditPreview");
  if (!events?.length) { root.className = "ad-empty"; root.textContent = "Nenhuma ação administrativa registrada ainda."; return; }
  root.className = "ad-list";
  root.innerHTML = events.map((event) => `<div class="ad-audit-row"><span><strong>${escapeHtml(event.action)}</strong><br>${escapeHtml(event.actorEmail || "Administrador")}${event.target ? ` · ${escapeHtml(event.target)}` : ""}</span><time>${readableDate(event.at)}</time></div>`).join("");
}

function renderIntegrationRows(data, selector, compact = false) {
  const symbols = { firebase: "◆", whatsapp: "◉", gemini: "✦", qstash: "▣", stripe: "$" };
  $(selector).innerHTML = data.integrations.map((item) => {
    const detail = item.id === "qstash"
      ? `Última execução: ${readableTimestamp(item.lastRunAt)} · ${item.runStatus === "ok" ? "sem falhas" : item.runStatus === "unknown" ? "sem histórico" : item.runStatus}`
      : item.id === "whatsapp"
        ? `Último evento: ${readableTimestamp(item.lastEventAt)} · ${Number(item.recentFailures || 0)} falha(s) na amostra recente`
        : item.detail;
    return `<div class="ad-integration"><span class="ad-integration-icon" aria-hidden="true">${symbols[item.id] || "◇"}</span><span class="ad-integration-content"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(detail)}</small></span><span class="ad-pill ${item.configured ? "" : "is-warn"}">${item.configured ? "Configurado" : "Pendente"}</span></div>`;
  }).join("");
  if (!compact) $("#adIntegrationNote").textContent = data.note || "";
  const stripe = data.integrations.find((item) => item.id === "stripe");
  if (stripe && $("#adBillingStatus")) {
    $("#adBillingStatus").innerHTML = `<span class="ad-provider-logo">S</span><div><strong>Stripe Billing</strong><small>${escapeHtml(stripe.detail)}</small></div><span class="ad-pill ${stripe.configured ? "" : "is-warn"}">${stripe.configured ? "Conectado" : "Configuração pendente"}</span>`;
  }
}

function userRow(user) {
  const initial = (user.displayName || user.email || "?").trim()[0]?.toUpperCase() || "?";
  const plans = [user.planId ? "" : `<option value="" selected disabled>Acesso legado (sem plano)</option>`, ...state.plans.filter((plan) => plan.active !== false || plan.id === user.planId).map((plan) =>
    `<option value="${escapeHtml(plan.id)}" ${plan.id === user.planId ? "selected" : ""}>${escapeHtml(plan.name)}</option>`)].join("");
  return `<div class="ad-user" data-uid="${escapeHtml(user.uid)}"><div class="ad-user-main"><span class="ad-avatar">${escapeHtml(initial)}</span><div><strong>${escapeHtml(user.displayName || user.email || user.uid)}</strong><small>${escapeHtml(user.email || user.uid)} · Último acesso ${readableDate(user.lastSignInAt)}${user.planId ? ` · Assinatura ${escapeHtml(user.subscriptionStatus || "active")}` : ""}</small></div></div><div class="ad-user-actions"><span class="ad-pill ${user.disabled ? "is-off" : ""}">${user.disabled ? "Desativado" : "Ativo"}</span><select aria-label="Plano de ${escapeHtml(user.email || user.uid)}" data-action="plan" data-current-plan="${escapeHtml(user.planId || "")}">${plans}</select><button class="ad-subtle-button" type="button" data-action="status" data-disabled="${!user.disabled}">${user.disabled ? "Reativar" : "Desativar"}</button></div></div>`;
}

function renderUsers() {
  const list = $("#adUsersList");
  list.innerHTML = state.users.length ? state.users.map(userRow).join("") : `<div class="ad-empty">Nenhum usuário encontrado nesta consulta.</div>`;
  $("#adUsersPageLabel").textContent = `${state.users.length} conta${state.users.length === 1 ? "" : "s"} nesta página`;
  $("#adUsersNext").disabled = !state.usersNextPageToken;
  $("#adUsersPreview").innerHTML = state.users.length ? state.users.slice(0, 6).map(userRow).join("") : `<div class="ad-empty">Nenhuma conta nesta página.</div>`;
}

async function loadUsers(query = {}) {
  const data = await request("users", undefined, { limit: 20, ...query });
  state.users = data.users;
  state.usersNextPageToken = data.nextPageToken;
  renderUsers();
}

async function loadPlans() {
  const data = await request("plans");
  state.plans = data.plans;
  $("#adPlansList").innerHTML = state.plans.length ? state.plans.map((plan) => `<div class="ad-plan"><div><strong>${escapeHtml(plan.name)}${plan.priceCents ? ` · ${money(plan.priceCents)}/${plan.billingInterval === "year" ? "ano" : "mês"}` : ""}</strong><small>${escapeHtml(plan.id)} · ${escapeHtml(plan.description || "Sem descrição")}${plan.stripePriceId ? " · Checkout conectado" : " · Sem checkout"}</small></div><div class="ad-plan-actions"><span class="ad-pill ${plan.active ? "" : "is-off"}">${plan.active ? "Ativo" : "Inativo"}</span><button class="ad-subtle-button" type="button" data-edit-plan="${escapeHtml(plan.id)}">Editar</button></div></div>`).join("") : `<div class="ad-empty">Nenhum plano criado. Contas sem plano mantêm o acesso atual.</div>`;
  $("#adSubscriptionPlanSelect").innerHTML = `<option value="">Selecione um plano</option>` + state.plans.filter((plan) => plan.active !== false).map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</option>`).join("");
  renderUsers();
}

async function loadSubscriptions() {
  const data = await request("subscriptions");
  $("#adSubscriptionsList").innerHTML = data.subscriptions.length ? data.subscriptions.map((item) => `<div class="ad-plan"><div><strong>${escapeHtml(item.uid)}</strong><small>${escapeHtml(item.planId)} · ${escapeHtml(item.status || "active")}${item.validUntil ? ` · Até ${readableDate(item.validUntil)}` : ""}</small></div><button class="ad-subtle-button" type="button" data-edit-subscription="${escapeHtml(item.uid)}" data-plan-id="${escapeHtml(item.planId)}" data-status="${escapeHtml(item.status || "active")}" data-valid-until="${escapeHtml(item.validUntil || "")}">Editar</button></div>`).join("") : `<div class="ad-empty">Nenhuma assinatura manual. Usuários sem plano mantêm o acesso atual.</div>`;
}

function renderConfig() {
  if (!state.config) return;
  const config = state.config;
  $("#adMaintenanceStatus").className = `ad-pill ${config.maintenance.enabled ? "is-warn" : ""}`;
  $("#adMaintenanceStatus").textContent = config.maintenance.enabled ? "Ativo" : "Desativado";
  $("#adFeatureSwitches").innerHTML = Object.entries(FEATURE_LABELS).map(([key, [label, description]]) => `<label class="ad-feature-row"><span><strong>${label}</strong><small>${description}</small></span><input type="checkbox" name="${key}" ${config.features[key] ? "checked" : ""} /></label>`).join("");
  const form = $("#adSettingsForm");
  form.elements.maintenance.checked = config.maintenance.enabled;
  form.elements.maintenanceMessage.value = config.maintenance.message;
  $("#adPlanFeatures").innerHTML = Object.entries(FEATURE_LABELS).map(([key, [label]]) => `<label class="ad-check"><input type="checkbox" name="feature-${key}" checked /> ${label}</label>`).join("");
}

async function loadConfig() {
  const data = await request("settings");
  state.config = data.config;
  renderConfig();
}

function money(cents) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format((Number(cents) || 0) / 100);
}

async function loadCharges() {
  const data = await request("charges");
  $("#adChargesList").innerHTML = data.charges.length ? data.charges.map((charge) => `<div class="ad-charge" data-charge-id="${escapeHtml(charge.id)}"><div><strong>${money(charge.amountCents)} · ${escapeHtml(charge.uid)}</strong><small>${escapeHtml(charge.note || "Sem observação")} · Vence ${charge.dueDate ? readableDate(charge.dueDate) : "sem data"}<br>Registro manual · ${escapeHtml(charge.status)}</small></div><div class="ad-charge-actions">${charge.status === "manual_pending" ? `<button class="ad-subtle-button" type="button" data-charge-status="manual_received">Marcar recebido</button><button class="ad-subtle-button" type="button" data-charge-status="manual_cancelled">Cancelar</button>` : ""}</div></div>`).join("") : `<div class="ad-empty">Nenhuma cobrança manual registrada.</div>`;
}

async function loadIntegrations() {
  const data = await request("integrations");
  renderIntegrationRows(data, "#adIntegrationsPreview", true);
  renderIntegrationRows(data, "#adIntegrationsList");
}

async function loadAdmins() {
  const data = await request("admins");
  state.admins = data.admins || [];
  state.isOwner = data.isOwner === true;
  $("#adAdminForm").hidden = !state.isOwner;
  $("#adAdminsList").innerHTML = state.admins.length ? state.admins.map((admin) => `<div class="ad-admin-row"><div><strong>${escapeHtml(admin.displayName || admin.email)}</strong><small>${escapeHtml(admin.email)} · ${admin.owner ? "Proprietário principal" : "Administrador"}${admin.source === "environment" ? " · Configuração do servidor" : " · Regra no Firebase"}</small></div><div class="ad-plan-actions"><span class="ad-pill ${admin.owner ? "" : "is-off"}">${admin.owner ? "Proprietário" : "Admin"}</span>${state.isOwner && !admin.owner && admin.uid !== state.user?.uid ? `<button class="ad-subtle-button" type="button" data-revoke-admin="${escapeHtml(admin.uid)}">Remover</button>` : ""}</div></div>`).join("") : `<div class="ad-empty">Nenhum administrador adicional cadastrado.</div>`;
}

async function loadDashboard() {
  const data = await request("dashboard");
  renderStats(data.metrics);
  renderAudit(data.recentAudit);
}

async function showSection(section) {
  if (!SECTION_LABELS[section]) return;
  state.currentSection = section;
  const sequence = ++state.loadSequence;
  $("#adPageTitle").textContent = section === "overview" ? "Administração" : SECTION_LABELS[section];
  $("#adPageSubtitle").textContent = SECTION_SUBTITLES[section];
  document.querySelectorAll(".ad-section").forEach((element) => element.classList.toggle("is-active", element.id === `ad-${section}`));
  document.querySelectorAll("[data-section]").forEach((button) => button.classList.toggle("is-active", button.dataset.section === section));
  closeMenu();
  setLoadError();
  const loads = {
    overview: [loadDashboard, loadPlans, loadUsers, loadIntegrations, loadConfig],
    users: [loadPlans, loadUsers],
    plans: [loadPlans],
    subscriptions: [loadPlans, loadSubscriptions],
    charges: [loadCharges],
    features: [loadConfig],
    integrations: [loadIntegrations],
    security: [loadAdmins],
    settings: [loadConfig],
  };
  const results = await Promise.allSettled(loads[section].map((load) => load()));
  if (sequence !== state.loadSequence) return;
  const failed = results.find((result) => result.status === "rejected");
  if (failed) setLoadError(`Não foi possível carregar ${SECTION_LABELS[section].toLowerCase()}: ${failed.reason.message}. Tente novamente.`);
}

function bindNavigation() {
  $("#adMobileTabs").innerHTML = Object.entries(SECTION_LABELS).map(([key, label]) => `<button type="button" data-section="${key}">${label}</button>`).join("");
  document.addEventListener("click", (event) => {
    const section = event.target.closest("[data-section]")?.dataset.section || event.target.closest("[data-go]")?.dataset.go;
    if (section) showSection(section);
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
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#pnRail").classList.contains("is-open")) {
      closeMenu();
      $("#adMenuButton").focus();
    }
  });
}

function bindActions() {
  $("#adUserSearch").addEventListener("submit", async (event) => { event.preventDefault(); try { await loadUsers({ email: $("#adUserEmail").value }); } catch (error) { toast(error.message, true); } });
  $("#adUserClear").addEventListener("click", async () => { $("#adUserEmail").value = ""; try { await loadUsers(); } catch (error) { toast(error.message, true); } });
  $("#adUsersNext").addEventListener("click", async () => { if (state.usersNextPageToken) { try { await loadUsers({ pageToken: state.usersNextPageToken }); } catch (error) { toast(error.message, true); } } });
  $("#adAuditRefresh").addEventListener("click", async () => { try { await loadDashboard(); toast("Atividade atualizada."); } catch (error) { toast(error.message, true); } });

  document.addEventListener("click", async (event) => {
    const statusButton = event.target.closest('[data-action="status"]');
    if (statusButton) {
      const uid = statusButton.closest("[data-uid]")?.dataset.uid;
      const disabled = statusButton.dataset.disabled === "true";
      if (!uid || !window.confirm(disabled
        ? "Desativar esta conta? O usuário perderá o acesso até a reativação."
        : "Reativar esta conta e restaurar seu acesso?")) return;
      try { await request("user-update", { uid, disabled }); toast(disabled ? "Conta desativada." : "Conta reativada."); await loadUsers(); } catch (error) { toast(error.message, true); }
    }
    const edit = event.target.closest("[data-edit-plan]");
    if (edit) {
      const plan = state.plans.find((item) => item.id === edit.dataset.editPlan);
      if (!plan) return;
      await showSection("plans");
      const form = $("#adPlanForm");
      form.elements.id.value = plan.id;
      form.elements.name.value = plan.name;
      form.elements.description.value = plan.description || "";
      form.elements.price.value = plan.priceCents ? String(plan.priceCents / 100).replace(".", ",") : "";
      form.elements.billingInterval.value = plan.billingInterval || "month";
      form.elements.stripePriceId.value = plan.stripePriceId || "";
      form.elements.active.checked = plan.active !== false;
      for (const key of Object.keys(FEATURE_LABELS)) form.elements[`feature-${key}`].checked = plan.features?.[key] === true;
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const chargeButton = event.target.closest("[data-charge-status]");
    if (chargeButton) {
      const id = chargeButton.closest("[data-charge-id]")?.dataset.chargeId;
      if (!id) return;
      const received = chargeButton.dataset.chargeStatus === "manual_received";
      if (!window.confirm(received
        ? "Marcar esta cobrança manual como recebida? O PulseNote não verifica pagamentos em um provedor externo."
        : "Cancelar este registro de cobrança manual?")) return;
      try { await request("charge-update", { id, status: chargeButton.dataset.chargeStatus }); toast("Registro manual atualizado."); await loadCharges(); } catch (error) { toast(error.message, true); }
    }
    const subscriptionButton = event.target.closest("[data-edit-subscription]");
    if (subscriptionButton) {
      const form = $("#adSubscriptionForm");
      form.elements.uid.value = subscriptionButton.dataset.editSubscription;
      form.elements.planId.value = subscriptionButton.dataset.planId;
      form.elements.status.value = subscriptionButton.dataset.status;
      form.elements.validUntil.value = subscriptionButton.dataset.validUntil;
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const revokeAdmin = event.target.closest("[data-revoke-admin]");
    if (revokeAdmin) {
      const uid = revokeAdmin.dataset.revokeAdmin;
      if (!uid || !window.confirm("Remover o acesso administrativo desta conta? A conta continuará existindo como usuário comum.")) return;
      try { await request("admin-role-set", { uid, enabled: false }); toast("Acesso administrativo removido."); await loadAdmins(); } catch (error) { toast(error.message, true); }
    }
  });

  document.addEventListener("change", async (event) => {
    const select = event.target.closest('select[data-action="plan"]');
    if (!select) return;
    const uid = select.closest("[data-uid]")?.dataset.uid;
    const previous = select.dataset.currentPlan;
    const plan = state.plans.find((item) => item.id === select.value);
    if (!uid || !plan) { select.value = previous; return; }
    const user = state.users.find((item) => item.uid === uid);
    const label = user?.email || user?.displayName || uid;
    if (!window.confirm(`Alterar o acesso de ${label} para o plano ${plan.name}? Esta mudança afeta os recursos disponíveis imediatamente.`)) {
      select.value = previous;
      return;
    }
    try { await request("entitlement-set", { uid, planId: select.value }); toast("Plano de acesso atualizado."); await loadUsers(); } catch (error) { toast(error.message, true); await loadUsers(); }
  });

  $("#adPlanForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const features = Object.fromEntries(Object.keys(FEATURE_LABELS).map((key) => [key, form.elements[`feature-${key}`].checked]));
    const existing = state.plans.find((plan) => plan.id === form.elements.id.value.trim().toLowerCase());
    const rawPrice = form.elements.price.value.trim().replace(/\s|R\$/g, "");
    const normalizedPrice = rawPrice.includes(",") ? rawPrice.replace(/\./g, "").replace(",", ".") : rawPrice;
    const price = normalizedPrice ? Number(normalizedPrice) : 0;
    if (!Number.isFinite(price) || price < 0 || (normalizedPrice && !/^\d+(?:\.\d{1,2})?$/.test(normalizedPrice))) return toast("Informe um preço válido com até duas casas decimais.", true);
    if (existing && (existing.active !== form.elements.active.checked
      || Object.keys(FEATURE_LABELS).some((key) => existing.features?.[key] !== features[key]))
      && !window.confirm(`Alterar os recursos do plano ${existing.name}? Isso pode mudar o acesso de todos os assinantes imediatamente.`)) return;
    try {
      await request("plan-save", { id: form.elements.id.value, name: form.elements.name.value, description: form.elements.description.value,
        priceCents: Math.round(price * 100), billingInterval: form.elements.billingInterval.value,
        stripePriceId: form.elements.stripePriceId.value.trim(), active: form.elements.active.checked, features });
      toast("Plano salvo."); form.reset(); await loadPlans();
    } catch (error) { toast(error.message, true); }
  });

  $("#adSubscriptionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!window.confirm(`Salvar o plano e a situação de acesso para ${form.elements.uid.value.trim()}?`)) return;
    try {
      await request("entitlement-set", { uid: form.elements.uid.value.trim(), planId: form.elements.planId.value,
        status: form.elements.status.value, validUntil: form.elements.validUntil.value || null });
      toast("Assinatura manual atualizada."); form.reset(); await Promise.all([loadSubscriptions(), loadUsers()]);
    } catch (error) { toast(error.message, true); }
  });

  $("#adChargeForm").addEventListener("input", (event) => { delete event.currentTarget.dataset.requestId; });
  $("#adChargeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton.disabled) return;
    const raw = form.elements.amount.value.trim().replace(/\s|R\$/g, "");
    const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
    const amount = Number(normalized);
    if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(?:[.,]\d{1,2})?$/.test(normalized)) return toast("Informe um valor com até duas casas decimais.", true);
    form.dataset.requestId ||= crypto.randomUUID();
    submitButton.disabled = true;
    try {
      const result = await request("charge-create", { uid: form.elements.uid.value.trim(), amountCents: Math.round(amount * 100), dueDate: form.elements.dueDate.value, note: form.elements.note.value, requestId: form.dataset.requestId });
      toast(result.alreadyCreated ? "Registro já confirmado. Nenhuma cobrança duplicada foi criada." : "Registro manual criado.");
      form.reset(); delete form.dataset.requestId; await loadCharges();
    } catch (error) { toast(error.message, true); }
    finally { submitButton.disabled = false; }
  });

  $("#adFeaturesForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const features = Object.fromEntries(Object.keys(FEATURE_LABELS).map((key) => [key, form.elements[key].checked]));
    if (Object.keys(FEATURE_LABELS).some((key) => state.config.features[key] !== features[key])
      && !window.confirm("Aplicar a mudança de recursos para todos os usuários? A disponibilidade muda imediatamente.")) return;
    try { const data = await request("config-update", { ...state.config, features }); state.config = data.config; renderConfig(); toast("Recursos atualizados no servidor."); } catch (error) { toast(error.message, true); }
  });
  $("#adSettingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const enabled = form.elements.maintenance.checked;
    if (enabled !== state.config.maintenance.enabled && !window.confirm(enabled
      ? "Ativar manutenção? Isso bloqueará alterações dos usuários no PulseNote."
      : "Desativar manutenção e restaurar as alterações dos usuários?")) return;
    try {
      const data = await request("config-update", { ...state.config, maintenance: { enabled, message: form.elements.maintenanceMessage.value } });
      state.config = data.config; renderConfig(); toast("Configurações atualizadas no servidor.");
    } catch (error) { toast(error.message, true); }
  });
  $("#adAdminForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = form.elements.email.value.trim().toLowerCase();
    if (!window.confirm(`Conceder acesso administrativo a ${email}? Essa conta poderá alterar usuários, recursos e configurações.`)) return;
    try { await request("admin-role-set", { email, enabled: true }); toast("Administrador adicionado."); form.reset(); await loadAdmins(); } catch (error) { toast(error.message, true); }
  });
}

bindNavigation();
bindActions();
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
    $(".ad-shell").classList.remove("is-locked");
    $("#adGate").hidden = true;
    $("#adContent").hidden = false;
    $("#adAccount").textContent = user.email || "Administrador";
    $("#adSession").textContent = "Acesso administrativo";
    $("#adAdminName").textContent = user.displayName || user.email || "Administrador";
    $("#adAdminAvatar").textContent = (user.displayName || user.email || "PN").split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");
    renderAdminWelcome(user);
    renderStats(data.metrics);
    renderAudit(data.recentAudit);
    const results = await Promise.allSettled([loadUsers(), loadPlans(), loadIntegrations(), loadConfig(), loadAdmins()]);
    if (sequence !== state.authSequence || state.user !== user) return;
    $("#adAdminRole").textContent = state.isOwner ? "Proprietário principal" : "Administrador";
    const failed = results.find((result) => result.status === "rejected");
    if (failed) setLoadError(`Parte do painel não carregou: ${failed.reason.message}. Tente novamente.`);
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

