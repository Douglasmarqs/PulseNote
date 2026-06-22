// firebase-config.js — Credenciais do projeto PulseNote no Firebase
// ─────────────────────────────────────────────────────────────────────
// ⚠️  LEMBRETE OBRIGATÓRIO PARA A VERCEL:
//
// Depois de fazer o deploy, acesse:
// Firebase Console → Authentication → Settings → Authorized domains
// → Add domain → cole: SEU-PROJETO.vercel.app
//
// Sem isso o login dará erro de "unauthorized-domain" na Vercel.
// ─────────────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey:            "AIzaSyC6SsmVCWogvtaOdN3NPPPKDreGClIGv1E",
  authDomain:        "pulsenote-f99e2.firebaseapp.com",
  projectId:         "pulsenote-f99e2",
  storageBucket:     "pulsenote-f99e2.firebasestorage.app",
  messagingSenderId: "244574278691",
  appId:             "1:244574278691:web:68835a5fdff4f178340d96",
  measurementId:     "G-HKB5FNZ32K",
};
