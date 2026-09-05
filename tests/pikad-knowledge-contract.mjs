import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PIKAD_DATASET_VERSION,
  PIKAD_SOURCE_CODE,
  loadPikadDataset,
  validatePikadImportEnvironment
} from '../scripts/import-pikad-staging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const dataset = loadPikadDataset(root);

assert.equal(dataset.source.source_code, PIKAD_SOURCE_CODE);
assert.equal(dataset.source.metadata.dataset_version, PIKAD_DATASET_VERSION);
assert.equal(dataset.source.metadata.workbook_sha256, 'd5832b06110a5827e26ef28eec19f153c25256adde2bf11c4e6edc8a1fd77d5f');
assert.deepEqual(dataset.source.metadata.worksheet_names, [
  'พิกัดตรี', 'พิกัดจตุ', 'พิกัดเบญ', 'พิกัดสัตตะ', 'พิกัดนวะ',
  'มหาพิกัดตรี', 'มหาพิกัดเบญจะ', 'มหาพิกัดทั่วไป', 'ชีต9'
]);
assert.deepEqual(dataset.summary, {
  sheets: 9,
  nonempty_rows: 351,
  concepts: 565,
  formula_concepts: 143,
  materia_medica_concepts: 405,
  context_concepts: 17,
  relations: 1548,
  matrix_ingredient_relations: 560,
  dosha_claim_relations: 55,
  warnings: 13
});

assert.ok(dataset.normalized.concepts.every(item => item.review_status === 'review_required'));
assert.ok(dataset.normalized.relations.every(item => item.review_status === 'review_required'));
assert.ok(dataset.normalized.relations
  .filter(item => item.predicate === 'has_matrix_ingredient')
  .every(item => item.qualifiers.occurrences.every(occurrence => occurrence.unit_status === 'not_specified')));

for (const dosha of ['dosha.pitta', 'dosha.vata', 'dosha.semha']) {
  assert.ok(dataset.normalized.relations.some(item => item.predicate === 'has_traditional_claim_for' && item.object_code === dosha), `${dosha} claims must be imported`);
}
for (const term of ['ตรีผลา', 'มหาตรีผลา', 'เบญจกูล', 'ยาบำรุงโลหิต']) {
  assert.ok(dataset.normalized.concepts.some(item => item.concept_type === 'formula' && item.preferred_term_th === term), `${term} must be searchable`);
}

const dateWarnings = dataset.warnings.filter(item => item.code === 'EXCEL_DATE_SERIAL_AMBIGUITY');
const outlierWarnings = dataset.warnings.filter(item => item.code === 'NUMERIC_OUTLIER_GT_100');
assert.equal(dateWarnings.length, 11);
assert.equal(outlierWarnings.length, 2);
assert.deepEqual(dateWarnings.find(item => item.source_ref === 'ชีต9!Y9'), {
  severity: 'review_required',
  code: 'EXCEL_DATE_SERIAL_AMBIGUITY',
  source_ref: 'ชีต9!Y9',
  raw_value: 46054,
  display_value: '1/2',
  number_format: 'd/m',
  note: 'เก็บค่าดิบและค่าที่แสดง แต่ไม่แปลงเป็นสัดส่วนหรือขนาดยาอัตโนมัติ'
});
assert.equal(dateWarnings.find(item => item.source_ref === 'ชีต9!E123')?.display_value, '1/4');
assert.match(dataset.safety.secondary_mapping, /ICD\/WHO not applied/);
assert.match(dataset.safety.practitioner_authority, /practitioner confirmation/);

const staging = JSON.parse(read('config/tenant.staging.example.json'));
const production = JSON.parse(read('config/tenant.chananya.json'));
const safeEnv = {
  CLINICAL_OS_STAGING_KNOWLEDGE_IMPORT: PIKAD_DATASET_VERSION,
  CLINICAL_OS_STAGING_DEPLOYMENT: 'true',
  CLINICAL_OS_ALLOW_STAGING_DATABASE: 'true',
  CLINICAL_OS_STAGING_DATABASE_ACK: 'STAGING_ONLY',
  CLINICAL_OS_TENANT_CONFIG_JSON: JSON.stringify(staging),
  CLINICAL_OS_PRODUCTION_CONFIG_JSON: JSON.stringify(production),
  URL: staging.auth.redirectOrigin,
  SUPABASE_URL: staging.database.url,
  SUPABASE_SERVICE_ROLE_KEY: 'staging-service-role-placeholder-key',
  BACKUP_PRODUCTION_SUPABASE_URL: production.database.url
};
assert.equal(validatePikadImportEnvironment({}, root).enabled, false);
assert.equal(validatePikadImportEnvironment(safeEnv, root).enabled, true);
assert.throws(() => validatePikadImportEnvironment({ ...safeEnv, CLINICAL_OS_STAGING_DEPLOYMENT: 'false' }, root), /dedicated staging/);
assert.throws(() => validatePikadImportEnvironment({ ...safeEnv, SUPABASE_URL: production.database.url }, root), /does not match|Production/);
assert.throws(() => validatePikadImportEnvironment({ ...safeEnv, BACKUP_PRODUCTION_SUPABASE_URL: staging.database.url }, root), /Production Supabase/);

const importer = read('scripts/import-pikad-staging.mjs');
const packageJson = read('package.json');
const foundation = read('foundation.js');
assert.match(importer, /resolution=ignore-duplicates/);
assert.match(importer, /review_required/);
assert.match(packageJson, /generate-tenant-config\.mjs && node scripts\/import-pikad-staging\.mjs/);
assert.match(foundation, /OWNER-PIKAD-YA-20260830/);
assert.match(foundation, /JSON\.stringify\(concept\.metadata\)/);

console.log('พิกัดยา contracts passed: 9 sheets, 565 concepts, 1,548 relations, staging-only review-required import');
