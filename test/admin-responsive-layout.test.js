const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const css = readFileSync(join(__dirname, "..", "src", "admin.css"), "utf8");

function baseRule(selector) {
  return css.split("\n").find((line) => line.startsWith(`${selector}{`)) || "";
}

test("admin grids size themselves to the available content width", () => {
  for (const selector of [".ad-stats", ".ad-overview-grid", ".ad-two-col"]) {
    assert.match(baseRule(selector), /grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,\d+px\),1fr\)\)/);
  }
});

test("admin narrow-container layout does not depend only on viewport media queries", () => {
  assert.match(baseRule(".ad-main"), /container:admin-main \/ inline-size/);
  assert.match(css, /@container admin-main \(max-width:520px\)\{/);
  assert.match(css, /\.ad-stats,\.ad-overview-grid,\.ad-overview-side,\.ad-two-col\{grid-template-columns:minmax\(0,1fr\)\}/);
});

