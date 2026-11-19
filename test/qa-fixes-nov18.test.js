// Regressões do relatório de QA de 18/11/2026 + Finanças v2.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("src/app.js");
const html = read("src/index.html");
const css = read("src/finance-v2.css");

function fn(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} não encontrada`);
  const end = app.indexOf("\n}\n", start);
  assert.ok(end > start, `fim de ${name} não encontrado`);
  return app.slice(start, end + 2);
}

test("P1: painel compara só o gasto das categorias limitadas com a soma dos limites", () => {
  const state = {
    finGoals: [{ categoryId: "teste_qa", limit: 100, workspaceId: "personal" }],
    finances: [
      { type: "despesa", category: "teste_qa", amount: 26, date: "2026-11-10" },
      { type: "despesa", category: "alimentacao", amount: 70, date: "2026-11-11" },
      { type: "receita", category: "salario", amount: 1000, date: "2026-11-01" },
    ],
  };
  const finLimitedSpend = new Function("state", "activeWorkspaceId", `${fn("finLimitedSpend")}; return finLimitedSpend;`)(state, "personal");
  assert.deepEqual(finLimitedSpend("2026-11", "personal"), { limits: 100, spent: 26, count: 1 });
  assert.doesNotMatch(app, /% da meta \(\$\{formatCurrency\(goalTotal\)\}\)/);
});

test("P1: escopo dos filtros aparece acima dos indicadores e no calendário", () => {
  assert.match(html, /id="finScopeBar"[^>]*role="status"/);
  assert.ok(html.indexOf('id="finScopeBar"') < html.indexOf('id="finKpis"'), "barra de escopo vem antes dos indicadores");
  assert.match(html, /id="finCalScopeTag"/);
  assert.match(fn("renderFinScope"), /Filtrado/);
});

test("P1: espaço compartilhado renova o token e mostra erro específico", () => {
  const api = fn("pulseApi");
  assert.match(api, /verified_email_required/);
  assert.match(api, /getIdToken\(retried\)/);
  assert.match(fn("createFinanceSpace"), /financeSpaceErrorMessage\(error/);
});

test("P2: respostas da IA não carregam campos do JSON estruturado", () => {
  const { stripStructuredArtifacts, salvageReply } = require("../api/_lib/aiGatewayFetch");
  assert.equal(stripStructuredArtifacts('Oi! Tudo certo. navigationTarget":"planner"}'), "Oi! Tudo certo.");
  assert.equal(stripStructuredArtifacts('Não consigo ler. Follow-ups":["Ativar"],"navigationTarget":"notes"}'), "Não consigo ler.");
  assert.equal(stripStructuredArtifacts("Seus remindes estão em dia."), "Seus lembretes estão em dia.");
  assert.equal(stripStructuredArtifacts("Gastei 30, tipo: mercado"), "Gastei 30, tipo: mercado");
  assert.equal(salvageReply('Posso ajudar. "followUps":["x"],"navigationTarget":null}').reply, "Posso ajudar.");
  assert.match(app, /pulsinhoCleanReply\(message\.content\)/);
});

test("P2: 'mercado' explícito vence a categoria ampla 'alimentação'", () => {
  const { normalizeActions } = require("../api/_lib/pulsinhoActions");
  const { buildCategoryList } = require("../api/_lib/financeCategories");
  const ctx = { state: {}, categories: buildCategoryList({}), today: "2026-11-18", channel: "app", rawMessage: "Gastei R$ 30 no mercado hoje. Registre como alimentação." };
  const result = normalizeActions([{ type: "add_transaction", amount: 30, transactionType: "despesa", categoryId: "alimentacao", title: "Mercado" }], ctx);
  assert.equal(result.actions[0].record.category, "mercado");
});

test("P2: nomear etapas mantém o progresso numérico", () => {
  const make = new Function("crypto", `${fn("syncGoalFromMilestones")}\n${fn("addNamedGoalMilestone")}; return addNamedGoalMilestone;`);
  let n = 0;
  const add = make({ randomUUID: () => `id${n++}` });
  const goal = { target: 3, current: 1 };
  add(goal, "Validar telas principais");
  assert.equal(goal.target, 3);
  assert.equal(goal.current, 1);
  assert.equal(goal.milestones[1].title, "Validar telas principais");
});

test("P2: plano gratuito, a11y dos temas e do botão flutuante, fechamento confirmado", () => {
  assert.match(app, /Plano gratuito ativo/);
  assert.match(app, /setAttribute\("aria-checked", String\(on\)\)/);
  assert.match(fn("setFinAutoSection"), /rules: "Nova regra"/);
  assert.doesNotMatch(fn("closeMonth"), /confirm\(`Fechar/);
});

test("P2/P3: e-mails em pt-BR e reenvio com contagem regressiva", () => {
  const init = read("src/firebase-init.js");
  assert.match(init, /auth\.languageCode = "pt-BR"/);
  assert.match(app, /Reenviar em \$\{left\}s/);
});

test("Finanças v2: cartões, categorias e toast sem emoji", () => {
  assert.match(fn("renderCreditCards"), /finCardArtHtml\(card\)/);
  assert.match(fn("syncCategoryTrigger"), /bdIcon\(finCategoryIconAny/);
  const picker = fn("openCategoryPicker");
  assert.doesNotMatch(picker, /🗑️|✓|✕|➕/u);
  assert.match(html, /class="toast t-toast"/);
  assert.doesNotMatch(html, /toast-mascot/);
  for (const t of ["t-toast", "t-success-check", "t-tilt-glare", "bf-tab-pill", "prefers-reduced-motion"]) assert.match(css, new RegExp(t));
  assert.match(html, /href="\/src\/finance-v2\.css\?v=\d+"/);
  assert.match(read("src/sw.js"), /"\/src\/finance-v2\.css"/);
});

test("Instalação: banner e instruções no visual novo, sem emojis, com o ícone do app", () => {
  const pwa = read("src/pwa-install.js");
  assert.doesNotMatch(pwa, /⚡|◻️|✕|⋮|↑/u);
  assert.match(pwa, /pwa-banner/);
  assert.match(pwa, /const APP_ICON = "icons\/icon-192\.png/);
  assert.match(pwa, /navigator\.maxTouchPoints > 1/); // iPadOS
  const manifest = JSON.parse(read("src/manifest.json"));
  assert.ok(manifest.icons.every((icon) => /\?v=20261119$/.test(icon.src)), "ícones com versão nova (cache)");
});

test("Resto do app: sem emojis na interface e aviso de erro sem alarme falso", () => {
  for (const glyph of ["💸 Gastei", "📅 O que tenho", "📊 Meus gastos", ">✕</button>"]) assert.ok(!html.includes(glyph), glyph);
  assert.doesNotMatch(read("src/notifications.js"), /"[📋📅🎯💸💰🔔]/u);
  assert.match(app, /const BENIGN_RUNTIME_ERRORS = \/ResizeObserver loop/);
  assert.match(app, /banner\.className = "rt-error"/);
  assert.match(css, /\.bn-nd-status\[data-state="saved"\] i::after/);
});

test("Notas: selo estável enquanto digita e 'Salvo' só com a nuvem confirmando", () => {
  const status = fn("setNdStatus");
  assert.match(status, /if \(el\.dataset\.state === state\) return;/, "não repinta a cada tecla");
  assert.match(app, /const ND_STATUS_LABELS = \{ editing: "Editando", saving: "Salvando…", saved: "Salvo", local: "Salvo no aparelho" \}/);
  assert.match(app, /window\.addEventListener\("pulsenote:synced"/);
  assert.match(app, /window\.dispatchEvent\(new CustomEvent\("pulsenote:synced", \{ detail: \{ ok: true/);
  assert.match(app, /Math\.min\(900, 5000 - \(now - ndFirstPendingAt\)\)/, "pausa de 0,9 s ou no máximo 5 s");
  assert.match(app, /renderAllUnlessEditingNote\(\); \/\/ re-renderiza/, "não redesenha durante a edição");
});

test("Finanças: formulário com borda vermelha em Despesa e verde em Receita", () => {
  assert.match(css, /#financesView \.bf-form\.fin-form-card:not\(\.is-receita\) \{ border-color: color-mix\(in srgb, var\(--bd-red\)/);
  assert.match(css, /#financesView \.bf-form\.fin-form-card\.is-receita \{ border-color: var\(--bd-green-line\); \}/);
});

test("Finanças v2: todo ícone novo usado existe como símbolo", () => {
  const symbols = new Set([...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  const catalog = app.slice(app.indexOf("const NEW_CATEGORY_ICON_GROUPS = ["), app.indexOf("const NEW_CATEGORY_ICON_FLAT"));
  const emojiMap = app.slice(app.indexOf("const FIN_EMOJI_SVG = {"), app.indexOf("};", app.indexOf("const FIN_EMOJI_SVG = {")));
  const used = new Set([
    ...[...catalog.matchAll(/\["([a-z0-9-]+)", "/g)].map((m) => m[1]),
    ...[...emojiMap.matchAll(/:"([a-z0-9-]+)"/g)].map((m) => m[1]),
    "contactless",
  ]);
  assert.deepEqual([...used].filter((name) => !symbols.has(name)), []);
});
