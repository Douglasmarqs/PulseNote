const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildPdfReportBuffer, buildTextPdfBuffer, textWidth, fitText, toWinAnsi } = require("../api/_lib/buildPdfReport");
const { normalizeBrainOutput, normalizeFiles, honestReplyFor, buildSystemPrompt } = require("../api/_lib/pulsinhoBrain");
const { parseTextIntent } = require("../api/_lib/parseCommandIntent");
const { buildCategoryList } = require("../api/_lib/financeCategories");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const categories = buildCategoryList({});
const now = { today: "2026-11-23", time: "10:00", hour: 10, weekday: "segunda-feira" };
const ctx = (extra = {}) => ({ state: {}, categories, today: now.today, nowTime: now.time, channel: "whatsapp", rawMessage: "", ...extra });

test("PDF do WhatsApp: acentos em WinAnsi, valores alinhados e várias páginas", () => {
  assert.equal(toWinAnsi("Ação — ok • 😀"), "Ação \x97 ok \x95 ");
  assert.ok(textWidth("R$ 1.000,00", 10, true) > textWidth("R$ 10,00", 10, true));
  assert.match(fitText("Uma descrição bem comprida que não cabe", 60, 9), /…$/);

  const entries = Array.from({ length: 60 }, (_, i) => ({
    date: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`, description: `Compra ${i}`, categoryLabel: "Mercado", type: "despesa", amount: 10 + i,
  }));
  const pdf = buildPdfReportBuffer({ monthLabel: "novembro de 2026", isClosed: true, entries }).toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.includes("(Novembro de 2026)"));
  assert.ok(pdf.includes("(Lan\xE7amentos)"), "texto com acento em Latin-1");
  assert.match(pdf, /\/Count [2-9]/, "lançamentos continuam em outras páginas");
  assert.ok(pdf.includes("(M\xEAs fechado)"));
});

test("PDF de documento livre: títulos, listas e paginação", () => {
  const content = ["Mala:", "• Protetor solar", "1. Chegar às 10h", "", "Texto ".repeat(900)].join("\n");
  const pdf = buildTextPdfBuffer({ title: "Viagem para a praia", content }).toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.includes("(Viagem para a praia)"));
  assert.ok(pdf.includes("(Protetor solar)"));
  assert.match(pdf, /\/Count [2-9]/);
});

test("Pulsinho só entrega arquivos de verdade e só no WhatsApp", () => {
  assert.deepEqual(normalizeFiles([{ kind: "finance_report", month: 10, year: 2026 }], ctx()), [{ kind: "finance_report", month: 10, year: 2026 }]);
  assert.deepEqual(normalizeFiles([{ kind: "finance_report", month: 99 }], ctx()), [{ kind: "finance_report", month: 11, year: 2026 }]);
  assert.deepEqual(normalizeFiles([{ kind: "document", title: "Lista", content: "• arroz" }], ctx()), [{ kind: "document", title: "Lista", content: "• arroz" }]);
  assert.deepEqual(normalizeFiles([{ kind: "document", title: "Vazio", content: "  " }], ctx()), []);
  assert.deepEqual(normalizeFiles([{ kind: "image" }], ctx()), []);
  assert.deepEqual(normalizeFiles([{ kind: "finance_report", month: 10, year: 2026 }], ctx({ channel: "app" })), []);

  const out = normalizeBrainOutput({ reply: "", files: [{ kind: "document", title: "Lista", content: "• arroz" }] }, ctx());
  assert.equal(out.files.length, 1);
  assert.match(out.reply, /PDF/);
});

test("Pulsinho não promete arquivo, imagem ou link que não vai mandar", () => {
  for (const fake of [
    "Estou gerando o PDF e já te mando o link para download!",
    "Quase lá! Só mais um instante 😊",
    "Vou subir o arquivo e te passo o link.",
    "Tô preparando a imagem do gráfico pra você",
  ]) {
    const honest = honestReplyFor(fake, ctx());
    assert.notEqual(honest, fake, fake);
    assert.match(honest, /PDF/);
    assert.doesNotMatch(honest, /quase l[aá]/i);
  }
  for (const ok of ["Registrado! Bom apetite 😋", "Você tem 3 tarefas pendentes:\n• Enviar proposta", "Vou te explicar: CDI é a taxa..."]) {
    assert.equal(honestReplyFor(ok, ctx()), ok);
  }
  // Com arquivo de verdade, a frase curta passa.
  const real = normalizeBrainOutput({ reply: "Prontinho, já te mando o PDF 👇", files: [{ kind: "finance_report", month: 11, year: 2026 }] }, ctx());
  assert.equal(real.reply, "Prontinho, já te mando o PDF 👇");
});

test("o prompt do WhatsApp descreve o que dá e o que não dá para enviar", () => {
  const prompt = buildSystemPrompt({ name: "Ana", now, channel: "whatsapp", context: {}, categories });
  assert.match(prompt, /"kind":"finance_report"/);
  assert.match(prompt, /"kind":"document"/);
  assert.match(prompt, /NÃO consegue: gerar ou enviar imagens/);
  assert.match(prompt, /PROIBIDO prometer/);
  const app = buildSystemPrompt({ name: "Ana", now, channel: "app", context: {}, categories });
  assert.doesNotMatch(app, /"kind":"document"/);
  assert.match(app, /Finanças → Exportar/);
});

test("PDF de lista/nota vai para o Pulsinho, PDF do mês continua sendo relatório", async () => {
  const options = { categories: [], today: "2026-11-23" };
  const notReport = async (text) => {
    const result = await parseTextIntent({ ...options, text });
    assert.notEqual(result?.intent, "report", text);
  };
  await notReport("faz um pdf da minha lista de compras");
  await notReport("transforma essa nota em pdf");
  assert.deepEqual(await parseTextIntent({ ...options, text: "manda o PDF do mês passado" }), {
    ok: true, intent: "report", report: { month: 10, year: 2026, format: "arquivo" },
  });
  assert.equal((await parseTextIntent({ ...options, text: "pdf dos meus gastos de outubro" })).intent, "report");
});

test("webhook envia os arquivos do Pulsinho com o mesmo fluxo do PDF do mês", () => {
  const webhook = read("api/whatsapp-webhook.js");
  assert.match(webhook, /async function sendBrainFiles/);
  assert.match(webhook, /buildTextPdfBuffer\(\{ title: file\.title, content: file\.content \}\)/);
  assert.match(webhook, /if \(brain\.files\?\.length\)/);
  assert.match(webhook, /sendMonthlyPdfReport\(\{ fb, uid, phone: fromPhone/);
});

test("relatório de Finanças no app: novo layout para salvar em PDF", () => {
  const app = read("src/app.js");
  const start = app.indexOf("function exportMonthReport(");
  const body = app.slice(start, app.indexOf("\nfunction bindFinanceMonthControls", start));
  assert.match(body, /Salvar como PDF/);
  assert.match(body, /Destaques do mês/);
  assert.match(body, /break-inside:avoid/);
  assert.match(body, /link\.download = `PulseNote-relatorio-/);
  assert.doesNotMatch(body, /📄/);
});

test("perfil: mapa de atividade se ajusta à largura e a foto não fica coberta", () => {
  const app = read("src/app.js");
  assert.match(app, /function pfxWatchHeatmap\(wrapEl\)/);
  assert.match(app, /new ResizeObserver/);
  assert.match(app, /wrapEl\.style\.setProperty\("--cell", `\$\{cell\}px`\)/);
  const css = read("src/profile-v3.css");
  assert.match(css, /\.pfx-heat-wrap \{[^}]*overflow: hidden/);
  assert.match(css, /\.pfx-avatar img \{[^}]*object-fit: cover/);
});

test("Início: gráfico de evolução não entra em ciclo de crescimento no app instalado", () => {
  const css = read("src/boards.css");
  assert.match(css, /\.bd-evo \.bd-evo-chart \{[^}]*contain: size/);
  assert.match(css, /\.bd-evo \.bd-evo-chart > svg \{[^}]*position: absolute/);
});
