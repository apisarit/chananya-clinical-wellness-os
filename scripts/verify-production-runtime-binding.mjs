import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateTenantConfig } from './generate-tenant-config.mjs';

const API = 'https://api.netlify.com/api/v1';
const PROJECT_REF = /^[a-z0-9]{20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// These names are intentionally limited to keys consumed by the checked-in
// Netlify functions. A key is never printed and secret values are never read
// into evidence.
export const REQUIRED_BINDING_KEYS = Object.freeze([
  'SUPABASE_URL', 'CNYOS_OWNER_EXPECTED_PROJECT_REF', 'CNYOS_RUNTIME_EXPECTED_CLINIC_ID',
  'CNYOS_ACCOUNT_CLINIC_ID', 'CNYOS_ACCOUNT_CLINIC_CODE', 'CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID',
  'CNYOS_OWNER_EXPECTED_SITE_ORIGIN', 'PATIENT_QR_ISSUER'
]);
export const REQUIRED_SECRET_KEYS = Object.freeze(['SUPABASE_SERVICE_ROLE_KEY', 'PATIENT_IDENTITY_HMAC_SECRET']);
export const LINE_KEYS = Object.freeze([
  'LINE_LIFF_ID', 'LINE_LOGIN_CHANNEL_ID', 'LINE_MESSAGING_CHANNEL_ID',
  'LINE_MESSAGING_CHANNEL_SECRET', 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN'
]);
export const BACKUP_BINDING_KEYS = Object.freeze([
  'BACKUP_PRODUCTION_SUPABASE_URL', 'BACKUP_EXPECTED_SUPABASE_PROJECT_REF',
  'BACKUP_EXPECTED_NETLIFY_SITE_ID', 'BACKUP_EXPECTED_SITE_ORIGIN', 'BACKUP_ENVIRONMENT'
]);
export const REQUIRED_FLAG_KEYS = Object.freeze(['CNYOS_OWNER_CONTROL_ENABLED', 'CNYOS_OWNER_DRIVE_ENABLED', 'BACKUP_ENABLED', 'BACKUP_DEPLOYMENT_ID', 'CLINICAL_OS_SOURCE_COMMIT']);
export const PHASES = Object.freeze(['pre-upload', 'pre-publish', 'post-upload', 'rollback']);
const ALLOWED_KEYS = new Set([...REQUIRED_BINDING_KEYS, ...REQUIRED_SECRET_KEYS, ...LINE_KEYS, ...BACKUP_BINDING_KEYS, ...REQUIRED_FLAG_KEYS]);
const SNAPSHOT_KEYS = [...REQUIRED_BINDING_KEYS, ...BACKUP_BINDING_KEYS, ...REQUIRED_FLAG_KEYS];
const LINE_PUBLIC_KEYS = ['LINE_LIFF_ID', 'LINE_LOGIN_CHANNEL_ID', 'LINE_MESSAGING_CHANNEL_ID'];

function clean(value) { return String(value ?? '').trim(); }
function required(name, env = process.env) {
  const value = clean(env[name]);
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function origin(value, code) {
  let parsed;
  try { parsed = new URL(clean(value)); } catch { throw new Error(code); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(code);
  return parsed.origin;
}

export function parseProductionConfig(raw) {
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('PRODUCTION_CONFIG_INVALID'); }
  try { return validateTenantConfig(parsed); } catch { throw new Error('PRODUCTION_CONFIG_INVALID'); }
}

function valuesForEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.scopes) || !entry.scopes.includes('functions') || !Array.isArray(entry.values)) throw new Error('NETLIFY_ENV_METADATA_INVALID');
  const candidates = entry.values.filter(item => item && typeof item === 'object' && !Array.isArray(item) && (item.context === 'production' || item.context === 'all'));
  const production = candidates.filter(item => item.context === 'production');
  const selectedCandidates = production.length ? production : candidates.filter(item => item.context === 'all');
  if (selectedCandidates.length !== 1) throw new Error(selectedCandidates.length ? 'NETLIFY_ENV_CONTEXT_AMBIGUOUS' : 'NETLIFY_ENV_CONTEXT_MISMATCH');
  const selected = selectedCandidates[0];
  const present = typeof selected.value === 'string' && selected.value.trim().length > 0;
  if (!present) throw new Error('NETLIFY_ENV_METADATA_INVALID');
  return { value: selected.value, present, secret: entry.is_secret === true, scopes: entry.scopes, context: selected.context };
}

export function normalizeProductionEnvironment(metadata) {
  const list = Array.isArray(metadata) ? metadata
    : Array.isArray(metadata?.variables) ? metadata.variables
      : Array.isArray(metadata?.values) ? metadata.values : null;
  if (!list) throw new Error('NETLIFY_ENV_METADATA_INVALID');
  const map = new Map();
  for (const entry of list) {
    const key = clean(entry?.key ?? entry?.name);
    // getEnvVars(site_id) is site-only, not a resolved inherited environment.
    // All required keys must be explicitly pinned at the site. Ignore unrelated
    // variables and non-Functions scopes; required omissions still fail below.
    if (!ALLOWED_KEYS.has(key) || !entry.scopes?.includes('functions')) continue;
    const selected = valuesForEntry(entry);
    if (map.has(key)) throw new Error(`NETLIFY_ENV_${key}_CONFLICT`);
    map.set(key, selected);
  }
  return map;
}

function value(map, key) { return clean(map.get(key)?.value); }
function requirePresent(map, key, { secret = false } = {}) {
  const item = map.get(key);
  if (!item?.present || (!secret && !value(map, key))) throw new Error(`NETLIFY_RUNTIME_${key}_MISSING`);
  if (secret && (item.scopes.length !== 1 || item.scopes[0] !== 'functions')) throw new Error(`NETLIFY_RUNTIME_${key}_SCOPE_INVALID`);
}

export function expectedProductionBindings({ config, siteId, siteOrigin }) {
  const tenant = parseProductionConfig(config);
  if (/(?:^|[-_.])(staging|stage|stg|nonprod|test)(?:$|[-_.])/i.test(tenant.deploymentId) ||
      /(?:^|[-_.])(staging|stage|stg|nonprod|test)(?:$|[-_.])/i.test(tenant.tenant.expectedClinicCode) || tenant.safety?.previewLocked === true) throw new Error('PRODUCTION_CONFIG_STAGING_OR_LOCKED');
  const expectedOrigin = origin(siteOrigin || tenant.auth.redirectOrigin, 'PRODUCTION_ORIGIN_INVALID');
  if (origin(tenant.auth.redirectOrigin, 'PRODUCTION_CONFIG_ORIGIN_INVALID') !== expectedOrigin) throw new Error('PRODUCTION_CONFIG_ORIGIN_MISMATCH');
  const databaseOrigin = origin(tenant.database.url, 'PRODUCTION_DATABASE_URL_INVALID');
  const projectRef = new URL(databaseOrigin).hostname.split('.')[0].toLowerCase();
  if (!PROJECT_REF.test(projectRef) || new URL(databaseOrigin).hostname !== `${projectRef}.supabase.co`) throw new Error('PRODUCTION_DATABASE_PROJECT_REF_INVALID');
  if (!UUID.test(clean(siteId))) throw new Error('PRODUCTION_SITE_ID_INVALID');
  return Object.freeze({
    SUPABASE_URL: databaseOrigin,
    CNYOS_OWNER_EXPECTED_PROJECT_REF: projectRef,
    CNYOS_RUNTIME_EXPECTED_CLINIC_ID: tenant.tenant.expectedClinicId,
    CNYOS_ACCOUNT_CLINIC_ID: tenant.tenant.expectedClinicId,
    CNYOS_ACCOUNT_CLINIC_CODE: tenant.tenant.expectedClinicCode,
    CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID: clean(siteId).toLowerCase(),
    CNYOS_OWNER_EXPECTED_SITE_ORIGIN: expectedOrigin,
    PATIENT_QR_ISSUER: tenant.identity.qrIssuer,
    BACKUP_PRODUCTION_SUPABASE_URL: databaseOrigin,
    BACKUP_EXPECTED_SUPABASE_PROJECT_REF: projectRef,
    BACKUP_EXPECTED_NETLIFY_SITE_ID: clean(siteId).toLowerCase(),
    BACKUP_EXPECTED_SITE_ORIGIN: expectedOrigin,
    BACKUP_ENVIRONMENT: 'production',
    BACKUP_DEPLOYMENT_ID: tenant.deploymentId,
    CNYOS_OWNER_CONTROL_ENABLED: 'true',
    CNYOS_OWNER_DRIVE_ENABLED: 'true',
    BACKUP_ENABLED: 'true'
  });
}

export function assertProductionRuntimeBinding({ metadata, config, siteId, siteOrigin, requireLine = false, releaseCommit, sourceCommitPolicy = 'exact' } = {}) {
  const expected = expectedProductionBindings({ config, siteId, siteOrigin });
  const map = normalizeProductionEnvironment(metadata);
  for (const key of REQUIRED_BINDING_KEYS) {
    requirePresent(map, key);
    const comparable = ['CNYOS_OWNER_EXPECTED_PROJECT_REF', 'CNYOS_RUNTIME_EXPECTED_CLINIC_ID', 'CNYOS_ACCOUNT_CLINIC_ID', 'CNYOS_OWNER_EXPECTED_NETLIFY_SITE_ID'].includes(key)
      ? value(map, key).toLowerCase() : value(map, key);
    if (comparable !== clean(expected[key]) && !['SUPABASE_URL', 'CNYOS_OWNER_EXPECTED_SITE_ORIGIN'].includes(key)) {
      throw new Error(`NETLIFY_RUNTIME_${key}_MISMATCH`);
    }
  }
  // URL and identifiers are compared canonically; clinic code/issuer remain case-sensitive by policy.
  for (const key of ['SUPABASE_URL', 'CNYOS_OWNER_EXPECTED_SITE_ORIGIN']) if (origin(value(map, key), 'NETLIFY_RUNTIME_ORIGIN_INVALID') !== origin(expected[key], 'PRODUCTION_ORIGIN_INVALID')) throw new Error(`NETLIFY_RUNTIME_${key}_MISMATCH`);
  for (const key of REQUIRED_SECRET_KEYS) requirePresent(map, key, { secret: true });
  if (!/^[0-9a-f]{40}$/.test(releaseCommit || '')) throw new Error('EXPECTED_RELEASE_COMMIT_INVALID');
  if (!['exact', 'valid'].includes(sourceCommitPolicy)) throw new Error('NETLIFY_RUNTIME_SOURCE_COMMIT_POLICY_INVALID');
  for (const key of REQUIRED_FLAG_KEYS) {
    requirePresent(map, key);
    if (key === 'CLINICAL_OS_SOURCE_COMMIT') {
      if (!/^[0-9a-f]{40}$/.test(value(map, key)) || (sourceCommitPolicy === 'exact' && value(map, key) !== releaseCommit)) {
        throw new Error(`NETLIFY_RUNTIME_${key}_MISMATCH`);
      }
    } else if (value(map, key) !== expected[key]) throw new Error(`NETLIFY_RUNTIME_${key}_MISMATCH`);
  }
  for (const key of BACKUP_BINDING_KEYS) { requirePresent(map, key); if (key.includes('URL') || key.includes('ORIGIN')) { if (origin(value(map, key), 'NETLIFY_RUNTIME_BACKUP_ORIGIN_INVALID') !== origin(expected[key], 'PRODUCTION_ORIGIN_INVALID')) throw new Error(`NETLIFY_RUNTIME_${key}_MISMATCH`); } else if (value(map, key).toLowerCase() !== clean(expected[key]).toLowerCase()) throw new Error(`NETLIFY_RUNTIME_${key}_MISMATCH`); }
  if (requireLine) {
    for (const key of LINE_KEYS) requirePresent(map, key, { secret: key.includes('SECRET') || key.includes('TOKEN') });
    for (const key of LINE_PUBLIC_KEYS) {
      const pattern = key === 'LINE_LIFF_ID' ? /^\d{8,20}-[A-Za-z0-9_-]{1,100}$/ : /^\d{8,20}$/;
      if (map.get(key)?.secret || !pattern.test(value(map, key))) throw new Error(`NETLIFY_RUNTIME_${key}_INVALID`);
    }
  }
  const publicKeys = requireLine ? [...SNAPSHOT_KEYS, ...LINE_PUBLIC_KEYS] : SNAPSHOT_KEYS;
  const source = map.get('CLINICAL_OS_SOURCE_COMMIT');
  return Object.freeze({
    siteId: clean(siteId).toLowerCase(),
    origin: origin(siteOrigin || expected.CNYOS_OWNER_EXPECTED_SITE_ORIGIN, 'PRODUCTION_ORIGIN_INVALID'),
    context: 'production',
    functionsScopeVerified: true,
    lineRequired: Boolean(requireLine),
    sourceCommitBinding: Object.freeze({ value: value(map, 'CLINICAL_OS_SOURCE_COMMIT'), context: source.context }),
    bindingSnapshot: Object.freeze(Object.fromEntries(publicKeys.map(key => [key, value(map, key)])))
  });
}

function withoutSourceCommit(bindings) {
  return Object.fromEntries(Object.entries(bindings || {}).filter(([key]) => key !== 'CLINICAL_OS_SOURCE_COMMIT'));
}

function assertStableTransition(previous, current, expectedSourceCommit) {
  const { bindingSnapshot: previousBindings, previousSourceBinding: _previousSource, ...previousEnvelope } = previous;
  const { bindingSnapshot: currentBindings, previousSourceBinding: _currentSource, ...currentEnvelope } = current;
  try {
    assert.deepEqual(previousEnvelope, currentEnvelope);
    assert.deepEqual(withoutSourceCommit(previousBindings), withoutSourceCommit(currentBindings));
    assert.equal(currentBindings?.CLINICAL_OS_SOURCE_COMMIT, expectedSourceCommit);
  } catch { throw new Error('NETLIFY_RUNTIME_BINDING_DRIFT'); }
}

async function netlify(pathname, token, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${API}${pathname}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('failed');
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('large');
    return JSON.parse(text);
  } catch { throw new Error('NETLIFY_API_REQUEST_FAILED'); }
}

export async function verifyProductionRuntime({ env = process.env, phase = 'post-upload', fetchImpl = fetch } = {}) {
  if (!PHASES.includes(phase)) throw new Error('NETLIFY_RUNTIME_PHASE_INVALID');
  const siteId = required('NETLIFY_SITE_ID', env).toLowerCase();
  const token = required('NETLIFY_AUTH_TOKEN', env);
  const config = required('CLINICAL_OS_PRODUCTION_CONFIG_JSON', env);
  const releaseCommit = required('EXPECTED_RELEASE_COMMIT', env).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(releaseCommit)) throw new Error('EXPECTED_RELEASE_COMMIT_INVALID');
  expectedProductionBindings({ config, siteId });
  const site = await netlify(`/sites/${encodeURIComponent(siteId)}`, token, fetchImpl);
  if (!site || typeof site !== 'object' || Array.isArray(site)) throw new Error('NETLIFY_SITE_METADATA_INVALID');
  if (clean(site.id).toLowerCase() !== siteId) throw new Error('NETLIFY_SITE_ID_MISMATCH');
  const siteOrigin = origin(site.ssl_url || site.url, 'NETLIFY_SITE_ORIGIN_INVALID');
  const expectedOrigin = origin(required('EXPECTED_PRODUCTION_HOST', env).startsWith('https://') ? required('EXPECTED_PRODUCTION_HOST', env) : `https://${required('EXPECTED_PRODUCTION_HOST', env)}`, 'EXPECTED_PRODUCTION_HOST_INVALID');
  if (siteOrigin !== expectedOrigin) throw new Error('NETLIFY_SITE_ORIGIN_MISMATCH');
  if (site.published_deploy?.context !== 'production') throw new Error('NETLIFY_PUBLISHED_CONTEXT_MISMATCH');
  const accountId = clean(site.account_id || site.account?.id);
  if (!accountId) throw new Error('NETLIFY_SITE_ACCOUNT_ID_UNAVAILABLE');
  const metadata = await netlify(`/accounts/${encodeURIComponent(accountId)}/env?site_id=${encodeURIComponent(siteId)}&scope=functions`, token, fetchImpl);
  const expectedSourceCommit = phase === 'rollback'
    ? required('EXPECTED_PREVIOUS_SOURCE_COMMIT', env).toLowerCase()
    : releaseCommit;
  if (!/^[0-9a-f]{40}$/.test(expectedSourceCommit)) throw new Error('EXPECTED_RUNTIME_SOURCE_COMMIT_INVALID');
  const evidence = assertProductionRuntimeBinding({
    metadata,
    config,
    siteId,
    siteOrigin,
    releaseCommit: expectedSourceCommit,
    sourceCommitPolicy: phase === 'pre-upload' ? 'valid' : 'exact',
    requireLine: env.RELEASE_REQUIRES_LINE === 'true'
  });
  const snapshotPath = path.resolve(env.NETLIFY_RUNTIME_BINDING_SNAPSHOT_PATH || 'artifacts/production-deploy/runtime-binding.json');
  // Hash only validated browser-public identity, never arbitrary config extras.
  const configDigest = crypto.createHash('sha256').update(JSON.stringify(expectedProductionBindings({ config, siteId, siteOrigin }))).digest('hex');
  const snapshot = {
    schemaVersion: 3,
    evidenceType: 'site_configuration_preflight_only',
    context: 'production',
    releaseCommit,
    siteId: evidence.siteId,
    origin: evidence.origin,
    configDigest,
    lineRequired: evidence.lineRequired,
    previousSourceBinding: evidence.sourceCommitBinding,
    bindingSnapshot: evidence.bindingSnapshot
  };
  if (phase === 'pre-upload') {
    try {
      await fs.mkdir(path.dirname(snapshotPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    } catch { throw new Error('NETLIFY_RUNTIME_SNAPSHOT_WRITE_FAILED'); }
    if (env.GITHUB_OUTPUT) {
      try {
        await fs.appendFile(env.GITHUB_OUTPUT, `previous_source_commit=${evidence.sourceCommitBinding.value}\nprevious_source_context=${evidence.sourceCommitBinding.context}\n`);
      } catch { throw new Error('NETLIFY_RUNTIME_OUTPUT_WRITE_FAILED'); }
    }
  } else {
    let previous;
    try { previous = JSON.parse(await fs.readFile(snapshotPath, 'utf8')); }
    catch { throw new Error('NETLIFY_RUNTIME_PRE_SNAPSHOT_MISSING'); }
    assertStableTransition(previous, snapshot, expectedSourceCommit);
  }
  process.stdout.write(`Production Functions runtime binding metadata checked (${phase}) for ${evidence.origin}; this does not prove immutable deployed snapshot or secret validity\n`);
  return evidence;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) verifyProductionRuntime({ phase: process.argv[2] || 'post-upload' }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
