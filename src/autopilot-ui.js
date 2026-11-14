const AREA_LABELS = {
  finances: "Finanças",
  planner: "Planner",
  notes: "Notas",
};
const AREA_ICONS = { finances: "wallet", planner: "calendar", notes: "note" };
const METRIC_ICONS = { trend: "bars", money: "wallet" };

function displayPriority(priority) {
  const value = String(priority || "").toLowerCase();
  if (value === "high" || value === "alta" || value === "urgent") return { label: "Alta", key: "high" };
  if (value === "medium" || value === "media" || value === "média") return { label: "Média", key: "medium" };
  return { label: "Baixa", key: "low" };
}

function makeTextElement(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = String(value || "");
  return el;
}

function icon(id) {
  return `<svg class="i" aria-hidden="true"><use href="#i-${String(id).replace(/[^a-z0-9-]/g, "")}"/></svg>`;
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value) || 0);
}

function lowerFirst(text) {
  const value = String(text || "");
  return value.charAt(0).toLocaleLowerCase("pt-BR") + value.slice(1);
}

function listText(items, max = 3) {
  const list = (items || []).slice(0, max);
  if (!list.length) return "";
  const rest = (items || []).length - list.length;
  return `${list.join("; ")}${rest > 0 ? ` e mais ${rest}` : ""}`;
}

// Texto da confirmação: diz exatamente o que vai mudar antes de aprovar.
function actionSentence(suggestion, option) {
  const items = suggestion.items || [];
  switch (option.action) {
    case "create_subscription_review_task":
      return `Vou criar uma tarefa com as assinaturas identificadas (${listText(items)}) para você revisar e cancelar as que não usa.`;
    case "pause_subscription_recurrents":
      return `Vou pausar no PulseNote as recorrências dessas assinaturas (${listText(items)}). Isso não cancela o serviço — faça o cancelamento no app de cada um.`;
    case "create_week_plan_task":
      return "Vou criar a tarefa “Planejar a próxima semana” para hoje, com um passo a passo para revisar tarefas e compromissos.";
    case "organize_notes_folders":
      return `Vou mover as notas sem categoria para as pastas sugeridas (${listText(items)}).`;
    case "reschedule_task_tomorrow":
      return `Vou mudar o prazo de “${suggestion.title.replace(/^Revisar tarefa atrasada:\s*/, "")}” para amanhã.`;
    case "complete_task":
      return `Vou marcar “${suggestion.title.replace(/^Revisar tarefa atrasada:\s*/, "")}” como concluída.`;
    default:
      return `Vou ${lowerFirst(option.label || "executar esta ação")} (${suggestion.title}). Nada mais será alterado.`;
  }
}

export function createAutopilotUI({ getToken, openArea, notify }) {
  const list = document.getElementById("autopilotList");
  const status = document.getElementById("autopilotStatus");
  const preview = document.getElementById("autopilotPreview");
  const dashboardPreview = document.getElementById("pulseAutopilotPreview");
  const dashboardCard = document.getElementById("pulseAutopilotDashboardCard");
  const modal = document.getElementById("autopilotConfirmModal");
  const modalDescription = document.getElementById("autopilotConfirmDescription");
  const applyButton = document.getElementById("autopilotConfirmApply");
  let suggestions = [];
  let fetchedAt = 0;
  let pendingLoad = null;
  let queuedReload = null;
  let pendingAction = null;
  let focusBeforeModal = null;
  let requestSerial = 0;
  let pendingSerial = 0;
  let refreshTimer = null;
  let bound = false;
  let filter = "all";

  function isDesignPreview() {
    return getToken()?.uid === "local-design-preview";
  }

  function loadDesignPreviewSuggestion() {
    suggestions = [{
      id: "design-preview-subscriptions",
      source: "finances",
      priority: "high",
      title: "Reduzir gastos recorrentes",
      description: "Você tem 2 assinaturas pouco usadas (R$ 79,80/mês). Cancele ou pause e economize R$ 957,60 por ano.",
      actionOptions: [
        { label: "Criar tarefa para revisar assinaturas", action: "create_subscription_review_task" },
        { label: "Já cancelei: pausar estas recorrências", action: "pause_subscription_recurrents" },
      ],
      metrics: [
        { icon: "wallet", label: "Gasto atual", value: "R$ 79,80/mês" },
        { icon: "trend", label: "Economia estimada", value: "R$ 957,60/ano", tone: "positive" },
      ],
      items: ["Streaming Plus – R$ 49,90/mês", "Produtividade Pro – R$ 29,90/mês"],
      impact: { label: "Economia estimada", value: "+ R$ 957,60/ano", tone: "positive" },
      metadata: { monthly: 79.8 },
    }, {
      id: "design-preview-week",
      source: "planner",
      priority: "medium",
      title: "Planejar a próxima semana",
      description: "Há 5 tarefas pendentes e 2 compromissos sem preparação. Organize sua semana em 10 minutos.",
      actionOptions: [{ label: "Criar tarefa de planejamento", action: "create_week_plan_task" }],
      metrics: [{ icon: "list", label: "5 tarefas pendentes" }, { icon: "calendar", label: "2 compromissos" }],
      items: ["Planejar metas de fevereiro · 25/01", "Organizar despesas do mês · 27/01", "Ajustar apresentação de resultados · 24/01"],
      impact: { label: "Tempo estimado", value: "10 minutos" },
    }, {
      id: "design-preview-notes",
      source: "notes",
      priority: "low",
      title: "Organizar suas notas",
      description: "Você tem 12 notas sem categoria. Classifique e encontre tudo com mais rapidez.",
      actionOptions: [{ label: "Organizar em 3 pastas", action: "organize_notes_folders" }],
      metrics: [{ icon: "note", label: "12 notas sem categoria" }, { icon: "layers", label: "Sugestão: 3 categorias" }],
      items: ["Ideias soltas → Pessoal", "Resumo do curso → Estudos", "Pauta do cliente → Trabalho"],
      impact: { label: "Pastas", value: "Trabalho, Estudos, Pessoal" },
    }];
    fetchedAt = Date.now();
    render();
    setStatus("Simulação do preview — nenhuma alteração será salva.");
    setPreview("3 sugestões simuladas para validar a experiência.");
  }

  function isVisible() {
    return ["autopilotView", "dashboardView"].some((id) =>
      document.getElementById(id)?.classList.contains("active-view"));
  }

  function setStatus(message) {
    if (status) status.textContent = message;
    if (typeof status?.classList?.toggle === "function") status.classList.toggle("is-quiet", /encontrad[ao]s?\.$|^Buscando|^Carregando/.test(String(message)));
  }

  function setPreview(message) {
    if (preview) preview.textContent = message;
    if (dashboardPreview) dashboardPreview.textContent = message;
  }

  function renderDashboardSuggestion() {
    if (!dashboardCard) return;
    dashboardCard.replaceChildren();
    const suggestion = suggestions[0];
    if (!suggestion) {
      const empty = makeTextElement("div", "pulse-dashboard-suggestion", "");
      empty.append(
        makeTextElement("h3", "", "Tudo em ordem por enquanto"),
        makeTextElement("p", "", "Quando surgir uma prioridade verificável, ela aparecerá aqui para você decidir."),
      );
      dashboardCard.append(empty);
      return;
    }

    const content = makeTextElement("div", "pulse-dashboard-suggestion", "");
    content.append(
      makeTextElement("h3", "", suggestion.title),
      makeTextElement("p", "", suggestion.description || suggestion.reason),
    );
    const actions = makeTextElement("div", "pulse-dashboard-suggestion-actions", "");
    for (const [index, option] of (suggestion.actionOptions || []).slice(0, 2).entries()) {
      if (!option?.action) continue;
      const button = makeTextElement("button", index === 0 ? "primary" : "secondary", option.label || "Revisar");
      button.type = "button";
      button.addEventListener("click", () => confirmAction(suggestion, option));
      actions.append(button);
    }
    const open = makeTextElement("button", "secondary", `Abrir ${AREA_LABELS[suggestion.source] || AREA_LABELS[suggestion.area] || "área"}`);
    open.type = "button";
    open.addEventListener("click", () => openArea(suggestion.source || suggestion.area));
    actions.append(open);
    content.append(actions);
    dashboardCard.append(content);
  }

  function renderEmpty(title, description) {
    if (!list) return;
    list.replaceChildren();
    const empty = makeTextElement("div", "autopilot-empty", "");
    empty.append(
      makeTextElement("strong", "", title),
      makeTextElement("p", "", description),
    );
    list.append(empty);
  }

  function chatPanel() {
    return document.getElementById("bdChat");
  }

  function closeConfirm() {
    if (modal) modal.hidden = true;
    pendingAction = null;
    if (applyButton) applyButton.disabled = false;
    chatPanel()?.classList?.remove("has-ap-confirm");
    focusBeforeModal?.focus?.();
    focusBeforeModal = null;
  }

  // No computador o cartão de confirmação fica dentro do painel do Pulsinho
  // (como no quadro); no celular/tablet vira uma folha inferior.
  function placeConfirm() {
    if (!modal || typeof window === "undefined") return;
    const chat = chatPanel();
    const docked = Boolean(window.matchMedia?.("(min-width: 1181px)").matches && chat?.closest?.("#apChatSlot")
      && document.getElementById("autopilotView")?.classList.contains("active-view"));
    modal.classList?.toggle("is-docked", docked);
    chat?.classList?.toggle("has-ap-confirm", docked);
    if (docked) {
      const form = chat.querySelector?.(".bd-chat-form");
      if (modal.parentElement !== chat) chat.insertBefore(modal, form || null);
    } else if (document.body && modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
  }

  function confirmAction(suggestion, option) {
    if (!modal || !option?.action) return;
    pendingAction = { suggestionId: suggestion.id, action: option.action };
    focusBeforeModal = document.activeElement;
    const title = document.getElementById("autopilotConfirmTitle");
    if (title) title.textContent = "Confirmar ação?";
    const sub = document.getElementById("apConfirmSub");
    if (sub) sub.textContent = option.label || suggestion.title;
    modalDescription.textContent = actionSentence(suggestion, option);
    const rows = document.getElementById("apConfirmRows");
    if (rows) {
      const list = [];
      if (suggestion.impact?.value) list.push({ icon: suggestion.source === "finances" ? "wallet" : "check", ...suggestion.impact });
      if (suggestion.metadata?.monthly && option.action === "pause_subscription_recurrents") list.push({ icon: "bars", label: "Impacto", value: `Redução de ${money(suggestion.metadata.monthly)}/mês` });
      else if (suggestion.metadata?.monthly) list.push({ icon: "bars", label: "Impacto", value: `Até ${money(suggestion.metadata.monthly)}/mês a menos` });
      rows.innerHTML = list.map((row) => `<li><span>${icon(row.icon)}${escapeText(row.label)}</span><b class="${row.tone === "positive" ? "is-pos" : row.tone === "negative" ? "is-neg" : ""}">${escapeText(row.value)}</b></li>`).join("");
      rows.hidden = !list.length;
    }
    placeConfirm();
    modal.hidden = false;
    (applyButton || document.getElementById("autopilotConfirmCancel"))?.focus?.();
  }

  function openDetail(suggestion) {
    const detail = document.getElementById("apDetailModal");
    const body = document.getElementById("apDetailBody");
    if (!detail || !body) return;
    const area = suggestion.source || suggestion.area;
    const areaEl = document.getElementById("apDetailArea");
    if (areaEl) areaEl.textContent = `${AREA_LABELS[area] || "PulseNote"} · prioridade ${displayPriority(suggestion.priority).label.toLowerCase()}`;
    const titleEl = document.getElementById("apDetailTitle");
    if (titleEl) titleEl.textContent = suggestion.title;
    const metrics = (suggestion.metrics || []).map((metric) => `<li>${icon(METRIC_ICONS[metric.icon] || metric.icon || "info")}<span>${escapeText(metric.label)}</span>${metric.value ? `<b class="${metric.tone === "positive" ? "is-pos" : metric.tone === "negative" ? "is-neg" : ""}">${escapeText(metric.value)}</b>` : ""}</li>`).join("");
    const items = (suggestion.items || []).map((item) => `<li>${escapeText(item)}</li>`).join("");
    const options = (suggestion.actionOptions || []).filter((option) => option?.action)
      .map((option, index) => `<button type="button" class="ap-btn ${index === 0 ? "ap-btn--primary" : "ap-btn--ghost"}" data-ap-option="${index}">${index === 0 ? icon("check") : ""}<span>${escapeText(option.label)}</span></button>`).join("");
    body.innerHTML = `<p class="ap-detail-reason">${escapeText(suggestion.description || suggestion.reason)}</p>
      ${metrics ? `<ul class="ap-metrics">${metrics}</ul>` : ""}
      ${items ? `<div class="ap-detail-items"><span>O que foi considerado</span><ul>${items}</ul></div>` : ""}
      <div class="ap-detail-actions">${options}<button type="button" class="ap-btn ap-btn--ghost" data-ap-open>${icon("arrow-right")}<span>Abrir ${escapeText(AREA_LABELS[area] || "área")}</span></button></div>`;
    body.onclick = (event) => {
      const optionButton = event.target.closest("[data-ap-option]");
      if (optionButton) {
        detail.hidden = true;
        confirmAction(suggestion, suggestion.actionOptions.filter((option) => option?.action)[Number(optionButton.dataset.apOption)]);
      } else if (event.target.closest("[data-ap-open]")) {
        detail.hidden = true;
        openArea(area);
      }
    };
    detail.hidden = false;
    detail.querySelector?.("#apDetailClose")?.focus?.();
  }

  function updateFilters() {
    const counts = { all: suggestions.length, finances: 0, planner: 0, notes: 0 };
    for (const item of suggestions) {
      const area = item.source || item.area;
      if (area in counts) counts[area] += 1;
    }
    if (filter !== "all" && !counts[filter]) filter = "all";
    for (const el of document.querySelectorAll?.("[data-ap-count]") || []) el.textContent = String(counts[el.dataset.apCount] || 0);
    for (const button of document.querySelectorAll?.("[data-ap-filter]") || []) {
      const active = button.dataset.apFilter === filter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = button.dataset.apFilter !== "all" && !counts[button.dataset.apFilter];
    }
  }

  function render() {
    if (!list) return;
    list.replaceChildren();
    updateFilters();
    if (!suggestions.length) {
      renderEmpty("Tudo em ordem por enquanto", "Quando houver algo útil e verificável para fazer, o Pulsinho mostra aqui.");
      setStatus("Nenhuma prioridade pendente agora.");
      setPreview("Nenhuma ação pendente por enquanto.");
      renderDashboardSuggestion();
      return;
    }

    setStatus(`${suggestions.length} ${suggestions.length === 1 ? "sugestão encontrada" : "sugestões encontradas"}.`);
    setPreview(`${suggestions.length} ${suggestions.length === 1 ? "sugestão prática para você" : "sugestões práticas para você"}.`);
    for (const suggestion of suggestions) {
      const area = suggestion.source || suggestion.area;
      if (filter !== "all" && area !== filter) continue;
      const card = makeTextElement("article", "ap-card", "");
      card.dataset.area = area || "other";
      const top = makeTextElement("div", "ap-card-top", "");
      const source = AREA_LABELS[area] || "PulseNote";
      const areaEl = makeTextElement("span", "ap-area", "");
      areaEl.innerHTML = `<span class="ap-area-ico">${icon(AREA_ICONS[area] || "sparkle")}</span>${escapeText(source)}`;
      const priority = displayPriority(suggestion.priority);
      const priorityEl = makeTextElement("span", "ap-prio", priority.label);
      priorityEl.dataset.priority = priority.key;
      top.append(areaEl, priorityEl);
      card.append(top);
      card.append(makeTextElement("h4", "ap-card-title", suggestion.title));
      card.append(makeTextElement("p", "ap-card-text", suggestion.description || suggestion.reason));

      const metrics = (suggestion.metrics || []).slice(0, 2);
      if (metrics.length) {
        const metricsEl = makeTextElement("ul", "ap-metrics", "");
        metricsEl.innerHTML = metrics.map((metric) => `<li>${icon(METRIC_ICONS[metric.icon] || metric.icon || "info")}<span>${escapeText(metric.label)}</span>${metric.value ? `<b class="${metric.tone === "positive" ? "is-pos" : metric.tone === "negative" ? "is-neg" : ""}">${escapeText(metric.value)}</b>` : ""}</li>`).join("");
        card.append(metricsEl);
      }

      const actions = makeTextElement("div", "ap-card-actions", "");
      const details = makeTextElement("button", "ap-btn ap-btn--ghost", "Ver detalhes");
      details.type = "button";
      details.addEventListener("click", () => openDetail(suggestion));
      actions.append(details);
      const primary = (suggestion.actionOptions || []).find((option) => option?.action);
      if (primary) {
        const run = makeTextElement("button", "ap-btn ap-btn--primary", "");
        run.type = "button";
        run.innerHTML = `${icon("check")}<span>Executar</span>`;
        run.title = primary.label || "Executar";
        run.addEventListener("click", () => confirmAction(suggestion, primary));
        actions.append(run);
      }
      card.append(actions);
      list.append(card);
    }
    renderDashboardSuggestion();
  }

  async function readJson(response) {
    try { return await response.json(); } catch { return {}; }
  }

  function accessMessage(code) {
    if (code === "plan" || code === "plan_required") return "O Autopilot não está incluído no plano atual. Revise seu plano em Configurações para ativá-lo.";
    if (code === "paused" || code === "expired" || code === "inactive_plan") return "Sua assinatura não está ativa. O restante dos seus dados continua disponível normalmente.";
    if (code === "feature_disabled") return "O Autopilot foi pausado pelo administrador do PulseNote.";
    if (code === "maintenance") return "O Autopilot está em manutenção. Nenhum dado foi alterado.";
    if (code === "unauthorized") return "Sua sessão expirou. Entre novamente para carregar suas prioridades.";
    return "Não foi possível consultar suas prioridades agora. Tente novamente em instantes.";
  }

  async function load({ force = false } = {}) {
    if (!getToken()) return;
    if (isDesignPreview()) {
      loadDesignPreviewSuggestion();
      return;
    }
    if (!force && fetchedAt && Date.now() - fetchedAt < 60_000) return;
    // A leitura em andamento pode ter começado antes de uma mudança vinda do
    // WhatsApp. Depois dela terminar, uma atualização forçada precisa fazer
    // uma nova leitura, nunca reutilizar a resposta antiga.
    if (pendingLoad) {
      if (!force) return pendingLoad;
      if (!queuedReload) {
        queuedReload = pendingLoad.then(() => {
          queuedReload = null;
          return isVisible() ? load({ force: true }) : undefined;
        }, (error) => {
          queuedReload = null;
          throw error;
        });
      }
      return queuedReload;
    }
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    const serial = ++requestSerial;
    pendingSerial = serial;
    setStatus("Buscando prioridades reais…");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    pendingLoad = (async () => {
      try {
        const token = await getToken()?.getIdToken();
        if (!token) return;
        const response = await fetch("/api/autopilot", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const body = await readJson(response);
        if (!response.ok) {
          const error = new Error(accessMessage(body.error));
          error.code = body.error;
          error.status = response.status;
          throw error;
        }
        if (serial !== requestSerial) return;
        suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
        fetchedAt = Date.now();
        render();
      } catch (error) {
        if (serial !== requestSerial) return;
        const detail = accessMessage(error?.code);
        setStatus(detail);
        setPreview(detail);
        if (dashboardCard) {
          dashboardCard.replaceChildren();
          const errorState = makeTextElement("div", "pulse-dashboard-suggestion", "");
          errorState.append(
            makeTextElement("h3", "", error?.code === "plan" ? "Autopilot não incluído no plano" : "Autopilot indisponível"),
            makeTextElement("p", "", detail),
          );
          dashboardCard.append(errorState);
        }
        if (!suggestions.length) renderEmpty("Não foi possível mostrar sugestões", detail);
        console.warn("Pulse Autopilot indisponível:", error);
      } finally {
        clearTimeout(timeout);
        pendingLoad = null;
      }
    })();
    return pendingLoad;
  }

  async function executeConfirmed() {
    if (!pendingAction || !applyButton) return;
    if (isDesignPreview()) {
      suggestions = suggestions.filter((item) => item.id !== pendingAction.suggestionId);
      closeConfirm();
      render();
      notify("Simulação concluída no preview. Nenhum dado real foi alterado.");
      return;
    }
    const action = pendingAction;
    applyButton.disabled = true;
    try {
      const token = await getToken()?.getIdToken();
      if (!token) throw new Error("Sua sessão expirou. Entre novamente.");
      const response = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...action, confirm: true }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.message || body.error || "Não foi possível concluir esta ação.");
      closeConfirm();
      notify(body.result?.message || "Ação concluída. Seus dados foram atualizados.");
      fetchedAt = 0;
      await load({ force: true });
    } catch (error) {
      applyButton.disabled = false;
      modalDescription.textContent = error.message || "Falha ao executar. Tente novamente.";
    }
  }

  function bind() {
    bound = true;
    document.getElementById("autopilotRefresh")?.addEventListener("click", () => load({ force: true }));
    document.getElementById("autopilotConfirmCancel")?.addEventListener("click", closeConfirm);
    document.getElementById("autopilotConfirmClose")?.addEventListener("click", closeConfirm);
    applyButton?.addEventListener("click", executeConfirmed);
    modal?.addEventListener("click", (event) => { if (event.target === modal) closeConfirm(); });
    const detail = document.getElementById("apDetailModal");
    document.getElementById("apDetailClose")?.addEventListener("click", () => { if (detail) detail.hidden = true; });
    detail?.addEventListener("click", (event) => { if (event.target === detail) detail.hidden = true; });
    for (const button of document.querySelectorAll?.("[data-ap-filter]") || []) {
      button.addEventListener("click", () => { filter = button.dataset.apFilter; render(); });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (modal && !modal.hidden) closeConfirm();
      if (detail && !detail.hidden) detail.hidden = true;
    });
  }

  function invalidate() {
    fetchedAt = 0;
    // Descarta qualquer GET iniciado antes do snapshot. O próprio GET não
    // escreve no Firestore, então esta atualização não causa um novo ciclo.
    requestSerial++;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!bound || !isVisible()) return;
    // Snapshots consecutivos (cache, servidor e eco de gravação) viram uma
    // única busca. Se houver GET pendente, load(force) aguarda sua conclusão.
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (isVisible()) void load({ force: true });
    }, 500);
  }
  function show() { return load({ force: Boolean(pendingLoad && pendingSerial !== requestSerial) }); }
  return { bind, load, invalidate, show };
}
