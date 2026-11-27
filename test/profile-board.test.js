const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("perfil mantém os IDs usados pelo app e ganha a nova estrutura", () => {
  const html = read("src/index.html");
  for (const id of ["profileAvatarPreview", "profileNameLabel", "profileEmailLabel", "profileLevelLabel", "profileLevelBadge", "profileLevelBar", "profileLevelXpLabel", "profileStatStreak", "profileStatTasks", "profileStatGoals", "profileStatNotes", "profileAchievementCount", "profileAchievements", "profileNextAchievement", "profilePlanChip"]) {
    assert.match(html, new RegExp(`id="${id}"`), `faltou #${id}`);
  }
  assert.match(html, /data-pf-filter="unlocked"/);
  assert.match(html, /<symbol id="i-flame"/);
});

test("perfil v3: compacto, útil e sem colidir com o cartão de foco do Planner", () => {
  const html = read("src/index.html");
  const app = read("src/app.js");
  const css = read("src/profile-v3.css");
  const view = html.slice(html.indexOf('id="profileView"'), html.indexOf("<!-- ===== SETTINGS VIEW"));
  // Classe própria: ".pf" também é o "Foco da semana" do Planner e quebrava o layout.
  assert.match(view, /<div class="pfx">/);
  assert.doesNotMatch(view, /class="pf[ "]/);
  // Sem IDs duplicados no perfil.
  const ids = [...view.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  // Blocos úteis: anel de nível, mês, atividade, conquistas recolhidas, conta e tema.
  for (const id of ["profileLevelRing", "profileHeatmap", "profileAccountRows", "profileThemeSeg", "profileAchToggle", "profileMedals", "profileStatBalance"]) {
    assert.match(view, new RegExp(`id="${id}"`), id);
  }
  assert.match(view, /id="profileAchAll" hidden/, "lista completa de conquistas começa recolhida");
  assert.doesNotMatch(view, /Como ganhar XP<\/h3>/, "o quadro de XP virou dica no nível");
  for (const fn of ["pfxRenderHeatmap", "pfxAccountRows", "bindProfileV3", "pfxBestStreak"]) assert.match(app, new RegExp(`function ${fn}\\(`), fn);
  // O mapa é desenhado no mesmo quadro em que o Perfil aparece (no quadro
  // seguinte ele mudava de altura e a tela "tremia").
  assert.match(app, /if \(view === "profile"\) pfxRenderHeatmap\(\{ fromView: true \}\);/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(html, /href="\/src\/profile-v3\.css\?v=\d+"/);
  assert.match(read("src/sw.js"), /"\/src\/profile-v3\.css"/);
});

test("perfil v3: maior sequência conta dias consecutivos com tarefa concluída", () => {
  const app = read("src/app.js");
  const start = app.indexOf("function pfxBestStreak()");
  const body = app.slice(start, app.indexOf("\n}\n", start) + 2);
  const best = new Function("state", `${body}; return pfxBestStreak();`);
  const tasks = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"].map((completedAt) => ({ completedAt }));
  assert.equal(best({ tasks }), 3);
  assert.equal(best({ tasks: [] }), 0);
});

test("conquistas expõem progresso (current/target) para as barras do perfil", () => {
  const app = read("src/app.js");
  const block = app.slice(app.indexOf("function getAchievementsList()"), app.indexOf("function getAchievementsList()") + 2600);
  const entries = block.match(/\{ title: "[^"]+"[^}]*\}/g) || [];
  assert.equal(entries.length, 12);
  for (const entry of entries) assert.match(entry, /current: [^,]+, target: \d+, unlocked:/, entry);
});

test("rolagem do mouse não fica presa e o botão de instalar usa ícone SVG", () => {
  assert.match(read("src/boards.css"), /html, body \{ overflow-x: clip; \}/);
  const pwa = read("src/pwa-install.js");
  assert.doesNotMatch(pwa, /⬇️/);
  assert.match(pwa, /class="pwa-ico"/);
});
