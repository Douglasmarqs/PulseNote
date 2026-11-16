// Simulador de ponta a ponta do webhook do WhatsApp para testes:
// Firestore em memória (com a semântica real de set+merge profundo),
// Auth falso, Meta falsa (captura o que seria enviado) e IA falsa
// (respostas roteirizadas por função). Nada sai da máquina.
const crypto = require("node:crypto");
const path = require("node:path");
const { EventEmitter } = require("node:events");

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target, source) {
  const out = { ...(isPlainObject(target) ? target : {}) };
  for (const [key, value] of Object.entries(source || {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createFakeFirestore(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
  const ref = (pathKey) => ({
    path: pathKey,
    async get() {
      const exists = docs.has(pathKey);
      return { exists, data: () => (exists ? clone(docs.get(pathKey)) : undefined) };
    },
    async set(data, options = {}) {
      docs.set(pathKey, options.merge ? deepMerge(docs.get(pathKey), data) : clone(data));
    },
    async create(data) {
      if (docs.has(pathKey)) throw Object.assign(new Error("already_exists"), { code: 6 });
      docs.set(pathKey, clone(data));
    },
    async update(data) {
      docs.set(pathKey, deepMerge(docs.get(pathKey), data));
    },
  });
  const db = {
    docs,
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    async runTransaction(fn) {
      const tx = {
        get: (r) => r.get(),
        set: (r, data, options) => r.set(data, options),
        create: (r, data) => r.create(data),
        update: (r, data) => r.update(data),
      };
      return fn(tx);
    },
  };
  return db;
}

function createSimulator({ state = {}, phone = "5531999990000", uid = "user-1", displayName = "Douglas Marques", model, gatewayFails = false } = {}) {
  const db = createFakeFirestore({
    [`whatsappLinks/${phone}`]: { uid },
    [`userData/${uid}`]: { data: { whatsappLinkedPhone: phone, ...state } },
  });
  const fb = {
    firestore: () => db,
    auth: () => ({ getUser: async (id) => ({ uid: id, displayName, disabled: false }) }),
  };
  const adminPath = path.join(__dirname, "..", "..", "api", "_lib", "firebaseAdmin.js");
  require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { getFirebaseAdmin: () => fb, FieldValue: {} } };

  Object.assign(process.env, {
    WHATSAPP_APP_SECRET: "sim-secret",
    WHATSAPP_PHONE_NUMBER_ID: "sim-phone",
    WHATSAPP_ACCESS_TOKEN: "sim-token",
    AI_GATEWAY_API_KEY: "sim-gateway",
    AI_GATEWAY_MODEL: "openai/sim-model",
  });
  delete process.env.GEMINI_API_KEY;

  const sent = [];
  const modelCalls = [];
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("graph.facebook.com")) {
      const payload = JSON.parse(options.body || "{}");
      sent.push(payload.type === "interactive"
        ? { kind: "buttons", text: payload.interactive.body.text, buttons: payload.interactive.action.buttons.map((b) => b.reply.id) }
        : { kind: "text", text: payload.text?.body || "" });
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `out-${sent.length}` }] }) };
    }
    if (href.includes("ai-gateway.vercel.sh")) {
      const body = JSON.parse(options.body || "{}");
      const system = body.messages.find((m) => m.role === "system")?.content || "";
      const conversation = body.messages.filter((m) => m.role !== "system");
      modelCalls.push({ system, conversation });
      if (gatewayFails || !model) return { ok: false, status: 503, json: async () => ({}) };
      const output = await model({ system, conversation, message: conversation.at(-1)?.content || "" });
      return { ok: true, status: 200, json: async () => ({ model: "openai/sim-model", choices: [{ message: { content: JSON.stringify(output) } }] }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };

  const webhookPath = path.join(__dirname, "..", "..", "api", "whatsapp-webhook.js");
  delete require.cache[webhookPath];
  const handler = require(webhookPath);

  let counter = 0;
  async function deliver(message) {
    counter += 1;
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `wamid.sim.${Date.now()}.${counter}`, from: phone, ...message }] } }] }] });
    const signature = `sha256=${crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(body).digest("hex")}`;
    const req = new EventEmitter();
    req.method = "POST";
    req.headers = { "x-hub-signature-256": signature };
    req.query = {};
    let status = 0;
    const res = {
      status(code) { status = code; return this; },
      end() { return this; },
      send() { return this; },
      setHeader() {},
    };
    const before = sent.length;
    const done = handler(req, res);
    setImmediate(() => { req.emit("data", Buffer.from(body)); req.emit("end"); });
    await done;
    return { status, replies: sent.slice(before) };
  }

  return {
    db, sent, modelCalls,
    say: (text) => deliver({ type: "text", text: { body: text } }),
    press: (id) => deliver({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } }),
    state: () => clone(db.docs.get(`userData/${uid}`)?.data || {}),
    thread: () => clone(db.docs.get(`whatsappAssistantThreads/${uid}`) || null),
  };
}

module.exports = { createSimulator, createFakeFirestore };
