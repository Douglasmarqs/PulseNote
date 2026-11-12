"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { FieldValue, getFirebaseAdmin } = require("./_lib/firebaseAdmin");
const {
  canEditFinanceSpace,
  cleanText,
  normalizeEmail,
  publicFinanceSpace,
  roleFor,
  sanitizeFinanceSpaceData,
} = require("./_lib/financeSpaces");

function bodyOf(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body && typeof req.body === "object" ? req.body : null;
}

function bearer(req) {
  return /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1] || "";
}

function inviteId(spaceId, email) {
  return createHash("sha256").update(`${spaceId}:${email}`).digest("hex").slice(0, 40);
}

async function listSpaces(db, decoded) {
  const email = normalizeEmail(decoded.email);
  const [spacesSnapshot, invitesSnapshot] = await Promise.all([
    db.collection("financeSpaces").where("memberUids", "array-contains", decoded.uid).limit(30).get(),
    email
      ? db.collection("financeSpaceInvites").where("inviteeEmail", "==", email).limit(30).get()
      : Promise.resolve({ docs: [] }),
  ]);
  const spaces = spacesSnapshot.docs.map((doc) => publicFinanceSpace(doc.data(), decoded.uid, doc.id));
  const invites = invitesSnapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((invite) => invite.status === "pending")
    .map((invite) => ({
      id: invite.id,
      spaceId: invite.spaceId,
      spaceName: cleanText(invite.spaceName, 70),
      inviterName: cleanText(invite.inviterName, 70),
      role: invite.role === "viewer" ? "viewer" : "editor",
    }));
  return { spaces, invites };
}

async function createSpace(db, decoded, body) {
  const name = cleanText(body.name, 70);
  const type = ["couple", "family", "group"].includes(body.type) ? body.type : "group";
  if (name.length < 2) return { status: 400, payload: { error: "invalid_name" } };
  const id = randomUUID();
  const member = {
    uid: decoded.uid,
    name: cleanText(decoded.name, 70) || "Proprietário",
    email: normalizeEmail(decoded.email),
    role: "owner",
    joinedAt: new Date().toISOString(),
  };
  const space = {
    name,
    type,
    ownerUid: decoded.uid,
    memberUids: [decoded.uid],
    members: { [decoded.uid]: member },
    revision: 0,
    data: sanitizeFinanceSpaceData({}, id),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.collection("financeSpaces").doc(id).set(space);
  return { status: 201, payload: { ok: true, space: publicFinanceSpace({ ...space, createdAt: null, updatedAt: null }, decoded.uid, id) } };
}

async function inviteMember(db, decoded, body) {
  const spaceId = cleanText(body.spaceId, 128);
  const email = normalizeEmail(body.email);
  const role = body.role === "viewer" ? "viewer" : "editor";
  if (!spaceId || !email || email === normalizeEmail(decoded.email)) return { status: 400, payload: { error: "invalid_invite" } };
  const ref = db.collection("financeSpaces").doc(spaceId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { status: 404, payload: { error: "space_not_found" } };
  const space = snapshot.data();
  if (roleFor(space, decoded.uid) !== "owner") return { status: 403, payload: { error: "owner_required" } };
  if (Object.values(space.members || {}).some((member) => normalizeEmail(member.email) === email)) {
    return { status: 409, payload: { error: "already_member" } };
  }
  if (Object.keys(space.members || {}).length >= 12) return { status: 409, payload: { error: "member_limit" } };
  await db.collection("financeSpaceInvites").doc(inviteId(spaceId, email)).set({
    spaceId,
    spaceName: cleanText(space.name, 70),
    inviteeEmail: email,
    inviterUid: decoded.uid,
    inviterName: cleanText(decoded.name, 70) || "Um usuário do PulseNote",
    role,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { status: 200, payload: { ok: true } };
}

async function acceptInvite(db, decoded, body) {
  const id = cleanText(body.inviteId, 128);
  const email = normalizeEmail(decoded.email);
  if (!id || !email) return { status: 400, payload: { error: "invalid_invite" } };
  let acceptedSpace;
  await db.runTransaction(async (transaction) => {
    const inviteRef = db.collection("financeSpaceInvites").doc(id);
    const inviteSnapshot = await transaction.get(inviteRef);
    if (!inviteSnapshot.exists) throw Object.assign(new Error("invite_not_found"), { code: "invite_not_found" });
    const invite = inviteSnapshot.data();
    if (invite.status !== "pending" || normalizeEmail(invite.inviteeEmail) !== email) {
      throw Object.assign(new Error("invite_forbidden"), { code: "invite_forbidden" });
    }
    const spaceRef = db.collection("financeSpaces").doc(invite.spaceId);
    const spaceSnapshot = await transaction.get(spaceRef);
    if (!spaceSnapshot.exists) throw Object.assign(new Error("space_not_found"), { code: "space_not_found" });
    const space = spaceSnapshot.data();
    const members = { ...(space.members || {}) };
    members[decoded.uid] = {
      uid: decoded.uid,
      name: cleanText(decoded.name, 70) || "Membro",
      email,
      role: invite.role === "viewer" ? "viewer" : "editor",
      joinedAt: new Date().toISOString(),
    };
    transaction.update(spaceRef, {
      members,
      memberUids: [...new Set([...(space.memberUids || []), decoded.uid])],
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(inviteRef, { status: "accepted", acceptedBy: decoded.uid, updatedAt: FieldValue.serverTimestamp() });
    acceptedSpace = { ...space, id: invite.spaceId, members, memberUids: [...new Set([...(space.memberUids || []), decoded.uid])] };
  });
  return { status: 200, payload: { ok: true, space: publicFinanceSpace(acceptedSpace, decoded.uid, acceptedSpace.id) } };
}

async function saveSpace(db, decoded, body) {
  const spaceId = cleanText(body.spaceId, 128);
  if (!spaceId) return { status: 400, payload: { error: "invalid_space" } };
  const ref = db.collection("financeSpaces").doc(spaceId);
  const data = sanitizeFinanceSpaceData(body.data, spaceId);
  let nextRevision = 0;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw Object.assign(new Error("space_not_found"), { code: "space_not_found" });
    const space = snapshot.data();
    if (!canEditFinanceSpace(space, decoded.uid)) throw Object.assign(new Error("space_read_only"), { code: "space_read_only" });
    const revision = Number.isInteger(space.revision) ? space.revision : 0;
    if (Number(body.revision) !== revision) throw Object.assign(new Error("space_conflict"), { code: "space_conflict" });
    nextRevision = revision + 1;
    transaction.update(ref, { data, revision: nextRevision, updatedAt: FieldValue.serverTimestamp() });
  });
  return { status: 200, payload: { ok: true, revision: nextRevision } };
}

async function leaveSpace(db, decoded, body) {
  const spaceId = cleanText(body.spaceId, 128);
  const ref = db.collection("financeSpaces").doc(spaceId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { status: 404, payload: { error: "space_not_found" } };
  const space = snapshot.data();
  const role = roleFor(space, decoded.uid);
  if (!role) return { status: 403, payload: { error: "space_forbidden" } };
  if (role === "owner") return { status: 409, payload: { error: "owner_cannot_leave" } };
  const members = { ...(space.members || {}) };
  delete members[decoded.uid];
  await ref.update({
    members,
    memberUids: (space.memberUids || []).filter((uid) => uid !== decoded.uid),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { status: 200, payload: { ok: true } };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const firebase = getFirebaseAdmin();
    const decoded = await firebase.auth().verifyIdToken(token, true);
    if (!decoded.email_verified) return res.status(403).json({ error: "verified_email_required" });
    const db = firebase.firestore();
    if (req.method === "GET") return res.status(200).json({ ok: true, ...(await listSpaces(db, decoded)) });
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }
    const body = bodyOf(req);
    if (!body) return res.status(400).json({ error: "invalid_json" });
    const handlers = { create: createSpace, invite: inviteMember, accept: acceptInvite, save: saveSpace, leave: leaveSpace };
    const handler = handlers[body.action];
    if (!handler) return res.status(400).json({ error: "invalid_action" });
    const result = await handler(db, decoded, body);
    return res.status(result.status).json(result.payload);
  } catch (error) {
    const code = String(error?.code || error?.message || "unknown");
    if (code.startsWith("auth/")) return res.status(401).json({ error: "unauthorized" });
    const known = new Set(["invite_not_found", "invite_forbidden", "space_not_found", "space_read_only", "space_conflict", "finance_space_too_large"]);
    if (known.has(code)) return res.status(code === "invite_forbidden" || code === "space_read_only" ? 403 : code === "space_conflict" ? 409 : code === "finance_space_too_large" ? 413 : 404).json({ error: code });
    console.error("finance_spaces_failed", { code });
    return res.status(500).json({ error: "finance_spaces_unavailable" });
  }
};
