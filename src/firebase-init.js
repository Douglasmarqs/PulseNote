// firebase-init.js — inicialização do Firebase (v10+)
import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence, GoogleAuthProvider }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

export const app     = initializeApp(firebaseConfig);
export const auth    = getAuth(app);
export const storage = getStorage(app);

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
