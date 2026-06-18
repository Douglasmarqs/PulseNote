// firebase-config.js — Cole aqui as credenciais do seu projeto Firebase
// ─────────────────────────────────────────────────────────────────────
// PASSO A PASSO (5 minutos, gratuito):
//
// 1. Acesse https://console.firebase.google.com
// 2. "Criar projeto" → dê um nome → prossiga
//
// 3. AUTENTICAÇÃO:
//    Menu lateral → Build → Authentication → "Vamos começar"
//    → Ative "E-mail/senha" → Salvar
//
// 4. BANCO DE DADOS:
//    Menu lateral → Build → Firestore Database → "Criar banco de dados"
//    → Escolha "southamerica-east1" (servidor no Brasil) → Modo produção
//
// 5. REGRAS DE SEGURANÇA:
//    Firestore → aba "Regras" → cole o conteúdo de firestore.rules → Publicar
//
// 6. CREDENCIAIS:
//    ⚙️ Configurações do projeto → Geral → "Seus apps" → clique em </>
//    → Registre o app → copie o firebaseConfig abaixo
//
// 7. DOMÍNIO AUTORIZADO (obrigatório para a Vercel funcionar):
//    Authentication → Settings → "Authorized domains" → Add domain
//    → Cole: SEU-PROJETO.vercel.app  (ou seu domínio customizado)
// ─────────────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey:            "SUA_API_KEY_AQUI",
  authDomain:        "seu-projeto.firebaseapp.com",
  projectId:         "seu-projeto",
  storageBucket:     "seu-projeto.appspot.com",
  messagingSenderId: "000000000000",
  appId:             "1:000000000000:web:xxxxxxxxxxxxxxxxxxxx",
};
