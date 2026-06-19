// sw.js — Service Worker do PulseNote
// Necessário para o app ser "instalável" (PWA) no Android/Chrome
// e para funcionar parcialmente offline.

const CACHE_NAME = "pulsenote-v1";

// Arquivos essenciais para o app abrir mesmo sem internet
const CORE_ASSETS = [
  "/login.html",
  "/index.html",
  "/forgot-password.html",
  "/styles.css",
  "/auth.css",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Instala o Service Worker e guarda os arquivos essenciais em cache
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

// Remove caches antigos quando uma nova versão do Service Worker é ativada
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Estratégia: tenta a rede primeiro (sempre dados atualizados);
// se falhar (offline), usa o cache como fallback.
// Não intercepta chamadas ao Firebase — essas sempre vão direto à rede.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Nunca cacheia chamadas ao Firebase/Google (autenticação e banco de dados
  // precisam sempre de dados em tempo real, nunca de uma versão antiga em cache)
  if (
    url.hostname.includes("firebase") ||
    url.hostname.includes("googleapis") ||
    url.hostname.includes("gstatic")
  ) {
    return; // deixa passar direto pela rede, sem intervenção
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Atualiza o cache com a versão mais recente
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
