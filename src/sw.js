// sw.js — Service Worker do PulseNote
// Necessário para o app ser "instalável" (PWA) no Android/Chrome,
// funcionar parcialmente offline, e exibir notificações do sistema.

// v10: corrige um bug real de cache que causava loop de redirecionamento
// (a tela ficava alternando e não abria). A causa: o handler de fetch
// cacheava QUALQUER requisição — inclusive a página /app em si — com a
// mesma estratégia "responde do cache na hora" usada pra CSS/imagens. Se
// alguma vez a resposta de /app viesse errada (ex.: durante uma janela de
// deploy), aquele HTML errado ficava preso no cache pra sempre, e a cada
// visita a /app o navegador servia essa versão errada de novo — que por
// sua vez tentava redirecionar de novo, num loop. Documentos de navegação
// (a própria página HTML) agora sempre buscam da rede primeiro; só
// arquivos estáticos (CSS/JS/imagens) continuam usando cache instantâneo.
// v11: mesma correção da v10, republicada para forçar mais um ciclo de
// atualização em quem ainda estava preso numa versão antiga do cache —
// junto com uma checagem de atualização mais agressiva em pwa-install.js
// (agora também verifica ao voltar pra aba, não só ao abrir o app).
// v12: adiciona o bloco de Firebase Cloud Messaging abaixo (push em
// segundo plano) — bump só pra garantir que quem já tinha o SW instalado
// receba essa versão nova o quanto antes.
// v13: invalida o CSS de autenticação após alinhar login/cadastro aos temas
// do painel. Sem trocar o nome, o stale-while-revalidate podia exibir a
// paleta anterior na primeira abertura de um PWA já instalado.
// v14: entrega a nova paleta, os cartões de notas formatados e a análise
// financeira também para quem já instalou o PWA.
// v15: alinha o tema Eclipse à paleta violeta/ciano da atualização.
const CACHE_NAME = "pulsenote-v15";

// ── Firebase Cloud Messaging (push em segundo plano) ──────────────
// Isso é o que permite uma notificação aparecer mesmo com o PulseNote
// fechado: o servidor (api/send-reminders.js) manda um push pro FCM, o
// FCM entrega pro navegador, e o navegador "acorda" este Service Worker
// só pra rodar o onBackgroundMessage abaixo.
//
// Usa o SDK "compat" (não o modular usado em app.js/push-notifications.js)
// porque é o único formato que o importScripts() de dentro de um Service
// Worker aceita carregar.
//
// Ficam num try/catch: se o import falhar por qualquer motivo (ex.: sem
// internet no exato instante em que o navegador reinstala o SW), o resto
// deste arquivo continua funcionando normal — cache e PWA não dependem
// disso.
try {
  importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

  // Mesmos valores públicos de src/firebase-config.js (chave de API de app
  // web não é segredo — é sempre visível no navegador; a segurança real
  // vem das regras do Firestore/Auth, não de esconder isso).
  firebase.initializeApp({
    apiKey: "AIzaSyC6SmmVCWogvtaOdN3NPPPKDreGClIGvlE",
    authDomain: "pulsenote-f99e2.firebaseapp.com",
    projectId: "pulsenote-f99e2",
    storageBucket: "pulsenote-f99e2.firebasestorage.app",
    messagingSenderId: "244574278691",
    appId: "1:244574278691:web:68835a5fdff4f178340d96",
  });

  const messaging = firebase.messaging();

  // O envio em api/send-reminders.js manda a notificação como "data"
  // (não "notification") DE PROPÓSITO — assim o FCM nunca mostra uma
  // notificação genérica sozinho, e a gente controla 100% da aparência
  // aqui, igual às notificações locais (ícone do Pulsinho, "tag" pra
  // evitar duplicata, e os mesmos dados usados pelo notificationclick
  // logo abaixo pra abrir a tela certa).
  messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    self.registration.showNotification(data.title || "PulseNote", {
      body: data.body || "",
      icon: "icons/pulsinho-notification-icon.png",
      badge: "icons/pulsinho-notification-icon.png",
      tag: data.tag || "pulsenote-push",
      vibrate: [120, 60, 120],
      data: { view: data.view || "dashboard", itemId: data.itemId || null },
    });
  });
} catch (err) {
  console.warn("Firebase Messaging não pôde ser inicializado no Service Worker:", err);
}

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

  // Documentos de navegação (a página em si: /app, /login, / etc.) — SEMPRE
  // busca da rede primeiro. É a categoria de arquivo onde "servir uma versão
  // presa no cache" causa os problemas mais graves (loop de redirecionamento,
  // tela branca, versão antiga do app inteiro), então aqui staleness nunca
  // vale a pena — só cai pro cache se a rede falhar de verdade (offline).
  const isNavigation = request.mode === "navigate" || request.destination === "document";
  if (isNavigation) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.open(CACHE_NAME).then((cache) => cache.match(request)))
    );
    return;
  }

  // Estratégia para o resto (CSS/JS/imagens): "stale-while-revalidate" —
  // responde IMEDIATAMENTE com a versão em cache (se existir), o que faz o
  // app abrir na hora em vez de esperar a rede toda vez, e por trás dos
  // panos busca uma versão nova na rede para deixar pronta na próxima
  // abertura. Se não houver cache ainda (primeira visita), espera a rede
  // normalmente.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);

      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) cache.put(request, response.clone());
          return response;
        })
        .catch(() => undefined);

      // Já tem em cache? Devolve na hora e atualiza em segundo plano.
      if (cached) {
        networkFetch; // deixa rodando sem bloquear a resposta
        return cached;
      }

      // Sem cache (primeira visita a esse arquivo): espera a rede, e cai
      // pro cache só se a rede falhar (ex.: sem internet).
      return (await networkFetch) || cached || Response.error();
    })
  );
});

// ── Notificações ─────────────────────────────────────────────
// Quando o usuário toca numa notificação, abre o app na tela certa
// (ex: tocar numa notificação de tarefa abre direto a aba de Tarefas)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetView = event.notification.data?.view || "dashboard";
  const itemId = event.notification.data?.itemId || null;
  const itemParam = itemId ? "&item=" + encodeURIComponent(itemId) : "";

  // IMPORTANTE: usamos a URL "bonita" (/app), que é a rota real exposta pelo
  // vercel.json (rewrites). Abrir direto em "/src/index.html" parece
  // equivalente, mas é o caminho de ARQUIVO interno, não uma rota pública —
  // em produção isso resultava na tela branca de erro "404: NOT_FOUND" toda
  // vez que o usuário tocava em qualquer notificação.
  const targetUrl = "/app?action=open-" + targetView + itemParam;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      // Se o app já estiver aberto em alguma aba, foca nela e manda a view
      // desejada. A aba pode estar tanto em "/app" (rota bonita) quanto em
      // "/src/index.html" (caso tenha sido aberta direto), então aceitamos os
      // dois formatos ao procurar uma janela existente.
      const existing = clientsArr.find((c) => c.url.includes("/app") || c.url.includes("index.html"));
      if (existing) {
        existing.focus();
        existing.postMessage({ type: "open-view", view: targetView, itemId });
        return;
      }
      // Senão, abre uma aba nova já na view desejada (e no item, se houver)
      return self.clients.openWindow(targetUrl);
    })
  );
});
