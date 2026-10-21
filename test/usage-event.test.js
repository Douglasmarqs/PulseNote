"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ALLOWED_AREAS } = require("../api/usage-event")._test;

test("telemetria aceita somente áreas conhecidas e não envia conteúdo do usuário", () => {
  assert.deepEqual([...ALLOWED_AREAS], ["dashboard", "planner", "notes", "finances", "autopilot", "profile", "settings"]);
  const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  const tracker = app.match(/function trackUsageArea[\s\S]*?\n}/)?.[0] || "";
  assert.match(tracker, /JSON\.stringify\(\{ area \}\)/);
  assert.doesNotMatch(tracker, /state|notes|finances|tasks/);
  assert.match(tracker, /60_000/);
});

