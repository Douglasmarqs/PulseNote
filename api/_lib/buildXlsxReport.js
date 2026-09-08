// ============================================================
// Gerador de relatório financeiro em .xlsx — versão para o servidor
// (usada pelo WhatsApp: "manda a planilha do mês passado").
//
// Isto é um PORTE fiel de buildXlsxBlob() em src/app.js (o botão
// "Exportar Excel" das Finanças no app) — mesma geração manual de
// OOXML/ZIP, sem nenhuma lib externa (nem no navegador, nem aqui).
// A função original já era 100% JS puro (Uint8Array, Map, TextEncoder
// — nada de `document`/`window`/`Blob`, exceto o `new Blob(...)` bem
// no final), então portar pro Node foi só trocar esse retorno final
// por `Buffer.from(...)` e receber os dados já prontos por parâmetro
// em vez de ler `state`/`findCategory` do app direto.
//
// Se um dia mudar o layout/estilo do relatório em src/app.js, replicar
// a mudança aqui também (e vice-versa) — são dois arquivos por causa
// do navegador (ESM) e da API (CommonJS) não compartilharem módulos
// diretamente neste projeto, não por acaso.
// ============================================================

// entries: [{ date: "YYYY-MM-DD", description, categoryLabel (sem o
//   emoji na frente), type: "receita"|"despesa", amount }], já
//   filtrado pro mês certo e ordenado por data.
function buildXlsxReportBuffer({ monthLabel, isClosed, entries }) {
  const receitas = entries.filter((f) => f.type === "receita").reduce((sum, f) => sum + f.amount, 0);
  const despesas = entries.filter((f) => f.type === "despesa").reduce((sum, f) => sum + f.amount, 0);
  const saldo = receitas - despesas;
  const geradoEm = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date());
  const formatDateBr = (iso) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };

  const byCat = {};
  entries.filter((f) => f.type === "despesa").forEach((f) => {
    if (!byCat[f.categoryLabel]) byCat[f.categoryLabel] = { label: f.categoryLabel, total: 0 };
    byCat[f.categoryLabel].total += f.amount;
  });
  const catList = Object.values(byCat).sort((a, b) => b.total - a.total);

  const strIndex = new Map();
  const strings = [];
  function s(str) {
    const k = String(str ?? "");
    if (!strIndex.has(k)) { strIndex.set(k, strings.length); strings.push(k); }
    return strIndex.get(k);
  }

  s(""); s("Relatório Financeiro"); s(monthLabel); s("Status"); s("Fechado"); s("Aberto");
  s("Receitas"); s("Despesas"); s("Saldo"); s("Total de lançamentos"); s("Gerado em"); s(geradoEm);
  s("Data"); s("Descrição"); s("Categoria"); s("Tipo"); s("Valor (R$)");
  s("Receita"); s("Despesa");
  catList.forEach((c) => s(c.label));
  entries.forEach((f) => { s(formatDateBr(f.date)); s(f.description || ""); s(f.categoryLabel); });

  const ST = { def: 0, hdr: 1, rec: 2, desp: 3, saldo: 4, num: 5, brl: 6, bold: 7 };

  function colRef(c) {
    let out = "";
    let n = c + 1;
    while (n > 0) { out = String.fromCharCode(64 + ((n - 1) % 26) + 1) + out; n = Math.floor((n - 1) / 26); }
    return out;
  }
  function cs(col, row, strIdx, style = ST.def) { return `<c r="${colRef(col)}${row}" t="s" s="${style}"><v>${strIdx}</v></c>`; }
  function cn(col, row, value, style = ST.num) { return `<c r="${colRef(col)}${row}" s="${style}"><v>${value}</v></c>`; }
  function cbrl(col, row, value, style = ST.brl) { return cn(col, row, value, style); }

  const sheet1Rows = [
    `<row r="1">${cs(0, 1, s("Relatório Financeiro"), ST.hdr)}${cs(1, 1, s(monthLabel), ST.hdr)}</row>`,
    `<row r="2">${cs(0, 2, s("Status"), ST.bold)}${cs(1, 2, s(isClosed ? "Fechado" : "Aberto"), isClosed ? ST.rec : ST.def)}</row>`,
    `<row r="3">${cs(0, 3, s("Gerado em"), ST.bold)}${cs(1, 3, s(geradoEm))}</row>`,
    `<row r="5">${cs(0, 5, s("Receitas"), ST.hdr)}${cbrl(1, 5, receitas, ST.rec)}</row>`,
    `<row r="6">${cs(0, 6, s("Despesas"), ST.hdr)}${cbrl(1, 6, despesas, ST.desp)}</row>`,
    `<row r="7">${cs(0, 7, s("Saldo"), ST.hdr)}${cbrl(1, 7, saldo, saldo >= 0 ? ST.rec : ST.desp)}</row>`,
    `<row r="8">${cs(0, 8, s("Total de lançamentos"), ST.bold)}${cn(1, 8, entries.length, ST.num)}</row>`,
  ];

  const sheet2Rows = [
    `<row r="1">${cs(0, 1, s("Data"), ST.hdr)}${cs(1, 1, s("Descrição"), ST.hdr)}${cs(2, 1, s("Categoria"), ST.hdr)}${cs(3, 1, s("Tipo"), ST.hdr)}${cs(4, 1, s("Valor (R$)"), ST.hdr)}</row>`,
    ...entries.map((f, i) => {
      const r = i + 2;
      const isRec = f.type === "receita";
      const signedAmt = isRec ? f.amount : -f.amount;
      return `<row r="${r}">${cs(0, r, s(formatDateBr(f.date)))}${cs(1, r, s(f.description || ""))}${cs(2, r, s(f.categoryLabel))}${cs(3, r, s(isRec ? "Receita" : "Despesa"), isRec ? ST.rec : ST.desp)}${cbrl(4, r, signedAmt, isRec ? ST.rec : ST.desp)}</row>`;
    }),
    (() => {
      const r = entries.length + 3;
      return `<row r="${r}">${cs(0, r, s("TOTAL"), ST.hdr)}${cs(1, r, s(""))}${cs(2, r, s(""))}${cs(3, r, s(""))}${cbrl(4, r, receitas - despesas, saldo >= 0 ? ST.rec : ST.desp)}</row>`;
    })(),
  ];

  const sheet3Rows = [
    `<row r="1">${cs(0, 1, s("Categoria"), ST.hdr)}${cs(1, 1, s("Valor (R$)"), ST.hdr)}${cs(2, 1, s("% das Despesas"), ST.hdr)}</row>`,
    ...catList.map((c, i) => {
      const r = i + 2;
      const pct = despesas > 0 ? Math.round((c.total / despesas) * 1000) / 10 : 0;
      return `<row r="${r}">${cs(0, r, s(c.label))}${cbrl(1, r, c.total, ST.desp)}${cn(2, r, pct, ST.num)}</row>`;
    }),
  ];

  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map((str) => `<si><t xml:space="preserve">${str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</t></si>`).join("")}
</sst>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="3">
  <font><sz val="11"/><name val="Calibri"/><color rgb="FF1A1F2E"/></font>
  <font><sz val="11"/><b/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
  <font><sz val="11"/><b/><name val="Calibri"/><color rgb="FF1A1F2E"/></font>
</fonts>
<fills count="7">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF2C5282"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF1A4731"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF7B1D16"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF1E3A5F"/></patternFill></fill>
  <fill><patternFill patternType="none"/></fill>
</fills>
<borders count="2">
  <border/>
  <border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  <xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
  <xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1"/>
  <xf numFmtId="164" fontId="1" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>
  <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"/>
  <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function makeSheetXml(rows) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rows.join("")}</sheetData>
</worksheet>`;
  }

  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Resumo" sheetId="1" r:id="rId1"/>
<sheet name="Lançamentos" sheetId="2" r:id="rId2"/>
<sheet name="Por Categoria" sheetId="3" r:id="rId3"/>
</sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
    "xl/styles.xml": stylesXml,
    "xl/sharedStrings.xml": ssXml,
    "xl/worksheets/sheet1.xml": makeSheetXml(sheet1Rows),
    "xl/worksheets/sheet2.xml": makeSheetXml(sheet2Rows),
    "xl/worksheets/sheet3.xml": makeSheetXml(sheet3Rows),
  };

  return zipFilesToBuffer(files);
}

// Mesmo gerador de ZIP manual do app.js (compressão STORED, sem
// deflate — o Excel aceita numa boa), só que devolvendo Buffer em vez
// de Blob no final, já que aqui é Node, não navegador.
function zipFilesToBuffer(filesObj) {
  const enc = new TextEncoder();

  function u32le(n) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]; }
  function u16le(n) { return [n & 0xff, (n >> 8) & 0xff]; }

  let crcTable = null;
  function crc32(data) {
    let crc = 0xffffffff;
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[i] = c;
      }
    }
    for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(filesObj)) {
    const nameBytes = enc.encode(name);
    const dataBytes = typeof content === "string" ? enc.encode(content) : content;
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const lhdr = [
      0x50, 0x4b, 0x03, 0x04,
      ...u16le(20), ...u16le(0), ...u16le(0), ...u16le(0), ...u16le(0),
      ...u32le(crc), ...u32le(size), ...u32le(size),
      ...u16le(nameBytes.length), ...u16le(0),
      ...nameBytes,
    ];

    parts.push(new Uint8Array(lhdr));
    parts.push(dataBytes);

    central.push({ nameBytes, crc, size, offset });
    offset += lhdr.length + size;
  }

  const cdStart = offset;
  for (const e of central) {
    const cd = [
      0x50, 0x4b, 0x01, 0x02,
      ...u16le(20), ...u16le(20), ...u16le(0), ...u16le(0), ...u16le(0), ...u16le(0),
      ...u32le(e.crc), ...u32le(e.size), ...u32le(e.size),
      ...u16le(e.nameBytes.length), ...u16le(0), ...u16le(0), ...u16le(0), ...u16le(0), ...u32le(0),
      ...u32le(e.offset),
      ...e.nameBytes,
    ];
    parts.push(new Uint8Array(cd));
    offset += cd.length;
  }

  const cdSize = offset - cdStart;
  const eocd = [
    0x50, 0x4b, 0x05, 0x06,
    ...u16le(0), ...u16le(0), ...u16le(central.length), ...u16le(central.length),
    ...u32le(cdSize), ...u32le(cdStart), ...u16le(0),
  ];
  parts.push(new Uint8Array(eocd));

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const buf = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { buf.set(p, pos); pos += p.length; }
  return Buffer.from(buf);
}

module.exports = { buildXlsxReportBuffer };
