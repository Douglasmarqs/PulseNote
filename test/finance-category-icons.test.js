// Cada categoria padrão tem um ícone próprio e todo ícone usado existe
// como <symbol> no index.html (senão o lançamento aparece sem ícone).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES } = require("../api/_lib/financeCategories");

const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");
const symbols = new Set([...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));

function block(startToken, endToken) {
  const start = app.indexOf(startToken);
  assert.ok(start >= 0, `${startToken} não encontrado`);
  return app.slice(start, app.indexOf(endToken, start));
}

test("todas as categorias padrão (gasto e receita) têm ícone específico", () => {
  const map = block("const FIN_CATEGORY_ICONS = {", "};");
  for (const category of [...DEFAULT_EXPENSE_CATEGORIES, ...DEFAULT_INCOME_CATEGORIES]) {
    assert.match(map, new RegExp(`\\b${category.id}: "`), `sem ícone para ${category.id}`);
  }
});

test("todo ícone de categoria e de descrição existe como símbolo SVG", () => {
  const used = new Set([
    ...[...block("const FIN_CATEGORY_ICONS = {", "};").matchAll(/: "([a-z0-9-]+)"/g)].map((m) => m[1]),
    ...[...block("const FIN_DESCRIPTION_ICONS = [", "\n];").matchAll(/, "([a-z0-9-]+)"/g)].map((m) => m[1]),
  ]);
  const missing = [...used].filter((name) => !["receita", "despesa"].includes(name) && !symbols.has(name));
  assert.deepEqual(missing, []);
});

test("as palavras da descrição apontam o ícone certo", () => {
  const rules = block("const FIN_DESCRIPTION_ICONS = [", "\n];");
  const list = eval(`${rules.replace("const FIN_DESCRIPTION_ICONS = ", "(")}\n])`);
  const norm = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const pick = (text, type = "despesa") => {
    for (const [re, icon, only] of list) {
      if (only && only !== type) continue;
      if (re.test(norm(text))) return icon;
    }
    return "";
  };
  assert.equal(pick("Uber pro trabalho"), "car");
  assert.equal(pick("Conta de luz"), "bolt");
  assert.equal(pick("Água Copasa"), "droplet");
  assert.equal(pick("Netflix"), "tv");
  assert.equal(pick("iFood sexta"), "bag");
  assert.equal(pick("Farmácia"), "pill");
  assert.equal(pick("Corte de cabelo"), "scissors");
  assert.equal(pick("Ração do Thor"), "paw");
  assert.equal(pick("Gasolina"), "fuel");
  assert.equal(pick("Recarga do celular"), "phone");
  assert.equal(pick("Salário", "receita"), "briefcase");
  assert.equal(pick("Freela do site", "receita"), "laptop");
  assert.equal(pick("Conta das crianças"), "", "\"das\" não pode virar imposto");
});
