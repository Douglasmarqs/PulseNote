// sw.js — Service Worker do PulseNote
// Necessário para o app ser "instalável" (PWA) no Android/Chrome,
// funcionar parcialmente offline, e exibir notificações do sistema.

const CACHE_NAME = "pulsenote-v2";

// Arquivos essenciais para o app abrir mesmo sem internet.
// Usamos os caminhos REAIS (dentro de /src/), não os caminhos "bonitos"
// reescritos pela Vercel — assim o cache nunca fica inconsistente com
// o conteúdo de fato servido.
const CORE_ASSETS = [
  "/src/login.html",
  "/src/index.html",
  "/src/forgot-password.html",
  "/src/styles.css",
  "/src/auth.css",
  "/src/manifest.json",
  "/src/icons/icon-192.png",
  "/src/icons/icon-512.png",
];

// Instala o Service Worker e guarda os arquivos essenciais em cache.
// Cada arquivo é cacheado individualmente — se um falhar (ex: 404),
// os outros continuam sendo cacheados normalmente.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        CORE_ASSETS.map((url) => cache.add(url).catch((err) => {
          console.warn("Não foi possível cachear:", url, err);
        }))
      )
    )
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
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Só intercepta requisições GET deste mesmo site. Nunca intercepta:
  // - métodos diferentes de GET (POST/PUT usados em login, salvar dados, etc.)
  // - domínios externos (Firebase, Google Fonts, CDNs)
  // Interceptar essas requisições é o padrão mais associado a falsos
  // positivos de "site suspeito" em verificações automáticas de segurança,
  // porque se parece com um Service Worker tentando interceptar credenciais.
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Só cacheia respostas válidas (200 OK), nunca erros ou redirects
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// ── Notificações ─────────────────────────────────────────────
// Quando o usuário toca numa notificação, abre o app na tela certa
// (ex: tocar numa notificação de tarefa abre direto a aba de Tarefas)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetView = event.notification.data?.view || "dashboard";
  const itemId = event.notification.data?.itemId || null;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      // Se o app já estiver aberto em alguma aba, foca nela e manda a view desejada
      const existing = clientsArr.find((c) => c.url.includes("index.html"));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: "open-view", view: targetView, itemId });
        return;
      }
      // Senão, abre uma nova aba já na view desejada (e no item, se houver)
      const itemParam = itemId ? "&item=" + encodeURIComponent(itemId) : "";
      return self.clients.openWindow("/src/index.html?action=open-" + targetView + itemParam);
    })
  );
});
