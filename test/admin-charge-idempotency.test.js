const test = require("node:test");
const assert = require("node:assert/strict");
const { createCharge, updateCharge } = require("../api/admin")._test;

function fakeDb() {
  const documents = new Map();
  let generated = 0;
  const ref = (collection, id) => ({ key: `${collection}/${id || `generated-${++generated}`}` });
  const snapshot = (key) => ({ exists: documents.has(key), data: () => documents.get(key) });
  return {
    documents,
    collection: (collection) => ({ doc: (id) => ref(collection, id) }),
    runTransaction: async (callback) => callback({
      get: async (document) => snapshot(document.key),
      create: (document, data) => {
        if (documents.has(document.key)) throw new Error("already_exists");
        documents.set(document.key, data);
      },
      update: (document, data) => {
        if (!documents.has(document.key)) throw new Error("not_found");
        documents.set(document.key, { ...documents.get(document.key), ...data });
      },
    }),
  };
}

const firebase = { auth: () => ({ getUser: async (uid) => ({ uid }) }) };
const actor = { uid: "admin-1", email: "admin@example.com" };
const chargeInput = { uid: "user-1", amountCents: 1090, dueDate: "2026-10-20", note: "Teste", requestId: "0e56856a-f698-439e-adab-61212f35c075" };

test("retry de cobrança manual devolve o mesmo registro sem segunda auditoria", async () => {
  const db = fakeDb();
  const first = await createCharge(firebase, db, actor, chargeInput);
  const retry = await createCharge(firebase, db, actor, chargeInput);
  assert.equal(first.alreadyCreated, false);
  assert.equal(retry.alreadyCreated, true);
  assert.equal(retry.charge.id, first.charge.id);
  assert.equal(retry.charge.amountCents, 1090);
  assert.equal([...db.documents.keys()].filter((key) => key.startsWith("adminCharges/")).length, 1);
  assert.equal([...db.documents.keys()].filter((key) => key.startsWith("adminAudit/")).length, 1);
});

test("mesmo identificador não pode representar outra cobrança", async () => {
  const db = fakeDb();
  await createCharge(firebase, db, actor, chargeInput);
  await assert.rejects(createCharge(firebase, db, actor, { ...chargeInput, amountCents: 2000 }),
    { status: 409, code: "charge_request_conflict" });
});

test("cobrança manual só pode ser finalizada uma vez", async () => {
  const db = fakeDb();
  const created = await createCharge(firebase, db, actor, chargeInput);
  const result = await updateCharge(db, actor, { id: created.charge.id, status: "manual_received" });
  assert.equal(result.status, "manual_received");
  await assert.rejects(updateCharge(db, actor, { id: created.charge.id, status: "manual_cancelled" }),
    { status: 409, code: "charge_already_finalized" });
  assert.equal([...db.documents.keys()].filter((key) => key.startsWith("adminAudit/")).length, 2);
});
