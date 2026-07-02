// api/parse-transaction.js
// ============================================================
// Endpoint usado pelo recurso "✨ Lançar por texto" em Finanças.
// Usa o nível GRATUITO da API do Gemini (Google).
//
// Por que isso precisa de um backend (e não pode ser chamado direto do
// navegador): a chave da API é secreta. Se o app chamasse o Gemini direto
// do navegador, qualquer pessoa poderia abrir o DevTools e roubar a chave —
// e ela ficaria associada à SUA cota gratuita. Por isso o frontend chama
// ESTE endpoint (no mesmo domínio, sem problema de CORS), e é ele quem
// guarda a chave e fala com a IA.
//
// Fluxo:
//   1) Confirma que quem está chamando é um usuário de verdade, logado no
//      PulseNote (verifica o token do Firebase Auth) — sem isso, qualquer
//      pessoa na internet poderia consumir sua cota gratuita do Gemini.
//   2) Manda o texto livre + a lista de categorias do usuário para o
//      Gemini, com um "responseSchema" que obriga a resposta a vir num
//      formato JSON fixo (e a escolher só entre os ids de categoria que
//      realmente existem para esse usuário).
//   3) Se o Gemini falhar por qualquer motivo (cota do nível grátis
//      esgotada, erro de rede etc.), devolve um erro claro — o frontend
//      then cai para o reconhecimento local (sem IA) como reserva, então o
//      recurso nunca trava completamente.
//
// Variáveis de ambiente necessárias (configure no painel da Vercel — veja
// AI_FEATURE_SETUP.md):
//   GEMINI_API_KEY
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
// ============================================================

const admin = require("firebase-admin");
const { parseTransactionText } = require("./_lib/parseTransactionAI");

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // No painel da Vercel as quebras de linha da chave privada chegam
      // como "\n" literal — precisamos converter de volta para quebras
      // de linha reais, senão a assinatura da credencial fica inválida.
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
  return admin;
}

async function verifyUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) throw new Error("missing_token");

  const fb = getFirebaseAdmin();
  const decoded = await fb.auth().verifyIdToken(token);
  return decoded.uid;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // ── 1) Autenticação ──────────────────────────────────────────
  try {
    await verifyUser(req);
  } catch (err) {
    console.error("Falha na autenticação:", err.message);
    return res.status(401).json({ error: "unauthorized" });
  }

  // ── 2) Validação básica + chamada à IA (lógica compartilhada com o
  //      webhook do WhatsApp — ver api/_lib/parseTransactionAI.js) ──
  const { text, categories, today } = req.body || {};
  const result = await parseTransactionText({ text, categories, today });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json(result.entry);
};
