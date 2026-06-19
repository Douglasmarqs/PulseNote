// firebase-init.js — inicialização do Firebase (v10+)
import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

export const app     = initializeApp(firebaseConfig);
export const auth    = getAuth(app);
export const storage = getStorage(app);

// Firestore com cache persistente offline
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

// Mantém o usuário logado entre sessões
setPersistence(auth, browserLocalPersistence).catch(() => {});
