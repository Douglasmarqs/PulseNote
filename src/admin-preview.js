// ════════════════════════════════════════════════════════════════════
// PulseNote · Painel — prévia local com dados fictícios
// ────────────────────────────────────────────────────────────────────
// Só é carregado com ?designPreview=1 em localhost ou nas prévias do
// projeto (nunca no domínio oficial — ver admin.js). Responde no lugar do
// servidor com dados INVENTADOS e simula as ações em memória, para revisar
// cada tela e fluxo sem login. Nada aqui toca dados ou pagamentos reais.
// ════════════════════════════════════════════════════════════════════

const DAY = 86400000;
const now = Date.now();
const iso = (offsetDays = 0, hour = 12) => new Date(now - offsetDays * DAY + (hour - 12) * 3600000).toISOString();
const day = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(now + offsetDays * DAY));
let seed = 20261128;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (list) => list[Math.floor(rand() * list.length)];
const clone = (value) => JSON.parse(JSON.stringify(value));

const FIRST = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Felipe", "Gabriela", "Heitor", "Isabela", "João", "Karina", "Lucas", "Marina", "Nicolas", "Olívia", "Pedro", "Quésia", "Rafael", "Sofia", "Tiago", "Ursula", "Vitor", "Wesley", "Yasmin", "Zeca", "Beatriz", "Caio", "Débora", "Enzo", "Fernanda", "Gustavo", "Helena", "Igor", "Júlia", "Leonardo", "Manuela", "Otávio", "Paula", "Renata", "Samuel", "Talita", "Valentina", "William", "Luana", "Mateus", "Alice", "Davi", "Lorena"];
const LAST = ["Silva", "Souza", "Oliveira", "Santos", "Lima", "Costa", "Ferreira", "Almeida", "Ribeiro", "Carvalho", "Gomes", "Martins", "Araújo", "Barbosa", "Rocha", "Moura"];

const plans = [
  { id: "gratis", name: "Essencial", description: "Para organizar o dia a dia.", tagline: "Para organizar o dia a dia", priceCents: 0, billingInterval: "month", currency: "BRL", active: true, visibility: "public", accent: "slate", order: 10, highlight: false, badge: "", ctaLabel: "", trialDays: 0, yearlyPriceCents: null, stripePriceId: null, stripePriceIdYear: null, aiDailyLimit: 10,
    benefits: ["Planner, notas, finanças e metas", "Pulsinho com IA · 10 conversas/dia", "Backup e sincronização", "Lembretes no aparelho"],
    features: { whatsapp: false, aiParsing: false, reminders: true, autopilot: false, mediaRecognition: false, whatsappReminders: false, pushNotifications: true, pdfReports: false }, updatedAt: iso(12) },
  { id: "pro", name: "Pro", description: "Tudo para quem quer ir além.", tagline: "Tudo para quem quer ir além", priceCents: 2990, billingInterval: "month", currency: "BRL", active: true, visibility: "public", accent: "violet", order: 20, highlight: true, badge: "Mais popular", ctaLabel: "Assinar o Pro", trialDays: 7, yearlyPriceCents: 29900, stripePriceId: "price_demoPro", stripePriceIdYear: "price_demoProYear", aiDailyLimit: 200,
    benefits: ["Tudo do Essencial", "Pulsinho com IA · 200 conversas/dia", "Pulsinho no WhatsApp", "Lançamentos por foto, áudio e PDF", "Lembretes no WhatsApp", "Relatórios em PDF"],
    features: { whatsapp: true, aiParsing: true, reminders: true, autopilot: false, mediaRecognition: true, whatsappReminders: true, pushNotifications: true, pdfReports: true }, updatedAt: iso(3) },
  { id: "familia", name: "Família", description: "Finanças da casa, juntas.", tagline: "Finanças da casa, juntas", priceCents: 4990, billingInterval: "month", currency: "BRL", active: true, visibility: "public", accent: "green", order: 30, highlight: false, badge: "", ctaLabel: "", trialDays: 0, yearlyPriceCents: 47900, stripePriceId: "price_demoFam", stripePriceIdYear: null, aiDailyLimit: 0,
    benefits: ["Tudo do Pro", "Espaços financeiros compartilhados", "IA sem limite", "Pulse Autopilot", "Suporte prioritário"],
    features: { whatsapp: true, aiParsing: true, reminders: true, autopilot: true, mediaRecognition: true, whatsappReminders: true, pushNotifications: true, pdfReports: true }, updatedAt: iso(20) },
  { id: "parceria", name: "Parceria", description: "Cortesia para parceiros e criadores.", tagline: "Acesso cortesia", priceCents: 0, billingInterval: "month", currency: "BRL", active: true, visibility: "private", accent: "amber", order: 90, highlight: false, badge: "", ctaLabel: "", trialDays: 0, yearlyPriceCents: null, stripePriceId: null, stripePriceIdYear: null, aiDailyLimit: 0,
    benefits: ["Tudo do Família", "Acesso antecipado a novidades"],
    features: { whatsapp: true, aiParsing: true, reminders: true, autopilot: true, mediaRecognition: true, whatsappReminders: true, pushNotifications: true, pdfReports: true }, updatedAt: iso(40) },
];

// Usuários com situações variadas (plano, teste, vencido, pausado, gratuito).
const users = FIRST.map((first, index) => {
  const last = pick(LAST);
  const created = Math.round(2 + rand() * 170);
  const lastActive = rand() < 0.82 ? Math.round(rand() * Math.min(created, 25)) : null;
  const roll = rand();
  let planId = null, segment = "none", source = null, validUntil = null, status = "none", daysLeft = null;
  if (roll < 0.34) { planId = rand() < 0.75 ? "pro" : "familia"; segment = "plan"; source = rand() < 0.6 ? "stripe" : "manual"; status = "active"; if (source === "manual") { daysLeft = Math.round(rand() * 40); validUntil = day(daysLeft); } }
  else if (roll < 0.48) { planId = "pro"; segment = "trial"; source = "trial"; status = "active"; daysLeft = Math.round(rand() * 7); validUntil = day(daysLeft); }
  else if (roll < 0.55) { planId = "pro"; segment = rand() < 0.5 ? "expired" : "trial_ended"; source = segment === "trial_ended" ? "trial" : "manual"; status = "active"; daysLeft = -Math.round(1 + rand() * 20); validUntil = day(daysLeft); }
  else if (roll < 0.59) { planId = "pro"; segment = "paused"; source = "manual"; status = "paused"; }
  else if (roll < 0.61) { planId = "parceria"; segment = "plan"; source = "manual"; status = "active"; }
  const disabled = index === 17;
  return {
    uid: `demo-${String(index + 1).padStart(3, "0")}`,
    email: `${first.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}.${last.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}@exemplo.com`,
    displayName: `${first} ${last}`, photoURL: "", provider: rand() < 0.55 ? "google" : "email", emailVerified: rand() < 0.93, disabled,
    createdAt: iso(created, 9), lastSignInAt: lastActive === null ? iso(created, 10) : iso(lastActive, 20), lastActiveAt: lastActive === null ? null : iso(lastActive, 21),
    planId, planName: planId ? plans.find((plan) => plan.id === planId)?.name : null, status, source, validUntil,
    segment: disabled ? "disabled" : segment, daysLeft, pending: { count: 0, cents: 0 }, admin: index === 0,
  };
});
users[0].displayName = "Lucas Martins";
users[0].email = "lucas.martins@exemplo.com";

const charges = [];
const chargeFor = (user, cents, statusName, created, due, note, extra = {}) => charges.push({ id: `chg-${charges.length + 101}`, uid: user.uid, email: user.email, amountCents: cents, status: statusName, createdAt: iso(created), dueDate: due, note, source: "manual", ...extra });
users.slice(2, 26).forEach((user, index) => {
  if (index % 3 === 0) chargeFor(user, 2990, "manual_pending", index % 5, day(index % 4 === 0 ? -3 : 5 + index), "Plano Pro · dezembro", { planId: "pro", grantDays: 30 });
  else if (index % 3 === 1) chargeFor(user, index % 2 ? 4990 : 2990, rand() < 0.85 ? "paid" : "manual_received", 3 + index, day(-index), index % 2 ? "Plano Família · novembro" : "Plano Pro · novembro", { paidAt: iso(2 + index), provider: "stripe" });
  else if (index === 5) chargeFor(user, 1990, "manual_cancelled", 22, day(-15), "Cobrança avulsa · consultoria");
});
for (const charge of charges) if (charge.status === "manual_pending") { const u = users.find((item) => item.uid === charge.uid); u.pending = { count: u.pending.count + 1, cents: u.pending.cents + charge.amountCents }; }

const config = {
  features: { whatsapp: true, aiParsing: true, reminders: true, autopilot: true, mediaRecognition: true, whatsappReminders: true, pushNotifications: true, pdfReports: true },
  maintenance: { enabled: false, message: "Estamos melhorando o PulseNote. Voltamos já!", eta: "", allowAdmins: true, startedAt: "" },
  access: { noPlan: "plan", noPlanPlanId: "gratis" },
  trial: { enabled: true, planId: "pro", days: 7, enabledAt: iso(30) },
  payment: { pixKey: "financeiro@pulsenote.example", pixHolder: "PulseNote Tecnologia", instructions: "Envie o comprovante pelo WhatsApp do suporte." },
  supportEmail: "suporte@pulsenote.example",
};

const admins = [
  { uid: "demo-001", email: "lucas.martins@exemplo.com", displayName: "Lucas Martins", owner: true, role: "owner", roleLabel: "Proprietário", source: "environment" },
  { uid: "demo-adm-2", email: "marina.financeiro@exemplo.com", displayName: "Marina Rocha", owner: false, role: "finance", roleLabel: "Financeiro", source: "firestore", lastSignInAt: iso(1, 15) },
  { uid: "demo-adm-3", email: "suporte.caio@exemplo.com", displayName: "Caio Lima", owner: false, role: "support", roleLabel: "Suporte", source: "firestore", lastSignInAt: iso(4, 11) },
];

const audit = [
  ["plan_saved", "pro", { planId: "pro" }, 0.08], ["access_trial", "", { email: users[5].email, planId: "pro" }, 0.3], ["manual_charge_created", "", { email: users[8].email }, 0.9],
  ["manual_charge_updated", "", { email: users[11].email, status: "manual_received" }, 1.2], ["access_extend", "", { email: users[3].email, validUntil: day(30) }, 2.1],
  ["config_updated", "global", {}, 3.4], ["admin_access_granted", "", { email: "suporte.caio@exemplo.com" }, 4], ["access_assign", "", { email: users[14].email, planId: "familia" }, 5.5],
  ["plans_reordered", "plans", {}, 6], ["maintenance_disabled", "global", {}, 9], ["maintenance_enabled", "global", {}, 9.1], ["user_disabled", "", { email: users[17].email }, 12],
].map(([action, target, details, ago], index) => ({ id: `aud-${index}`, at: iso(ago, 14), actorUid: index % 3 ? "demo-adm-2" : "demo-001", actorEmail: index % 3 ? "marina.financeiro@exemplo.com" : "lucas.martins@exemplo.com", action, target, details }));

function segments() {
  const count = (fn) => users.filter(fn).length;
  const pending = charges.filter((charge) => charge.status === "manual_pending");
  return {
    plan: count((u) => u.segment === "plan"), trial: count((u) => u.segment === "trial"), none: count((u) => u.segment === "none"),
    paused: count((u) => ["paused", "cancelled"].includes(u.segment)), expired: count((u) => ["expired", "trial_ended"].includes(u.segment)),
    disabled: count((u) => u.segment === "disabled"),
    expiringSoon: count((u) => u.segment === "plan" && u.daysLeft !== null && u.daysLeft <= 7),
    trialEndingSoon: count((u) => u.segment === "trial" && u.daysLeft !== null && u.daysLeft <= 3),
    pendingCharges: pending.length, pendingCents: pending.reduce((sum, c) => sum + c.amountCents, 0),
    overdueCharges: pending.filter((c) => c.dueDate && c.dueDate < day(0)).length,
  };
}

const integrations = {
  integrations: [
    { id: "firebase", label: "Firebase", configured: true, detail: "Credenciais do servidor" },
    { id: "whatsapp", label: "WhatsApp", configured: true, detail: "Webhook ativo", lastEventAt: iso(0.02), recentFailures: 1 },
    { id: "gemini", label: "Gemini", configured: true, detail: "Interpretação de texto" },
    { id: "ai-gateway", label: "Pulsinho GPT / Claude", configured: true, detail: "Modelos OpenAI e Anthropic configurados via Vercel AI Gateway" },
    { id: "qstash", label: "QStash / lembretes", configured: true, detail: "Execução a cada 5 min", lastRunAt: iso(0.004), runStatus: "ok" },
    { id: "stripe", label: "Stripe Billing", configured: false, detail: "Defina STRIPE_SECRET_KEY e STRIPE_WEBHOOK_SECRET na Vercel para ativar cobranças automáticas" },
  ],
  reminderDeliveries: users.slice(0, 7).map((user, index) => ({ id: `rd${index}`, uid: user.uid, channel: index % 3 ? "whatsapp" : "push", notificationKey: ["Pagar boleto da internet", "Reunião às 15h", "Meta de economia", "Tomar remédio", "Revisar orçamento", "Aniversário da Ana", "Fatura do cartão"][index], status: index === 4 ? "failed" : "accepted", attemptedAt: iso(index * 0.1), providerStatus: index === 4 ? "failed" : ["delivered", "read", "sent"][index % 3], providerUpdatedAt: iso(index * 0.1), error: index === 4 ? "Número sem WhatsApp" : null })),
  note: "Prévia local: integrações e entregas fictícias.",
};

function dashboard() {
  const accountsByDay = Array.from({ length: 90 }, (_, index) => {
    const offset = 89 - index;
    return { date: day(-offset), total: users.filter((u) => new Date(u.createdAt).getTime() <= now - offset * DAY).length };
  });
  const lastAccessByDay = Array.from({ length: 30 }, (_, index) => {
    const offset = 29 - index;
    return { date: day(-offset), users: users.filter((u) => u.lastActiveAt && Math.round((now - new Date(u.lastActiveAt).getTime()) / DAY) === offset).length };
  });
  const active = users.filter((u) => ["plan"].includes(u.segment) && u.planId);
  const byPlan = new Map();
  for (const user of active) byPlan.set(user.planId, (byPlan.get(user.planId) || 0) + 1);
  const planBreakdown = [...byPlan.entries()].map(([planId, count]) => { const plan = plans.find((p) => p.id === planId); return { planId, name: plan?.name || planId, count, monthlyCents: plan?.priceCents || 0 }; }).sort((a, b) => b.count - a.count);
  const paid = charges.filter((c) => ["paid", "manual_received"].includes(c.status));
  const since = now - 30 * DAY;
  return {
    periodDays: 30, segments: segments(),
    metrics: { users: users.length, activeUsers30d: users.filter((u) => u.lastActiveAt && new Date(u.lastActiveAt).getTime() >= since).length, activeSubscriptions: active.length,
      revenueCents30d: paid.filter((c) => new Date(c.createdAt).getTime() >= since).reduce((s, c) => s + c.amountCents, 0), revenuePrevCents30d: 21890,
      integrationsHealthy: 5, integrationsTotal: 6, usersWithSavedChanges30d: 31, whatsappReceived30d: 1284, reminderDeliveriesAccepted30d: 642,
      newUsers30d: users.filter((u) => new Date(u.createdAt).getTime() >= since).length, newUsersPrev30d: 9,
      mrrCents: planBreakdown.reduce((s, item) => s + item.count * item.monthlyCents, 0), totalTasks: 1830, totalNotes: 744, totalFinances: 3920, totalEvents: 512 },
    lastAccessByDay, accountsByDay, planBreakdown,
    integrations: integrations.integrations.map(({ id, label, configured }) => ({ id, label, configured })),
    journey: { accounts: users.length, savedData: 41, whatsappLinked: 23, remindersConfigured: 29, planAssigned: active.length },
    usageFlow: { trackedUsers: 39, topAreas: [{ key: "dashboard", count: 1820 }, { key: "finances", count: 1340 }, { key: "planner", count: 1102 }, { key: "notes", count: 760 }, { key: "settings", count: 210 }, { key: "profile", count: 168 }],
      topTransitions: [{ key: "dashboard>finances", count: 640 }, { key: "dashboard>planner", count: 512 }, { key: "planner>notes", count: 240 }] },
    recentAudit: audit.slice(0, 6),
  };
}

function subscribersFor(planId) {
  return { active: users.filter((u) => u.planId === planId && u.segment === "plan").length, trial: users.filter((u) => u.planId === planId && u.segment === "trial").length };
}
const sortedPlans = () => [...plans].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.priceCents - b.priceCents);
const fail = (code, status = 400) => { const error = new Error(code); error.status = status; throw error; };

export async function previewRequest(action, body, query = {}) {
  await new Promise((resolve) => setTimeout(resolve, 120 + Math.round(rand() * 160)));
  switch (action) {
    case "dashboard": return clone(dashboard());
    case "me": return { isAdmin: true, isOwner: true, uid: "demo-001", email: users[0].email, role: "owner", roleLabel: "Proprietário", permissions: ["view", "users.access", "users.status", "plans.manage", "charges.manage", "config.manage", "admins.manage"] };
    case "directory": return { users: clone(users), today: day(0), truncated: false };
    case "plans": return { plans: clone(sortedPlans().map((plan) => ({ ...plan, subscribers: subscribersFor(plan.id) }))) };
    case "settings": case "features": return { config: clone(config) };
    case "charges": return { charges: clone([...charges].sort((a, b) => b.createdAt.localeCompare(a.createdAt))), stripeConfigured: false };
    case "integrations": return clone(integrations);
    case "audit": return { events: clone(audit) };
    case "admins": return { admins: clone(admins), isOwner: true };
    case "user-detail": {
      const user = users.find((u) => u.uid === query.uid) || fail("user_not_found", 404);
      return { user: clone(user), entitlement: user.planId ? { planId: user.planId, status: user.status, source: user.source, validUntil: user.validUntil } : null,
        activity: { tasks: Math.round(rand() * 90), notes: Math.round(rand() * 40), events: Math.round(rand() * 25), goals: Math.round(rand() * 6), finances: Math.round(rand() * 160) },
        whatsappLinked: rand() < 0.5, whatsappReminderEnabled: rand() < 0.4, pushEnabled: rand() < 0.6, lastActiveAt: user.lastActiveAt, lastArea: pick(["dashboard", "finances", "planner", "notes"]),
        aiToday: Math.round(rand() * 12), charges: clone(charges.filter((c) => c.uid === user.uid)) };
    }
    case "plan-save": {
      const existing = plans.find((p) => p.id === body.id);
      const next = { ...(existing || {}), ...clone(body), currency: "BRL", updatedAt: new Date().toISOString() };
      if (existing) Object.assign(existing, next); else plans.push(next);
      audit.unshift({ id: `aud-${audit.length}`, at: new Date().toISOString(), actorEmail: users[0].email, action: "plan_saved", target: body.id, details: {} });
      return { plan: clone(next) };
    }
    case "plan-order": {
      (body.ids || []).forEach((id, index) => { const plan = plans.find((p) => p.id === id); if (plan) plan.order = (index + 1) * 10; });
      audit.unshift({ id: `aud-${audit.length}`, at: new Date().toISOString(), actorEmail: users[0].email, action: "plans_reordered", target: "plans", details: {} });
      return { order: body.ids.map((id, index) => ({ id, order: (index + 1) * 10 })) };
    }
    case "access-apply": {
      const applied = [];
      for (const uid of body.uids || []) {
        const user = users.find((u) => u.uid === uid);
        if (!user) continue;
        if (body.op === "assign") Object.assign(user, { planId: body.planId, planName: plans.find((p) => p.id === body.planId)?.name, segment: "plan", status: "active", source: "manual", validUntil: body.validUntil || null, daysLeft: null });
        if (body.op === "trial") Object.assign(user, { planId: body.planId, planName: plans.find((p) => p.id === body.planId)?.name, segment: "trial", status: "active", source: "trial", validUntil: day(body.days), daysLeft: body.days });
        if (body.op === "extend" && user.planId) { const left = Math.max(0, user.daysLeft || 0) + body.days; Object.assign(user, { validUntil: day(left), daysLeft: left, segment: user.source === "trial" ? "trial" : "plan" }); }
        if (body.op === "pause") Object.assign(user, { status: "paused", segment: "paused" });
        if (body.op === "resume") Object.assign(user, { status: "active", segment: "plan" });
        if (body.op === "remove") Object.assign(user, { planId: null, planName: null, segment: "none", status: "none", validUntil: null, daysLeft: null });
        applied.push(uid);
      }
      return { applied, skipped: [] };
    }
    case "charge-bulk": {
      const created = (body.uids || []).map((uid) => { const user = users.find((u) => u.uid === uid); const charge = { id: `chg-${charges.length + 101}`, uid, email: user?.email, amountCents: body.amountCents || plans.find((p) => p.id === body.planId)?.priceCents || 0, status: "manual_pending", createdAt: new Date().toISOString(), dueDate: body.dueDate, note: body.note || "Cobrança PulseNote", planId: body.planId || null, grantDays: body.grantDays || null, source: "manual" }; charges.unshift(charge); if (user) user.pending = { count: user.pending.count + 1, cents: user.pending.cents + charge.amountCents }; return { id: charge.id, uid }; });
      return { created, skipped: [] };
    }
    case "charge-update": {
      const charge = charges.find((c) => c.id === body.id) || fail("charge_not_found", 404);
      charge.status = body.status;
      const user = users.find((u) => u.uid === charge.uid);
      if (user) user.pending = { count: Math.max(0, user.pending.count - 1), cents: Math.max(0, user.pending.cents - charge.amountCents) };
      return { id: charge.id, status: charge.status, granted: body.status === "manual_received" && charge.planId ? { planId: charge.planId, validUntil: day(charge.grantDays || 30) } : null };
    }
    case "config-update": {
      for (const key of Object.keys(body || {})) config[key] = { ...(config[key] || {}), ...clone(body[key]) };
      if (body.maintenance) config.maintenance.startedAt = body.maintenance.enabled ? new Date().toISOString() : "";
      return { config: clone(config) };
    }
    case "user-update": { const user = users.find((u) => u.uid === body.uid); if (user) { user.disabled = body.disabled; user.segment = body.disabled ? "disabled" : (user.planId ? "plan" : "none"); } return { ok: true }; }
    case "admin-role-set": {
      if (body.enabled === false) { const index = admins.findIndex((a) => a.uid === body.uid); if (index >= 0) admins.splice(index, 1); }
      else if (body.email) admins.push({ uid: `demo-adm-${admins.length + 2}`, email: body.email, displayName: "", owner: false, role: body.role, source: "firestore", lastSignInAt: null });
      else { const admin = admins.find((a) => a.uid === body.uid); if (admin) admin.role = body.role; }
      return { ok: true };
    }
    default: return fail("unknown_action", 404);
  }
}

export const previewUser = {
  uid: "demo-001", email: "lucas.martins@exemplo.com", displayName: "Lucas Martins", emailVerified: true,
  getIdToken: async () => "preview",
};
