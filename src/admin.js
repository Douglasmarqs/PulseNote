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
  features: "Recursos", integrations: "Integrações", settings: "Configurações",
};
const state = { user: null, config: null, plans: [], users: [], usersNextPageToken: null, currentSection: "overview" };
const $ = (selector) => document.querySelector(selector);

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

function renderStats(metrics) {
  const items = [
    ["♧", "Usuários", metrics.users, "Contas no Firebase Auth"],
    ["▥", "Com alterações", metrics.usersWithSavedChanges30d, "Salvaram dados nos últimos 30 dias"],
    ["◉", "WhatsApp", metrics.whatsappReceived30d, "Mensagens recebidas em 30 dias"],
    ["♧", "Lembretes", metrics.reminderDeliveriesAccepted30d, "Entregas aceitas em 30 dias"],
  ];
  $("#adStats").innerHTML = items.map(([icon, label, count, subtitle]) =>
    `<div class="ad-stat"><span class="ad-stat-icon" aria-hidden="true">${icon}</span><div><span class="ad-stat-label">${label}</span><strong>${Number(count).toLocaleString("pt-BR")}</strong><small>${subtitle}</small></div></div>`
  ).join("");
}

function renderAudit(events) {
  const root = $("#adAuditPreview");
  if (!events?.length) { root.className = "ad-empty"; root.textContent = "Nenhuma ação administrativa registrada ainda."; return; }
  root.className = "ad-list";
  root.innerHTML = events.map((event) => `<div class="ad-audit-row"><span><strong>${escapeHtml(event.action)}</strong><br>${escapeHtml(event.actorEmail || "Administrador")}${event.target ? ` · ${escapeHtml(event.target)}` : ""}</span><time>${readableDate(event.at)}</time></div>`).join("");
}

function renderIntegrationRows(data, selector, compact = false) {
  const symbols = { firebase: "◆", whatsapp: "◉", gemini: "✦", qstash: "▣" };
  $(selector).innerHTML = data.integrations.map((item) => {
    const detail = item.id === "qstash"
      ? `Última execução: ${readableTimestamp(item.lastRunAt)} · ${item.runStatus === "ok" ? "sem falhas" : item.runStatus === "unknown" ? "sem histórico" : item.runStatus}`
      : item.id === "whatsapp"
        ? `Último evento: ${readableTimestamp(item.lastEventAt)} · ${Number(item.recentFailures || 0)} falha(s) na amostra recente`
        : item.detail;
    return `<div class="ad-integration"><span class="ad-integration-icon" aria-hidden="true">${symbols[item.id] || "◇"}</span><span class="ad-integration-content"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(detail)}</small></span><span class="ad-pill ${item.configured ? "" : "is-warn"}">${item.configured ? "Configurado" : "Pendente"}</span></div>`;
  }).join("");
  if (!compact) $("#adIntegrationNote").textContent = data.note || "";
}

function userRow(user) {
  const initial = (user.displayName || user.email || "?").trim()[0]?.toUpperCase() || "?";
  const plans = [`<option value="">Sem plano</option>`, ...state.plans.filter((plan) => plan.active !== false || plan.id === user.planId).map((plan) =>
    `<option value="${escapeHtml(plan.id)}" ${plan.id === user.planId ? "selected" : ""}>${escapeHtml(plan.name)}</option>`)].join("");
  return `<div class="ad-user" data-uid="${escapeHtml(user.uid)}"><div class="ad-user-main"><span class="ad-avatar">${escapeHtml(initial)}</span><div><strong>${escapeHtml(user.displayName || user.email || user.uid)}</strong><small>${escapeHtml(user.email || user.uid)} · Último acesso ${readableDate(user.lastSignInAt)}${user.planId ? ` · Assinatura ${escapeHtml(user.subscriptionStatus || "active")}` : ""}</small></div></div><div class="ad-user-actions"><span class="ad-pill ${user.disabled ? "is-off" : ""}">${user.disabled ? "Desativado" : "Ativo"}</span><select aria-label="Plano de ${escapeHtml(user.email || user.uid)}" data-action="plan">${plans}</select><button class="ad-subtle-button" type="button" data-action="status" data-disabled="${!user.disabled}">${user.disabled ? "Reativar" : "Desativar"}</button></div></div>`;
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
  $("#adPlansList").innerHTML = state.plans.length ? state.plans.map((plan) => `<div class="ad-plan"><div><strong>${escapeHtml(plan.name)}</strong><small>${escapeHtml(plan.id)} · ${escapeHtml(plan.description || "Sem descrição")}</small></div><div class="ad-plan-actions"><span class="ad-pill ${plan.active ? "" : "is-off"}">${plan.active ? "Ativo" : "Inativo"}</span><button class="ad-subtle-button" type="button" data-edit-plan="${escapeHtml(plan.id)}">Editar</button></div></div>`).join("") : `<div class="ad-empty">Nenhum plano criado. Contas sem plano mantêm o acesso atual.</div>`;
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
  form.elements.supportEmail.value = config.supportEmail;
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

async function loadDashboard() {
  const data = await request("dashboard");
  renderStats(data.metrics);
  renderAudit(data.recentAudit);
}

async function showSection(section) {
  if (!SECTION_LABELS[section]) return;
  state.currentSection = section;
  document.querySelectorAll(".ad-section").forEach((element) => element.classList.toggle("is-active", element.id === `ad-${section}`));
  document.querySelectorAll("[data-section]").forEach((button) => button.classList.toggle("is-active", button.dataset.section === section));
  $("#adSidebar").classList.remove("is-open");
  $("#adMenuButton").setAttribute("aria-expanded", "false");
  try {
    if (section === "users") await loadUsers();
    if (section === "plans") await loadPlans();
    if (section === "subscriptions") await Promise.all([loadPlans(), loadSubscriptions()]);
    if (section === "charges") await loadCharges();
    if (section === "integrations") await loadIntegrations();
    if (section === "features" || section === "settings") await loadConfig();
    if (section === "overview") await Promise.all([loadDashboard(), loadUsers(), loadIntegrations(), loadConfig()]);
  } catch (error) { toast(`Não foi possível carregar: ${error.message}`, true); }
}

function bindNavigation() {
  $("#adMobileTabs").innerHTML = Object.entries(SECTION_LABELS).filter(([key]) => key !== "overview").map(([key, label]) => `<button type="button" data-section="${key}">${label}</button>`).join("");
  document.addEventListener("click", (event) => {
    const section = event.target.closest("[data-section]")?.dataset.section || event.target.closest("[data-go]")?.dataset.go;
    if (section) showSection(section);
  });
  $("#adMenuButton").addEventListener("click", () => {
    const open = $("#adSidebar").classList.toggle("is-open");
    $("#adMenuButton").setAttribute("aria-expanded", String(open));
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
      if (!uid || (disabled && !window.confirm("Desativar esta conta? O usuário perderá o acesso até a reativação."))) return;
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
      form.elements.active.checked = plan.active !== false;
      for (const key of Object.keys(FEATURE_LABELS)) form.elements[`feature-${key}`].checked = plan.features?.[key] === true;
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const chargeButton = event.target.closest("[data-charge-status]");
    if (chargeButton) {
      const id = chargeButton.closest("[data-charge-id]")?.dataset.chargeId;
      if (!id) return;
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
  });

  document.addEventListener("change", async (event) => {
    const select = event.target.closest('select[data-action="plan"]');
    if (!select) return;
    const uid = select.closest("[data-uid]")?.dataset.uid;
    try { await request("entitlement-set", { uid, planId: select.value || null }); toast("Plano de acesso atualizado."); await loadUsers(); } catch (error) { toast(error.message, true); await loadUsers(); }
  });

  $("#adPlanForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const features = Object.fromEntries(Object.keys(FEATURE_LABELS).map((key) => [key, form.elements[`feature-${key}`].checked]));
    try {
      await request("plan-save", { id: form.elements.id.value, name: form.elements.name.value, description: form.elements.description.value, active: form.elements.active.checked, features });
      toast("Plano salvo."); form.reset(); await loadPlans();
    } catch (error) { toast(error.message, true); }
  });

  $("#adSubscriptionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await request("entitlement-set", { uid: form.elements.uid.value.trim(), planId: form.elements.planId.value,
        status: form.elements.status.value, validUntil: form.elements.validUntil.value || null });
      toast("Assinatura manual atualizada."); form.reset(); await Promise.all([loadSubscriptions(), loadUsers()]);
    } catch (error) { toast(error.message, true); }
  });

  $("#adChargeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const raw = form.elements.amount.value.trim().replace(/\s|R\$/g, "");
    const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
    const amount = Number(normalized);
    if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(?:[.,]\d{1,2})?$/.test(normalized)) return toast("Informe um valor com até duas casas decimais.", true);
    try {
      await request("charge-create", { uid: form.elements.uid.value.trim(), amountCents: Math.round(amount * 100), dueDate: form.elements.dueDate.value, note: form.elements.note.value });
      toast("Registro manual criado."); form.reset(); await loadCharges();
    } catch (error) { toast(error.message, true); }
  });

  $("#adFeaturesForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const features = Object.fromEntries(Object.keys(FEATURE_LABELS).map((key) => [key, form.elements[key].checked]));
    try { const data = await request("config-update", { ...state.config, features }); state.config = data.config; renderConfig(); toast("Recursos atualizados no servidor."); } catch (error) { toast(error.message, true); }
  });
  $("#adSettingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const enabled = form.elements.maintenance.checked;
    if (enabled && !state.config.maintenance.enabled && !window.confirm("Ativar manutenção? Isso bloqueará alterações dos usuários no PulseNote.")) return;
    try {
      const data = await request("config-update", { ...state.config, maintenance: { enabled, message: form.elements.maintenanceMessage.value }, supportEmail: form.elements.supportEmail.value });
      state.config = data.config; renderConfig(); toast("Configurações atualizadas no servidor.");
    } catch (error) { toast(error.message, true); }
  });
}

bindNavigation();
bindActions();
onAuthStateChanged(auth, async (user) => {
  state.user = user;
  if (!user) {
    $("#adGate").innerHTML = `Entre no PulseNote para acessar a administração. <a href="/login">Ir para o login</a>`;
    return;
  }
  try {
    await user.getIdToken(true);
    const data = await request("dashboard");
    $("#adGate").hidden = true;
    $("#adContent").hidden = false;
    $("#adAccount").textContent = user.email || "Administrador";
    $("#adSession").textContent = "Acesso administrativo";
    renderStats(data.metrics);
    renderAudit(data.recentAudit);
    const results = await Promise.allSettled([loadUsers(), loadPlans(), loadIntegrations(), loadConfig()]);
    for (const result of results) if (result.status === "rejected") toast(`Parte do painel não carregou: ${result.reason.message}`, true);
  } catch (error) {
    $("#adGate").innerHTML = error.status === 403
      ? `Esta conta não tem permissão administrativa. <a href="/app">Voltar ao aplicativo</a>`
      : `Não foi possível validar o acesso agora. <button type="button" id="adRetry">Tentar novamente</button>`;
    $("#adRetry")?.addEventListener("click", () => location.reload());
  }
});
