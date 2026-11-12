"use strict";

const PRIVATE_WORKSPACES = new Set(["personal", "couple", "family", "business"]);

async function loadFinanceState(db, uid, workspaceId) {
  const requested = typeof workspaceId === "string" && workspaceId ? workspaceId : "personal";
  if (PRIVATE_WORKSPACES.has(requested)) {
    const snapshot = await db.collection("userData").doc(uid).get();
    return { state: snapshot.exists ? snapshot.data()?.data || {} : {}, workspaceId: requested, shared: false };
  }
  const snapshot = await db.collection("financeSpaces").doc(requested).get();
  if (!snapshot.exists) throw Object.assign(new Error("space_not_found"), { code: "space_not_found" });
  const space = snapshot.data();
  if (!space?.members?.[uid]) throw Object.assign(new Error("space_forbidden"), { code: "space_forbidden" });
  return { state: space.data || {}, workspaceId: requested, shared: true };
}

module.exports = { PRIVATE_WORKSPACES, loadFinanceState };
