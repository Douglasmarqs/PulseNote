const test = require("node:test");
const assert = require("node:assert/strict");
const { assertUnlinkAllowed, verifyUser, unlinkUser } = require("../api/whatsapp-unlink");

test("desvinculação exige token não revogado e usuário ativo", async () => {
  const firebase = {
    auth: () => ({
      verifyIdToken: async (_token, checkRevoked) => {
        assert.equal(checkRevoked, true);
        return { uid: "user-1" };
      },
      getUser: async () => ({ disabled: false }),
    }),
  };
  await assert.rejects(verifyUser({ headers: {} }, firebase), /missing_token/);
  assert.equal(await verifyUser({ headers: { authorization: "Bearer token" } }, firebase), "user-1");
  firebase.auth = () => ({ verifyIdToken: async () => ({ uid: "user-1" }), getUser: async () => ({ disabled: true }) });
  await assert.rejects(verifyUser({ headers: { authorization: "Bearer token" } }, firebase), { status: 403 });
});

test("desvinculação respeita desativação administrativa e manutenção", () => {
  assert.doesNotThrow(() => assertUnlinkAllowed(undefined, undefined));
  assert.throws(() => assertUnlinkAllowed({ disabled: true }, {}), { status: 403 });
  assert.throws(() => assertUnlinkAllowed({}, { maintenance: { enabled: true } }), { status: 503 });
});

test("desvinculação não apaga número reassociado a outra pessoa", async () => {
  const docs = new Map([
    ["userData/user-1", { data: { whatsappLinkedPhone: "5531999999999", notes: [] } }],
    ["whatsappLinks/5531999999999", { uid: "user-2" }],
  ]);
  const writes = [];
  const db = {
    collection: (name) => ({ doc: (id) => ({ path: `${name}/${id}` }) }),
    runTransaction: async (work) => work({
      get: async (ref) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
      delete: (ref) => writes.push({ type: "delete", path: ref.path }),
      set: (ref, data) => writes.push({ type: "set", path: ref.path, data }),
    }),
  };
  await unlinkUser(db, "user-1");
  assert.deepEqual(writes.map((item) => item.type), ["set"]);
  assert.equal(writes[0].data.data.whatsappLinkedPhone, null);
  assert.deepEqual(writes[0].data.data.notes, []);

  writes.length = 0;
  docs.set("whatsappLinks/5531999999999", { uid: "user-1" });
  await unlinkUser(db, "user-1");
  assert.deepEqual(writes.map((item) => item.type), ["delete", "set"]);

  writes.length = 0;
  docs.set("systemConfig/global", { maintenance: { enabled: true } });
  await assert.rejects(unlinkUser(db, "user-1"), { status: 503 });
  assert.equal(writes.length, 0);
});
