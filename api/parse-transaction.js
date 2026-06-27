// api/parse-transaction.js
// ============================================================
// Endpoint usado pelo recurso "✨ Lançar por texto (IA)" em Finanças.
//
// Por que isso precisa de um backend (e não pode ser chamado direto do
// navegador): a chave da API da IA é secreta. Se o app chamasse a Anthropic
// direto do navegador, qualquer pessoa poderia abrir o DevTools e roubar a
// chave. Por isso o frontend chama ESTE endpoint (que mora no mesmo domínio,
// sem problema de CORS), e é ele quem guarda a chave e fala com a IA.
//
// Fluxo:
//   1) Confirma que quem está chamando é um usuário de verdade, logado no
//      PulseNote (verifica o token do Firebase Auth) — sem isso, qualquer
//      pessoa na internet poderia usar sua chave da API e gerar custos.
//   2) Manda o texto livre + a lista de categorias do usuário para a IA,
//      pedindo de volta um JSON estruturado.
//   3) Valida o que a IA devolveu (nunca confiamos 100% na resposta de uma
//      IA) antes de repassar ao frontend.
//
// Variáveis de ambiente necessárias (configure no painel da Vercel, em
// Project Settings → Environment Variables — veja AI_FEATURE_SETUP.md):
//   ANTHROPIC_API_KEY
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
// ============================================================

const admin = require("firebase-admin");

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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY não configurada.");
    return res.status(500).json({ error: "ai_not_configured" });
  }

  const todayIso = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10);
  const categoryList = categories.map((c) => `- ${c.id} (${c.type}): ${c.label}`).join("\n");

  const system = `Você extrai dados de um lançamento financeiro a partir de uma frase em português.
Data de hoje: ${todayIso}.

Categorias disponíveis (use exatamente um destes ids, sempre do tipo compatível):
${categoryList}

Regras:
- "amount": número positivo em reais, com ponto decimal (ex.: 32.5).
- Se houver referências relativas de data ("ontem", "semana passada"), calcule a data real a partir de hoje. Sem data explícita, use hoje.
- "description": curta (até 6 palavras), capturando o essencial da frase.
- "type": "despesa" por padrão; só use "receita" se for claramente uma entrada de dinheiro (salário, venda, recebimento, reembolso etc).
- "categoryId": escolha o id mais adequado da lista acima, do mesmo tipo escolhido em "type". Se nada combinar bem, use a categoria "outros" (despesa) ou "outros_receita" (receita).

Responda SOMENTE com um objeto JSON válido (sem markdown, sem texto antes/depois), no formato:
{"type":"despesa","amount":0,"categoryId":"outros","description":"","date":"YYYY-MM-DD"}`;

  // ── 3) Chama a IA ─────────────────────────────────────────────
  let raw;
  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // Haiku é rápido e barato — mais que suficiente para uma tarefa de
        // extração estruturada simples como essa (não precisa do modelo
        // mais "caro" da família para isso).
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system,
        messages: [
          { role: "user", content: text.trim().slice(0, 200) },
          // Pré-preenchemos o início da resposta do assistente com "{" —
          // isso reduz bastante a chance de a IA "conversar" antes de
          // mandar o JSON, em vez de ir direto ao ponto.
          { role: "assistant", content: "{" },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error("Erro na API da Anthropic:", aiRes.status, errBody);
      return res.status(502).json({ error: "ai_request_failed" });
    }

    const data = await aiRes.json();
    const continuation = (data.content || []).map((block) => block.text || "").join("");
    raw = "{" + continuation;
  } catch (err) {
    console.error("Erro inesperado chamando a IA:", err);
    return res.status(502).json({ error: "ai_request_failed" });
  }

  // ── 4) Valida o que a IA devolveu antes de confiar nisso ──────
  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (err) {
    console.error("Resposta da IA não é um JSON válido:", raw);
    return res.status(502).json({ error: "ai_bad_response" });
  }

  const validIds = new Set(categories.map((c) => c.id));
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
