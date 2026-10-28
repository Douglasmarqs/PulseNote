"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
