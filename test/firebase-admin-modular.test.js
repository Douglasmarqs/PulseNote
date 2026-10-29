"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { FieldValue, getFirebaseAdmin } = require("../api/_lib/firebaseAdmin");

const migratedRoutes = [
  "api/_lib/admin.js",
  "api/autopilot.js",
  "api/parse-transaction.js",
  "api/send-reminders.js",
  "api/whatsapp-unlink.js",
  "api/whatsapp-webhook.js",
];

test("Firebase Admin 14 usa somente os módulos suportados nas rotas", () => {
  assert.equal(typeof getFirebaseAdmin, "function");
  assert.equal(typeof FieldValue.arrayRemove, "function");

  for (const relativePath of migratedRoutes) {
    const source = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
    assert.doesNotMatch(source, /require\(["']firebase-admin["']\)/, relativePath);
    assert.doesNotMatch(source, /admin\.(?:apps|initializeApp|credential|auth|firestore|messaging)/, relativePath);
  }
});

test("Firebase Auth inicia no modo CommonJS usado pelas funções da Vercel", () => {
  const packageJson = require("../package.json");
  assert.equal(packageJson.overrides?.["jwks-rsa"]?.jose, "5.10.0");

  const result = spawnSync(process.execPath, [
    "--no-experimental-require-module",
    "-e",
    "require('firebase-admin/auth')",
  ], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
