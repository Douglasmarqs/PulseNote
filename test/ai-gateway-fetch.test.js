const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMessages } = require("../api/_lib/aiGatewayFetch");

test("mensagens do gateway preservam apenas o histórico necessário", () => {
  const messages = [
    { role: "system", content: "não permitido" },
    ...Array.from({ length: 15 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turno ${index}` })),
  ];
  const normalized = normalizeMessages(messages, "pergunta atual");
  assert.equal(normalized.length, 13);
  assert.equal(normalized[0].content, "turno 3");
  assert.deepEqual(normalized.at(-1), { role: "user", content: "pergunta atual" });
});

test("não duplica a pergunta atual quando ela já encerra o histórico", () => {
  const normalized = normalizeMessages([{ role: "user", content: "olá" }], "olá");
  assert.deepEqual(normalized, [{ role: "user", content: "olá" }]);
});
