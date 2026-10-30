const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { normalizeMetaDeliveryStatus, shouldApplyProviderStatus } = require('../api/whatsapp-webhook')._test;

test('status da Meta é sanitizado e correlacionado somente por hash', () => {
  const result = normalizeMetaDeliveryStatus({
    id: 'wamid.super-secreto', status: 'failed', timestamp: '1793400000',
    recipient_id: '5531999999999', errors: [{ code: 131026, title: 'telefone privado' }],
  });
  assert.equal(result.providerMessageIdHash, crypto.createHash('sha256').update('wamid.super-secreto').digest('hex'));
  assert.equal(result.providerStatus, 'failed');
  assert.equal(result.providerError, 'meta_131026');
  assert.equal(JSON.stringify(result).includes('5531999999999'), false);
  assert.equal(JSON.stringify(result).includes('telefone privado'), false);
  assert.equal(JSON.stringify(result).includes('wamid.super-secreto'), false);
});

test('progresso de entrega não regride por callback fora de ordem', () => {
  assert.equal(shouldApplyProviderStatus('sent', 'delivered'), true);
  assert.equal(shouldApplyProviderStatus('delivered', 'read'), true);
  assert.equal(shouldApplyProviderStatus('read', 'delivered'), false);
  assert.equal(shouldApplyProviderStatus('delivered', 'failed'), true);
  assert.equal(normalizeMetaDeliveryStatus({ id: '', status: 'read' }), null);
  assert.equal(normalizeMetaDeliveryStatus({ id: 'x', status: 'unknown' }), null);
});
