const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../src/product-system.css"), "utf8");

test("gráfico de projeção abre detalhes por mouse e teclado", () => {
  assert.match(html, /class="pulse-forecast-visual" role="button" tabindex="0"/);
  assert.match(html, /id="pulseForecastDetailModal"/);
  assert.match(app, /forecastVisual\?\.addEventListener\("click", openDashboardForecastDetail\)/);
  assert.match(app, /event\.key !== "Enter" && event\.key !== " "/);
});

test("detalhes da projeção usam texto seguro e dados do backend", () => {
  assert.match(app, /latestDashboardForecast = forecast/);
  assert.match(app, /lastForecastFetchAt = 0;\s+latestDashboardForecast = null;\s+renderSharedFinanceSpaces/);
  assert.match(app, /timeline\.replaceChildren\(\)/);
  assert.match(app, /title\.textContent = item\.description/);
  assert.doesNotMatch(app, /pulseForecastTimeline[\s\S]{0,200}innerHTML/);
});

test("sistema visual define materiais e preferências de acessibilidade", () => {
  assert.match(css, /--glass-subtle:/);
  assert.match(css, /--glass-elevated:/);
  assert.match(css, /--glass-focus:/);
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(css, /@media \(prefers-contrast: more\)/);
});
