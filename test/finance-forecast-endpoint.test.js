const test = require("node:test");
const assert = require("node:assert/strict");

test("endpoint de previsão exige autenticação e não aceita escrita", async () => {
  const handler = require("../api/finance-forecast");
  const response = () => ({
    code: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  });

  const unauthenticated = response();
  await handler({ method: "GET", headers: {}, query: {} }, unauthenticated);
  assert.equal(unauthenticated.code, 401);

  const write = response();
  await handler({ method: "POST", headers: {}, query: {} }, write);
  assert.equal(write.code, 405);
  assert.equal(write.headers.Allow, "GET");
});
