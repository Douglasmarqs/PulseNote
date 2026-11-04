function normalizeCommand(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function classifyPulseCommand(value) {
  const command = normalizeCommand(value);
  if (/\b(financ\w*|saldo|gasto\w*|despesa\w*|receita\w*|orcamento|fatura\w*|paguei|comprei|pix)\b/.test(command)) {
    return "finances";
  }
  if (/\b(planner|tarefa\w*|agenda|compromisso\w*|meta\w*|lembrete\w*|reuniao|consulta\w*)\b/.test(command)) {
    return "planner";
  }
  if (/\b(nota\w*|anotacao|anotacoes|checklist|ideia\w*)\b/.test(command)) {
    return "notes";
  }
  if (/\d/.test(command)) return "finances";
  return "autopilot";
}

