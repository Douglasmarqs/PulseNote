// firebase-init.js
// ============================================================
// Inicializa o Firebase (App, Auth, Firestore) e exporta
// instâncias prontas para uso em toda a aplicação.
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  enableIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Mantém o usuário logado entre sessões do navegador (até deslogar manualmente)
setPersistence(auth, browserLocalPersistence).catch((err) =>
  console.warn("Não foi possível definir persistência de login:", err)
);

// Permite que o app funcione offline com cache local automático do Firestore
enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("Persistência offline indisponível: múltiplas abas abertas.");
  } else if (err.code === "unimplemented") {
    console.warn("Persistência offline não suportada neste navegador.");
  }
});
