import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  normalizeRestoreEnvironment,
  normalizeRestoreSourceRequest,
  RESTORE_DATA_DOMAINS
} from '../netlify/functions/_shared/restore-source.mjs';

function required(name, { max = 2048 } = {}) {
  const value = String(process.env[name] || '').trim();
  if (!value || value.length > max) throw new Error(`${name}_REQUIRED`);
  return value;
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function equalJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function safeCode(error) {
  const code = String(error?.message || 'RESTORE_SOURCE_SET_BINDING_FAILED');
  return /^[A-Z][A-Z0-9_]{2,160}$/.test(code) ? code : 'RESTORE_SOURCE_SET_BINDING_FAILED';
}

try {
  const sourcePath = path.resolve(required('RESTORE_SOURCE_BINDING_EVIDENCE_PATH'));
  const setPath = path.resolve(required('RESTORE_SET_EVIDENCE_PATH'));
  const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  const set = JSON.parse(await fs.readFile(setPath, 'utf8'));
  const request = normalizeRestoreSourceRequest({
    clinicCode: required('RESTORE_SOURCE_CLINIC_CODE', { max: 40 }),
    slot: required('RESTORE_BACKUP_SLOT', { max: 40 })
  });
  const environment = normalizeRestoreEnvironment(required('RESTORE_SOURCE_ENVIRONMENT', { max: 20 }));
  const expectedCommit = required('RESTORE_EXPECTED_SOURCE_COMMIT', { max: 40 }).toLowerCase();
  assert(/^[0-9a-f]{40}$/.test(expectedCommit), 'RESTORE_SOURCE_EXPECTED_COMMIT_INVALID');

  assert(source.format === 'chananya-restore-source-binding-evidence/v1'
    && /^[0-9a-f-]{36}$/i.test(String(source.run_id || '')),
  'RESTORE_SOURCE_BINDING_EVIDENCE_INVALID');
  assert(set.valid === true && set.format === 'chananya-restore-set-evidence/v1',
    'RESTORE_SET_EVIDENCE_INVALID');
  for (const evidence of [source, set]) {
    assert(evidence.environment === environment, 'RESTORE_SOURCE_SET_ENVIRONMENT_MISMATCH');
    assert(evidence.clinic_code === request.clinicCode, 'RESTORE_SOURCE_SET_CLINIC_CODE_MISMATCH');
    assert(evidence.slot === request.slot, 'RESTORE_SOURCE_SET_SLOT_MISMATCH');
    assert(evidence.source_revision === expectedCommit, 'RESTORE_SOURCE_SET_REVISION_MISMATCH');
  }
  assert(source.clinic_id === set.clinic_id, 'RESTORE_SOURCE_SET_CLINIC_ID_MISMATCH');

  const sourceObjects = new Map((Array.isArray(source.objects) ? source.objects : [])
    .map(object => [object?.domain, object]));
  assert(sourceObjects.size === RESTORE_DATA_DOMAINS.length + 1
    && sourceObjects.has('manifest'), 'RESTORE_SOURCE_OBJECT_EVIDENCE_INVALID');
  const expectedFiles = [];
  for (const domain of RESTORE_DATA_DOMAINS) {
    const object = sourceObjects.get(domain);
    const verified = set.domains?.[domain];
    assert(object && verified, `RESTORE_SOURCE_SET_DOMAIN_MISSING_${domain.toUpperCase()}`);
    assert(object.plaintext_sha256 === verified.plaintext_sha256
      && object.ciphertext_sha256 === verified.ciphertext_sha256
      && equalJson(object.row_counts, verified.row_counts),
    `RESTORE_SOURCE_SET_DOMAIN_EVIDENCE_MISMATCH_${domain.toUpperCase()}`);
    expectedFiles.push(object.file_name);
  }
  assert(equalJson([...expectedFiles].sort(), [...(set.files || [])].sort()),
    'RESTORE_SOURCE_SET_FILE_NAMES_MISMATCH');

  const destination = path.join(path.dirname(setPath), 'restore-source-and-set-binding.json');
  await fs.writeFile(destination, `${JSON.stringify({
    format: 'chananya-restore-source-and-set-binding/v1',
    verified_at: new Date().toISOString(),
    run_id: source.run_id,
    restore_set_sha256: set.restore_set_sha256,
    source_manifest_sha256: source.manifest_sha256,
    environment,
    clinic_id: set.clinic_id,
    clinic_code: request.clinicCode,
    slot: request.slot,
    source_revision: expectedCommit
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`Exact completed run ${source.run_id} bound to decrypted restore set: ${destination}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ valid: false, code: safeCode(error) })}\n`);
  process.exitCode = 1;
}
