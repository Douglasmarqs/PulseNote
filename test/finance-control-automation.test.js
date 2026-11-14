const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("src/index.html");
const app = read("src/app.js");
const css = read("src/boards.css");

function block(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, start);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, end);
  return source.slice(from, to);
}

test("abas Controle e Automação mantêm todos os campos e botões usados pelo app", () => {
  for (const id of [
    "finGoalsList", "finOpenGoalsModal", "finBudgetsMonth", "finSavingsList", "finOpenSavingsModal",
    "finAccountsList", "finAddAccount", "finAccountFormWrap", "finAccountForm", "finAccountId", "finAccountName", "finAccountInstitution",
    "finAccountType", "finAccountWorkspace", "finAccountBalance", "finAccountCancel",
    "finCardsList", "finAddCard", "finCardFormWrap", "finCardForm", "finCardName", "finCardLast4", "finCardLimit", "finCardClosingDay", "finCardDueDay", "finCardCancel",
    "finMembersList", "finSpacesManage", "finSpacesManager", "finSpacesManagerClose", "finSharedSpacesList", "finSharedInvites",
    "finCreateSpaceToggle", "finCreateSpaceForm", "finSharedSpaceName", "finSharedSpaceType", "finCreateSpaceCancel",
    "finAutoBoard", "finOpenRecurModal", "finOpenRuleModal", "finReviewSuggestions", "finSuggestActionText",
    "finRecurList", "finRulesList", "finScheduledList", "finOpenSchedModal", "finRecurringSuggestions", "finIngestList",
    "finAutoCloseCard", "finAutoCloseMode", "finClosuresList", "finActivityList", "finAutoFab",
    "finSavingsModal", "finSavingsForm", "savingsId", "savingsName", "savingsTarget", "savingsSaved", "savingsDeposit", "savingsDepositBtn", "savingsDelete",
    "finRuleModal", "finRuleForm", "ruleId", "ruleMatch", "ruleType", "ruleCategory", "ruleName", "ruleDelete",
    "finSchedModal", "finSchedForm", "schedDesc", "schedAmount", "schedDate", "schedType", "schedCategory",
    "finGoalsModal", "goalCategory", "goalLimit", "finSaveGoal", "finDeleteGoal", "finGoalsCurrent",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const key of ["recur", "sched", "suggest", "rules", "ingest", "close", "log"]) {
    assert.match(html, new RegExp(`data-auto-open="${key}"`), `nav ${key}`);
    assert.match(html, new RegExp(`data-auto-sec="${key}"`), `seção ${key}`);
  }
  assert.match(html, /data-sim-slot="controle"/);
});

test("cada id usado pelo módulo de Controle/Automação existe na página", () => {
  const module = block(app, "// CONTROLE E AUTOMAÇÃO (quadros 07 e 08)", "// LANÇAMENTOS RECORRENTES");
  const ids = new Set([...module.matchAll(/["'`]#([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  assert.ok(ids.size > 40);
  const dynamic = new Set(["finActionSheet", "finAutoCloseToggle"]); // folha criada pelo próprio módulo
  for (const id of ids) if (!dynamic.has(id)) assert.match(html, new RegExp(`id="${id}"`), id);
});

test("recorrência pausada não é lançada nem aparece como compromisso", () => {
  const auto = block(app, "function autoApplyRecurrents()", "\nwindow.editNote");
  assert.match(auto, /if \(rec\.active === false\) return;/);
  assert.match(app, /if \(item\.active === false \|\| isRecurrentSkipped\(item, monthKey\)\) continue;/);
  assert.match(app, /if \(item\.active === false \|\| isRecurrentSkipped\(item, monthKey\)\) return false;/);
  const projection = read("src/finance-projection.js");
  assert.match(projection, /item\.active === false/);
});

test("regras preenchem tipo e categoria e contam execuções ao registrar", () => {
  assert.match(app, /function finMatchRule\(description\)/);
  assert.match(app, /finApplyRuleToForm\(result\.description\)/);
  assert.match(app, /rule\.hits = \(Number\(rule\.hits\) \|\| 0\) \+ 1;/);
  assert.match(app, /fillExpenseFormFrom\(data, "foto"\)/);
  assert.match(app, /fillExpenseFormFrom\(data, "áudio"\)/);
});

test("fechamento automático fecha o mês anterior sem pedir confirmação", () => {
  assert.match(app, /function closeMonth\(monthKey, \{ silent = false \} = \{\}\)/);
  assert.match(app, /if \(!silent && !confirm\(`Fechar/);
  assert.match(app, /autoCloseFinMonths\(\);/);
  assert.match(app, /closeMonth\(previous, \{ silent: true \}\)/);
});

test("novos dados financeiros são normalizados e sincronizados item a item", () => {
  for (const field of ["savingsGoals", "finRules", "finActivity"]) {
    assert.match(app, new RegExp(`if \\(!Array\\.isArray\\(parsed\\.${field}\\)\\) parsed\\.${field} = \\[\\];`), field);
  }
  const sync = read("src/state-sync.js");
  for (const field of ["savingsGoals", "finRules", "finActivity", "scheduledFinances"]) assert.match(sync, new RegExp(`"${field}"`), field);
  assert.match(app, /if \(state\.finActivity\.length > 60\) state\.finActivity\.length = 60;/);
});

test("layout responsivo de Controle e Automação", () => {
  assert.match(css, /\.bf-ctl \{ display: grid; grid-template-columns: repeat\(24, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 760px\) \{\n  \.bf-ctl \{ display: flex; flex-direction: column;/);
  assert.match(css, /\.bf-auto\[data-open\]:not\(\[data-open=""\]\) \.bf-auto-nav \{ display: none; \}/);
  assert.match(css, /#globalPaletteInput, #categoryPickerSearch \{/);
});
