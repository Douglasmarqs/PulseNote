const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const css = read("src/admin-console.css");
const js = read("src/admin.js");
const html = read("src/admin.html");

test("admin no iPhone: campos com 16px (sem zoom automático ao tocar)", () => {
  assert.match(css, /@media \(max-width: 820px\), \(pointer: coarse\) \{\s*input:not\(\[type=checkbox\]\)[^}]*font-size: 16px !important;/);
});

test("admin no celular: topo fixo fino, faixa de seções e fundo travado com janelas abertas", () => {
  assert.match(css, /\.ad-topbar \{ position: sticky !important; top: 0;/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /\.ad-mobile-tabs \{ position: sticky;/);
  assert.match(css, /html:has\(\.ac-modal:not\(\[hidden\]\)\), html:has\(\.ad-user-drawer\.is-open\), html:has\(\.pn-rail\.is-open\) \{ overflow: hidden; \}/);
  assert.match(js, /function placeHeading\(\)/);
  assert.match(js, /function syncMobileTabs\(\)/);
});

test("admin no celular: janelas não abrem o teclado sozinhas e camadas na ordem certa", () => {
  assert.match(js, /if \(isTouchDevice\(\)\) setTimeout\(\(\) => \$\("#adModalTitle"\)\?\.focus/);
  assert.match(html, /<h2 id="adModalTitle" tabindex="-1">/);
  assert.match(css, /\.ad-user-drawer \{ z-index: 120 !important;/);
  assert.match(css, /\.pn-rail \{ z-index: 130 !important;/);
  assert.match(css, /\.ac-modal \{ z-index: 140 !important;/);
  assert.match(css, /\.ac-bulkbar\[hidden\] \{ display: none !important; \}/);
});

test("admin: tabela de permissões com abreviações e legenda no celular", () => {
  assert.match(js, /const ROLE_SHORT = \{ owner: "Prop\.", admin: "Adm\.", finance: "Fin\.", support: "Sup\.", viewer: "Leit\." \};/);
  assert.match(js, /data-short="\$\{escapeHtml\(ROLE_SHORT\[role\]/);
  assert.match(html, /class="ac-matrix-legend"/);
});

test("admin: versões novas dos arquivos para furar o cache", () => {
  assert.match(html, /admin-console\.css\?v=4/);
  assert.match(html, /admin\.js\?v=45/);
});
