"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { OFFICIAL_APP_URL, appBaseUrl, verifyStripeSignature } = require("../api/_lib/billing");

test("checkout always returns to the official HTTPS application origin", () => {
  const previousApp = process.env.APP_BASE_URL;
  const previousPublic = process.env.PUBLIC_APP_URL;
  try {
    delete process.env.APP_BASE_URL;
    delete process.env.PUBLIC_APP_URL;
    assert.equal(appBaseUrl(), OFFICIAL_APP_URL);
    process.env.APP_BASE_URL = "https://pulse-note-5erj.vercel.app/some/path/";
    assert.equal(appBaseUrl(), OFFICIAL_APP_URL);
    process.env.APP_BASE_URL = "http://attacker.example";
    assert.throws(() => appBaseUrl(), /invalid_app_base_url/);
  } finally {
    if (previousApp === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = previousApp;
    if (previousPublic === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = previousPublic;
  }
});

test("Stripe webhook rejects altered and expired payloads", () => {
  const raw = Buffer.from(JSON.stringify({ id: "evt_test", type: "invoice.paid" }));
  const secret = "whsec_test_secret";
  const timestamp = 2_000_000_000;
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw.toString("utf8")}`).digest("hex");
  const header = `t=${timestamp},v1=${signature}`;
  assert.equal(verifyStripeSignature(raw, header, secret, timestamp + 30), true);
  assert.equal(verifyStripeSignature(Buffer.from("alterado"), header, secret, timestamp + 30), false);
  assert.equal(verifyStripeSignature(raw, header, secret, timestamp + 301), false);
});
