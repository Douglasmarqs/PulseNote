const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSuggestions, findSuggestion, formatSuggestionsForWhatsApp } = require("../api/_lib/autopilot");
const { listAutopilotSuggestions, executeAutopilotSuggestion } = require("../api/_lib/autopilotService");
const { checkAutopilotAccess } = require("../api/_lib/autopilotAccess");

const NOW = new Date("2026-10-13T15:00:00.000Z"); // 12:00 in Sao Paulo

function exampleState() {
  return {
    timeZone: "America/Sao_Paulo",
    tasks: [{ id: "task-1", title: "Pagar boleto", status: "Pendente", priority: "Alta", dueDate: "2026-10-10", subtasks: [] }],
    events: [{ id: "event-1", title: "Consulta", date: "2026-10-14", time: "09:00", location: "Centro" }],
    notes: [{ id: "note-1", title: "Preparar viagem", checklist: [
      { id: "item-1", text: "Separar documentos", done: false },
      { id: "item-2", text: "Comprar passagem", done: true },
    ] }],
    finGoals: [{ id: "limit-1", categoryId: "mercado", limit: 100 }],
    finances: [{ id: "finance-1", type: "despesa", category: "mercado", amount: 95.25, date: "2026-10-12" }],
    customCategories: [{ id: "mercado", label: "🛒 Mercado" }],
  };
}

function fakeFirestore(uid, state) {
  const documents = new Map([[`userData/${uid}`, { data: structuredClone(state), updatedAt: NOW.toISOString() }]]);
  const ref = (path) => ({ path, get: async () => snapshot({ path }) });
  const snapshot = (documentRef) => {
    const data = documents.get(documentRef.path);
    return { exists: data !== undefined, data: () => structuredClone(data) };
  };
  return {
    documents,
    collection(name) { return { doc(id) { return ref(`${name}/${id}`); } }; },
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        get: async (documentRef) => snapshot(documentRef),
        update: (documentRef, changes) => writes.push({ operation: "update", path: documentRef.path, changes }),
        create: (documentRef, data) => writes.push({ operation: "create", path: documentRef.path, data }),
      };
      const result = await callback(tx);
      for (const write of writes) {
        if (write.operation === "create") {
          if (documents.has(write.path)) throw new Error("already_exists");
          documents.set(write.path, structuredClone(write.data));
        } else {
          const current = documents.get(write.path);
          for (const [field, value] of Object.entries(write.changes)) {
            const segments = field.split(".");
            let target = current;
            for (const segment of segments.slice(0, -1)) target = target[segment];
            target[segments.at(-1)] = structuredClone(value);
          }
        }
      }
      return result;
    },
    state() { return structuredClone(documents.get(`userData/${uid}`).data); },
  };
}

test("suggestions are deterministic, cross-domain, scoped and actionable", () => {
  const state = exampleState();
  const first = buildSuggestions(state, NOW);
  const second = buildSuggestions(structuredClone(state), NOW);
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first.map((item) => item.kind)), new Set([
    "overdue_task", "upcoming_event", "pending_checklist", "category_limit",
  ]));
  assert.ok(first.every((item) => item.id.startsWith("ap_") && item.code.length === 10));
  assert.ok(first.every((item) => item.description && item.source && item.actionOptions.length));
  assert.equal(first.find((item) => item.kind === "category_limit").metadata.spent, 95.25);
  assert.match(formatSuggestionsForWhatsApp(first), /Nenhuma mudança é feita automaticamente/);
});

test("completed tasks and resolved checklists do not produce stale advice", () => {
  const state = exampleState();
  state.tasks[0].status = "Concluida";
  state.notes[0].checklist[0].done = true;
  state.finances[0].amount = 20;
  assert.deepEqual(buildSuggestions(state, NOW).map((item) => item.kind), ["upcoming_event"]);
});

test("execution requires explicit confirmation and is idempotent across short codes", async () => {
  const uid = "user-a";
  const db = fakeFirestore(uid, exampleState());
  const suggestion = (await listAutopilotSuggestions(db, uid, NOW)).find((item) => item.kind === "overdue_task");
  assert.ok(findSuggestion(await listAutopilotSuggestions(db, uid, NOW), suggestion.code));
  await assert.rejects(
    executeAutopilotSuggestion(db, uid, { suggestionId: suggestion.id, action: "complete_task" }, NOW),
    { message: "confirmation_required", status: 400 },
  );
  assert.equal(db.state().tasks[0].status, "Pendente");

  const input = { suggestionId: suggestion.code.toUpperCase(), action: "complete_task", confirm: true };
  const first = await executeAutopilotSuggestion(db, uid, input, NOW);
  assert.equal(first.ok, true);
  assert.equal(first.alreadyExecuted, false);
  assert.equal(db.state().tasks[0].status, "Concluida");
  assert.equal(db.state().tasks[0].completedAt, "2026-10-13");

  const replay = await executeAutopilotSuggestion(db, uid, input, NOW);
  assert.equal(replay.alreadyExecuted, true);
  assert.equal(db.state().tasks.length, 1);
  await assert.rejects(
    executeAutopilotSuggestion(db, uid, { ...input, action: "reschedule_task_tomorrow" }, NOW),
    { message: "suggestion_already_executed", status: 409 },
  );
  assert.equal([...db.documents.keys()].filter((path) => path.startsWith("autopilotExecutions/")).length, 1);
});

test("changed source data makes a previously displayed suggestion stale", async () => {
  const uid = "user-b";
  const db = fakeFirestore(uid, exampleState());
  const oldSuggestion = (await listAutopilotSuggestions(db, uid, NOW)).find((item) => item.kind === "category_limit");
  db.documents.get(`userData/${uid}`).data.finances[0].amount = 25;
  await assert.rejects(
    executeAutopilotSuggestion(db, uid, { suggestionId: oldSuggestion.id, action: "create_budget_review_task", confirm: true }, NOW),
    { message: "stale_suggestion", status: 409 },
  );
  assert.equal(db.state().tasks.length, 1);
});

test("note checklist action marks exactly one item; conversion creates a linked task", async () => {
  const uid = "user-c";
  const state = exampleState();
  state.notes[0].checklist.push({ id: "item-3", text: "Reservar hotel", done: false });
  const db = fakeFirestore(uid, state);
  const firstSuggestion = (await listAutopilotSuggestions(db, uid, NOW)).find((item) => item.kind === "pending_checklist");
  await executeAutopilotSuggestion(db, uid, { suggestionId: firstSuggestion.id, action: "mark_checklist_item", confirm: true }, NOW);
  assert.equal(db.state().notes[0].checklist[0].done, true);
  assert.equal(db.state().notes[0].checklist[2].done, false);

  const nextSuggestion = (await listAutopilotSuggestions(db, uid, NOW)).find((item) => item.kind === "pending_checklist");
  const result = await executeAutopilotSuggestion(db, uid, { suggestionId: nextSuggestion.id, action: "convert_note_to_task", confirm: true }, NOW);
  const nextState = db.state();
  assert.equal(result.result.type, "task");
  assert.equal(nextState.tasks[0].sourceNoteId, "note-1");
  assert.equal(nextState.tasks[0].subtasks.length, 1);
  assert.equal(nextState.notes[0].convertedToTaskId, nextState.tasks[0].id);
});

test("budget action creates one review task without touching unrelated fields", async () => {
  const uid = "user-d";
  const db = fakeFirestore(uid, exampleState());
  const suggestion = (await listAutopilotSuggestions(db, uid, NOW)).find((item) => item.kind === "category_limit");
  const originalFinance = db.state().finances;
  await executeAutopilotSuggestion(db, uid, { suggestionId: suggestion.id, action: "create_budget_review_task", confirm: true }, NOW);
  assert.equal(db.state().tasks[0].autopilotSource, "budget:2026-10:mercado");
  assert.deepEqual(db.state().finances, originalFinance);
  assert.equal(buildSuggestions(db.state(), NOW).some((item) => item.kind === "category_limit"), false);
});

test("admin maintenance, feature flag and subscription gate Autopilot", async () => {
  const uid = "user-e";
  const db = fakeFirestore(uid, exampleState());
  assert.equal((await checkAutopilotAccess(db, uid)).allowed, true); // legacy account

  db.documents.set("systemConfig/global", { maintenance: { enabled: true }, features: { autopilot: true } });
  await assert.rejects(checkAutopilotAccess(db, uid), { code: "maintenance", status: 503 });

  db.documents.set("systemConfig/global", { maintenance: { enabled: false }, features: { autopilot: false } });
  await assert.rejects(checkAutopilotAccess(db, uid), { code: "feature_disabled", status: 503 });

  db.documents.set("systemConfig/global", { maintenance: { enabled: false }, features: { autopilot: true } });
  db.documents.set(`adminEntitlements/${uid}`, { planId: "starter" });
  db.documents.set("adminPlans/starter", { active: true, features: { autopilot: false } });
  await assert.rejects(checkAutopilotAccess(db, uid), { code: "plan", status: 403 });

  db.documents.set("adminPlans/starter", { active: true, features: { autopilot: true } });
  assert.equal((await checkAutopilotAccess(db, uid)).allowed, true);
});
