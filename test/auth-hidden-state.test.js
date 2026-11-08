const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("alertas vazios de login e cadastro permanecem ocultos", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/auth.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../src/login.html"), "utf8");

  assert.match(html, /id="loginError" class="auth-error" hidden/);
  assert.match(html, /id="registerError" class="auth-error" hidden/);
  assert.match(css, /\.auth-error\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

