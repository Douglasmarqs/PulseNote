const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { localExpenseFallback } = require("../api/_lib/localTextFallback");
const { parseTextIntent } = require("../api/_lib/parseCommandIntent");

// O app roda como módulo no navegador e importa Firebase; executar apenas o
// parser local real evita mocks da interface e testa o mesmo código de produção.
function appFinanceParser(categories, todayIso) {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  const start = source.indexOf("const FIN_CATEGORY_KEYWORDS = {");
  const endMarker = "return { type, amount, categoryId, description, date };";
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "parser financeiro do app não encontrado");
  const closingBrace = source.indexOf("\n}", end);
  assert.ok(closingBrace > end, "fim do parser financeiro do app não encontrado");

  const context = {
    todayIso,
    state: { customCategories: [] },
    expenseCategories: categories.filter((c) => c.type === "despesa"),
    incomeCategories: categories.filter((c) => c.type === "receita"),
    findCategory: (id) => categories.find((c) => c.id === id) || { label: "Outros" },
    toLocalIso: (date) => date.toISOString().slice(0, 10),
  };
  vm.runInNewContext(`${source.slice(start, closingBrace + 2)}\nglobalThis.parseForTest = parseFinanceText;`, context);
  return context.parseForTest;
}

test("app e WhatsApp usam a mesma categoria nos lançamentos cotidianos", async () => {
  const todayIso = "2026-10-18";
  const categories = [
    ["alimentacao", "🍔 Restaurante/Delivery"], ["mercado", "🛒 Mercado"],
    ["transporte", "🚗 Transporte"], ["combustivel", "⛽ Combustível"],
    ["moradia", "🏠 Moradia"], ["contas", "💡 Contas e Utilidades"],
    ["manutencao", "🔧 Manutenção"], ["seguros", "🛡️ Seguros"],
    ["impostos", "🧾 Impostos"], ["saude", "💊 Saúde"],
    ["academia", "🏋️ Academia"], ["outros", "📦 Outros"],
  ].map(([id, label]) => ({ id, label, type: "despesa" }));
  const parseInApp = appFinanceParser(categories, todayIso);

  for (const [message, expected] of [
    ["gastei 90 em gasolina", "combustivel"],
    ["gastei 100 no posto", "combustivel"],
    ["paguei 95 de luz", "contas"],
    ["gastei 70 na internet", "contas"],
    ["paguei 60 na academia", "academia"],
    ["paguei 3 no pão", "alimentacao"],
    ["bolo 15 reais", "alimentacao"],
    ["paguei 20 na padaria", "alimentacao"],
    ["paguei 120 no mercado", "mercado"],
    ["gastei 120 no Pão de Açúcar", "mercado"],
    ["paguei 95 na conta de luz", "contas"],
    ["uber 25 reais", "transporte"],
    ["aluguel 1200 reais", "moradia"],
    ["oficina 80 reais", "manutencao"],
    ["seguro do carro 500 reais", "seguros"],
    ["paguei 200 de ipva", "impostos"],
    ["plano de saúde 100 reais", "saude"],
  ]) {
    const appResult = parseInApp(message);
    const whatsappResult = localExpenseFallback({ text: message, categories, todayIso });
    const commandResult = await parseTextIntent({ text: message, categories, today: todayIso, aiEnabled: false });
    assert.equal(appResult.categoryId, expected, `app: ${message}`);
    assert.equal(whatsappResult.categoryId, expected, `WhatsApp: ${message}`);
    assert.equal(commandResult.entry?.categoryId, expected, `comando WhatsApp: ${message}`);
  }
});
