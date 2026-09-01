import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEDULED_FUNCTION_NAMES = Object.freeze([
  'database-backup',
  'database-backup-recovery'
]);

const NETLIFY_SCHEDULED_ROUTE_DENIAL_STATUS = 404;
const MAX_DENIAL_BODY_BYTES = 16 * 1024;

export function assertPublishedNetlifyOrigin(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch { throw new Error('SCHEDULED_ROUTE_ORIGIN_INVALID'); }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.netlify\.app$/.test(parsed.hostname)) {
    throw new Error('SCHEDULED_ROUTE_ORIGIN_INVALID');
  }
  return parsed.origin;
}

async function readBoundedDenialBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DENIAL_BODY_BYTES) throw new Error('SCHEDULED_ROUTE_DENIAL_BODY_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(value => Buffer.from(value))).toString('utf8');
}

function assertExternalDenial(response, body) {
  let payload;
  try { payload = JSON.parse(body); }
  catch { payload = null; }
  if (payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && (Object.hasOwn(payload, 'enabled')
      || Object.hasOwn(payload, 'ok')
      || Object.hasOwn(payload, 'code'))) {
    throw new Error('SCHEDULED_FUNCTION_RUNTIME_REACHED');
  }
  if (response.status !== NETLIFY_SCHEDULED_ROUTE_DENIAL_STATUS) {
    throw new Error('SCHEDULED_FUNCTION_PUBLIC_ROUTE_PRESENT');
  }
}

export async function verifyScheduledRouteDenial(originValue, fetchImpl = fetch) {
  const origin = assertPublishedNetlifyOrigin(originValue);
  const evidence = [];
  for (const functionName of SCHEDULED_FUNCTION_NAMES) {
    const endpoint = new URL(`/.netlify/functions/${functionName}`, origin);
    for (const method of ['GET', 'POST']) {
      const response = await fetchImpl(endpoint, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        // Deliberately malformed for the application handler: if a route is
        // accidentally exposed, this cannot enqueue work and its runtime JSON
        // response is distinguished from Netlify's external route denial.
        body: method === 'POST' ? '{}' : undefined,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000)
      });
      const body = await readBoundedDenialBody(response);
      assertExternalDenial(response, body);
      evidence.push(Object.freeze({ functionName, method, status: response.status }));
    }
  }
  return Object.freeze(evidence);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const origin = process.argv[2] || process.env.STAGING_SITE_URL || '';
  verifyScheduledRouteDenial(origin)
    .then(evidence => {
      for (const item of evidence) {
        console.log(`${item.functionName} ${item.method}: externally denied (${item.status})`);
      }
    })
    .catch(error => {
      console.error(String(error?.message || 'SCHEDULED_ROUTE_DENIAL_CHECK_FAILED'));
      process.exitCode = 1;
    });
}
