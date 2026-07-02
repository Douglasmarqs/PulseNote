// pwa-install.js — Registro do Service Worker + botão/banner de instalação
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

  // ── Detecta a plataforma ────────────────────────────────────────
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

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
    btn.innerHTML = `<span style="font-size:1.05rem">⬇️</span><span>Instalar app</span>`;

    btn.addEventListener("click", () => handleInstallClick(platform));
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

  function showInstructionsModal(platform) {
    if (document.getElementById("pwaInstructionsModal")) return;

    const modal = document.createElement("div");
    modal.id = "pwaInstructionsModal";
    modal.style.cssText = `position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);
      backdrop-filter:blur(6px);display:grid;place-items:center;padding:20px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;

    const stepsIOS = `
      <ol style="margin:0;padding-left:20px;display:grid;gap:10px;color:#4a5568;font-size:0.9rem;line-height:1.5">
        <li>Toque no ícone de <strong>Compartilhar</strong> (quadrado com seta ↑) na barra do Safari</li>
        <li>Role para baixo e toque em <strong>"Adicionar à Tela de Início"</strong></li>
        <li>Toque em <strong>"Adicionar"</strong> no canto superior direito</li>
      </ol>`;

    const stepsAndroidFallback = `
      <ol style="margin:0;padding-left:20px;display:grid;gap:10px;color:#4a5568;font-size:0.9rem;line-height:1.5">
        <li>Toque no menu (três pontinhos ⋮) no canto superior do navegador</li>
        <li>Toque em <strong>"Instalar app"</strong> ou <strong>"Adicionar à tela inicial"</strong></li>
        <li>Confirme tocando em <strong>"Instalar"</strong></li>
      </ol>`;

    modal.innerHTML = `
      <div style="background:#fff;border-radius:24px;padding:28px;width:100%;max-width:380px;
        box-shadow:0 20px 60px rgba(0,0,0,0.25)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h2 style="font-size:1.1rem;font-weight:800;color:#1a1f2e;margin:0">Instalar o PulseNote</h2>
          <button id="closePwaInstructions" style="width:30px;height:30px;border-radius:10px;
            background:#f5f7fa;border:none;font-size:1rem;cursor:pointer;color:#4a5568">✕</button>
        </div>
        ${platform === "ios" ? stepsIOS : stepsAndroidFallback}
      </div>
    `;

    document.body.appendChild(modal);
    document.getElementById("closePwaInstructions").addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  }

  // ── Banner dispensável (aparece uma vez, pode ser fechado) ──────
  function maybeShowDismissableBanner(platform) {
    const DISMISS_KEY = "pn_install_banner_dismissed_at";
    const dismissedAt = localStorage.getItem(DISMISS_KEY);
    if (dismissedAt && Date.now() - Number(dismissedAt) < 7 * 24 * 60 * 60 * 1000) return;
    if (document.getElementById("pwaInstallBanner")) return;

    const banner = document.createElement("div");
    banner.id = "pwaInstallBanner";
    banner.style.cssText = `
      position:fixed; left:16px; right:16px; bottom:max(16px, env(safe-area-inset-bottom));
      z-index:9997; background:#fff; border:1.5px solid #e8ecf2;
      border-radius:20px; box-shadow:0 12px 36px rgba(0,0,0,0.18);
      padding:16px; display:flex; align-items:center; gap:12px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      animation:pwaSlideUp 320ms ease; max-width:480px; margin:0 auto;
    `;

    const style = document.createElement("style");
    style.textContent = `@keyframes pwaSlideUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }`;
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
          <strong style="display:block;font-size:0.92rem;color:#1a1f2e">Instalar PulseNote</strong>
          <span style="font-size:0.8rem;color:#8a9bb0">Acesso rápido direto da tela inicial</span>
        </div>
        <button id="pwaInstallBtn" style="flex-shrink:0;height:38px;padding:0 16px;border-radius:12px;
          background:#4f8ef7;color:#fff;font-weight:700;font-size:0.85rem;
          border:none;cursor:pointer">Instalar</button>
        <button id="pwaDismissBtn" aria-label="Fechar" style="flex-shrink:0;width:28px;height:28px;
          border-radius:8px;background:#f5f7fa;border:none;
          color:#8a9bb0;font-size:0.9rem;cursor:pointer">✕</button>
      `;
    } else {
      banner.innerHTML = `
        ${iconHtml}
        <div style="flex:1;min-width:0">
          <strong style="display:block;font-size:0.88rem;color:#1a1f2e;margin-bottom:2px">
            Instalar PulseNote no iPhone
          </strong>
          <span style="font-size:0.78rem;color:#8a9bb0;line-height:1.4">
            Toque em <strong>Compartilhar</strong> (◻️↑) e depois em
            <strong>"Adicionar à Tela de Início"</strong>
          </span>
        </div>
        <button id="pwaDismissBtn" aria-label="Fechar" style="flex-shrink:0;width:28px;height:28px;
          border-radius:8px;background:#f5f7fa;border:none;
          color:#8a9bb0;font-size:0.9rem;cursor:pointer;align-self:flex-start">✕</button>
      `;
    }

    document.body.appendChild(banner);

    document.getElementById("pwaDismissBtn").addEventListener("click", () => {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
      banner.remove();
    });

    const installBtn = document.getElementById("pwaInstallBtn");
    if (installBtn) {
      installBtn.addEventListener("click", () => handleInstallClick("android"));
    }
  }
})();
