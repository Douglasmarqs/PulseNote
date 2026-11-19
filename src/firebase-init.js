// firebase-init.js — inicialização do Firebase (v10+)
import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence, GoogleAuthProvider }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app     = initializeApp(firebaseConfig);
export const auth    = getAuth(app);

// E-mails de verificação/recuperação e as páginas de ação do Firebase em
// português (QA 18/11: chegavam em inglês). O NOME no assunto ("PulseNote"
// no lugar de "project-244574278691") vem do "Nome público" do projeto no
// Console do Firebase → Configurações do projeto.
auth.languageCode = "pt-BR";

// Depois de clicar no link do e-mail, o botão "Continuar" volta para o app.
export const emailActionSettings = { url: `${window.location.origin}/app`, handleCodeInApp: false };

// Envia a verificação com o "Continuar" para o app; se o domínio atual não
// estiver autorizado no Firebase (preview/local), envia sem ele em vez de
// deixar a pessoa sem e-mail.
export async function sendVerificationEmail(sendEmailVerification, user) {
  try {
    return await sendEmailVerification(user, emailActionSettings);
  } catch (error) {
    if (!/continue-uri|unauthorized-domain/.test(String(error?.code || ""))) throw error;
    return sendEmailVerification(user);
  }
}

// Provedor de login com Google — pede sempre a tela de seleção de conta,
// para quem tem várias contas Google no aparelho escolher a certa.
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

// Firestore com cache persistente offline
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

// Mantém o usuário logado entre sessões
setPersistence(auth, browserLocalPersistence).catch(() => {});
