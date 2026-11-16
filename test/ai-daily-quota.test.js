// Limite diário de conversas com IA por plano.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeFirestore, createSimulator } = require("./helpers/whatsappSim");
const { createAiQuota, aiLimitReply, aiQuotaNotice, saoPauloToday, resolveAiDailyLimit } = require("../api/_lib/aiQuota");
const { converse, brazilNow } = require("../api/_lib/pulsinhoBrain");
const { askPulsinho } = require("../api/_lib/pulsinhoAssistant");

const fixedLimit = (limit, tier = "free") => async () => ({ limit, tier });

test("conta só até o limite do dia e recusa a partir daí", async () => {
  const db = createFakeFirestore();
  const quota = () => createAiQuota({ db, uid: "u1", resolveLimit: fixedLimit(3), today: () => "2026-11-16" });
  const results = [];
  for (let i = 0; i < 4; i += 1) results.push(await quota().consume());
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.deepEqual(results.map((r) => r.remaining), [2, 1, 0, 0]);
  assert.equal(db.docs.get("aiUsage/u1").count, 3);
});

test("vira o dia e a cota recomeça", async () => {
  const db = createFakeFirestore({ "aiUsage/u1": { day: "2026-11-15", count: 10 } });
  const result = await createAiQuota({ db, uid: "u1", resolveLimit: fixedLimit(10), today: () => "2026-11-16" }).consume();
  assert.equal(result.allowed, true);
  assert.equal(db.docs.get("aiUsage/u1").count, 1);
});

test("erro da IA devolve a mensagem para a cota", async () => {
  const db = createFakeFirestore();
  const quota = createAiQuota({ db, uid: "u1", resolveLimit: fixedLimit(5), today: () => "2026-11-16" });
  await quota.consume();
  assert.equal(db.docs.get("aiUsage/u1").count, 1);
  await quota.refund();
  assert.equal(db.docs.get("aiUsage/u1").count, 0);
});

test("limite 0 (admin ou plano sem limite) nunca bloqueia nem grava contador", async () => {
  const db = createFakeFirestore();
  const result = await createAiQuota({ db, uid: "u1", resolveLimit: fixedLimit(0, "admin") }).consume();
  assert.equal(result.allowed, true);
  assert.equal(result.unlimited, true);
  assert.equal(db.docs.has("aiUsage/u1"), false);
});

test("falha ao consultar a cota libera a mensagem (nunca derruba o Pulsinho)", async () => {
  const db = createFakeFirestore();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await createAiQuota({ db, uid: "u1", resolveLimit: async () => { throw new Error("boom"); } }).consume();
    assert.equal(result.allowed, true);
  } finally {
    console.warn = originalWarn;
  }
});

test("limites por plano: sem plano = 10, pago sem valor = 200, valor do plano vale, admin sem limite", async () => {
  const db = createFakeFirestore({
    "adminEntitlements/paid": { planId: "pro", status: "active" },
    "adminPlans/pro": { name: "Pro", active: true, priceCents: 1990, features: {} },
    "adminEntitlements/custom": { planId: "plus", status: "active" },
    "adminPlans/plus": { name: "Plus", active: true, priceCents: 990, aiDailyLimit: 50, features: {} },
    "adminRoles/boss": { enabled: true },
  });
  assert.deepEqual(await resolveAiDailyLimit(db, "nobody"), { limit: 10, tier: "free" });
  assert.equal((await resolveAiDailyLimit(db, "paid")).limit, 200);
  assert.equal((await resolveAiDailyLimit(db, "custom")).limit, 50);
  assert.equal((await resolveAiDailyLimit(db, "boss")).limit, 0);
});

test("o cérebro não chama a IA quando a cota acabou, e cumprimento não gasta cota", async () => {
  const db = createFakeFirestore({ "aiUsage/u1": { day: saoPauloToday(), count: 10 } });
  let calls = 0;
  const callModel = async () => { calls += 1; return { ok: true, parsed: { reply: "oi" } }; };
  const quota = createAiQuota({ db, uid: "u1", resolveLimit: fixedLimit(10) });
  const blocked = await converse({ message: "me conta uma curiosidade", callModel, quota });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "ai_daily_limit");
  assert.equal(calls, 0);
  const hello = await converse({ message: "bom dia", callModel, quota });
  assert.equal(hello.source, "smalltalk");
  assert.equal(calls, 0);
});

test("app: cota esgotada responde explicando e comando claro ainda vira ação", async () => {
  const db = createFakeFirestore({ "aiUsage/u1": { day: saoPauloToday(), count: 10 } });
  const quota = () => createAiQuota({ db, uid: "u1", resolveLimit: fixedLimit(10, "free") });
  const callModel = async () => { throw new Error("não deveria chamar a IA"); };
  const chat = await askPulsinho({ state: {}, question: "me conta uma curiosidade", channel: "app", callModel, quota: quota() });
  assert.equal(chat.ok, true);
  assert.equal(chat.limitReached, true);
  assert.match(chat.reply, /10 conversas com IA de hoje/);
  assert.match(chat.reply, /planos/);

  const expense = await askPulsinho({ state: {}, question: "gastei 30 no mercado", channel: "app", callModel, quota: quota() });
  assert.equal(expense.actions.length, 1);
  assert.equal(expense.actions[0].type, "add_transaction");
  assert.equal(expense.actions[0].record.amount, 30);
  assert.match(expense.reply, /modo rápido/);
});

test("avisos: últimas conversas do dia", () => {
  assert.equal(aiQuotaNotice({ allowed: true, limit: 10, remaining: 5 }), "");
  assert.match(aiQuotaNotice({ allowed: true, limit: 10, remaining: 2 }), /^_Restam 2 conversas/);
  assert.match(aiQuotaNotice({ allowed: true, limit: 10, remaining: 2 }, { channel: "app" }), /^Restam 2 conversas/);
  assert.match(aiQuotaNotice({ allowed: true, limit: 10, remaining: 0 }), /última conversa/);
  assert.equal(aiQuotaNotice({ allowed: true, unlimited: true }), "");
  assert.doesNotMatch(aiLimitReply({ limit: 200, tier: "paid" }), /planos/);
});

test("WhatsApp: com a cota esgotada a conversa explica o limite e o gasto continua sendo registrado", async () => {
  const today = brazilNow().today;
  let modelCalls = 0;
  const sim = createSimulator({
    state: { finances: [], tasks: [] },
    model: async () => { modelCalls += 1; return { reply: "não deveria", actions: [] }; },
  });
  sim.db.docs.set("aiUsage/user-1", { day: saoPauloToday(), count: 10 });
  const chat = await sim.say("me conta uma curiosidade");
  assert.equal(modelCalls, 0);
  assert.match(chat.replies.map((r) => r.text).join("\n"), /10 conversas com IA de hoje/);

  await sim.say("gastei 30 no mercado");
  const finances = sim.state().finances || [];
  assert.ok(finances.some((entry) => entry.amount === 30 && entry.date === today), "gasto registrado sem IA");
  assert.equal(modelCalls, 0);
});

test("WhatsApp: dentro da cota a IA responde e a contagem sobe", async () => {
  const sim = createSimulator({ state: {}, model: async () => ({ reply: "Tô de boa sim! E você?", actions: [] }) });
  const answer = await sim.say("ta de boa aí?");
  assert.match(answer.replies.map((r) => r.text).join("\n"), /Tô de boa sim/);
  assert.equal(sim.db.docs.get("aiUsage/user-1").count, 1);
});
