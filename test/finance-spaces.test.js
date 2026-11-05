"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canEditFinanceSpace,
  normalizeEmail,
  publicFinanceSpace,
  sanitizeFinanceSpaceData,
} = require("../api/_lib/financeSpaces");

test("dados de um espaço compartilhado ficam isolados no próprio workspace", () => {
  const data = sanitizeFinanceSpaceData({
    finances: [{ id: "f1", amount: 10, workspaceId: "personal", fcmTokens: ["secret"] }],
    financeAccounts: [{ id: "a1", name: "Conta conjunta", balance: 100 }],
  }, "space-123");
  assert.equal(data.finances[0].workspaceId, "space-123");
  assert.equal(data.financeAccounts[0].workspaceId, "space-123");
  assert.equal("fcmTokens" in data.finances[0], false);
  assert.deepEqual(data.finGoals, []);
});

test("somente proprietário e editor podem gravar finanças compartilhadas", () => {
  const space = { members: { owner: { role: "owner" }, editor: { role: "editor" }, viewer: { role: "viewer" } } };
  assert.equal(canEditFinanceSpace(space, "owner"), true);
  assert.equal(canEditFinanceSpace(space, "editor"), true);
  assert.equal(canEditFinanceSpace(space, "viewer"), false);
  assert.equal(canEditFinanceSpace(space, "outsider"), false);
});

test("resposta pública expõe apenas membros do espaço e dados financeiros permitidos", () => {
  const result = publicFinanceSpace({
    name: "Família",
    type: "family",
    members: { u1: { uid: "u1", name: "Ana", email: " ANA@EXAMPLE.COM ", role: "owner" } },
    data: { finances: [{ id: "x", amount: 20 }] },
  }, "u1", "space-family");
  assert.equal(result.canEdit, true);
  assert.equal(result.members[0].email, "ana@example.com");
  assert.equal(result.data.finances[0].workspaceId, "space-family");
  assert.equal(normalizeEmail(" A@B.COM "), "a@b.com");
});
