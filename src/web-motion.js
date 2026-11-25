/* PulseNote — movimento da versão de navegador (web-motion.js)
   Par do web.css. Não depende do app.js: observa o que ele já faz
   (body[data-active-view], .active nos itens da barra, data-theme) e
   acrescenta os momentos de movimento por cima.
   - Indicador que desliza na barra lateral + barra recolhível ( [ )
   - Atalhos: G e depois I/P/N/F/A/C para trocar de área, ? para a lista
   - Topo que se compacta ao rolar e linha de progresso ao trocar de área
   - Números de dinheiro que contam até o valor ao abrir a área
   - Blocos que entram ao aparecer na rolagem
   - Brilho que acompanha o cursor nos cartões
   - Troca de tema com revelação circular (View Transitions)
   Tudo desliga com "reduzir movimento" — do aparelho ou escolhido no app
   (Configurações → Aparência → Movimento). */
(() => {
  "use strict";
  const doc = document;
  const root = doc.documentElement;

  // ── Preferência de movimento do próprio app ──────────────────
  // "auto" segue o aparelho; "full" mantém as animações mesmo quando o
  // sistema pede menos movimento (no Windows, "Efeitos de animação"
  // desligado faz o navegador pedir isso e o app ficava parado);
  // "reduced" desliga mesmo com o aparelho animando.
  const MOTION_KEY = "pulsenote-motion";
  const readMotion = () => { try { const v = localStorage.getItem(MOTION_KEY); return v === "full" || v === "reduced" ? v : "auto"; } catch { return "auto"; } };
  let motionPref = readMotion();
  const nativeMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : null;
  function fakeList(media, matches) {
    return { media, matches, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } };
  }
  // Todo o app (app.js e este arquivo) pergunta ao navegador por
  // "prefers-reduced-motion"; a resposta passa a respeitar a escolha.
  if (nativeMatchMedia) {
    window.matchMedia = (query) => {
      const q = String(query);
      if (motionPref !== "auto" && q.includes("prefers-reduced-motion")) {
        const wantsReduce = motionPref === "reduced";
        return fakeList(q, /reduce/.test(q) ? wantsReduce : !wantsReduce);
      }
      return nativeMatchMedia(q);
    };
  }
  // As folhas de estilo também: as regras @media de movimento são
  // religadas/desligadas conforme a escolha.
  const originalMedia = new WeakMap();
  function retuneRules(rules) {
    for (const rule of rules) {
      if (rule.media && rule.cssRules) {
        if (!originalMedia.has(rule)) originalMedia.set(rule, rule.media.mediaText);
        const orig = originalMedia.get(rule);
        if (/prefers-reduced-motion/.test(orig)) {
          const isReduce = /prefers-reduced-motion:\s*reduce/.test(orig);
          let next = orig;
          if (motionPref === "full") next = isReduce ? "not all" : orig.replace(/\(\s*prefers-reduced-motion:\s*no-preference\s*\)/g, "(min-width: 0px)");
          if (motionPref === "reduced") next = isReduce ? orig.replace(/\(\s*prefers-reduced-motion:\s*reduce\s*\)/g, "(min-width: 0px)") : "not all";
          if (rule.media.mediaText !== next) rule.media.mediaText = next;
        }
      }
      if (rule.cssRules) retuneRules(rule.cssRules);
    }
  }
  function retuneSheets() {
    for (const sheet of doc.styleSheets) {
      let rules = null;
      try { rules = sheet.cssRules; } catch { continue; } // folhas de outro domínio
      if (rules) retuneRules(rules);
    }
  }
  function setMotion(pref, { save = true } = {}) {
    motionPref = pref;
    root.dataset.motion = pref;
    if (save) { try { localStorage.setItem(MOTION_KEY, pref); } catch { /* sem armazenamento */ } }
    retuneSheets();
    doc.dispatchEvent(new CustomEvent("pn:motion", { detail: pref }));
  }
  root.dataset.motion = motionPref;
  retuneSheets();
  // Estilos que chegam depois (avisos, banners) também seguem a escolha.
  new MutationObserver(() => retuneSheets()).observe(doc.head, { childList: true });
  addEventListener("load", retuneSheets, { once: true });
  window.pnSetMotion = setMotion;

  const mq = (q) => { try { return window.matchMedia(q); } catch { return { matches: false, addEventListener() {} }; } };
  const desktop = mq("(min-width: 761px)");
  const finePointer = mq("(hover: hover) and (pointer: fine)");
  const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SIDE_KEY = "pulsenote-side-collapsed";

  // Último ponto tocado/clicado: origem da revelação circular do tema.
  let lastPoint = { x: innerWidth / 2, y: 80 };
  doc.addEventListener("pointerdown", (e) => { lastPoint = { x: e.clientX, y: e.clientY }; }, { capture: true, passive: true });

  // ── Troca de tema com revelação circular ─────────────────────
  // app.js chama window.pnWithThemeTransition(run) quando existe.
  window.pnWithThemeTransition = (run) => {
    const before = root.getAttribute("data-theme");
    if (calm() || typeof doc.startViewTransition !== "function") { run(); return; }
    let changed = false;
    const t = doc.startViewTransition(() => { run(); changed = root.getAttribute("data-theme") !== before; });
    t.ready.then(() => {
      if (!changed) return;
      const { x, y } = lastPoint;
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 620, easing: "cubic-bezier(.22, 1, .36, 1)", pseudoElement: "::view-transition-new(root)" }
      );
    }).catch(() => {});
  };

  function ready(fn) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  }

  ready(() => {
    const nav = doc.querySelector(".bd-sidebar .bd-nav");
    const sidebar = doc.querySelector(".bd-sidebar");
    const topbar = doc.querySelector(".bd-topbar");
    if (!nav || !sidebar || !topbar) return;

    // ── Barra lateral: indicador que desliza ────────────────────
    const ink = doc.createElement("i");
    ink.className = "pn-nav-ink is-off";
    ink.setAttribute("aria-hidden", "true");
    nav.prepend(ink);
    nav.classList.add("has-ink");
    let inkPlaced = false;
    function moveInk({ instant = false } = {}) {
      const active = nav.querySelector(".bd-nav-item.active");
      // toggle() só com mudança real: reescrever a classe gera registro de
      // mutação, e o observador da barra entraria em laço.
      const off = !active || !active.offsetParent;
      if (ink.classList.contains("is-off") !== off) ink.classList.toggle("is-off", off);
      if (off) return;
      if (instant || !inkPlaced || calm()) ink.style.transition = "none";
      ink.style.setProperty("--pn-ink-y", `${active.offsetTop}px`);
      ink.style.height = `${active.offsetHeight}px`;
      ink.style.width = `${active.offsetWidth}px`;
      ink.style.left = `${active.offsetLeft}px`;
      if (ink.style.transition === "none") requestAnimationFrame(() => requestAnimationFrame(() => { ink.style.transition = ""; }));
      inkPlaced = true;
    }

    // Atalhos nos itens + dica de nome para a barra recolhida
    const KEYS = { dashboard: "i", planner: "p", notes: "n", finances: "f", autopilot: "a", settings: "c" };
    doc.querySelectorAll(".bd-sidebar [data-nav]").forEach((item) => {
      const label = item.querySelector("span")?.textContent.trim();
      if (label) item.dataset.tip = label;
      const key = KEYS[item.dataset.view];
      if (key && !item.querySelector(".pn-kbd")) {
        const k = doc.createElement("span");
        k.className = "pn-kbd";
        k.setAttribute("aria-hidden", "true");
        k.innerHTML = `<kbd>G</kbd><kbd>${key}</kbd>`;
        item.append(k);
        item.setAttribute("aria-keyshortcuts", `G ${key.toUpperCase()}`);
      }
    });

    // ── Barra recolhível ────────────────────────────────────────
    const brand = sidebar.querySelector(".bd-brand");
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "pn-side-toggle";
    toggle.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-chev-left"/></svg>';
    if (!doc.getElementById("i-chev-left")) toggle.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>';
    brand?.after(toggle);
    function setCollapsed(on, { save = true } = {}) {
      root.classList.toggle("pn-side-collapsed", on);
      toggle.setAttribute("aria-label", on ? "Expandir barra lateral" : "Recolher barra lateral");
      toggle.setAttribute("aria-expanded", String(!on));
      toggle.title = `${on ? "Expandir" : "Recolher"} barra ( [ )`;
      if (save) { try { localStorage.setItem(SIDE_KEY, on ? "1" : "0"); } catch { /* sem armazenamento */ } }
      // O indicador acompanha a largura nova quando a transição termina.
      setTimeout(() => moveInk({ instant: true }), calm() ? 0 : 440);
    }
    let savedCollapsed = false;
    try { savedCollapsed = localStorage.getItem(SIDE_KEY) === "1"; } catch { /* idem */ }
    setCollapsed(savedCollapsed, { save: false });
    toggle.addEventListener("click", () => setCollapsed(!root.classList.contains("pn-side-collapsed")));

    // ── Topo: chip ⌘K e linha de progresso ─────────────────────
    const actions = doc.querySelector("#bdTopActions");
    const searchLabel = actions?.querySelector(".bd-search");
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    function openPalette() {
      doc.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: !isMac, metaKey: isMac, bubbles: true }));
    }
    if (actions && searchLabel) {
      const chip = doc.createElement("button");
      chip.type = "button";
      chip.className = "pn-kbd-chip";
      chip.setAttribute("aria-label", "Buscar em tudo");
      chip.setAttribute("aria-keyshortcuts", isMac ? "Meta+K" : "Control+K");
      chip.innerHTML = `<svg class="i" aria-hidden="true"><use href="#i-search"/></svg><span>Buscar</span><kbd>${isMac ? "⌘" : "Ctrl"}</kbd><kbd>K</kbd>`;
      chip.addEventListener("click", openPalette);
      searchLabel.before(chip);
    }
    const routeBar = doc.createElement("i");
    routeBar.className = "pn-route-bar";
    routeBar.setAttribute("aria-hidden", "true");
    topbar.append(routeBar);

    // Topo ao rolar (todas as larguras). Com folga entre ligar e desligar
    // para o topo não "piscar" quando a rolagem para perto do limite.
    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const on = doc.body.classList.contains("pn-scrolled");
        if (!on && scrollY > 16) doc.body.classList.add("pn-scrolled");
        else if (on && scrollY < 4) doc.body.classList.remove("pn-scrolled");
      });
    }
    addEventListener("scroll", onScroll, { passive: true });

    // ── Números que contam ─────────────────────────────────────
    const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
    const MONEY = /^\s*([+\-\u2212]?)\s*R\$\s?([\d.]+,\d{2})\s*$/;
    function countUp(el) {
      const text = el.textContent;
      const m = MONEY.exec(text);
      if (!m) return;
      const sign = m[1] === "-" || m[1] === "−" ? -1 : 1;
      const target = sign * Number(m[2].replace(/\./g, "").replace(",", "."));
      if (!Number.isFinite(target) || Math.abs(target) < 1) return;
      const prefix = m[1] === "+" ? "+" : "";
      const fmt = (v) => prefix + brl.format(v).replace(/ /g, " ");
      const sample = fmt(target);
      // Só anima se o formato bater com o que o app escreveu (não mexe em
      // valores com abreviações ou textos próprios).
      if (sample.replace(/\s/g, "") !== text.replace(/\s/g, "").replace("−", "-")) return;
      const dur = 900;
      const t0 = performance.now();
      let last = null;
      el.classList.add("pn-counting");
      const step = (now) => {
        // Se o app reescreveu o valor no meio, ele manda.
        if (last !== null && el.textContent !== last) { el.classList.remove("pn-counting"); return; }
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 4);
        last = p < 1 ? fmt(target * eased) : text;
        el.textContent = last;
        if (p < 1) requestAnimationFrame(step);
        else el.classList.remove("pn-counting");
      };
      requestAnimationFrame(step);
    }
    const COUNT_SEL = ".bd-kpi-body strong, .bf-kpi-body > strong, .overview-value, .pfx-stat strong, .pfx-stat-value";
    function countView(view) {
      if (calm() || !view) return;
      view.querySelectorAll(COUNT_SEL).forEach((el) => { if (el.getClientRects().length) countUp(el); });
    }

    // ── Entrada dos blocos ao rolar ─────────────────────────────
    const REVEAL_SEL = ".bd-card, .bn-card";
    let io = null;
    function armReveal(view) {
      io?.disconnect();
      if (calm() || !view || typeof IntersectionObserver !== "function") return;
      const vh = innerHeight;
      const pending = [...view.querySelectorAll(REVEAL_SEL)].filter((el) => {
        if (!el.getClientRects().length) return false;
        if (el.closest(".bd-card") !== el && el.parentElement?.closest(".bd-card")) return false; // só o cartão de fora
        const r = el.getBoundingClientRect();
        return r.top > vh; // ainda abaixo da dobra
      });
      if (!pending.length) return;
      io = new IntersectionObserver((entries) => {
        let i = 0;
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          cascadeRows(entry.target, 160);
          entry.target.animate(
            [{ opacity: 0, transform: "translateY(18px) scale(.985)" }, { opacity: 1, transform: "none" }],
            { duration: 560, delay: Math.min(i++, 4) * 60, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "backwards" }
          );
        });
      }, { rootMargin: "0px 0px 60px 0px" });
      pending.forEach((el) => io.observe(el));
    }

    // ── Brilho que acompanha o cursor ───────────────────────────
    // Só uma classe + duas variáveis: o brilho é um ::after do próprio
    // cartão (web.css), sem inserir nada no conteúdo que o app redesenha.
    const SPOT_SKIP = ".bd-chat, .modal-card, .fin-form-card, .pf-hero";
    let spotCard = null;
    doc.addEventListener("pointermove", (e) => {
      if (!finePointer.matches || !desktop.matches || calm()) return;
      const card = e.target.closest?.(".bd-card");
      if (card !== spotCard) {
        spotCard?.classList.remove("pn-spot");
        spotCard = card && !card.matches(SPOT_SKIP) ? card : null;
        spotCard?.classList.add("pn-spot");
      }
      if (!spotCard) return;
      const r = spotCard.getBoundingClientRect();
      spotCard.style.setProperty("--mx", `${Math.round(e.clientX - r.left)}px`);
      spotCard.style.setProperty("--my", `${Math.round(e.clientY - r.top)}px`);
    }, { passive: true });
    doc.addEventListener("pointerleave", () => { spotCard?.classList.remove("pn-spot"); spotCard = null; });

    // ── Troca de área ───────────────────────────────────────────
    const title = doc.querySelector("#viewTitle");
    const subtitle = doc.querySelector("#viewSubtitle");
    let current = doc.body.dataset.activeView || doc.querySelector(".view.active-view")?.id.replace(/View$/, "");
    function replay(el, cls) {
      if (!el || calm()) return;
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
    }
    function onViewChange(view) {
      if (!view || view === current) return;
      current = view;
      moveInk();
      if (desktop.matches) replay(routeBar, "run");
      replay(title, "pn-title-in");
      replay(subtitle, "pn-title-in");
      const section = doc.getElementById(`${view}View`);
      requestAnimationFrame(() => { countView(section); armReveal(section); armSegs(section); cascadeRows(section, 180); });
    }
    new MutationObserver(() => {
      const v = doc.body.dataset.activeView || doc.querySelector(".view.active-view")?.id.replace(/View$/, "");
      onViewChange(v);
    }).observe(doc.body, { attributes: true, attributeFilter: ["data-active-view"] });
    // Reserva: alguns caminhos só trocam a classe do item da barra.
    // (Só os itens da barra — nunca o próprio indicador.)
    const navObserver = new MutationObserver((records) => {
      if (!records.some((r) => r.target !== ink)) return;
      const v = nav.querySelector(".bd-nav-item.active")?.dataset.view;
      if (v) onViewChange(v); else moveInk();
    });
    nav.querySelectorAll(".bd-nav-item").forEach((item) => navObserver.observe(item, { attributes: true, attributeFilter: ["class"] }));

    // Primeira pintura: indicador no lugar, sem animar; números contam
    // quando os dados chegam (a tela de abertura sai).
    requestAnimationFrame(() => moveInk({ instant: true }));
    addEventListener("resize", () => moveInk({ instant: true }), { passive: true });
    doc.fonts?.ready?.then(() => moveInk({ instant: true }));
    const overlay = doc.getElementById("appLoadingOverlay");
    const firstCount = () => {
      const section = doc.querySelector(".view.active-view");
      countView(section);
      armReveal(section);
      cascadeRows(section, 200);
    };
    if (overlay && !overlay.hidden && overlay.isConnected) {
      const mo = new MutationObserver(() => {
        if (!overlay.isConnected || overlay.hidden || overlay.classList.contains("is-leaving") || overlay.classList.contains("hidden")) {
          mo.disconnect();
          setTimeout(firstCount, 120);
        }
      });
      mo.observe(overlay, { attributes: true });
      mo.observe(overlay.parentNode, { childList: true });
    } else {
      setTimeout(firstCount, 300);
    }

    // ── Destaque que desliza entre as linhas de uma lista ───────
    // Um único "fundo" por lista corre até a linha sob o mouse, em vez de
    // cada linha acender sozinha.
    const ROW_SEL = ".bd-list li, .bf-tx, .bf-mini, .bd-agenda .bd-ag, .bp-task, .bf-brow, .bf-row, .bf-member, .bf-arow, .bf-rrow, .bf-srow, .bd-res-row, .pfx-row";
    let hotRow = null;
    function rowPill(host) {
      let pill = host.querySelector(":scope > .pn-row-pill");
      if (!pill) {
        pill = doc.createElement("i");
        pill.className = "pn-row-pill snap";
        pill.setAttribute("aria-hidden", "true");
        host.prepend(pill);
        host.classList.add("pn-row-host");
      }
      return pill;
    }
    function markIcon(row) {
      const first = row.firstElementChild;
      if (first && !first.classList.contains("pn-ico") && first.offsetWidth && first.offsetWidth <= 48 && first.offsetHeight <= 48) first.classList.add("pn-ico");
    }
    function lightRow(row) {
      const host = row.parentElement;
      if (!host) return;
      const pill = rowPill(host);
      const fresh = !pill.classList.contains("on");
      if (hotRow && hotRow !== row) hotRow.classList.remove("pn-hot");
      hotRow = row;
      row.classList.add("pn-hot");
      markIcon(row);
      if (fresh) pill.classList.add("snap");
      pill.style.setProperty("--px", `${row.offsetLeft}px`);
      pill.style.setProperty("--py", `${row.offsetTop}px`);
      pill.style.setProperty("--pw", `${row.offsetWidth}px`);
      pill.style.setProperty("--ph", `${row.offsetHeight}px`);
      if (fresh) { void pill.offsetWidth; pill.classList.remove("snap"); }
      pill.classList.add("on");
    }
    function dimRows() {
      if (!hotRow) return;
      hotRow.classList.remove("pn-hot");
      hotRow.parentElement?.querySelector(":scope > .pn-row-pill")?.classList.remove("on");
      hotRow = null;
    }
    doc.addEventListener("pointerover", (e) => {
      if (!finePointer.matches || !desktop.matches) return;
      const row = e.target.closest?.(ROW_SEL);
      if (row === hotRow) return;
      if (!row) { if (hotRow && !hotRow.parentElement?.contains(e.target)) dimRows(); return; }
      if (row.parentElement !== hotRow?.parentElement) dimRows();
      lightRow(row);
    }, { passive: true });
    doc.addEventListener("pointerout", (e) => {
      if (hotRow && !e.relatedTarget) dimRows();
    }, { passive: true });
    addEventListener("scroll", () => { if (hotRow && !hotRow.matches(":hover")) dimRows(); }, { passive: true });

    // ── Toque (celular e tablet): resposta ao pressionar ────────
    // Sem mouse não há "passar por cima": a linha acende e o cartão afunda
    // de leve no instante do toque, e solta se a pessoa começar a rolar.
    const PRESS_SEL = `${ROW_SEL}, .bn-card, .bd-kpi, .bf-kpi, .bd-ts, .pfx-stat, .bf-card-tile, .bd-side-pulsinho`;
    let pressed = null;
    let pressTimer = 0;
    const release = () => {
      clearTimeout(pressTimer);
      const el = pressed;
      pressed = null;
      if (el) setTimeout(() => el.classList.remove("pn-press"), 140);
    };
    doc.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || calm()) return;
      const el = e.target.closest?.(PRESS_SEL);
      if (!el || e.target.closest("input, textarea, select, [contenteditable]")) return;
      release();
      pressed = el;
      // Um instante de espera: quem só está rolando a tela não acende nada.
      pressTimer = setTimeout(() => el.classList.add("pn-press"), 60);
    }, { passive: true });
    ["pointerup", "pointercancel", "pointerleave"].forEach((type) => doc.addEventListener(type, release, { passive: true }));
    addEventListener("scroll", () => { if (pressed) { clearTimeout(pressTimer); pressed.classList.remove("pn-press"); pressed = null; } }, { passive: true, capture: true });
    // iOS só aplica :active com algum ouvinte de toque registrado.
    doc.addEventListener("touchstart", () => {}, { passive: true });

    // ── Pílula deslizante nos seletores ─────────────────────────
    const SEG_SEL = ".bd-seg, .bf-ws";
    function placeSeg(group, { snap = false } = {}) {
      const active = group.querySelector(":scope > button.active");
      let pill = group.querySelector(":scope > .pn-seg-pill");
      if (!active || !active.offsetWidth) { if (pill) pill.style.opacity = "0"; return; }
      if (!pill) {
        pill = doc.createElement("i");
        pill.className = "pn-seg-pill snap";
        pill.setAttribute("aria-hidden", "true");
        group.prepend(pill);
        group.classList.add("pn-seg-host");
        snap = true;
      }
      if (snap || calm()) pill.classList.add("snap");
      pill.style.opacity = "";
      pill.style.setProperty("--sx", `${active.offsetLeft}px`);
      pill.style.setProperty("--sy", `${active.offsetTop}px`);
      pill.style.setProperty("--sw", `${active.offsetWidth}px`);
      pill.style.setProperty("--sh", `${active.offsetHeight}px`);
      if (pill.classList.contains("snap")) { void pill.offsetWidth; requestAnimationFrame(() => pill.classList.remove("snap")); }
    }
    const segObserver = new MutationObserver((records) => {
      const groups = new Set();
      records.forEach((r) => {
        const g = r.target.closest?.(SEG_SEL) || (r.target.matches?.(SEG_SEL) ? r.target : null);
        if (g && !(r.target.classList?.contains("pn-seg-pill"))) groups.add(g);
      });
      groups.forEach((g) => placeSeg(g, { snap: records.some((r) => r.type === "childList" && r.target === g && [...r.addedNodes].some((n) => n.nodeName === "BUTTON")) }));
    });
    function armSegs(scope = doc) {
      scope.querySelectorAll(SEG_SEL).forEach((g) => {
        if (!g.dataset.pnSeg) {
          g.dataset.pnSeg = "1";
          segObserver.observe(g, { attributes: true, attributeFilter: ["class"], subtree: true, childList: true });
        }
        placeSeg(g, { snap: true });
      });
    }
    armSegs();
    addEventListener("resize", () => doc.querySelectorAll(".pn-seg-host").forEach((g) => placeSeg(g, { snap: true })), { passive: true });

    // ── Troca de aba com direção ────────────────────────────────
    // A aba nova entra do lado para onde a pessoa "andou".
    function slideIn(panel, dir) {
      if (!panel || calm() || !panel.animate || panel.querySelector(VIEW_FIXED)) return;
      panel.animate(
        [{ opacity: 0, transform: `translateX(${dir * 26}px)`, filter: "blur(4px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
        { duration: 420, easing: "cubic-bezier(.22, 1, .36, 1)" }
      );
    }
    const VIEW_FIXED = ".bp-fab, .bf-fab, .bf-pop, .modal-backdrop, .st-drawer";
    const TAB_PANELS = [
      { tab: "[data-planner-tab]", list: "#plannerView .planner-tabs", panel: () => doc.querySelector("#plannerView .planner-subview.active") },
      { tab: ".fin-tab-btn", list: ".bf-tabs", panel: () => doc.querySelector(".fin-tab-panel:not([hidden])") },
    ];
    doc.addEventListener("click", (e) => {
      for (const cfg of TAB_PANELS) {
        const tab = e.target.closest?.(cfg.tab);
        if (!tab) continue;
        const tabs = [...(tab.closest(cfg.list)?.querySelectorAll(cfg.tab) || [])];
        const from = tabs.findIndex((t) => t.classList.contains("active"));
        const to = tabs.indexOf(tab);
        if (from === to) return;
        requestAnimationFrame(() => {
          const panel = cfg.panel();
          slideIn(panel, to > from ? 1 : -1);
          cascadeRows(panel, 120);
        });
        return;
      }
      // Pastas das notas: os cartões se reorganizam em cascata.
      if (e.target.closest?.("#noteFolders button, .bn-chips button")) {
        requestAnimationFrame(() => {
          if (calm()) return;
          [...doc.querySelectorAll("#notesList > *")].slice(0, 12).forEach((card, i) => {
            card.animate?.([{ opacity: 0, transform: "translateY(12px) scale(.97)" }, { opacity: 1, transform: "none" }],
              { duration: 420, delay: i * 35, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "backwards" });
          });
        });
      }
    }, true);

    // Linhas de uma lista entram em cascata (troca de área/aba e ao rolar).
    function cascadeRows(scope, baseDelay = 0) {
      if (!scope || calm()) return;
      const seen = new Map();
      scope.querySelectorAll(ROW_SEL).forEach((row) => {
        if (!row.getClientRects().length) return;
        const r = row.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return;
        const host = row.parentElement;
        const n = seen.get(host) || 0;
        if (n >= 8) return;
        seen.set(host, n + 1);
        row.animate?.([{ opacity: 0, transform: "translateX(-8px)" }, { opacity: 1, transform: "none" }],
          { duration: 380, delay: baseDelay + n * 40, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "backwards" });
      });
    }

    // ── Rolagem: fio de progresso e inclinação das notas ────────
    const scrollLine = doc.createElement("i");
    scrollLine.className = "pn-scroll-line";
    scrollLine.setAttribute("aria-hidden", "true");
    topbar.append(scrollLine);
    let lineTick = false;
    addEventListener("scroll", () => {
      if (lineTick) return;
      lineTick = true;
      requestAnimationFrame(() => {
        lineTick = false;
        const max = doc.documentElement.scrollHeight - innerHeight;
        scrollLine.style.setProperty("--pn-progress", max > 0 ? Math.min(1, scrollY / max).toFixed(4) : "0");
      });
    }, { passive: true });

    let tiltCard = null;
    doc.addEventListener("pointermove", (e) => {
      if (!finePointer.matches || !desktop.matches || calm()) return;
      const card = e.target.closest?.(".bn-card");
      if (tiltCard && tiltCard !== card) { tiltCard.style.transform = ""; tiltCard.classList.remove("pn-tilt"); }
      tiltCard = card;
      if (!card) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      card.classList.add("pn-tilt");
      card.style.transform = `perspective(900px) rotateX(${(-y * 6).toFixed(2)}deg) rotateY(${(x * 7).toFixed(2)}deg) translateY(-4px)`;
    }, { passive: true });

    // ── Configurações → Aparência → Movimento ───────────────────
    const themeGroup = doc.getElementById("themeToggle");
    if (themeGroup && !doc.getElementById("pnMotionSeg")) {
      const OPTIONS = [["auto", "Automático"], ["full", "Sempre ligado"], ["reduced", "Reduzido"]];
      const row = doc.createElement("div");
      row.className = "pn-motion-row";
      row.innerHTML = `<div class="pn-motion-copy"><strong id="pnMotionLabel">Movimento e animações</strong><small id="pnMotionHint"></small></div>
        <div class="bd-seg pn-motion-seg" id="pnMotionSeg" role="radiogroup" aria-labelledby="pnMotionLabel">
          ${OPTIONS.map(([v, l]) => `<button type="button" role="radio" data-motion-choice="${v}">${l}</button>`).join("")}
        </div>`;
      themeGroup.after(row);
      const seg = row.querySelector("#pnMotionSeg");
      const hint = row.querySelector("#pnMotionHint");
      const systemReduces = () => nativeMatchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const sync = () => {
        seg.querySelectorAll("button").forEach((b) => {
          const on = b.dataset.motionChoice === motionPref;
          b.classList.toggle("active", on);
          b.setAttribute("aria-checked", String(on));
          b.tabIndex = on ? 0 : -1;
        });
        hint.textContent = motionPref === "full" ? "Animações sempre ativas, mesmo se o aparelho pedir menos movimento."
          : motionPref === "reduced" ? "Quase sem animações: telas trocam direto, sem efeitos."
          : systemReduces() ? "Seu aparelho está pedindo menos movimento, então o app está quase parado. Escolha “Sempre ligado” para ver as animações."
          : "Segue a configuração do aparelho.";
      };
      seg.addEventListener("click", (e) => {
        const b = e.target.closest("[data-motion-choice]");
        if (b) { setMotion(b.dataset.motionChoice); sync(); }
      });
      seg.addEventListener("keydown", (e) => {
        if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
        e.preventDefault();
        const list = [...seg.querySelectorAll("button")];
        const i = list.findIndex((b) => b.classList.contains("active"));
        const next = list[(i + (e.key === "ArrowRight" ? 1 : list.length - 1)) % list.length];
        next.click(); next.focus();
      });
      sync();
    }

    // ── Atalhos de teclado ──────────────────────────────────────
    const keysPanel = doc.createElement("div");
    keysPanel.className = "pn-keys";
    keysPanel.hidden = true;
    keysPanel.setAttribute("role", "dialog");
    keysPanel.setAttribute("aria-modal", "true");
    keysPanel.setAttribute("aria-label", "Atalhos de teclado");
    const mod = isMac ? "⌘" : "Ctrl";
    keysPanel.innerHTML = `<div class="pn-keys-card">
      <h2>Atalhos de teclado <button type="button" class="bd-icon-btn" data-pn-keys-close aria-label="Fechar"><svg class="i" aria-hidden="true"><use href="#i-x"/></svg></button></h2>
      <ul>
        <li><span>Buscar em tudo</span><span><kbd>${mod}</kbd><kbd>K</kbd></span></li>
        <li><span>Ir para Início</span><span><kbd>G</kbd><kbd>I</kbd></span></li>
        <li><span>Ir para Planner</span><span><kbd>G</kbd><kbd>P</kbd></span></li>
        <li><span>Ir para Notas</span><span><kbd>G</kbd><kbd>N</kbd></span></li>
        <li><span>Ir para Finanças</span><span><kbd>G</kbd><kbd>F</kbd></span></li>
        <li><span>Ir para Autopilot</span><span><kbd>G</kbd><kbd>A</kbd></span></li>
        <li><span>Ir para Configurações</span><span><kbd>G</kbd><kbd>C</kbd></span></li>
        <li><span>Recolher / expandir a barra</span><span><kbd>[</kbd></span></li>
        <li><span>Mostrar esta lista</span><span><kbd>?</kbd></span></li>
      </ul></div>`;
    doc.body.append(keysPanel);
    let keysReturn = null;
    const closeKeys = () => { keysPanel.hidden = true; keysReturn?.focus?.(); };
    const openKeys = () => { keysReturn = doc.activeElement; keysPanel.hidden = false; keysPanel.querySelector("[data-pn-keys-close]")?.focus(); };
    keysPanel.addEventListener("click", (e) => { if (e.target === keysPanel || e.target.closest("[data-pn-keys-close]")) closeKeys(); });

    const VIEW_BY_KEY = { i: "dashboard", h: "dashboard", p: "planner", n: "notes", f: "finances", a: "autopilot", c: "settings" };
    let gAt = 0;
    const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const modalOpen = () => [...doc.querySelectorAll(".modal-backdrop, .bn-detail-wrap, .bn-form-wrap")].some((m) => !m.hidden && m.getClientRects().length);
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !keysPanel.hidden) { e.preventDefault(); closeKeys(); return; }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || !desktop.matches) return;
      const k = e.key.toLowerCase();
      if (k === "?" || (k === "/" && e.shiftKey)) { e.preventDefault(); keysPanel.hidden ? openKeys() : closeKeys(); return; }
      if (!keysPanel.hidden || modalOpen()) return;
      if (k === "[" && mq("(min-width: 1181px)").matches) { e.preventDefault(); setCollapsed(!root.classList.contains("pn-side-collapsed")); return; }
      if (k === "g") { gAt = performance.now(); return; }
      if (gAt && performance.now() - gAt < 1200 && VIEW_BY_KEY[k]) {
        gAt = 0;
        const btn = doc.querySelector(`.bd-sidebar [data-nav][data-view="${VIEW_BY_KEY[k]}"]`);
        if (btn) { e.preventDefault(); btn.click(); }
        return;
      }
      gAt = 0;
    });
  });
})();
