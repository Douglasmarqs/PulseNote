const test = require("node:test");
const assert = require("node:assert/strict");

const { SERVER_OWNED_USER_COLLECTIONS, deleteServerOwnedUserData } = require("../api/account-delete-cleanup")._test;

test("account cleanup removes the server-owned operational aggregate for the authenticated uid", async () => {
  const deleted = [];
  let committed = false;
  const db = {
    collection: (name) => ({ doc: (uid) => `${name}/${uid}` }),
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
