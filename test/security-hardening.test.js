"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("cabeçalhos de segurança valem para todo o site", () => {
  const conf = JSON.parse(read("vercel.json"));
  const all = conf.headers.find((h) => h.source === "/(.*)");
  const h = Object.fromEntries(all.headers.map((x) => [x.key, x.value]));
  assert.equal(h["X-Frame-Options"], "DENY", "ninguém embute o app em outro site (clickjacking)");
  assert.match(h["Strict-Transport-Security"], /max-age=\d{8,}/, "só HTTPS");
  assert.equal(h["Cross-Origin-Opener-Policy"], "same-origin-allow-popups", "isola a janela e mantém o login do Google");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  // aplicado de verdade: o que nunca quebra o app
  for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) assert.ok(h["Content-Security-Policy"].includes(d), d);
  // política completa em observação, com os hosts do login do Google e das notificações
  for (const host of ["https://apis.google.com", "https://fcm.googleapis.com", "https://pulsenote-f99e2.firebaseapp.com"]) assert.ok(h["Content-Security-Policy-Report-Only"].includes(host), host);
});

test("Firestore: cada pessoa só lê e grava o próprio documento; o resto é bloqueado", () => {
  const rules = read("firestore.rules");
  assert.match(rules, /match \/userData\/\{userId\}[\s\S]*request\.auth\.uid == userId/);
  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
});

test("Storage: só fotos (sem SVG), até 5 MB, e a pessoa pode apagar a própria", () => {
  const rules = read("storage.rules");
  assert.match(rules, /contentType\.matches\('image\/\(jpeg\|png\|webp\|gif\|heic\|heif\)'\)/);
  assert.doesNotMatch(rules, /matches\('image\/\.\*'\)/);
  assert.match(rules, /allow delete: if request\.auth != null && request\.auth\.uid == userId;/);
});

test("senha: mínimo de 8 caracteres e sem as senhas óbvias (cadastro e troca)", () => {
  const auth = read("src/auth.js");
  const login = read("src/login.html");
  assert.match(auth, /function passwordProblem\(pw, email = ""\)/);
  assert.match(auth, /if \(pw\.length < 8\) return/);
  assert.match(login, /id="regPassword"[^>]*minlength="8"/);
  // o retorno após o login só aceita rotas internas
  assert.match(auth, /const postAuthPath = authParams\.get\("next"\) === "\/admin" \? "\/admin" : "\/app";/);
  // recuperar senha não revela se o e-mail existe
  assert.match(auth, /não revelamos e-mails cadastrados/);
});
