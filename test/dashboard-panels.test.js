const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const source = (name) => readFileSync(join(__dirname, "..", "src", name), "utf8");
const html = source("index.html");
const app = source("app.js");
const css = source("styles.css");

test("dashboard panels stay open without expand or collapse controls", () => {
  for (const id of ["tasks", "chart", "events", "goals", "finance-mini", "whatsapp"]) {
    assert.match(html, new RegExp(`data-panel-id="${id}"`));
  }
  assert.match(html, /id="weeklySummary"/);
  assert.match(html, /id="chartBars"/);
  assert.doesNotMatch(html, /data-collapse-toggle|dash-panel-collapse-btn/);
  assert.doesNotMatch(app, /initDashPanelCollapse|pn_dash_collapsed_/);
  assert.doesNotMatch(css, /\.dash-panel\.is-collapsed/);
});

test("dashboard shortcuts still open their matching areas", () => {
  assert.match(html, /data-view-shortcut="planner" data-planner-focus="tasks" title="Ver tarefas"/);
  assert.match(html, /data-view-shortcut="planner" data-planner-focus="agenda" title="Ver agenda"/);
  assert.match(html, /data-view-shortcut="planner" data-planner-focus="goals" title="Ver metas"/);
  assert.match(html, /data-view-shortcut="finances" title="Ver finanças"/);
  assert.match(app, /document\.querySelectorAll\("\[data-view-shortcut\]"\)/);
});

