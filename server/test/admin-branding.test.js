import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBrandingPatch,
  hasBrandingPatch,
  normalizeBrandingObject,
  normalizeBrandingPatch,
  serializeBranding,
} from '../src/lib/admin-branding.js';

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

test('admin branding normalizes primary colors and clears empty values', () => {
  assert.deepEqual(normalizeBrandingPatch({ primary_color: '#25A' }), {
    primary_color: '#2255aa',
  });
  assert.deepEqual(normalizeBrandingPatch({ primary_color: '#abc' }), {
    primary_color: '#aabbcc',
  });
  assert.deepEqual(normalizeBrandingPatch({ primary_color: '' }), {
    primary_color: null,
  });
  assert.deepEqual(normalizeBrandingPatch({ primary_color: null }), {
    primary_color: null,
  });

  expectHttpError(
    () => normalizeBrandingPatch({ primary_color: 'red' }),
    400,
    'invalid_request'
  );
});

test('admin branding validates logo URLs for https and loopback use', () => {
  assert.deepEqual(
    normalizeBrandingPatch({ logo_url: ' https://acme.test/logo.svg?size=large ' }),
    { logo_url: 'https://acme.test/logo.svg?size=large' }
  );
  assert.deepEqual(normalizeBrandingPatch({ logo_url: 'http://localhost/logo.svg' }), {
    logo_url: 'http://localhost/logo.svg',
  });
  assert.deepEqual(
    normalizeBrandingPatch({ logo_url: 'http://acme.localhost/logo.svg' }),
    { logo_url: 'http://acme.localhost/logo.svg' }
  );

  for (const logoUrl of [
    'http://acme.test/logo.svg',
    'data:image/svg+xml,%3Csvg/%3E',
    'javascript:alert(1)',
    '/logo.svg',
    'https://user:password@acme.test/logo.svg',
    'https://acme.test/logo.svg#fragment',
    'https://*.acme.test/logo.svg',
    `https://acme.test/${'a'.repeat(2048)}.svg`,
  ]) {
    expectHttpError(
      () => normalizeBrandingPatch({ logo_url: logoUrl }),
      400,
      'invalid_request'
    );
  }
});

test('admin branding patches preserve unknown keys and clear individual fields', () => {
  const current = JSON.stringify({
    primary_color: '#2255aa',
    custom_asset: 'https://acme.test/custom.png',
  });

  const updated = applyBrandingPatch(current, {
    logo_url: 'https://acme.test/logo.svg',
  });
  assert.deepEqual(JSON.parse(updated), {
    primary_color: '#2255aa',
    custom_asset: 'https://acme.test/custom.png',
    logo_url: 'https://acme.test/logo.svg',
  });

  const cleared = applyBrandingPatch(updated, { logo_url: null });
  assert.deepEqual(JSON.parse(cleared), {
    primary_color: '#2255aa',
    custom_asset: 'https://acme.test/custom.png',
  });
  assert.equal(hasBrandingPatch({ logo_url: null }), true);
  assert.equal(hasBrandingPatch({ display_name: 'Acme' }), false);
  assert.deepEqual(serializeBranding(cleared), {
    logo_url: null,
    primary_color: '#2255aa',
  });
});

test('admin branding normalization accepts raw JSON and parsed objects', () => {
  assert.deepEqual(
    normalizeBrandingObject(
      JSON.stringify({
        logo_url: ' https://acme.test/logo.svg ',
        primary_color: '#25A',
      })
    ),
    {
      logo_url: 'https://acme.test/logo.svg',
      primary_color: '#2255aa',
    }
  );

  assert.deepEqual(
    normalizeBrandingObject({
      logo_url: '',
      primary_color: 'red',
      custom_asset: 'https://acme.test/custom.png',
    }),
    {
      custom_asset: 'https://acme.test/custom.png',
    }
  );
});
