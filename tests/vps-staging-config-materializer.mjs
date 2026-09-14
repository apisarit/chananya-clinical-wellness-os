import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeVpsStagingConfig, validateBrowserKey } from '../scripts/materialize-vps-staging-config.mjs';

const legacy = role => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role })}.signature`;
};

test('accepts only browser-safe publishable and legacy anon keys', () => {
  assert.equal(validateBrowserKey('sb_publishable_public'), 'sb_publishable_public');
  assert.equal(validateBrowserKey(legacy('anon')), legacy('anon'));
  for (const value of [legacy('service_role'), 'eyJ.invalid', 'sb_secret_private', 'service_role', '']) {
    assert.throws(() => validateBrowserKey(value), /CNYOS_VPS_STAGING_BROWSER_KEY_REJECTED/);
  }
});

test('writes a private same-origin runtime config without mutating the source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-vps-config-'));
  const sourcePath = path.resolve('config/tenant.cnyos-staging.json');
  const before = fs.readFileSync(sourcePath, 'utf8');
  const outputPath = path.join(dir, 'tenant.json');
  const result = materializeVpsStagingConfig({
    sourcePath,
    outputPath,
    domain: 'srv1506007.hstgr.cloud',
    browserKey: legacy('anon')
  });
  assert.equal(result.database.url, 'https://srv1506007.hstgr.cloud/supabase');
  assert.equal(result.auth.redirectOrigin, 'https://srv1506007.hstgr.cloud');
  assert.equal(result.tenant.expectedClinicId, '784ec3b0-7618-42ad-9ba0-eed606d22358');
  assert.equal(result.tenant.expectedClinicCode, 'CNYOS-VPS-STG');
  assert.equal(result.identity.qrIssuer, 'CNYOS-VPS-STG');
  assert.equal(result.database.publishableKey, legacy('anon'));
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), before);
  assert.throws(() => materializeVpsStagingConfig({
    sourcePath,
    outputPath: path.join(dir, 'bad.json'),
    domain: 'cnyos.netlify.app',
    browserKey: legacy('anon')
  }), /CNYOS_VPS_STAGING_DOMAIN_REJECTED/);
});
