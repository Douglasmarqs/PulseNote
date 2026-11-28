"use strict";

// ════════════════════════════════════════════════════════════════════
// Planos — regras únicas de validação e de exibição
// ────────────────────────────────────────────────────────────────────
// O mesmo módulo valida o que o painel salva (savePlan) e monta o que o
// app mostra na vitrine (publicBillingState). Assim o que o administrador
// vê na prévia é exatamente o que a pessoa vê para assinar.
// ════════════════════════════════════════════════════════════════════

const PLAN_ACCENTS = Object.freeze(["violet", "blue", "green", "amber", "rose", "slate"]);
const MAX_BENEFITS = 12;
const MAX_PRICE_CENTS = 100_000_000;
const STRIPE_PRICE_RE = /^price_[A-Za-z0-9]+$/;

function planError(code) {
  const error = new Error(code);
  error.status = 400;
  error.code = code;
  return error;
}

const clean = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

function optionalCents(value) {
  if (value === null || value === undefined || value === "") return null;
  const cents = Number(value);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_PRICE_CENTS) throw planError("invalid_plan_billing");
  return cents;
}

function optionalPriceId(value) {
  const id = clean(value, 128);
  if (id && !STRIPE_PRICE_RE.test(id)) throw planError("invalid_plan_billing");
  return id || null;
}

// Campos de vitrine e de venda (tudo opcional; padrões seguros).
function normalizeShowcase(body = {}, { billingInterval = "month" } = {}) {
  const benefits = Array.isArray(body.benefits) ? body.benefits : [];
  if (benefits.length > MAX_BENEFITS) throw planError("invalid_plan_showcase");
  const cleanBenefits = benefits.map((item) => clean(item, 90)).filter(Boolean);
  const accent = PLAN_ACCENTS.includes(body.accent) ? body.accent : "violet";
  const order = body.order === undefined || body.order === null || body.order === "" ? 100 : Number(body.order);
  if (!Number.isInteger(order) || order < 0 || order > 999) throw planError("invalid_plan_showcase");
  const trialDays = body.trialDays === undefined || body.trialDays === null || body.trialDays === "" ? 0 : Number(body.trialDays);
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 60) throw planError("invalid_plan_trial");
  // Preço anual alternativo só existe quando o preço principal é mensal.
  const yearlyPriceCents = billingInterval === "month" ? optionalCents(body.yearlyPriceCents) : null;
  const stripePriceIdYear = billingInterval === "month" && yearlyPriceCents ? optionalPriceId(body.stripePriceIdYear) : null;
  return {
    tagline: clean(body.tagline, 90),
    benefits: cleanBenefits,
    badge: clean(body.badge, 24),
    highlight: body.highlight === true,
    accent,
    ctaLabel: clean(body.ctaLabel, 28),
    order,
    trialDays,
    yearlyPriceCents: yearlyPriceCents || null,
    stripePriceIdYear,
  };
}

// Desconto do anual em relação a 12 meses do mensal (0 se não compensa).
function yearlySavingsPct(plan) {
  const monthly = Number(plan?.priceCents) || 0;
  const yearly = Number(plan?.yearlyPriceCents) || 0;
  if (!monthly || !yearly || plan?.billingInterval === "year") return 0;
  const full = monthly * 12;
  return yearly < full ? Math.round(((full - yearly) / full) * 100) : 0;
}

function sortPlans(list) {
  return [...list].sort((a, b) => (Number(a.order ?? 100) - Number(b.order ?? 100))
    || ((Number(a.priceCents) || 0) - (Number(b.priceCents) || 0))
    || String(a.name || a.id).localeCompare(String(b.name || b.id), "pt-BR"));
}

// O que o app recebe de cada plano (nada de IDs internos do Stripe).
function publicPlan(id, plan, { stripeReady = false } = {}) {
  const interval = plan.billingInterval === "year" ? "year" : "month";
  const yearlyPriceCents = interval === "month" && Number(plan.yearlyPriceCents) > 0 ? Number(plan.yearlyPriceCents) : null;
  return {
    id,
    name: plan.name || id,
    description: plan.description || "",
    tagline: plan.tagline || "",
    benefits: Array.isArray(plan.benefits) ? plan.benefits.filter((item) => typeof item === "string" && item.trim()).slice(0, MAX_BENEFITS) : [],
    badge: plan.badge || "",
    highlight: plan.highlight === true,
    accent: PLAN_ACCENTS.includes(plan.accent) ? plan.accent : "violet",
    ctaLabel: plan.ctaLabel || "",
    order: Number.isInteger(plan.order) ? plan.order : 100,
    priceCents: Number(plan.priceCents) || 0,
    yearlyPriceCents,
    yearlySavingsPct: yearlySavingsPct({ ...plan, billingInterval: interval }),
    currency: plan.currency || "BRL",
    billingInterval: interval,
    trialDays: Number.isInteger(plan.trialDays) ? plan.trialDays : 0,
    aiDailyLimit: Number.isInteger(plan.aiDailyLimit) ? plan.aiDailyLimit : null,
    features: plan.features || {},
    checkoutAvailable: Boolean(plan.stripePriceId && stripeReady),
    checkoutAvailableYear: Boolean(yearlyPriceCents && plan.stripePriceIdYear && stripeReady),
  };
}

// Nova ordem da vitrine: ids na sequência desejada (sem repetidos).
function normalizeOrder(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw planError("invalid_plan_order");
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== "string" || !/^[a-z0-9_-]{2,40}$/.test(id) || seen.has(id)) throw planError("invalid_plan_order");
    seen.add(id);
  }
  return ids.map((id, index) => ({ id, order: (index + 1) * 10 }));
}

module.exports = { PLAN_ACCENTS, MAX_BENEFITS, normalizeShowcase, publicPlan, sortPlans, yearlySavingsPct, normalizeOrder };
