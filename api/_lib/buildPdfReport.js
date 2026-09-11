// Relatório financeiro em PDF sem dependências externas.
// O WhatsApp aceita PDF diretamente, enquanto planilhas exigiam um fluxo
// separado e pouco útil no celular. Mantemos o documento propositalmente
// compacto para ficar legível tanto no WhatsApp quanto em leitores móveis.

function ascii(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?");
}

function escapePdf(value) {
  return ascii(value).replace(/([\\()])/g, "\\$1");
}

function formatCurrency(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
}

function wrapLine(value, width = 82) {
  const words = ascii(value).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word.slice(0, width);
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function buildReportLines({ monthLabel, isClosed, entries }) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const income = normalizedEntries
    .filter((entry) => entry.type === "receita")
    .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const expense = normalizedEntries
    .filter((entry) => entry.type !== "receita")
    .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
  const balance = income - expense;
  const categories = new Map();

  normalizedEntries
    .filter((entry) => entry.type !== "receita")
    .forEach((entry) => {
      const label = entry.categoryLabel || "Outros";
      categories.set(label, (categories.get(label) || 0) + (Number(entry.amount) || 0));
    });

  const lines = [
    "PULSENOTE - RELATORIO FINANCEIRO",
    `${monthLabel} | ${isClosed ? "Mes fechado" : "Mes em aberto"}`,
    "",
    `Receitas: ${formatCurrency(income)}`,
    `Despesas: ${formatCurrency(expense)}`,
    `Saldo: ${formatCurrency(balance)}`,
    `Lancamentos: ${normalizedEntries.length}`,
    "",
  ];

  if (categories.size) {
    lines.push("MAIORES CATEGORIAS DE DESPESA");
    [...categories.entries()]
      .sort(([, first], [, second]) => second - first)
      .slice(0, 5)
      .forEach(([label, amount]) => lines.push(`${label}: ${formatCurrency(amount)}`));
    lines.push("");
  }

  lines.push("LANCAMENTOS");
  normalizedEntries.forEach((entry) => {
    const prefix = entry.type === "receita" ? "+" : "-";
    const header = `${entry.date || "Sem data"} | ${prefix}${formatCurrency(entry.amount)} | ${entry.categoryLabel || "Outros"}`;
    lines.push(...wrapLine(header));
    lines.push(...wrapLine(`  ${entry.description || "Sem descricao"}`));
  });

  lines.push("", `Gerado em ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`);
  return lines;
}

function pdfStream(lines) {
  const commands = ["BT", "/F1 10 Tf", "50 800 Td", "14 TL"];
  lines.forEach((line) => {
    commands.push(`(${escapePdf(line)}) Tj`);
    commands.push("T*");
  });
  commands.push("ET");
  return commands.join("\n");
}

function buildPdfReportBuffer({ monthLabel, isClosed, entries }) {
  const lines = buildReportLines({ monthLabel, isClosed, entries });
  const pageLineCount = 42;
  const contentPages = [];
  for (let start = 0; start < lines.length; start += pageLineCount) {
    contentPages.push(lines.slice(start, start + pageLineCount));
  }
  if (!contentPages.length) contentPages.push([""]);
  const pages = contentPages.map((content, index) => [
    `PULSENOTE | ${monthLabel}`,
    "",
    ...content,
    "",
    `Pagina ${index + 1} de ${contentPages.length}`,
  ]);

  const pageObjects = pages.map((_, index) => 4 + index * 2);
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((page, index) => {
    const pageId = pageObjects[index];
    const contentId = pageId + 1;
    const stream = pdfStream(page);
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });

  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  let offset = parts[0].length;
  for (let id = 1; id <= objects.size; id++) {
    offsets[id] = offset;
    const object = Buffer.from(`${id} 0 obj\n${objects.get(id)}\nendobj\n`, "latin1");
    parts.push(object);
    offset += object.length;
  }

  const xrefOffset = offset;
  const xref = ["xref", `0 ${objects.size + 1}`, "0000000000 65535 f "];
  for (let id = 1; id <= objects.size; id++) {
    xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  }
  xref.push("trailer", `<< /Size ${objects.size + 1} /Root 1 0 R >>`, "startxref", String(xrefOffset), "%%EOF");
  parts.push(Buffer.from(`${xref.join("\n")}\n`, "latin1"));
  return Buffer.concat(parts);
}

module.exports = { buildPdfReportBuffer, buildReportLines };
