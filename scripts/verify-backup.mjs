import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  countDomainRows,
  decryptBackup,
  parseEncryptionKey
} from '../netlify/functions/_shared/database-backup.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: BACKUP_ENCRYPTION_KEY_BASE64=... npm run verify:backup -- /absolute/path/to/file.cdb.json.enc');
  process.exitCode = 2;
} else {
  try {
    const envelope = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
    const key = parseEncryptionKey(process.env.BACKUP_ENCRYPTION_KEY_BASE64);
    const payload = decryptBackup(envelope, key);
    const summary = {
      valid: true,
      file: path.basename(file),
      clinic_id: payload.clinic_id,
      domain: payload.domain,
      schema_version: payload.schema_version,
      exported_at: payload.exported_at,
      key_id: envelope.key_id,
      plaintext_sha256: envelope.plaintext_sha256,
      row_counts: countDomainRows(payload)
    };
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      valid: false,
      code: /^[A-Z0-9_]+$/.test(String(error?.message || ''))
        ? error.message
        : 'BACKUP_VERIFICATION_FAILED'
    }));
    process.exitCode = 1;
  }
}
