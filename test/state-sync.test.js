const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/state-sync.js"), "utf8");
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("somente campos alterados são enviados, sem tocar tokens do servidor", async () => {
  const { changedStateKeys } = await modulePromise;
  const before = { notes: [], finances: [], fcmTokens: ["t1"], appReminderOptIn: true };
  const after = { notes: [], finances: [{ id: "new", amount: 10.9 }], fcmTokens: ["t2"], appReminderOptIn: true };
  assert.deepEqual(changedStateKeys(before, after, ["fcmTokens", "serverNotifications"]), ["finances"]);
});

test("gasto pelo WhatsApp sobrevive quando app altera outra nota", async () => {
  const { mergeDirtyState } = await modulePromise;
  const remote = { finances: [{ id: "wa1", amount: 10.9 }], notes: [{ id: "n1", title: "Antes" }] };
  const local = { finances: [], notes: [{ id: "n1", title: "Depois" }] };
  const merged = mergeDirtyState(remote, local, { notes: [{ id: "n1", title: "Antes" }] });
  assert.deepEqual(merged.finances, remote.finances);
  assert.equal(merged.notes[0].title, "Depois");
});

test("gasto remoto e gasto local entram na mesma coleção sem duplicar", async () => {
  const { mergeDirtyState } = await modulePromise;
  const local = { finances: [{ id: "app1", amount: 20 }] };
  const remote = { finances: [{ id: "wa1", amount: 10.9 }] };
  const merged = mergeDirtyState(remote, local, { finances: [] });
  assert.deepEqual(merged.finances.map((item) => item.id), ["app1", "wa1"]);
});

test("remoção local não apaga lançamentos remotos novos", async () => {
  const { mergeDirtyState } = await modulePromise;
  const base = [{ id: "old", amount: 1 }];
  const remote = { finances: [...base, { id: "wa1", amount: 2 }] };
  const merged = mergeDirtyState(remote, { finances: [] }, { finances: base });
  assert.deepEqual(merged.finances, [{ id: "wa1", amount: 2 }]);
});

test("edição local e remota no mesmo item resolve em favor da edição confirmada no app", async () => {
  const { mergeDirtyState } = await modulePromise;
  const base = [{ id: "x", amount: 10 }];
  const remote = { finances: [{ id: "x", amount: 12 }] };
  const merged = mergeDirtyState(remote, { finances: [{ id: "x", amount: 11 }] }, { finances: base });
  assert.equal(merged.finances[0].amount, 11);
});
