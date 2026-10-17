const AREA_LABELS = {
  finances: "Finanças",
  planner: "Planner",
  notes: "Notas",
};

function displayPriority(priority) {
  const value = String(priority || "").toLowerCase();
  if (value === "high" || value === "alta" || value === "urgent") return { label: "Prioridade alta", key: "high" };
  if (value === "medium" || value === "media" || value === "média") return { label: "Prioridade média", key: "medium" };
  return { label: "Sugestão", key: "low" };
}

function makeTextElement(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = String(value || "");
  return el;
}

export function createAutopilotUI({ getToken, openArea, notify }) {
  const list = document.getElementById("autopilotList");
  const status = document.getElementById("autopilotStatus");
  const preview = document.getElementById("autopilotPreview");
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

  function isVisible() {
    return ["autopilotView", "dashboardView"].some((id) =>
      document.getElementById(id)?.classList.contains("active-view"));
  }

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  function setPreview(message) {
    if (preview) preview.textContent = message;
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

  function closeConfirm() {
    if (modal) modal.hidden = true;
    pendingAction = null;
    if (applyButton) applyButton.disabled = false;
    focusBeforeModal?.focus?.();
    focusBeforeModal = null;
  }

  function confirmAction(suggestion, option) {
    if (!modal || !option?.action) return;
    pendingAction = { suggestionId: suggestion.id, action: option.action };
    focusBeforeModal = document.activeElement;
    modalDescription.textContent = `Deseja ${String(option.label || "executar esta ação").toLowerCase()} para “${suggestion.title}”? O PulseNote só fará essa alteração depois que você confirmar.`;
    modal.hidden = false;
    document.getElementById("autopilotConfirmCancel")?.focus();
  }

  function render() {
    if (!list) return;
    list.replaceChildren();
    if (!suggestions.length) {
      renderEmpty("Tudo em ordem por enquanto", "Quando houver algo útil e verificável para fazer, o Pulsinho mostra aqui.");
      setStatus("Nenhuma prioridade pendente agora.");
      setPreview("Nenhuma ação pendente por enquanto.");
      return;
    }

    setStatus(`${suggestions.length} ${suggestions.length === 1 ? "sugestão encontrada" : "sugestões encontradas"}.`);
    setPreview(`${suggestions.length} ${suggestions.length === 1 ? "sugestão prática para você" : "sugestões práticas para você"}.`);
    for (const suggestion of suggestions) {
      const card = makeTextElement("article", "autopilot-card", "");
      const top = makeTextElement("div", "autopilot-card-top", "");
      const source = AREA_LABELS[suggestion.source] || AREA_LABELS[suggestion.area] || "PulseNote";
      const priority = displayPriority(suggestion.priority);
      const priorityEl = makeTextElement("span", "autopilot-priority", priority.label);
      priorityEl.dataset.priority = priority.key;
      top.append(makeTextElement("span", "autopilot-area", source), priorityEl);
      card.append(top);
      card.append(makeTextElement("h3", "", suggestion.title));
      card.append(makeTextElement("p", "", suggestion.description || suggestion.reason));

      const actions = makeTextElement("div", "autopilot-card-actions", "");
      for (const [index, option] of (suggestion.actionOptions || []).entries()) {
        if (!option?.action) continue;
        const button = makeTextElement("button", index === 0 ? "autopilot-action-primary" : "autopilot-action-secondary", option.label || "Executar");
        button.type = "button";
        button.addEventListener("click", () => confirmAction(suggestion, option));
        actions.append(button);
      }
      const openButton = makeTextElement("button", "autopilot-action-secondary", `Abrir ${source}`);
      openButton.type = "button";
      openButton.addEventListener("click", () => openArea(suggestion.source || suggestion.area));
      actions.append(openButton);
      card.append(actions);
      list.append(card);
    }
  }

  async function readJson(response) {
    try { return await response.json(); } catch { return {}; }
  }

  async function load({ force = false } = {}) {
    if (!getToken()) return;
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
        if (!response.ok) throw new Error(body.message || body.error || `Serviço indisponível (${response.status}).`);
        if (serial !== requestSerial) return;
        suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
        fetchedAt = Date.now();
        render();
      } catch (error) {
        if (serial !== requestSerial) return;
        setStatus("Não foi possível carregar as sugestões agora.");
        setPreview("Sugestões indisponíveis neste momento.");
        if (!suggestions.length) renderEmpty("Sugestões indisponíveis", "Tente atualizar quando a conexão estiver estável.");
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
      notify("Ação concluída. Seus dados foram atualizados.");
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
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal && !modal.hidden) closeConfirm();
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
