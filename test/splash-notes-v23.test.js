const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("src/index.html");
const app = read("src/app.js");
const css = read("src/boards.css");

test("abertura: Pulsinho animado já no HTML (antes de qualquer CSS externo)", () => {
  assert.match(html, /<div class="pulsinho-stage" aria-hidden="true">/);
  assert.match(html, /class="pulsinho-ring"/);
  assert.match(html, /<path pathLength="100" d="M0,13/);
  for (const name of ["pnSplashEnter", "pnSplashLeave", "pnSplashRing", "pnSplashBeat", "pnSplashLook"]) {
    assert.match(html, new RegExp(`@keyframes ${name}`), name);
  }
  assert.match(html, /prefers-reduced-motion: reduce\) \{ #appLoadingOverlay \* \{ animation: none !important; \} \}/);
  assert.match(app, /overlay\.classList\.add\("is-leaving"\)/);
});

test("saudação do Pulsinho volta a ser texto normal depois da animação", () => {
  assert.doesNotMatch(css, /@keyframes pulsinhoWord \{[^}]*blur/);
  assert.match(app, /if \(pulsinhoIntroState === "reveal"\) \{\s*pulsinhoIntroState = "done";/);
});

test("abrir/fechar nota não usa position:fixed no corpo (faixa vazia no iPhone)", () => {
  assert.match(app, /document\.documentElement\.classList\.add\("pn-scroll-locked"\)/);
  assert.doesNotMatch(app, /document\.body\.style\.position = "fixed"/);
  assert.match(app, /function repairViewportAfterOverlay\(\)/);
  assert.match(css, /html\.pn-scroll-locked, html\.pn-scroll-locked body \{ overflow: hidden; \}/);
});
