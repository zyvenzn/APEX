import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from '../src/auth/crypto.js';

test('password hashes verify without storing plaintext', async () => {
  const password = 'correct-horse-battery';
  const encoded = await hashPassword(password);
  assert.notEqual(encoded, password);
  assert.equal(await verifyPassword(password, encoded), true);
  assert.equal(await verifyPassword('wrong-password', encoded), false);
});

test('session tokens are random and stored as one-way hashes', () => {
  const a = createSessionToken();
  const b = createSessionToken();
  assert.notEqual(a, b);
  assert.notEqual(hashSessionToken(a), a);
  assert.equal(hashSessionToken(a).length, 64);
});

test('malformed password hashes fail closed', async () => {
  assert.equal(await verifyPassword('anything', 'invalid'), false);
});