const crypto = require("node:crypto");
const { buildSuggestions, findSuggestion, applySuggestionAction } = require("./autopilot");

function serviceError(code, status) {
  return Object.assign(new Error(code), { status });
}

function userReference(db, uid) {
  if (typeof uid !== "string" || !uid.trim()) throw serviceError("unauthorized", 401);
  return db.collection("userData").doc(uid);
}

function executionReference(db, uid, reference) {
  const code = reference.startsWith("ap_") ? reference.slice(3, 13) : reference;
  const id = crypto.createHash("sha256").update(JSON.stringify([uid, code])).digest("hex");
  return db.collection("autopilotExecutions").doc(id);
}

async function listAutopilotSuggestions(db, uid, now = new Date()) {
  const snapshot = await userReference(db, uid).get();
  const state = snapshot.exists ? snapshot.data()?.data || {} : {};
  return buildSuggestions(state, now);
}

// Confirmed actions are checked against the latest Firestore snapshot inside
// a transaction. The separate execution document is not writable by clients
// (firestore.rules) and makes retries/repeated WhatsApp messages idempotent.
async function executeAutopilotSuggestion(db, uid, input, now = new Date()) {
  if (input?.confirm !== true) throw serviceError("confirmation_required", 400);
  const reference = typeof input.suggestionId === "string" ? input.suggestionId.trim().toLowerCase() : "";
  if (!/^(?:ap_[a-f0-9]{20}|[a-f0-9]{10})$/.test(reference)) {
    throw serviceError("invalid_suggestion_id", 400);
  }
  if (typeof input.action !== "string" || !/^[a-z_]{3,48}$/.test(input.action)) {
    throw serviceError("invalid_action", 400);
  }

  const userRef = userReference(db, uid);
  // A short WhatsApp code resolves to a full ID from the user's own current
  // suggestions; the receipt always uses the full ID, so no code collision can
  // result in an action on another user's data.
  return db.runTransaction(async (tx) => {
    const userSnapshot = await tx.get(userRef);
    if (!userSnapshot.exists) throw serviceError("user_data_not_found", 404);
    const state = userSnapshot.data()?.data || {};
    const currentSuggestions = buildSuggestions(state, now);
    const suggestion = findSuggestion(currentSuggestions, reference);

    // The 10-character code also locates the receipt after the original
    // suggestion disappears. A hash collision is rejected, never replayed as
    // another suggestion's action.
    const receiptRef = executionReference(db, uid, reference);
    const prior = await tx.get(receiptRef);
    if (prior.exists) {
      const receipt = prior.data();
      if (suggestion && receipt.suggestionId !== suggestion.id) throw serviceError("suggestion_code_collision", 409);
      if (/^ap_/.test(reference) && receipt.suggestionId !== reference) throw serviceError("suggestion_code_collision", 409);
      if (receipt.action !== input.action) throw serviceError("suggestion_already_executed", 409);
      return { ok: true, alreadyExecuted: true, suggestionId: receipt.suggestionId, action: input.action, result: receipt.result };
    }

    if (!suggestion) throw serviceError("stale_suggestion", 409);
    const { patch, result } = applySuggestionAction(state, suggestion, input.action, now);
    const changes = { updatedAt: now.toISOString() };
    for (const [field, value] of Object.entries(patch)) changes[`data.${field}`] = value;
    tx.update(userRef, changes);
    tx.create(receiptRef, {
      uid,
      suggestionId: suggestion.id,
      action: input.action,
      createdAt: now.toISOString(),
      result,
    });
    return { ok: true, alreadyExecuted: false, suggestionId: suggestion.id, action: input.action, result };
  });
}

module.exports = { listAutopilotSuggestions, executeAutopilotSuggestion };
