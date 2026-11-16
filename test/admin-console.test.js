// Painel administrativo v2: papéis, acessos em lote, testes grátis,
// cobranças vinculadas a plano e regras de quem está sem plano.
const test = require("node:test");
const assert = require("node:assert/strict");

function fakeDb(initial = {}) {
  const docs = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]));
  let auto = 0;
  const snap = (key) => ({ id: key.split("/")[1], exists: docs.has(key), data: () => (docs.has(key) ? JSON.parse(JSON.stringify(docs.get(key))) : undefined) });
  const ref = (name, id = `auto${++auto}`) => {
    const key = `${name}/${id}`;
    return {
      id, key,
      get: async () => snap(key),
      set: async (value, options) => { docs.set(key, options?.merge ? { ...(docs.get(key) || {}), ...value } : value); },
      create: async (value) => { if (docs.has(key)) throw Object.assign(new Error("exists"), { code: 6 }); docs.set(key, value); },
      update: async (value) => { docs.set(key, { ...(docs.get(key) || {}), ...value }); },
      delete: async () => { docs.delete(key); },
    };
  };
  const query = (name, filters = []) => ({
    where: (field, op, value) => query(name, [...filters, [field, value]]),
    orderBy: () => query(name, filters), limit: () => query(name, filters),
    get: async () => ({ docs: [...docs.keys()].filter((key) => key.startsWith(`${name}/`)).map(snap)
      .filter((entry) => filters.every(([field, value]) => entry.data()?.[field] === value)) }),
  });
  return {
    docs,
    collection: (name) => ({ doc: (id) => ref(name, id), add: async (value) => ref(name).set(value), ...query(name) }),
    batch: () => {
      const ops = [];
      return { set: (r, v, o) => ops.push(() => r.set(v, o)), delete: (r) => ops.push(() => r.delete()), commit: async () => { for (const op of ops) await op(); } };
    },
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v), create: (r, v) => r.create(v) }),
  };
}

const firebase = { auth: () => ({ getUsers: async (ids) => ({ users: ids.filter(({ uid }) => uid !== "ghost").map(({ uid }) => ({ uid, email: `${uid}@x.com` })) }), getUser: async (uid) => ({ uid, email: `${uid}@x.com` }) }) };
const actor = { uid: "adm", email: "adm@x.com", role: "admin" };
const { _test } = require("../api/admin.js");
const { saoPauloToday, hasPermission, getUserEntitlements, checkUserFeature } = require("../api/_lib/admin");

test("hierarquia: cada papel só tem as permissões dele", () => {
  assert.equal(hasPermission({ role: "owner" }, "admins.manage"), true);
  assert.equal(hasPermission({ role: "admin" }, "admins.manage"), false);
  assert.equal(hasPermission({ role: "finance" }, "charges.manage"), true);
  assert.equal(hasPermission({ role: "finance" }, "config.manage"), false);
  assert.equal(hasPermission({ role: "support" }, "users.access"), true);
  assert.equal(hasPermission({ role: "support" }, "charges.manage"), false);
  assert.equal(hasPermission({ role: "viewer" }, "users.access"), false);
  assert.equal(hasPermission({ role: "viewer" }, "view"), true);
});

test("rota do painel recusa ação fora do papel (servidor, não só a tela)", async () => {
  const adminPath = require.resolve("../api/_lib/admin.js");
  const apiPath = require.resolve("../api/admin.js");
  const original = require.cache[adminPath].exports.requireAdmin;
  const originalGetAdmin = require.cache[adminPath].exports.getAdmin;
  require.cache[adminPath].exports.getAdmin = () => ({ firestore: () => ({}) });
  require.cache[adminPath].exports.requireAdmin = async () => ({ uid: "s1", email: "s@x.com", role: "support", permissions: ["view", "users.access"] });
  delete require.cache[apiPath];
  const handler = require("../api/admin.js");
  const res = { code: 0, body: null, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  try {
    await handler({ method: "POST", query: { action: "charge-bulk" }, body: {}, headers: {} }, res);
    assert.equal(res.code, 403);
    assert.equal(res.body.error, "permission_denied");
  } finally {
    require.cache[adminPath].exports.requireAdmin = original;
    require.cache[adminPath].exports.getAdmin = originalGetAdmin;
    delete require.cache[apiPath];
  }
});

test("dar teste grátis em lote, estender, pausar e remover", async () => {
  const db = fakeDb({ "adminPlans/pro": { name: "Pro", active: true, priceCents: 2990 } });
  const trial = await _test.accessApply(firebase, db, actor, { op: "trial", uids: ["a", "b", "ghost"], planId: "pro", days: 7 });
  assert.deepEqual(trial.applied, ["a", "b"]);
  assert.equal(trial.skipped[0].reason, "user_not_found");
  const a = db.docs.get("adminEntitlements/a");
  assert.equal(a.source, "trial");
  assert.equal(a.validUntil, _test.addDaysIso(saoPauloToday(), 6));

  await _test.accessApply(firebase, db, actor, { op: "extend", uids: ["a", "c"], days: 30 });
  assert.equal(db.docs.get("adminEntitlements/a").validUntil, _test.addDaysIso(saoPauloToday(), 36));
  await _test.accessApply(firebase, db, actor, { op: "pause", uids: ["b"] });
  assert.equal(db.docs.get("adminEntitlements/b").status, "paused");
  await _test.accessApply(firebase, db, actor, { op: "remove", uids: ["b"] });
  assert.equal(db.docs.has("adminEntitlements/b"), false);
  const audits = [...db.docs.entries()].filter(([key]) => key.startsWith("adminAudit/")).map(([, value]) => value.action);
  assert.ok(audits.includes("access_trial") && audits.includes("access_extend") && audits.includes("access_remove"));
  await assert.rejects(_test.accessApply(firebase, db, actor, { op: "trial", uids: ["a"], planId: "pro", days: 0 }), { code: "invalid_days" });
  await assert.rejects(_test.accessApply(firebase, db, actor, { op: "assign", uids: Array.from({ length: 201 }, (_, i) => `u${i}`), planId: "pro" }), { code: "too_many_users" });
});

test("cobrança em lote vinculada a plano libera o plano quando é recebida", async () => {
  const db = fakeDb({ "adminPlans/pro": { name: "Pro", active: true, priceCents: 2990, billingInterval: "month" } });
  const requestId = "0e56856a-f698-439e-adab-61212f35c075";
  const result = await _test.chargeBulk(firebase, db, actor, { uids: ["a", "b"], planId: "pro", requestId });
  assert.equal(result.created.length, 2);
  const again = await _test.chargeBulk(firebase, db, actor, { uids: ["a", "b"], planId: "pro", requestId });
  assert.equal(again.created.length, 0, "repetir o envio não duplica cobranças");
  const charge = db.docs.get(`adminCharges/${result.created[0].id}`);
  assert.equal(charge.amountCents, 2990);
  assert.equal(charge.grantDays, 30);
  const update = await _test.updateCharge(db, actor, { id: result.created[0].id, status: "manual_received" });
  assert.equal(update.granted.planId, "pro");
  const entitlement = db.docs.get("adminEntitlements/a");
  assert.equal(entitlement.source, "charge");
  assert.equal(entitlement.validUntil, _test.addDaysIso(saoPauloToday(), 29));
});

test("teste vencido volta para a regra de quem está sem plano", async () => {
  const yesterday = _test.addDaysIso(saoPauloToday(), -1);
  const db = fakeDb({
    "adminPlans/pro": { active: true, features: { autopilot: true } },
    "adminPlans/free": { active: true, features: { autopilot: false, whatsapp: true } },
    "adminEntitlements/u1": { planId: "pro", status: "active", source: "trial", validUntil: yesterday },
    "systemConfig/global": {},
  });
  assert.deepEqual(await checkUserFeature(db, "u1", "autopilot"), { allowed: true, reason: "legacy_access" });
  db.docs.set("systemConfig/global", { access: { noPlan: "plan", noPlanPlanId: "free" } });
  assert.deepEqual(await checkUserFeature(db, "u1", "autopilot"), { allowed: false, reason: "default_plan" });
  assert.deepEqual(await checkUserFeature(db, "u1", "whatsapp"), { allowed: true, reason: "default_plan" });
  const entitlement = await getUserEntitlements(db, "u2", { config: { access: { noPlan: "plan", noPlanPlanId: "free" } } });
  assert.equal(entitlement.status, "default_plan");
});

test("configuração: manutenção com previsão, regra sem plano, teste automático e Pix", async () => {
  const db = fakeDb({ "adminPlans/pro": { active: true }, "systemConfig/global": {} });
  const { config } = await _test.updateConfig(db, actor, { maintenance: { enabled: true, message: "Voltamos já", eta: "18h", allowAdmins: false } });
  assert.equal(config.maintenance.enabled, true);
  assert.equal(config.maintenance.eta, "18h");
  assert.equal(config.maintenance.allowAdmins, false);
  assert.ok(config.maintenance.startedAt);
  const trial = await _test.updateConfig(db, actor, { trial: { enabled: true, planId: "pro", days: 14 } });
  assert.equal(trial.config.trial.enabled, true);
  assert.equal(trial.config.maintenance.enabled, true, "seções não enviadas continuam como estavam");
  await assert.rejects(_test.updateConfig(db, actor, { trial: { enabled: true, planId: "nao-existe", days: 7 } }), { code: "invalid_trial" });
  await assert.rejects(_test.updateConfig(db, actor, { access: { noPlan: "plan", noPlanPlanId: "" } }), { code: "invalid_access_policy" });
  const pix = await _test.updateConfig(db, actor, { payment: { pixKey: "chave@pix.com", pixHolder: "Douglas" } });
  assert.equal(pix.config.payment.pixKey, "chave@pix.com");
  const audit = [...db.docs.values()].map((value) => value.action).filter(Boolean);
  assert.ok(audit.includes("maintenance_enabled"));
});

test("billing: teste automático só para conta nova, cobranças pendentes e planos privados ocultos", async () => {
  const billing = require("../api/_lib/billing");
  const db = fakeDb({
    "adminPlans/pro": { name: "Pro", active: true, priceCents: 2990, visibility: "public" },
    "adminPlans/vip": { name: "VIP", active: true, priceCents: 0, visibility: "private" },
    "systemConfig/global": { trial: { enabled: true, planId: "pro", days: 7, enabledAt: "2026-01-01T00:00:00.000Z" }, maintenance: { enabled: true, message: "Manutenção", eta: "18h" }, payment: { pixKey: "pix@x.com" } },
    "adminCharges/c1": { uid: "new", status: "manual_pending", amountCents: 2990, note: "Pro" },
    "adminCharges/c2": { uid: "new", status: "paid", amountCents: 2990 },
  });
  const fb = { firestore: () => db };
  const state = await billing.publicBillingState(fb, { uid: "new", email: "new@x.com", createdAt: "2026-06-01T10:00:00.000Z" });
  assert.deepEqual(state.plans.map((plan) => plan.id), ["pro"]);
  assert.equal(state.subscription.trial, true);
  assert.equal(db.docs.get("adminEntitlements/new").source, "trial");
  assert.deepEqual(state.charges.map((charge) => charge.id), ["c1"]);
  assert.equal(state.payment.manual.pixKey, "pix@x.com");
  assert.equal(state.maintenance.enabled, true);
  assert.equal(state.maintenance.bypass, false);
  const old = await billing.publicBillingState(fb, { uid: "old", email: "old@x.com", createdAt: "2025-01-01T10:00:00.000Z" });
  assert.equal(old.subscription.status, "unassigned", "contas antigas não ganham teste automático");
});

test("Stripe: cobrança avulsa só vira paga com payment_status=paid e libera o plano", async () => {
  const billing = require("../api/_lib/billing");
  const db = fakeDb({ "adminCharges/c1": { uid: "u1", status: "manual_pending", amountCents: 2990, planId: "pro", grantDays: 30 } });
  const fb = { firestore: () => db };
  const pending = await billing.applyStripeEvent(fb, { type: "checkout.session.completed", data: { object: { mode: "payment", payment_status: "unpaid", metadata: { charge_id: "c1", firebase_uid: "u1" } } } });
  assert.equal(pending.pending, true);
  assert.equal(db.docs.get("adminCharges/c1").status, "manual_pending");
  const paid = await billing.applyStripeEvent(fb, { type: "checkout.session.async_payment_succeeded", data: { object: { mode: "payment", payment_status: "paid", payment_intent: "pi_1", metadata: { charge_id: "c1", firebase_uid: "u1" } } } });
  assert.equal(paid.paid, true);
  assert.equal(db.docs.get("adminCharges/c1").status, "paid");
  assert.equal(db.docs.get("adminEntitlements/u1").planId, "pro");
  const dup = await billing.applyStripeEvent(fb, { type: "checkout.session.completed", data: { object: { mode: "payment", payment_status: "paid", metadata: { charge_id: "c1", firebase_uid: "u1" } } } });
  assert.equal(dup.duplicate, true);
});
