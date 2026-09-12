import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMBERSHIP_PROOF_VERSION } from '../scripts/staging-membership-proof.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const index = JSON.parse(read('version-index.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

assert.equal(index.schemaVersion, 1);
assert.deepEqual(index.application, { name: pkg.name, version: pkg.version });
assert.equal(index.application.version, lock.version);
assert.equal(index.application.version, lock.packages[''].version);
assert.equal(index.application.name, lock.packages[''].name);
assert.equal(index.components.length, 1);
const component = index.components[0];
assert.equal(component.id, 'staging-membership-uat');
assert.equal(component.version, MEMBERSHIP_PROOF_VERSION);
assert.equal(component.version, '1.0.0-candidate.2');
assert.equal(component.versionExport, 'MEMBERSHIP_PROOF_VERSION');
assert.equal(component.status, 'local-review-candidate');
assert.equal(component.entryPoint, 'scripts/staging-membership-proof.mjs');
assert.ok(component.files.includes(component.entryPoint));
assert.deepEqual(component.files, [
  'scripts/staging-membership-proof.mjs',
  'scripts/verify-authenticated-staging.mjs',
  'ops/cnyos-staging-controller/scripts/membership-journal-store.mjs',
  'supabase/manual/staff_membership_recovery_candidate.sql',
  'tests/staff-membership-recovery-candidate-contract.mjs',
  'tests/staging-membership-checkpoint-contract.mjs',
  'tests/staging-membership-journal-contract.mjs',
  'tests/fixtures/membership-journal-child.mjs',
  'tests/staff-membership-native-recovery.mjs',
  'tests/fixtures/staff-membership-native-fixture.sql',
  'tests/staging-safety-contract.mjs',
  'docs/STAGING_MEMBERSHIP_RECOVERY.md',
  'docs/STAGING_MEMBERSHIP_JOURNAL.md',
  'docs/STAGING_MEMBERSHIP_NATIVE_RECOVERY.md'
]);
const files = [
  ...component.files, index.copyright.noticePath,
  ...index.copyright.thirdPartyNotices
];
assert.equal(new Set(files).size, files.length, 'Index paths must be unique');
for (const relative of files) {
  assert.equal(typeof relative, 'string');
  assert.ok(relative.length > 0 && !path.isAbsolute(relative));
  assert.ok(!relative.split(/[\\/]/).some(part => ['.', '..', ''].includes(part)));
  const absolute = path.resolve(root, relative);
  assert.ok(absolute.startsWith(root), 'Index path escaped the checkout');
  assert.ok(fs.lstatSync(absolute).isFile(), 'Index must name ordinary existing files');
}
const candidate = read('supabase/manual/staff_membership_recovery_candidate.sql');
assert.match(candidate, /STAFF_MEMBERSHIP_RECOVERY_REVIEW_REQUIRED/);
assert.ok(candidate.indexOf('STAFF_MEMBERSHIP_RECOVERY_REVIEW_REQUIRED')
  < candidate.indexOf('-- BEGIN LOCAL FIXTURE DEFINITIONS'));
assert.equal(index.copyright.status, 'awaiting_owner_confirmation');
assert.equal(index.copyright.holder, null);
assert.equal(index.copyright.noticePath, 'COPYRIGHT.md');
assert.deepEqual(index.copyright.thirdPartyNotices, ['docs/licenses/ASTRONOMY_ENGINE_LICENSE.txt']);
assert.match(read('COPYRIGHT.md'), /awaiting owner confirmation/);
assert.equal(index.evidenceLimits.stagingVerified, false);
assert.equal(index.evidenceLimits.productionAuthorized, false);
assert.equal(index.evidenceLimits.cryptographicManifest, false);
assert.equal(pkg.scripts['check:version-index'], 'node tests/version-index-contract.mjs');
process.stdout.write('Version index contract passed: package/component versions, scoped paths, pending rights holder and non-authorizing metadata\n');
