"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ALLOWED_AREAS } = require("../api/usage-event")._test;

test("telemetria aceita somente áreas conhecidas e não envia conteúdo do usuário", () => {
  assert.deepEqual([...ALLOWED_AREAS], ["dashboard", "planner", "notes", "finances", "autopilot", "profile", "settings"]);
  const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  const tracker = app.match(/function trackUsageArea[\s\S]*?\n}/)?.[0] || "";
  assert.match(tracker, /JSON\.stringify\(\{ area \}\)/);
  assert.doesNotMatch(tracker, /state|notes|finances|tasks/);
  assert.match(tracker, /60_000/);
});

test("módulo principal permanece sintaticamente válido e sem saída de terminal incorporada", () => {
  const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  assert.doesNotMatch(app, /Warning: truncated output|Total output lines:|tokens truncated/);
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: app,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

