const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("src/index.html");
const app = read("src/app.js");

test("Configurações mantém todos os controles antigos, cada um uma única vez", () => {
  for (const id of [
    "settingsAvatarPreview", "settingsPhotoInput", "settingsUserName", "settingsUserEmail", "settingsUploadProgress", "settingsUploadProgressBar",
    "settingsNameForm", "settingsNameInput", "themeToggle", "billingSettingsCard", "billingStatusBadge", "billingStatusText", "billingPlanGrid",
    "billingActions", "billingPortalButton", "whatsappLinkedBlock", "whatsappLinkedPhoneLabel", "whatsappReminderOptIn", "settingsWhatsappUnlinkBtn",
    "whatsappUnlinkedBlock", "whatsappCodeBlock", "whatsappCodeText", "whatsappBotNumberLabel", "whatsappCodeExpiry", "settingsWhatsappGenerateBtn",
    "pulsinhoAiPreference", "appReminderOptIn", "appReminderStatus", "settingsPasswordForm", "settingsCurrentPw", "settingsNewPw", "settingsMessage",
    "settingsExportBackup", "settingsImportBackup", "settingsImportFile", "settingsForceUpdate", "adminAccessCard", "settingsLogoutBtn", "settingsDeleteAccountBtn",
  ]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
  }
  for (const choice of ["light", "aurora", "eclipse", "system"]) assert.match(html, new RegExp(`data-theme-choice="${choice}"`));
});

test("cada seção do menu abre um painel ou um cartão existente", () => {
  const keys = [...html.matchAll(/data-st="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["conta", "aparencia", "plano", "integracoes", "inteligencia", "notificacoes", "seguranca"]);
  for (const key of ["conta", "plano", "integracoes", "notificacoes", "seguranca"]) assert.match(html, new RegExp(`data-st-panel="${key}"`), key);
  for (const key of ["aparencia", "inteligencia"]) assert.match(html, new RegExp(`data-st-sec="${key}"`), key);
  assert.match(app, /function openSettingsSection\(key\)/);
  assert.match(app, /parent\.insertBefore\(panel, next/);
});

test("interruptores do resumo usam os mesmos fluxos de antes", () => {
  assert.match(app, /document\.getElementById\("settingsWhatsappUnlinkBtn"\)\?\.click\(\)/);
  assert.match(app, /else startWhatsappLink\(\);/);
  assert.match(app, /box\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
});
