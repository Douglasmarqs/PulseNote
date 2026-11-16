const test = require("node:test");
const assert = require("node:assert/strict");
const { createSimulator } = require("./helpers/whatsappSim");

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const baseState = () => ({
  tasks: [
    { id: "t1", title: "Enviar proposta", status: "Pendente", dueDate: today },
    { id: "t2", title: "Comprar ração", status: "Pendente", dueDate: "" },
  ],
  events: [],
  notes: [{ id: "n1", title: "Senha do wifi", description: "abc123" }],
  goals: [{ id: "g1", title: "Viagem para o Chile", current: 1000, target: 5000 }],
  finances: [],
});
const quiet = () => {
  const saved = { info: console.info, warn: console.warn };
  console.info = () => {};
  console.warn = () => {};
  return () => Object.assign(console, saved);
};

test("saudação é respondida na hora, com nome e resumo do dia, sem chamar a IA", async () => {
  const restore = quiet();
  try {
    const state = baseState();
    // Depois das 19h o resumo é de amanhã — uma tarefa em cada dia deixa o
    // teste independente do horário em que roda.
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    state.tasks.push({ id: "t3", title: "Dentista", status: "Pendente", dueDate: tomorrow.toISOString().slice(0, 10) });
    const sim = createSimulator({ state, model: async () => { throw new Error("não deveria chamar a IA"); } });
    const { replies } = await sim.say("bom dia pulsinho");
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /^Bom dia, Douglas! ☀️/);
    assert.match(replies[0].text, /1 tarefa/);
    const how = await sim.say("Boa noite, Pulsinho! Tudo bem?");
    assert.match(how.replies[0].text, /^Boa noite, Douglas!/);
    assert.match(how.replies[0].text, /E (com )?você/);
    const thanks = await sim.say("valeu!");
    assert.match(thanks.replies[0].text, /Douglas|nada|Conta comigo|Por nada/);
    assert.equal(sim.modelCalls.length, 0);
    assert.equal(sim.thread().messages.length, 6, "cada troca entra no histórico da conversa");
  } finally { restore(); }
});

test("uma mensagem com várias intenções vira vários registros, com resumo de cada um", async () => {
  const restore = quiet();
  try {
    const sim = createSimulator({
      state: baseState(),
      model: async ({ message, system }) => {
        assert.match(system, /Pulsinho/);
        assert.match(system, /Douglas/);
        assert.match(system, /abc123/, "com a leitura de notas permitida, o conteúdo ajuda a responder");
        assert.match(message, /gastei 30 no uber e 25 na padaria/);
        return {
          reply: "Feito!",
          actions: [
            { type: "add_transaction", amount: 30, transactionType: "despesa", categoryId: "transporte", title: "Uber", categoryConfidence: "alta" },
            { type: "add_transaction", amount: 25, transactionType: "despesa", categoryId: "alimentacao", title: "Padaria", categoryConfidence: "alta" },
            { type: "add_task", title: "Pagar a luz", date: "2099-03-10", time: "9", reminderMinutes: 0 },
          ],
        };
      },
    });
    const { replies } = await sim.say("gastei 30 no uber e 25 na padaria, e me lembra de pagar a luz dia 10/03/2099 às 9h");
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /Feito!/);
    assert.match(replies[0].text, /R\$\s*30,00 — Uber/);
    assert.match(replies[0].text, /R\$\s*25,00 — Padaria/);
    assert.match(replies[0].text, /Tarefa “Pagar a luz” — 10\/03\/2099 às 09:00 \(lembrete na hora\)/);
    const state = sim.state();
    assert.deepEqual(state.finances.map((f) => [f.description, f.amount, f.category, f.source]), [
      ["Padaria", 25, "alimentacao", "whatsapp"], ["Uber", 30, "transporte", "whatsapp"],
    ]);
    assert.ok(state.finances.every((f) => /^wa_/.test(f.id)));
    assert.equal(state.tasks[0].title, "Pagar a luz");
    assert.equal(state.tasks[0].dueTime, "09:00");
    assert.equal(state.tasks[0].reminder, 0);
  } finally { restore(); }
});

test("saudação junto com pedido: cumprimenta e, sem IA, registra pelo caminho de reserva", async () => {
  const restore = quiet();
  try {
    const sim = createSimulator({ state: baseState(), model: async () => { throw new Error("comando claro não usa IA"); } });
    const { replies } = await sim.say("Oi Pulsinho! gastei 45 no mercado");
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /^(Oi|Olá|E aí), Douglas! 👋\n✅ Novo Gasto Registrado!/);
    assert.equal(sim.state().finances[0].category, "mercado");
  } finally { restore(); }
});

test("conversa livre usa o histórico: o 'sim' responde à sugestão anterior", async () => {
  const restore = quiet();
  try {
    const sim = createSimulator({
      state: baseState(),
      model: async ({ conversation, message }) => {
        if (/assinaturas/.test(message)) {
          return { reply: "Suas assinaturas somam pouco este mês. Quer que eu crie uma tarefa para revisá-las no sábado?", actions: [] };
        }
        assert.equal(message, "sim");
        assert.ok(conversation.some((m) => m.role === "assistant" && /revisá-las no sábado\?/.test(m.content)), "histórico chega ao modelo");
        return { reply: "Combinado!", actions: [{ type: "add_task", title: "Revisar assinaturas", date: "2099-01-03" }] };
      },
    });
    const first = await sim.say("o que você acha dos meus gastos com assinaturas?");
    assert.match(first.replies[0].text, /Quer que eu crie uma tarefa/);
    const second = await sim.say("sim");
    assert.match(second.replies[0].text, /Combinado!\n\n📋 Tarefa “Revisar assinaturas”/);
    assert.equal(sim.state().tasks[0].title, "Revisar assinaturas");
  } finally { restore(); }
});

test("exclusão pedida em conversa sempre pede confirmação e só apaga com o 'sim'", async () => {
  const restore = quiet();
  try {
    const sim = createSimulator({
      state: baseState(),
      model: async () => ({ reply: "Certo.", actions: [{ type: "delete_note", targetId: "n1" }] }),
    });
    const ask = await sim.say("pode tirar aquela nota da senha do wifi?");
    assert.equal(ask.replies[0].kind, "buttons");
    assert.deepEqual(ask.replies[0].buttons, ["pa:yes", "pa:no"]);
    assert.match(ask.replies[0].text, /Excluir a nota “Senha do wifi”/);
    assert.equal(sim.state().notes.length, 1, "nada é apagado antes da confirmação");

    const cancel = await sim.press("pa:no");
    assert.match(cancel.replies[0].text, /cancelei/);
    assert.equal(sim.state().notes.length, 1);
    assert.equal(sim.state().whatsappPendingAssistantAction, null, "pendência é limpa de verdade (merge profundo do Firestore)");

    await sim.say("pode tirar aquela nota da senha do wifi?");
    const yes = await sim.say("sim, pode");
    assert.match(yes.replies[0].text, /✅ Pronto!\n🗑️ Excluído: “Senha do wifi”/);
    assert.equal(sim.state().notes.length, 0);

    const again = await sim.press("pa:yes");
    assert.match(again.replies[0].text, /expirou ou foi usada/);
  } finally { restore(); }
});

test("concluir tarefa e avançar meta por conversa", async () => {
  const restore = quiet();
  try {
    const sim = createSimulator({
      state: baseState(),
      model: async () => ({
        reply: "Mandou bem! 🎉",
        actions: [
          { type: "complete_task", targetId: "t1" },
          { type: "update_goal", query: "chile", value: 500, mode: "delta" },
        ],
      }),
    });
    const { replies } = await sim.say("já mandei a proposta pro cliente e guardei 500 pra viagem do Chile");
    assert.match(replies[0].text, /✅ Tarefa concluída: “Enviar proposta”/);
    assert.match(replies[0].text, /🎯 Meta “Viagem para o Chile”: 1\.500\/5\.000 \(30%\)/);
    const state = sim.state();
    assert.equal(state.tasks.find((t) => t.id === "t1").status, "Concluida");
    assert.equal(state.goals[0].current, 1500);
  } finally { restore(); }
});

test("gasto com categoria incerta pergunta a categoria em vez de chutar", async () => {
  const restore = quiet();
  try {
    const sim = createSimulator({
      state: baseState(),
      model: async () => ({
        reply: "Anotado!",
        actions: [{ type: "add_transaction", amount: 80, transactionType: "despesa", categoryId: "lazer", title: "Presente da Ana", categoryConfidence: "baixa", categoryAlternatives: ["presentes", "eventos"] }],
      }),
    });
    const ask = await sim.say("saiu 80 conto naquilo da Ana ontem");
    assert.match(ask.replies[0].text, /Me diz o número:\n1\) 🎬 Lazer\n2\) 🎁 Presentes\n3\) 🎉 Festas e Eventos/);
    assert.equal(sim.state().finances.length, 0);
    const pick = await sim.say("2");
    assert.match(pick.replies[0].text, /Novo Gasto Registrado/);
    assert.equal(sim.state().finances[0].category, "presentes");
  } finally { restore(); }
});

test("sem IA disponível, o caminho antigo continua respondendo", async () => {
  const restore = quiet();
  const originalError = console.error;
  console.error = () => {};
  try {
    const sim = createSimulator({ state: baseState(), gatewayFails: true });
    const greet = await sim.say("e aí pulsinho");
    assert.match(greet.replies[0].text, /^(Oi|Olá|E aí), Douglas!/);
    const task = await sim.say("me lembra de ligar pro João amanhã às 10h");
    assert.match(task.replies[0].text, /Tarefa criada: "ligar pro João"/);
  } finally {
    console.error = originalError;
    restore();
  }
});

test("comandos claros também passam pela IA quando ela está disponível", async () => {
  const restore = quiet();
  try {
    const sim = createSimulator({
      state: baseState(),
      model: async ({ message }) => {
        assert.equal(message, "minhas tarefas");
        return { reply: "Você tem 2 pendências:\n• Enviar proposta — hoje\n• Comprar ração", actions: [] };
      },
    });
    const { replies } = await sim.say("minhas tarefas");
    assert.equal(replies[0].text, "Você tem 2 pendências:\n• Enviar proposta — hoje\n• Comprar ração");
    assert.equal(sim.modelCalls.length, 1);
  } finally { restore(); }
});

test("'apagar último gasto' pede confirmação antes de excluir", async () => {
  const restore = quiet();
  try {
    const state = baseState();
    state.finances = [{ id: "wa_11111111-2222-3333-4444-555555555555", source: "whatsapp", type: "despesa", amount: 45, description: "Mercado", category: "mercado", date: today }];
    const sim = createSimulator({ state, model: async () => { throw new Error("não usa IA"); } });
    const ask = await sim.say("apagar último gasto");
    assert.equal(ask.replies[0].kind, "buttons");
    assert.match(ask.replies[0].text, /Excluir o gasto de R\$ 45,00 — Mercado/);
    assert.equal(sim.state().finances.length, 1, "nada é apagado sem o botão");
    const done = await sim.press("fin:confirm_delete:wa_11111111-2222-3333-4444-555555555555");
    assert.match(done.replies[0].text, /Excluí “Mercado”/);
    assert.equal(sim.state().finances.length, 0);
  } finally { restore(); }
});

test("memória do WhatsApp guarda as últimas 20 mensagens", async () => {
  const restore = quiet();
  try {
    const sim = createSimulator({ state: baseState(), model: async () => ({ reply: "Certo!", actions: [] }) });
    for (let i = 0; i < 12; i += 1) await sim.say(`me conta uma curiosidade número ${i}`);
    const thread = sim.thread();
    assert.equal(thread.messages.length, 20);
    assert.match(thread.messages.at(-2).content, /número 11/);
  } finally { restore(); }
});

test("sem IA, 'apaga a tarefa' também pede confirmação e aceita 'sim'", async () => {
  const restore = quiet();
  const originalError = console.error;
  console.error = () => {};
  try {
    const sim = createSimulator({ state: baseState(), gatewayFails: true });
    const ask = await sim.say("apaga a tarefa comprar ração");
    assert.match(ask.replies[0].text, /Excluir a tarefa “Comprar ração”\? Responda \*1\*/);
    assert.equal(sim.state().tasks.length, 2);
    const yes = await sim.say("sim");
    assert.match(yes.replies[0].text, /Apaguei a tarefa "Comprar ração"/);
    assert.equal(sim.state().tasks.length, 1);
  } finally {
    console.error = originalError;
    restore();
  }
});

test("boas-vindas da vinculação: saudação com nome, guia completo e link de privacidade", () => {
  const { buildWelcomeMessages } = require("../api/whatsapp-webhook")._test;
  const [hello, guide, closing] = buildWelcomeMessages("Douglas Marques");
  assert.match(hello, /^Oi, Douglas! 💜/);
  for (const topic of ["Finanças", "Tarefas e lembretes", "Agenda", "Notas", "Metas", "Internet", "áudio", "confirmação"]) assert.match(guide, new RegExp(topic));
  assert.ok(guide.length < 4000, "cabe numa mensagem do WhatsApp");
  assert.match(closing, /\/privacy$/);
  assert.match(buildWelcomeMessages("")[0], /^Oi! 💜/);
});
