import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readiness = JSON.parse(read('release-readiness.json'));
const preview = read('ui-review.html');
const coverage = read('docs/PLATFORM_COVERAGE_AND_RELEASE_GATES.md');

assert.equal(readiness.releaseChannel, 'preview', 'unverified release must remain on the preview channel');
assert.equal(readiness.commercialProductionReady, false, 'commercial production claim must fail closed');
assert.equal(readiness.status, 'production_candidate_under_verification');
assert.deepEqual(
  readiness.requiredGates.map(gate => gate.id),
  [
    'owner_subscription_database_enforcement',
    'authenticated_staging_all_roles',
    'line_callback',
    'encrypted_backup_restore_drill',
    'privacy_security_legal_review'
  ],
  'the five user-mandated gates must remain explicit and ordered'
);
for (const gate of readiness.requiredGates) {
  assert.equal(gate.status, 'pending', `${gate.id} must remain pending until evidence exists`);
  assert.equal(gate.evidence, null, `${gate.id} must not carry invented evidence`);
}
assert.match(preview, /ไม่ใช่ Commercial Production 100%/, 'Preview must show the release limitation on every workspace');
assert.match(coverage, /Preview \/ production candidate under verification/, 'coverage document must use the guarded release label');

console.log('Commercial release gate passed: 5 evidence gates fail closed');
