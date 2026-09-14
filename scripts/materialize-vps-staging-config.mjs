import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTenantConfig } from './generate-tenant-config.mjs';

const EXPECTED_DOMAIN = 'srv1506007.hstgr.cloud';
const EXPECTED_CLINIC_ID = '784ec3b0-7618-42ad-9ba0-eed606d22358';
const EXPECTED_CLINIC_CODE = 'CNYOS-VPS-STG';

export function validateBrowserKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 512 || /service[_-]?role|secret/i.test(key) || key.startsWith('sb_secret_')) {
    throw new Error('CNYOS_VPS_STAGING_BROWSER_KEY_REJECTED');
  }
  if (key.startsWith('sb_publishable_')) return key;
  const parts = key.split('.');
  if (parts.length !== 3 || !parts.every(Boolean)) throw new Error('CNYOS_VPS_STAGING_BROWSER_KEY_REJECTED');
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload?.role !== 'anon') throw new Error('role');
  } catch {
    throw new Error('CNYOS_VPS_STAGING_BROWSER_KEY_REJECTED');
  }
  return key;
}

export function materializeVpsStagingConfig({ sourcePath, outputPath, domain, browserKey }) {
  if (domain !== EXPECTED_DOMAIN) throw new Error('CNYOS_VPS_STAGING_DOMAIN_REJECTED');
  const config = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  config.tenant.expectedClinicId = EXPECTED_CLINIC_ID;
  config.tenant.expectedClinicCode = EXPECTED_CLINIC_CODE;
  config.database.url = `https://${EXPECTED_DOMAIN}/supabase`;
  config.database.publishableKey = validateBrowserKey(browserKey);
  config.auth.redirectOrigin = `https://${EXPECTED_DOMAIN}`;
  config.identity.qrIssuer = EXPECTED_CLINIC_CODE;
  const validated = validateTenantConfig(config);
  fs.writeFileSync(outputPath, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return validated;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourcePath, outputPath] = process.argv.slice(2);
  if (!sourcePath || !outputPath) throw new Error('CNYOS_VPS_STAGING_CONFIG_USAGE');
  materializeVpsStagingConfig({
    sourcePath,
    outputPath,
    domain: process.env.CNYOS_STAGING_DOMAIN,
    browserKey: process.env.CNYOS_STAGING_SUPABASE_ANON_KEY
  });
}
