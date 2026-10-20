const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTextIntent, findBestMatches } = require("../api/_lib/parseCommandIntent");
const { _test: {
  deleteTaskByQuery, deleteNoteByQuery, selectPendingDelete, clearPendingDelete, formatDeleteChoices,
  financeDeletionTarget, deleteLastWhatsAppEntry,
} } = require("../api/whatsapp-webhook");

function firebaseWithState(initialState) {
  let state = structuredClone(initialState);
  const ref = { path: "userData/test-user" };
  const db = {
    collection: () => ({ doc: () => ref }),
    runTransaction: async (work) => {
      let next;
      await work({
        get: async () => ({ exists: true, data: () => ({ data: structuredClone(state) }) }),
        set: (_ref, value) => { next = value.data; },
      });
      if (next) state = next;
    },
  };
  return { fb: { firestore: () => db }, state: () => state };
}

test("comandos de excluir tarefa e nota chegam às intenções destrutivas", async () => {
  for (const [text, intent] of [["apaga a tarefa mercado", "task_action"], ["apaga a nota mercado", "note_action"]]) {
    const result = await parseTextIntent({ text, categories: [], today: "2026-10-19", aiEnabled: false });
    assert.equal(result.intent, intent);
    assert.equal(result.task?.action || result.note?.action, "delete");
  }
});

test("preposição opcional não corta o começo do título de tarefa ou nota", async () => {
  for (const [text, kind, query] of [
    ["apaga a tarefa dentista", "task", "dentista"],
    ["apaga a tarefa de dentista", "task", "dentista"],
    ["apaga a nota devolução", "note", "devolução"],
    ["apaga a nota sobre devolução", "note", "devolução"],
  ]) {
    const result = await parseTextIntent({ text, categories: [], today: "2026-10-19", aiEnabled: false });
    assert.equal(result[kind]?.query, query, text);
  }
});

test("busca empatada preserva todos os candidatos sem alterar o matcher dos demais comandos", () => {
  const items = [{ id: "a", title: "Mercado BH" }, { id: "b", title: "Mercado Central" }];
  assert.deepEqual(findBestMatches("mercado", items).map((item) => item.id), ["a", "b"]);
  assert.deepEqual(findBestMatches("mercado bh", items).map((item) => item.id), ["a"]);
});

test("exclusão ambígua de tarefa não remove a primeira; número remove apenas o ID escolhido", async () => {
  const { fb, state } = firebaseWithState({ tasks: [
    { id: "t1", title: "Comprar pão", dueDate: "2026-10-20" },
    { id: "t2", title: "Comprar bolo", dueDate: "2026-10-21" },
  ] });
  const offered = await deleteTaskByQuery(fb, "test-user", "comprar");
  assert.equal(offered.status, "ambiguous");
  assert.match(formatDeleteChoices(offered), /Responda com o número/);
  assert.deepEqual(state().tasks.map((item) => item.id), ["t1", "t2"]);
  assert.equal((await selectPendingDelete(fb, "test-user", 3)).status, "invalid");
  assert.deepEqual(state().tasks.map((item) => item.id), ["t1", "t2"]);
  const chosen = await selectPendingDelete(fb, "test-user", 2);
  assert.equal(chosen.status, "deleted");
  assert.equal(chosen.item.id, "t2");
  assert.deepEqual(state().tasks.map((item) => item.id), ["t1"]);
  assert.equal(state().whatsappPendingDelete, null);
});

test("notas com título idêntico pedem desambiguação, inclusive ao buscar no conteúdo", async () => {
  const { fb, state } = firebaseWithState({ notes: [
    { id: "n1", title: "Ideia", description: "roteiro viagem" },
    { id: "n2", title: "Ideia", description: "roteiro filme" },
  ] });
  const offered = await deleteNoteByQuery(fb, "test-user", "ideia");
  assert.equal(offered.status, "ambiguous");
  assert.equal(state().notes.length, 2);
  await clearPendingDelete(fb, "test-user");
  assert.equal(state().notes.length, 2);
  const contentMatch = await deleteNoteByQuery(fb, "test-user", "roteiro");
  assert.equal(contentMatch.status, "ambiguous");
  assert.equal(state().notes.length, 2);
});

test("item removido no app e escolha expirada nunca apagam outro item", async () => {
  const { fb, state } = firebaseWithState({ tasks: [
    { id: "t1", title: "Mercado BH" }, { id: "t2", title: "Mercado Central" },
  ] });
  await deleteTaskByQuery(fb, "test-user", "mercado");
  state().tasks = [{ id: "t1", title: "Mercado BH" }];
  assert.equal((await selectPendingDelete(fb, "test-user", 2)).status, "missing");
  assert.deepEqual(state().tasks.map((item) => item.id), ["t1"]);
  state().tasks.push({ id: "t2", title: "Mercado Central" });
  await deleteTaskByQuery(fb, "test-user", "mercado");
  state().whatsappPendingDelete.createdAt = "2020-01-01T00:00:00.000Z";
  assert.equal((await selectPendingDelete(fb, "test-user", 1)).status, "expired");
  assert.equal(state().tasks.length, 2);
});

test("mais de dez candidatos não oferece seleção incompleta", async () => {
  const tasks = Array.from({ length: 11 }, (_, index) => ({ id: `t${index}`, title: `Mercado ${index}` }));
  const { fb, state } = firebaseWithState({ tasks });
  assert.equal((await deleteTaskByQuery(fb, "test-user", "mercado")).status, "too_many");
  assert.equal(state().tasks.length, 11);
  assert.equal(state().whatsappPendingDelete, null);
});

test("exclusão financeira sem posição não escolhe um lançamento por conta própria", () => {
  for (const command of ["cancelar", "apagar", "excluir a", "apagar gasto", "apagar a receita", "cancelar o registro", "cancelar o ultimo", "excluir penultimo"]) {
    assert.equal(financeDeletionTarget(command).underspecified, true, command);
  }
  assert.equal(financeDeletionTarget("apagar ultimo").underspecified, false);
  assert.equal(financeDeletionTarget("cancela isso ai"), null);
  assert.equal(financeDeletionTarget("exclua isso"), null);
});

test("o mutador financeiro rejeita alvo vago ou ausente mesmo se chamado fora do handler", async () => {
  const { fb, state } = firebaseWithState({ finances: [
    { id: "r2", source: "whatsapp", type: "receita", description: "Salário" },
    { id: "r1", source: "whatsapp", type: "receita", description: "Freela" },
  ] });
  assert.equal(await deleteLastWhatsAppEntry(fb, "test-user"), undefined);
  assert.equal(await deleteLastWhatsAppEntry(fb, "test-user", financeDeletionTarget("apagar a receita")), undefined);
  assert.deepEqual(state().finances.map((entry) => entry.id), ["r2", "r1"]);
});

test("última receita e penúltimo gasto respeitam tipo e posição informados", async () => {
  const { fb, state } = firebaseWithState({ finances: [
    { id: "g3", source: "whatsapp", type: "despesa", description: "Café" },
    { id: "r2", source: "whatsapp", type: "receita", description: "Salário" },
    { id: "g2", source: "whatsapp", type: "despesa", description: "Almoço" },
    { id: "g1", source: "whatsapp", type: "despesa", description: "Pão" },
    { id: "r1", source: "app", type: "receita", description: "Venda" },
  ] });
  assert.equal((await deleteLastWhatsAppEntry(fb, "test-user", financeDeletionTarget("apagar a ultima receita"))).id, "r2");
  assert.equal((await deleteLastWhatsAppEntry(fb, "test-user", financeDeletionTarget("apagar o penultimo gasto"))).id, "g2");
  assert.deepEqual(state().finances.map((item) => item.id), ["g3", "g1", "r1"]);
  assert.equal(await deleteLastWhatsAppEntry(fb, "test-user", financeDeletionTarget("apagar a receita")), undefined);
  assert.deepEqual(state().finances.map((item) => item.id), ["g3", "g1", "r1"]);
});
