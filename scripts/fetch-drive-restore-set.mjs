import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  parseServiceAccount
} from '../netlify/functions/_shared/database-backup.mjs';
import {
  RESTORE_DATA_DOMAINS,
  RESTORE_FOLDER_DOMAINS,
  RESTORE_OBJECT_DOMAINS
} from '../netlify/functions/_shared/restore-source.mjs';
import {
  downloadInspectedDriveObject,
  fetchExactRestoreSource,
  fetchGoogleRestoreReaderAccessToken,
  inspectRestoreFolder,
  inspectRestoreObject,
  validateBackupManifest,
  validateEncryptedObjectEnvelope
} from './_shared/drive-restore-source.mjs';

function required(name, { max = 8192 } = {}) {
  const value = String(process.env[name] || '').trim();
  if (!value || value.length > max) throw new Error(`${name}_REQUIRED`);
  return value;
}

function safeCode(error) {
  const code = String(error?.message || 'RESTORE_SET_FETCH_FAILED');
  return /^[A-Z][A-Z0-9_]{2,160}$/.test(code) ? code : 'RESTORE_SET_FETCH_FAILED';
}

try {
  if (process.env.RESTORE_DRILL_ACK !== 'ISOLATED_RESTORE_TEST_ONLY') {
    throw new Error('RESTORE_DRILL_ACK_REQUIRED');
  }

  const clinicCode = required('RESTORE_SOURCE_CLINIC_CODE', { max: 40 });
  const slot = required('RESTORE_BACKUP_SLOT', { max: 40 });
  const expectedEnvironment = required('RESTORE_SOURCE_ENVIRONMENT', { max: 20 });
  const expectedSourceRevision = required('RESTORE_EXPECTED_SOURCE_COMMIT', { max: 40 });
  const expectedRootFolderId = required('GOOGLE_DRIVE_EXPECTED_ROOT_FOLDER_ID', { max: 256 });
  const destination = path.resolve(required('RESTORE_SET_DIR', { max: 1024 }));
  const evidenceDirectory = path.resolve(required('RESTORE_EVIDENCE_DIR', { max: 1024 }));

  const source = await fetchExactRestoreSource({
    endpoint: required('RESTORE_SOURCE_API_URL', { max: 1024 }),
    apiToken: required('RESTORE_SOURCE_API_TOKEN', { max: 256 }),
    clinicCode,
    slot,
    expectedEnvironment,
    expectedRootFolderId
  });

  const serviceAccount = parseServiceAccount(
    required('GOOGLE_DRIVE_RESTORE_READER_SERVICE_ACCOUNT_JSON', { max: 32768 })
  );
  const accessToken = await fetchGoogleRestoreReaderAccessToken(serviceAccount);

  // The restore reader may be read-only. Verify topology and object evidence
  // without requiring canAddChildren or any other write capability.
  await inspectRestoreFolder({
    accessToken,
    folderId: source.rootFolderId
  });
  await Promise.all(RESTORE_FOLDER_DOMAINS.map(domain => inspectRestoreFolder({
    accessToken,
    folderId: source.folders[domain],
    expectedParentId: source.rootFolderId
  })));

  // Look up every recorded object by its immutable Drive file ID. Never
  // search by name and never consult the clinic's current assignment.
  const metadata = Object.fromEntries(await Promise.all(
    RESTORE_OBJECT_DOMAINS.map(async domain => [
      domain,
      await inspectRestoreObject({
        accessToken,
        sourceObject: source.objects[domain]
      })
    ])
  ));

  // The plaintext, non-PHI manifest is itself a required fifth object. Bind
  // it to the completed database run before downloading any encrypted domain.
  const manifestBytes = await downloadInspectedDriveObject({
    accessToken,
    metadata: metadata.manifest
  });
  const manifestEvidence = validateBackupManifest(
    manifestBytes,
    source,
    expectedSourceRevision
  );

  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const existingEncryptedFiles = (await fs.readdir(destination))
    .filter(name => name.endsWith('.cdb.json.enc'));
  if (existingEncryptedFiles.length > 0) throw new Error('RESTORE_SET_DIR_NOT_EMPTY');

  const verifiedDownloads = [];
  for (const domain of RESTORE_DATA_DOMAINS) {
    const bytes = await downloadInspectedDriveObject({
      accessToken,
      metadata: metadata[domain]
    });
    const object = source.objects[domain];
    validateEncryptedObjectEnvelope({
      bytes,
      source,
      domain,
      expectedSourceRevision: manifestEvidence.sourceRevision,
      expectedDeploymentId: manifestEvidence.deploymentId
    });
    verifiedDownloads.push({ domain, object, bytes });
  }

  const downloaded = [];
  for (const { domain, object, bytes } of verifiedDownloads) {
    const target = path.join(destination, object.fileName);
    if (path.dirname(target) !== destination || path.basename(target) !== object.fileName) {
      throw new Error('RESTORE_SOURCE_FILE_NAME_UNSAFE');
    }
    await fs.writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    downloaded.push({
      domain,
      name: object.fileName,
      drive_file_id: object.fileId,
      encrypted_bytes: bytes.length,
      ciphertext_sha256: object.ciphertextSha256
    });
  }

  await fs.mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const sourceEvidencePath = path.join(evidenceDirectory, 'restore-source-binding.json');
  const sourceEvidence = {
    format: 'chananya-restore-source-binding-evidence/v1',
    verified_at: new Date().toISOString(),
    run_id: source.runId,
    clinic_id: source.clinicId,
    clinic_code: source.clinicCode,
    environment: source.environment,
    slot: source.slot,
    completed_at: source.completedAt,
    source_revision: manifestEvidence.sourceRevision,
    source_deployment_id: manifestEvidence.deploymentId,
    manifest_sha256: manifestEvidence.manifestSha256,
    drive_assignment_version: source.assignmentVersion,
    drive_root_folder_id: source.rootFolderId,
    objects: RESTORE_OBJECT_DOMAINS.map(domain => ({
      domain,
      drive_file_id: source.objects[domain].fileId,
      file_name: source.objects[domain].fileName,
      destination_folder_id: source.objects[domain].destinationFolderId,
      size: metadata[domain].size,
      ...(domain === 'manifest' ? {} : {
        plaintext_sha256: source.objects[domain].plaintextSha256,
        ciphertext_sha256: source.objects[domain].ciphertextSha256,
        row_counts: source.objects[domain].rowCounts
      })
    }))
  };
  await fs.writeFile(
    sourceEvidencePath,
    `${JSON.stringify(sourceEvidence, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' }
  );

  process.stdout.write(`${JSON.stringify({
    fetched: true,
    run_id: source.runId,
    environment: source.environment,
    clinic_code: source.clinicCode,
    slot: source.slot,
    source_revision: manifestEvidence.sourceRevision,
    drive_assignment_version: source.assignmentVersion,
    manifest_verified: true,
    downloaded,
    evidence_file: sourceEvidencePath
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ fetched: false, code: safeCode(error) })}\n`);
  process.exitCode = 1;
}
