import {
  BACKUP_DOMAINS,
  backupFileName,
  backupSlot,
  countDomainRows,
  encryptBackup,
  fetchGoogleAccessToken,
  parseBackupEnvironment,
  parseEncryptionKey,
  parseServiceAccount,
  supabaseRpc,
  upsertDriveFile
} from './_shared/database-backup.mjs';

const responseHeaders = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff'
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

function env(name) {
  return Netlify.env.get(name) || '';
}

function configuration() {
  const environment = parseBackupEnvironment(env('BACKUP_ENVIRONMENT'));
  const deploymentId = env('BACKUP_DEPLOYMENT_ID') || env('SITE_NAME');
  const sourceRevision = env('CLINICAL_OS_SOURCE_COMMIT') || env('COMMIT_REF') || env('DEPLOY_ID');
  const config = {
    environment,
    deploymentId,
    sourceRevision,
    supabaseUrl: env('SUPABASE_URL'),
    productionSupabaseUrl: env('BACKUP_PRODUCTION_SUPABASE_URL'),
    serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    serviceAccountValue: env('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON'),
    encryptionKeyValue: env('BACKUP_ENCRYPTION_KEY_BASE64'),
    folderIds: {
      patients: env('GOOGLE_DRIVE_PATIENTS_FOLDER_ID'),
      products: env('GOOGLE_DRIVE_PRODUCTS_FOLDER_ID'),
      pharmacy: env('GOOGLE_DRIVE_PHARMACY_FOLDER_ID'),
      transactions: env('GOOGLE_DRIVE_TRANSACTIONS_FOLDER_ID'),
      manifests: env('GOOGLE_DRIVE_MANIFESTS_FOLDER_ID')
    }
  };
  const missing = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.deploymentId) missing.push('BACKUP_DEPLOYMENT_ID or SITE_NAME');
  if (!config.sourceRevision) missing.push('CLINICAL_OS_SOURCE_COMMIT, COMMIT_REF or DEPLOY_ID');
  if (!config.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.serviceAccountValue) missing.push('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON');
  if (!config.encryptionKeyValue) missing.push('BACKUP_ENCRYPTION_KEY_BASE64');
  for (const [domain, folderId] of Object.entries(config.folderIds)) {
    if (!folderId) missing.push(`GOOGLE_DRIVE_${domain.toUpperCase()}_FOLDER_ID`);
  }
  if (missing.length) {
    console.error('database backup configuration is incomplete', { missing });
    throw new Error('BACKUP_CONFIGURATION_INCOMPLETE');
  }
  const stagingMarker = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;
  if (config.environment === 'staging') {
    if (!stagingMarker.test(config.deploymentId)) throw new Error('BACKUP_STAGING_DEPLOYMENT_ID_REQUIRED');
    if (!config.productionSupabaseUrl) throw new Error('BACKUP_PRODUCTION_SUPABASE_URL_REQUIRED');
    if (new URL(config.supabaseUrl).origin === new URL(config.productionSupabaseUrl).origin) {
      throw new Error('BACKUP_STAGING_CANNOT_USE_PRODUCTION_DATABASE');
    }
  }
  if (config.environment === 'production' && stagingMarker.test(config.deploymentId)) {
    throw new Error('BACKUP_PRODUCTION_DEPLOYMENT_ID_INVALID');
  }
  if (new Set(Object.values(config.folderIds)).size !== Object.keys(config.folderIds).length) {
    throw new Error('BACKUP_DRIVE_FOLDER_IDS_MUST_BE_UNIQUE');
  }
  return Object.freeze(config);
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function errorCode(error, fallback = 'BACKUP_OPERATION_FAILED') {
  const candidate = String(error?.message || '').toUpperCase();
  return /^[A-Z][A-Z0-9_]{2,79}$/.test(candidate) ? candidate : fallback;
}

async function finishRun(config, runId, status, counts, objects, code = null) {
  await supabaseRpc(config, 'complete_backup_export_run', {
    p_run_id: runId,
    p_status: status,
    p_domain_counts: counts,
    p_object_manifest: objects,
    p_error_code: code
  });
}

async function backupClinic({
  config,
  clinic,
  slot,
  requestId,
  accessToken,
  encryptionKey
}) {
  const lease = firstRow(await supabaseRpc(config, 'begin_backup_export_run', {
    p_clinic_id: clinic.clinic_id,
    p_scheduled_for: slot,
    p_request_id: requestId
  }));
  if (!lease?.acquired) {
    return { clinicCode: clinic.clinic_code, status: 'skipped', reason: 'slot_already_leased' };
  }

  const counts = {};
  const objects = [];
  const failures = [];

  for (const domain of BACKUP_DOMAINS) {
    try {
      const payload = await supabaseRpc(config, 'export_clinic_backup_domain', {
        p_clinic_id: clinic.clinic_id,
        p_domain: domain
      });
      counts[domain] = countDomainRows(payload);
      const encrypted = encryptBackup(payload, encryptionKey, {
        environment: config.environment,
        deploymentId: config.deploymentId,
        sourceRevision: config.sourceRevision,
        clinicId: clinic.clinic_id,
        clinicCode: clinic.clinic_code,
        domain,
        slot
      });
      const name = backupFileName(clinic.clinic_code, domain, slot, 'cdb.json.enc', config.environment);
      const driveFile = await upsertDriveFile({
        accessToken,
        folderId: config.folderIds[domain],
        name,
        mimeType: 'application/vnd.chananya.backup+json',
        bytes: encrypted.bytes
      });
      objects.push({
        environment: config.environment,
        domain,
        file_id: driveFile.id,
        file_name: name,
        operation: driveFile.operation,
        plaintext_bytes: encrypted.plaintextBytes,
        encrypted_bytes: encrypted.encryptedBytes,
        plaintext_sha256: encrypted.envelope.plaintext_sha256,
        ciphertext_sha256: encrypted.envelope.ciphertext_sha256,
        key_id: encrypted.envelope.key_id
      });
    } catch (error) {
      const code = errorCode(error, 'BACKUP_DOMAIN_FAILED');
      console.error('database backup domain failed', {
        requestId,
        clinicCode: clinic.clinic_code,
        domain,
        code
      });
      failures.push({ domain, code });
    }
  }

  const manifest = {
    format: 'chananya-backup-manifest/v2',
    environment: config.environment,
    deployment_id: config.deploymentId,
    source_revision: config.sourceRevision,
    clinic_id: clinic.clinic_id,
    clinic_code: clinic.clinic_code,
    slot,
    generated_at: new Date().toISOString(),
    domains: objects.map(item => ({
      domain: item.domain,
      file_id: item.file_id,
      file_name: item.file_name,
      plaintext_bytes: item.plaintext_bytes,
      encrypted_bytes: item.encrypted_bytes,
      plaintext_sha256: item.plaintext_sha256,
      ciphertext_sha256: item.ciphertext_sha256,
      key_id: item.key_id,
      row_counts: counts[item.domain]
    })),
    failures
  };

  try {
    const manifestName = backupFileName(clinic.clinic_code, 'manifest', slot, 'manifest.json', config.environment);
    const manifestFile = await upsertDriveFile({
      accessToken,
      folderId: config.folderIds.manifests,
      name: manifestName,
      mimeType: 'application/json',
      bytes: Buffer.from(JSON.stringify(manifest, null, 2))
    });
    objects.push({
      domain: 'manifest',
      environment: config.environment,
      file_id: manifestFile.id,
      file_name: manifestName,
      operation: manifestFile.operation
    });
  } catch (error) {
    failures.push({ domain: 'manifest', code: errorCode(error, 'BACKUP_MANIFEST_FAILED') });
  }

  const backedUpDomains = objects.filter(item => BACKUP_DOMAINS.includes(item.domain)).length;
  const status = failures.length === 0 && backedUpDomains === BACKUP_DOMAINS.length
    ? 'completed'
    : backedUpDomains > 0 ? 'partial' : 'failed';
  const code = failures.map(item => item.code).join(',').slice(0, 500) || null;
  await finishRun(config, lease.run_id, status, counts, objects, code);
  return {
    clinicCode: clinic.clinic_code,
    status,
    backedUpDomains,
    failures: failures.map(item => ({ domain: item.domain, code: item.code }))
  };
}

export default async (_request, context) => {
  const requestId = context.requestId || crypto.randomUUID();
  try {
    const config = configuration();
    const serviceAccount = parseServiceAccount(config.serviceAccountValue);
    const encryptionKey = parseEncryptionKey(config.encryptionKeyValue);
    const accessToken = await fetchGoogleAccessToken(serviceAccount);
    const slot = backupSlot(new Date());
    const clinics = await supabaseRpc(config, 'list_backup_export_clinics');
    if (!Array.isArray(clinics) || clinics.length === 0) {
      throw new Error('BACKUP_CLINIC_LIST_EMPTY');
    }

    const results = [];
    for (const clinic of clinics) {
      try {
        results.push(await backupClinic({
          config,
          clinic,
          slot,
          requestId,
          accessToken,
          encryptionKey
        }));
      } catch (error) {
        const code = errorCode(error, 'BACKUP_CLINIC_FAILED');
        console.error('database backup clinic failed', {
          requestId,
          clinicCode: clinic.clinic_code,
          code
        });
        results.push({ clinicCode: clinic.clinic_code, status: 'failed', code });
      }
    }

    const unhealthy = results.filter(result => !['completed', 'skipped'].includes(result.status));
    return json({
      ok: unhealthy.length === 0,
      environment: config.environment,
      deploymentId: config.deploymentId,
      slot,
      completed: results.filter(result => result.status === 'completed').length,
      skipped: results.filter(result => result.status === 'skipped').length,
      failedOrPartial: unhealthy.length
    }, unhealthy.length ? 500 : 200);
  } catch (error) {
    const code = errorCode(error, 'BACKUP_JOB_FAILED');
    console.error('database backup job failed', { requestId, code });
    return json({ ok: false, code }, 500);
  }
};

export const config = {
  schedule: '0 20 * * *'
};
