import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateClientSecret,
  normalizeScopes,
  normalizeUriList,
} from '../src/lib/admin-clients.js';

function expectHttpError(fn, status, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return;
  }
  assert.fail('Expected an HTTP error');
}

test('admin client scopes are normalized and must include openid', () => {
  assert.equal(normalizeScopes('openid email'), 'openid email');
  assert.equal(normalizeScopes(['email', 'openid', 'email']), 'email openid');
  expectHttpError(() => normalizeScopes('email profile'), 400, 'invalid_request');
});

test('admin client redirect URIs are absolute and exact', () => {
  assert.deepEqual(
    normalizeUriList(
      ['http://localhost:3000/callback', 'https://app.example.test/callback'],
      'redirect_uris',
      { required: true }
    ),
    ['http://localhost:3000/callback', 'https://app.example.test/callback']
  );
  expectHttpError(
    () => normalizeUriList(['/callback'], 'redirect_uris', { required: true }),
    400,
    'invalid_request'
  );
  expectHttpError(
    () => normalizeUriList(['https://app.test/callback#token'], 'redirect_uris'),
    400,
    'invalid_request'
  );
});

test('admin client secrets are URL-safe random values', () => {
  assert.match(generateClientSecret(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(generateClientSecret(), generateClientSecret());
});
