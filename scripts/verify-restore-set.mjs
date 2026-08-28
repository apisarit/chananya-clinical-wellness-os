import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  parseEncryptionKey,
  verifyBackupSet
} from '../netlify/functions/_shared/database-backup.mjs';

async function resolveInputs(arguments_) {
  if (arguments_.length === 1) {
    const target = path.resolve(arguments_[0]);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const names = (await fs.readdir(target))
        .filter(name => name.endsWith('.cdb.json.enc'))
        .sort();
      return names.map(name => path.join(target, name));
    }
  }
  return arguments_.map(file => path.resolve(file));
}

function safeCode(error) {
  const code = String(error?.message || 'RESTORE_SET_VERIFICATION_FAILED');
  return /^[A-Z][A-Z0-9_]{2,160}$/.test(code) ? code : 'RESTORE_SET_VERIFICATION_FAILED';
}

try {
  const files = await resolveInputs(process.argv.slice(2));
  if (files.length === 0) {
    throw new Error('RESTORE_SET_FILES_REQUIRED');
  }
  const envelopes = [];
  for (const file of files) {
    envelopes.push(JSON.parse(await fs.readFile(file, 'utf8')));
  }
  const key = parseEncryptionKey(process.env.BACKUP_ENCRYPTION_KEY_BASE64);
  const evidence = {
    ...verifyBackupSet(envelopes, key),
    verified_at: new Date().toISOString(),
    files: files.map(file => path.basename(file)).sort()
  };

  const evidenceDirectory = process.env.RESTORE_EVIDENCE_DIR;
  if (evidenceDirectory) {
    const directory = path.resolve(evidenceDirectory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = evidence.slot.replace(/[^0-9A-Za-z]/g, '').slice(0, 24);
    const destination = path.join(directory, `restore-set-${evidence.environment}-${stamp}.json`);
    await fs.writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    evidence.evidence_file = destination;
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ valid: false, code: safeCode(error) })}\n`);
  process.exitCode = 1;
}
