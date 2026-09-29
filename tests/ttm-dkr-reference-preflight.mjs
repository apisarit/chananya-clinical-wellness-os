import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDkrDataset, loadDkrDataset, DKR_DATASET_VERSION } from '../scripts/import-ttm-dkr-staging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = name => JSON.parse(fs.readFileSync(path.join(root, 'config', name), 'utf8'));
const staging = config('tenant.staging.example.json');
const production = config('tenant.chananya.json');
const env = {
  CLINICAL_OS_STAGING_DKR_IMPORT: DKR_DATASET_VERSION,
  CLINICAL_OS_STAGING_DEPLOYMENT: 'true', CLINICAL_OS_ALLOW_STAGING_DATABASE: 'true',
  CLINICAL_OS_STAGING_DATABASE_ACK: 'STAGING_ONLY',
  CLINICAL_OS_TENANT_CONFIG_JSON: JSON.stringify(staging),
  CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(production),
  URL: staging.auth.redirectOrigin, SUPABASE_URL: staging.database.url,
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-staging-placeholder-key',
  BACKUP_PRODUCTION_SUPABASE_URL: production.database.url,
};
const dataset = loadDkrDataset(root);
const codes = ['dosha.pitta', 'dosha.vata', 'dosha.semha',
  'element.tejo', 'element.vayo', 'element.apo', 'element.pathavi',
  'coordinate.pitta.apattha', 'coordinate.pitta.pattha', 'coordinate.pitta.kamdao',
  'coordinate.vata.hathai', 'coordinate.vata.satthaka', 'coordinate.vata.sumana',
  'coordinate.semha.saw', 'coordinate.semha.ura', 'coordinate.semha.kutha', 'coordinate.pathavi'];
const foundation = codes.map((concept_code, index) => ({ id: `foundation-${index}`, concept_code,
  version: 'TTM-FOUNDATION-v1', review_status: 'review_required' }));

async function runFixture({ missing, missingAfterRead, duplicate, invalidResponse,
  denied, wrongVersion, crossVersionStatus, unsafeMetadata, approvedConcept,
  reviewedRelationStatus, reviewedSourceStatus, reviewedBodyStatus, invalidSourceRead, expectedFailure } = {}) {
  const originalFetch = globalThis.fetch;
  const writes = [];
  let foundationReads = 0;
  let preservedRelation;
  let preservedBody;
  const sources = new Map();
  const originalSources = new Map();
  const tables = { ttm_diagnostic_knowledge: [], ttm_concepts: [], ttm_concept_relations: [] };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, new URL(staging.database.url).origin);
    const table = url.pathname.split('/').at(-1);
    const method = options.method || 'GET';
    const response = data => new Response(JSON.stringify(data), { status: 200 });
    if (method === 'HEAD') {
      const rows = tables[table].filter(row => !url.searchParams.has('version')
        || row.version === url.searchParams.get('version').slice(3));
      return new Response(null, { status: 200, headers: { 'content-range': `0-0/${rows.length}` } });
    }
    if (method === 'POST') {
      const rows = JSON.parse(options.body);
      writes.push({ table, rows });
      if (table === 'ttm_sources') {
        if (!reviewedSourceStatus) return response(rows.map(row => ({ ...row, id: row.source_code })));
        const inserted = [];
        for (const row of rows) {
          const original = { ...row, id: row.source_code, review_status: reviewedSourceStatus,
            active: false, citation: 'Synthetic reviewed citation', metadata: { reviewed_note: 'synthetic' } };
          sources.set(row.source_code, structuredClone(original));
          originalSources.set(row.source_code, original);
          if (!new Headers(options.headers).get('prefer').includes('resolution=ignore-duplicates')) {
            sources.set(row.source_code, { ...original, ...row });
            inserted.push(sources.get(row.source_code));
          }
        }
        return response(inserted);
      }
      assert.ok(table in tables, `unexpected write ${table}`);
      if (table === 'ttm_concepts' && rows[0]?.version === dataset.body_model.version && reviewedBodyStatus) {
        preservedBody = { ...rows[0], id: 'synthetic-reviewed-body', active: false,
          review_status: reviewedBodyStatus, definition: 'Synthetic reviewed definition',
          metadata: { member_count_approved: 1, retained_note: 'synthetic' } };
        tables[table].push(new Headers(options.headers).get('prefer').includes('resolution=ignore-duplicates')
          ? structuredClone(preservedBody) : { ...preservedBody, ...rows[0] });
        tables[table].push(...rows.slice(1).map((row, index) => ({ ...row, id: `body-${index}` })));
        return response(null);
      }
      if (table === 'ttm_concept_relations' && reviewedRelationStatus) {
        if (!preservedRelation) {
          preservedRelation = { ...rows[0], id: 'synthetic-reviewed-edge',
            review_status: reviewedRelationStatus, active: false,
            evidence_note: 'Synthetic reviewed evidence, not the raw workbook',
            qualifiers: { retained_review: 'synthetic' } };
          tables[table].push(structuredClone(preservedRelation));
        }
        const keys = url.searchParams.get('on_conflict').split(',');
        for (const row of rows) {
          const index = tables[table].findIndex(existing => keys.every(key => existing[key] === row[key]));
          if (index < 0) tables[table].push({ ...row, id: `edge-${tables[table].length}` });
          else if (!new Headers(options.headers).get('prefer').includes('resolution=ignore-duplicates')) {
            tables[table][index] = { ...tables[table][index], ...row };
          }
        }
        return response(null);
      }
      tables[table].push(...rows.map((row, index) => ({ ...row, id: `${table}-${tables[table].length + index}` })));
      return response(null);
    }
    assert.equal(method, 'GET');
    if (table === 'ttm_sources') {
      const row = sources.get(url.searchParams.get('source_code').slice(3));
      if (invalidSourceRead === 'missing') return response([]);
      if (invalidSourceRead === 'duplicate') return response([row, row]);
      if (invalidSourceRead === 'wrong-code') return response([{ ...row, source_code: 'WRONG-SOURCE' }]);
      if (invalidSourceRead === 'missing-id') return response([{ ...row, id: null }]);
      if (invalidSourceRead === 'malformed') return response({ unexpected: row });
      return response([row]);
    }
    if (table === 'ttm_diagnostic_knowledge') return response(unsafeMetadata ? [{ ...dataset.rules[0],
      version: 'TTM-DKR-v1', review_status: 'review_required',
      metadata: { clinical_inference_allowed: true, retained_note: 'synthetic' } }] : []);
    assert.equal(table, 'ttm_concepts');
    if (url.searchParams.get('version') === 'eq.TTM-FOUNDATION-v1') {
      foundationReads++;
      if (denied) return new Response(JSON.stringify({ message: 'synthetic access denied' }), { status: 403 });
      if (invalidResponse) return response({ unexpected: 'not an array' });
      const rows = foundation.filter(row => row.concept_code !== missing
        && !(foundationReads > 1 && row.concept_code === missingAfterRead))
        .map(row => wrongVersion ? { ...row, version: 'WRONG-VERSION' } : row);
      if (duplicate) rows.push({ ...rows[0], id: 'duplicate-reference' });
      if (crossVersionStatus) rows.push({ id: 'different-version-same-code', version: 'TTM-FOUNDATION-v1',
        concept_code: dataset.rules[0].concept_code, review_status: 'approved' });
      return response(rows);
    }
    const version = url.searchParams.get('version').slice(3);
    if (approvedConcept && version === 'TTM-DKR-v1' && tables.ttm_concepts.length === 0) {
      return response([{ ...dataset.rules[3], version, review_status: 'approved',
        preferred_term_th: 'Synthetic reviewed concept', definition: 'Synthetic reviewed definition' }]);
    }
    if (unsafeMetadata && version === 'TTM-DKR-v1' && tables.ttm_concepts.length === 0) {
      return response([{ ...dataset.rules[0], version, review_status: 'review_required',
        metadata: { clinical_inference_allowed: true, retained_note: 'synthetic-concept' } }]);
    }
    return response(tables.ttm_concepts.filter(row => row.version === version));
  };
  try {
    if (expectedFailure) await assert.rejects(importDkrDataset({ env, cwd: root }), expectedFailure);
    else {
      const result = await importDkrDataset({ env, cwd: root });
      assert.equal(result.rules, 113);
      assert.equal(result.concepts, 113);
      assert.equal(result.bodyGroups, 4);
      assert.ok(result.typedRelations > 4);
      if (reviewedSourceStatus) assert.deepEqual(sources, originalSources,
        're-import must not reset source review, citation, metadata or active state');
      if (reviewedBodyStatus) assert.deepEqual(
        tables.ttm_concepts.find(row => row.id === preservedBody.id), preservedBody,
        're-import must not reset body registry review or approved member metadata');
      assert.ok(writes.filter(write => write.table === 'ttm_concept_relations')
        .flatMap(write => write.rows).every(row => row.review_status === 'review_required'),
      'generated edges must not inherit approval from a concept');
      if (reviewedRelationStatus) assert.deepEqual(
        tables.ttm_concept_relations.find(row => row.id === preservedRelation.id), preservedRelation,
        're-import must not overwrite existing relation review, evidence, qualifiers or active state');
      if (unsafeMetadata) {
        const row = tables.ttm_diagnostic_knowledge[0];
        assert.equal(row.metadata.clinical_inference_allowed, false,
          'unreviewed imported knowledge cannot inherit clinical permission from stale metadata');
        assert.equal(row.metadata.retained_note, 'synthetic');
        assert.equal(tables.ttm_concepts[0].metadata.clinical_inference_allowed, false);
        assert.equal(tables.ttm_concepts[0].metadata.retained_note, 'synthetic-concept');
      }
      for (const row of foundation) assert.ok(tables.ttm_concept_relations.some(edge => edge.object_concept_id === row.id),
        `expected a mapped edge to ${row.concept_code}`);
    }
  } finally { globalThis.fetch = originalFetch; }
  return { writes, foundationReads };
}

const absent = await runFixture({ missing: 'coordinate.pitta.apattha', expectedFailure: /TTM_DKR_REFERENCE_MISSING/ });
assert.equal(absent.writes.length, 0, 'missing foundation reference must stop before source or rule mutations');
await runFixture();
await runFixture({ reviewedSourceStatus: 'approved' });
await runFixture({ reviewedSourceStatus: 'rejected' });
await runFixture({ reviewedBodyStatus: 'approved' });
await runFixture({ reviewedBodyStatus: 'rejected' });
for (const invalidSourceRead of ['missing', 'duplicate', 'wrong-code', 'missing-id', 'malformed']) {
  const result = await runFixture({ reviewedSourceStatus: 'approved', invalidSourceRead,
    expectedFailure: /TTM_DKR_SOURCE_IDENTITY_INVALID/ });
  assert.equal(result.writes.filter(write => write.table !== 'ttm_sources').length, 0,
    'invalid source readback must refuse dependent writes');
}
await runFixture({ approvedConcept: true });
await runFixture({ reviewedRelationStatus: 'approved' });
await runFixture({ reviewedRelationStatus: 'rejected' });
await runFixture({ approvedConcept: true, reviewedRelationStatus: 'rejected' });
await runFixture({ unsafeMetadata: true });
await runFixture({ crossVersionStatus: true });
for (const missing of codes) {
  const result = await runFixture({ missing, expectedFailure: /TTM_DKR_REFERENCE_MISSING/ });
  assert.equal(result.writes.length, 0, `preflight must fail before writes for ${missing}`);
}
const duplicate = await runFixture({ duplicate: true, expectedFailure: /TTM_DKR_REFERENCE_AMBIGUOUS/ });
assert.equal(duplicate.writes.length, 0);
for (const [option, expectedFailure] of [
  ['invalidResponse', /TTM_DKR_REFERENCE_INVALID_RESPONSE/],
  ['wrongVersion', /TTM_DKR_REFERENCE_MISSING/],
  ['denied', /HTTP 403/],
]) {
  const result = await runFixture({ [option]: true, expectedFailure });
  assert.equal(result.writes.length, 0, `${option} must stop before mutations`);
}
const disappeared = await runFixture({ missingAfterRead: 'coordinate.pitta.apattha', expectedFailure: /TTM_DKR_REFERENCE_MISSING/ });
assert.ok(disappeared.writes.length > 0, 'fixture exercises disappearance after preflight, not only initial absence');
assert.equal(disappeared.writes.filter(write => write.table === 'ttm_concept_relations').length, 0,
  'changed references cannot publish a silently incomplete relation batch');
console.log('DKR import contracts passed: required anchors, draft metadata, no inherited edge approval, and existing edge review/content preservation. Synthetic REST fixture only.');
