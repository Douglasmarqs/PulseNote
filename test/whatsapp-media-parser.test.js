const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTransactionImage, parseNoteImage, transcribeAudio } = require("../api/_lib/parseTransactionAI");

async function withGeminiReply(reply, run) {
  const previousFetch = global.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  let requestBody;
  process.env.GEMINI_API_KEY = "test-key";
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }),
    };
  };
  try {
    return await run(() => requestBody);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
}

test("PDF de boleto conserva vencimento e estado pendente para confirmação", async () => {
  await withGeminiReply({
    type: "despesa", amount: 10.9, categoryId: "contas", description: "Conta de luz",
    date: "2026-10-17", documentKind: "boleto", paymentStatus: "pendente", dueDate: "2026-10-25",
  }, async (request) => {
    const result = await parseTransactionImage({
      imageBase64: "cGRm", mimeType: "application/pdf", caption: "boleto da luz",
      categories: [{ id: "contas", type: "despesa", label: "Contas" }], today: "2026-10-17",
    });
    assert.equal(result.ok, true);
    assert.equal(result.entry.amount, 10.9);
    assert.deepEqual(result.mediaAssessment, {
      documentKind: "boleto", paymentStatus: "pendente", dueDate: "2026-10-25",
    });
    assert.equal(request().contents[0].parts[0].inlineData.mimeType, "application/pdf");
  });
});

test("foto de anotação mantém o texto OCR, inclusive centavos escritos", async () => {
  await withGeminiReply({ title: "Saldo inicial", content: "Saldo inicial: R$ 10,90" }, async (request) => {
    const result = await parseNoteImage({ imageBase64: "aW1hZ2U=", mimeType: "image/jpeg", caption: "nota" });
    assert.deepEqual(result, {
      ok: true, note: { title: "Saldo inicial", description: "Saldo inicial: R$ 10,90" },
    });
    assert.equal(request().contents[0].parts[0].inlineData.mimeType, "image/jpeg");
  });
});

test("áudio OGG devolve transcrição para o roteador de comandos", async () => {
  await withGeminiReply({ transcript: "gastei 10,90 com pão" }, async (request) => {
    const result = await transcribeAudio({ audioBase64: "YXVkaW8=", mimeType: "audio/ogg" });
    assert.deepEqual(result, { ok: true, transcript: "gastei 10,90 com pão" });
    assert.equal(request().contents[0].parts[0].inlineData.mimeType, "audio/ogg");
  });
});
