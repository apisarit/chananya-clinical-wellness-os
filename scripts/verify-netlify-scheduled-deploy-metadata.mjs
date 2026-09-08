import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SCHEDULES = Object.freeze({
  'database-backup': '0 20 * * *',
  'database-backup-recovery': '*/15 0-2,20-23 * * *'
});

export const EXPECTED_FUNCTION_NAMES = Object.freeze([
  'account-access',
  'database-backup',
  'database-backup-background',
  'database-backup-recovery',
  'evidence-search',
  'line-oa-webhook',
  'owner-drive',
  'owner-subscription',
  'patient-identity',
  'platform-console',
  'restore-source'
]);

const sourceCommitPattern = /^[0-9a-f]{40}$/;

function expectedIdentity(value, errorCode) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(errorCode);
  return normalized;
}

function assertNoConfiguredRoutes(metadata, functionName) {
  const functionsConfig = metadata.functions_config;
  if (functionsConfig === undefined || functionsConfig === null) return;
  if (typeof functionsConfig !== 'object' || Array.isArray(functionsConfig)) {
    throw new Error('NETLIFY_DEPLOY_METADATA_INVALID');
  }
  const config = functionsConfig[functionName];
  if (config === undefined || config === null) return;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('NETLIFY_DEPLOY_METADATA_INVALID');
  }
  for (const field of ['routes', 'excluded_routes']) {
    if (!Object.hasOwn(config, field)) continue;
    if (!Array.isArray(config[field])) throw new Error('NETLIFY_DEPLOY_METADATA_INVALID');
    if (config[field].length) throw new Error('NETLIFY_SCHEDULED_FUNCTION_CUSTOM_ROUTE_PRESENT');
  }
}

export function assertScheduledDeployMetadata(metadata, {
  expectedSiteId,
  expectedDeployId,
  expectedCommit,
  expectedContext = 'production'
} = {}) {
  const siteId = expectedIdentity(expectedSiteId, 'EXPECTED_NETLIFY_SITE_ID_REQUIRED').toLowerCase();
  const deployId = expectedIdentity(expectedDeployId, 'EXPECTED_NETLIFY_DEPLOY_ID_REQUIRED').toLowerCase();
  const commit = expectedIdentity(expectedCommit, 'EXPECTED_NETLIFY_SOURCE_COMMIT_REQUIRED').toLowerCase();
  const context = expectedIdentity(expectedContext, 'EXPECTED_NETLIFY_DEPLOY_CONTEXT_REQUIRED');
  if (!sourceCommitPattern.test(commit)) throw new Error('EXPECTED_NETLIFY_SOURCE_COMMIT_INVALID');
  if (!metadata
    || typeof metadata !== 'object'
    || Array.isArray(metadata)
    || !Array.isArray(metadata.function_schedules)
    || !Array.isArray(metadata.available_functions)) {
    throw new Error('NETLIFY_DEPLOY_METADATA_INVALID');
  }
  if (String(metadata.id || '').trim().toLowerCase() !== deployId) {
    throw new Error('NETLIFY_DEPLOY_ID_MISMATCH');
  }
  if (String(metadata.site_id || '').trim().toLowerCase() !== siteId) {
    throw new Error('NETLIFY_DEPLOY_SITE_ID_MISMATCH');
  }
  if (String(metadata.commit_ref || '').trim().toLowerCase() !== commit) {
    throw new Error('NETLIFY_DEPLOY_SOURCE_COMMIT_MISMATCH');
  }
  if (metadata.state !== 'ready') throw new Error('NETLIFY_DEPLOY_NOT_READY');
  if (metadata.context !== context) throw new Error('NETLIFY_DEPLOY_CONTEXT_MISMATCH');

  const scheduledNames = metadata.function_schedules.map(item => String(item?.name || ''));
  if (scheduledNames.length !== Object.keys(REQUIRED_SCHEDULES).length ||
    new Set(scheduledNames).size !== scheduledNames.length ||
    !scheduledNames.every(name => Object.hasOwn(REQUIRED_SCHEDULES, name))) {
    throw new Error('NETLIFY_SCHEDULE_METADATA_INVALID');
  }
  const functionNames = metadata.available_functions.map(item => String(item?.n || ''));
  if (functionNames.length !== EXPECTED_FUNCTION_NAMES.length ||
    new Set(functionNames).size !== functionNames.length ||
    !EXPECTED_FUNCTION_NAMES.every(name => functionNames.includes(name))) {
    throw new Error('NETLIFY_FUNCTION_FILESET_INVALID');
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
    assertNoConfiguredRoutes(metadata, name);
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
    console.error('Usage: EXPECTED_NETLIFY_SITE_ID=... EXPECTED_NETLIFY_DEPLOY_ID=... EXPECTED_NETLIFY_SOURCE_COMMIT=... npm run verify:backup-deploy-metadata -- <metadata.json|->');
    process.exitCode = 1;
  } else {
    readMetadata(input)
      .then(metadata => assertScheduledDeployMetadata(metadata, {
        expectedSiteId: process.env.EXPECTED_NETLIFY_SITE_ID,
        expectedDeployId: process.env.EXPECTED_NETLIFY_DEPLOY_ID,
        expectedCommit: process.env.EXPECTED_NETLIFY_SOURCE_COMMIT,
        expectedContext: process.env.EXPECTED_NETLIFY_DEPLOY_CONTEXT || 'production'
      }))
      .then(evidence => {
        for (const item of evidence) console.log(`${item.name}: scheduled ${item.cron}; no custom route field`);
      })
      .catch(error => {
        console.error(String(error?.message || 'NETLIFY_DEPLOY_METADATA_CHECK_FAILED'));
        process.exitCode = 1;
      });
  }
}
