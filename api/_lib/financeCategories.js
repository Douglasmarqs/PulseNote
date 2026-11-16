// api/_lib/financeCategories.js
// ============================================================
// Categorias padrão de finanças, compartilhadas pelo WhatsApp e pela
// conversa do Pulsinho no app. Espelham as categorias padrão de
// src/app.js (expenseCategories / incomeCategories): os ids que a IA
// escolhe precisam bater com os do app para os lançamentos aparecerem
// na categoria certa. Se você editar as categorias padrão no app, edite
// aqui também.
// ============================================================

const DEFAULT_EXPENSE_CATEGORIES = [
  { id: "moradia", label: "🏠 Moradia" },
  { id: "contas", label: "💡 Contas e Utilidades" },
  { id: "manutencao", label: "🔧 Manutenção e Reparos" },
  { id: "alimentacao", label: "🍔 Restaurante/Delivery" },
  { id: "mercado", label: "🛒 Mercado" },
  { id: "transporte", label: "🚗 Transporte" },
  { id: "combustivel", label: "⛽ Combustível" },
  { id: "saude", label: "💊 Saúde" },
  { id: "academia", label: "🏋️ Academia e Esportes" },
  { id: "beleza", label: "💅 Beleza e Cuidados pessoais" },
  { id: "educacao", label: "📚 Educação" },
  { id: "lazer", label: "🎬 Lazer" },
  { id: "eventos", label: "🎉 Festas e Eventos" },
  { id: "presentes", label: "🎁 Presentes" },
  { id: "roupas", label: "👗 Roupas e Acessórios" },
  { id: "tecnologia", label: "📱 Tecnologia e Eletrônicos" },
  { id: "assinaturas", label: "🔁 Assinaturas" },
  { id: "familia", label: "👶 Filhos e Família" },
  { id: "pet", label: "🐾 Pet" },
  { id: "viagem", label: "✈️ Viagem" },
  { id: "investimentos_desp", label: "💰 Investimentos e Poupança" },
  { id: "emprestimos", label: "🏦 Empréstimos e Dívidas" },
  { id: "impostos", label: "🧾 Impostos e Taxas" },
  { id: "seguros", label: "🛡️ Seguros" },
  { id: "doacoes", label: "🎗️ Doações" },
  { id: "outros", label: "📦 Outros" },
];

const DEFAULT_INCOME_CATEGORIES = [
  { id: "salario", label: "💼 Salário" },
  { id: "freelance", label: "💻 Freelance/Bico" },
  { id: "investimentos", label: "📈 Investimentos" },
  { id: "vendas", label: "🏷️ Vendas" },
  { id: "aluguel_receb", label: "🏠 Aluguel recebido" },
  { id: "reembolso", label: "↩️ Reembolso" },
  { id: "premio", label: "🏆 Prêmio/Sorte" },
  { id: "emprestimo_receb", label: "🤝 Empréstimo recebido" },
  { id: "pensao", label: "👨‍👩‍👧 Pensão/Auxílio" },
  { id: "presente", label: "🎁 Presente/Bônus" },
  { id: "outros_receita", label: "📦 Outros" },
];

// Lista única [{ id, type, label }] com as categorias padrão e as
// personalizadas da pessoa (state.customCategories).
function buildCategoryList(state) {
  const custom = Array.isArray(state?.customCategories) ? state.customCategories : [];
  const despesa = [
    ...DEFAULT_EXPENSE_CATEGORIES,
    ...custom.filter((c) => c && (c.type || "despesa") === "despesa"),
  ].map((c) => ({ id: c.id, type: "despesa", label: c.label }));
  const receita = [
    ...DEFAULT_INCOME_CATEGORIES,
    ...custom.filter((c) => c && c.type === "receita"),
  ].map((c) => ({ id: c.id, type: "receita", label: c.label }));
  return [...despesa, ...receita].filter((c) => c.id);
}

// ── Aprendizado pelo histórico ──────────────────────────────────
// "Padoca do Zé" lançada antes como Mercado volta a ser Mercado: a forma
// como a PESSOA já categorizou uma descrição vale mais que qualquer
// palpite (dicionário ou IA). Correções feitas no app entram no histórico
// e passam a valer na próxima vez.
const KEY_STOPWORDS = new Set(["de", "do", "da", "dos", "das", "no", "na", "nos", "nas", "em", "com", "o", "a", "os", "as", "e", "um", "uma", "pra", "para"]);

function descriptionKey(text) {
  return String(text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !KEY_STOPWORDS.has(word))
    .join(" ")
    .trim();
}

function learnedCategoryId(state, description, type, { categories } = {}) {
  const key = descriptionKey(description);
  if (key.length < 3) return "";
  const valid = new Set((categories || buildCategoryList(state)).filter((c) => c.type === type).map((c) => c.id));
  const scores = new Map();
  const finances = Array.isArray(state?.finances) ? state.finances.slice(0, 800) : [];
  finances.forEach((entry, index) => {
    if (!entry || entry.type !== type || !valid.has(entry.category) || /^outros/.test(entry.category)) return;
    const other = descriptionKey(entry.description);
    if (!other) return;
    const exact = other === key;
    const near = !exact && key.length >= 5 && other.length >= 5 && (other.startsWith(`${key} `) || key.startsWith(`${other} `));
    if (!exact && !near) return;
    // Mais peso para iguais e para os mais recentes (a última correção vale mais).
    const weight = (exact ? 2 : 1) * (index < 20 ? 1.5 : 1);
    scores.set(entry.category, (scores.get(entry.category) || 0) + weight);
  });
  let best = "";
  let bestScore = 0;
  for (const [id, score] of scores) if (score > bestScore) { best = id; bestScore = score; }
  return best;
}

// Resumo dos hábitos (descrição → categoria) para a IA imitar o jeito da
// pessoa de categorizar. Só pares com categoria específica.
function categoryHabits(state, limit = 30) {
  const seen = new Map();
  for (const entry of (Array.isArray(state?.finances) ? state.finances.slice(0, 600) : [])) {
    if (!entry?.description || !entry.category || /^outros/.test(entry.category)) continue;
    const key = descriptionKey(entry.description);
    if (!key || seen.has(`${entry.type}|${key}`)) continue;
    seen.set(`${entry.type}|${key}`, { descricao: String(entry.description).slice(0, 40), tipo: entry.type, categoria: entry.category });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

module.exports = { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES, buildCategoryList, learnedCategoryId, categoryHabits, descriptionKey };
