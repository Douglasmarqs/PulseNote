const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../src/product-system.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");

test("produto usa tipografia consistente e uma escala central de espacos", () => {
  assert.match(html, /product-system\.css\?v=\d+/);
  assert.match(css, /--font-product:[^;]*Segoe UI Variable Text/);
  assert.match(css, /--font-display:[^;]*Segoe UI Variable Display/);
  assert.match(css, /--leading-body:\s*1\.58/);
  assert.match(css, /--space-4:\s*16px/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums lining-nums/);
});

test("conteudo longo pode encolher ou quebrar sem sobrepor acoes", () => {
  // (classes de telas antigas que nenhum HTML/JS cria mais saíram do CSS)
  assert.match(css, /:where\([^)]*\.fin-shared-space-copy\) \{ min-width: 0; \}/);
  assert.match(css, /:where\([^)]*\.fin-shared-space-copy strong, \.settings-form label\) \{ overflow-wrap: anywhere; \}/);
  assert.match(css, /:where\(\.pill, [^)]*\.fin-workspace-label\) \{\s*flex: 0 0 auto;\s*white-space: nowrap;/);
});

test("telas estreitas reorganizam navegacao em vez de comprimir texto", () => {
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*#plannerView \.planner-tabs\s*\{\s*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /@media \(max-width:\s*380px\)[\s\S]*#financesView \.fin-tab-btn\s*\{[\s\S]*min-width:\s*108px/);
});
