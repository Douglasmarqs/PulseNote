"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const plans = require("../api/_lib/plans");
const { _test: admin } = require("../api/admin.js");

// Banco simulado: documentos por coleção + registro do que foi gravado.
function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed).map(([name, docs]) => [name, new Map(Object.entries(docs))]));
  const writes = [];
  const col = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const docs = store.get(name);
    return {
      doc: (id = `auto${writes.length}`) => ({ id, _col: name, get: async () => ({ id, exists: docs.has(id), data: () => docs.get(id) }) }),
      orderBy: () => col(name), limit: () => col(name), where: () => col(name),
      get: async () => ({ docs: [...docs.entries()].map(([id, data]) => ({ id, exists: true, data: () => data })) }),
    };
  };
  const db = {
    store, writes, collection: col,
    batch: () => {
      const ops = [];
      return {
        set: (ref, data, opts) => ops.push(["set", ref, data, opts]),
        update: (ref, data) => ops.push(["update", ref, data]),
        commit: async () => { for (const [kind, ref, data, opts] of ops) { const docs = store.get(ref._col) || new Map(); store.set(ref._col, docs); docs.set(ref.id, kind === "update" || opts?.merge ? { ...(docs.get(ref.id) || {}), ...data } : data); writes.push([kind, ref._col, ref.id, data]); } },
      };
    },
  };
  return db;
}
const actor = { uid: "adm1", email: "dono@exemplo.com" };
const FULL = Object.fromEntries(Object.keys(require("../api/_lib/adminConfig").DEFAULT_FEATURES).map((key) => [key, true]));

test("vitrine do plano: limpa textos, limita vantagens e valida teste, ordem e cor", () => {
  const ok = plans.normalizeShowcase({ tagline: "  Para quem   quer mais  ", benefits: [" IA sem limite ", "", "WhatsApp"], badge: "Mais popular", highlight: true, accent: "rose", ctaLabel: "Começar agora", order: 20, trialDays: 7, yearlyPriceCents: 29900, stripePriceIdYear: "price_ABC" });
  assert.equal(ok.tagline, "Para quem quer mais");
  assert.deepEqual(ok.benefits, ["IA sem limite", "WhatsApp"]);
  assert.equal(ok.accent, "rose");
  assert.equal(ok.highlight, true);
  assert.equal(ok.yearlyPriceCents, 29900);
  assert.equal(ok.stripePriceIdYear, "price_ABC");
  assert.equal(plans.normalizeShowcase({ accent: "neon" }).accent, "violet", "cor fora da lista volta ao padrão");
  assert.equal(plans.normalizeShowcase({}).order, 100);
  assert.equal(plans.normalizeShowcase({ yearlyPriceCents: 29900 }, { billingInterval: "year" }).yearlyPriceCents, null, "plano anual não tem preço anual alternativo");
  assert.throws(() => plans.normalizeShowcase({ benefits: Array(13).fill("x") }), /invalid_plan_showcase/);
  assert.throws(() => plans.normalizeShowcase({ trialDays: 61 }), /invalid_plan_trial/);
  assert.throws(() => plans.normalizeShowcase({ order: -1 }), /invalid_plan_showcase/);
  assert.throws(() => plans.normalizeShowcase({ yearlyPriceCents: 100, stripePriceIdYear: "nao-e-price" }), /invalid_plan_billing/);
});

test("app recebe a vitrine sem IDs internos do Stripe, com economia do anual e checkout por ciclo", () => {
  const pub = plans.publicPlan("pro", { name: "Pro", priceCents: 2990, billingInterval: "month", yearlyPriceCents: 29900, stripePriceId: "price_m", stripePriceIdYear: "price_y", benefits: ["A", 3, "B"], accent: "x", order: 10, trialDays: 7 }, { stripeReady: true });
  assert.equal(pub.stripePriceId, undefined);
  assert.equal(pub.stripePriceIdYear, undefined);
  assert.deepEqual(pub.benefits, ["A", "B"]);
  assert.equal(pub.accent, "violet");
  assert.equal(pub.yearlySavingsPct, 17, "12 × 29,90 = 358,80 → 299,00 economiza 17%");
  assert.equal(pub.checkoutAvailable, true);
  assert.equal(pub.checkoutAvailableYear, true);
  assert.equal(plans.publicPlan("pro", { priceCents: 2990, stripePriceId: "price_m" }, { stripeReady: false }).checkoutAvailable, false, "sem Stripe, sem botão de assinar");
  assert.deepEqual(plans.sortPlans([{ id: "b", order: 20, priceCents: 0 }, { id: "a", order: 10, priceCents: 9900 }, { id: "c", order: 10, priceCents: 100 }]).map((p) => p.id), ["c", "a", "b"]);
});

test("painel salva o plano com a vitrine completa e registra na auditoria", async () => {
  const db = fakeDb();
  const result = await admin.savePlan(db, actor, { id: "pro", name: "Pro", active: true, priceCents: 2990, billingInterval: "month", features: FULL, tagline: "Tudo liberado", benefits: ["IA sem limite"], badge: "Mais popular", highlight: true, accent: "blue", ctaLabel: "Assinar Pro", order: 20, trialDays: 7, yearlyPriceCents: 29900 });
  const saved = db.store.get("adminPlans").get("pro");
  assert.equal(saved.tagline, "Tudo liberado");
  assert.equal(saved.badge, "Mais popular");
  assert.equal(saved.trialDays, 7);
  assert.equal(saved.yearlyPriceCents, 29900);
  assert.equal(result.plan.highlight, true);
  const audit = [...db.store.get("adminAudit").values()][0];
  assert.equal(audit.action, "plan_saved");
  await assert.rejects(admin.savePlan(db, actor, { id: "x1", name: "X", active: true, features: FULL, benefits: Array(20).fill("a") }), /invalid_plan_showcase/);
});

test("reordenar a vitrine grava a nova ordem, recusa repetidos e plano inexistente", async () => {
  const db = fakeDb({ adminPlans: { free: { name: "Grátis" }, pro: { name: "Pro" }, max: { name: "Max" } } });
  await admin.reorderPlans(db, actor, { ids: ["pro", "free", "max"] });
  assert.equal(db.store.get("adminPlans").get("pro").order, 10);
  assert.equal(db.store.get("adminPlans").get("free").order, 20);
  assert.equal(db.store.get("adminPlans").get("max").order, 30);
  assert.ok([...db.store.get("adminAudit").values()].some((event) => event.action === "plans_reordered"));
  await assert.rejects(admin.reorderPlans(db, actor, { ids: ["pro", "pro"] }), /invalid_plan_order/);
  await assert.rejects(admin.reorderPlans(db, actor, { ids: ["pro", "fantasma"] }), /plan_not_found/);
  const { plans: listed } = await admin.listPlans(db);
  assert.deepEqual(listed.map((plan) => plan.id), ["pro", "free", "max"], "a lista do painel segue a ordem salva");
  // reordenar exige permissão de planos no servidor
  const route = fs.readFileSync(path.join(__dirname, "../api/admin.js"), "utf8");
  assert.match(route, /"plan-order": "plans\.manage"/);
});

test("checkout: mensal ou anual pelo preço certo e dias grátis só para quem nunca assinou", async () => {
  const billing = require("../api/_lib/billing");
  const sent = [];
  const previousFetch = global.fetch;
  const previousKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  global.fetch = async (url, init) => { sent.push([url, Object.fromEntries(new URLSearchParams(init.body))]); return { ok: true, json: async () => ({ id: "cs_1", url: "https://checkout.stripe.com/x" }) }; };
  try {
    const plan = { name: "Pro", active: true, priceCents: 2990, billingInterval: "month", stripePriceId: "price_m", stripePriceIdYear: "price_y", trialDays: 7 };
    const make = (entitlement) => fakeDb({ adminPlans: { pro: plan }, billingCustomers: { u1: { stripeCustomerId: "cus_1" } }, ...(entitlement ? { adminEntitlements: { u1: entitlement } } : {}) });
    const firebase = (db) => ({ firestore: () => db });
    const user = { uid: "u1", email: "u@ex.com" };

    await billing.createCheckout(firebase(make()), user, "pro", "year");
    let params = sent.at(-1)[1];
    assert.equal(params["line_items[0][price]"], "price_y");
    assert.equal(params["subscription_data[trial_period_days]"], "7", "primeira assinatura ganha os dias grátis");

    await billing.createCheckout(firebase(make({ provider: "stripe", providerSubscriptionId: "sub_1" })), user, "pro", "month");
    params = sent.at(-1)[1];
    assert.equal(params["line_items[0][price]"], "price_m");
    assert.equal(params["subscription_data[trial_period_days]"], undefined, "quem já assinou não repete o teste");

    const noYear = fakeDb({ adminPlans: { pro: { ...plan, stripePriceIdYear: null } }, billingCustomers: { u1: { stripeCustomerId: "cus_1" } } });
    await assert.rejects(billing.createCheckout(firebase(noYear), user, "pro", "year"), /plan_checkout_not_configured/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
  }
});
