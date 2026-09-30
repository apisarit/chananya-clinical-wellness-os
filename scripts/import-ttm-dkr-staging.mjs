import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadTenantConfig } from './generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DKR_DATASET_VERSION = 'TTM-DKR-v1-complete-20260830';
export const DKR_SOURCE_CODE = 'TTM-DKR-v1';
export const DKR_GRAPH_VERSION = 'TTM-REASONING-GRAPH-v2';
export const BODY_SOURCE_CODE = 'OWNER-TTM-ONTOLOGY-V2-20260830';
const stagingMarker = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;
const CONTEXT_DOMAINS = new Set([
  'age_samutthan', 'kala_samutthan', 'kala_ekadot', 'kala_duvandot',
  'kala_tridot', 'season_6', 'season_pitsadan'
]);
const AXES = Object.freeze({ 'ปิตตะ': 'dosha.pitta', 'วาตะ': 'dosha.vata', 'เสมหะ': 'dosha.semha' });
const ELEMENTS = Object.freeze({
  'ไฟ': 'element.tejo', 'เตโช': 'element.tejo',
  'ลม': 'element.vayo', 'วาโย': 'element.vayo',
  'น้ำ': 'element.apo', 'อาโป': 'element.apo',
  'ดิน': 'element.pathavi', 'ปถวี': 'element.pathavi'
});
const COORDINATES = Object.freeze([
  ['อพัทธปิตตะ', 'coordinate.pitta.apattha'],
  ['พัทธปิตตะ', 'coordinate.pitta.pattha'],
  ['กำเดา', 'coordinate.pitta.kamdao'],
  ['หทัยวาตะ', 'coordinate.vata.hathai'],
  ['สัตถกวาตะ', 'coordinate.vata.satthaka'],
  ['สุมนาวาตะ', 'coordinate.vata.sumana'],
  ['ศอเสมหะ', 'coordinate.semha.saw'],
  ['อุระเสมหะ', 'coordinate.semha.ura'],
  ['คูถเสมหะ', 'coordinate.semha.kutha'],
  ['ปถวีธาตุ', 'coordinate.pathavi']
]);

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

export function loadDkrDataset(cwd = root) {
  const target = path.join(cwd, 'data', 'ttm', 'ttm-dkr-v1-complete-20260830.json.gz');
  const dataset = JSON.parse(zlib.gunzipSync(fs.readFileSync(target)).toString('utf8'));
  if (dataset.dataset_version !== DKR_DATASET_VERSION) throw new Error('Unexpected TTM-DKR dataset version');
  if (dataset.source?.source_code !== DKR_SOURCE_CODE) throw new Error('Unexpected TTM-DKR source code');
  if (dataset.source?.metadata?.workbook_rule_count !== 113 || dataset.rules?.length !== 113) {
    throw new Error('TTM-DKR complete dataset must contain 113 rules');
  }
  if (!dataset.rules.every(rule => rule.review_status === 'review_required')) {
    throw new Error('Blank workbook review columns must remain review_required');
  }
  if (dataset.body_model?.groups?.reduce((sum, group) => sum + group.target_count, 0) !== 42) {
    throw new Error('TTM asymmetric body registry targets must total 42');
  }
  return dataset;
}

export function validateDkrImportEnvironment(env = process.env, cwd = root) {
  if (env.CLINICAL_OS_STAGING_DKR_IMPORT !== DKR_DATASET_VERSION) return Object.freeze({ enabled: false });
  if (env.CLINICAL_OS_STAGING_DEPLOYMENT !== 'true') throw new Error('TTM-DKR import requires a dedicated staging deployment');
  if (env.CLINICAL_OS_ALLOW_STAGING_DATABASE !== 'true') throw new Error('TTM-DKR import requires explicit staging database access');
  if (env.CLINICAL_OS_STAGING_DATABASE_ACK !== 'STAGING_ONLY') throw new Error('TTM-DKR import requires STAGING_ONLY acknowledgement');

  const config = loadTenantConfig({ env, cwd });
  if (!stagingMarker.test(config.deploymentId)) throw new Error('TTM-DKR import rejected a non-staging deploymentId');
  if (config.safety?.previewLocked || !config.database?.url) throw new Error('TTM-DKR import cannot run against a locked database config');
  const serviceRoleKey = required(env, 'SUPABASE_SERVICE_ROLE_KEY', { min: 20, max: 8192 });
  const runtimeDatabase = httpsOrigin(required(env, 'SUPABASE_URL', { max: 240 }), 'SUPABASE_URL');
  const configuredDatabase = httpsOrigin(config.database.url, 'database.url');
  const productionDatabase = httpsOrigin(required(env, 'BACKUP_PRODUCTION_SUPABASE_URL', { max: 240 }), 'BACKUP_PRODUCTION_SUPABASE_URL');
  if (runtimeDatabase !== configuredDatabase) throw new Error('SUPABASE_URL does not match the isolated staging tenant config');
  if (runtimeDatabase === productionDatabase) throw new Error('TTM-DKR import rejected the Production Supabase project');
  return Object.freeze({ enabled: true, config, serviceRoleKey, databaseOrigin: runtimeDatabase });
}

async function request(target, resource, {
  method = 'GET', body, prefer, headers = {}, expected = [200, 201, 204, 206]
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
  if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
  if (!expected.includes(response.status)) {
    const detail = typeof data === 'string' ? data : data?.message || data?.hint || data?.code || 'request failed';
    throw new Error(`TTM-DKR import HTTP ${response.status}: ${String(detail).slice(0, 500)}`);
  }
  return { data, headers: response.headers, status: response.status };
}

async function batches(items, size, worker) {
  for (let start = 0; start < items.length; start += size) await worker(items.slice(start, start + size));
}

function knowledgeKey(row) {
  return [row.domain, row.rule_key, row.input_key || '', row.version || 'TTM-DKR-v1'].join('|');
}

function conceptType(domain) {
  if (['constitution', 'conception_month', 'birth_weekday'].includes(domain)) return 'constitution_rule';
  if (domain === 'coordinate') return 'coordinate';
  if (domain === 'food_taste') return 'guidance_rule';
  return 'context_rule';
}

function foundationLayer(domain) {
  if (['constitution', 'conception_month', 'birth_weekday'].includes(domain)) return 1;
  if (domain === 'food_taste') return 4;
  return 2;
}

function conceptDefinition(rule) {
  return [
    rule.output_value,
    rule.description,
    rule.coordinate !== rule.input_key && rule.coordinate !== rule.output_value ? rule.coordinate : null
  ].filter(Boolean).join(' — ');
}

function doshaWeights(rule) {
  const proportions = rule.metadata?.proportions;
  if (proportions && typeof proportions === 'object') {
    return Object.fromEntries(Object.entries(proportions).filter(([axis, weight]) => AXES[axis] && Number(weight) > 0));
  }
  const text = [rule.samutthan, rule.output_value, rule.description].filter(Boolean).join(' ');
  const weights = {};
  for (const axis of Object.keys(AXES)) {
    if (!text.includes(axis)) continue;
    const match = text.match(new RegExp(`${axis}[^0-9]{0,18}(\\d+)\\s*ส่วน`));
    weights[axis] = match ? Number(match[1]) : 1;
  }
  return weights;
}

function elementCode(rule) {
  const normalized = String(rule.element || '').trim();
  return ELEMENTS[normalized] || null;
}

function coordinateCode(rule) {
  const text = [rule.coordinate, rule.input_key, rule.output_value].filter(Boolean).join(' ');
  return COORDINATES.find(([term]) => text.includes(term))?.[1] || null;
}

function ruleMetadata(rule, existingMetadata = {}) {
  return {
    workbook: 'TTM_Diagnostic_Knowledge_Review_v1.xlsx',
    workbook_sha256: '64e95db966b054dd37b6a4e33dbfe26612cb4a6943f258b154d96b1dfad74c7b',
    sheet: rule.sheet_name,
    row: rule.sheet_row,
    review_column_blank: true,
    import_revision: '2026-08-30',
    rule_role: CONTEXT_DOMAINS.has(rule.domain) ? 'context_only' : 'reference_only',
    clinical_inference_allowed: false,
    ...(rule.metadata || {}),
    ...(existingMetadata || {})
  };
}

function relationRow({ subject, predicate, object, sourceId, rule, qualifiers, reviewStatus }) {
  return {
    subject_concept_id: subject,
    predicate,
    object_concept_id: object,
    source_id: sourceId,
    evidence_note: [rule.output_value, rule.source_ref].filter(Boolean).join(' • '),
    qualifiers: {
      domain: rule.domain,
      input_key: rule.input_key,
      source_ref: rule.source_ref,
      evidence_scope: 'context_only_not_diagnosis',
      ...(qualifiers || {})
    },
    review_status: reviewStatus || 'review_required',
    version: DKR_GRAPH_VERSION,
    active: true
  };
}

async function exactCount(target, table, filters) {
  const query = new URLSearchParams({ select: 'id', limit: '1', ...filters });
  const result = await request(target, `${table}?${query}`, {
    method: 'HEAD', prefer: 'count=exact', headers: { Range: '0-0' }, expected: [200, 206]
  });
  const match = (result.headers.get('content-range') || '').match(/\/(\d+)$/);
  if (!match) throw new Error(`Missing exact count for ${table}`);
  return Number(match[1]);
}

export async function importDkrDataset({ env = process.env, cwd = root } = {}) {
  const target = validateDkrImportEnvironment(env, cwd);
  if (!target.enabled) return Object.freeze({ skipped: true, reason: 'staging DKR import flag not set' });
  const dataset = loadDkrDataset(cwd);

  const sourceResult = await request(target, 'ttm_sources?on_conflict=source_code', {
    method: 'POST',
    body: [{ ...dataset.source, active: true }],
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  const source = sourceResult.data?.[0];
  if (!source?.id) throw new Error('TTM-DKR source upsert did not return an id');

  const bodySourceResult = await request(target, 'ttm_sources?on_conflict=source_code', {
    method: 'POST',
    body: [{
      source_code: BODY_SOURCE_CODE,
      title_th: 'ข้อกำหนดโครงสร้างกาย TTM แบบไม่สมมาตร v2',
      title_en: 'Owner TTM asymmetric body model constraint v2',
      source_type: 'owner_curation_constraint',
      citation: 'Owner-confirmed product ontology direction, 2026-08-30',
      provenance: 'owner_instruction',
      review_status: 'review_required',
      version: '1',
      active: true,
      metadata: { member_policy: dataset.body_model.member_policy, target_total: 42 }
    }],
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  const bodySource = bodySourceResult.data?.[0];
  if (!bodySource?.id) throw new Error('TTM body-model source upsert did not return an id');

  const existingKnowledgeQuery = new URLSearchParams({ select: '*', version: 'eq.TTM-DKR-v1', limit: '1000' });
  const existingKnowledge = (await request(target, `ttm_diagnostic_knowledge?${existingKnowledgeQuery}`)).data || [];
  const knowledgeMap = new Map(existingKnowledge.map(row => [knowledgeKey(row), row]));
  const knowledgeRows = dataset.rules.map(rule => {
    const existing = knowledgeMap.get(knowledgeKey(rule));
    const locked = ['approved', 'rejected'].includes(existing?.review_status);
    const sourceRow = locked ? existing : rule;
    return {
      domain: rule.domain,
      rule_key: rule.rule_key,
      input_key: rule.input_key,
      output_value: sourceRow.output_value,
      element: sourceRow.element,
      samutthan: sourceRow.samutthan,
      coordinate: sourceRow.coordinate,
      description: sourceRow.description,
      source_ref: sourceRow.source_ref,
      source_class: sourceRow.source_class || rule.source_class,
      review_status: existing?.review_status || 'review_required',
      version: 'TTM-DKR-v1',
      active: existing?.active ?? true,
      metadata: ruleMetadata(rule, existing?.metadata)
    };
  });
  await batches(knowledgeRows, 60, batch => request(target, 'ttm_diagnostic_knowledge?on_conflict=domain,rule_key,input_key,version', {
    method: 'POST', body: batch, prefer: 'resolution=merge-duplicates,return=minimal', expected: [200, 201]
  }));

  const existingConceptQuery = new URLSearchParams({ select: '*', version: 'eq.TTM-DKR-v1', limit: '1000' });
  const existingConcepts = (await request(target, `ttm_concepts?${existingConceptQuery}`)).data || [];
  const conceptMap = new Map(existingConcepts.map(row => [row.concept_code, row]));
  const conceptRows = dataset.rules.map(rule => {
    const existing = conceptMap.get(rule.concept_code);
    const locked = ['approved', 'rejected'].includes(existing?.review_status);
    return {
      concept_code: rule.concept_code,
      concept_type: conceptType(rule.domain),
      preferred_term_th: locked ? existing.preferred_term_th : (rule.input_key || rule.rule_key),
      preferred_term_en: existing?.preferred_term_en || null,
      foundation_layer: foundationLayer(rule.domain),
      definition: locked ? existing.definition : conceptDefinition(rule),
      source_id: source.id,
      review_status: existing?.review_status || 'review_required',
      version: 'TTM-DKR-v1',
      active: existing?.active ?? true,
      metadata: ruleMetadata(rule, existing?.metadata)
    };
  });
  await batches(conceptRows, 60, batch => request(target, 'ttm_concepts?on_conflict=concept_code,version', {
    method: 'POST', body: batch, prefer: 'resolution=merge-duplicates,return=minimal', expected: [200, 201]
  }));

  const bodyConceptRows = dataset.body_model.groups.map(group => ({
    concept_code: group.code,
    concept_type: 'body_group',
    preferred_term_th: group.label,
    preferred_term_en: null,
    foundation_layer: 2,
    definition: `เป้าหมายทะเบียน ${group.target_count} รายการ; ยังไม่อนุมานชื่อสมาชิกที่ไม่มีแหล่งรับรอง`,
    source_id: bodySource.id,
    review_status: 'review_required',
    version: dataset.body_model.version,
    active: true,
    metadata: {
      target_count: group.target_count,
      member_count_approved: 0,
      asymmetric_model: true,
      member_policy: dataset.body_model.member_policy
    }
  }));
  await request(target, 'ttm_concepts?on_conflict=concept_code,version', {
    method: 'POST', body: bodyConceptRows, prefer: 'resolution=merge-duplicates,return=minimal', expected: [200, 201]
  });

  const queries = [
    new URLSearchParams({ select: 'id,concept_code,version,review_status', version: 'eq.TTM-DKR-v1', limit: '1000' }),
    new URLSearchParams({ select: 'id,concept_code,version,review_status', version: 'eq.TTM-FOUNDATION-v1', limit: '1000' }),
    new URLSearchParams({ select: 'id,concept_code,version,review_status', version: `eq.${dataset.body_model.version}`, limit: '1000' })
  ];
  const conceptSets = await Promise.all(queries.map(query => request(target, `ttm_concepts?${query}`)));
  const allConcepts = conceptSets.flatMap(result => result.data || []);
  const idByVersionCode = new Map(allConcepts.map(row => [`${row.version}|${row.concept_code}`, row.id]));
  const statusByCode = new Map(allConcepts.map(row => [row.concept_code, row.review_status]));

  const relationRows = [];
  for (const rule of dataset.rules) {
    const subject = idByVersionCode.get(`TTM-DKR-v1|${rule.concept_code}`);
    if (!subject) throw new Error(`Unresolved TTM-DKR concept ${rule.concept_code}`);
    const reviewStatus = statusByCode.get(rule.concept_code) || 'review_required';
    if (CONTEXT_DOMAINS.has(rule.domain)) {
      for (const [axis, weight] of Object.entries(doshaWeights(rule))) {
        const object = idByVersionCode.get(`TTM-FOUNDATION-v1|${AXES[axis]}`);
        if (object) relationRows.push(relationRow({ subject, predicate: 'context_supports_axis', object, sourceId: source.id, rule, reviewStatus, qualifiers: { axis, weight } }));
      }
    }
    const element = elementCode(rule);
    if (element) {
      const object = idByVersionCode.get(`TTM-FOUNDATION-v1|${element}`);
      if (object) relationRows.push(relationRow({ subject, predicate: 'context_points_to_element', object, sourceId: source.id, rule, reviewStatus }));
    }
    const coordinate = coordinateCode(rule);
    if (coordinate) {
      const object = idByVersionCode.get(`TTM-FOUNDATION-v1|${coordinate}`);
      if (object) relationRows.push(relationRow({ subject, predicate: 'source_record_for_coordinate', object, sourceId: source.id, rule, reviewStatus }));
    }
  }
  for (const group of dataset.body_model.groups) {
    const subject = idByVersionCode.get(`${dataset.body_model.version}|${group.code}`);
    const object = idByVersionCode.get(`${group.anchor_version}|${group.anchor_code}`);
    if (!subject || !object) throw new Error(`Unresolved body registry relation ${group.code}`);
    relationRows.push({
      subject_concept_id: subject,
      predicate: 'registry_target_for',
      object_concept_id: object,
      source_id: bodySource.id,
      evidence_note: `${group.label} • เป้าหมาย ${group.target_count} รายการ`,
      qualifiers: { target_count: group.target_count, member_policy: dataset.body_model.member_policy },
      review_status: 'review_required',
      version: DKR_GRAPH_VERSION,
      active: true
    });
  }
  await batches(relationRows, 60, batch => request(target, 'ttm_concept_relations?on_conflict=subject_concept_id,predicate,object_concept_id,source_id,version', {
    method: 'POST', body: batch, prefer: 'resolution=merge-duplicates,return=minimal', expected: [200, 201]
  }));

  const [knowledgeCount, conceptCount, relationCount, bodyGroupCount] = await Promise.all([
    exactCount(target, 'ttm_diagnostic_knowledge', { version: 'eq.TTM-DKR-v1' }),
    exactCount(target, 'ttm_concepts', { source_id: `eq.${source.id}`, version: 'eq.TTM-DKR-v1' }),
    exactCount(target, 'ttm_concept_relations', { version: `eq.${DKR_GRAPH_VERSION}` }),
    exactCount(target, 'ttm_concepts', { source_id: `eq.${bodySource.id}`, version: `eq.${dataset.body_model.version}` })
  ]);
  if (knowledgeCount !== 113 || conceptCount !== 113 || bodyGroupCount !== 4 || relationCount !== relationRows.length) {
    throw new Error(`TTM-DKR import count mismatch: rules=${knowledgeCount}, concepts=${conceptCount}, relations=${relationCount}/${relationRows.length}, body=${bodyGroupCount}`);
  }
  return Object.freeze({
    skipped: false,
    deploymentId: target.config.deploymentId,
    datasetVersion: DKR_DATASET_VERSION,
    rules: knowledgeCount,
    concepts: conceptCount,
    typedRelations: relationCount,
    bodyGroups: bodyGroupCount,
    bodyTargetTotal: 42,
    reviewStatus: 'review_required_except_preserved_human_decisions'
  });
}

async function main() {
  const result = await importDkrDataset();
  if (result.skipped) {
    process.stdout.write('TTM-DKR staging import skipped; explicit one-time flag not set\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
