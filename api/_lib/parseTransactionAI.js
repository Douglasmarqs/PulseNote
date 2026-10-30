// api/_lib/parseTransactionAI.js
// ============================================================
// Núcleo do "✨ Lançar por texto" (e agora também de foto de cupom):
// manda uma frase livre OU uma imagem + a lista de categorias do
// usuário para o Gemini e devolve um lançamento estruturado
// ({type, amount, categoryId, description, date}).
//
// Extraído de api/parse-transaction.js para ser reaproveitado também
// pelo webhook do WhatsApp (api/whatsapp-webhook.js) — é a MESMA lógica,
// só que agora mora num lugar só.
// ============================================================

// A família Gemini 2.5 está sendo desativada pela Google (desligamento
// completo até out/2026, mas o Flash-Lite já vinha falhando com 404/503
// bem antes disso — foi o que apareceu nos logs do webhook). Trocado
// para o sucessor indicado pela própria Google, mesmo nível
// rápido/barato/gratuito. O mesmo modelo lê imagem também (multimodal).
const { fetchGeminiJson, GEMINI_MODEL } = require("./geminiFetch");
const { guessSpecificCategoryId } = require("./localTextFallback");

function buildSystemPrompt({ todayIso, categoryList, mediaMode = false }) {
  return `Você extrai dados de um lançamento financeiro a partir do que o usuário mandou (uma frase em português, OU a foto/PDF de um cupom fiscal, boleto ou comprovante).
Data de hoje: ${todayIso}.

Categorias disponíveis (escolha exatamente um destes ids, sempre do tipo compatível):
${categoryList}

Regras OBRIGATÓRIAS:
- "amount": número positivo em reais (ex.: 32.5). Se for uma foto de cupom, use o VALOR TOTAL da compra (procure por "TOTAL", "VALOR A PAGAR" — não some cada item à mão se já houver um total impresso). Obrigatório.
- "date": se houver referência de data relativa no texto ("ontem", "anteontem"/"antes de ontem", "semana passada", "segunda-feira", "dia 12", "27/06" etc.), calcule a data real YYYY-MM-DD a partir de hoje. Se for cupom fiscal com data impressa, use essa data. Para boleto NÃO pago, nunca use o vencimento como data de pagamento. Sem nenhuma referência, use hoje.
- "type": "despesa" por padrão. Use "receita" APENAS se for entrada de dinheiro (salário, recebimento, venda, reembolso, freelance, rendimento etc.) — cupom fiscal é sempre "despesa".
- "categoryId": escolha o id que melhor descreve o que foi dito/comprado. Priorize o mais específico (ex.: se a frase cita "mercado" ou o cupom é de supermercado, escolha "mercado" — não "outros"). Deve ser do mesmo tipo de "type". NUNCA escolha uma categoria genérica tipo "outros"/"outros_receita" se qualquer categoria mais específica da lista puder se aplicar pelo SENTIDO do que foi dito, mesmo sem a palavra exata (ex.: "gastei com o veterinário" → categoria de pet; "comprei fralda" → categoria de filhos/família; "paguei o seguro do carro" → categoria de seguros). Só use "outros"/"outros_receita" quando genuinely nenhuma categoria da lista tiver relação com o que foi dito.
- "description": 2 a 5 palavras que descrevam O QUE foi gasto/recebido — NÃO use o nome da categoria como descrição. Se for cupom, use o nome do estabelecimento (ex.: "Supermercado Extra", "Farmácia Drogasil"). Se for texto, extraia do que foi dito, removendo só conectores ("gastei", "paguei", "recebi", "reais", "de", "com", "no", "na" etc.).
${mediaMode ? '- Para imagem/PDF, informe também "documentKind" (cupom, nota_fiscal, comprovante, boleto ou outro), "paymentStatus" (pago, pendente ou desconhecido) e "dueDate" somente quando o vencimento estiver legível. Informe "paymentMethod" (pix, boleto, cartao_debito, cartao_credito, dinheiro, transferencia ou desconhecido) apenas se o meio de pagamento estiver explícito no documento; um boleto ou uma nota fiscal por si só NÃO comprovam o meio usado nem a quitação. Boleto com código de barras e vencimento, sem comprovante de quitação, é pendente. Se o valor total não estiver legível, não invente.' : ''}

Exemplo 1 — entrada: "gastei 32 reais no ifood ontem"
Saída: {"type":"despesa","amount":32,"categoryId":"alimentacao","description":"iFood","date":"${todayIso}"}

Exemplo 2 — entrada: "paguei 80 reais de gasolina antes de ontem"
Saída: {"type":"despesa","amount":80,"categoryId":"transporte","description":"Gasolina","date":"${todayIso}"}

Exemplo 3 — entrada: "recebi salário 2500"
Saída: {"type":"receita","amount":2500,"categoryId":"salario","description":"Salário mensal","date":"${todayIso}"}

Exemplo 4 — entrada: foto de cupom fiscal de supermercado, total R$ 143,90, datado de 10/07
Saída: {"type":"despesa","amount":143.90,"categoryId":"mercado","description":"Supermercado","date":"AAAA-07-10"}`;
}

// Faz a chamada ao Gemini com o "contents" já montado (texto OU
// imagem+texto) e valida/normaliza a resposta. Uso interno — quem chama
// de fora é parseTransactionText() ou parseTransactionImage().
async function callGeminiForEntry({ contents, categories, today, mediaMode = false }) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return { ok: false, status: 400, error: "invalid_categories" };
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY não configurada.");
    return { ok: false, status: 500, error: "ai_not_configured" };
  }

  const todayIso = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10);
  const categoryIds = categories.map((c) => c.id);
  const categoryList = categories.map((c) => `- ${c.id} (${c.type}): ${c.label}`).join("\n");
  const systemPrompt = buildSystemPrompt({ todayIso, categoryList, mediaMode });

  const aiResult = await fetchGeminiJson({
    model: GEMINI_MODEL,
    apiKey: process.env.GEMINI_API_KEY,
    systemPrompt,
    contents,
    label: "transaction",
    timeoutMs: mediaMode ? 14000 : 9000,
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
          ...(mediaMode ? {
            documentKind: { type: "string", enum: ["cupom", "nota_fiscal", "comprovante", "boleto", "outro"] },
            paymentStatus: { type: "string", enum: ["pago", "pendente", "desconhecido"] },
            paymentMethod: { type: "string", enum: ["pix", "boleto", "cartao_debito", "cartao_credito", "dinheiro", "transferencia", "desconhecido"] },
            dueDate: { type: "string" },
          } : {}),
        },
        required: ["type", "amount", "categoryId", "description", "date", ...(mediaMode ? ["documentKind", "paymentStatus"] : [])],
      },
    },
  });

  if (!aiResult.ok) return aiResult;
  const parsed = aiResult.parsed;

  const type = parsed.type === "receita" ? "receita" : "despesa";
  const amount = Math.round(Number(parsed.amount) * 100) / 100;
  const validIds = new Set(categories.filter((c) => c.type === type).map((c) => c.id));
  let categoryId = validIds.has(parsed.categoryId)
    ? parsed.categoryId
    : type === "receita" ? "outros_receita" : "outros";
  const sourceText = contents.map((part) => part.text || "").join(" ");
  const explicitCategoryId = guessSpecificCategoryId(sourceText, type, categories);
  if (explicitCategoryId) categoryId = explicitCategoryId;
  const description = String(parsed.description || "").slice(0, 60).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : todayIso;

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: 422, error: "ai_invalid_amount" };
  }

  const result = { ok: true, entry: { type, amount, categoryId, description, date } };
  if (mediaMode) {
    const kinds = ["cupom", "nota_fiscal", "comprovante", "boleto", "outro"];
    const statuses = ["pago", "pendente", "desconhecido"];
    result.mediaAssessment = {
      documentKind: kinds.includes(parsed.documentKind) ? parsed.documentKind : "outro",
      paymentStatus: statuses.includes(parsed.paymentStatus) ? parsed.paymentStatus : "desconhecido",
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate) ? parsed.dueDate : "",
    };
    const methods = {
      pix: "Pix", boleto: "Boleto", cartao_debito: "Cartão de débito",
      cartao_credito: "Cartão de crédito", dinheiro: "Dinheiro", transferencia: "Transferência",
    };
    if (methods[parsed.paymentMethod]) result.mediaAssessment.paymentMethod = methods[parsed.paymentMethod];
  }
  return result;
}

// categories: [{id, type, label}], today: "YYYY-MM-DD", text: string livre
// Retorna { ok: true, entry } ou { ok: false, status, error }
async function parseTransactionText({ text, categories, today }) {
  if (!text || typeof text !== "string" || !text.trim() || text.length > 200) {
    return { ok: false, status: 400, error: "invalid_text" };
  }
  return callGeminiForEntry({
    contents: [{ text: text.trim().slice(0, 200) }],
    categories,
    today,
  });
}

// imageBase64: string base64 SEM o prefixo "data:...;base64,", mimeType:
// ex. "image/jpeg". Usado pelo webhook do WhatsApp quando a pessoa manda
// foto ou PDF de cupom/boleto/comprovante em vez de texto.
async function parseTransactionImage({ imageBase64, mimeType, categories, today, caption = "" }) {
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return { ok: false, status: 400, error: "invalid_image" };
  }
  return callGeminiForEntry({
    contents: [
      { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBase64 } },
      { text: `Extraia os dados desta foto ou PDF de cupom, nota fiscal, boleto ou comprovante. Legenda da pessoa: ${String(caption || "").slice(0, 300)}. Siga as regras do systemInstruction.` },
    ],
    categories,
    today,
    mediaMode: true,
  });
}

// A pessoa também pode enviar uma foto de anotação (ou um PDF simples) em
// vez de digitar. Guardamos somente a transcrição confirmada, nunca a imagem
// binária no documento Firestore de 1 MiB.
async function parseNoteImage({ imageBase64, mimeType, caption = "" }) {
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return { ok: false, status: 400, error: "invalid_image" };
  }
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, status: 503, error: "ai_not_configured" };
  }
  const result = await fetchGeminiJson({
    model: GEMINI_MODEL,
    apiKey: process.env.GEMINI_API_KEY,
    label: "note_ocr",
    timeoutMs: 14000,
    systemPrompt: "Transcreva fielmente a anotação desta imagem/PDF em português. Não invente trechos ilegíveis, dados pessoais ou valores. Retorne título curto e conteúdo em JSON. Se não houver texto legível, use conteúdo vazio.",
    contents: [
      { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBase64 } },
      { text: `Legenda fornecida: ${String(caption).slice(0, 300)}. Transcreva o texto visível.` },
    ],
    generationConfig: {
      maxOutputTokens: 700,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: { title: { type: "string" }, content: { type: "string" } },
        required: ["title", "content"],
      },
    },
  });
  if (!result.ok) return result;
  const title = String(result.parsed?.title || "").trim().slice(0, 80);
  const content = String(result.parsed?.content || "").trim().slice(0, 4000);
  if (!content) return { ok: false, status: 422, error: "unreadable_note" };
  return { ok: true, note: { title: title || content.slice(0, 40), description: content } };
}

// Áudios do WhatsApp chegam como OGG/Opus na maior parte dos aparelhos.
// Em vez de criar outro classificador para eles, primeiro obtemos uma
// transcrição curta e depois reaproveitamos exatamente o mesmo parser de
// comandos usado para mensagens de texto. Isso mantém "criar tarefa",
// "anotar", "marcar compromisso" e lançamentos financeiros coerentes.
async function transcribeAudio({ audioBase64, mimeType }) {
  if (!audioBase64 || typeof audioBase64 !== "string") {
    return { ok: false, status: 400, error: "invalid_audio" };
  }
  if (!process.env.GEMINI_API_KEY) {
    return { ok: false, status: 500, error: "ai_not_configured" };
  }

  const result = await fetchGeminiJson({
    model: GEMINI_MODEL,
    apiKey: process.env.GEMINI_API_KEY,
    label: "audio_transcription",
    systemPrompt: "Transcreva o áudio em português brasileiro. Retorne somente JSON. Não invente palavras; se não houver fala compreensível, use uma transcrição vazia.",
    contents: [
      { inlineData: { mimeType: mimeType || "audio/ogg", data: audioBase64 } },
      { text: "Transcreva a fala deste áudio." },
    ],
    generationConfig: {
      maxOutputTokens: 300,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: { transcript: { type: "string" } },
        required: ["transcript"],
      },
    },
  });

  const transcript = String(result.parsed?.transcript || "").trim().slice(0, 500);
  return result.ok && transcript ? { ok: true, transcript } : { ok: false, status: result.status || 422, error: "audio_not_understood" };
}

module.exports = { parseTransactionText, parseTransactionImage, parseNoteImage, transcribeAudio };
