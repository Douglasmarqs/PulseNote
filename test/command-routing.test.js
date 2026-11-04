const test = require("node:test");
const assert = require("node:assert/strict");

test("comando rápido abre diretamente a área pedida", async () => {
  const { classifyPulseCommand } = await import("../src/command-routing.mjs");

  assert.equal(classifyPulseCommand("ver minhas finanças"), "finances");
  assert.equal(classifyPulseCommand("mostrar meu saldo"), "finances");
  assert.equal(classifyPulseCommand("abrir agenda de compromissos"), "planner");
  assert.equal(classifyPulseCommand("ver minhas anotações"), "notes");
});

test("comando com valor continua financeiro e pedido genérico vai ao Autopilot", async () => {
  const { classifyPulseCommand } = await import("../src/command-routing.mjs");

  assert.equal(classifyPulseCommand("mercado 42,90"), "finances");
  assert.equal(classifyPulseCommand("o que devo priorizar hoje?"), "autopilot");
});

