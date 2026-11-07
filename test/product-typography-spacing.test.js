const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../src/product-system.css"), "utf8");

test("produto usa tipografia consistente e uma escala central de espacos", () => {
  assert.match(css, /--font-product:[^;]*Segoe UI Variable Text/);
  assert.match(css, /--font-display:[^;]*Segoe UI Variable Display/);
  assert.match(css, /--leading-body:\s*1\.58/);
  assert.match(css, /--space-4:\s*16px/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums lining-nums/);
});

test("conteudo longo pode encolher ou quebrar sem sobrepor acoes", () => {
  assert.match(css, /\.planner-row-main,[\s\S]*\.fin-shared-space-copy[\s\S]*min-width:\s*0/);
  assert.match(css, /\.planner-row-main strong,[\s\S]*\.settings-form label[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.pulse-beta-badge,[\s\S]*\.note-folder-badge[\s\S]*white-space:\s*nowrap/);
  assert.match(css, /#financesView \.fin-tx-amount\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap/);
});

test("telas estreitas reorganizam navegacao em vez de comprimir texto", () => {
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*#plannerView \.planner-tabs\s*\{\s*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*#financesView \.fin-tab-btn\s*\{[\s\S]*min-width:\s*108px/);
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*\.note-detail-footer \.primary-button\s*\{\s*flex:\s*1 1 100%/);
});
