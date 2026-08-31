const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLINIC_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{1,23}$/;

export function normalizeOwnerEmails(value) {
  const emails = [...new Set(String(value || '')
    .split(/[\s,;]+/)
    .map(item => item.trim().toLowerCase())
    .filter(Boolean))];
  if (emails.length === 0 || emails.length > 20) throw new Error('CNYOS_OWNER_EMAILS_INVALID');
  if (emails.some(email => email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('CNYOS_OWNER_EMAILS_INVALID');
  }
  return Object.freeze(emails);
}

export function normalizeOwnerClinicCodes(value) {
  const codes = [...new Set(String(value || '')
    .split(/[\s,;]+/)
    .map(item => item.trim().toUpperCase())
    .filter(Boolean))];
  if (codes.length === 0 || codes.length > 50 || codes.some(code => !CLINIC_CODE_PATTERN.test(code))) {
    throw new Error('CNYOS_OWNER_CLINIC_CODES_INVALID');
  }
  return Object.freeze(codes);
}

export function assertOwnerProject(url, expectedProjectRef) {
  const expected = String(expectedProjectRef || '').trim().toLowerCase();
  if (!/^[a-z]{20}$/.test(expected)) throw new Error('CNYOS_OWNER_PROJECT_REF_INVALID');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('CNYOS_OWNER_DATABASE_CONFIG_MISSING'); }
  const actual = parsed.hostname.match(/^([a-z]{20})\.supabase\.co$/)?.[1] || '';
  if (parsed.protocol !== 'https:' || actual !== expected) throw new Error('CNYOS_OWNER_PROJECT_MISMATCH');
  return actual;
}

export function extractBearerToken(request) {
  const value = String(request.headers.get('authorization') || '');
  const match = value.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].length < 32 || match[1].length > 8192) {
    throw new Error('CNYOS_OWNER_SESSION_REQUIRED');
  }
  return match[1];
}

export function allowedOwnerOrigin(request) {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin) return origin === requestOrigin;
  return fetchSite === 'same-origin';
}

export function validateOwnerUser(user, allowedEmails) {
  const email = String(user?.email || '').trim().toLowerCase();
  const providers = new Set([
    user?.app_metadata?.provider,
    ...(Array.isArray(user?.app_metadata?.providers) ? user.app_metadata.providers : []),
    ...(Array.isArray(user?.identities) ? user.identities.map(identity => identity?.provider) : [])
  ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean));

  if (!UUID_PATTERN.test(String(user?.id || '')) || !email) throw new Error('CNYOS_OWNER_SESSION_INVALID');
  if (!user?.email_confirmed_at && !user?.confirmed_at) throw new Error('CNYOS_OWNER_EMAIL_UNCONFIRMED');
  if (!providers.has('google')) throw new Error('CNYOS_OWNER_GOOGLE_SIGN_IN_REQUIRED');
  if (!allowedEmails.includes(email)) throw new Error('CNYOS_OWNER_NOT_AUTHORIZED');
  return Object.freeze({ id: user.id, email });
}

export function normalizeSubscriptionRequest(value) {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const requestId = String(body.requestId || '').trim();
  const clinicId = String(body.clinicId || '').trim();
  const clinicCode = String(body.clinicCode || '').trim().toUpperCase();
  const reason = String(body.reason || '').trim();
  if (!UUID_PATTERN.test(requestId) || !UUID_PATTERN.test(clinicId)) {
    throw new Error('CNYOS_OWNER_CONTROL_INPUT_INVALID');
  }
  if (!CLINIC_CODE_PATTERN.test(clinicCode)) throw new Error('CNYOS_OWNER_CLINIC_CODE_INVALID');
  if (typeof body.enabled !== 'boolean') throw new Error('CNYOS_OWNER_STATE_INVALID');
  if (reason.length < 8 || reason.length > 500) throw new Error('CNYOS_OWNER_REASON_INVALID');
  return Object.freeze({ requestId, clinicId, clinicCode, enabled: body.enabled, reason });
}

export async function readOwnerJson(request, maxBytes = 8192) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('CNYOS_OWNER_REQUEST_TOO_LARGE');
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('CNYOS_OWNER_REQUEST_TOO_LARGE');
  try { return JSON.parse(text || '{}'); }
  catch { throw new Error('CNYOS_OWNER_REQUEST_JSON_INVALID'); }
}

export async function supabaseOwnerRequest({
  url,
  serviceRoleKey,
  resource,
  method = 'GET',
  bearer = serviceRoleKey,
  body,
  fetchImpl = fetch
}) {
  if (!url || !serviceRoleKey) throw new Error('CNYOS_OWNER_DATABASE_CONFIG_MISSING');
  if (!/^\/(?:auth\/v1\/user|rest\/v1\/rpc\/[a-z][a-z0-9_]*)$/.test(resource)) {
    throw new Error('CNYOS_OWNER_DATABASE_RESOURCE_INVALID');
  }
  const response = await fetchImpl(`${url.replace(/\/$/, '')}${resource}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const databaseCode = /^CNYOS_[A-Z0-9_]{3,80}$/.test(String(payload?.message || ''))
      ? payload.message
      : 'CNYOS_OWNER_DATABASE_REQUEST_FAILED';
    throw new Error(databaseCode);
  }
  return payload;
}

export function ownerPublicError(error) {
  const code = String(error?.message || '');
  const status = code === 'CNYOS_OWNER_SESSION_REQUIRED' || code === 'CNYOS_OWNER_SESSION_INVALID' ? 401
    : code === 'CNYOS_OWNER_NOT_AUTHORIZED' || code === 'CNYOS_OWNER_GOOGLE_SIGN_IN_REQUIRED' || code === 'CNYOS_OWNER_EMAIL_UNCONFIRMED' || code === 'CNYOS_OWNER_CLINIC_NOT_ALLOWED' ? 403
      : code === 'CNYOS_OWNER_REQUEST_TOO_LARGE' ? 413
        : code === 'CNYOS_OWNER_CONTROL_DISABLED' || code === 'CNYOS_OWNER_DATABASE_CONFIG_MISSING' || code === 'CNYOS_OWNER_EMAILS_INVALID' || code === 'CNYOS_OWNER_CLINIC_CODES_INVALID' || code === 'CNYOS_OWNER_PROJECT_REF_INVALID' || code === 'CNYOS_OWNER_PROJECT_MISMATCH' ? 503
        : code.includes('INPUT') || code.includes('INVALID') || code.includes('MISMATCH') || code.includes('REASON') ? 400
          : 500;
  const safeCode = /^CNYOS_OWNER_[A-Z0-9_]{3,80}$/.test(code) ? code : 'CNYOS_OWNER_CONTROL_FAILED';
  return Object.freeze({ code: safeCode, status });
}
