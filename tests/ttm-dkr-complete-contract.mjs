import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DKR_DATASET_VERSION,
  DKR_GRAPH_VERSION,
  DKR_SOURCE_CODE,
  loadDkrDataset,
  validateDkrImportEnvironment
} from '../scripts/import-ttm-dkr-staging.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const dataset = loadDkrDataset(root);

assert.equal(dataset.dataset_version, DKR_DATASET_VERSION);
assert.equal(dataset.source.source_code, DKR_SOURCE_CODE);
assert.equal(dataset.rules.length, 113);
assert.deepEqual(dataset.summary.domain_counts, {
  constitution: 3,
  conception_month: 4,
  birth_weekday: 4,
  coordinate: 10,
  age_samutthan: 3,
  kala_samutthan: 5,
  kala_ekadot: 12,
  kala_duvandot: 12,
  kala_tridot: 12,
  season_4: 4,
  season_6: 6,
  season_pitsadan: 18,
  zodiac_samutthan: 12,
  pradesa_samutthan: 4,
  food_taste: 4
});
assert.deepEqual(dataset.summary.source_class_counts, { source_derived: 25, image_transcribed: 88 });
assert.ok(dataset.rules.every(rule => rule.review_status === 'review_required'));
assert.ok(dataset.rules.every(rule => rule.metadata?.clinical_inference_allowed !== true));
assert.equal(dataset.safety.context_is_not_diagnosis, true);
assert.equal(dataset.safety.unapproved_rules_do_not_score_clinical_hypotheses, true);

assert.deepEqual(dataset.body_model.groups.map(group => [group.code, group.target_count]), [
  ['body_registry.pitta4', 4],
  ['body_registry.vata6', 6],
  ['body_registry.semha12', 12],
  ['body_registry.pathavi20', 20]
]);
assert.equal(dataset.body_model.groups.reduce((sum, group) => sum + group.target_count, 0), 42);
assert.match(dataset.body_model.member_policy, /Do not infer or force symmetric members/);

const staging = JSON.parse(read('config/tenant.staging.example.json'));
const production = JSON.parse(read('config/tenant.chananya.json'));
const safeEnv = {
  CLINICAL_OS_STAGING_DKR_IMPORT: DKR_DATASET_VERSION,
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
assert.equal(validateDkrImportEnvironment({}, root).enabled, false);
assert.equal(validateDkrImportEnvironment(safeEnv, root).enabled, true);
assert.throws(() => validateDkrImportEnvironment({ ...safeEnv, CLINICAL_OS_STAGING_DATABASE_ACK: '' }, root), /STAGING_ONLY/);
assert.throws(() => validateDkrImportEnvironment({ ...safeEnv, SUPABASE_URL: production.database.url }, root), /does not match|Production/);
assert.throws(() => validateDkrImportEnvironment({ ...safeEnv, BACKUP_PRODUCTION_SUPABASE_URL: staging.database.url }, root), /Production Supabase/);

const importer = read('scripts/import-ttm-dkr-staging.mjs');
assert.match(importer, new RegExp(DKR_GRAPH_VERSION));
assert.match(importer, /context_supports_axis/);
assert.match(importer, /context_points_to_element/);
assert.match(importer, /source_record_for_coordinate/);
assert.match(importer, /registry_target_for/);
assert.match(importer, /clinical_inference_allowed: false/);
assert.match(importer, /\['approved', 'rejected'\]\.includes\(existing\?\.review_status\)/, 'human review decisions must survive re-import');

console.log('TTM-DKR contracts passed: 113 source-preserving rules, asymmetric 42-body targets and staging-only typed graph import');
