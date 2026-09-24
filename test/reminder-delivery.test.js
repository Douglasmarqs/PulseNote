const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNotifications, deliverChannel, sendWhatsAppReminder, sendPush } = require('../api/send-reminders')._test;

function memoryDb() {
  const docs = new Map();
  return {
    docs,
    collection: () => ({ doc: id => ({
      id,
      set: async value => docs.set(id, { ...docs.get(id), ...value }),
    }) }),
    runTransaction: async fn => fn({
      get: async ref => ({ data: () => docs.get(ref.id) }),
      set: (ref, value) => docs.set(ref.id, { ...docs.get(ref.id), ...value }),
    }),
  };
}

test('falha no WhatsApp permite retry e não repete push já aceito', async () => {
  const db = memoryDb();
  const n = { key: 'event_consulta', occurrence: '2026-09-23T09:00_15' };
  const now = new Date('2026-09-23T11:45:00Z');
  assert.equal(await deliverChannel(db, 'u1', n, 'push', now, async () => {}), true);
  await assert.rejects(deliverChannel(db, 'u1', n, 'whatsapp', now, async () => { throw Error('503'); }));
  assert.equal(await deliverChannel(db, 'u1', n, 'push', now, async () => { throw Error('duplicado'); }), false);
  assert.equal(await deliverChannel(db, 'u1', n, 'whatsapp', now, async () => {}), true);
  assert.equal(await deliverChannel(db, 'u1', { ...n, occurrence: '2026-09-24T09:00_15' }, 'push', now, async () => {}), true);
});

test('cron atrasado recupera compromisso recente e zero significa na hora', () => {
  const event = { id: 'e', title: 'Reunião', date: '2026-09-23', time: '09:00', reminder: 0 };
  const build = (time, events = [event]) => buildNotifications({ events }, '2026-09-23', new Date(time));
  assert.equal(build('2026-09-23T11:59:00Z').length, 0);
  assert.equal(build('2026-09-23T12:00:00Z').length, 1);
  assert.equal(build('2026-09-23T12:25:00Z').length, 1);
  assert.equal(build('2026-09-23T12:25:00Z', [{ ...event, status: 'Cancelada' }]).length, 0);
});

test('tarefas atrasadas não escondem tarefas para hoje', () => {
  const notifications = buildNotifications({ tasks: [
    { id: 'a', title: 'A', dueDate: '2026-09-22' },
    { id: 'b', title: 'B', dueDate: '2026-09-23' },
  ] }, '2026-09-23', new Date('2026-09-23T12:00:00Z'));
  assert.deepEqual(notifications.map(n => n.key), ['tasksOverdue', 'tasksToday']);
});

test('WhatsApp informa configuração ausente e rejeição do provedor', async () => {
  const keys = ['WHATSAPP_REMINDER_TEMPLATE_NAME', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];
  const previous = keys.map(key => process.env[key]);
  const originalFetch = global.fetch;
  try {
    delete process.env.WHATSAPP_REMINDER_TEMPLATE_NAME;
    await assert.rejects(sendWhatsAppReminder('5531999999999', 'teste'), /configuration_missing/);
    keys.forEach(key => { process.env[key] = 'test'; });
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 132001 } }) });
    await assert.rejects(sendWhatsAppReminder('5531999999999', 'teste'), /132001/);
  } finally {
    global.fetch = originalFetch;
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test('push informa falha total em vez de contabilizar como enviado', async () => {
  const fb = { messaging: () => ({ sendEachForMulticast: async () => ({
    successCount: 0, failureCount: 1,
    responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }],
  }) }) };
  const result = await sendPush(fb, ['expired'], { title: 'T', body: 'B', tag: 't' });
  assert.equal(result.accepted, 0);
  assert.deepEqual(result.invalidTokens, ['expired']);
});
