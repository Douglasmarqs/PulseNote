const test = require('node:test');
const assert = require('node:assert/strict');
const { updateUser } = require('../api/admin')._test;

const actor = { uid: 'administrator', email: 'admin@example.invalid' };
const uid = 'regular-user';

function fixture(initialDisabled) {
  const calls = [];
  const state = { authDisabled: initialDisabled, markerDisabled: initialDisabled, failAuth: false, failMarker: false };
  const firebase = { auth: () => ({
    getUser: async () => ({ uid, email: 'regular@example.invalid' }),
    updateUser: async (_, update) => {
      calls.push(`auth:${update.disabled}`);
      if (state.failAuth) throw new Error('auth_unavailable');
      state.authDisabled = update.disabled;
    },
    revokeRefreshTokens: async () => { calls.push('revoke'); },
  }) };
  const db = { collection: (name) => ({
    doc: () => name === 'adminRoles'
      ? { get: async () => ({ data: () => ({}) }) }
      : { set: async (value) => {
        assert.equal(name, 'adminUserStatus');
        calls.push(`marker:${value.disabled}`);
        if (state.failMarker) throw new Error('firestore_unavailable');
        state.markerDisabled = value.disabled;
      } },
    add: async () => {
      assert.equal(name, 'adminAudit');
      calls.push('audit');
    },
  }) };
  return { firebase, db, calls, state };
}

test('disable closes the server gate before Auth and keeps it closed if Auth fails', async () => {
  const { firebase, db, calls, state } = fixture(false);
  state.failAuth = true;
  await assert.rejects(updateUser(firebase, db, actor, { uid, disabled: true }), /auth_unavailable/);
  assert.equal(state.markerDisabled, true);
  assert.equal(state.authDisabled, false);
  assert.deepEqual(calls, ['marker:true', 'auth:true']);

  state.failAuth = false;
  calls.length = 0;
  await updateUser(firebase, db, actor, { uid, disabled: true });
  assert.deepEqual(calls, ['marker:true', 'auth:true', 'revoke', 'audit']);
  assert.equal(state.authDisabled, true);
});

test('reactivation clears the server gate only after Auth succeeds', async () => {
  const { firebase, db, calls, state } = fixture(true);
  state.failAuth = true;
  await assert.rejects(updateUser(firebase, db, actor, { uid, disabled: false }), /auth_unavailable/);
  assert.equal(state.markerDisabled, true);
  assert.deepEqual(calls, ['auth:false']);

  state.failAuth = false;
  state.failMarker = true;
  calls.length = 0;
  await assert.rejects(updateUser(firebase, db, actor, { uid, disabled: false }), /firestore_unavailable/);
  assert.equal(state.markerDisabled, true);
  assert.equal(state.authDisabled, false);
  assert.deepEqual(calls, ['auth:false', 'marker:false']);

  state.failMarker = false;
  calls.length = 0;
  await updateUser(firebase, db, actor, { uid, disabled: false });
  assert.deepEqual(calls, ['auth:false', 'marker:false', 'audit']);
  assert.equal(state.markerDisabled, false);
});
