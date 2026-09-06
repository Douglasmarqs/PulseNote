// api/_lib/localTextFallback.js
// ============================================================
// Rede de segurança 100% local (zero chamada de IA) usada pelo
// parseCommandIntent.js quando o Gemini falha de vez (erro de rede/HTTP)
// OU responde mas deixa de preencher um campo crítico. O schema do
// parseCommandIntent só EXIGE "intent" no JSON de resposta — os demais
// campos ficam opcionais de propósito, pra um schema só dar conta de
// TODAS as intenções (expense, task_action, goal_action...). Isso é
// ótimo pra flexibilidade, mas abre uma brecha: numa resposta
// "preguiçosa" do modelo, o campo que a gente mais precisa (o valor de
// um gasto, o título de uma tarefa...) pode vir vazio, e sem essa rede
// de segurança a única saída era falhar com a mensagem genérica de
// "não entendi" — mesmo a pessoa tendo escrito uma frase perfeitamente
// compreensível.
//
// A heurística de valor/data/categoria abaixo espelha a MESMA lógica
// que o app já usa há tempos em parseFinanceText() (src/app.js) pro
// botão "✨ Lançar por texto" nunca travar quando a IA falha — trazida
// pro servidor pra dar a MESMA garantia de robustez às mensagens do
// WhatsApp (que antes dependiam 100% da IA, sem nenhum plano B).
// ============================================================

const FIN_CATEGORY_KEYWORDS = {
  alimentacao: ["almoço", "almoco", "jantar", "lanche", "restaurante", "comida", "ifood", "padaria", "café", "cafe", "pizza", "hambúrguer", "hamburguer", "churrasco", "marmita", "delivery", "açaí", "acai", "sorvete", "doces", "rappi", "padoca", "brunch", "sushi"],
  mercado: ["mercado", "supermercado", "feira", "hortifruti", "atacadão", "atacadao"],
  transporte: ["uber", "99", "ônibus", "onibus", "metro", "metrô", "táxi", "taxi", "passagem", "estacionamento", "pedágio", "pedagio"],
  combustivel: ["gasolina", "combustível", "combustivel", "posto", "álcool", "alcool", "etanol", "diesel"],
  manutencao: ["oficina", "mecânico", "mecanico", "manutenção do carro", "manutencao do carro", "reforma", "conserto", "encanador", "eletricista"],
  saude: ["farmácia", "farmacia", "remédio", "remedio", "médico", "medico", "consulta", "dentista", "plano de saúde", "plano de saude", "exame", "hospital", "psicólogo", "psicologo", "terapia", "fisioterapia", "óculos", "oculos", "vacina", "laboratório", "laboratorio"],
  academia: ["academia", "personal trainer", "crossfit", "pilates", "yoga", "musculação", "musculacao"],
  beleza: ["cabelo", "corte de cabelo", "cabeleireiro", "cabeleireira", "salão", "salao", "manicure", "pedicure", "barbearia", "barbeiro", "depilação", "depilacao", "estética", "estetica", "maquiagem", "sobrancelha", "unha", "skincare"],
  educacao: ["curso", "faculdade", "livro", "mensalidade escolar", "escola", "material escolar", "apostila", "aula", "udemy", "mensalidade da faculdade", "pós-graduação", "pos-graduacao"],
  lazer: ["cinema", "show", "bar", "balada", "streaming", "jogo", "passeio", "ingresso", "netflix", "parque"],
  eventos: ["festa", "aniversário", "aniversario", "casamento", "confraternização", "confraternizacao"],
  presentes: ["presente", "lembrancinha"],
  roupas: ["roupa", "calça", "calca", "camisa", "tênis", "tenis", "sapato", "blusa", "jaqueta", "acessório", "acessorio", "bolsa", "perfume"],
  tecnologia: ["celular", "notebook", "computador", "fone de ouvido", "carregador", "eletrônico", "eletronico"],
  moradia: ["aluguel", "condomínio", "condominio", "iptu"],
  contas: ["luz", "água", "agua", "internet", "gás", "gas", "conta de", "telefone", "tv a cabo", "wifi"],
  assinaturas: ["assinatura", "spotify", "amazon prime", "youtube premium", "mensalidade do", "disney+", "disney plus", "hbo max", "globoplay", "apple music", "icloud", "google one", "google fotos", "google photos", "chatgpt", "chat gpt", "openai", "uber one"],
  viagem: ["viagem", "hospedagem", "hotel", "pousada", "passagem aérea", "passagem aerea"],
  pet: ["ração", "racao", "veterinário", "veterinario", "petshop"],
  seguros: ["seguro do carro", "seguro residencial", "seguro de vida", "seguro"],
  impostos: ["ipva", "imposto de renda", "irpf", "imposto", "taxa"],
  doacoes: ["doação", "doacao", "dízimo", "dizimo"],
  familia: ["fralda", "escola do meu filho", "escolinha", "pediatra", "babá", "baba", "brinquedo", "mesada do filho", "berçário", "bercario"],
  investimentos_desp: ["tesouro direto", "aplicação", "aplicacao", "cdb", "poupança", "poupanca", "previdência privada", "previdencia privada"],
  emprestimos: ["empréstimo", "emprestimo", "parcela do empréstimo", "financiamento", "dívida", "divida", "cartão de crédito atrasado", "juros"],
  salario: ["salário", "salario", "contracheque", "pagamento do trabalho", "pagamento da empresa", "holerite"],
  freelance: ["freela", "freelance", "bico", "job extra", "trampo extra", "projeto extra"],
  investimentos: ["dividendo", "rendimento", "investimento", "ação", "acoes", "ações", "cdb", "tesouro direto", "fii", "fundo imobiliário", "fundo imobiliario"],
  vendas: ["venda", "vendi", "vendeu"],
  reembolso: ["reembolso", "ressarcimento", "devolução", "devolucao"],
  presente: ["presente", "bônus", "bonus", "mesada"],
  aluguel_receb: ["aluguel do inquilino", "recebi o aluguel", "aluguel recebido"],
  emprestimo_receb: ["me emprestaram", "empréstimo que peguei", "emprestimo que peguei", "dinheiro emprestado"],
  pensao: ["pensão", "pensao", "auxílio", "auxilio", "bolsa família", "bolsa familia"],
  premio: ["prêmio", "premio", "sorteio", "loteria", "aposta ganha"],
};

const FIN_INCOME_HINTS = ["recebi", "receb", "ganhei", "caiu", "depositaram", "pix recebido", "entrou", "salário", "salario", "venda", "vendi", "freela", "freelance", "bico", "reembolso", "presente", "bônus", "bonus", "dividendo", "rendimento"];

// Palavras "de ligação" sem valor descritivo, removidas ao montar a
// descrição final — mesma lista usada em parseFinanceText (src/app.js).
const FIN_FILLER_WORDS = [
  "gastei", "gasto", "gastando", "paguei", "pagamento", "pagando", "comprei", "compra", "comprando",
  "recebi", "receb", "ganhei", "ganhando", "pix", "transferência", "transferencia",
  "reais", "real", "r\\$", "de", "do", "da", "dos", "das", "no", "na", "nos", "nas", "em", "com", "pra", "para",
  "um", "uma", "uns", "umas", "o", "a", "os", "as", "e", "foi", "fui", "ao", "à", "esse", "essa", "isso",
];

const FIN_MONTH_NAMES = {
  janeiro: 0, fevereiro: 1, marco: 2, abril: 3, maio: 4, junho: 5,
  julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
};
const FIN_WEEKDAY_NAMES = {
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
};

function normalizeFinAmount(raw) {
  let s = raw.trim();
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    s = s.replace(",", ".");
  } else if (hasDot) {
    const parts = s.split(".");
    if (parts[parts.length - 1].length === 3) s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysIso(baseDate, delta) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + delta);
  return toIsoDate(d);
}

// Extrai uma referência de data relativa/explícita do texto e devolve
// { date, cleaned } — "cleaned" é o texto com o trecho de data já
// removido (útil pra não confundir número de data com valor em reais
// na hora de achar o amount). "date" vem null quando nada foi
// reconhecido (deixa o chamador decidir o default apropriado pro
// contexto — "hoje" pra lançamento financeiro, "" pra tarefa sem prazo,
// falha mesmo pra compromisso que exige data).
//
// "direction" resolve a AMBIGUIDADE de dia/mês sem ano explícito
// ("dia 1", "1 de setembro", "sexta") quando esse dia/mês já passou (ou
// ainda vai acontecer) dentro do ano/mês corrente:
//   - "future" (tarefas, compromissos): dia já passado -> assume a
//     PRÓXIMA ocorrência (mês/ano seguinte). Ex.: hoje=20/09, "dia 5" ->
//     05/10 (mês que vem), porque tarefa/compromisso são pro futuro.
//   - "past" (gastos/receitas, edição do último lançamento): dia ainda
//     não chegou este mês/ano -> assume a ocorrência ANTERIOR (mês/ano
//     passado), nunca empurra pra frente. Ex.: hoje=04/09, "1 de
//     setembro" -> 01/09 deste ano (já passou, fica); "dia 1" com hoje
//     sendo dia 20 -> 01/09 (mês corrente, já passou, fica) — só recua
//     pro mês/ano anterior se o dia AINDA não tiver chegado no atual.
//     Isso existia como intenção (ver extractPastDateIso/
//     extractFutureDateIso abaixo) mas nunca era de fato aplicado aqui —
//     por isso um gasto de "dia 1" ou "1 de setembro" podia sair
//     lançado no mês/ano SEGUINTE em vez do correto.
function extractDateAndClean(text, todayIso, direction = "future") {
  let working = String(text || "").toLowerCase();
  const today = new Date(`${todayIso}T12:00:00`);
  let date = null;

  if (/anteontem|ante-ontem|antes de ontem/.test(working)) {
    date = addDaysIso(today, -2);
    working = working.replace(/anteontem|ante-ontem|antes de ontem/g, " ");
  } else if (/\bontem\b/.test(working)) {
    date = addDaysIso(today, -1);
    working = working.replace(/\bontem\b/g, " ");
  } else if (/\bhoje\b/.test(working)) {
    date = todayIso;
    working = working.replace(/\bhoje\b/g, " ");
  } else if (/depois de amanh[ãa]/.test(working)) {
    date = addDaysIso(today, 2);
    working = working.replace(/depois de amanh[ãa]/g, " ");
  } else if (/\bamanh[ãa](?![a-zà-ÿ0-9_])/i.test(working)) {
    date = addDaysIso(today, 1);
    working = working.replace(/\bamanh[ãa](?![a-zà-ÿ0-9_])/gi, " ");
  } else if (/semana passada/.test(working)) {
    date = addDaysIso(today, -7);
    working = working.replace(/semana passada/g, " ");
  } else if (/(pr[óo]xima semana|semana que vem)/.test(working)) {
    date = addDaysIso(today, 7);
    working = working.replace(/(pr[óo]xima semana|semana que vem)/g, " ");
  } else {
    const daysAgoMatch =
      working.match(/(?:h[áa]|faz)\s*(\d+)\s*dias?\b/) ||
      working.match(/(\d+)\s*dias?\s*atr[áa]s/);
    if (daysAgoMatch) {
      date = addDaysIso(today, -parseInt(daysAgoMatch[1], 10));
      working = working.replace(daysAgoMatch[0], " ");
    } else {
      const explicitDate = working.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
      const monthNameMatch = !explicitDate &&
        working.match(/\b(\d{1,2})\s*(?:de\s*)?(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/);
      const weekdayMatch = !explicitDate && !monthNameMatch &&
        working.match(/\b(domingo|segunda(?:-feira)?|ter[çc]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[áa]bado)\b/);
      const dayOnlyMatch = !explicitDate && !monthNameMatch && !weekdayMatch &&
        working.match(/\bdia\s*(\d{1,2})\b/);

      if (explicitDate) {
        const day = parseInt(explicitDate[1], 10);
        const month = parseInt(explicitDate[2], 10) - 1;
        const hasExplicitYear = !!explicitDate[3];
        let year = hasExplicitYear ? parseInt(explicitDate[3], 10) : today.getFullYear();
        if (year < 100) year += 2000;
        let d = new Date(year, month, day);
        if (!hasExplicitYear && !isNaN(d)) {
          if (direction === "future" && d < today) d = new Date(year + 1, month, day);
          else if (direction === "past" && d > today) d = new Date(year - 1, month, day);
        }
        if (!isNaN(d)) date = toIsoDate(d);
        working = working.replace(explicitDate[0], " ");
      } else if (monthNameMatch) {
        const day = parseInt(monthNameMatch[1], 10);
        const monthKeyName = monthNameMatch[2].replace("ç", "c");
        const month = FIN_MONTH_NAMES[monthKeyName];
        let d = new Date(today.getFullYear(), month, day);
        if (direction === "future" && d < today) d = new Date(today.getFullYear() + 1, month, day); // futuro mais próximo pra compromisso
        else if (direction === "past" && d > today) d = new Date(today.getFullYear() - 1, month, day); // passado mais próximo pra gasto/receita
        if (!isNaN(d)) date = toIsoDate(d);
        working = working.replace(monthNameMatch[0], " ");
      } else if (weekdayMatch) {
        const normalized = weekdayMatch[1].replace("-feira", "").replace("ç", "c").replace("á", "a");
        const targetDow = FIN_WEEKDAY_NAMES[normalized];
        if (targetDow !== undefined) {
          let diff = targetDow - today.getDay();
          if (direction === "future") { if (diff <= 0) diff += 7; } // próxima ocorrência (compromissos são pro futuro)
          else if (diff > 0) diff -= 7; // ocorrência mais recente já passada (gasto/receita são do passado)
          date = addDaysIso(today, diff);
        }
        working = working.replace(weekdayMatch[0], " ");
      } else if (dayOnlyMatch) {
        const day = parseInt(dayOnlyMatch[1], 10);
        if (day >= 1 && day <= 31) {
          let d = new Date(today.getFullYear(), today.getMonth(), day);
          if (direction === "future" && d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, day);
          else if (direction === "past" && d > today) d = new Date(today.getFullYear(), today.getMonth() - 1, day);
          if (!isNaN(d)) date = toIsoDate(d);
        }
        working = working.replace(dayOnlyMatch[0], " ");
      }
    }
  }

  return { date, cleaned: working };
}

// Versão "passado" da extração de data (lançamento financeiro — se nada
// bater, assume hoje, igual ao parseFinanceText original).
function extractPastDateIso(text, todayIso) {
  const { date } = extractDateAndClean(text, todayIso, "past");
  return date || todayIso;
}

// Versão "futuro" pra tarefas/compromissos (se nada bater, devolve null
// — cabe ao chamador decidir: tarefa sem prazo vira "", compromisso sem
// data reconhecida realmente não dá pra completar).
function extractFutureDateIso(text, todayIso) {
  const { date } = extractDateAndClean(text, todayIso, "future");
  return date;
}

// Devolve a data reconhecida no texto (ISO) ou null se nenhum padrão
// bateu — usada pra decidir se a extração LOCAL deve ter prioridade
// sobre a data que a IA devolveu. Datas relativas ("ontem", "amanhã",
// "sexta", "dia 12"...) são cálculo mecânico, e regex acerta isso de
// forma determinística; um modelo de linguagem pode errar a conta
// (ex.: entender "ontem" mas devolver a data de hoje) — por isso, quando
// o texto tem uma referência de data reconhecível, ela vence a da IA.
// "direction" precisa ser passado pelo chamador ("past" pra gasto/edição
// de lançamento, "future" pra tarefa/compromisso) — ver comentário em
// extractDateAndClean.
function detectDate(text, todayIso, direction = "future") {
  return extractDateAndClean(text, todayIso, direction).date;
}

// Reconhece horário mencionado no texto ("às 15h", "15:30", "meio-dia",
// "9h", "9 da manhã"...) e devolve no formato "HH:MM", ou null se nada
// bateu. Mesma lógica do detectDate: cálculo mecânico, regex é mais
// confiável que a IA "lembrar" de converter certo.
function extractTimeFromText(text) {
  const working = String(text || "").toLowerCase();

  if (/meio[\s-]?dia/.test(working)) return "12:00";
  if (/meia[\s-]?noite/.test(working)) return "00:00";

  const hm = working.match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (hm) {
    const h = Math.min(23, parseInt(hm[1], 10));
    const m = Math.min(59, parseInt(hm[2], 10));
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  const hOnly = working.match(/\b(?:às|as|a partir das|a partir de)\s*(\d{1,2})\s*h(?:oras)?\b/) ||
    working.match(/\b(\d{1,2})\s*h(?:oras)?\b/) ||
    working.match(/\b(?:às|as)\s*(\d{1,2})\b(?!\s*\/|\s*de\s)/);
  if (hOnly) {
    const h = parseInt(hOnly[1], 10);
    if (h >= 0 && h <= 23) return `${String(h).padStart(2, "0")}:00`;
  }
  return null;
}

function extractAmountFromText(text) {
  const working = extractDateAndClean(text, new Date().toISOString().slice(0, 10)).cleaned;
  const moneyMatch =
    working.match(/r\$\s*([\d.,]+)/) ||
    working.match(/([\d.,]+)\s*(?:reais|real)\b/) ||
    working.match(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
  return moneyMatch ? normalizeFinAmount(moneyMatch[1]) : null;
}

function guessType(text) {
  const norm = String(text || "").toLowerCase();
  return FIN_INCOME_HINTS.some((kw) => norm.includes(kw)) ? "receita" : "despesa";
}

// categories: [{id, type, label}] — respeita categorias custom do
// usuário (casadas por palavra do próprio label), sempre priorizando a
// palavra-chave MAIS ESPECÍFICA (mais longa) encontrada no texto.
function guessCategoryId(text, type, categories) {
  const working = String(text || "").toLowerCase();
  let categoryId = type === "receita" ? "outros_receita" : "outros";
  let bestLen = 0;

  const validIds = new Set((categories || []).filter((c) => c.type === type).map((c) => c.id));
  for (const [id, keywords] of Object.entries(FIN_CATEGORY_KEYWORDS)) {
    if (!validIds.has(id)) continue; // só considera ids que o usuário realmente tem
    for (const kw of keywords) {
      if (kw.length > bestLen && working.includes(kw)) {
        categoryId = id;
        bestLen = kw.length;
      }
    }
  }
  // Categorias custom sem lista de sinônimos própria: casa por palavra do label.
  for (const cat of categories || []) {
    if (cat.type !== type) continue;
    const words = String(cat.label || "").replace(/^\S+\s*/, "").toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const w of words) {
      if (w.length > bestLen && working.includes(w)) {
        categoryId = cat.id;
        bestLen = w.length;
      }
    }
  }
  return categoryId;
}

// Remove palavras de data (ontem, hoje, amanhã, dia da semana...) de uma
// descrição já pronta — usada tanto na extração local quanto na
// descrição que a própria IA devolve, porque o modelo às vezes deixa a
// palavra de data solta na descrição mesmo já tendo preenchido o campo
// "date" corretamente (ex.: description "Uber ontem" + date certo).
function stripDateWordsFromDescription(text) {
  return String(text || "")
    .replace(/\b(hoje|ontem|anteontem|amanh[ãa])(?![a-zà-ÿ0-9_])/gi, " ")
    .replace(/\bdepois de amanh[ãa](?![a-zà-ÿ0-9_])/gi, " ")
    .replace(/\b(domingo|segunda(?:-feira)?|ter[çc]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[áa]bado)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[,.\-–—\s]+|[,.\-–—\s]+$/g, "");
}

function guessDescription(text, amountRaw) {
  let working = String(text || "").toLowerCase();
  if (amountRaw) working = working.replace(amountRaw, " ");
  working = stripDateWordsFromDescription(working);
  const words = working
    .replace(/[.,;!?]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FIN_FILLER_WORDS.includes(w));
  const desc = words.join(" ").trim();
  if (!desc) return "";
  return desc.charAt(0).toUpperCase() + desc.slice(1, 60);
}

// Última rede de segurança pra um "lançamento financeiro por texto":
// tenta montar um entry válido só com regex, sem IA nenhuma. Devolve
// null quando nem um valor em reais dá pra achar (nesse caso não tem
// mesmo o que recuperar, e a mensagem de "não entendi" é legítima).
function localExpenseFallback({ text, categories, todayIso }) {
  const amount = extractAmountFromText(text);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const type = guessType(text);
  const categoryId = guessCategoryId(text, type, categories);
  const date = extractPastDateIso(text, todayIso);
  const amountMatch =
    text.match(/r\$\s*[\d.,]+/i) ||
    text.match(/[\d.,]+\s*(?:reais|real)\b/i) ||
    text.match(/\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?/);
  const description = guessDescription(text, amountMatch ? amountMatch[0] : null) || (type === "receita" ? "Recebimento" : "Gasto");

  return { type, amount, categoryId, description, date };
}

// Remove a primeira frase de comando reconhecida ("cria uma tarefa
// pra", "me lembra de", "marca reunião com"...) do início do texto,
// deixando só o "miolo" que interessa como título/consulta. Usado como
// ÚLTIMO recurso quando a IA classificou a intenção certa mas não
// preencheu o campo de texto livre correspondente (título, consulta de
// busca etc.) — nunca deixa o campo vazio: se nenhum padrão bater,
// devolve o texto original (melhor um título "cru" do que falhar).
function stripKnownTriggers(text, patterns) {
  const original = String(text || "").trim();
  for (const re of patterns) {
    const m = original.match(re);
    if (m && m[0].length < original.length) {
      const rest = original.slice(m[0].length).trim().replace(/^[:\-–—]\s*/, "");
      if (rest) return rest;
    }
  }
  return original;
}

const TASK_CREATE_TRIGGERS = [
  /^\s*(me\s+)?lembr[ae]r?\s+de\s+/i,
  /^\s*cria[r]?\s+(uma\s+)?tarefa\s*(pra|para|de)?\s*/i,
  /^\s*adiciona[r]?\s+(uma\s+)?tarefa\s*(pra|para|de)?\s*/i,
  /^\s*nova\s+tarefa\s*[:\-–—]?\s*/i,
  /^\s*tarefa\s*[:\-–—]?\s*/i,
];

// Pra concluir/apagar uma tarefa já existente ("concluí a tarefa do
// dentista", "apaga a tarefa de comprar ração") — frases de comando bem
// diferentes das de CRIAR uma tarefa nova, então reaproveitar
// TASK_CREATE_TRIGGERS aqui não batia com nada e deixava o comando
// inteiro (verbo incluso) como "alvo" da busca por tarefa.
const TASK_COMPLETE_DELETE_TRIGGERS = [
  /^\s*conclu[íi][r]?\s+(a\s+)?tarefa\s*(de|do|da)?\s*/i,
  /^\s*termin[ei][i]?\s+(a\s+)?tarefa\s*(de|do|da)?\s*/i,
  /^\s*finaliz[ei][i]?\s+(a\s+)?tarefa\s*(de|do|da)?\s*/i,
  /^\s*marca[r]?\s+(a\s+)?tarefa\s*(de|do|da)?\s*(como\s+(feita|conclu[íi]da))?\s*/i,
  /^\s*apag[ae][i]?[r]?\s+(a\s+)?tarefa\s*(de|do|da)?\s*/i,
  /^\s*exclu[íi][i]?[r]?\s+(a\s+)?tarefa\s*(de|do|da)?\s*/i,
  /^\s*deleta[r]?\s+(a\s+)?tarefa\s*(de|do|da)?\s*/i,
  /^\s*remov[ei][i]?[r]?\s+(a\s+)?tarefa\s*(de|do|da)?\s*/i,
];

const GOAL_CREATE_TRIGGERS = [
  /^\s*cria[r]?\s+(uma\s+)?meta\s*(de|pra|para)?\s*/i,
  /^\s*nova\s+meta\s*[:\-–—]?\s*/i,
  /^\s*meta\s*[:\-–—]?\s*/i,
];

// Pra ATUALIZAR o progresso de uma meta já existente ("avancei 200 na
// minha meta de economia", "minha meta de ler livros já bateu 3") —
// mesmo problema do task_action acima: GOAL_CREATE_TRIGGERS só reconhece
// frase de CRIAR meta nova, não de progresso, então nada era cortado e o
// "avancei 200 na minha meta de" inteiro virava ruído na busca pela
// meta certa.
const GOAL_UPDATE_TRIGGERS = [
  /^\s*avanc[ei][i]?\s+[\d.,]+\s*(na|no|em)?\s*(minha\s+)?meta\s*(de)?\s*/i,
  /^\s*consegui\s+[\d.,]+\s*(na|no|em)?\s*(minha\s+)?meta\s*(de)?\s*/i,
  /^\s*atualiza[r]?\s+(a\s+)?(minha\s+)?meta\s*(de)?\s*/i,
  /^\s*(a\s+)?(minha\s+)?meta\s+de\s+/i,
];

const EVENT_CREATE_TRIGGERS = [
  /^\s*marca[r]?\s+(um[a]?\s+)?/i,
  /^\s*agenda[r]?\s+/i,
  /^\s*cria[r]?\s+(um[a]?\s+)?(compromisso|evento|reuni[ãa]o)\s*(com|de)?\s*/i,
];

const FINANCE_SEARCH_TRIGGERS = [
  /^\s*quanto\s+(eu\s+)?(gastei|recebi)\s+(com|em|de|no|na)?\s*/i,
  /^\s*busca[r]?\s+(meus\s+|minhas\s+)?(gastos|lan[çc]amentos)\s*(com|de|em)?\s*/i,
  /^\s*mostra[r]?\s+(os\s+)?(gastos|lan[çc]amentos)\s*(com|de|em)?\s*/i,
  /^\s*procura[r]?\s+(por\s+)?/i,
];

const NOTE_SEARCH_TRIGGERS = [
  /^\s*busca[r]?\s+(minhas\s+|as\s+)?notas?\s*(sobre|de)?\s*/i,
  /^\s*procura[r]?\s+(minhas\s+|as\s+)?notas?\s*(sobre|de)?\s*/i,
];

module.exports = {
  localExpenseFallback,
  extractAmountFromText,
  extractPastDateIso,
  extractFutureDateIso,
  detectDate,
  extractTimeFromText,
  stripDateWordsFromDescription,
  guessType,
  guessCategoryId,
  stripKnownTriggers,
  TASK_CREATE_TRIGGERS,
  TASK_COMPLETE_DELETE_TRIGGERS,
  GOAL_CREATE_TRIGGERS,
  GOAL_UPDATE_TRIGGERS,
  EVENT_CREATE_TRIGGERS,
  FINANCE_SEARCH_TRIGGERS,
  NOTE_SEARCH_TRIGGERS,
};
