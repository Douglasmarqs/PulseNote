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

    // Atalhos nos itens (só para leitores de tela — as letrinhas visíveis
    // ao passar o mouse saíram) + dica de nome para a barra recolhida.
    const KEYS = { dashboard: "i", planner: "p", notes: "n", finances: "f", autopilot: "a", settings: "c" };
    doc.querySelectorAll(".bd-sidebar [data-nav]").forEach((item) => {
      const label = item.querySelector("span")?.textContent.trim();
      if (label) item.dataset.tip = label;
      const key = KEYS[item.dataset.view];
      if (key) item.setAttribute("aria-keyshortcuts", `G ${key.toUpperCase()}`);
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

    // ── Valores em reais como odômetro ──────────────────────────
    // Cada dígito rola na própria casa (fonte com dígitos de largura igual):
    // o número já ocupa a largura final desde o 1º quadro, então nada ao
    // redor se mexe — a contagem antiga mudava de largura e "tremia".
    // Roda ao abrir a área (de 0 até o valor) e sempre que o valor muda
    // (do valor antigo para o novo, ex.: ao registrar um gasto).
    const ODO_SEL = ".bd-kpi-value, .bf-kpi-body > strong, #bdResTotal, #bdResIn, #bdResOut";
    const ODO_MONEY = /^([+\-−]\s?)?R\$\s?[\d.]+,\d{2}$/;
    const odoLast = new WeakMap();
    const odoRolling = new Map();
    const escHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    function odoFinish(el, text) {
      const anims = odoRolling.get(el);
      if (!anims) return;
      odoRolling.delete(el);
      anims.forEach((a) => { try { a.cancel(); } catch { /* já terminou */ } });
      odoLast.set(el, text);
      el.textContent = text;
    }
    function odoRoll(el, fromText) {
      const to = el.textContent.replace(/\s+/g, " ").trim();
      if (odoRolling.has(el)) odoFinish(el, to);
      odoLast.set(el, to);
      if (calm() || !ODO_MONEY.test(to) || !el.offsetWidth) return;
      const cs = getComputedStyle(el);
      const fontPx = parseFloat(cs.fontSize) || 16;
      const lh = parseFloat(cs.lineHeight) || fontPx * 1.2;
      if (el.scrollHeight > lh * 1.5) return; // quebrou em duas linhas: deixa quieto
      const toDigits = [...to].filter((c) => /\d/.test(c));
      const fromDigits = [...String(fromText || "")].filter((c) => /\d/.test(c));
      const offset = toDigits.length - fromDigits.length; // alinha pela direita
      let k = -1;
      const cells = [...to].map((ch) => {
        if (!/\d/.test(ch)) return `<span class="pn-odo-c">${ch === " " ? "&nbsp;" : escHtml(ch)}</span>`;
        k += 1;
        const t = Number(ch);
        const fromIdx = k - offset;
        const f = fromText == null ? 0 : (fromIdx >= 0 && fromDigits[fromIdx] != null ? Number(fromDigits[fromIdx]) : 0);
        const start = f;
        const end = fromText == null ? 10 + t : (t >= f ? t : t + 10);
        const rows = Array.from({ length: 20 }, (_, n) => `<i>${n % 10}</i>`).join("");
        return `<span class="pn-odo-d" data-s="${start}" data-e="${end}"><span class="pn-odo-s">${rows}</span></span>`;
      });
      el.classList.add("pn-odo-host");
      el.innerHTML = `<span class="pn-odo" aria-hidden="true" style="--lh:${lh}px">${cells.join("")}</span><span class="sr-only">${escHtml(to)}</span>`;
      const strips = [...el.querySelectorAll(".pn-odo-d")];
      const anims = strips.map((cell, i) => {
        const fromRow = Number(cell.dataset.s), toRow = Number(cell.dataset.e);
        const fromRight = strips.length - 1 - i;
        return cell.firstElementChild.animate(
          [{ transform: `translateY(${-fromRow * lh}px)` }, { transform: `translateY(${-toRow * lh}px)` }],
          { duration: 720 + fromRight * 70, delay: 40, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "both" }
        );
      });
      odoRolling.set(el, anims);
      Promise.all(anims.map((a) => a.finished)).then(() => { if (odoRolling.get(el) === anims) odoFinish(el, to); }, () => {});
    }
    function odoEnter(section) {
      if (calm() || !section) return;
      // Depois do ajuste de tamanho da fonte do app (2 quadros).
      setTimeout(() => section.querySelectorAll(ODO_SEL).forEach((el) => { if (el.getClientRects().length) odoRoll(el, null); }), 90);
    }
    const odoObserver = new MutationObserver((records) => {
      const touched = new Set();
      records.forEach((r) => { const host = (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest?.(ODO_SEL); if (host) touched.add(host); });
      touched.forEach((el) => {
        if (odoRolling.has(el)) {
          // O app reescreveu no meio da rolagem: termina na hora e segue.
          if (!el.querySelector(".pn-odo")) { const now = el.textContent.trim(); const prev = odoLast.get(el); odoRolling.delete(el); odoLast.set(el, now); if (prev && prev !== now) odoRoll(el, prev); }
          return;
        }
        const now = el.textContent.replace(/\s+/g, " ").trim();
        const prev = odoLast.get(el);
        odoLast.set(el, now);
        if (!prev || prev === now || doc.getElementById("appLoadingOverlay")) return;
        if (ODO_MONEY.test(prev) && ODO_MONEY.test(now) && el.getClientRects().length) odoRoll(el, prev);
      });
    });
    doc.querySelectorAll(ODO_SEL).forEach((el) => {
      odoLast.set(el, el.textContent.replace(/\s+/g, " ").trim());
      odoObserver.observe(el, { childList: true, characterData: true, subtree: true });
    });
    window.pnOdoEnter = odoEnter;

    // ── Tarefa concluída: faíscas na caixinha ───────────────────
    function pnSpark(rect, { count = 10, colors = ["#25d388", "#7c6bff", "#22d3ee", "#ffc83d"] } = {}) {
      if (calm() || !rect) return;
      const burst = doc.createElement("div");
      burst.className = "pn-burst";
      burst.setAttribute("aria-hidden", "true");
      burst.style.left = `${rect.left + rect.width / 2}px`;
      burst.style.top = `${rect.top + rect.height / 2}px`;
      for (let i = 0; i < count; i += 1) {
        const dot = doc.createElement("i");
        dot.className = "pn-burst-dot";
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
        const dist = 22 + Math.random() * 18;
        const size = 4 + Math.random() * 3;
        dot.style.width = dot.style.height = `${size}px`;
        dot.style.background = dot.style.color = colors[i % colors.length];
        burst.append(dot);
        dot.animate([
          { transform: "translate(-50%, -50%) scale(.3)", opacity: 1 },
          { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(1)`, opacity: 0 },
        ], { duration: 520 + Math.random() * 160, easing: "cubic-bezier(.2, .7, .3, 1)", fill: "forwards" });
      }
      doc.body.append(burst);
      setTimeout(() => burst.remove(), 800);
    }
    window.pnSpark = pnSpark;
    doc.addEventListener("click", (e) => {
      const check = e.target.closest?.(".bp-check");
      if (!check || check.classList.contains("is-done")) return; // só ao concluir
      const id = check.closest("[data-task-id]")?.dataset.taskId;
      const rect = check.getBoundingClientRect();
      navigator.vibrate?.(10);
      requestAnimationFrame(() => {
        pnSpark(rect);
        const fresh = id ? doc.querySelector(`[data-task-id="${CSS.escape(id)}"] .bp-check`) : null;
        fresh?.animate?.([{ transform: "scale(.6)" }, { transform: "scale(1.18)", offset: 0.55 }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.34, 1.5, .5, 1)" });
      });
    }, true);

    // ── Entrada dos blocos ao rolar ─────────────────────────────
    const REVEAL_SEL = ".bd-card, .bn-card";
    let io = null;
    function armReveal(view) {
      io?.disconnect();
      if (calm() || !view || typeof IntersectionObserver !== "function") return;
      // Sem medir posições: o próprio observador diz, na 1ª leitura, quem já
      // está à vista (esses ficam como estão); só os de baixo esmaecem ao
      // aparecer. Medir cada cartão aqui recalculava a página na troca.
      const pending = [...view.querySelectorAll(REVEAL_SEL)].filter((el) => !(el.closest(".bd-card") !== el && el.parentElement?.closest(".bd-card")));
      if (!pending.length) return;
      const firstSeen = new WeakSet();
      io = new IntersectionObserver((entries) => {
        let i = 0;
        entries.forEach((entry) => {
          if (!firstSeen.has(entry.target)) {
            firstSeen.add(entry.target);
            if (entry.isIntersecting || !entry.boundingClientRect.height) { io.unobserve(entry.target); return; }
            if (entry.boundingClientRect.top < 0) { io.unobserve(entry.target); return; }
            return;
          }
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          entry.target.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: 480, delay: Math.min(i++, 4) * 60, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "backwards" }
          );
        });
      }, { rootMargin: "0px 0px 60px 0px" });
      pending.forEach((el) => io.observe(el));
    }

    // ── Brilho que acompanha o cursor ───────────────────────────
    // Só uma classe + duas variáveis: o brilho é um ::after do próprio
    // cartão (web.css), sem inserir nada no conteúdo que o app redesenha.
    // Cartões com gráfico ficam de fora: repintar o brilho a cada movimento
    // do mouse forçava o gráfico inteiro a ser redesenhado e ele "engasgava".
    const SPOT_SKIP = ".bd-chat, .modal-card, .fin-form-card, .pf-hero, .bd-evo, .bf-evo, .bd-cats, .bf-cmp, .bf-an > .bd-card";
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
      // Medições e reinício de animação no quadro seguinte (sem recálculo
      // forçado no meio da troca de tela).
      requestAnimationFrame(() => { moveInk(); if (desktop.matches) replay(routeBar, "run"); });
      // O título já anima no app.js (uma única animação, sem sumir). Aqui
      // só garantimos que o vidro do topo some na hora — a tela nova abre
      // no topo, e o vidro esmaecendo por 0,35s parecia uma piscada.
      title?.classList.remove("pn-title-in");
      subtitle?.classList.remove("pn-title-in");
      doc.body.classList.add("pn-view-switch");
      doc.body.classList.remove("pn-scrolled", "pn-scrolling");
      requestAnimationFrame(() => requestAnimationFrame(() => doc.body.classList.remove("pn-view-switch")));
      const section = doc.getElementById(`${view}View`);
      requestAnimationFrame(() => { armReveal(section); armSegs(section); odoEnter(section); });
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
      if (v) onViewChange(v); else requestAnimationFrame(() => moveInk());
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
      armReveal(section);
      odoEnter(section);
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
    let pressStart = { x: 0, y: 0 };
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
      pressStart = { x: e.clientX, y: e.clientY };
      // Espera um pouco mais e cancela se o dedo andar: quem só está rolando
      // a tela não acende nada (antes a linha acendia e apagava ao rolar).
      pressTimer = setTimeout(() => el.classList.add("pn-press"), 110);
    }, { passive: true });
    doc.addEventListener("pointermove", (e) => {
      if (!pressed || e.pointerType === "mouse") return;
      if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 6) {
        clearTimeout(pressTimer);
        pressed.classList.remove("pn-press");
        pressed = null;
      }
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

    // ── Rolagem: fio de progresso e inclinação das notas ────────
    const scrollLine = doc.createElement("i");
    scrollLine.className = "pn-scroll-line";
    scrollLine.setAttribute("aria-hidden", "true");
    topbar.append(scrollLine);
    let lineTick = false;
    let lineIdle = 0;
    addEventListener("scroll", () => {
      // O fio só aparece enquanto a página está rolando e some sozinho
      // logo depois — parado, o topo fica sem nenhuma risca.
      doc.body.classList.add("pn-scrolling");
      clearTimeout(lineIdle);
      lineIdle = setTimeout(() => doc.body.classList.remove("pn-scrolling"), 900);
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

    // ── Notas: comemoração ao concluir ──────────────────────────
    // O botão afunda e volta, o check se desenha e faíscas saem dele.
    // As faíscas ficam no <body>, então seguem visíveis mesmo se a nota
    // fechar logo depois (celular).
    window.pnCelebrate = (btn, { soft = false } = {}) => {
      if (!btn || calm()) return;
      btn.classList.remove("pn-done-pop");
      void btn.offsetWidth;
      btn.classList.add("pn-done-pop");
      setTimeout(() => btn.classList.remove("pn-done-pop"), 720);
      if (soft) return;
      const r = btn.getBoundingClientRect();
      const burst = doc.createElement("div");
      burst.className = "pn-burst";
      burst.setAttribute("aria-hidden", "true");
      burst.style.left = `${r.left + r.width / 2}px`;
      burst.style.top = `${r.top + r.height / 2}px`;
      const ring = doc.createElement("i");
      ring.className = "pn-burst-ring";
      ring.style.width = `${r.width}px`;
      ring.style.height = `${r.height}px`;
      burst.append(ring);
      const colors = ["#7c6bff", "#22d3ee", "#25d388", "#ffc83d", "#ff6b9a"];
      const count = 14;
      for (let i = 0; i < count; i += 1) {
        const dot = doc.createElement("i");
        dot.className = "pn-burst-dot";
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
        const dist = Math.max(r.width, 90) * (0.42 + Math.random() * 0.3);
        const size = 6 + Math.random() * 5;
        dot.style.width = dot.style.height = `${size}px`;
        dot.style.background = colors[i % colors.length];
        dot.style.color = colors[i % colors.length];
        if (i % 3 === 0) dot.style.borderRadius = "2px";
        burst.append(dot);
        dot.animate(
          [
            { transform: "translate(-50%, -50%) scale(.4)", opacity: 0 },
            { transform: `translate(calc(-50% + ${Math.cos(angle) * dist * 0.55}px), calc(-50% + ${Math.sin(angle) * dist * 0.55}px)) scale(1)`, opacity: 1, offset: 0.35 },
            { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist + 18}px)) scale(.6) rotate(${Math.random() * 180}deg)`, opacity: 0 },
          ],
          { duration: 720 + Math.random() * 220, easing: "cubic-bezier(.2, .7, .3, 1)", fill: "forwards" }
        );
      }
      ring.animate(
        [{ transform: "translate(-50%, -50%) scale(1)", opacity: 0.7 }, { transform: "translate(-50%, -50%) scale(1.35)", opacity: 0 }],
        { duration: 620, easing: "cubic-bezier(.2, .7, .3, 1)", fill: "forwards" }
      );
      doc.body.append(burst);
      setTimeout(() => burst.remove(), 1100);
    };

    // ── Notas: formatação acima do teclado (celular) ────────────
    // Na nota aberta a barra de formatação só aparece enquanto se escreve
    // no texto, presa logo acima do teclado (onde o polegar já está); o
    // rodapé sai do caminho. No computador ela fica sempre visível no topo.
    const ndDetail = doc.querySelector("#noteDetailModal .bn-detail");
    const ndBody = doc.getElementById("ndBody");
    if (ndDetail && ndBody) {
      const keepWriting = () => {
        const a = doc.activeElement;
        return a === ndBody || ndBody.contains(a) || Boolean(a?.closest?.("#noteDetailToolbar, #ndLinkForm"));
      };
      const syncKeyboard = () => {
        const vv = window.visualViewport;
        const kb = vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
        ndDetail.style.setProperty("--pn-kb", `${kb}px`);
      };
      ndBody.addEventListener("focus", () => { ndDetail.classList.add("is-writing"); syncKeyboard(); });
      // "OK" no fim da barra (celular): fecha o teclado e o rodapé volta.
      const toolbar = doc.getElementById("noteDetailToolbar");
      if (toolbar && !toolbar.querySelector(".pn-tool-done")) {
        const done = doc.createElement("button");
        done.type = "button";
        done.className = "pn-tool-done";
        done.textContent = "OK";
        done.setAttribute("aria-label", "Fechar o teclado");
        done.addEventListener("mousedown", (e) => e.preventDefault());
        done.addEventListener("click", () => { ndBody.blur(); ndDetail.classList.remove("is-writing"); });
        toolbar.append(done);
      }
      doc.addEventListener("focusout", () => {
        setTimeout(() => { if (!keepWriting()) ndDetail.classList.remove("is-writing"); }, 60);
      });
      window.visualViewport?.addEventListener("resize", syncKeyboard);
      window.visualViewport?.addEventListener("scroll", syncKeyboard);
    }

    // ── Checklist da nota: concluídos descem para o fim ─────────
    // Marcou: o item fica um instante no lugar (dá para ver o check) e então
    // desliza para o grupo "Concluídos"; desmarcou: volta para cima na hora.
    // Só muda a ordem visual (CSS order) — os índices do app continuam iguais.
    const checkList = doc.getElementById("ndChecklistItems");
    if (checkList) {
      const sinkTimers = new WeakMap();
      const flip = (mutate) => {
        if (calm()) { mutate(); return; }
        const rows = [...checkList.children];
        const before = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
        mutate();
        rows.forEach((r) => {
          const dy = before.get(r) - r.getBoundingClientRect().top;
          if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 380, easing: "cubic-bezier(.22, 1, .36, 1)" });
        });
      };
      const syncAll = () => checkList.querySelectorAll(".bn-check-row").forEach((r) => {
        const done = r.classList.contains("is-done");
        if (r.classList.contains("pn-sunk") !== done) r.classList.toggle("pn-sunk", done);
      });
      new MutationObserver((records) => {
        for (const rec of records) {
          if (rec.type === "childList") { syncAll(); continue; } // redesenho: sem animação
          const row = rec.target;
          if (!row.classList?.contains("bn-check-row")) continue;
          const done = row.classList.contains("is-done");
          if (done === row.classList.contains("pn-sunk")) continue;
          clearTimeout(sinkTimers.get(row));
          if (done) {
            sinkTimers.set(row, setTimeout(() => {
              if (row.isConnected && row.classList.contains("is-done") && !row.classList.contains("pn-sunk")) flip(() => row.classList.add("pn-sunk"));
            }, 650));
          } else {
            flip(() => row.classList.remove("pn-sunk"));
          }
        }
      }).observe(checkList, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
      syncAll();
    }

    // ── Pulsinho no Início: mesma altura dos blocos ao lado ─────
    // Começa na linha dos cartões de resumo e termina com o último bloco.
    const dash = doc.querySelector("#dashboardView .bd-dash");
    const dashMain = dash?.querySelector(".bd-dash-main");
    const dashKpis = dash?.querySelector(".bd-kpis");
    if (dash && dashMain && dashKpis && typeof ResizeObserver === "function") {
      const fitChat = () => {
        if (!dashMain.offsetHeight) return;
        const top = dashKpis.offsetTop - dashMain.offsetTop;
        dash.style.setProperty("--pn-chat-top", `${Math.max(0, top)}px`);
        dash.style.setProperty("--pn-chat-h", `${Math.max(0, dashMain.offsetHeight - top)}px`);
      };
      new ResizeObserver(fitChat).observe(dashMain);
      fitChat();
    }

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
