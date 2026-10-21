const test = require("node:test");
const assert = require("node:assert/strict");
const { requireAdmin, checkUserFeature, configuredPrimaryAdminEmail, getUserEntitlements } = require("../api/_lib/admin");
const { getRuntimeConfig, assertFeatureEnabled } = require("../api/_lib/adminConfig");
const { validateFeatureMap, integrationStatus, setEntitlement, summarizeUserState, summarizeUsage, aggregateUsage } = require("../api/admin")._test;

function fakeFirebase({ email = "dono@example.com", verified = true, disabled = false, role = false, revoked = false } = {}) {
  const docs = {
    "adminRoles/u1": role ? { enabled: true } : undefined,
    "systemConfig/global": undefined,
  };
  return {
    docs,
    auth: () => ({
      verifyIdToken: async (token, checkRevoked) => {
        assert.equal(checkRevoked, true);
        if (revoked) throw new Error("revoked");
        return { uid: "u1", token };
      },
      getUser: async () => ({ uid: "u1", email, emailVerified: verified, disabled }),
    }),
    firestore: () => ({
      collection: (name) => ({ doc: (id) => ({
        get: async () => ({ exists: Boolean(docs[`${name}/${id}`]), data: () => docs[`${name}/${id}`] }),
      }) }),
    }),
  };
}

test("nega acesso administrativo sem token, conta verificada ou papel", async () => {
  const original = process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
  try {
    await assert.rejects(requireAdmin({ headers: {} }, fakeFirebase()), { status: 401 });
    await assert.rejects(requireAdmin({ headers: { authorization: "Bearer token" } }, fakeFirebase()), { status: 403 });
    await assert.rejects(requireAdmin({ headers: { authorization: "Bearer token" } }, fakeFirebase({ role: true, verified: false })), { status: 403 });
    await assert.rejects(requireAdmin({ headers: { authorization: "Bearer token" } }, fakeFirebase({ role: true, disabled: true })), { status: 403 });
    await assert.rejects(requireAdmin({ headers: { authorization: "Bearer token" } }, fakeFirebase({ role: true, revoked: true })), { status: 401 });
  } finally { if (original === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = original; }
});

test("aceita somente e-mail confirmado na allowlist ou papel privado no servidor", async () => {
  const original = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "DONO@example.com";
  try {
    const allowed = await requireAdmin({ headers: { authorization: "Bearer token" } }, fakeFirebase());
    assert.equal(allowed.email, "dono@example.com");
    process.env.ADMIN_EMAILS = "";
    const role = await requireAdmin({ headers: { authorization: "Bearer token" } }, fakeFirebase({ role: true }));
    assert.equal(role.uid, "u1");
  } finally { if (original === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = original; }
});

test("mantém a conta principal do proprietário autorizada quando a variável da Vercel não está disponível", async () => {
  const originalPrimary = process.env.PRIMARY_ADMIN_EMAIL;
  const originalAdmins = process.env.ADMIN_EMAILS;
  delete process.env.PRIMARY_ADMIN_EMAIL;
  delete process.env.ADMIN_EMAILS;
  try {
    assert.equal(configuredPrimaryAdminEmail(), "douglas1201.santos@gmail.com");
    const allowed = await requireAdmin({ headers: { authorization: "Bearer token" } }, fakeFirebase({ email: "douglas1201.santos@gmail.com" }));
    assert.equal(allowed.isOwner, true);
  } finally {
    if (originalPrimary === undefined) delete process.env.PRIMARY_ADMIN_EMAIL; else process.env.PRIMARY_ADMIN_EMAIL = originalPrimary;
    if (originalAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = originalAdmins;
  }
});

test("manutenção e flags do servidor bloqueiam ações sem mudar acesso legado", async () => {
  const docs = {
    "systemConfig/global": { maintenance: { enabled: false }, features: { autopilot: false } },
  };
  const db = {
    collection: (name) => ({ doc: (id) => ({ get: async () => ({
      exists: Boolean(docs[`${name}/${id}`]), data: () => docs[`${name}/${id}`],
    }) }) }),
  };
  const config = await getRuntimeConfig(db);
  assert.equal(config.features.autopilot, false);
  assert.equal(config.features.whatsapp, true);
  assert.throws(() => assertFeatureEnabled(config, "autopilot"), { status: 503, code: "feature_disabled" });
  assert.deepEqual(await checkUserFeature(db, "u1", "autopilot"), { allowed: false, reason: "feature_disabled" });
  docs["systemConfig/global"].maintenance.enabled = true;
  const maintenanceConfig = await getRuntimeConfig(db);
  assert.throws(() => assertFeatureEnabled(maintenanceConfig, "whatsapp"), { status: 503, code: "maintenance" });
  assert.deepEqual(await checkUserFeature(db, "u1", "whatsapp"), { allowed: false, reason: "maintenance" });
});

test("plano atribuído controla o recurso; sem plano preserva acesso existente", async () => {
  const docs = {
    "systemConfig/global": {},
    "adminPlans/basic": { active: true, features: { autopilot: false } },
  };
  const db = { collection: (name) => ({ doc: (id) => ({ get: async () => ({
    exists: Boolean(docs[`${name}/${id}`]), data: () => docs[`${name}/${id}`],
  }) }) }) };
  assert.deepEqual(await checkUserFeature(db, "u1", "autopilot"), { allowed: true, reason: "legacy_access" });
  docs["adminEntitlements/u1"] = { planId: "basic" };
  assert.deepEqual(await checkUserFeature(db, "u1", "autopilot"), { allowed: false, reason: "plan" });
  docs["adminPlans/basic"].features.autopilot = true;
  assert.deepEqual(await checkUserFeature(db, "u1", "autopilot"), { allowed: true, reason: "plan" });
  docs["adminEntitlements/u1"].status = "paused";
  assert.deepEqual(await checkUserFeature(db, "u1", "autopilot"), { allowed: false, reason: "paused" });
  docs["adminEntitlements/u1"].status = "active";
  docs["adminEntitlements/u1"].validUntil = "2020-01-01";
  assert.deepEqual(await checkUserFeature(db, "u1", "autopilot"), { allowed: false, reason: "expired" });
  delete docs["adminEntitlements/u1"];
  docs["adminUserStatus/u1"] = { disabled: true };
  assert.deepEqual(await checkUserFeature(db, "u1", "whatsapp"), { allowed: false, reason: "disabled" });
});

test("configuração rejeita atributos desconhecidos e tipos falsos", () => {
  const valid = { whatsapp: true, aiParsing: true, reminders: false, autopilot: true,
    mediaRecognition: true, whatsappReminders: false, pushNotifications: true, pdfReports: true };
  assert.deepEqual(validateFeatureMap(valid), valid);
  assert.throws(() => validateFeatureMap({ ...valid, admin: true }), { code: "invalid_features" });
  assert.throws(() => validateFeatureMap({ ...valid, whatsapp: "false" }), { code: "invalid_features" });
});

test("planos antigos herdam capacidades já implícitas sem reabrir recursos desligados", async () => {
  const docs = {
    "adminEntitlements/u1": { planId: "legacy", status: "active" },
    "adminPlans/legacy": { active: true, features: { whatsapp: true, aiParsing: true, reminders: true, autopilot: false } },
  };
  const db = { collection: (name) => ({ doc: (id) => ({ get: async () => ({
    exists: Boolean(docs[`${name}/${id}`]), data: () => docs[`${name}/${id}`],
  }) }) }) };
  const entitlement = await getUserEntitlements(db, "u1");
  assert.equal(entitlement.features.mediaRecognition, true);
  assert.equal(entitlement.features.whatsappReminders, true);
  assert.equal(entitlement.features.pushNotifications, true);
  assert.equal(entitlement.features.pdfReports, true);
  assert.equal(entitlement.features.autopilot, false);
});

test("resumo administrativo expõe somente totais e estados operacionais", () => {
  const snapshot = { exists: true, data: () => ({ updatedAt: "2026-10-20T12:00:00.000Z", data: {
    tasks: [{ reminder: 30 }, { title: "privado" }], notes: [{ description: "segredo" }],
    events: [{ reminder: 10 }], goals: [{ reminder: false }], finances: [{ amount: 99 }],
    whatsappLinkedPhone: "5531999999999", whatsappReminderOptIn: true,
    appReminderOptIn: true, fcmTokens: ["token"], timeZone: "America/Sao_Paulo",
  } }) };
  const result = summarizeUserState(snapshot);
  assert.deepEqual(result.activity, { tasks: 2, notes: 1, events: 1, goals: 1, finances: 1, reminderItems: 2 });
  assert.equal(result.whatsappLinked, true);
  assert.equal(result.pushEnabled, true);
  assert.equal(JSON.stringify(result).includes("segredo"), false);
  assert.equal(JSON.stringify(result).includes("5531999999999"), false);
});

test("fluxo de uso agrega somente áreas e transições permitidas, sem conteúdo pessoal", () => {
  const usage = summarizeUsage({ exists: true, data: () => ({
    lastSeenAt: "2026-10-21T01:00:00.000Z", lastArea: "planner", totalViews: 7,
    areaCounts: { dashboard: 3, planner: 4 }, privateNote: "não expor",
  }) });
  assert.equal(usage.lastArea, "planner");
  assert.equal(usage.totalViews, 7);
  assert.equal(JSON.stringify(usage).includes("não expor"), false);
  const aggregated = aggregateUsage({ docs: [
    { data: () => ({ lastSeenAt: "2026-10-21T01:00:00.000Z", areaCounts: { dashboard: 2, planner: 1 }, transitions: { "dashboard>planner": 1 } }) },
    { data: () => ({ lastSeenAt: "2026-10-21T02:00:00.000Z", areaCounts: { dashboard: 1 }, transitions: {} }) },
  ] });
  assert.equal(aggregated.trackedUsers, 2);
  assert.deepEqual(aggregated.topAreas[0], { key: "dashboard", count: 3 });
  assert.deepEqual(aggregated.topTransitions[0], { key: "dashboard>planner", count: 1 });
});

test("administrador não pode remover plano e restaurar acesso legado sem querer", async () => {
  await assert.rejects(
    setEntitlement({}, {}, { uid: "admin", email: "admin@example.com" }, { uid: "u1", planId: null }),
    { status: 400, code: "plan_required" },
  );
});

test("monitoramento mostra sinais reais e não confunde credenciais com entrega", async () => {
  const db = { collection: (name) => name === "whatsappProcessedMessages"
    ? { orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [
      { data: () => ({ status: "failed", updatedAt: "2026-10-13T18:00:00.000Z" }) },
    ] }) }) }) }
    : { doc: () => ({ get: async () => ({ data: () => ({ lastRunAt: "2026-10-13T18:05:00.000Z", status: "ok" }) }) }) } };
  const result = await integrationStatus(db);
  const whatsapp = result.integrations.find((item) => item.id === "whatsapp");
  const qstash = result.integrations.find((item) => item.id === "qstash");
  assert.equal(whatsapp.recentFailures, 1);
  assert.equal(qstash.runStatus, "ok");
  assert.match(result.note, /presença de credenciais/);
});

