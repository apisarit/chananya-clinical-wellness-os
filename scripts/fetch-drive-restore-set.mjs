import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  BACKUP_DOMAINS,
  backupFileName,
  downloadDriveFile,
  fetchGoogleAccessToken,
  findDriveFile,
  parseBackupEnvironment,
  parseServiceAccount
} from '../netlify/functions/_shared/database-backup.mjs';

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
  const environment = parseBackupEnvironment(required('RESTORE_SOURCE_ENVIRONMENT'));
  if (!['staging', 'production'].includes(environment)) throw new Error('RESTORE_SOURCE_ENVIRONMENT_INVALID');
  const clinicCode = required('RESTORE_SOURCE_CLINIC_CODE', { max: 40 });
  const slot = new Date(required('RESTORE_BACKUP_SLOT', { max: 40 })).toISOString();
  const destination = path.resolve(required('RESTORE_SET_DIR', { max: 1024 }));
  const serviceAccount = parseServiceAccount(required('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON', { max: 32768 }));
  const accessToken = await fetchGoogleAccessToken(serviceAccount);

  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const downloaded = [];
  for (const domain of BACKUP_DOMAINS) {
    const folderId = required(`GOOGLE_DRIVE_${domain.toUpperCase()}_FOLDER_ID`, { max: 256 });
    const name = backupFileName(clinicCode, domain, slot, 'cdb.json.enc', environment);
    const file = await findDriveFile({ accessToken, folderId, name });
    if (!file?.id) throw new Error(`RESTORE_SET_DRIVE_FILE_MISSING_${domain.toUpperCase()}`);
    const bytes = await downloadDriveFile({ accessToken, fileId: file.id });
    const target = path.join(destination, name);
    await fs.writeFile(target, bytes, { mode: 0o600 });
    downloaded.push({ domain, name, drive_file_id: file.id, encrypted_bytes: bytes.length });
  }
  process.stdout.write(`${JSON.stringify({ fetched: true, environment, clinic_code: clinicCode, slot, downloaded }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ fetched: false, code: safeCode(error) })}\n`);
  process.exitCode = 1;
}
