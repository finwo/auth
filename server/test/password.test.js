import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../src/lib/password.js';

test('password hashes verify and reject the wrong password', async () => {
  const encoded = await hashPassword('correct horse battery staple');
  assert.match(encoded, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('wrong', encoded), false);
});

test('the same password produces different hashes', async () => {
  const first = await hashPassword('same password');
  const second = await hashPassword('same password');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('same password', first), true);
  assert.equal(await verifyPassword('same password', second), true);
});

test('malformed hashes and oversized passwords fail closed', async () => {
  assert.equal(await verifyPassword('password', 'not-a-hash'), false);
  assert.equal(await verifyPassword('password', 'scrypt$1$2$3$bad$bad'), false);
  assert.equal(await verifyPassword('x'.repeat(1025), await hashPassword('password')), false);
});

test('the dummy hash rejects arbitrary passwords', async () => {
  assert.equal(await verifyDummyPassword('anything'), false);
});
