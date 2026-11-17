const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("src/app.js");
const css = read("src/boards.css");
const html = read("src/index.html");
const adminCss = read("src/admin-console.css");

test("títulos sem os emojis 👋 e 📝 — ilustração animada no lugar", () => {
  assert.doesNotMatch(app, /dashboard: \[`\$\{greeting\}, \$\{first\}! 👋`/);
  assert.doesNotMatch(app, /notes: \[`Notas, \$\{first\}! 📝`/);
  assert.match(app, /function viewHeadingGlyph\(view, hour\)/);
  for (const kind of ["sunrise", "sun", "moon", "notes"]) assert.match(app, new RegExp(`pn-glyph--${kind}`));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.pn-glyph \* \{ animation: none !important; \} \}/);
});

test("tela não fica deslocada depois do teclado (iPhone)", () => {
  assert.match(app, /function bindKeyboardViewportRepair\(\)/);
  assert.match(app, /document\.body\.style\.minHeight = "calc\(100vh \+ 2px\)"/);
  assert.match(app, /attributeFilter: \["hidden"\]/);
  assert.match(app, /modal\.hidden = true;\n  repairViewportAfterOverlay\(\);/);
});

test("Pulsinho em tela cheia ao digitar no celular", () => {
  assert.match(html, /id="bdChatExpand"/);
  assert.match(app, /function openPulsinhoFullscreen\(\)/);
  assert.match(app, /chat\.style\.setProperty\("--chat-vh"/);
  assert.match(css, /\.bd-chat\.is-fullscreen \{/);
  assert.match(css, /body\.bd-chat-open \.bd-tabbar/);
});

test("Foco da semana: anel, etapas tocáveis e metas com desfazer", () => {
  assert.match(app, /function goalStats\(goal\)/);
  assert.match(app, /function goalRingHtml\(stats, size = "lg"\)/);
  assert.match(app, /function stepGoal\(goalId, delta\)/);
  assert.match(app, /function syncGoalFromMilestones\(goal\)/);
  assert.match(app, /function goalManageCardHtml\(goal, isFocus\)/);
  assert.doesNotMatch(app, /planner-goal-progress-control/, "slider antigo removido");
  assert.match(app, /actionLabel: "Desfazer"/);
  assert.match(css, /\.pf-ring > svg \{/);
  assert.match(html, /Etapas até concluir/);
});

test("admin: engajamento e manutenção cabem na tela do celular", () => {
  assert.match(adminCss, /\.ad-flow-divider \{ margin: 16px 0 12px !important;/);
  assert.match(adminCss, /grid-template-areas: "txt txt" "pill btn";/);
  assert.match(read("src/admin.js"), /isCompact\(\) \? \{ day: "2-digit", month: "2-digit" \}/);
});
