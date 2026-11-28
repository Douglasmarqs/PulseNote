// ════════════════════════════════════════════════════════════════════
// PulseNote · Vitrine de planos (componente compartilhado)
// ────────────────────────────────────────────────────────────────────
// O MESMO código desenha os cartões no app (Configurações → Plano e a
// página "Planos") e na prévia ao vivo do Estúdio de planos do painel.
// O administrador vê exatamente o que a pessoa vai ver para assinar.
// Sem dependências; todo texto vindo do painel passa por escape.
// ════════════════════════════════════════════════════════════════════

export const PLAN_FEATURE_LABELS = {
  whatsapp: "Pulsinho no WhatsApp",
  aiParsing: "Lançamentos com IA",
  mediaRecognition: "Leitura de fotos, áudios e PDF",
  reminders: "Lembretes inteligentes",
  whatsappReminders: "Lembretes no WhatsApp",
  pushNotifications: "Notificações no aparelho",
  autopilot: "Pulse Autopilot",
  pdfReports: "Relatórios em PDF",
};
const FEATURE_ORDER = ["whatsapp", "aiParsing", "mediaRecognition", "reminders", "whatsappReminders", "pushNotifications", "autopilot", "pdfReports"];

export const PLAN_ACCENTS = ["violet", "blue", "green", "amber", "rose", "slate"];

export const PLAN_FAQ = [
  ["Posso cancelar quando quiser?", "Sim. Você cancela em Configurações → Plano, sem multa. O acesso continua até o fim do período já pago."],
  ["Quais formas de pagamento?", "Cartão de crédito e Pix pelo checkout seguro do Stripe. O PulseNote nunca vê nem guarda o número do seu cartão."],
  ["O que acontece com meus dados se eu mudar de plano?", "Nada se perde. Notas, tarefas e finanças continuam suas em qualquer plano — só os recursos extras mudam."],
  ["Como funciona o teste grátis?", "Quando o plano oferece dias grátis, a cobrança só começa depois deles. O teste vale uma vez por conta."],
];

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (cents, { compact = false } = {}) => {
  const value = (Number(cents) || 0) / 100;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: compact && Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
};
const svg = (paths, cls = "pc-i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICON = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  dash: svg('<path d="M7 12h10"/>'),
  spark: svg('<path d="M10.5 3l1.8 5.2L17.5 10l-5.2 1.8L10.5 17l-1.8-5.2L3.5 10l5.2-1.8z"/>'),
  gift: svg('<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v8.5h14V12M12 8v12.5M12 8C10.5 4.2 7 4.3 7 6.3 7 8 12 8 12 8zM12 8c1.5-3.8 5-3.7 5-1.7C17 8 12 8 12 8z"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5v-3a3.5 3.5 0 017 0v3"/>'),
};

export function aiLimitText(plan) {
  if (Number.isInteger(plan?.aiDailyLimit)) return plan.aiDailyLimit === 0 ? "Pulsinho com IA sem limite" : `Pulsinho com IA · ${plan.aiDailyLimit} conversas/dia`;
  return (Number(plan?.priceCents) || 0) > 0 ? "Pulsinho com IA · 200 conversas/dia" : "Pulsinho com IA · 10 conversas/dia";
}

// Vantagens exibidas: as escritas no painel; sem elas, as do próprio plano.
export function planBenefits(plan) {
  const written = Array.isArray(plan?.benefits) ? plan.benefits.filter((item) => typeof item === "string" && item.trim()) : [];
  if (written.length) return written;
  const fromFeatures = FEATURE_ORDER.filter((key) => plan?.features?.[key]).map((key) => PLAN_FEATURE_LABELS[key]);
  return ["Planner, notas, finanças e metas", aiLimitText(plan), ...fromFeatures].slice(0, 7);
}

// Preço conforme o ciclo escolhido (anual mostra o valor por mês e o total).
export function planPriceView(plan, interval = "month") {
  const monthly = Number(plan?.priceCents) || 0;
  const yearly = Number(plan?.yearlyPriceCents) || 0;
  if (!monthly && !(interval === "year" && yearly)) return { main: "Grátis", suffix: "", note: "Para sempre, sem cartão", free: true };
  if (plan?.billingInterval === "year") return { main: money(monthly, { compact: true }), suffix: "/ano", note: `Equivale a ${money(Math.round(monthly / 12))} por mês`, yearly: true };
  if (interval === "year" && yearly) {
    const savings = Number(plan.yearlySavingsPct) || (monthly ? Math.max(0, Math.round(((monthly * 12 - yearly) / (monthly * 12)) * 100)) : 0);
    return { main: money(Math.round(yearly / 12)), suffix: "/mês", note: `${money(yearly, { compact: true })} cobrados por ano${savings ? ` · economize ${savings}%` : ""}`, savings, yearly: true };
  }
  return { main: money(monthly, { compact: true }), suffix: "/mês", note: yearly ? `ou ${money(yearly, { compact: true })} no plano anual` : "Cobrado todo mês · cancele quando quiser" };
}

export function maxYearlySavings(plans) {
  return Math.max(0, ...(plans || []).map((plan) => Number(plan.yearlySavingsPct) || 0));
}
export function hasYearlyOption(plans) {
  return (plans || []).some((plan) => plan.billingInterval !== "year" && Number(plan.yearlyPriceCents) > 0);
}

export function renderIntervalToggle(plans, interval = "month") {
  if (!hasYearlyOption(plans)) return "";
  const savings = maxYearlySavings(plans);
  return `<div class="pc-interval" role="radiogroup" aria-label="Ciclo de cobrança">
    <button type="button" role="radio" aria-checked="${interval === "month"}" class="${interval === "month" ? "is-on" : ""}" data-plan-interval="month">Mensal</button>
    <button type="button" role="radio" aria-checked="${interval === "year"}" class="${interval === "year" ? "is-on" : ""}" data-plan-interval="year">Anual${savings ? `<em>−${savings}%</em>` : ""}</button>
    <i class="pc-interval-pill" aria-hidden="true"></i>
  </div>`;
}

// Estado do botão de cada cartão.
function ctaFor(plan, { interval, currentPlanId, preview }) {
  const isCurrent = currentPlanId && currentPlanId === plan.id;
  if (isCurrent) return { label: "Seu plano atual", disabled: true, current: true };
  const free = !(Number(plan.priceCents) || 0) && !(interval === "year" && Number(plan.yearlyPriceCents));
  const custom = String(plan.ctaLabel || "").trim();
  if (free) return { label: custom || "Plano gratuito", disabled: !preview, free: true };
  const available = interval === "year" && plan.billingInterval !== "year" && Number(plan.yearlyPriceCents) ? plan.checkoutAvailableYear : plan.checkoutAvailable;
  if (!available && !preview) return { label: "Em breve", disabled: true };
  return { label: custom || `Assinar ${plan.name}`, disabled: false };
}

export function renderPlanCard(plan, options = {}) {
  const { interval = "month", trialEligible = true, preview = false } = options;
  const accent = PLAN_ACCENTS.includes(plan.accent) ? plan.accent : "violet";
  const price = planPriceView(plan, interval);
  const cta = ctaFor(plan, options);
  const trialDays = Number(plan.trialDays) || 0;
  const benefits = planBenefits(plan);
  const classes = ["pc-card", `pc-accent-${accent}`, plan.highlight ? "is-highlight" : "", cta.current ? "is-current" : "", preview && options.focusId === plan.id ? "is-focus" : ""].filter(Boolean).join(" ");
  return `<article class="${classes}" data-plan-card="${esc(plan.id)}">
    ${plan.badge ? `<span class="pc-badge">${ICON.spark}${esc(plan.badge)}</span>` : ""}
    <header class="pc-head">
      <span class="pc-dot" aria-hidden="true"></span>
      <h3 class="pc-name">${esc(plan.name || "Plano")}</h3>
      ${plan.tagline ? `<p class="pc-tagline">${esc(plan.tagline)}</p>` : plan.description ? `<p class="pc-tagline">${esc(plan.description)}</p>` : ""}
    </header>
    <div class="pc-price${price.free ? " is-free" : ""}">
      <strong>${esc(price.main)}</strong>${price.suffix ? `<span>${esc(price.suffix)}</span>` : ""}
    </div>
    <p class="pc-price-note">${esc(price.note)}</p>
    ${trialDays && trialEligible && !cta.current && !price.free ? `<span class="pc-trial">${ICON.gift}${trialDays} ${trialDays === 1 ? "dia" : "dias"} grátis para testar</span>` : ""}
    <button type="button" class="pc-cta${plan.highlight ? " is-primary" : ""}" data-plan-choose="${esc(plan.id)}" ${cta.disabled ? "disabled" : ""}>${cta.current ? ICON.check : ""}${esc(cta.label)}</button>
    <ul class="pc-benefits">${benefits.map((item) => `<li><span class="pc-tick">${ICON.check}</span><span>${esc(item)}</span></li>`).join("")}</ul>
  </article>`;
}

export function renderPlanCards(plans, options = {}) {
  const list = Array.isArray(plans) ? plans : [];
  if (!list.length) return `<div class="pc-empty">Nenhum plano disponível no momento.</div>`;
  return `<div class="pc-grid" data-count="${list.length}">${list.map((plan) => renderPlanCard(plan, options)).join("")}</div>`;
}

// Tabela de comparação (página "Planos").
export function renderComparison(plans) {
  const list = Array.isArray(plans) ? plans : [];
  if (list.length < 2) return "";
  const rows = [
    ["Planner, notas, finanças e metas", () => true],
    ["Conversas com IA por dia", (plan) => (Number.isInteger(plan.aiDailyLimit) ? (plan.aiDailyLimit === 0 ? "Sem limite" : String(plan.aiDailyLimit)) : (Number(plan.priceCents) || 0) > 0 ? "200" : "10")],
    ...FEATURE_ORDER.map((key) => [PLAN_FEATURE_LABELS[key], (plan) => plan.features?.[key] === true]),
  ];
  const cell = (value) => (value === true ? `<span class="pc-yes" aria-label="Incluído">${ICON.check}</span>` : value === false ? `<span class="pc-no" aria-label="Não incluído">${ICON.dash}</span>` : `<b>${esc(value)}</b>`);
  return `<div class="pc-compare-wrap"><table class="pc-compare">
    <thead><tr><th scope="col">Recursos</th>${list.map((plan) => `<th scope="col" class="pc-accent-${PLAN_ACCENTS.includes(plan.accent) ? plan.accent : "violet"}${plan.highlight ? " is-highlight" : ""}"><span class="pc-dot" aria-hidden="true"></span>${esc(plan.name)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(([label, read]) => `<tr><th scope="row">${esc(label)}</th>${list.map((plan) => `<td>${cell(read(plan))}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

export function renderFaq() {
  return `<div class="pc-faq">${PLAN_FAQ.map(([q, a]) => `<details><summary>${esc(q)}<i aria-hidden="true"></i></summary><p>${esc(a)}</p></details>`).join("")}</div>`;
}

// Dados de demonstração (prévia local do app e do painel — nunca reais).
export const DEMO_PLANS = [
  { id: "gratis", name: "Essencial", tagline: "Para organizar o dia a dia", priceCents: 0, billingInterval: "month", accent: "slate", order: 10,
    benefits: ["Planner, notas, finanças e metas", "Pulsinho com IA · 10 conversas/dia", "Backup e sincronização", "Lembretes no aparelho"],
    features: { reminders: true, pushNotifications: true }, aiDailyLimit: 10, checkoutAvailable: false },
  { id: "pro", name: "Pro", tagline: "Tudo para quem quer ir além", priceCents: 2990, yearlyPriceCents: 29900, yearlySavingsPct: 17, billingInterval: "month",
    badge: "Mais popular", highlight: true, accent: "violet", order: 20, trialDays: 7, ctaLabel: "Assinar o Pro",
    benefits: ["Tudo do Essencial", "Pulsinho com IA · 200 conversas/dia", "Pulsinho no WhatsApp", "Lançamentos por foto, áudio e PDF", "Lembretes no WhatsApp", "Relatórios em PDF"],
    features: { whatsapp: true, aiParsing: true, mediaRecognition: true, reminders: true, whatsappReminders: true, pushNotifications: true, pdfReports: true }, aiDailyLimit: 200, checkoutAvailable: true, checkoutAvailableYear: true },
  { id: "familia", name: "Família", tagline: "Finanças da casa, juntas", priceCents: 4990, yearlyPriceCents: 47900, yearlySavingsPct: 20, billingInterval: "month",
    accent: "green", order: 30,
    benefits: ["Tudo do Pro", "Espaços financeiros compartilhados", "IA sem limite", "Pulse Autopilot", "Suporte prioritário"],
    features: { whatsapp: true, aiParsing: true, mediaRecognition: true, reminders: true, whatsappReminders: true, pushNotifications: true, autopilot: true, pdfReports: true }, aiDailyLimit: 0, checkoutAvailable: true, checkoutAvailableYear: true },
];
