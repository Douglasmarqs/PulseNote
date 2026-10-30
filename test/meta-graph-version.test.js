const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { META_GRAPH_VERSION } = require("../api/_lib/metaGraph");
const { sendWhatsAppDocument } = require("../api/whatsapp-webhook")._test;

test("todos os caminhos WhatsApp usam uma versão da Graph API ainda suportada", () => {
  assert.equal(META_GRAPH_VERSION, "v25.0");
  for (const file of ["whatsapp-webhook.js", "send-reminders.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "api", file), "utf8");
    assert.doesNotMatch(source, /graph\.facebook\.com\/v20\.0/);
    assert.match(source, /META_GRAPH_VERSION/);
  }
});

test("envio de documento usa a versão configurada", async () => {
  const originalFetch = global.fetch;
  const originalPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const originalToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const urls = [];
  try {
    process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-test";
    process.env.WHATSAPP_ACCESS_TOKEN = "token-test";
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true };
    };
    await sendWhatsAppDocument("5531999999999", "media-test", "relatorio.pdf", "Relatório");
    assert.deepEqual(urls, [`https://graph.facebook.com/${META_GRAPH_VERSION}/phone-test/messages`]);
  } finally {
    global.fetch = originalFetch;
    if (originalPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhoneId;
    if (originalToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = originalToken;
  }
});
