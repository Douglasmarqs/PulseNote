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

const GEMINI_MODEL = "gemini-2.5-flash-lite"; // rápido, barato, elegível ao nível grátis

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

  // ── 2) Validação básica da entrada ───────────────────────────
  const { text, categories, today } = req.body || {};
  if (!text || typeof text !== "string" || !text.trim() || text.length > 200) {
    return res.status(400).json({ error: "invalid_text" });
  }
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ error: "invalid_categories" });
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY não configurada.");
    return res.status(500).json({ error: "ai_not_configured" });
  }

  const todayIso = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10);
  const categoryIds = categories.map((c) => c.id);
  const categoryList = categories.map((c) => `- ${c.id} (${c.type}): ${c.label}`).join("\n");

  const systemPrompt = `Você extrai dados de um lançamento financeiro a partir de uma frase em português.
Data de hoje: ${todayIso}.

Categorias disponíveis (escolha exatamente um destes ids, sempre do tipo compatível):
${categoryList}

Regras:
- "amount": número positivo em reais (ex.: 32.5).
- Se houver referências relativas de data ("ontem", "semana passada"), calcule a data real a partir de hoje. Sem data explícita, use hoje.
- "description": curta (até 6 palavras), capturando o essencial da frase.
- "type": "despesa" por padrão; só use "receita" se for claramente uma entrada de dinheiro (salário, venda, recebimento, reembolso etc).
- "categoryId": escolha o id mais adequado da lista acima, do mesmo tipo escolhido em "type". Se nada combinar bem, use a categoria "outros" (despesa) ou "outros_receita" (receita).`;

  // ── 3) Chama o Gemini, forçando o formato da resposta com responseSchema ──
  let raw;
  try {
    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: text.trim().slice(0, 200) }] }],
          generationConfig: {
            maxOutputTokens: 200,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["despesa", "receita"] },
                amount: { type: "number" },
                categoryId: { type: "string", enum: categoryIds },
                description: { type: "string" },
                date: { type: "string" },
              },
              required: ["type", "amount", "categoryId", "description", "date"],
            },
          },
        }),
      }
    );

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error("Erro na API do Gemini:", aiRes.status, errBody);
      if (aiRes.status === 429) {
        return res.status(429).json({ error: "ai_rate_limited" });
      }
      return res.status(502).json({ error: "ai_request_failed" });
    }

    const data = await aiRes.json();
    raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  } catch (err) {
    console.error("Erro inesperado chamando o Gemini:", err);
    return res.status(502).json({ error: "ai_request_failed" });
  }

  // ── 4) Valida o que a IA devolveu antes de confiar nisso ──────
  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (err) {
    console.error("Resposta do Gemini não é um JSON válido:", raw);
    return res.status(502).json({ error: "ai_bad_response" });
  }

  const validIds = new Set(categoryIds);
  const type = parsed.type === "receita" ? "receita" : "despesa";
  const amount = Math.round(Number(parsed.amount) * 100) / 100;
  const categoryId = validIds.has(parsed.categoryId)
    ? parsed.categoryId
    : type === "receita" ? "outros_receita" : "outros";
  const description = String(parsed.description || "").slice(0, 60).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : todayIso;

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(422).json({ error: "ai_invalid_amount" });
  }

  return res.status(200).json({ type, amount, categoryId, description, date });
};
