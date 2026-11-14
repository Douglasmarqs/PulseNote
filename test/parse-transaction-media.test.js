"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Carrega api/parse-transaction.js com Firebase, IA e painel admin simulados.
function loadRoute({ feature = { allowed: true }, ai = {} } = {}) {
  const calls = { features: [], image: [], audio: [], text: [] };
  const stub = (rel, exports) => {
    const file = require.resolve(path.join(__dirname, "..", "api", rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  stub("_lib/firebaseAdmin.js", { getFirebaseAdmin: () => ({ auth: () => ({ verifyIdToken: async () => ({ uid: "u1" }) }), firestore: () => ({}) }) });
  stub("_lib/admin.js", { checkUserFeature: async (_db, _uid, name) => { calls.features.push(name); return name === "aiParsing" ? { allowed: true } : feature; } });
  stub("_lib/parseTransactionAI.js", {
    parseTransactionText: async (args) => { calls.text.push(args); return ai.text || { ok: true, entry: { amount: 32, type: "despesa", categoryId: "alimentacao", description: "Almoço", date: "2025-01-24" } }; },
    parseTransactionImage: async (args) => { calls.image.push(args); return ai.image || { ok: true, entry: { amount: 420.9, type: "despesa", categoryId: "mercado", description: "Supermercado", date: "2025-01-23" } }; },
    transcribeAudio: async (args) => { calls.audio.push(args); return ai.audio || { ok: true, transcript: "almoço 32 reais hoje" }; },
  });
  const route = path.join(__dirname, "..", "api", "parse-transaction.js");
  delete require.cache[require.resolve(route)];
  return { handler: require(route), calls };
}

async function call(handler, body) {
  const res = { statusCode: 0, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
  await handler({ method: "POST", headers: { authorization: "Bearer t" }, body }, res);
  return res;
}

const tinyB64 = Buffer.from("conteúdo de teste").toString("base64");

test("foto do comprovante vira lançamento e exige a permissão de leitura de mídia", async () => {
  const { handler, calls } = loadRoute();
  const res = await call(handler, { mode: "image", imageBase64: tinyB64, mimeType: "image/jpeg", categories: [{ id: "mercado" }], today: "2025-01-24" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amount, 420.9);
  assert.deepEqual(calls.features, ["aiParsing", "mediaRecognition"]);
  assert.equal(calls.image[0].mimeType, "image/jpeg");
});

test("PDF é aceito como comprovante", async () => {
  const { handler } = loadRoute();
  const res = await call(handler, { mode: "image", imageBase64: tinyB64, mimeType: "application/pdf" });
  assert.equal(res.statusCode, 200);
});

test("áudio é transcrito e depois interpretado como texto, devolvendo a transcrição", async () => {
  const { handler, calls } = loadRoute();
  const res = await call(handler, { mode: "audio", audioBase64: tinyB64, mimeType: "audio/wav;codec=pcm", today: "2025-01-24" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.transcript, "almoço 32 reais hoje");
  assert.equal(calls.text[0].text, "almoço 32 reais hoje");
  assert.equal(calls.audio[0].mimeType, "audio/wav");
});

test("áudio sem valor devolve a transcrição para o app explicar o que ouviu", async () => {
  const { handler } = loadRoute({ ai: { text: { ok: false, status: 422, error: "ai_invalid_amount" } } });
  const res = await call(handler, { mode: "audio", audioBase64: tinyB64, mimeType: "audio/ogg" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.transcript, "almoço 32 reais hoje");
});

test("recusa formato não suportado, arquivo grande demais e conteúdo inválido", async () => {
  const { handler, calls } = loadRoute();
  assert.equal((await call(handler, { mode: "image", imageBase64: tinyB64, mimeType: "image/gif" })).body.error, "unsupported_media");
  assert.equal((await call(handler, { mode: "audio", audioBase64: tinyB64, mimeType: "video/mp4" })).body.error, "unsupported_media");
  assert.equal((await call(handler, { mode: "image", imageBase64: "A".repeat(4_300_001), mimeType: "image/jpeg" })).statusCode, 413);
  assert.equal((await call(handler, { mode: "image", imageBase64: "<script>", mimeType: "image/jpeg" })).statusCode, 400);
  assert.equal(calls.image.length, 0, "nada chega à IA");
});

test("painel admin desligando a leitura de mídia bloqueia sem chamar a IA", async () => {
  const { handler, calls } = loadRoute({ feature: { allowed: false, reason: "feature_disabled" } });
  const res = await call(handler, { mode: "image", imageBase64: tinyB64, mimeType: "image/png" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "feature_disabled");
  assert.equal(calls.image.length, 0);
});

test("texto continua funcionando como antes", async () => {
  const { handler, calls } = loadRoute();
  const res = await call(handler, { text: "almoço 32 reais", categories: [], today: "2025-01-24" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.features, ["aiParsing"]);
});
