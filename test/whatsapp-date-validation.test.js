const test = require("node:test");
const assert = require("node:assert/strict");
const { extractFutureDateIso, extractPastDateIso } = require("../api/_lib/localTextFallback");

test("data de hoje informada no WhatsApp permanece hoje, não pula um ano", () => {
  assert.equal(extractFutureDateIso("consulta 15/10", "2026-10-15"), "2026-10-15");
  assert.equal(extractFutureDateIso("consulta 15 de outubro", "2026-10-15"), "2026-10-15");
  assert.equal(extractPastDateIso("gastei 20 no dia 15", "2026-10-15"), "2026-10-15");
});

test("datas impossíveis não são convertidas silenciosamente para outro dia", () => {
  assert.equal(extractFutureDateIso("consulta 31/02", "2026-10-15"), null);
  assert.equal(extractFutureDateIso("consulta 31 de abril", "2026-10-15"), null);
  assert.equal(extractFutureDateIso("consulta 29/02/2026", "2026-10-15"), null);
});

test("dia sem mês busca a ocorrência válida; 29 de fevereiro busca ano bissexto", () => {
  assert.equal(extractFutureDateIso("consulta dia 31", "2026-11-30"), "2026-12-31");
  assert.equal(extractPastDateIso("gastei 20 dia 31", "2026-11-30"), "2026-10-31");
  assert.equal(extractFutureDateIso("consulta 29 de fevereiro", "2026-10-15"), "2028-02-29");
  assert.equal(extractPastDateIso("gastei 20 em 29 de fevereiro", "2026-10-15"), "2024-02-29");
});
