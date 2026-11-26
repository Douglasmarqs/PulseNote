const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("camada do navegador carrega por último e entra no cache offline", () => {
  const html = read("src/index.html");
  const sw = read("src/sw.js");
  const links = [...html.matchAll(/<link rel="stylesheet" href="\/src\/([^"?]+)/g)].map((m) => m[1]);
  assert.equal(links.at(-1), "web.css", "web.css precisa ser a última folha de estilo");
  assert.match(html, /<script src="\/src\/web-motion\.js\?v=\d+" defer><\/script>/);
  assert.match(sw, /"\/src\/web\.css"/);
  assert.match(sw, /"\/src\/web-motion\.js"/);
});

test("Finanças no celular: três resumos em grade, sem vão à direita", () => {
  const css = read("src/web.css");
  const mobile = css.slice(css.indexOf("@media (max-width: 760px)"), css.indexOf("COMPUTADOR / TABLET"));
  assert.match(mobile, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(mobile, /margin: 0; padding: 0; overflow: visible/);
  assert.match(mobile, /#financesView \.bf-dots \{ display: none; \}/);
});

test("movimento respeita 'reduzir movimento' e o tema usa revelação circular", () => {
  const css = read("src/web.css");
  const js = read("src/web-motion.js");
  const app = read("src/app.js");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /startViewTransition/);
  assert.match(app, /window\.pnWithThemeTransition\(\(\) => applyTheme\(choice\)\)/);
});

test("indicador da barra não observa a si mesmo (sem laço de mutações)", () => {
  const js = read("src/web-motion.js");
  // Só troca a classe quando o estado muda de fato…
  assert.match(js, /if \(ink\.classList\.contains\("is-off"\) !== off\)/);
  // …e observa apenas os itens da barra, ignorando o próprio indicador.
  assert.match(js, /records\.some\(\(r\) => r\.target !== ink\)/);
  assert.doesNotMatch(js, /\.observe\(nav, \{ attributes: true, subtree: true/);
});

test("atalhos de teclado não disparam enquanto se digita", () => {
  const js = read("src/web-motion.js");
  assert.match(js, /isContentEditable \|\| \/\^\(INPUT\|TEXTAREA\|SELECT\)\$\//);
  for (const key of ["i: \"dashboard\"", "p: \"planner\"", "n: \"notes\"", "f: \"finances\""]) assert.ok(js.includes(key), key);
});

test("divisórias entre itens são traços suaves, não linhas retas de ponta a ponta", () => {
  const css = read("src/web.css");
  assert.match(css, /--pn-divider: linear-gradient\(90deg,/);
  for (const row of [".bf-tx", ".bd-agenda .bd-ag", ".bp-task", ".bf-row", ".bd-res-row"]) assert.ok(css.includes(row), row);
  assert.match(css, /border-top-color: transparent !important;\s*background-image: var\(--pn-divider\)/);
  assert.match(css, /border-bottom-color: transparent !important;\s*background-image: var\(--pn-divider\)/);
  assert.match(css, /\.bd-ag-more \{ border-top-color: transparent !important; background-image: none !important; \}/);
});

test("movimento ao passar o mouse, trocar de aba e rolar", () => {
  const js = read("src/web-motion.js");
  // destaque único que desliza entre as linhas de uma lista
  assert.match(js, /pn-row-pill/);
  // pílula deslizante nos seletores de período/espaço
  assert.match(js, /const SEG_SEL = "\.bd-seg, \.bf-ws"/);
  // abas do Planner e de Finanças entram pelo lado para onde se andou
  assert.match(js, /\[data-planner-tab\]/);
  assert.match(js, /\.fin-tab-btn/);
  assert.match(js, /translateX\(\$\{dir \* 26\}px\)/);
  // fio de progresso da rolagem e inclinação 3D das notas
  assert.match(js, /pn-scroll-line/);
  assert.match(js, /perspective\(900px\) rotateX/);
});

test("todos os aparelhos: toque responde, efeitos de mouse só com mouse", () => {
  const css = read("src/web.css");
  const js = read("src/web-motion.js");
  // toque acende a linha / afunda o cartão, e solta ao rolar
  assert.match(js, /e\.pointerType === "mouse"/);
  assert.match(js, /classList\.add\("pn-press"\)/);
  assert.match(css, /\.pn-press \{\s*background-color/);
  // levantar cartão e brilho do botão só onde existe mouse (sem "hover preso" no tablet)
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.bn-card:hover/);
  // topo ao rolar e animação do título valem em qualquer largura
  assert.doesNotMatch(js, /toggle\("pn-scrolled", desktop\.matches/);
  assert.doesNotMatch(js, /if \(!desktop\.matches\) return;\s*replay/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.bd-topbar \{ transition/);
});

test("preferência de movimento do app vence o 'reduzir movimento' do sistema quando escolhida", () => {
  const js = read("src/web-motion.js");
  assert.match(js, /const MOTION_KEY = "pulsenote-motion"/);
  // matchMedia e as regras @media de movimento passam a seguir a escolha
  assert.match(js, /window\.matchMedia = \(query\) =>/);
  assert.match(js, /rule\.media\.mediaText = next/);
  // opção nas Configurações → Aparência
  assert.match(js, /data-motion-choice/);
  assert.match(js, /\["full", "Sempre ligado"\]/);
});

test("navegador: colunas do Início batem, Notas com mesma altura e Finanças proporcional", () => {
  const css = read("src/web.css");
  assert.match(css, /\.bd-kpis, \.bd-row--charts, \.bd-row--lists \{ grid-template-columns: minmax\(0, 1\.35fr\) minmax\(0, 1fr\); \}/);
  assert.match(css, /\.bn-grid:has\(#noteDetailModal:not\(\[hidden\]\)\)/);
  assert.match(css, /height: max\(600px, calc\(100dvh - 118px\)\)/);
  assert.match(css, /#financesView \.bf-launch \{ grid-template-columns: minmax\(0, 1\.22fr\) minmax\(300px, \.92fr\) minmax\(0, 1\.12fr\); align-items: stretch; \}/);
  assert.match(css, /\.bd-main > \.view \{ margin-inline: 0 !important; \}/);
});

test("moldura sem riscas: barra lateral e topo sem linhas, sem letrinhas de atalho", () => {
  const css = read("src/web.css");
  const js = read("src/web-motion.js");
  // topo: sem faixa parada; vidro que se dissolve só ao rolar
  assert.match(css, /\.bd-topbar \{\s*background: transparent !important;/);
  assert.match(css, /body\.pn-scrolled \.bd-topbar::after \{ content: none !important; \}/);
  assert.match(css, /mask-image: linear-gradient\(180deg, #000 0, #000 calc\(100% - 30px\), transparent 100%\)/);
  // barra lateral: sem borda, sem linha e sem desfoque que desenhava degrau
  assert.match(css, /\.bd-sidebar::before \{ content: none !important; \}/);
  assert.match(css, /border-right: 0 !important;/);
  assert.match(css, /backdrop-filter: none !important;/);
  // letrinhas "G N" ao passar o mouse saíram (o atalho continua funcionando)
  assert.doesNotMatch(js, /<kbd>G<\/kbd><kbd>\$\{key\}<\/kbd>/);
  assert.match(js, /aria-keyshortcuts", `G \$\{key\.toUpperCase\(\)\}`/);
});

test("troca de tela sem piscar: título nunca some e só uma animação", () => {
  const app = read("src/app.js");
  const js = read("src/web-motion.js");
  // título só clareia (0,55 → 1), sem deslizar
  assert.match(app, /el\?\.animate\?\.\(\[\{ opacity: 0\.55 \}, \{ opacity: 1 \}\]/);
  assert.doesNotMatch(js, /replay\(title, "pn-title-in"\)/);
  assert.match(js, /classList\.add\("pn-view-switch"\)/);
});

test("Perfil abre estável: mapa desenhado no mesmo quadro e sem números contando", () => {
  const app = read("src/app.js");
  const js = read("src/web-motion.js");
  assert.match(app, /if \(view === "profile"\) pfxRenderHeatmap\(\);/);
  assert.doesNotMatch(js, /COUNT_SEL = "[^"]*pfx-stat/);
});

test("nota aberta: concluir comemora, ferramentas recolhem e checklist renovado", () => {
  const app = read("src/app.js");
  const js = read("src/web-motion.js");
  const css = read("src/web.css");
  assert.match(app, /window\.pnCelebrate\(document\.querySelector\("#ndSaveBtn"\)\);\s*setTimeout\(\(\) => \{ saveNoteDetail\.closing = false; closeNoteDetail\(\); \}, 380\);/);
  assert.match(js, /window\.pnCelebrate = /);
  assert.match(css, /@keyframes pnCheckDraw/);
});

test("gráfico de evolução: leitura ao passar o mouse sem redesenhar e sem brilho pesado", () => {
  const app = read("src/app.js");
  const js = read("src/web-motion.js");
  assert.match(app, /function bindBalanceChartHover\(host\)/);
  assert.match(app, /if \(!frame\) frame = requestAnimationFrame\(paint\);/);
  assert.match(app, /class="pn-chart-tip"/);
  assert.match(js, /SPOT_SKIP = "[^"]*\.bd-evo, \.bf-evo/);
});

test("gráfico redondo: fatia ativa não move a área de clique e não pisca", () => {
  const app = read("src/app.js");
  const css = read("src/web.css");
  // só o traço visível se desloca; o grupo (com a área de clique) fica parado
  assert.match(css, /\.bd-donut-seg-g\.is-active \{ transform: none !important; \}/);
  assert.match(css, /\.bd-donut-seg-g\.is-active \.bd-donut-seg \{ transform: translate\(var\(--dx\), var\(--dy\)\); \}/);
  // vãos entre fatias esperam antes de voltar ao total
  assert.match(app, /revertTimer = setTimeout\(\(\) => preview\(null\), 180\);/);
  // centro troca sem apagar
  assert.match(app, /\{ opacity: 0\.4, transform: "scale\(\.95\)" \}/);
  // texto de baixo com altura fixa
  assert.match(css, /\.bd-cats-insight \{ min-height: 52px;/);
});

test("site sem tremidinha: um movimento só por bloco, sem encolher ao tocar", () => {
  const js = read("src/web-motion.js");
  const css = read("src/web.css");
  const app = read("src/app.js");
  // linhas não deslizam mais em sentido contrário à tela
  assert.doesNotMatch(js, /cascadeRows/);
  // revelar ao rolar: sem escala
  assert.doesNotMatch(js, /translateY\(18px\) scale\(\.985\)/);
  // toque: espera mais e cancela se o dedo andar; sem encolher
  assert.match(js, /Math\.hypot\(e\.clientX - pressStart\.x, e\.clientY - pressStart\.y\) > 6/);
  assert.doesNotMatch(css, /\.pn-press \{\s*transform: scale/);
  // troca de tela só esmaece: nenhum bloco desliza, cartões não sobem e
  // números não contam (largura mudando a cada quadro)
  assert.match(css, /@keyframes cardRise \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
  assert.match(css, /@keyframes pfxRise \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
  assert.match(css, /@keyframes wfIn \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
  assert.match(app, /el\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\], \{ duration: 240/);
  assert.doesNotMatch(app, /translate3d\(\$\{dx\}px, \$\{dy\}px, 0\)/);
  assert.doesNotMatch(js, /function countUp/);
  // colunas das Notas não animam a largura (reorganizava os cartões a cada quadro)
  assert.doesNotMatch(css, /transition: grid-template-columns \.55s/);
});

test("nota aberta (direção A): topo limpo, detalhes numa linha, formatação acima do teclado", () => {
  const js = read("src/web-motion.js");
  const css = read("src/web.css");
  const app = read("src/app.js");
  const html = read("src/index.html");
  // topo: status discreto, sem contagem de palavras, sem ícone ao lado do título
  assert.match(css, /\.bn-detail \.bn-nd-count \{ display: none !important; \}/);
  assert.match(css, /\.bn-detail \.bn-nd-hero \.bn-detail-ico \{ display: none !important; \}/);
  // prioridade · pasta · data numa linha que abre a folha de detalhes
  assert.match(app, /class="bn-nd-metaline" data-nd-details/);
  assert.match(app, /function openNoteDetailsSheet\(noteId\)/);
  assert.match(app, /if \(event\.target\.closest\("\[data-nd-details\]"\)\) \{\s*openNoteDetailsSheet\(note\.id\);/);
  // formatação: no celular só ao escrever, presa acima do teclado; rodapé sai
  assert.match(js, /ndDetail\.classList\.add\("is-writing"\)/);
  assert.match(js, /--pn-kb/);
  assert.match(css, /\.bn-detail:not\(\.is-writing\) #noteDetailToolbar \{ display: none !important; \}/);
  assert.match(css, /\.bn-detail\.is-writing \.bn-detail-foot \{ display: none !important; \}/);
  // rodapé: Concluir largo, Tarefa compacto
  assert.match(html, /id="ndConvertTaskBtn" aria-label="Virar tarefa"><svg class="i"><use href="#i-bolt"\/><\/svg><span>Tarefa<\/span>/);
  assert.match(css, /\.bn-detail \.bn-detail-foot \{ grid-template-columns: auto minmax\(0, 1fr\) !important; \}/);
});

test("checklist leve e prático", () => {
  const js = read("src/web-motion.js");
  const css = read("src/web.css");
  const html = read("src/index.html");
  // checklist tem campo próprio (aba): a área de texto não é mais encurtada
  assert.doesNotMatch(css, /\.bn-detail-scroll:has\(#ndChecklistSection/);
  // concluídos descem para o fim sob "Concluídos"
  assert.match(css, /\.bn-check-row\.pn-sunk \{ order: 1; \}/);
  assert.match(css, /content: "Concluídos"/);
  assert.match(js, /flip\(\(\) => row\.classList\.add\("pn-sunk"\)\)/);
  assert.match(html, /<span>Checklist<\/span><span id="ndChecklistProgress">/);
  assert.match(html, /placeholder="Adicionar item"/);
});

test("nota: Anotação e Checklist em abas separadas", () => {
  const html = read("src/index.html");
  const app = read("src/app.js");
  const css = read("src/web.css");
  assert.match(html, /id="ndTabs" role="tablist"/);
  assert.match(html, /data-nd-tab="text"/);
  assert.match(html, /data-nd-tab="check"/);
  assert.match(app, /function setNdTab\(tab, \{ focus = false, animate = true \} = \{\}\)/);
  // botão de checklist da barra leva para a aba
  assert.match(app, /if \(cmd === "checklist"\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*setNdTab\("check", \{ focus: true \}\);/);
  // uma aba por vez
  assert.match(css, /\.bn-detail\[data-tab="text"\] #ndChecklistSection \{ display: none !important; \}/);
  assert.match(css, /\.bn-detail\[data-tab="check"\] #ndBody,/);
  assert.match(app, /tabCount\.textContent = items\.length \? `\$\{completed\}\/\$\{items\.length\}` : "";/);
});

test("Pulsinho: abertura e fechamento com coreografia", () => {
  const app = read("src/app.js");
  assert.match(app, /function playPulsinhoOpenChoreography\(chat, from, to, \{ backdrop, teaserMascot, mascotFrom \} = \{\}\)/);
  assert.match(app, /glow\.className = "bd-chat-glow";/);
  assert.match(app, /querySelector\("\.bd-teaser-mascot"\)\?\.animate\?\./);
  // elemento compartilhado: o Pulsinho voa do balão ao cabeçalho e volta
  assert.match(app, /function pulsinhoFlyMascot\(source, fromRect, toRect/);
  assert.match(app, /pulsinhoFlyMascot\(teaserMascot, mascotFrom, landAt/);
  assert.match(app, /pulsinhoFlyMascot\(headMascot, headMascot\.getBoundingClientRect\(\), mascotTo/);
  // fundo escurece em círculo a partir do balão; pulso desenhado ao pousar
  assert.match(app, /clipPath: `circle\(0px at \$\{cx\}px \$\{cy\}px\)`/);
  assert.match(app, /strokeDashoffset: `\$\{len\}`/);
});

test("Pulsinho no Início: coluna proporcional, alinhada aos cartões e com sugestões", () => {
  const css = read("src/web.css");
  const js = read("src/web-motion.js");
  const app = read("src/app.js");
  const html = read("src/index.html");
  assert.match(css, /\.bd-dash \{ grid-template-columns: minmax\(0, 1fr\) clamp\(360px, 22vw, 420px\); \}/);
  assert.match(css, /margin-top: var\(--pn-chat-top, 52px\)/);
  assert.match(js, /--pn-chat-h/);
  // sugestões aparecem no computador até a primeira mensagem
  assert.match(app, /box\.hidden = !\(isPulsinhoConvo\(\) \|\| docked\)/);
  // sem emoji nas sugestões
  const suggest = html.slice(html.indexOf('id="bdChatSuggest"'), html.indexOf('id="pulseCommandForm"'));
  assert.doesNotMatch(suggest, /\p{Extended_Pictographic}/u);
});

test("valores em odômetro: largura fixa, rola ao abrir e ao mudar o valor", () => {
  const js = read("src/web-motion.js");
  const css = read("src/web.css");
  assert.match(js, /const ODO_SEL = /);
  assert.match(js, /function odoRoll\(el, fromText\)/);
  assert.match(js, /odoObserver\.observe\(el, \{ childList: true, characterData: true, subtree: true \}\)/);
  assert.match(css, /font-variant-numeric: tabular-nums;/);
  assert.match(css, /\.pn-odo-d \{\s*overflow: hidden;/);
  // leitor de tela continua lendo o valor certo
  assert.match(js, /<span class="sr-only">\$\{escHtml\(to\)\}<\/span>/);
});

test("abertura: Pulsinho voa até o logo e a tela se revela em círculo", () => {
  const app = read("src/app.js");
  const html = read("src/index.html");
  assert.match(app, /function playSplashExit\(overlay\)/);
  assert.match(app, /if \(reduceMotion \|\| !playSplashExit\(overlay\)\)/);
  assert.match(app, /overlay\.style\.setProperty\("background", "transparent", "important"\)/);
  assert.match(html, /class="app-loading-word" aria-label="PulseNote"><span style="--i:0">P<\/span>/);
  assert.match(html, /class="app-loading-beat"/);
});

test("tarefa concluída: faíscas na caixinha", () => {
  const js = read("src/web-motion.js");
  assert.match(js, /window\.pnSpark = pnSpark;/);
  assert.match(js, /const check = e\.target\.closest\?\.\("\.bp-check"\);/);
});
