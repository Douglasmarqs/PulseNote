const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../src/product-system.css"), "utf8");

test("viewport preserva zoom e acompanha o teclado virtual", () => {
  assert.match(html, /viewport-fit=cover, interactive-widget=resizes-content/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
});

test("controles móveis recebem toque imediato sem bloquear texto comum", () => {
  assert.match(css, /button, a, \[role="button"\], summary, \.tab, \.chip/);
  assert.match(css, /touch-action: manipulation/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*font-size: 16px !important/);
  assert.doesNotMatch(css, /body\s*\{[^}]*user-select:\s*none/);
});

test("editor de nota mantém a criação limpa e organização opcional", () => {
  assert.match(html, /class="note-details-hint"/);
  assert.doesNotMatch(html, /id="noteTextColorPicker"|id="noteColorPicker"/);
  assert.match(html, /id="noteTextColor" type="hidden"/);
  assert.match(html, /id="noteColor" type="hidden"/);
});

test("metas do planner viram trilho tocável no celular", () => {
  assert.match(css, /#plannerView \.planner-goals-strip[\s\S]*grid-auto-flow: column/);
  assert.match(css, /scroll-snap-type: x proximity/);
  assert.match(css, /touch-action: pan-y/);
});
