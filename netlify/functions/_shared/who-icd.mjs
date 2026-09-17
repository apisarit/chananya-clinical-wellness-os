const WHO_TOKEN_ENDPOINT = 'https://icdaccessmanagement.who.int/connect/token';
const WHO_API_ORIGIN = 'https://id.who.int';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const PROJECT_REF = /^[a-z]{20}$/;
const RELEASE = /^\d{4}-\d{2}$/;
const LANGUAGE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const TOKEN = /^[A-Za-z0-9._~-]{20,4096}$/;
const MAX_BODY = 2048;
const MAX_RESPONSE = 524_288;
const MAX_RESULTS = 20;
const KNOWLEDGE_ROLES = new Set(['super_admin', 'admin', 'doctor', 'practitioner']);

const HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
});

function failure(code, status) {
  return Object.assign(new Error(code), { publicCode: code, status });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function text(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

async function boundedJson(response, maxBytes, code, status) {
  const statedLength = Number(response.headers.get('content-length') || 0);
  if (statedLength > maxBytes || !response.body) throw failure(code, status);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw failure(code, status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw failure(code, status);
  }
}

export function configuration(getEnv) {
  const clientId = text(getEnv('WHO_ICD_CLIENT_ID'), 512);
  const clientSecret = text(getEnv('WHO_ICD_CLIENT_SECRET'), 2048);
  const release = text(getEnv('WHO_ICD_RELEASE'), 16);
  const language = text(getEnv('WHO_ICD_LANGUAGE') || 'en', 8);
  const enabled = getEnv('WHO_ICD_ENABLED') === 'true'
    && clientId.length >= 8
    && clientSecret.length >= 16
    && RELEASE.test(release)
    && LANGUAGE.test(language);
  return Object.freeze({ clientId, clientSecret, release, language, enabled });
}

export function normalizeSearchInput(value, defaults = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('WHO_ICD_INPUT_INVALID', 400);
  }
  const keys = Object.keys(value);
  if (keys.some(key => !['query', 'limit', 'release', 'language'].includes(key))) {
    throw failure('WHO_ICD_INPUT_INVALID', 400);
  }
  const query = text(value.query, 160).replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 120 || /[\u0000-\u001f\u007f<>\\{}]/.test(query)
      || /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|@)/i.test(query)) {
    throw failure('WHO_ICD_QUERY_INVALID', 400);
  }
  const limit = value.limit === undefined ? 10 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw failure('WHO_ICD_LIMIT_INVALID', 400);
  }
  const release = text(value.release || defaults.release, 16);
  const language = text(value.language || defaults.language, 8);
  if (!RELEASE.test(release) || !LANGUAGE.test(language)) {
    throw failure('WHO_ICD_VERSION_INVALID', 400);
  }
  return Object.freeze({ query, limit, release, language });
}

export async function requestWhoToken(config, { fetchImpl = fetch, signal = AbortSignal.timeout(8000) } = {}) {
  if (!config?.clientId || !config?.clientSecret) throw failure('WHO_ICD_NOT_CONFIGURED', 503);
  let response;
  try {
    response = await fetchImpl(WHO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'icdapi_access' }).toString(),
      redirect: 'error',
      signal
    });
  } catch {
    throw failure('WHO_ICD_AUTH_UNAVAILABLE', 502);
  }
  if (!response.ok) throw failure('WHO_ICD_AUTH_REJECTED', 502);
  const payload = await boundedJson(response, 16_384, 'WHO_ICD_AUTH_INVALID', 502);
  const accessToken = text(payload?.access_token, 4096);
  if (!TOKEN.test(accessToken)) throw failure('WHO_ICD_AUTH_INVALID', 502);
  return accessToken;
}

function normalizeEntity(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const rawId = text(item['@id'] || item.id || item.entityId, 512);
  const id = rawId.replace(/^http:\/\/id\.who\.int\/icd\//, 'https://id.who.int/icd/');
  const title = text(item.title || item.label || item.preferredLabel || item.name, 300);
  const code = text(item.code || item.theCode || item.mmsCode, 64);
  if (!title || !id || !/^https:\/\/id\.who\.int\/icd\//.test(id)) return null;
  return Object.freeze({ id, code: code || null, title });
}

export function normalizeSearchResponse(payload, limit) {
  const candidates = Array.isArray(payload?.destinationEntities) ? payload.destinationEntities
    : Array.isArray(payload?.entities) ? payload.entities
      : Array.isArray(payload?.results) ? payload.results
        : Array.isArray(payload?.items) ? payload.items : [];
  const seen = new Set();
  const results = [];
  for (const item of candidates) {
    const entity = normalizeEntity(item);
    if (!entity || seen.has(entity.id)) continue;
    seen.add(entity.id);
    results.push(entity);
    if (results.length >= limit) break;
  }
  const total = Number(payload?.total ?? payload?.totalCount);
  return Object.freeze({
    results,
    total: Number.isSafeInteger(total) && total >= 0 ? total : results.length
  });
}

export async function searchWhoIcd(query, config, { fetchImpl = fetch, signal = AbortSignal.timeout(15_000) } = {}) {
  const input = normalizeSearchInput(query, config);
  const url = new URL(`${WHO_API_ORIGIN}/icd/release/${input.release}/mms/search`);
  url.searchParams.set('q', input.query);
  let response;
  try {
    const token = await requestWhoToken(config, { fetchImpl, signal });
    response = await fetchImpl(url.toString(), {
      headers: {
        Accept: 'application/json',
        'Accept-Language': input.language,
        'API-Version': 'v2',
        Authorization: `Bearer ${token}`
      },
      redirect: 'error',
      signal
    });
  } catch (error) {
    if (error?.publicCode) throw error;
    throw failure('WHO_ICD_SOURCE_UNAVAILABLE', 502);
  }
  if (response.status === 429) throw failure('WHO_ICD_SOURCE_BUSY', 429);
  if (!response.ok) throw failure('WHO_ICD_SOURCE_UNAVAILABLE', 502);
  const payload = await boundedJson(response, MAX_RESPONSE, 'WHO_ICD_SOURCE_INVALID', 502);
  return Object.freeze({ release: input.release, language: input.language, ...normalizeSearchResponse(payload, input.limit) });
}

function bearer(request) {
  const value = String(request.headers.get('authorization') || '');
  const token = /^Bearer\s+([A-Za-z0-9._~-]{32,4096})$/i.exec(value)?.[1] || '';
  if (!token) throw failure('WHO_ICD_SESSION_REQUIRED', 401);
  return token;
}

async function supabaseJson(config, resource, token, fetchImpl, signal, body) {
  let response;
  try {
    response = await fetchImpl(`${config.supabaseUrl}${resource}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        apikey: config.supabaseKey,
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal
    });
  } catch {
    throw failure('WHO_ICD_ACCESS_UNAVAILABLE', 503);
  }
  if (response.status === 401) throw failure('WHO_ICD_SESSION_REQUIRED', 401);
  if (response.status === 403) throw failure('WHO_ICD_ACCESS_DENIED', 403);
  if (!response.ok) throw failure('WHO_ICD_ACCESS_UNAVAILABLE', 503);
  return boundedJson(response, 65_536, 'WHO_ICD_ACCESS_UNAVAILABLE', 503);
}

function accessConfiguration(getEnv) {
  const supabaseUrl = text(getEnv('SUPABASE_URL'), 256).replace(/\/$/, '');
  const supabaseKey = text(getEnv('SUPABASE_PUBLISHABLE_KEY') || getEnv('SUPABASE_ANON_KEY'), 512);
  const expectedProjectRef = text(getEnv('CNYOS_OWNER_EXPECTED_PROJECT_REF'), 32);
  const expectedClinicId = text(getEnv('CNYOS_RUNTIME_EXPECTED_CLINIC_ID'), 64).toLowerCase();
  if (!PROJECT_REF.test(expectedProjectRef) || !UUID.test(expectedClinicId)
      || supabaseUrl !== `https://${expectedProjectRef}.supabase.co`
      || !supabaseKey) throw failure('WHO_ICD_ACCESS_NOT_CONFIGURED', 503);
  return Object.freeze({ supabaseUrl, supabaseKey, expectedClinicId });
}

async function assertAccess(request, getEnv, fetchImpl, signal) {
  const token = bearer(request);
  const config = accessConfiguration(getEnv);
  const claims = (() => {
    try {
      const parts = token.split('.');
      const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error();
      return parsed;
    } catch { throw failure('WHO_ICD_SESSION_REQUIRED', 401); }
  })();
  if (claims.role !== 'authenticated' || !UUID.test(String(claims.sub || ''))
      || claims.iss !== `${config.supabaseUrl}/auth/v1`
      || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw failure('WHO_ICD_SESSION_REQUIRED', 401);
  }
  const user = await supabaseJson(config, '/auth/v1/user', token, fetchImpl, signal);
  if (String(user?.id || '') !== claims.sub) throw failure('WHO_ICD_SESSION_REQUIRED', 401);
  const rows = await supabaseJson(config, '/rest/v1/rpc/current_access_context', token, fetchImpl, signal, {});
  const access = Array.isArray(rows) ? rows[0] : rows;
  if (access?.ready !== true || String(access.clinic_id || '').toLowerCase() !== config.expectedClinicId
      || !KNOWLEDGE_ROLES.has(String(access.effective_role || ''))) {
    throw failure('WHO_ICD_ACCESS_DENIED', 403);
  }
  return Object.freeze({ token, config, access });
}

export async function handleWhoIcd(request, context, { getEnv, fetchImpl = fetch } = {}) {
  if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return json({ ok: false, code: 'WHO_ICD_ORIGIN_DENIED' }, 403);
  }
  try {
    const env = getEnv || (name => globalThis.Netlify?.env?.get(name) || '');
    const who = configuration(env);
    if (!who.enabled) throw failure('WHO_ICD_NOT_CONFIGURED', 503);
    const length = Number(request.headers.get('content-length') || 0);
    if (length > MAX_BODY || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
      throw failure('WHO_ICD_INPUT_INVALID', 400);
    }
    const bodyText = await request.text();
    if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY) throw failure('WHO_ICD_INPUT_INVALID', 400);
    let input;
    try { input = JSON.parse(bodyText || '{}'); } catch { throw failure('WHO_ICD_INPUT_INVALID', 400); }
    const signal = AbortSignal.timeout(20_000);
    const identity = await assertAccess(request, env, fetchImpl, signal);
    const result = await searchWhoIcd(input, who, { fetchImpl, signal });
    // Recheck the database access context after the provider call to avoid
    // returning results after a role or subscription revocation.
    await assertAccess(request, env, fetchImpl, signal);
    return json({ ok: true, source: 'who-icd-11-mms', ...result, clinicId: identity.config.expectedClinicId });
  } catch (error) {
    return json({ ok: false, code: error?.publicCode || 'WHO_ICD_REQUEST_FAILED' }, error?.status || 500);
  }
}
