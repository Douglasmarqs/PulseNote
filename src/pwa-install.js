// pwa-install.js — Registro do Service Worker + botão/banner de instalação
// Inclua este script (sem type="module") em login.html e index.html.

(function () {
  "use strict";

  // ── Registra o Service Worker e garante que atualizações realmente
  //    apareçam ────────────────────────────────────────────────────
  // Problema que isso resolve: bumpar CACHE_NAME (ex.: v6 → v7) faz o
  // navegador instalar o novo Service Worker em segundo plano, mas isso
  // sozinho NÃO recarrega o JS/CSS já carregado na aba aberta — a pessoa
  // continuava vendo o app.js/styles.css antigos até fechar e reabrir o
  // app várias vezes (às vezes nem isso resolvia, por causa do cache
  // HTTP normal do navegador por baixo do cache do Service Worker).
  // Com o listener de "controllerchange" abaixo, assim que o novo SW
  // assume o controle da página, a gente recarrega automaticamente —
  // dessa forma toda atualização aparece na primeira visita depois do
  // deploy, sem exigir nenhuma ação manual da pessoa.
  if ("serviceWorker" in navigator) {
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForUpdate) return; // nunca recarrega em loop
      reloadedForUpdate = true;
      window.location.reload();
    });

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").then((reg) => {
        // Além de reagir a atualizações que cheguem sozinhas, força uma
        // checagem ativa por uma versão nova toda vez que o app abre —
        // sem isso, o navegador só reverifica o sw.js periodicamente por
        // conta própria (pode levar até 24h), então um redeploy recente
        // podia demorar bastante pra ser notado.
        reg.update().catch(() => {});

        // Mesma checagem, mas também toda vez que a pessoa volta pra essa
        // aba depois de ter usado outro app/aba — cobre o caso de alguém
        // que deixa o PulseNote aberto em segundo plano por muito tempo
        // (comum em celular) sem nunca dar um "reload" de verdade.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        });
      }).catch((err) => {
        console.warn("Service Worker não registrado:", err);
      });
    });
  }

  // ── Detecta se já está rodando como app instalado ──────────────
  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true // iOS Safari
    );
  }

  // ── Detecta a plataforma ────────────────────────────────────────
  const ua = navigator.userAgent;
  // iPadOS 13+ se apresenta como Mac; Chrome/Edge/Firefox no iOS também
  // instalam pelo menu Compartilhar (iOS 16.4+), então valem todos.
  const isIOS = (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) && !window.MSStream;
  const isSafari = isIOS && /Safari|CriOS|FxiOS|EdgiOS/i.test(ua);

  let deferredPrompt = null; // evento de instalação nativo do Android/Chrome/Edge/desktop

  // Chrome/Android/Edge/desktop dispara este evento quando o app é "instalável"
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showFixedButton("android");
    maybeShowDismissableBanner("android");
  });

  // Quando o app é instalado com sucesso, escondemos os botões
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    document.getElementById("pwaFixedInstallBtn")?.remove();
    document.getElementById("pwaInstallBanner")?.remove();
  });

  if (isStandalone()) return; // já instalado — não mostra nada do que segue

  // iOS Safari não tem beforeinstallprompt — mostramos botão/instruções manuais
  if (isIOS && isSafari) {
    showFixedButton("ios");
    setTimeout(() => maybeShowDismissableBanner("ios"), 2500);
  }

  // ── Botão FIXO e permanente de instalação ───────────────────────
  // Diferente do banner (que pode ser dispensado), este botão continua
  // visível sempre que o app ainda não está instalado — funciona como
  // um "botão de download" de verdade, igual a outros sites que oferecem
  // instalação (ex: lojas de apps via navegador).
  function showFixedButton(platform) {
    if (document.getElementById("pwaFixedInstallBtn")) return;
    const container = document.querySelector("[data-pwa-install-slot]");
    if (!container) return; // a página atual não reservou um lugar pro botão

    const btn = document.createElement("button");
    btn.id = "pwaFixedInstallBtn";
    btn.type = "button";
    btn.className = "pwa-fixed-install-btn";
    btn.setAttribute("aria-label", "Instalar app");
    btn.setAttribute("title", "Instalar app");
    btn.innerHTML = `<span class="pwa-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="m7.5 9.8 4.5 4.5 4.5-4.5"/><path d="M5 15.5v2A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-2"/></svg></span><span>Instalar app</span>`;

    btn.addEventListener("click", () => handleInstallClick(platform));
    ensureStyles();
    container.appendChild(btn);
  }

  async function handleInstallClick(platform) {
    if (platform === "android" && deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") {
        document.getElementById("pwaFixedInstallBtn")?.remove();
      }
      deferredPrompt = null;
      return;
    }
    // iOS (ou Android antes do evento beforeinstallprompt disparar):
    // mostra as instruções manuais, já que não existe API de instalação direta
    showInstructionsModal(platform);
  }

  // ── Visual v2 (mesmo acabamento do app) ─────────────────────────
  // Antes: cartão branco com emojis/caracteres no lugar de ícones e estilos inline.
  // Agora: vidro escuro, ícone real do PulseNote, ícones SVG e as
  // transições "Toast open/close" e "Modal open/close" do transitions.dev.
  // O estilo vem embutido porque este script também roda no login.html.
  const SVG = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3.5M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2 2 0 00-2 2V19a2 2 0 002 2h10a2 2 0 002-2v-6.5a2 2 0 00-2-2h-1.5"/></svg>',
    plusSquare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5l4 4 9-9"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5.5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="18.5" r="1.8"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="m7.5 9.8 4.5 4.5 4.5-4.5"/><path d="M5 15.5v2A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-2"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10a6 6 0 0112 0c0 5 2 6.500 2 6.500H4S6 15 6 10"/><path d="M10.300 20a2 2 0 003.400 0"/></svg>',
    offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.500l7 3v5c0 4.500-3 7.700-7 9-4-1.300-7-4.500-7-9v-5z"/><path d="M9 12l2 2 4-4"/></svg>',
  };
  // Relativo de propósito: funciona em /app, /login (reescritos para /src/…)
  // e servindo /src direto (local).
  const APP_ICON = "icons/icon-192.png?v=20261119";

  function ensureStyles() {
    if (document.getElementById("pwaInstallStyles")) return;
    const style = document.createElement("style");
    style.id = "pwaInstallStyles";
    style.textContent = `
      .pwa-v2 { --ease: cubic-bezier(.22,1,.36,1); --ink: #eef1ff; --ink-2: #a9b1d6; --line: rgba(255,255,255,.1); --primary: #6d5dfc; font-family: inherit; color: var(--ink); }
      .pwa-banner { position: fixed; left: 50%; bottom: max(16px, calc(env(safe-area-inset-bottom) + 12px)); z-index: 9997; display: flex; align-items: center; gap: 12px; width: min(460px, calc(100vw - 24px)); padding: 12px 12px 12px 12px; border: 1px solid var(--line); border-radius: 20px;
        background: radial-gradient(120% 140% at 0% 0%, rgba(109,93,252,.22), transparent 55%), linear-gradient(180deg, rgba(30,34,56,.94), rgba(14,17,31,.96));
        box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, 0 24px 60px -18px rgba(5,8,20,.75); backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4);
        opacity: 0; transform: translate(-50%, 16px) scale(.97); filter: blur(2px); transition: opacity 250ms var(--ease), transform 250ms var(--ease), filter 250ms var(--ease); }
      .pwa-banner.is-open { opacity: 1; transform: translate(-50%, 0) scale(1); filter: none; transition-duration: 350ms; }
      .pwa-app-ico { position: relative; flex: none; width: 48px; height: 48px; border-radius: 14px; overflow: hidden; box-shadow: 0 8px 20px -8px rgba(109,93,252,.9), 0 0 0 1px rgba(255,255,255,.12) inset; }
      .pwa-app-ico img { width: 100%; height: 100%; display: block; object-fit: cover; }
      .pwa-copy { flex: 1; min-width: 0; display: grid; gap: 2px; }
      .pwa-copy strong { font-size: 14px; font-weight: 750; letter-spacing: -.01em; }
      .pwa-copy span { font-size: 12.5px; line-height: 1.35; color: var(--ink-2); }
      .pwa-copy .pwa-inline-ico { display: inline-grid; place-items: center; width: 18px; height: 18px; margin: 0 1px; vertical-align: -4px; border-radius: 5px; background: rgba(255,255,255,.08); color: var(--ink); }
      .pwa-copy .pwa-inline-ico svg { width: 13px; height: 13px; }
      .pwa-btn { flex: none; height: 38px; padding: 0 16px; border: 0; border-radius: 12px; background: linear-gradient(180deg, #7f70ff, var(--primary)); color: #fff; font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer; box-shadow: 0 8px 18px -8px rgba(109,93,252,.9), 0 1px 0 rgba(255,255,255,.25) inset; transition: transform .2s var(--ease), filter .2s; }
      .pwa-btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
      .pwa-btn:active { transform: scale(.97); }
      .pwa-x { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 10px; background: rgba(255,255,255,.06); color: var(--ink-2); cursor: pointer; transition: background .2s, color .2s, transform .3s var(--ease); }
      .pwa-x:hover { background: rgba(255,255,255,.12); color: var(--ink); transform: rotate(90deg); }
      .pwa-x svg { width: 14px; height: 14px; }
      .pwa-modal-backdrop { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; padding: 20px; background: rgba(6,9,20,0); transition: background 300ms var(--ease), backdrop-filter 300ms var(--ease); }
      .pwa-modal-backdrop.is-open { background: rgba(6,9,20,.6); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
      .pwa-modal { width: 100%; max-width: 390px; padding: 22px; border: 1px solid var(--line); border-radius: 24px; background: linear-gradient(180deg, #1a1e33, #11142a); box-shadow: 0 30px 80px -20px rgba(0,0,0,.7);
        opacity: 0; transform: translateY(12px) scale(.96); filter: blur(3px); transition: opacity 300ms var(--ease), transform 300ms var(--ease), filter 300ms var(--ease); }
      .pwa-modal-backdrop.is-open .pwa-modal { opacity: 1; transform: none; filter: none; }
      .pwa-modal-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
      .pwa-modal-head h2 { flex: 1; margin: 0; font-size: 17px; font-weight: 750; letter-spacing: -.01em; }
      .pwa-modal-head h2 small { display: block; margin-top: 2px; font-size: 12.5px; font-weight: 500; color: var(--ink-2); }
      .pwa-perks { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 16px; padding: 0; list-style: none; }
      .pwa-perks li { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 99px; background: rgba(109,93,252,.14); color: #cfc8ff; font-size: 12px; font-weight: 650; }
      .pwa-perks svg { width: 13px; height: 13px; }
      .pwa-steps { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; counter-reset: s; }
      .pwa-steps li { display: grid; grid-template-columns: 28px 1fr auto; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.03); font-size: 13.5px; line-height: 1.4; color: var(--ink-2); opacity: 0; transform: translateY(6px); animation: pwaStep 420ms var(--ease) forwards; }
      .pwa-steps li:nth-child(2) { animation-delay: 70ms; } .pwa-steps li:nth-child(3) { animation-delay: 140ms; }
      .pwa-steps li::before { counter-increment: s; content: counter(s); display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; background: var(--primary); color: #fff; font-size: 13px; font-weight: 800; }
      .pwa-steps strong { color: var(--ink); font-weight: 700; }
      .pwa-step-ico { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: rgba(255,255,255,.07); color: var(--ink); }
      .pwa-step-ico svg { width: 17px; height: 17px; }
      @keyframes pwaStep { to { opacity: 1; transform: none; } }
      .bda-pwa .pwa-fixed-install-btn, [data-pwa-install-slot]:not(#bdTopActions *) > .pwa-fixed-install-btn.is-v2 { display: inline-flex; align-items: center; gap: 10px; height: 42px; padding: 0 16px 0 6px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; background: linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.03)); color: #eef1ff; font: inherit; font-size: 13.5px; font-weight: 650; cursor: pointer; box-shadow: 0 10px 24px -14px rgba(109,93,252,.9); transition: border-color .25s, background .25s, transform .3s cubic-bezier(.22,1,.36,1); }
      .bda-pwa .pwa-fixed-install-btn:hover { border-color: rgba(139,123,255,.6); background: rgba(109,93,252,.16); transform: translateY(-1px); }
      .bda-pwa .pwa-fixed-install-btn .pwa-ico { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: linear-gradient(140deg, #5b4ff5, #8b7bff); color: #fff; box-shadow: 0 0 0 3px rgba(109,93,252,.18); }
      .bda-pwa .pwa-fixed-install-btn .pwa-ico svg { width: 15px; height: 15px; }
      @media (prefers-reduced-motion: reduce) {
        .pwa-banner, .pwa-modal, .pwa-modal-backdrop, .pwa-steps li { transition: none !important; animation: none !important; filter: none !important; }
        .pwa-banner.is-open { transform: translate(-50%, 0) !important; }
        .pwa-modal-backdrop.is-open .pwa-modal, .pwa-steps li { opacity: 1 !important; transform: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function appIconHtml() {
    return `<span class="pwa-app-ico" aria-hidden="true"><img src="${APP_ICON}" alt="" width="48" height="48" decoding="async" /></span>`;
  }

  function showInstructionsModal(platform) {
    if (document.getElementById("pwaInstructionsModal")) return;
    ensureStyles();

    const modal = document.createElement("div");
    modal.id = "pwaInstructionsModal";
    modal.className = "pwa-v2 pwa-modal-backdrop";

    const steps = platform === "ios"
      ? `<li><span>Toque em <strong>Compartilhar</strong> na barra do navegador</span><span class="pwa-step-ico">${SVG.share}</span></li>
         <li><span>Escolha <strong>Adicionar à Tela de Início</strong></span><span class="pwa-step-ico">${SVG.plusSquare}</span></li>
         <li><span>Confirme em <strong>Adicionar</strong></span><span class="pwa-step-ico">${SVG.check}</span></li>`
      : `<li><span>Abra o <strong>menu</strong> do navegador</span><span class="pwa-step-ico">${SVG.dots}</span></li>
         <li><span>Toque em <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong></span><span class="pwa-step-ico">${SVG.download}</span></li>
         <li><span>Confirme em <strong>Instalar</strong></span><span class="pwa-step-ico">${SVG.check}</span></li>`;

    modal.innerHTML = `
      <div class="pwa-modal" role="dialog" aria-modal="true" aria-labelledby="pwaModalTitle">
        <div class="pwa-modal-head">
          ${appIconHtml()}
          <h2 id="pwaModalTitle">Instalar o PulseNote<small>Leva menos de 10 segundos</small></h2>
          <button type="button" class="pwa-x" id="closePwaInstructions" aria-label="Fechar">${SVG.close}</button>
        </div>
        <ul class="pwa-perks"><li>${SVG.bolt}Abre na hora</li><li>${SVG.bell}Lembretes no aparelho</li><li>${SVG.offline}Funciona offline</li></ul>
        <ol class="pwa-steps">${steps}</ol>
      </div>
    `;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add("is-open"));
    const close = () => {
      modal.classList.remove("is-open");
      document.removeEventListener("keydown", onKey);
      setTimeout(() => modal.remove(), 260);
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    document.getElementById("closePwaInstructions").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    requestAnimationFrame(() => document.getElementById("closePwaInstructions")?.focus());
  }

  // ── Banner dispensável (aparece uma vez, pode ser fechado) ──────
  function maybeShowDismissableBanner(platform) {
    const DISMISS_KEY = "pn_install_banner_dismissed_at";
    let dismissedAt = null;
    try { dismissedAt = localStorage.getItem(DISMISS_KEY); } catch { /* sem storage */ }
    if (dismissedAt && Date.now() - Number(dismissedAt) < 7 * 24 * 60 * 60 * 1000) return;
    if (document.getElementById("pwaInstallBanner")) return;
    ensureStyles();

    const banner = document.createElement("div");
    banner.id = "pwaInstallBanner";
    banner.className = "pwa-v2 pwa-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", "Instalar o PulseNote");

    const copy = platform === "android"
      ? `<strong>Instale o PulseNote</strong><span>Abre direto da tela inicial, com lembretes no aparelho.</span>`
      : `<strong>Instale o PulseNote</strong><span>Toque em <i class="pwa-inline-ico">${SVG.share}</i> e depois em <b>Adicionar à Tela de Início</b>.</span>`;

    banner.innerHTML = `
      ${appIconHtml()}
      <div class="pwa-copy">${copy}</div>
      <button type="button" class="pwa-btn" id="pwaInstallBtn">${platform === "android" ? "Instalar" : "Ver como"}</button>
      <button type="button" class="pwa-x" id="pwaDismissBtn" aria-label="Agora não">${SVG.close}</button>
    `;

    document.body.appendChild(banner);
    requestAnimationFrame(() => requestAnimationFrame(() => banner.classList.add("is-open")));

    const hide = () => { banner.classList.remove("is-open"); setTimeout(() => banner.remove(), 260); };
    document.getElementById("pwaDismissBtn").addEventListener("click", () => {
      try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* sem storage */ }
      hide();
    });
    document.getElementById("pwaInstallBtn").addEventListener("click", () => {
      hide();
      handleInstallClick(platform);
    });
  }
})();
