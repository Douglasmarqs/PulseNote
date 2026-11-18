// Refinos de novembro/2026: Início ↔ Planner, gráficos, Pulsinho em balão,
// Planner compacto, Notas reformuladas, salvamento leve e Finanças.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("src/index.html");
const app = read("src/app.js");
const refine = read("src/refine.css");
const productCss = read("src/product-system.css");
const sw = read("src/sw.js");

// Extrai uma função de nível superior do app.js pelo nome (para testar comportamento).
function extractFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `função ${name} existe`);
  let depth = 0;
  let i = app.indexOf("{", start);
  for (; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    else if (app[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return app.slice(start, i + 1);
}

test("tema automático vira um tema real (sem misturar claro com escuro)", () => {
  assert.match(html, /setAttribute\("data-theme", \(t === "light" \|\| t === "aurora" \|\| t === "eclipse"\) \? t : \(isDark \? "aurora" : "light"\)\)/);
  assert.match(app, /function resolveThemeChoice\(choice\)/);
  assert.match(app, /if \(getSavedTheme\(\) === "system"\) applyTheme\("system"\)/);
  // Os tokens escuros não valem mais para "qualquer tema que não seja claro".
  assert.doesNotMatch(productCss, /^:root:not\(\[data-theme="light"\]\) \{/m);
  assert.match(productCss, /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{/);
});

test("compromissos de hoje no Início usam o mesmo recorte do Planner", () => {
  const snapshot = extractFunction("bdAgendaSnapshot");
  // tarefas do dia: mesmo filtro da lente Dia do Planner
  assert.match(snapshot, /t\.dueDate === todayIso && t\.status !== "Cancelada"/);
  // atrasadas: mesmo critério do grupo "Atrasadas"
  assert.match(snapshot, /t\.dueDate < todayIso && t\.status !== "Concluida" && t\.status !== "Cancelada"/);
  // contas: só as que vencem hoje (o cartão é "de hoje")
  assert.match(snapshot, /if \(dueDay !== todayDay\) continue;/);
  assert.doesNotMatch(snapshot, /dueDay - todayDay > 7/);
  const render = extractFunction("renderBoardsToday");
  assert.match(render, /counts\.overdue \?/, "chip de atrasadas só aparece quando há");
  assert.match(render, /counts\.bills \?/, "chip de contas só aparece quando há");
  assert.match(app, /if \(plannerFocus === "agenda"\) \{ plannerDayDate = todayIso; setPlannerTab\("day"\); \}/);
});

test("o app acompanha o relógio (vira o dia sem recarregar)", () => {
  assert.match(app, /^let todayIso = toLocalIso\(new Date\(\)\);/m);
  assert.match(app, /function refreshTodayIfNeeded\(\)/);
  assert.match(app, /function startLiveClock\(\)/);
  assert.match(app, /visibilitychange", \(\) => \{ if \(!document\.hidden\) refreshTimeSensitiveViews\(\); \}/);
  assert.match(app, /startLiveClock\(\);/);
});

test("curva dos gráficos é monotônica: não inventa picos nem sai da área", () => {
  const bdSmoothPath = new Function(`${extractFunction("bdSmoothPath")}; return bdSmoothPath;`)();
  // degrau: 100,100,100,40,40 — a curva nunca pode passar de 100 nem descer de 40
  const coords = [[0, 100], [10, 100], [20, 100], [30, 40], [40, 40]];
  const d = bdSmoothPath(coords);
  const ys = [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));
  assert.ok(ys.length > 4);
  assert.ok(Math.max(...ys) <= 100 + 1e-9, `máximo ${Math.max(...ys)}`);
  assert.ok(Math.min(...ys) >= 40 - 1e-9, `mínimo ${Math.min(...ys)}`);
});

test("bolinha do gráfico tem folga e etiqueta não cobre o fim da linha", () => {
  const draw = extractFunction("drawBalanceChart");
  assert.match(draw, /const DOT = 7;/);
  assert.match(draw, /right: DOT \+ 6, top: DOT \+ 6/);
  assert.match(draw, /longestTick/);
  assert.match(draw, /overflow="visible"/);
  // linhas dos cartões não encostam na borda
  assert.match(app, /2 \+ \(i \/ \(values\.length - 1\)\) \* 194/);
});

test("Pulsinho: balão com chamada própria, sem a mãozinha, abre a conversa", () => {
  assert.doesNotMatch(html, /👋/);
  assert.match(html, /id="bdChatTeaser"/);
  assert.match(html, /id="bdChatTeaserText"/);
  assert.match(html, /id="bdChatTeaserActions"/);
  assert.match(app, /function pulsinhoTeaserCalls\(\)/);
  assert.match(app, /function bindPulsinhoTeaser\(\)/);
  assert.match(app, /clipPath: pulsinhoClipFor\(from, to, 22\)/, "o balão se abre até virar a tela de conversa");
  assert.match(app, /if \(pulsinhoIntroState === "pending"\) playPulsinhoIntro\(\);/);
  assert.match(refine, /#dashboardView \.bd-chat:not\(\.is-convo\) > :not\(\.bd-chat-teaser\) \{ display: none !important; \}/);
  assert.match(refine, /\.bd-chat-wave \{ display: none !important; \}/);
});

test("Planner: sem botão flutuante, foco compacto e vivo, mês com agenda do dia", () => {
  assert.doesNotMatch(html, /id="plannerFab"/);
  assert.doesNotMatch(app, /#plannerFab/);
  const focus = extractFunction("renderPlannerFocus");
  assert.match(focus, /class="wf/);
  assert.match(focus, /plannerFocusWeekLabel\(\)/);
  assert.match(app, /function schedulePlannerFocusAdvance\(goalId\)/);
  assert.match(html, /id="plannerMonthDay"/);
  assert.match(app, /function renderPlannerMonthDay\(\)/);
  assert.match(app, /function bindPlannerMonth\(\)/);
  // "Ir para hoje" virou uma pílula "Hoje" que só aparece fora do período atual
  assert.doesNotMatch(html, /Ir para hoje/);
  assert.match(html, /id="plannerDayToday" hidden/);
  const groups = extractFunction("getPlannerTaskGroups");
  assert.ok(groups.indexOf('key: "overdue"') < groups.indexOf('key: "today"'), "Atrasadas primeiro");
  for (const key of ["tomorrow", "week", "later", "undated"]) assert.match(groups, new RegExp(`key: "${key}"`));
});

test("Notas: botões com estado lido do texto, sem hover preso no celular", () => {
  assert.match(app, /function noteFormatState\(editor\)/);
  assert.match(app, /function paintNoteToolbar\(toolbar, editor, key\)/);
  assert.match(app, /let notePending = null;/);
  assert.match(app, /function setNdPanel\(name\)/, "cor e link: um painel por vez");
  assert.match(refine, /@media \(hover: hover\) and \(pointer: fine\) \{\n  \.bn-rich-tools button:hover, \.bn-tool-row > button:hover/);
  assert.match(app, /else if \(node\.tagName === "MARK" && !node\.textContent\.trim\(\) && !node\.querySelector\("br"\)\) node\.remove\(\);/);
  assert.match(app, /node\.textContent\.replace\(\/\\u200B\/g, ""\)/);
});

test("Notas: salvar não redesenha o app inteiro nem trava", () => {
  const save = extractFunction("saveNote");
  assert.doesNotMatch(save, /renderAll\(\)/);
  assert.match(save, /queueNotePersist\(\);/);
  assert.match(save, /"Nota criada"/);
  const close = extractFunction("closeNoteDetail");
  assert.doesNotMatch(close, /renderAll\(\)/);
  assert.match(app, /function queueNotePersist\(\)/);
  assert.match(app, /window\.addEventListener\("pagehide", flushNotePersist\);/);
  assert.match(app, /label\.textContent = state === "saved" \? "Salvo" : "Salvando…";/);
  assert.doesNotMatch(app, /Anotacao (criada|atualizada|excluida)/);
});

test("Notas: checklist de verdade e pasta no lugar de 'Organizar'", () => {
  assert.match(app, /function renderNoteChecklistBuilder\(/);
  assert.match(app, /function addNoteChecklistItem\(/);
  assert.match(app, /event\.key === "Backspace" && !input\.value/);
  assert.match(app, /function openNoteFolderSheet\(noteId\)/);
  assert.match(html, /<span>Mover para pasta<\/span>/);
  // campos de notas antigas continuam guardados ao editar
  for (const id of ["noteCategory", "noteTags", "noteGoal", "noteAttachments", "noteObservations"]) {
    assert.match(html, new RegExp(`id="${id}" type="hidden"`), id);
  }
});

test("Finanças: linha de acompanhamento do mês no cartão Receitas", () => {
  assert.match(app, /function finMonthPulseSeries\(monthKey\)/);
  assert.match(app, /function renderFinMonthPulse\(monthKey\)/);
  assert.match(app, /dot\.className = "bf-spark-dot";/, "bolinha em HTML (não deforma nem corta)");
  assert.match(refine, /\.bf-kpi--in\.has-pulse \.bf-spark \{/);
});

test("toda função chamada por onclick/onsubmit gerado está exposta em window", () => {
  const names = new Set();
  for (const src of [app, html]) {
    for (const m of src.matchAll(/on(?:click|submit|change|input|keydown)="(?:return\s+)?(?:event\.stopPropagation\(\);\s*)?([A-Za-z_$][\w$]*)\(/g)) names.add(m[1]);
  }
  names.delete("fn"); // exemplo em comentário
  names.delete("if"); // onkeydown="if(...)" não é chamada de função
  const exposed = new Set([...app.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]));
  const missing = [...names].filter((name) => !exposed.has(name));
  assert.deepEqual(missing, []);
});

test("PWA entrega a folha nova e invalida o cache antigo", () => {
  assert.match(html, /href="\/src\/refine\.css\?v=\d+"/);
  assert.match(sw, /"\/src\/refine\.css"/);
  assert.match(sw, /const CACHE_NAME = "pulsenote-v53";/);
});

test("Início: chips de compromissos coloridos por tipo", () => {
  assert.match(refine, /\.bd-ts \{ --tc: var\(--bd-primary\); background: color-mix\(in srgb, var\(--tc\) 10%, var\(--bd-card\)\)/);
  for (const tone of ["blue", "violet", "red", "amber"]) assert.match(refine, new RegExp(`\\.bd-ts\\.tone-${tone} \\{ --tc: var\\(--bd-${tone}\\); \\}`));
});

test("Gastos por categoria: toque seleciona a fatia e nada vira texto copiável", () => {
  assert.match(app, /let bdCatsSelected = null;/);
  assert.match(app, /function paintBoardsCategories\(previewIndex\)/);
  assert.match(app, /function selectBoardsCategory\(index\)/);
  assert.match(app, /class="bd-donut-hit"/, "área de toque maior que a fatia");
  assert.match(app, /data-cats-clear/, "tocar no centro volta ao total");
  assert.match(app, /addEventListener\("contextmenu"/);
  assert.match(app, /addEventListener\("selectstart", \(event\) => event\.preventDefault\(\)\)/);
  assert.doesNotMatch(extractFunction("renderBoardsCategories"), /<title>/, "sem tooltip nativo no toque longo");
  assert.match(refine, /-webkit-user-select: none; user-select: none; -webkit-touch-callout: none;/);
});

test("Notas: texto e checklist empilhados em coluna (não se sobrepõem no iPhone)", () => {
  assert.match(refine, /\.bn-detail \.bn-detail-scroll \{ display: flex !important; flex-direction: column;/);
  assert.match(refine, /\.bn-detail \.bn-detail-scroll > \* \{ flex: none; min-width: 0; \}/);
});

test("Notas: botões e cor acendem no toque, pela posição do cursor (não pelo nó)", () => {
  assert.match(app, /function noteCaretOffset\(editor, range\)/);
  assert.match(app, /function notePendingMatches\(editor, range\)/);
  assert.match(app, /values: \{ \.\.\.\(same \? notePending\.values : \{\}\), color: noteColorHex\(value\) \}/);
  assert.match(app, /colorBtn\.classList\.toggle\("has-color", Boolean\(color\)\)/);
  assert.match(app, /function noteEditorActive\(editor\)/);
});
