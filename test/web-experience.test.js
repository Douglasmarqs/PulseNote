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
