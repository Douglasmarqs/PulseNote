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

module.exports = { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_INCOME_CATEGORIES, buildCategoryList };
