const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("exclusão da conta só remove o login depois que os dados forem apagados", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const start = source.indexOf("// ── Excluir conta permanentemente");
  const end = source.indexOf("// Atualiza todos os pontos da UI", start);
  assert.ok(start >= 0 && end > start, "fluxo de exclusão encontrado");
  const flow = source.slice(start, end);

  assert.match(flow, /await fetch\("\/api\/whatsapp-unlink"/);
  assert.match(flow, /if \(!unlinkResponse\.ok\) \{[\s\S]*?throw unlinkError;/);
  assert.match(flow, /await deleteDoc\(doc\(db, "userData", account\.uid\)\)/);
  assert.match(flow, /catch \(err\) \{[\s\S]*?throw deletionError;/);
  assert.ok(flow.indexOf("await fetch(\"/api/whatsapp-unlink\"") < flow.indexOf("await deleteDoc"));
  assert.ok(flow.indexOf("await deleteDoc") < flow.indexOf("await deleteUser"));
  assert.ok(flow.indexOf("await deleteUser") > flow.indexOf("localStorage.removeItem"));
});
