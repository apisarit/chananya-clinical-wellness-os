import assert from 'node:assert/strict';
import { configuration, normalizeSearchInput, normalizeSearchResponse, searchWhoIcd } from '../netlify/functions/_shared/who-icd.mjs';

const env = {
  WHO_ICD_ENABLED: 'true',
  WHO_ICD_CLIENT_ID: 'client-id',
  WHO_ICD_CLIENT_SECRET: 'secret-value-long-enough',
  WHO_ICD_RELEASE: '2026-01',
  WHO_ICD_LANGUAGE: 'en',
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test'
};

assert.equal(configuration(name => env[name] || '').enabled, true);
assert.deepEqual(normalizeSearchInput({ query: '  diabetes   mellitus ', limit: 3 }, { release: '2026-01', language: 'en' }), {
  query: 'diabetes mellitus', limit: 3, release: '2026-01', language: 'en'
});
assert.throws(() => normalizeSearchInput({ query: 'https://bad.example' }, { release: '2026-01', language: 'en' }), /QUERY_INVALID/);
assert.throws(() => normalizeSearchInput({ query: 'x' }, { release: '2026-01', language: 'en' }), /QUERY_INVALID/);
assert.throws(() => normalizeSearchInput({ query: 'pain', release: 'latest' }, { release: '2026-01', language: 'en' }), /VERSION_INVALID/);
assert.deepEqual(normalizeSearchResponse({ destinationEntities: [
  { '@id': 'http://id.who.int/icd/entity/1', title: 'Pain' },
  { '@id': 'https://id.who.int/icd/entity/1', title: 'Duplicate' },
  { id: 'https://evil.example/entity/2', title: 'Rejected' }
] }, 10), {
  results: [{ id: 'https://id.who.int/icd/entity/1', code: null, title: 'Pain' }], total: 1
});

const calls = [];
const result = await searchWhoIcd({ query: 'low back pain', limit: 2 }, configuration(name => env[name] || ''), {
  fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/connect/token')) {
      return new Response(JSON.stringify({ access_token: 'a'.repeat(32), token_type: 'Bearer' }), { status: 200 });
    }
    return new Response(JSON.stringify({ destinationEntities: [
      { '@id': 'https://id.who.int/icd/entity/123', title: 'Low back pain', theCode: 'ME84' }
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
});
assert.equal(result.release, '2026-01');
assert.equal(result.results[0].code, 'ME84');
assert.match(calls[0].options.headers.Authorization, /^Basic /);
assert.equal(calls[1].options.headers['API-Version'], 'v2');
assert.equal(calls[1].options.headers.Authorization, 'Bearer ' + 'a'.repeat(32));
assert.equal(new URL(calls[1].url).pathname, '/icd/release/2026-01/mms/search');
assert.equal(new URL(calls[1].url).searchParams.get('q'), 'low back pain');
assert.equal(calls[1].options.redirect, 'error');
assert.doesNotMatch(JSON.stringify(calls), /secret-value-long-enough/);

console.log('WHO ICD connector contract passed: fixed OAuth endpoint, v2 MMS search, bounded input/output, and no browser secret exposure');
