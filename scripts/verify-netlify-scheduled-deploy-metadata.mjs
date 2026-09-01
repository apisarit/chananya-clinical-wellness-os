import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SCHEDULES = Object.freeze({
  'database-backup': '0 20 * * *',
  'database-backup-recovery': '*/15 0-2,20-23 * * *'
});

export function assertScheduledDeployMetadata(metadata) {
  if (!metadata
    || typeof metadata !== 'object'
    || !Array.isArray(metadata.function_schedules)
    || !Array.isArray(metadata.available_functions)) {
    throw new Error('NETLIFY_DEPLOY_METADATA_INVALID');
  }
  for (const [name, cron] of Object.entries(REQUIRED_SCHEDULES)) {
    const schedules = metadata.function_schedules.filter(item => item?.name === name);
    if (schedules.length !== 1 || schedules[0]?.cron !== cron) {
      throw new Error('NETLIFY_SCHEDULE_METADATA_INVALID');
    }
    const functions = metadata.available_functions.filter(item => item?.n === name);
    if (functions.length !== 1 || Object.hasOwn(functions[0], 'ro')) {
      throw new Error('NETLIFY_SCHEDULED_FUNCTION_CUSTOM_ROUTE_PRESENT');
    }
  }
  return Object.freeze(Object.entries(REQUIRED_SCHEDULES).map(([name, cron]) => Object.freeze({ name, cron })));
}

async function readMetadata(input) {
  const raw = input === '-'
    ? await new Promise((resolve, reject) => {
      const chunks = [];
      process.stdin.on('data', chunk => chunks.push(chunk));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    })
    : await fs.readFile(input, 'utf8');
  try { return JSON.parse(raw); }
  catch { throw new Error('NETLIFY_DEPLOY_METADATA_INVALID'); }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = process.argv[2] || '';
  if (!input) {
    console.error('Usage: npm run verify:backup-deploy-metadata -- <metadata.json|->');
    process.exitCode = 1;
  } else {
    readMetadata(input)
      .then(assertScheduledDeployMetadata)
      .then(evidence => {
        for (const item of evidence) console.log(`${item.name}: scheduled ${item.cron}; no custom route field`);
      })
      .catch(error => {
        console.error(String(error?.message || 'NETLIFY_DEPLOY_METADATA_CHECK_FAILED'));
        process.exitCode = 1;
      });
  }
}
