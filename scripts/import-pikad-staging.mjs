import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadTenantConfig } from './generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PIKAD_DATASET_VERSION = 'PIKAD-YA-20260830-v1';
export const PIKAD_SOURCE_CODE = 'OWNER-PIKAD-YA-20260830';
const stagingMarker = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;

function required(env, key, { min = 1, max = 8192 } = {}) {
  const value = String(env[key] || '').trim();
  if (value.length < min || value.length > max) throw new Error(`${key} is required`);
  return value;
}

function httpsOrigin(value, field) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error(`${field} must be a valid HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${field} must be a credential-free HTTPS URL`);
  return url.origin;
}

export function loadPikadDataset(cwd = root) {
  const target = path.join(cwd, 'data', 'ttm', 'pikad-ya-20260830.json.gz');
  const payload = zlib.gunzipSync(fs.readFileSync(target)).toString('utf8');
  const dataset = JSON.parse(payload);
  if (dataset.source?.source_code !== PIKAD_SOURCE_CODE) throw new Error('Unexpected พิกัดยา source code');
  if (dataset.source?.metadata?.dataset_version !== PIKAD_DATASET_VERSION) throw new Error('Unexpected พิกัดยา dataset version');
  if (dataset.source?.review_status !== 'review_required' || dataset.safety?.review_status !== 'review_required') {
    throw new Error('พิกัดยา must remain review_required');
  }
  if (!Array.isArray(dataset.normalized?.concepts) || !Array.isArray(dataset.normalized?.relations)) {
    throw new Error('พิกัดยา normalized payload is incomplete');
  }
  return dataset;
}

export function validatePikadImportEnvironment(env = process.env, cwd = root) {
  if (env.CLINICAL_OS_STAGING_KNOWLEDGE_IMPORT !== PIKAD_DATASET_VERSION) {
    return Object.freeze({ enabled: false });
  }
  if (env.CLINICAL_OS_STAGING_DEPLOYMENT !== 'true') throw new Error('พิกัดยา import requires a dedicated staging deployment');
  if (env.CLINICAL_OS_ALLOW_STAGING_DATABASE !== 'true') throw new Error('พิกัดยา import requires explicit staging database access');
  if (env.CLINICAL_OS_STAGING_DATABASE_ACK !== 'STAGING_ONLY') throw new Error('พิกัดยา import requires STAGING_ONLY acknowledgement');

  const config = loadTenantConfig({ env, cwd });
  if (!stagingMarker.test(config.deploymentId)) throw new Error('พิกัดยา import rejected a non-staging deploymentId');
  if (config.safety?.previewLocked || !config.database?.url) throw new Error('พิกัดยา import cannot run against a locked database config');

  const serviceRoleKey = required(env, 'SUPABASE_SERVICE_ROLE_KEY', { min: 20, max: 8192 });
  const runtimeDatabase = httpsOrigin(required(env, 'SUPABASE_URL', { max: 240 }), 'SUPABASE_URL');
  const configuredDatabase = httpsOrigin(config.database.url, 'database.url');
  const productionDatabase = httpsOrigin(required(env, 'BACKUP_PRODUCTION_SUPABASE_URL', { max: 240 }), 'BACKUP_PRODUCTION_SUPABASE_URL');
  if (runtimeDatabase !== configuredDatabase) throw new Error('SUPABASE_URL does not match the isolated staging tenant config');
  if (runtimeDatabase === productionDatabase) throw new Error('พิกัดยา import rejected the Production Supabase project');

  return Object.freeze({ enabled: true, config, serviceRoleKey, databaseOrigin: runtimeDatabase });
}

async function request(target, resource, {
  method = 'GET',
  body,
  prefer,
  headers = {},
  expected = [200, 201, 204, 206]
} = {}) {
  const response = await fetch(`${target.databaseOrigin}/rest/v1/${resource}`, {
    method,
    headers: {
      apikey: target.serviceRoleKey,
      Authorization: `Bearer ${target.serviceRoleKey}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const raw = method === 'HEAD' ? '' : await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = raw; }
  }
  if (!expected.includes(response.status)) {
    const detail = typeof data === 'string' ? data : data?.message || data?.hint || data?.code || 'request failed';
    throw new Error(`พิกัดยา import HTTP ${response.status}: ${String(detail).slice(0, 500)}`);
  }
  return { data, headers: response.headers, status: response.status };
}

async function batches(items, size, worker) {
  for (let start = 0; start < items.length; start += size) {
    await worker(items.slice(start, start + size));
  }
}

function mapByCode(rows) {
  return new Map(rows.map(row => [`${row.version}|${row.concept_code}`, row.id]));
}

async function exactCount(target, table, filters) {
  const query = new URLSearchParams({ select: 'id', limit: '1', ...filters });
  const result = await request(target, `${table}?${query}`, {
    method: 'HEAD',
    prefer: 'count=exact',
    headers: { Range: '0-0' },
    expected: [200, 206]
  });
  const contentRange = result.headers.get('content-range') || '';
  const match = contentRange.match(/\/(\d+)$/);
  if (!match) throw new Error(`Missing exact count for ${table}`);
  return Number(match[1]);
}

export async function importPikadDataset({ env = process.env, cwd = root } = {}) {
  const target = validatePikadImportEnvironment(env, cwd);
  if (!target.enabled) return Object.freeze({ skipped: true, reason: 'staging import flag not set' });
  const dataset = loadPikadDataset(cwd);
  const sourceQuery = new URLSearchParams({ select: '*', source_code: `eq.${PIKAD_SOURCE_CODE}`, limit: '1' });
  const existingSource = (await request(target, `ttm_sources?${sourceQuery}`)).data?.[0] || null;
  const sourcePayload = {
    ...dataset.source,
    active: true,
    review_status: existingSource?.review_status || 'review_required',
    metadata: { ...dataset.source.metadata, ...(existingSource?.metadata || {}) }
  };
  const sourceResult = await request(target, 'ttm_sources?on_conflict=source_code', {
    method: 'POST',
    body: [sourcePayload],
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  const source = sourceResult.data?.[0];
  if (!source?.id) throw new Error('พิกัดยา source upsert did not return an id');

  const conceptRows = dataset.normalized.concepts.map(concept => ({ ...concept, source_id: source.id, active: true }));
  await batches(conceptRows, 75, batch => request(target, 'ttm_concepts?on_conflict=concept_code,version', {
    method: 'POST',
    body: batch,
    prefer: 'resolution=ignore-duplicates,return=minimal',
    expected: [201]
  }));

  const importedConceptQuery = new URLSearchParams({
    select: 'id,concept_code,version',
    version: `eq.${PIKAD_DATASET_VERSION}`,
    limit: '1000'
  });
  const foundationConceptQuery = new URLSearchParams({
    select: 'id,concept_code,version',
    version: 'eq.TTM-FOUNDATION-v1',
    limit: '1000'
  });
  const [importedConcepts, foundationConcepts] = await Promise.all([
    request(target, `ttm_concepts?${importedConceptQuery}`),
    request(target, `ttm_concepts?${foundationConceptQuery}`)
  ]);
  const conceptIds = mapByCode([...(importedConcepts.data || []), ...(foundationConcepts.data || [])]);

  const relationRows = dataset.normalized.relations.map(relation => {
    const subject = conceptIds.get(`${relation.subject_version}|${relation.subject_code}`);
    const object = conceptIds.get(`${relation.object_version}|${relation.object_code}`);
    if (!subject || !object) throw new Error(`Unresolved พิกัดยา relation ${relation.subject_code} ${relation.predicate} ${relation.object_code}`);
    return {
      subject_concept_id: subject,
      predicate: relation.predicate,
      object_concept_id: object,
      source_id: source.id,
      evidence_note: relation.evidence_note,
      qualifiers: relation.qualifiers,
      review_status: 'review_required',
      version: PIKAD_DATASET_VERSION,
      active: true
    };
  });
  await batches(relationRows, 60, batch => request(target, 'ttm_concept_relations?on_conflict=subject_concept_id,predicate,object_concept_id,source_id,version', {
    method: 'POST',
    body: batch,
    prefer: 'resolution=ignore-duplicates,return=minimal',
    expected: [201]
  }));

  const [conceptCount, relationCount] = await Promise.all([
    exactCount(target, 'ttm_concepts', { source_id: `eq.${source.id}`, version: `eq.${PIKAD_DATASET_VERSION}` }),
    exactCount(target, 'ttm_concept_relations', { source_id: `eq.${source.id}`, version: `eq.${PIKAD_DATASET_VERSION}` })
  ]);
  if (conceptCount !== dataset.summary.concepts) {
    throw new Error(`พิกัดยา concept count mismatch: expected ${dataset.summary.concepts}, found ${conceptCount}`);
  }
  if (relationCount !== dataset.summary.relations) {
    throw new Error(`พิกัดยา relation count mismatch: expected ${dataset.summary.relations}, found ${relationCount}`);
  }

  return Object.freeze({
    skipped: false,
    deploymentId: target.config.deploymentId,
    datasetVersion: PIKAD_DATASET_VERSION,
    sourceCode: PIKAD_SOURCE_CODE,
    concepts: conceptCount,
    relations: relationCount,
    warnings: dataset.summary.warnings,
    reviewStatus: 'review_required'
  });
}

async function main() {
  const result = await importPikadDataset();
  if (result.skipped) {
    process.stdout.write('พิกัดยา staging import skipped; explicit one-time flag not set\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
