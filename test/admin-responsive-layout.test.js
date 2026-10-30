const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const css = readFileSync(join(__dirname, "..", "src", "admin.css"), "utf8");
const html = readFileSync(join(__dirname, "..", "src", "admin.html"), "utf8");
const js = readFileSync(join(__dirname, "..", "src", "admin.js"), "utf8");
const appJs = readFileSync(join(__dirname, "..", "src", "app.js"), "utf8");

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

test("admin navigation avoids ad-blocker identifiers and keeps the page in its grid track", () => {
  assert.match(html, /class="pn-rail" id="pnRail"/);
  assert.match(html, /aria-controls="pnRail"/);
  assert.match(js, /#pnRail/);
  assert.doesNotMatch(html, /adSidebar|class="ad-sidebar"/);
  assert.doesNotMatch(html, /class="ad-section/);
  assert.match(html, /class="pn-console-view is-active" id="pn-console-overview"/);
  assert.match(js, /querySelectorAll\("\.pn-console-view"\)/);
  assert.match(js, /`pn-console-\$\{section\}`/);
  assert.match(baseRule(".ad-page"), /grid-column:2/);
  assert.match(baseRule(".ad-shell.is-locked .ad-page"), /grid-column:1/);
  assert.match(css, /\.ad-page\{grid-column:auto\}/);
});

test("the same signed-in account can switch between the personal app and administration", () => {
  assert.match(html, /class="ad-app-switch" href="\/app"/);
  assert.match(html, /Abrir meu PulseNote/);
  assert.match(appJs, /id="dropdownAdmin" hidden/);
  assert.match(appJs, /window\.location\.assign\("\/admin"\)/);
  assert.match(appJs, /douglas1201\.santos@gmail\.com/);
  assert.match(appJs, /dropdownEntry\.hidden = !\(allowed \|\| isPrimaryOwner\)/);
});

test("admin identifies production, preview and local environments without a misleading static label", () => {
  assert.match(html, /id="adEnvironment">Ambiente de prévia<\/span>/);
  assert.match(js, /hostname === "pulse-note-5erj\.vercel\.app"/);
  assert.match(js, /"Ambiente de produção"/);
  assert.match(js, /"Ambiente local" : "Ambiente de prévia"/);
});
