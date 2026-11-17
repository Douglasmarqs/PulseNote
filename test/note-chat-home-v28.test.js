const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("src/app.js");
const css = read("src/boards.css");
const html = read("src/index.html");

test("nota aberta: excluir sem confirm() e com desfazer", () => {
  assert.doesNotMatch(app, /confirm\("Excluir essa anotação\?/);
  assert.match(app, /function deleteNoteWithUndo\(id\)/);
  assert.match(app, /closeNoteDetailThen\(\(\) => deleteNoteWithUndo\(id\)\)/);
});

test("nota aberta: Virar tarefa espera o histórico antes de trocar de tela", () => {
  assert.match(app, /function closeNoteDetailThen\(next\)/);
  assert.match(app, /closeNoteDetailThen\(\(\) => convertNoteToTask\(id\)\)/);
  assert.match(app, /if \(ndAfterClose\) ndAfterClose\(\);/);
});

test("nota aberta: marca-texto liga e desliga, limpar remove tudo", () => {
  assert.match(app, /function noteHighlightActive\(\)/);
  assert.match(app, /noteHighlightActive\(\) \? "transparent" : "#fde047"/);
  assert.match(app, /document\.execCommand\("removeFormat"\);\n      document\.execCommand\("backColor", false, "transparent"\);/);
  assert.doesNotMatch(app, /execCommand\("foreColor", false, getComputedStyle\(body\)\.color\)/, "não grava a cor do tema");
  assert.match(html, /data-nd-cmd="highlight"[^>]*aria-pressed="false"/);
});

test("nota: cor do tema não é gravada (texto invisível ao trocar de tema)", () => {
  assert.match(app, /function noteColorIsVivid\(value\)/);
  assert.match(app, /function scrubNoteEditorStyles\(root\)/);
  assert.match(app, /filter\(\(\[prop, value\]\) => noteStyleValueKept\(prop, value\)\)/);
  assert.match(app, /noteHtmlToPlainText\(storedHtml\) \|\| !String\(note\.description/, "corpo vazio cai para a descrição");
});

test("nota aberta: hover não gruda no toque e rodapé com duas ações", () => {
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{\n  \.bn-tool-row > button:hover/);
  assert.match(css, /\.bn-detail \.bn-detail-foot \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/);
  assert.match(html, /id="ndStatus"[^\n]*\n\s*<span class="bn-nd-count" id="ndCount"/);
  assert.match(app, /data-nd-check-del=/);
});

test("Home: sem reajuste ao voltar e troca de telas fluida", () => {
  assert.match(app, /if \(!scroller\.clientWidth\) return;/);
  assert.match(app, /if \(view === "dashboard"\) renderBoardsEvolution\(\);/);
  assert.doesNotMatch(css, /\.bd-kpis, #financesView \.bf-kpis \{ scroll-behavior: smooth;/);
  assert.match(app, /function animateViewEntrance\(target, fromView, toView\)/);
  assert.match(app, /function syncTabbarInk\(/);
  assert.match(css, /\.bd-tab-ink \{/);
  assert.match(app, /prefersReducedMotion\(\)/);
});

test("Pulsinho: bolhas agrupadas, batimento ao pensar, campo único e arrastar para fechar", () => {
  assert.match(app, /function pulsinhoTypingHtml\(/);
  assert.match(app, /index >= freshFrom \? "is-new" : ""/);
  assert.match(app, /function bindPulsinhoDragToClose\(\)/);
  assert.match(html, /<div class="bd-composer">/);
  assert.match(css, /\.bd-msg\.is-new \{/);
  assert.match(css, /@keyframes pnBeat/);
});
