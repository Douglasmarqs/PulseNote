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
