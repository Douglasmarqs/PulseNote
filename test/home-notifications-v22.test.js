const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("src/index.html");
const app = read("src/app.js");
const css = read("src/boards.css");

const brain = require("../api/_lib/pulsinhoBrain");
const { _test: reminders } = require("../api/send-reminders");
const { sendTestPush } = require("../api/_lib/pushSend");

const now = { today: "2026-11-16", time: "19:30", weekday: "segunda-feira" };
const state = {
  tasks: [{ id: "t1", title: "lavar casa do cachorro", dueDate: "2026-11-16", dueTime: "22:00", priority: "Urgente", status: "Pendente" }],
  events: [{ id: "e1", title: "ir ao centro", date: "2026-11-20", time: "14:00" }],
  notes: [{ id: "n1", title: "fazer compras", description: "comprar legumes" }, { id: "n2", title: "Cortar o cabelo", description: "" }],
};

test("Pulsinho completa resposta que termina em ':' sem a lista (WhatsApp)", async () => {
  const result = await brain.converse({
    state, message: "pode me falar quais são minhas notas e tarefas?", name: "Douglas", channel: "whatsapp", now, allowSmallTalk: false,
    callModel: async () => ({ ok: true, parsed: { reply: "Claro, Douglas — aqui tá o que você salvou:", actions: [], lookups: [] } }),
  });
  assert.equal(result.ok, true);
  assert.match(result.reply, /aqui tá o que você salvou:\n\n\*📋 Tarefas pendentes\*/);
  assert.match(result.reply, /lavar casa do cachorro — hoje às 22:00/);
  assert.match(result.reply, /\*📝 Notas\*\n• fazer compras — comprar legumes/);
  assert.doesNotMatch(result.reply, /Próximos compromissos/, "só o que foi pedido");
});

test("Pulsinho mostra os resultados reais quando a 2ª chamada da consulta falha", async () => {
  let calls = 0;
  const result = await brain.converse({
    state, message: "o que anotei sobre compras?", name: "Douglas", channel: "app", now, allowSmallTalk: false,
    callModel: async () => (++calls === 1
      ? { ok: true, parsed: { reply: "Vou ver:", lookups: [{ type: "notes", query: "compras" }] } }
      : { ok: false, status: 504, error: "timeout" }),
  });
  assert.equal(calls, 2);
  assert.match(result.reply, /^Aqui está o que encontrei, Douglas:/);
  assert.match(result.reply, /fazer compras — comprar legumes/);
});

test("resposta completa não é alterada", async () => {
  const reply = "Você tem 1 tarefa:\n• lavar casa do cachorro — hoje";
  const result = await brain.converse({
    state, message: "minhas tarefas", channel: "app", now, allowSmallTalk: false,
    callModel: async () => ({ ok: true, parsed: { reply, actions: [] } }),
  });
  assert.equal(result.reply, reply);
  assert.equal(brain.isDanglingReply("Aqui está 👇:"), true);
  assert.equal(brain.isDanglingReply("Tudo certo por aqui!"), false);
});

test("lembrete só é enviado quando a pessoa escolheu um", () => {
  const at = new Date("2026-11-16T12:50:00Z"); // 09:50 em São Paulo
  const make = (reminder) => ({ tasks: [{ id: "x", title: "Pagar luz", status: "Pendente", dueDate: "2026-11-16", dueTime: "10:00", reminder }] });
  const keys = (reminder) => reminders.buildNotifications(make(reminder), "2026-11-16", at).map((n) => n.key);
  assert.deepEqual(keys("none"), []);
  assert.deepEqual(keys(null), [], "null vem de tarefas antigas salvas com 'Sem lembrete'");
  assert.deepEqual(keys(Number.NaN), []);
  assert.deepEqual(keys(false), []);
  assert.ok(keys(15).includes("task_x"));
  assert.ok(!keys(0).includes("task_x"), "na hora: ainda não chegou");
});

test("app guarda 'Sem lembrete' como 'none' (antes virava 15 min ao recarregar)", () => {
  assert.match(app, /function normalizeReminderValue\(value, fallback = 15\)/);
  assert.match(app, /if \(selected === "none"\) return "none";/);
  assert.match(app, /t\.reminder = normalizeReminderValue\(t\.reminder\);/);
  assert.doesNotMatch(app, /Number\(selectedReminder \|\| 15\)/);
  assert.match(read("src/notifications.js"), /function reminderOff\(value\)/);
});

function fakeFirebase({ tokens = ["t".repeat(40)], lastAt = null } = {}) {
  const docs = new Map([["pushTests/u1", lastAt ? { lastAt } : null], ["userData/u1", { data: { fcmTokens: tokens } }]]);
  const sent = [];
  const ref = (col, id) => ({
    key: `${col}/${id}`,
    get: async () => ({ exists: Boolean(docs.get(`${col}/${id}`)), data: () => docs.get(`${col}/${id}`) || undefined }),
    update: async () => {},
  });
  return {
    sent,
    firestore: () => ({
      collection: (col) => ({ doc: (id) => ref(col, id) }),
      runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, value) => docs.set(r.key, value) }),
    }),
    messaging: () => ({
      sendEachForMulticast: async (message) => { sent.push(message); return { successCount: message.tokens.length, failureCount: 0, responses: message.tokens.map(() => ({ success: true })) }; },
    }),
  };
}

test("push de teste vai só para os aparelhos da própria conta, 1 por minuto", async () => {
  const fb = fakeFirebase();
  const first = await sendTestPush(fb, "u1", { now: Date.parse("2026-11-16T22:00:00Z") });
  assert.equal(first.ok, true);
  assert.equal(first.accepted, 1);
  assert.equal(fb.sent[0].data.tag, "pulsenote-push-test");
  const again = await sendTestPush(fb, "u1", { now: Date.parse("2026-11-16T22:00:30Z") });
  assert.deepEqual([again.ok, again.status, again.error], [false, 429, "push_test_cooldown"]);
  const none = await sendTestPush(fakeFirebase({ tokens: [] }), "u1");
  assert.deepEqual([none.ok, none.status, none.error], [false, 409, "no_push_devices"]);
  assert.match(read("api/pulsinho.js"), /body\.action === "push-test"/);
  assert.match(read("api/account-delete-cleanup.js"), /"pushTests"/);
});

test("Início: agenda, resultado e categorias com estrutura nova", () => {
  for (const id of ["bdTodaySummary", "bdToday", "bdResult", "bdResTotal", "bdResIn", "bdResOut", "bdResMeter", "bdResRate", "bdCats", "bdChatMenu", "bdChatJump", "bdChatAvatar"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /symbol id="i-arrow-in"/);
  assert.match(app, /function bdAgendaItems\(\)/);
  assert.match(app, /function renderBoardsResult\(receitas, despesas\)/);
  assert.match(css, /--bd-cat-1: #2a78d6/);
  assert.match(css, /\.bd-chat-form input \{ font-size: 16px; \}/, "sem zoom do iPhone ao tocar no campo");
});

test("notas: editor com formatação seguro e cor por prioridade", () => {
  for (const cmd of ["bold", "italic", "underline", "strike", "highlight", "ul", "ol", "checklist", "clear"]) {
    assert.match(html, new RegExp(`data-ne-cmd="${cmd}"`), cmd);
  }
  assert.match(html, /id="noteEditor" class="bn-rich-editor" contenteditable="true"/);
  assert.match(html, /id="notePrioritySeg"[^>]*role="radiogroup"/);
  assert.match(app, /const editorHtml = noteEditorHtml\(\);/);
  assert.match(app, /document\.execCommand\("insertText", false, text\.slice\(0, 20000\)\)/, "colar entra como texto puro");
  assert.match(app, /style="--nc:var\(--np-\$\{prio\}\)"/);
});

test("sininho abre a central e o puxar-para-atualizar só existe no app instalado", () => {
  assert.match(app, /toggleNotificationCenter\(\);/);
  assert.doesNotMatch(app, /#bdBellBtn"\)\?\.addEventListener\("click", \(\) => setView\("settings"\)\)/);
  assert.match(app, /if \(!touch \|\| !standalone \|\| document\.querySelector\("\.pn-ptr"\)\) return;/);
  assert.match(app, /Adicionar à Tela de Início/);
});
