import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA40 = /^[0-9a-f]{40}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NETLIFY_DEPLOY_ID = /^[0-9a-f]{24}$/i;
const PROJECT_REF = /^[a-z]{20}$/;

export function requiredEnv(name, env = process.env) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

export function currentSource({ env = process.env } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const expected = String(env.EXPECTED_RELEASE_COMMIT || env.GITHUB_SHA || commit).trim();
  assert.match(expected, SHA40, 'production admission requires a full release SHA');
  assert.equal(commit, expected, 'production admission checkout does not match the expected release SHA');
  assert.match(tree, SHA40, 'production admission Git tree is invalid');
  return { commit, tree };
}

export function parseProductionConfig(raw) {
  let config;
  try { config = JSON.parse(String(raw || '')); }
  catch { throw new Error('CLINICAL_OS_PRODUCTION_CONFIG_JSON_INVALID'); }
  if (config?.schemaVersion !== 1 || config?.database?.provider !== 'supabase') {
    throw new Error('CLINICAL_OS_PRODUCTION_CONFIG_JSON_UNSUPPORTED');
  }
  const clinicId = String(config?.tenant?.expectedClinicId || '').trim();
  const clinicCode = String(config?.tenant?.expectedClinicCode || '').trim().toUpperCase();
  if (!UUID.test(clinicId)) throw new Error('PRODUCTION_CLINIC_ID_INVALID');
  if (!/^[A-Z0-9][A-Z0-9._-]{1,63}$/.test(clinicCode)) throw new Error('PRODUCTION_CLINIC_CODE_INVALID');
  let databaseUrl;
  try { databaseUrl = new URL(String(config?.database?.url || '').trim()); }
  catch { throw new Error('PRODUCTION_SUPABASE_URL_INVALID'); }
  if (databaseUrl.protocol !== 'https:'
    || databaseUrl.pathname !== '/'
    || databaseUrl.search
    || databaseUrl.hash
    || databaseUrl.username
    || databaseUrl.password) {
    throw new Error('PRODUCTION_SUPABASE_URL_INVALID');
  }
  const match = /^([a-z]{20})\.supabase\.co$/.exec(databaseUrl.hostname);
  if (!match) throw new Error('PRODUCTION_SUPABASE_PROJECT_REF_INVALID');
  return Object.freeze({
    config,
    clinicId,
    clinicCode,
    databaseOrigin: databaseUrl.origin,
    projectRef: match[1]
  });
}

export function loadProductionTarget(env = process.env) {
  const target = parseProductionConfig(requiredEnv('CLINICAL_OS_PRODUCTION_CONFIG_JSON', env));
  const expectedProjectRef = requiredEnv('PRODUCTION_EXPECTED_SUPABASE_PROJECT_REF', env).toLowerCase();
  const expectedClinicId = requiredEnv('PRODUCTION_EXPECTED_CLINIC_ID', env).toLowerCase();
  const expectedClinicCode = requiredEnv('PRODUCTION_EXPECTED_CLINIC_CODE', env).toUpperCase();
  if (!PROJECT_REF.test(expectedProjectRef) || target.projectRef !== expectedProjectRef) {
    throw new Error('PRODUCTION_SUPABASE_PROJECT_CONFIRMATION_MISMATCH');
  }
  if (!UUID.test(expectedClinicId) || target.clinicId.toLowerCase() !== expectedClinicId) {
    throw new Error('PRODUCTION_CLINIC_ID_CONFIRMATION_MISMATCH');
  }
  if (target.clinicCode !== expectedClinicCode) {
    throw new Error('PRODUCTION_CLINIC_CODE_CONFIRMATION_MISMATCH');
  }
  return target;
}

async function fetchJson(url, { method = 'POST', headers = {}, body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error(`PRODUCTION_CONTROL_REQUEST_FAILED:${error?.name || 'network'}`);
  }
  const text = await response.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { throw new Error(`PRODUCTION_CONTROL_RESPONSE_INVALID:${response.status}`); }
  }
  if (!response.ok) throw new Error(`PRODUCTION_CONTROL_REQUEST_DENIED:${response.status}`);
  return parsed;
}

export async function supabaseServiceRpc(target, serviceRoleKey, name, body = {}) {
  const key = String(serviceRoleKey || '').trim();
  if (!key || key === target.config?.database?.publishableKey) {
    throw new Error('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY_INVALID');
  }
  return fetchJson(`${target.databaseOrigin}/rest/v1/rpc/${encodeURIComponent(name)}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    body
  });
}

export async function listExactSubscription(target, serviceRoleKey) {
  const rows = await supabaseServiceRpc(target, serviceRoleKey, 'list_owner_subscription_clinics', {});
  if (!Array.isArray(rows)) throw new Error('PRODUCTION_SUBSCRIPTION_LIST_INVALID');
  const matching = rows.filter(row =>
    String(row?.clinic_id || '').toLowerCase() === target.clinicId.toLowerCase()
    && String(row?.clinic_code || '').trim().toUpperCase() === target.clinicCode
  );
  if (matching.length !== 1) throw new Error('PRODUCTION_SUBSCRIPTION_TARGET_NOT_UNIQUE');
  const row = matching[0];
  const version = Number(row?.subscription_version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('PRODUCTION_SUBSCRIPTION_VERSION_INVALID');
  return Object.freeze({
    clinicId: String(row.clinic_id),
    clinicCode: String(row.clinic_code).toUpperCase(),
    enabled: row.enabled === true,
    state: String(row.subscription_state || ''),
    version,
    changedAt: row.changed_at || null,
    changedBy: row.changed_by || null,
    changeReason: row.change_reason || null
  });
}

export function assertSuspended(row) {
  assert.equal(row.enabled, false, 'production tenant must be OFF before deployment/admission checks');
  assert.equal(row.state, 'suspended', 'production tenant subscription_state must be suspended');
  assert.ok(row.changedAt && Number.isFinite(Date.parse(row.changedAt)), 'production suspension changedAt evidence missing');
  assert.ok(String(row.changedBy || '').trim(), 'production suspension changedBy evidence missing');
  assert.ok(String(row.changeReason || '').trim().length >= 8, 'production suspension reason evidence missing');
  return row;
}

export function assertActive(row) {
  assert.equal(row.enabled, true, 'production tenant must be ON for final admission verification');
  assert.equal(row.state, 'active', 'production tenant subscription_state must be active');
  assert.ok(row.changedAt && Number.isFinite(Date.parse(row.changedAt)), 'production activation changedAt evidence missing');
  assert.ok(String(row.changedBy || '').trim(), 'production activation changedBy evidence missing');
  assert.ok(String(row.changeReason || '').trim().length >= 8, 'production activation reason evidence missing');
  return row;
}

export function parseAdmissionAttestation(raw) {
  if (!String(raw || '').trim()) throw new Error('PRODUCTION_ADMISSION_ATTESTATION_JSON_REQUIRED');
  try { return JSON.parse(raw); }
  catch { throw new Error('PRODUCTION_ADMISSION_ATTESTATION_JSON_INVALID'); }
}

export function validateAdmissionAttestation(attestation, { source, target, origin }) {
  assert.equal(attestation?.schemaVersion, 1, 'production admission attestation schema mismatch');
  assert.equal(attestation?.evidenceType, 'cnyos_real_patient_data_admission_attestation');
  assert.equal(attestation?.admitRealPatientData, true, 'real-patient-data admission is not approved');
  assert.equal(attestation?.releaseCommit, source.commit, 'admission attestation belongs to another commit');
  assert.equal(attestation?.releaseTree, source.tree, 'admission attestation belongs to another Git tree');
  assert.match(String(attestation?.netlifyDeployId || ''), NETLIFY_DEPLOY_ID, 'admission Netlify deploy ID invalid');
  assert.equal(String(attestation?.clinicId || '').toLowerCase(), target.clinicId.toLowerCase(), 'admission clinic ID mismatch');
  assert.equal(String(attestation?.clinicCode || '').toUpperCase(), target.clinicCode, 'admission clinic code mismatch');
  assert.equal(String(attestation?.productionOrigin || '').replace(/\/$/, ''), origin, 'admission production origin mismatch');
  const version = Number(attestation?.expectedSubscriptionVersion);
  assert.ok(Number.isSafeInteger(version) && version > 0, 'admission expected subscription version invalid');
  for (const field of ['postDeployArtifact', 'monitoringArtifact', 'approvalReference', 'approvedBy']) {
    assert.ok(String(attestation?.[field] || '').trim(), `admission ${field} missing`);
  }
  for (const field of ['postDeployVerifiedAt', 'monitoringVerifiedAt', 'approvedAt']) {
    assert.ok(Number.isFinite(Date.parse(attestation?.[field])), `admission ${field} invalid`);
  }
  const approvedAt = Date.parse(attestation.approvedAt);
  assert.ok(approvedAt >= Date.parse(attestation.postDeployVerifiedAt), 'admission approval predates post-deploy verification');
  assert.ok(approvedAt >= Date.parse(attestation.monitoringVerifiedAt), 'admission approval predates monitoring verification');
  return Object.freeze({ ...attestation, expectedSubscriptionVersion: version });
}

export async function verifyNetlifyPublishedDeploy(attestation, env = process.env) {
  const siteId = requiredEnv('PRODUCTION_NETLIFY_SITE_ID', env);
  const token = requiredEnv('NETLIFY_AUTH_TOKEN', env);
  const expectedHost = requiredEnv('PRODUCTION_SITE_HOST', env).toLowerCase();
  const response = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`NETLIFY_ADMISSION_VERIFY_FAILED:${response.status}`);
  const site = await response.json();
  assert.equal(site?.id, siteId, 'admission Netlify site ID mismatch');
  const url = new URL(site.ssl_url || site.url);
  assert.equal(url.protocol, 'https:', 'admission Netlify production URL must use HTTPS');
  assert.equal(url.hostname.toLowerCase(), expectedHost, 'admission Netlify production host mismatch');
  const deploy = site?.published_deploy;
  assert.ok(deploy, 'admission Netlify site has no published deploy');
  assert.equal(deploy.id, attestation.netlifyDeployId, 'admission approval is for a different Netlify deploy');
  assert.equal(deploy.state, 'ready', 'admission Netlify deploy is not ready');
  assert.equal(deploy.context, 'production', 'admission Netlify deploy is not production context');
  assert.match(String(deploy.title || ''), new RegExp(attestation.releaseCommit.slice(0, 12), 'i'), 'admission Netlify deploy title does not identify the release commit');
  return Object.freeze({ siteId, origin: url.origin, deployId: deploy.id, publishedAt: deploy.published_at || null });
}

export async function readPublicDeploymentEvidence(file, { source, origin }) {
  let evidence;
  try { evidence = JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
  catch { throw new Error('PRODUCTION_PUBLIC_DEPLOYMENT_EVIDENCE_INVALID'); }
  assert.equal(evidence?.evidenceType, 'public_production_deployment_attestation');
  assert.equal(evidence?.releaseCommit, source.commit, 'public deployment evidence commit mismatch');
  assert.equal(evidence?.releaseTree, source.tree, 'public deployment evidence tree mismatch');
  assert.equal(String(evidence?.origin || '').replace(/\/$/, ''), origin, 'public deployment evidence origin mismatch');
  assert.ok(Number.isFinite(Date.parse(evidence?.verifiedAt)), 'public deployment evidence timestamp invalid');
  return evidence;
}

export async function writeEvidence(file, value) {
  const destination = path.resolve(file);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return destination;
}
