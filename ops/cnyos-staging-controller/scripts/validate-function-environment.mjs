import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  POLICY,
  POLICY_SHA256,
  assertControllerRuntime,
  fail,
  required,
  sha256,
  writeJsonExclusive
} from './policy.mjs';

function readNetlifyValue(cli, token, name) {
  let stdout;
  try {
    stdout = execFileSync(cli, [
      'env:get',
      name,
      `--site=${POLICY.target.netlifySiteId}`,
      '--context=production',
      '--scope=functions'
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NETLIFY_AUTH_TOKEN: token,
        NETLIFY_SITE_ID: POLICY.target.netlifySiteId,
        NETLIFY_CLI_TELEMETRY_DISABLED: '1'
      }
    });
  } catch {
    fail('CNYOS_CONTROLLER_FUNCTION_ENV_READ_FAILED');
  }
  const value = String(stdout).replace(/\r?\n$/, '');
  if (!value || value.length > 2048 || /[\r\n\0]/.test(value)) {
    fail('CNYOS_CONTROLLER_FUNCTION_ENV_VALUE_INVALID');
  }
  return value;
}

export async function validateFunctionEnvironment({
  env = process.env,
  now = () => new Date()
} = {}) {
  const runtime = assertControllerRuntime(env);
  const token = required(env.CNYOS_STAGING_NETLIFY_AUTH_TOKEN,
    'CNYOS_CONTROLLER_NETLIFY_TOKEN_REQUIRED', 4096);
  const cli = path.resolve(required(env.CNYOS_NETLIFY_CLI_PATH,
    'CNYOS_CONTROLLER_NETLIFY_CLI_PATH_REQUIRED', 4096));
  let cliRealPath;
  try { cliRealPath = await fs.realpath(cli); }
  catch { fail('CNYOS_CONTROLLER_NETLIFY_CLI_PATH_INVALID'); }
  if (!cliRealPath.split(path.sep).join('/').includes('/node_modules/netlify-cli/')) {
    fail('CNYOS_CONTROLLER_NETLIFY_CLI_PATH_INVALID');
  }
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    fail('CNYOS_CONTROLLER_TIME_INVALID');
  }
  const expectedEntries = Object.entries(POLICY.functionEnvironment)
    .sort(([left], [right]) => left.localeCompare(right));
  const observed = [];
  for (const [name, expected] of expectedEntries) {
    const value = readNetlifyValue(cli, token, name);
    if (value !== expected) fail('CNYOS_CONTROLLER_FUNCTION_ENV_TARGET_MISMATCH');
    observed.push([name, value]);
  }
  if (POLICY.functionEnvironment.SUPABASE_URL === POLICY.productionDenylist.supabaseOrigin ||
    POLICY.functionEnvironment.CNYOS_ACCOUNT_CLINIC_ID === POLICY.productionDenylist.clinicId ||
    POLICY.functionEnvironment.CNYOS_ACCOUNT_CLINIC_CODE === POLICY.productionDenylist.clinicCode) {
    fail('CNYOS_CONTROLLER_FUNCTION_ENV_PRODUCTION_TARGET_DENIED');
  }
  const evidence = Object.freeze({
    schemaVersion: 1,
    evidenceType: 'cnyos_staging_controller_function_environment_validation',
    status: 'passed',
    authorization: false,
    scope: 'cnyos_staging_only',
    productionAuthorization: false,
    verifiedAt: observedAt.toISOString(),
    controllerRepository: runtime.repository,
    controllerRef: runtime.ref,
    controllerCommit: runtime.commit,
    controllerRunId: runtime.runId,
    target: POLICY.target,
    policySha256: POLICY_SHA256,
    validatedVariableNames: Object.freeze(expectedEntries.map(([name]) => name)),
    exactValuesSha256: sha256(JSON.stringify(observed)),
    productionDenylistConfirmed: true,
    protectedSecretPresenceVerified: false,
    valuesSerialized: false
  });
  const evidencePath = await writeJsonExclusive(
    required(env.CNYOS_CONTROLLER_FUNCTION_ENV_EVIDENCE_PATH,
      'CNYOS_CONTROLLER_FUNCTION_ENV_EVIDENCE_PATH_REQUIRED', 4096),
    evidence
  );
  return Object.freeze({ evidence, evidencePath });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  validateFunctionEnvironment().then(async result => {
    const bytes = await fs.readFile(result.evidencePath);
    process.stdout.write(`${JSON.stringify({
      evidencePath: result.evidencePath,
      evidenceSha256: sha256(bytes),
      validatedVariableCount: result.evidence.validatedVariableNames.length
    })}\n`);
  }).catch(error => {
    process.stderr.write(`${String(error?.message || 'CNYOS_CONTROLLER_FUNCTION_ENV_VALIDATION_FAILED')}\n`);
    process.exitCode = 1;
  });
}
