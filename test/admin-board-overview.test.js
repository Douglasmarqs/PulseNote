const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _test } = require("../api/admin.js");

const html = fs.readFileSync(path.join(__dirname, "../src/admin.html"), "utf8");

function snapshot(docs) {
  return { docs: docs.map(([id, data]) => ({ id, data: () => data, exists: true })) };
}

function fakeDb(data) {
  const query = (name) => {
    const api = {
      where: () => api, orderBy: () => api, limit: () => api,
      count: () => ({ get: async () => ({ data: () => ({ count: (data[name] || []).length }) }) }),
      get: async () => snapshot(data[name] || []),
      doc: () => ({ get: async () => ({ exists: false, data: () => ({}) }) }),
    };
    return api;
  };
  return { collection: query };
}

test("visão geral do admin traz MRR por plano, crescimento e totais de uso", async () => {
  const now = Date.now();
  const iso = (days) => new Date(now - days * 86400000).toUTCString();
  const users = [
    { uid: "a", metadata: { creationTime: iso(200), lastSignInTime: iso(1) } },
    { uid: "b", metadata: { creationTime: iso(40), lastSignInTime: iso(2) } },
    { uid: "c", metadata: { creationTime: iso(5), lastSignInTime: iso(0) } },
  ];
  const firebase = { auth: () => ({ listUsers: async () => ({ users, pageToken: undefined }) }) };
  const db = fakeDb({
    adminEntitlements: [["a", { planId: "pro", status: "active" }], ["b", { planId: "pro", status: "active" }], ["c", { planId: "anual", status: "active" }]],
    adminPlans: [["pro", { name: "Pro", priceCents: 2990 }], ["anual", { name: "Anual", priceCents: 24000, billingInterval: "year" }]],
    adminCharges: [["x", { status: "paid", amountCents: 5000, createdAt: new Date(now - 3 * 86400000).toISOString() }], ["y", { status: "paid", amountCents: 4000, createdAt: new Date(now - 45 * 86400000).toISOString() }]],
    userData: [["a", { data: { tasks: [{}, {}], notes: [{}], finances: [{}, {}, {}] } }], ["b", { data: { tasks: [{}] } }]],
  });
  const result = await _test.dashboard(firebase, db);
  assert.equal(result.metrics.activeSubscriptions, 3);
  assert.equal(result.metrics.mrrCents, 2990 * 2 + 2000);
  assert.deepEqual(result.planBreakdown.map((item) => [item.name, item.count]), [["Pro", 2], ["Anual", 1]]);
  assert.equal(result.metrics.revenueCents30d, 5000);
  assert.equal(result.metrics.revenuePrevCents30d, 4000);
  assert.equal(result.metrics.totalTasks, 3);
  assert.equal(result.metrics.totalFinances, 3);
  assert.equal(result.metrics.newUsers30d, 1);
  assert.equal(result.metrics.newUsersPrev30d, 1);
  assert.equal(result.accountsByDay.length, 90);
  assert.equal(result.accountsByDay.at(-1).total, 3);
  assert.ok(result.accountsByDay[0].total >= 1, "conta antiga entra como base do acumulado");
  assert.equal(result.metrics.activeUsers30d, 3);
});

test("painel administrativo segue o quadro 11 sem perder controles", () => {
  for (const id of ["adKpis", "adGrowthChart", "adGrowthRange", "adIntegrationsPreview", "adPlanBreakdown", "adSubsTotals", "adUsersPreview", "adAuditPreview", "adAuditAll", "adAuditDrawer", "adOvTabs", "adAccessChart", "adJourney", "adUsageFlow", "adOperationsSummary", "adMaintenanceStatus", "adUserDrawer", "adEnvironment"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const section of ["overview", "users", "plans", "subscriptions", "charges", "features", "integrations", "security", "settings"]) {
    assert.match(html, new RegExp(`data-section="${section}"`), section);
    assert.match(html, new RegExp(`id="pn-console-${section}"`), section);
  }
  assert.match(html, /admin-boards\.css/);
  const used = [...html.matchAll(/href="#i-([a-z-]+)"/g)].map((m) => m[1]);
  for (const name of new Set(used)) assert.match(html, new RegExp(`<symbol id="i-${name}"`), name);
});
