const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("chave Web Push é um ponto público P-256 não comprimido válido", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "firebase-config.js"), "utf8");
  const match = source.match(/messagingVapidKey:\s*"([A-Za-z0-9_-]+)"/);
  assert.ok(match, "messagingVapidKey precisa existir");

  const publicKey = Buffer.from(match[1], "base64url");
  assert.equal(publicKey.length, 65, "a chave P-256 precisa ter 65 bytes");
  assert.equal(publicKey[0], 0x04, "a chave precisa usar o formato EC não comprimido");
});
