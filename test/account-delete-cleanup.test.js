const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SERVER_OWNED_USER_COLLECTIONS,
  SERVER_OWNED_USER_QUERY_COLLECTIONS,
  deleteServerOwnedUserData,
} = require("../api/account-delete-cleanup")._test;

test("account cleanup removes the server-owned operational aggregate for the authenticated uid", async () => {
  const deleted = [];
  let committed = false;
  const db = {
    collection: (name) => ({
      doc: (uid) => `${name}/${uid}`,
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
    batch: () => ({
      delete: (ref) => deleted.push(ref),
      commit: async () => { committed = true; },
    }),
  };

  await deleteServerOwnedUserData(db, "user-123");
  assert.equal(committed, true);
  assert.deepEqual(deleted, SERVER_OWNED_USER_COLLECTIONS.map((name) => `${name}/user-123`));
  assert.ok(deleted.includes("adminUsage/user-123"));
});

test("account cleanup removes idempotency and delivery receipts owned by the uid", async () => {
  const deleted = [];
  const pending = new Map(SERVER_OWNED_USER_QUERY_COLLECTIONS.map((name) => [
    name,
    [{ ref: `${name}/receipt-1` }, { ref: `${name}/receipt-2` }],
  ]));
  const db = {
    collection: (name) => ({
      doc: (uid) => `${name}/${uid}`,
      where: (field, operator, value) => {
        assert.equal(field, "uid");
        assert.equal(operator, "==");
        assert.equal(value, "user-123");
        return { limit: (size) => ({
          get: async () => {
            assert.equal(size, 400);
            const docs = pending.get(name) || [];
            pending.set(name, []);
            return { empty: docs.length === 0, docs };
          },
        }) };
      },
    }),
    batch: () => ({
      delete: (ref) => deleted.push(ref),
      commit: async () => {},
    }),
  };

  await deleteServerOwnedUserData(db, "user-123");
  for (const collection of SERVER_OWNED_USER_QUERY_COLLECTIONS) {
    assert.ok(deleted.includes(`${collection}/receipt-1`));
    assert.ok(deleted.includes(`${collection}/receipt-2`));
  }
});
