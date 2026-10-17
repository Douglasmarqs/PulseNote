const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const rules = readFileSync(join(__dirname, "..", "firestore.rules"), "utf8");
const userDataRules = rules.split("match /userData/{userId} {")[1]?.split("match /{document=**} {")[0];

function conditionFor(operation) {
  const condition = userDataRules?.match(new RegExp(`allow ${operation}:\\s*if([\\s\\S]*?);`))?.[1];
  assert.ok(condition, `Expected an explicit ${operation} rule for userData`);
  return condition;
}

test("account deletion has its own owner-only rule without request.resource checks", () => {
  const deletion = conditionFor("delete");
  assert.match(deletion, /request\.auth != null/);
  assert.match(deletion, /request\.auth\.uid == userId/);
  assert.match(deletion, /!userDisabled\(userId\)/);
  assert.match(deletion, /!maintenanceEnabled\(\)/);
  assert.doesNotMatch(deletion, /request\.resource/);
});

test("create and update retain data-shape and access protections", () => {
  const writes = conditionFor("create, update");
  assert.match(writes, /request\.auth != null/);
  assert.match(writes, /request\.auth\.uid == userId/);
  assert.match(writes, /!userDisabled\(userId\)/);
  assert.match(writes, /!maintenanceEnabled\(\)/);
  assert.match(writes, /request\.resource\.data\.keys\(\)\.hasOnly/);
  assert.match(writes, /request\.resource\.data\.data is map/);
  assert.match(writes, /request\.resource\.data\.updatedAt is string/);
  assert.doesNotMatch(userDataRules, /allow write:/);
});
