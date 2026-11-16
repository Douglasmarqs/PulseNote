const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { detectSmallTalk, buildSmallTalkReply, converse, buildBrainContext, isPureQuestion } = require("../api/_lib/pulsinhoBrain");
const { normalizeAction, normalizeActions, applyActionToState } = require("../api/_lib/pulsinhoActions");
const { askPulsinho } = require("../api/_lib/pulsinhoAssistant");
const { buildCategoryList } = require("../api/_lib/financeCategories");
const { looksCompound, parseDeterministicIntent } = require("../api/_lib/parseCommandIntent");

const now = { today: "2025-01-24", time: "09:05", hour: 9, weekday: "sexta-feira" };
const categories = buildCategoryList({});
const ctx = (state = {}, extra = {}) => ({ state, categories, today: now.today, nowTime: now.time, channel: "app", ...extra });

test("entende saudações e bate-papo em qualquer forma, sem confundir com pedidos", () => {
  const kind = (text, history = []) => detectSmallTalk(text, { history })?.kind || null;
  assert.equal(kind("bom dia pulsinho"), "greeting");
  assert.equal(kind("Boa noite, Pulsinho!! Tudo bem?"), "greeting");
  assert.equal(detectSmallTalk("e aí, beleza?").howAreYou, true);
  assert.equal(kind("oiii"), "greeting");
  assert.equal(kind("obrigado pela ajuda"), "thanks");
  assert.equal(kind("kkkkkk"), "laugh");
  assert.equal(kind("quem é você?"), "identity");
  assert.equal(kind("tchau pulsinho"), "bye");
  // Verbos que parecem cumprimento continuam sendo pedidos.
  assert.equal(kind("salve isso numa nota"), null);
  assert.equal(kind("fala pro João que eu atraso"), null);
  assert.equal(kind("gastei 45 no mercado"), null);
  // "ok" depois de uma pergunta do Pulsinho é resposta, não bate-papo.
  assert.equal(kind("ok"), "ack");
  assert.equal(kind("ok", [{ role: "assistant", content: "Quer que eu crie a tarefa?" }]), null);
  // Saudação + pedido: o pedido segue com o texto original (acentos inclusos).
  assert.deepEqual(detectSmallTalk("Olá! Me lembra de pagar a luz amanhã"), { kind: "prefix", greeting: "hi", rest: "Me lembra de pagar a luz amanhã" });
});

test("resposta de saudação usa o nome, o período do dia e o resumo real da agenda", () => {
  const state = {
    tasks: [{ id: "1", title: "Enviar proposta", status: "Pendente", dueDate: "2025-01-24" }],
    events: [{ id: "e", title: "Dentista", date: "2025-01-24", time: "15:30" }],
  };
  const reply = buildSmallTalkReply({ kind: "greeting", greeting: "morning" }, { name: "Douglas Marques", state, now, seed: "x" });
  assert.match(reply, /^Bom dia, Douglas! ☀️ Hoje você tem 1 tarefa e 1 compromisso — o próximo é “Dentista” às 15:30\./);
  const night = buildSmallTalkReply({ kind: "greeting", greeting: "night" }, { name: "Douglas", state, now: { ...now, hour: 21, time: "21:00" }, seed: "x" });
  assert.match(night, /Amanhã|amanhã/);
  assert.doesNotMatch(buildSmallTalkReply({ kind: "thanks" }, { name: "Usuário", state: {}, now, seed: "x" }), /Usuário/);
});

test("ações da IA são revalidadas: tipo, valor, data, categoria e alvo", () => {
  const state = {
    tasks: [{ id: "t1", title: "Comprar ração", status: "Pendente" }, { id: "t2", title: "Comprar pão", status: "Pendente" }],
    goals: [{ id: "g1", title: "Reserva", current: 100, target: 1000 }],
    notes: [{ id: "n1", title: "Ideias" }],
    finRules: [{ id: "r", match: "aluguel", type: "despesa", categoryId: "moradia", active: true }],
  };
  const { actions, asks } = normalizeActions([
    { type: "drop_database" },
    { type: "add_transaction", title: "uber" },
    { type: "add_transaction", amount: "1.600,00", title: "aluguel de janeiro", categoryId: "outros", categoryConfidence: "baixa" },
    { type: "add_event", title: "Aniversário" },
    { type: "add_task", title: "beber água", time: "15h", reminderMinutes: 0 },
    { type: "complete_task", query: "comprar" },
    { type: "delete_note", targetId: "n1" },
  ], ctx(state));
  assert.deepEqual(actions.map((a) => [a.type, a.risk]), [["add_transaction", "auto"], ["add_task", "auto"], ["delete_note", "confirm"]]);
  assert.equal(actions[0].record.category, "moradia", "regra de categorização da pessoa vale");
  assert.equal(actions[0].record.amount, 1600);
  assert.equal(actions[0].lowConfidence, false);
  assert.equal(actions[1].record.dueDate, "2025-01-24");
  assert.equal(actions[1].record.dueTime, "15:00");
  assert.equal(actions[1].record.title, "Beber água");
  assert.ok(asks.some((q) => /valor/.test(q)));
  assert.ok(asks.some((q) => /Para que dia/.test(q)));
  assert.ok(asks.some((q) => /mais de uma tarefa parecida/.test(q) && /Comprar ração/.test(q) && /Comprar pão/.test(q)));
});

test("lembrete sem dia com horário que já passou vai para amanhã; áudio nunca exclui", () => {
  const late = normalizeAction({ type: "add_task", title: "Ligar", time: "08:00" }, ctx());
  assert.equal(late.action.record.dueDate, "2025-01-25");
  const audio = normalizeAction({ type: "delete_task", targetId: "t1" }, ctx({ tasks: [{ id: "t1", title: "X" }] }, { fromAudio: true }));
  assert.equal(audio.ok, false);
  assert.match(audio.ask, /áudio/);
});

test("aplicar ações altera só o necessário e respeita ids", () => {
  const state = { goals: [{ id: "g1", title: "Reserva", current: 100, target: 1000 }], tasks: [] };
  const goal = normalizeAction({ type: "update_goal", targetId: "g1", value: 250 }, ctx(state)).action;
  assert.match(goal.summary, /350\/1\.000 \(35%\)/);
  assert.equal(applyActionToState(state, goal).ok, true);
  assert.equal(state.goals[0].current, 350);
  const task = normalizeAction({ type: "add_task", title: "Revisar" }, ctx(state)).action;
  applyActionToState(state, task);
  applyActionToState(state, task);
  assert.equal(state.tasks.length, 1, "a mesma ação aplicada duas vezes não duplica");
  assert.equal(applyActionToState(state, { type: "delete_task", targetId: "nao-existe" }).ok, false);
});

test("pergunta pura nunca grava sozinha, mesmo que a IA proponha", async () => {
  assert.equal(isPureQuestion("posso gastar 50 no cinema?"), true);
  assert.equal(isPureQuestion("pode anotar isso pra mim?"), false);
  const result = await converse({
    message: "será que vale a pena comprar um tênis de 300?", categories, now,
    callModel: async () => ({ ok: true, parsed: { reply: "Depende!", actions: [{ type: "add_transaction", amount: 300, title: "Tênis" }] } }),
  });
  assert.equal(result.actions[0].risk, "confirm");
});

test("o prompt traz contexto real e o conteúdo das notas só quando a pessoa permite", async () => {
  const prompts = [];
  const state = { notes: [{ id: "n1", title: "Diário", description: "texto íntimo" }, { id: "n2", title: "Wi-fi de casa", description: "senha: girassol123" }], tasks: [{ id: "t", title: "Enviar proposta", status: "Pendente" }] };
  const model = async ({ systemPrompt }) => { prompts.push(systemPrompt); return { ok: true, parsed: { reply: "ok" } }; };
  await converse({ state, message: "qual é a senha do wifi?", name: "Douglas", categories, now, callModel: model });
  assert.match(prompts[0], /Douglas/);
  assert.match(prompts[0], /sexta-feira, 2025-01-24, 09:05/);
  assert.match(prompts[0], /Enviar proposta/);
  assert.match(prompts[0], /girassol123/);
  const ranked = buildBrainContext(state, { now, message: "qual é a senha do wifi?" }).notas;
  assert.equal(ranked[0].id, "n2", "a nota relacionada à pergunta vem primeiro");

  await converse({ state: { ...state, aiReadNotes: false }, message: "qual é a senha do wifi?", categories, now, callModel: model });
  assert.doesNotMatch(prompts[1], /girassol123|texto íntimo/);
  assert.match(prompts[1], /"Wi-fi de casa"/);
  assert.match(prompts[1], /desativada pela pessoa/);
});

test("a IA pode pedir uma consulta e responde com os resultados reais", async () => {
  const state = { finances: [
    { id: "f1", date: "2024-03-05", description: "Uber centro", amount: 23.5, type: "despesa", category: "transporte" },
    { id: "f2", date: "2024-03-20", description: "Uber aeroporto", amount: 61, type: "despesa", category: "transporte" },
    { id: "f3", date: "2024-03-21", description: "Mercado", amount: 200, type: "despesa", category: "mercado" },
  ] };
  const messages = [];
  const result = await converse({
    state, message: "quanto gastei com uber em março do ano passado?", categories, now,
    callModel: async ({ message }) => {
      messages.push(message);
      if (messages.length === 1) return { ok: true, parsed: { reply: "", lookups: [{ type: "transactions", query: "uber", from: "2024-03-01", to: "2024-03-31" }] } };
      return { ok: true, parsed: { reply: "Em março de 2024 foram 2 corridas de Uber, R$ 84,50 no total." } };
    },
  });
  assert.equal(messages.length, 2);
  assert.match(messages[1], /RESULTADOS DA CONSULTA/);
  assert.match(messages[1], /"quantidade":2/);
  assert.match(messages[1], /"totalGastos":84.5/);
  assert.doesNotMatch(messages[1], /Mercado/);
  assert.match(result.reply, /R\$ 84,50/);
});

test("notícias e informações atuais vão para a pesquisa na internet, com fontes", async () => {
  let searched = null;
  const result = await converse({
    message: "quais as principais notícias de hoje?", categories, now,
    callModel: async () => ({ ok: true, parsed: { reply: "", lookups: [{ type: "web", query: "principais notícias hoje Brasil" }] } }),
    webSearch: async (input) => { searched = input; return { ok: true, text: "Hoje os destaques são…", sources: [{ title: "g1.globo.com" }, { title: "folha.uol.com.br" }, { title: "g1.globo.com" }] }; },
  });
  assert.equal(searched.query, "principais notícias hoje Brasil");
  assert.equal(result.source, "web");
  assert.match(result.reply, /Hoje os destaques são…\n\nFontes: g1\.globo\.com, folha\.uol\.com\.br$/);
  const failed = await converse({
    message: "cotação do dólar agora", categories, now,
    callModel: async () => ({ ok: true, parsed: { reply: "", lookups: [{ type: "web", query: "cotação dólar" }] } }),
    webSearch: async () => ({ ok: false }),
  });
  assert.match(failed.reply, /não respondeu/);
});

test("'anota:' guarda o texto exatamente como foi escrito", async () => {
  const result = await converse({
    message: "anota: ideia — app de receitas com IA, testar com a Ana em dezembro!!", categories, now,
    callModel: async () => ({ ok: true, parsed: { reply: "Anotado ✍️", actions: [{ type: "add_note", title: "App de receitas", content: "Ideia de app de receitas com IA" }] } }),
  });
  assert.equal(result.actions[0].record.description, "ideia — app de receitas com IA, testar com a Ana em dezembro!!");
  assert.equal(result.actions[0].record.title, "App de receitas");
});

test("simulação de compra: números do simulador, explicação da IA", async () => {
  let prompt = "";
  const result = await askPulsinho({
    question: "posso comprar um tênis de 300?",
    state: { financeAccounts: [{ id: "a", workspaceId: "personal", currentBalance: 2000 }], financialSettings: { safetyReserve: 500 } },
    now,
    callModel: async ({ systemPrompt }) => { prompt = systemPrompt; return { ok: true, provider: "test", parsed: { reply: "Cabe sim! Ainda sobra uma boa margem 😉" } }; },
  });
  assert.equal(result.kind, "simulation");
  assert.match(prompt, /FATOS CALCULADOS/);
  assert.match(prompt, /"valor":300/);
  assert.equal(result.reply, "Cabe sim! Ainda sobra uma boa margem 😉");
});

test("app: 'agenda uma reunião' vai para a IA em vez da resposta pronta de agenda", async () => {
  let calls = 0;
  const result = await askPulsinho({
    state: { events: [{ id: "e", title: "Antigo", date: "2099-01-01" }] },
    question: "agenda uma reunião com o time amanhã às 10h",
    now,
    callModel: async () => {
      calls += 1;
      return { ok: true, provider: "test", parsed: { reply: "Marcado!", actions: [{ type: "add_event", title: "Reunião com o time", date: "2025-01-25", time: "10:00" }] } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].risk, "auto");
  assert.equal(result.actions[0].record.title, "Reunião com o time");
  assert.equal(result.proposedAction, null);
});

test("app: 'oi' responde na hora e exclusões chegam como confirmação", async () => {
  const hi = await askPulsinho({ state: {}, question: "oi", name: "Douglas", now, callModel: async () => { throw new Error("sem IA"); } });
  assert.match(hi.reply, /Douglas/);
  assert.equal(hi.provider, "pulse-engine");
  const del = await askPulsinho({
    state: { tasks: [{ id: "t1", title: "Revisar assinaturas", status: "Pendente" }] },
    question: "apaga a tarefa de revisar assinaturas",
    now,
    callModel: async () => ({ ok: true, parsed: { reply: "Certo.", actions: [{ type: "delete_task", query: "assinaturas" }] } }),
  });
  assert.equal(del.actions[0].risk, "confirm");
  assert.equal(del.actions[0].targetId, "t1");
});

test("frases compostas saem do atalho de comando único quando a IA está disponível", () => {
  assert.equal(looksCompound("gastei 30 no uber e 25 na padaria"), true);
  assert.equal(looksCompound("gastei 20 no almoço e anota que o restaurante é bom"), true);
  assert.equal(looksCompound("me lembra de pagar boleto sexta às 15h, 30 minutos antes"), false);
  assert.equal(looksCompound("gastei 30 dia 5 no mercado"), false);
  assert.equal(parseDeterministicIntent("gastei 30 no uber e 25 na padaria", "2025-01-24", categories, { deferCompound: true }), null);
});

test("chat do app aplica ações com desfazer e pede confirmação para exclusões", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  assert.match(app, /function handlePulsinhoPayload\(payload\)/);
  assert.match(app, /action\.risk !== "auto" \|\| action\.lowConfidence/);
  assert.match(app, /data-pulsinho-undo/);
  assert.match(app, /function confirmPulsinhoActions\(\)/);
  assert.doesNotMatch(app, /command\.length < 3/, "mensagens curtas como 'oi' são aceitas");
  assert.match(app, /pulsenote-pulsinho-thread:/, "conversa do app fica salva entre recarregamentos");
  assert.match(app, /\.slice\(-20\)/, "contexto de 20 mensagens");
  assert.match(app, /stAiNotesSwitch/);
  assert.match(app, /parsed\.aiReadNotes = true/);
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "boards.css"), "utf8");
  assert.match(css, /\.bd-msg-action \{/);
});
