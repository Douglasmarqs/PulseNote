"use strict";

const FINANCE_SPACE_FIELDS = Object.freeze([
  "finances",
  "financeAccounts",
  "finGoals",
  "finRecurrents",
  "monthClosures",
]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

function cleanText(value, max = 80) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeItem(item, workspaceId) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const clean = safeClone(item);
  delete clean.fcmTokens;
  delete clean.whatsappLinkedPhone;
  delete clean.whatsappLinkCode;
  delete clean.serverNotifications;
  clean.workspaceId = workspaceId;
  return clean;
}

function sanitizeFinanceSpaceData(input, workspaceId) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const output = {};
  for (const field of FINANCE_SPACE_FIELDS) {
    const list = Array.isArray(source[field]) ? source[field] : [];
    output[field] = list.slice(0, 2000).map((item) => sanitizeItem(item, workspaceId)).filter(Boolean);
  }
  const reserve = Number(source.financialSettings?.safetyReserve);
  output.financialSettings = {
    safetyReserve: Number.isFinite(reserve) && reserve >= 0 ? Math.round(reserve * 100) / 100 : 0,
  };
  const bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  if (bytes > 700_000) {
    const error = new Error("finance_space_too_large");
    error.code = "finance_space_too_large";
    throw error;
  }
  return output;
}

function roleFor(space, uid) {
  return space?.members?.[uid]?.role || null;
}

function canEditFinanceSpace(space, uid) {
  return ["owner", "editor"].includes(roleFor(space, uid));
}

function publicFinanceSpace(space, uid, id) {
  const members = Object.values(space?.members || {}).map((member) => ({
    uid: cleanText(member.uid, 128),
    name: cleanText(member.name, 70) || "Membro",
    email: normalizeEmail(member.email),
    role: ["owner", "editor", "viewer"].includes(member.role) ? member.role : "viewer",
  }));
  return {
    id,
    name: cleanText(space?.name, 70) || "Espaço compartilhado",
    type: ["couple", "family", "group"].includes(space?.type) ? space.type : "group",
    role: roleFor(space, uid),
    canEdit: canEditFinanceSpace(space, uid),
    revision: Number.isInteger(space?.revision) ? space.revision : 0,
    members,
    data: sanitizeFinanceSpaceData(space?.data, id),
    updatedAt: space?.updatedAt?.toDate?.()?.toISOString?.() || space?.updatedAt || null,
  };
}

module.exports = {
  FINANCE_SPACE_FIELDS,
  canEditFinanceSpace,
  cleanText,
  normalizeEmail,
  publicFinanceSpace,
  roleFor,
  sanitizeFinanceSpaceData,
};
