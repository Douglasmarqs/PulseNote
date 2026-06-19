// pwa-install.js — Registro do Service Worker + banner de instalação
// Inclua este script (sem type="module") em login.html e index.html.

(function () {
  "use strict";

  // ── Registra o Service Worker ──────────────────────────────────
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
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

  if (isStandalone()) return; // já instalado — não mostra nada

  // ── Detecta a plataforma ────────────────────────────────────────
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

  // Não mostra o banner se já foi dispensado nos últimos 7 dias
  const DISMISS_KEY = "pn_install_banner_dismissed_at";
  const dismissedAt = localStorage.getItem(DISMISS_KEY);
  if (dismissedAt && Date.now() - Number(dismissedAt) < 7 * 24 * 60 * 60 * 1000) {
    return;
  }

  let deferredPrompt = null; // evento de instalação nativo do Android/Chrome

  // Chrome/Android dispara este evento quando o app é "instalável"
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner("android");
  });

  // iOS Safari não tem beforeinstallprompt — mostramos instruções manuais
  if (isIOS && isSafari) {
    setTimeout(() => showInstallBanner("ios"), 2500);
  }

  function showInstallBanner(platform) {
    if (document.getElementById("pwaInstallBanner")) return;

    const banner = document.createElement("div");
    banner.id = "pwaInstallBanner";
    banner.style.cssText = `
      position:fixed; left:16px; right:16px; bottom:max(16px, env(safe-area-inset-bottom));
      z-index:9997; background:var(--surface,#fff); border:1.5px solid var(--line,#e8ecf2);
      border-radius:20px; box-shadow:0 12px 36px rgba(0,0,0,0.18);
      padding:16px; display:flex; align-items:center; gap:12px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      animation:pwaSlideUp 320ms ease; max-width:480px; margin:0 auto;
    `;

    const style = document.createElement("style");
    style.textContent = `
      @keyframes pwaSlideUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
    `;
    document.head.appendChild(style);

    const iconHtml = `
      <div style="width:46px;height:46px;border-radius:14px;flex-shrink:0;
        background:linear-gradient(145deg,#4f8ef7,#af52de);
        display:grid;place-items:center;box-shadow:0 4px 12px rgba(79,142,247,0.3)">
        <span style="color:#fff;font-size:1.3rem">⚡</span>
      </div>
    `;

    if (platform === "android") {
      banner.innerHTML = `
        ${iconHtml}
        <div style="flex:1;min-width:0">
          <strong style="display:block;font-size:0.92rem;color:var(--text,#1a1f2e)">Instalar PulseNote</strong>
          <span style="font-size:0.8rem;color:var(--muted,#8a9bb0)">Acesso rápido direto da tela inicial</span>
        </div>
        <button id="pwaInstallBtn" style="flex-shrink:0;height:38px;padding:0 16px;border-radius:12px;
          background:var(--accent,#4f8ef7);color:#fff;font-weight:700;font-size:0.85rem;
          border:none;cursor:pointer">Instalar</button>
        <button id="pwaDismissBtn" aria-label="Fechar" style="flex-shrink:0;width:28px;height:28px;
          border-radius:8px;background:var(--surface2,#f5f7fa);border:none;
          color:var(--muted,#8a9bb0);font-size:0.9rem;cursor:pointer">✕</button>
      `;
    } else {
      banner.innerHTML = `
        ${iconHtml}
        <div style="flex:1;min-width:0">
          <strong style="display:block;font-size:0.88rem;color:var(--text,#1a1f2e);margin-bottom:2px">
            Instalar PulseNote no iPhone
          </strong>
          <span style="font-size:0.78rem;color:var(--muted,#8a9bb0);line-height:1.4">
            Toque em <strong>Compartilhar</strong> (◻️↑) e depois em
            <strong>"Adicionar à Tela de Início"</strong>
          </span>
        </div>
        <button id="pwaDismissBtn" aria-label="Fechar" style="flex-shrink:0;width:28px;height:28px;
          border-radius:8px;background:var(--surface2,#f5f7fa);border:none;
          color:var(--muted,#8a9bb0);font-size:0.9rem;cursor:pointer;align-self:flex-start">✕</button>
      `;
    }

    document.body.appendChild(banner);

    document.getElementById("pwaDismissBtn").addEventListener("click", () => {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
      banner.remove();
    });

    const installBtn = document.getElementById("pwaInstallBtn");
    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === "accepted") banner.remove();
        deferredPrompt = null;
      });
    }
  }
})();
