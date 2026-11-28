"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
// O projeto é CommonJS e o componente é ES: copia como .mjs e importa de lá.
let loaded = null;
const load = () => {
  if (!loaded) {
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pulsenote-plans-"));
    const file = path.join(dir, "plan-cards.mjs");
    fs.writeFileSync(file, fs.readFileSync(path.join(__dirname, "../src/plan-cards.js"), "utf8"));
    loaded = import(require("node:url").pathToFileURL(file).href);
  }
  return loaded;
};

const pro = { id: "pro", name: "Pro", priceCents: 2990, yearlyPriceCents: 29900, yearlySavingsPct: 17, billingInterval: "month", badge: "Mais popular", highlight: true, accent: "rose", trialDays: 7, benefits: ["IA sem limite"], checkoutAvailable: true, checkoutAvailableYear: false };

test("cartão do plano: preço mensal/anual, selo, destaque e teste grátis", async () => {
  const pc = await load();
  const monthly = pc.renderPlanCard(pro, { interval: "month" });
  assert.match(monthly, /class="pc-card pc-accent-rose is-highlight"/);
  assert.match(monthly, /Mais popular/);
  assert.match(monthly, /R\$\s?29,90/);
  assert.match(monthly, /7 dias grátis para testar/);
  const yearly = pc.planPriceView(pro, "year");
  assert.match(yearly.main, /24,92/);
  assert.match(yearly.note, /economize 17%/);
  // anual sem Price ID anual no Stripe: botão "Em breve" (nunca leva a um checkout quebrado)
  assert.match(pc.renderPlanCard(pro, { interval: "year" }), /disabled>Em breve</);
  assert.match(pc.renderPlanCard(pro, { interval: "year", preview: true }), /Assinar Pro|Assinar o Pro/, "na prévia do painel o botão aparece como o usuário verá depois de configurar");
  assert.match(pc.renderPlanCard(pro, { currentPlanId: "pro" }), /Seu plano atual/);
  assert.doesNotMatch(pc.renderPlanCard(pro, { trialEligible: false }), /dias grátis/, "quem já assinou não vê teste grátis");
});

test("textos do painel nunca viram HTML na vitrine", async () => {
  const pc = await load();
  const html = pc.renderPlanCards([{ ...pro, name: "<img src=x onerror=alert(1)>", badge: "\"><b>x</b>", benefits: ["<script>alert(1)</script>"], tagline: "<i>t</i>" }]);
  assert.doesNotMatch(html, /<img src=x|<script>|<b>x<\/b>|<i>t<\/i>/);
  assert.match(html, /&lt;script&gt;/);
});

test("sem vantagens escritas, a vitrine usa as do próprio plano; comparação e perguntas", async () => {
  const pc = await load();
  const benefits = pc.planBenefits({ priceCents: 0, features: { whatsapp: true } });
  assert.ok(benefits.includes("Pulsinho no WhatsApp"));
  assert.ok(benefits.some((b) => /10 conversas/.test(b)));
  assert.match(pc.renderComparison(pc.DEMO_PLANS), /Conversas com IA por dia/);
  assert.equal(pc.renderComparison([pro]), "", "comparação só com 2+ planos");
  assert.match(pc.renderIntervalToggle(pc.DEMO_PLANS, "year"), /aria-checked="true" class="is-on" data-plan-interval="year"/);
  assert.equal(pc.renderIntervalToggle([{ priceCents: 990 }]), "", "sem preço anual, sem alternância");
  assert.ok(pc.PLAN_FAQ.length >= 4);
});

test("app usa o componente na vitrine e na página Planos", () => {
  const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../src/index.html"), "utf8");
  assert.match(app, /from "\.\/plan-cards\.js"/);
  assert.match(app, /function openPlansSheet\(\)/);
  assert.match(app, /billingApi\("checkout", "POST", \{ planId, interval: billingView\.interval \}\)/);
  assert.match(html, /href="\/src\/plan-cards\.css\?v=\d+"/);
  assert.match(html, /id="billingCompareBtn"/);
  assert.match(html, /<button type="button" class="pfx-chip is-plan" id="profilePlanChip"/);
  assert.match(fs.readFileSync(path.join(__dirname, "../src/sw.js"), "utf8"), /"\/src\/plan-cards\.js"/);
});
