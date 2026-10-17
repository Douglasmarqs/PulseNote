const test = require("node:test");
const assert = require("node:assert/strict");
const { _test: { findUidForPhone, confirmWhatsAppLink } } = require("../api/whatsapp-webhook");

function firebaseWithLink(uid, getUser, linkedPhone = "5531999999999") {
  return {
    firestore: () => ({
      collection: (name) => ({ doc: () => ({ get: async () => ({
        exists: name === "whatsappLinks" ? !!uid : name === "userData" && !!linkedPhone,
        data: () => name === "whatsappLinks" ? { uid } : { data: { whatsappLinkedPhone: linkedPhone } },
      }) }) }),
    }),
    auth: () => ({ getUser }),
  };
}

test("WhatsApp não associa um número a uma conta excluída ou desativada", async () => {
  assert.equal(await findUidForPhone(firebaseWithLink(null, () => {
    throw new Error("não deveria consultar Auth");
  }), "5531999999999"), null);

  assert.equal(await findUidForPhone(firebaseWithLink("uid_ativo", async () => ({ disabled: false })), "5531999999999"), "uid_ativo");
  assert.equal(await findUidForPhone(firebaseWithLink("uid_desativado", async () => ({ disabled: true })), "5531999999999"), null);
  assert.equal(await findUidForPhone(firebaseWithLink("uid_antigo", async () => ({ disabled: false }), "5531888888888"), "5531999999999"), null);
  assert.equal(await findUidForPhone(firebaseWithLink("uid_sem_dados", async () => ({ disabled: false }), null), "5531999999999"), null);
  assert.equal(await findUidForPhone(firebaseWithLink("uid_excluido", async () => {
    const error = new Error("Usuário inexistente");
    error.code = "auth/user-not-found";
    throw error;
  }), "5531999999999"), null);
});

test("falha transitória do Auth não é confundida com conta excluída", async () => {
  const error = new Error("Auth temporariamente indisponível");
  error.code = "auth/internal-error";
  await assert.rejects(
    findUidForPhone(firebaseWithLink("uid_ativo", async () => { throw error; }), "5531999999999"),
    error
  );
});

function transactionalFirebase(initialDocs) {
  const docs = new Map(Object.entries(initialDocs));
  const db = {
    collection: (name) => ({ doc: (id) => ({ path: `${name}/${id}` }) }),
    runTransaction: async (work) => {
      const writes = [];
      const result = await work({
        get: async (ref) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        set: (ref, value) => writes.push({ type: "set", ref, value }),
        delete: (ref) => writes.push({ type: "delete", ref }),
      });
      for (const write of writes) {
        if (write.type === "delete") docs.delete(write.ref.path);
        else docs.set(write.ref.path, write.value);
      }
      return result;
    },
  };
  return { fb: { firestore: () => db }, docs };
}

test("trocar o número remove o vínculo anterior e atualiza o usuário na mesma transação", async () => {
  const oldPhone = "5531888888888";
  const newPhone = "5531999999999";
  const code = "123456";
  const { fb, docs } = transactionalFirebase({
    "userData/uid_ativo": { data: {
      whatsappLinkedPhone: oldPhone, whatsappLinkCode: code,
      whatsappLinkCodeExpiresAt: new Date(Date.now() + 60000).toISOString(), notes: [{ id: "n1" }],
    } },
    [`whatsappLinks/${oldPhone}`]: { uid: "uid_ativo" },
  });
  assert.equal(await confirmWhatsAppLink(fb, "uid_ativo", newPhone, code), "linked");
  assert.equal(docs.has(`whatsappLinks/${oldPhone}`), false);
  assert.equal(docs.get(`whatsappLinks/${newPhone}`).uid, "uid_ativo");
  assert.equal(docs.get("userData/uid_ativo").data.whatsappLinkedPhone, newPhone);
  assert.equal(docs.get("userData/uid_ativo").data.whatsappLinkCode, null);
  assert.deepEqual(docs.get("userData/uid_ativo").data.notes, [{ id: "n1" }]);
});

test("troca não apaga número reassociado nem rouba número de outra conta", async () => {
  const code = "123456";
  const oldPhone = "5531888888888";
  const newPhone = "5531999999999";
  const { fb, docs } = transactionalFirebase({
    "userData/uid_ativo": { data: {
      whatsappLinkedPhone: oldPhone, whatsappLinkCode: code,
      whatsappLinkCodeExpiresAt: new Date(Date.now() + 60000).toISOString(),
    } },
    [`whatsappLinks/${oldPhone}`]: { uid: "outro_uid" },
    [`whatsappLinks/${newPhone}`]: { uid: "novo_uid" },
    "userData/novo_uid": { data: { whatsappLinkedPhone: newPhone } },
  });
  assert.equal(await confirmWhatsAppLink(fb, "uid_ativo", newPhone, code), "already_linked");
  assert.equal(docs.get(`whatsappLinks/${oldPhone}`).uid, "outro_uid");
  assert.equal(docs.get(`whatsappLinks/${newPhone}`).uid, "novo_uid");
  assert.equal(docs.get("userData/uid_ativo").data.whatsappLinkedPhone, oldPhone);

  // Se a conta anterior já mudou de número, o índice legado é órfão e
  // não deve impedir o verdadeiro dono do telefone de vincular novamente.
  docs.set("userData/novo_uid", { data: { whatsappLinkedPhone: "5531777777777" } });
  assert.equal(await confirmWhatsAppLink(fb, "uid_ativo", newPhone, code), "linked");
  assert.equal(docs.get(`whatsappLinks/${oldPhone}`).uid, "outro_uid");
  assert.equal(docs.get(`whatsappLinks/${newPhone}`).uid, "uid_ativo");
});

test("código expirado ou conta desativada não cria vínculo", async () => {
  const phone = "5531999999999";
  const { fb, docs } = transactionalFirebase({
    "userData/uid_ativo": { data: {
      whatsappLinkCode: "123456",
      whatsappLinkCodeExpiresAt: new Date(Date.now() - 1000).toISOString(),
    } },
  });
  assert.equal(await confirmWhatsAppLink(fb, "uid_ativo", phone, "123456"), "invalid");
  assert.equal(docs.has(`whatsappLinks/${phone}`), false);
  docs.set("userData/uid_ativo", { data: {
    whatsappLinkCode: "123456",
    whatsappLinkCodeExpiresAt: new Date(Date.now() + 60000).toISOString(),
  } });
  docs.set("adminUserStatus/uid_ativo", { disabled: true });
  assert.equal(await confirmWhatsAppLink(fb, "uid_ativo", phone, "123456"), "invalid");
  assert.equal(docs.has(`whatsappLinks/${phone}`), false);
});
