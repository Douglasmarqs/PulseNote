const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const loadDeletion = () => import("../src/account-deletion.mjs");

test("exclusão só remove o login após leitura e remoção dos dados", async () => {
  const { deleteAccountDataAndIdentity } = await loadDeletion();
  const steps = [];
  await deleteAccountDataAndIdentity({
    readData: async () => { steps.push("read"); return { data: { notes: [1] } }; },
    deleteData: async () => { steps.push("delete-data"); },
    deleteIdentity: async () => { steps.push("delete-auth"); },
    restoreData: async () => { steps.push("restore"); },
  });
  assert.deepEqual(steps, ["read", "delete-data", "delete-auth"]);
});

test("falha na exclusão dos dados preserva o login sem tentativa de recuperação", async () => {
  const { deleteAccountDataAndIdentity } = await loadDeletion();
  const steps = [];
  const failure = new Error("Firestore denied");
  await assert.rejects(deleteAccountDataAndIdentity({
    readData: async () => ({}),
    deleteData: async () => { steps.push("delete-data"); throw failure; },
    deleteIdentity: async () => { steps.push("delete-auth"); },
    restoreData: async () => { steps.push("restore"); },
  }), (error) => error === failure);
  assert.deepEqual(steps, ["delete-data"]);
});

test("falha no Auth restaura o documento antes de reportar o erro original", async () => {
  const { deleteAccountDataAndIdentity } = await loadDeletion();
  const steps = [];
  const backup = { data: { notes: [1] }, updatedAt: "2026-10-17" };
  const failure = new Error("Auth denied");
  await assert.rejects(deleteAccountDataAndIdentity({
    readData: async () => backup,
    deleteData: async () => { steps.push("delete-data"); },
    deleteIdentity: async () => { steps.push("delete-auth"); throw failure; },
    restoreData: async (value) => { assert.equal(value, backup); steps.push("restore"); },
  }), (error) => error === failure);
  assert.deepEqual(steps, ["delete-data", "delete-auth", "restore"]);
});

test("falha na restauração é explícita e conserva a causa do Auth", async () => {
  const { deleteAccountDataAndIdentity } = await loadDeletion();
  const authFailure = new Error("Auth denied");
  const restoreFailure = new Error("Firestore unavailable");
  await assert.rejects(deleteAccountDataAndIdentity({
    readData: async () => ({}),
    deleteData: async () => {},
    deleteIdentity: async () => { throw authFailure; },
    restoreData: async () => { throw restoreFailure; },
  }), (error) => {
    assert.equal(error.code, "data/restore-failed");
    assert.equal(error.originalError, authFailure);
    assert.equal(error.cause, restoreFailure);
    return true;
  });
});

test("ausência de cópia confirmada impede remoção dos dados e do login", async () => {
  const { deleteAccountDataAndIdentity } = await loadDeletion();
  let removed = false;
  await assert.rejects(deleteAccountDataAndIdentity({
    readData: async () => null,
    deleteData: async () => { removed = true; },
    deleteIdentity: async () => { removed = true; },
    restoreData: async () => {},
  }), { code: "data/snapshot-failed" });
  assert.equal(removed, false);
});

test("app impede recriação do documento durante exclusão e só limpa cache após Auth", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const start = source.indexOf("// ── Excluir conta permanentemente");
  const end = source.indexOf("// Atualiza todos os pontos da UI", start);
  assert.ok(start >= 0 && end > start, "fluxo de exclusão encontrado");
  const flow = source.slice(start, end);

  assert.match(source, /if \(!snapshot\.exists\(\) && accountDeletionInProgress\) return;/);
  assert.match(source, /if \(!user\) \{[\s\S]*?if \(accountDeletionInProgress\) return;[\s\S]*?window\.location\.replace\("\/login"\)/);
  assert.match(source, /function syncToServer\(\) \{\s*if \(accountDeletionInProgress\) return;/);
  assert.match(flow, /await fetch\("\/api\/whatsapp-unlink"/);
  assert.match(flow, /await fetch\("\/api\/account-delete-cleanup"/);
  assert.match(flow, /if \(accountDeletionRequested\) return;/);
  assert.match(flow, /await Promise\.allSettled\(\[\.\.\.activeSyncs\]\)/);
  assert.match(flow, /getDocFromServer\(userDocRef\)/);
  assert.match(flow, /await deleteAccountDataAndIdentity\(/);
  assert.match(flow, /deleteIdentity: \(\) => deleteUser\(account\)/);
  assert.ok(flow.indexOf("deleteAccountDataAndIdentity") < flow.indexOf("localStorage.removeItem"));
  assert.match(flow, /accountDeletionInProgress = false;/);
});

test("exclusão reautentica contas Google sem pedir uma senha inexistente", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const start = source.indexOf("// ── Excluir conta permanentemente");
  const end = source.indexOf("// Atualiza todos os pontos da UI", start);
  const flow = source.slice(start, end);

  assert.match(source, /reauthenticateWithPopup/);
  assert.match(source, /GoogleAuthProvider/);
  assert.match(flow, /providers\.has\(GoogleAuthProvider\.PROVIDER_ID\)/);
  assert.match(flow, /reauthenticateWithPopup\(account, new GoogleAuthProvider\(\)\)/);
  assert.match(flow, /providers\.has\(EmailAuthProvider\.PROVIDER_ID\)/);
  assert.ok(flow.indexOf("reauthenticateWithPopup") < flow.indexOf("prompt(\"Por segurança"));
});
