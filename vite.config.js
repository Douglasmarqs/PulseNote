import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// BookVerse — configuração do Vite + PWA
//
// O plugin gera o service worker e injeta o manifest automaticamente.
// "registerType: autoUpdate" cobre o requisito de "atualização automática"
// do módulo de PWA: quando uma nova versão é publicada, o service worker
// antigo é substituído sem o usuário precisar desinstalar/reinstalar.

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'BookVerse',
        short_name: 'BookVerse',
        description: 'O app que torna a leitura um hábito diário.',
        theme_color: '#14182B',
        background_color: '#14182B',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'pt-BR',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Cache inteligente: arquivos estáticos do build (JS/CSS/fontes)
        // ficam disponíveis offline. Dados do Firestore NÃO passam por
        // aqui — eles têm a própria camada de cache/offline do SDK do
        // Firebase, que é mais segura para dados que mudam (evita
        // mostrar informação desatualizada como se fosse atual).
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/index.html',
      },
      devOptions: {
        enabled: false, // ativar manualmente se for testar o SW em dev
      },
    }),
  ],
  server: {
    port: 5173,
  },
})
