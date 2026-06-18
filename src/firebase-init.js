// firebase-init.js — inicialização do Firebase (corrigido para v10+)
import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app  = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Firestore com cache persistente offline (API correta para Firebase 10+)
// persistentMultipleTabManager permite funcionar em várias abas ao mesmo tempo
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

// Mantém o usuário logado entre sessões (até clicar em Sair)
setPersistence(auth, browserLocalPersistence).catch(() => {});
