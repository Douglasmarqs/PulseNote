// firebase-config.js
// ============================================================
// Configuração central do Firebase para o PulseNote
// ============================================================
//
// COMO OBTER SUAS CREDENCIAIS:
// 1. Acesse https://console.firebase.google.com
// 2. Crie um projeto novo (gratuito)
// 3. No menu lateral: Build > Authentication > Sign-in method
//    → Ative "E-mail/senha"
// 4. No menu lateral: Build > Firestore Database > Criar banco
//    → Inicie em modo de produção (as regras de segurança já
//      estão prontas no arquivo firestore.rules deste projeto)
// 5. Vá em ⚙️ Configurações do projeto > Geral > Seus apps
//    → Clique no ícone "</>" (Web) e registre o app
// 6. Copie o objeto firebaseConfig gerado e cole abaixo
//
// ============================================================

export const firebaseConfig = {
  apiKey: "SUA_API_KEY_AQUI",
  authDomain: "seu-projeto.firebaseapp.com",
  projectId: "seu-projeto",
  storageBucket: "seu-projeto.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxxxxxxxxxx",
};

// Aviso amigável caso alguém abra o app sem preencher as credenciais acima
if (firebaseConfig.apiKey === "SUA_API_KEY_AQUI") {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.innerHTML = `
      <div style="min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:-apple-system,sans-serif;background:#f0f4ff">
        <div style="max-width:480px;background:#fff;border-radius:24px;padding:36px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center">
          <div style="font-size:2.5rem;margin-bottom:12px">🔧</div>
          <h1 style="font-size:1.3rem;font-weight:800;color:#1a1f2e;margin-bottom:10px">Firebase ainda não configurado</h1>
          <p style="color:#4a5568;line-height:1.6;font-size:0.92rem">
            Abra o arquivo <code style="background:#f5f7fa;padding:2px 6px;border-radius:6px">firebase-config.js</code>
            e cole as credenciais do seu projeto Firebase.<br/><br/>
            As instruções completas estão comentadas no topo do arquivo.
          </p>
        </div>
      </div>
    `;
  });
}

// Nome da coleção do Firestore onde os dados de cada usuário ficam
export const USER_DATA_COLLECTION = "userData";
