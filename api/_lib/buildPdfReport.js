// PDFs do PulseNote sem dependências externas (relatório financeiro e
// documento livre, enviados pelo WhatsApp).
//
// Desenhamos direto com os operadores do PDF: retângulos coloridos, texto
// em Helvetica/Helvetica-Bold com WinAnsiEncoding (acentos do português
// funcionam) e medição de largura pelas métricas da fonte — assim valores
// ficam alinhados à direita e descrições longas são cortadas com "…".

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Larguras (1/1000 em) dos caracteres ASCII 32..126 — métricas AFM padrão.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Caracteres fora do Latin-1 que o WinAnsi tem em 0x80–0x9F.
const WIN_ANSI = { "—": "\x97", "–": "\x96", "•": "\x95", "…": "\x85", "‘": "\x91", "’": "\x92", "“": "\x93", "”": "\x94", "€": "\x80", "−": "-", "→": "-", "✓": "v" };

function toWinAnsi(value) {
  let out = "";
  for (const ch of String(value ?? "").normalize("NFC")) {
    if (WIN_ANSI[ch]) { out += WIN_ANSI[ch]; continue; }
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += ch;
    else if (code === 9) out += " ";
    // Emojis e símbolos sem equivalente somem (não viram "?").
  }
  return out;
}

function charWidth(ch, bold) {
  const table = bold ? HELV_B : HELV;
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return table[code - 32];
  if (ch === "\x85" || ch === "\x97") return 1000;
  if (ch === "\x96") return 556;
  if (ch === "\x95") return 350;
  if (ch === "\xB7") return 278;
  // Letra acentuada: mesma largura da letra base.
  const base = ch.normalize("NFD")[0];
  const baseCode = base.charCodeAt(0);
  return baseCode >= 32 && baseCode <= 126 ? table[baseCode - 32] : 556;
}

function textWidth(text, size, bold = false) {
  let total = 0;
  for (const ch of toWinAnsi(text)) total += charWidth(ch, bold);
  return (total * size) / 1000;
}

function fitText(text, maxWidth, size, bold = false) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (textWidth(clean, size, bold) <= maxWidth) return clean;
  let out = clean;
  while (out.length > 1 && textWidth(`${out}…`, size, bold) > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function wrapText(text, maxWidth, size, bold = false) {
  const lines = [];
  for (const paragraph of String(text ?? "").split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (textWidth(next, size, bold) <= maxWidth) current = next;
      else {
        if (current) lines.push(current);
        current = textWidth(word, size, bold) <= maxWidth ? word : fitText(word, maxWidth, size, bold);
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function hex(color) {
  const c = String(color || "#000000").replace("#", "");
  const n = parseInt(c.length === 3 ? c.split("").map((x) => x + x).join("") : c, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" ");
}

function escapePdf(value) {
  return toWinAnsi(value).replace(/([\\()])/g, "\\$1");
}

// ── "Tela" simples com várias páginas ────────────────────────────
function createCanvas() {
  const pages = [];
  let ops = null;
  const api = {
    pages,
    addPage() { ops = []; pages.push(ops); return api; },
    rect(x, y, w, h, color) { ops.push(`${hex(color)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); return api; },
    roundRect(x, y, w, h, r, color) {
      const k = 0.5523 * r;
      const p = (n) => n.toFixed(2);
      ops.push(`${hex(color)} rg ${p(x + r)} ${p(y)} m ${p(x + w - r)} ${p(y)} l ${p(x + w - r + k)} ${p(y)} ${p(x + w)} ${p(y + r - k)} ${p(x + w)} ${p(y + r)} c ${p(x + w)} ${p(y + h - r)} l ${p(x + w)} ${p(y + h - r + k)} ${p(x + w - r + k)} ${p(y + h)} ${p(x + w - r)} ${p(y + h)} c ${p(x + r)} ${p(y + h)} l ${p(x + r - k)} ${p(y + h)} ${p(x)} ${p(y + h - r + k)} ${p(x)} ${p(y + h - r)} c ${p(x)} ${p(y + r)} l ${p(x)} ${p(y + r - k)} ${p(x + r - k)} ${p(y)} ${p(x + r)} ${p(y)} c f`);
      return api;
    },
    polyline(points, color, width = 1) {
      const path = points.map(([px, py], i) => `${px.toFixed(2)} ${py.toFixed(2)} ${i ? "l" : "m"}`).join(" ");
      ops.push(`${hex(color)} RG ${width} w 1 J 1 j ${path} S`);
      return api;
    },
    line(x1, y1, x2, y2, color, width = 0.6) { ops.push(`${hex(color)} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); return api; },
    text(x, y, value, { size = 10, bold = false, color = "#141729", align = "left" } = {}) {
      const w = textWidth(value, size, bold);
      const tx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${hex(color)} rg ${tx.toFixed(2)} ${y.toFixed(2)} Td (${escapePdf(value)}) Tj ET`);
      return api;
    },
  };
  return api;
}

function serializePdf(pages, title = "PulseNote") {
  const objects = new Map();
  const pageIds = pages.map((_, index) => 6 + index * 2);
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.set(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  objects.set(5, `<< /Title (${escapePdf(title)}) /Producer (PulseNote) >>`);
  pages.forEach((ops, index) => {
    const pageId = pageIds[index];
    const stream = ops.join("\n");
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.set(pageId + 1, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });

  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let offset = parts[0].length;
  const total = Math.max(...objects.keys());
  for (let id = 1; id <= total; id++) {
    offsets[id] = offset;
    const object = Buffer.from(`${id} 0 obj\n${objects.get(id)}\nendobj\n`, "latin1");
    parts.push(object);
    offset += object.length;
  }
  const xref = ["xref", `0 ${total + 1}`, "0000000000 65535 f "];
  for (let id = 1; id <= total; id++) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  xref.push("trailer", `<< /Size ${total + 1} /Root 1 0 R /Info 5 0 R >>`, "startxref", String(offset), "%%EOF");
  parts.push(Buffer.from(`${xref.join("\n")}\n`, "latin1"));
  return Buffer.concat(parts);
}

// ── Utilidades de conteúdo ──────────────────────────────────────
const INK = "#141729";
const INK_2 = "#4a5068";
const INK_3 = "#8b90a7";
const LINE = "#e7e9f2";
const SOFT = "#f6f7fb";
const BRAND = "#5b4ff5";
const IN = "#059669";
const OUT = "#e11d48";
const PALETTE = ["#6d5efc", "#ec4899", "#38bdf8", "#f97316", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444"];

function formatCurrency(value) {
  const n = Number(value || 0);
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}` : "--/--";
}

function capitalize(text) {
  const s = String(text || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function generatedAt() {
  return new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// Cabeçalho escuro da primeira página.
function drawCover(c, { kicker, title, subtitle, badge }) {
  c.rect(0, PAGE_H - 150, PAGE_W, 150, "#1f1a52");
  c.rect(PAGE_W - 220, PAGE_H - 150, 220, 150, "#2b2470");
  c.rect(PAGE_W - 110, PAGE_H - 150, 110, 150, "#3a2fa0");
  c.roundRect(MARGIN, PAGE_H - 58, 24, 24, 6, "#7c6cff");
  // Traço de pulso do logo (mesmo desenho do ícone do app).
  const lx = MARGIN + 2;
  const ly = PAGE_H - 36;
  c.polyline([[3, 12], [7, 12], [9.5, 6], [13.5, 18], [16, 12], [21, 12]].map(([px, py]) => [lx + px * 0.84, ly - py * 0.84]), "#ffffff", 1.8);
  c.text(MARGIN + 32, PAGE_H - 50, "PulseNote", { size: 12, bold: true, color: "#ffffff" });
  if (badge) {
    const w = textWidth(badge, 8.5, true) + 18;
    c.roundRect(PAGE_W - MARGIN - w, PAGE_H - 57, w, 20, 10, "#4a3fc0");
    c.text(PAGE_W - MARGIN - w / 2, PAGE_H - 50.5, badge, { size: 8.5, bold: true, color: "#ffffff", align: "center" });
  }
  if (kicker) c.text(MARGIN, PAGE_H - 84, kicker.toUpperCase(), { size: 8, bold: true, color: "#a5b4fc" });
  c.text(MARGIN, PAGE_H - 110, fitText(title, CONTENT_W, 24, true), { size: 24, bold: true, color: "#ffffff" });
  if (subtitle) c.text(MARGIN, PAGE_H - 130, fitText(subtitle, CONTENT_W, 10), { size: 10, color: "#c7c9e8" });
}

function drawRunningHeader(c, label) {
  c.text(MARGIN, PAGE_H - 34, "PulseNote", { size: 9, bold: true, color: BRAND });
  c.text(PAGE_W - MARGIN, PAGE_H - 34, label, { size: 9, color: INK_3, align: "right" });
  c.line(MARGIN, PAGE_H - 44, PAGE_W - MARGIN, PAGE_H - 44, LINE);
}

function drawFooters(c, label) {
  const total = c.pages.length;
  c.pages.forEach((ops, index) => {
    const saved = ops;
    // Escreve no fim do fluxo de cada página.
    const tmp = createCanvas();
    tmp.addPage();
    tmp.line(MARGIN, 40, PAGE_W - MARGIN, 40, LINE);
    tmp.text(MARGIN, 26, `${label} · gerado em ${generatedAt()}`, { size: 8, color: INK_3 });
    tmp.text(PAGE_W - MARGIN, 26, `Página ${index + 1} de ${total}`, { size: 8, color: INK_3, align: "right" });
    saved.push(...tmp.pages[0]);
  });
}

// ── Relatório financeiro do mês ─────────────────────────────────
function summarize(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const income = list.filter((e) => e.type === "receita").reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const expense = list.filter((e) => e.type !== "receita").reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const cats = new Map();
  list.filter((e) => e.type !== "receita").forEach((e) => {
    const label = e.categoryLabel || "Outros";
    const cur = cats.get(label) || { label, total: 0, count: 0 };
    cur.total += Number(e.amount) || 0;
    cur.count += 1;
    cats.set(label, cur);
  });
  return { list, income, expense, balance: income - expense, categories: [...cats.values()].sort((a, b) => b.total - a.total) };
}

// Linhas de texto do relatório (usadas em testes e como resumo).
function buildReportLines({ monthLabel, isClosed, entries }) {
  const { list, income, expense, balance, categories } = summarize(entries);
  const lines = [
    "PulseNote · Relatório financeiro",
    `${capitalize(monthLabel)} · ${isClosed ? "Mês fechado" : "Mês em aberto"}`,
    `Receitas: ${formatCurrency(income)}`,
    `Despesas: ${formatCurrency(expense)}`,
    `Saldo: ${formatCurrency(balance)}`,
    `Lançamentos: ${list.length}`,
  ];
  categories.slice(0, 5).forEach((cat) => lines.push(`${cat.label}: ${formatCurrency(cat.total)}`));
  return lines;
}

function buildPdfReportBuffer({ monthLabel, isClosed, entries }) {
  const { list, income, expense, balance, categories } = summarize(entries);
  const sorted = [...list].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const label = capitalize(monthLabel || "Relatório");
  const c = createCanvas().addPage();

  drawCover(c, {
    kicker: "Relatório financeiro",
    title: label,
    subtitle: `${list.length} ${list.length === 1 ? "lançamento" : "lançamentos"} · usado ${income > 0 ? Math.round((expense / income) * 100) : expense > 0 ? 100 : 0}% da renda do mês`,
    badge: isClosed ? "Mês fechado" : "Mês em aberto",
  });

  // KPIs
  let y = PAGE_H - 228;
  const gap = 10;
  const boxW = (CONTENT_W - gap * 3) / 4;
  const savings = income > 0 ? `${((balance / income) * 100).toFixed(1).replace(".", ",")}%` : "—";
  [
    { k: "RECEITAS", v: formatCurrency(income), color: IN },
    { k: "DESPESAS", v: formatCurrency(expense), color: OUT },
    { k: "SALDO", v: formatCurrency(balance), color: balance >= 0 ? INK : OUT },
    { k: "POUPANÇA", v: savings, color: BRAND },
  ].forEach((kpi, i) => {
    const x = MARGIN + i * (boxW + gap);
    c.roundRect(x, y, boxW, 58, 10, SOFT);
    c.rect(x + 12, y + 40, 6, 6, kpi.color);
    c.text(x + 23, y + 40, kpi.k, { size: 7.5, bold: true, color: INK_3 });
    c.text(x + 12, y + 16, fitText(kpi.v, boxW - 24, 13.5, true), { size: 13.5, bold: true, color: kpi.color });
  });

  // Barra "quanto da renda foi usado"
  y -= 26;
  const usedRaw = income > 0 ? expense / income : expense > 0 ? 1 : 0;
  const used = Math.min(1, usedRaw);
  c.text(MARGIN, y, "Da renda do mês, foi usado", { size: 9, color: INK_2 });
  c.text(PAGE_W - MARGIN, y, `${Math.round(usedRaw * 100)}%`, { size: 9, bold: true, color: used >= 0.9 ? OUT : INK, align: "right" });
  y -= 12;
  c.roundRect(MARGIN, y, CONTENT_W, 6, 3, LINE);
  if (used > 0) c.roundRect(MARGIN, y, Math.max(6, CONTENT_W * used), 6, 3, used >= 0.9 ? OUT : "#10b981");

  // Categorias
  if (categories.length) {
    y -= 36;
    c.text(MARGIN, y, "Para onde foi o dinheiro", { size: 12, bold: true, color: INK });
    c.text(PAGE_W - MARGIN, y, `${categories.length} ${categories.length === 1 ? "categoria" : "categorias"}`, { size: 8.5, color: INK_3, align: "right" });
    y -= 10;
    categories.slice(0, 8).forEach((cat, i) => {
      y -= 20;
      const color = PALETTE[i % PALETTE.length];
      const pct = expense > 0 ? cat.total / expense : 0;
      c.roundRect(MARGIN, y - 1, 8, 8, 2, color);
      c.text(MARGIN + 15, y, fitText(cat.label, 150, 9.5, true), { size: 9.5, bold: true, color: INK });
      const barX = MARGIN + 180;
      const barW = 200;
      c.roundRect(barX, y, barW, 5, 2.5, SOFT);
      c.roundRect(barX, y, Math.max(5, barW * pct), 5, 2.5, color);
      c.text(barX + barW + 36, y, `${Math.round(pct * 100)}%`, { size: 9, color: INK_3, align: "right" });
      c.text(PAGE_W - MARGIN, y, formatCurrency(cat.total), { size: 9.5, bold: true, color: INK, align: "right" });
    });
  }

  // Tabela de lançamentos
  const cols = { date: MARGIN + 10, desc: MARGIN + 58, cat: MARGIN + 300, val: PAGE_W - MARGIN - 10 };
  const tableHeader = () => {
    c.roundRect(MARGIN, y - 6, CONTENT_W, 20, 6, SOFT);
    c.text(cols.date, y, "DATA", { size: 7.5, bold: true, color: INK_3 });
    c.text(cols.desc, y, "DESCRIÇÃO", { size: 7.5, bold: true, color: INK_3 });
    c.text(cols.cat, y, "CATEGORIA", { size: 7.5, bold: true, color: INK_3 });
    c.text(cols.val, y, "VALOR", { size: 7.5, bold: true, color: INK_3, align: "right" });
    y -= 22;
  };
  y -= 40;
  if (y < 120) { c.addPage(); drawRunningHeader(c, label); y = PAGE_H - 74; }
  c.text(MARGIN, y, "Lançamentos", { size: 12, bold: true, color: INK });
  c.text(PAGE_W - MARGIN, y, `${sorted.length} no mês`, { size: 8.5, color: INK_3, align: "right" });
  y -= 24;
  tableHeader();
  sorted.forEach((e, i) => {
    if (y < 62) {
      c.addPage();
      drawRunningHeader(c, label);
      y = PAGE_H - 74;
      tableHeader();
    }
    if (i % 2 === 1) c.rect(MARGIN, y - 6, CONTENT_W, 19, "#fafbfd");
    const isIn = e.type === "receita";
    c.text(cols.date, y, shortDate(e.date), { size: 9, color: INK_2 });
    c.text(cols.desc, y, fitText(e.description || "Sem descrição", cols.cat - cols.desc - 12, 9, true), { size: 9, bold: true, color: INK });
    c.text(cols.cat, y, fitText(e.categoryLabel || "Outros", 120, 9), { size: 9, color: INK_2 });
    c.text(cols.val, y, `${isIn ? "+" : "-"} ${formatCurrency(e.amount)}`, { size: 9, bold: true, color: isIn ? IN : OUT, align: "right" });
    y -= 19;
  });
  if (y < 70) { c.addPage(); drawRunningHeader(c, label); y = PAGE_H - 74; }
  c.line(MARGIN, y + 8, PAGE_W - MARGIN, y + 8, LINE, 1);
  c.text(cols.date, y - 6, "Saldo do mês", { size: 9.5, bold: true, color: INK });
  c.text(cols.val, y - 6, formatCurrency(balance), { size: 9.5, bold: true, color: balance >= 0 ? IN : OUT, align: "right" });

  drawFooters(c, `PulseNote · ${label}`);
  return serializePdf(c.pages, `PulseNote - Relatório ${label}`);
}

// ── Documento livre ("transforma isso em PDF") ──────────────────
// Título + texto com parágrafos, listas ("•", "-", "1.") e subtítulos
// (linhas curtas terminadas em ":" ou em *negrito* do WhatsApp).
function buildTextPdfBuffer({ title, content, subtitle = "" }) {
  const docTitle = String(title || "Documento").replace(/\s+/g, " ").trim().slice(0, 90) || "Documento";
  const c = createCanvas().addPage();
  drawCover(c, { kicker: "Documento", title: docTitle, subtitle: subtitle || `Criado pelo Pulsinho em ${generatedAt()}` });
  let y = PAGE_H - 190;
  const ensure = (needed) => {
    if (y - needed < 60) {
      c.addPage();
      drawRunningHeader(c, fitText(docTitle, 300, 9));
      y = PAGE_H - 74;
    }
  };
  const blocks = String(content || "").replace(/\r/g, "").split("\n");
  for (const raw of blocks) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { y -= 8; continue; }
    const bold = /^\*[^*]+\*:?$/.test(line.trim()) || (/:$/.test(line.trim()) && line.trim().length <= 60);
    const bullet = /^\s*(?:[•\-–*]\s+|\d+[.)]\s+)/.exec(line);
    const text = line.trim().replace(/^\*([^*]+)\*(:?)$/, "$1$2").replace(/\*([^*]+)\*/g, "$1");
    if (bold) {
      ensure(30);
      y -= 10;
      c.text(MARGIN, y, fitText(text, CONTENT_W, 12, true), { size: 12, bold: true, color: INK });
      y -= 18;
      continue;
    }
    if (bullet) {
      const marker = /\d/.test(bullet[0]) ? bullet[0].trim() : "•";
      const body = line.slice(bullet[0].length).replace(/\*([^*]+)\*/g, "$1");
      const wrapped = wrapText(body, CONTENT_W - 18, 10.5);
      wrapped.forEach((part, index) => {
        ensure(16);
        if (index === 0) c.text(MARGIN + 2, y, marker, { size: 10.5, bold: true, color: BRAND });
        c.text(MARGIN + 18, y, part, { size: 10.5, color: INK });
        y -= 15;
      });
      continue;
    }
    for (const part of wrapText(text, CONTENT_W, 10.5)) {
      ensure(16);
      c.text(MARGIN, y, part, { size: 10.5, color: INK });
      y -= 15;
    }
    y -= 3;
  }
  drawFooters(c, `PulseNote · ${fitText(docTitle, 240, 8)}`);
  return serializePdf(c.pages, docTitle);
}

module.exports = { buildPdfReportBuffer, buildReportLines, buildTextPdfBuffer, textWidth, fitText, toWinAnsi };
