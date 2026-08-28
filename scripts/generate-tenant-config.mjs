import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = /^#[0-9a-f]{6}$/i;
const clinicCode = /^[A-Z][A-Z0-9_-]{1,23}$/;
const stagingMarker = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;
// Existing installations use a deterministic compatibility UUID whose version
// nibble is zero, so validate the UUID shape without imposing RFC version bits.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredString(value, field, max = 180) {
  const clean = String(value ?? '').trim();
  if (!clean || clean.length > max) throw new Error(`${field} is required and must be <= ${max} characters`);
  return clean;
}

function validateUrl(value, field, { allowRelative = false } = {}) {
  const clean = String(value ?? '').trim();
  if (allowRelative && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(clean)) return clean;
  let parsed;
  try { parsed = new URL(clean); } catch { throw new Error(`${field} must be a valid URL`); }
  if (parsed.protocol !== 'https:') throw new Error(`${field} must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${field} must not contain credentials`);
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function validateOrigin(value, field) {
  const clean = validateUrl(value, field);
  const parsed = new URL(clean);
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(`${field} must be an HTTPS origin without a path, query or fragment`);
  }
  return parsed.origin;
}

function validatePublishableKey(value) {
  const key = requiredString(value, 'database.publishableKey', 512);
  if (/service[_-]?role|secret/i.test(key) || key.startsWith('sb_secret_')) {
    throw new Error('database.publishableKey must never contain a service-role or secret key');
  }
  if (key.startsWith('sb_publishable_')) return key;
  if (!key.startsWith('eyJ')) {
    throw new Error('database.publishableKey must be a Supabase publishable/anon key');
  }
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString('utf8'));
    if (payload.role !== 'anon') {
      throw new Error('database.publishableKey legacy JWT must contain role=anon');
    }
  } catch (error) {
    if (String(error?.message || error).includes('role=anon')) throw error;
    throw new Error('database.publishableKey legacy JWT is invalid');
  }
  return key;
}

export function validateTenantConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tenant config must be an object');
  const colors = input.brand?.colors || {};
  const normalizedColors = {};
  for (const key of ['primary950','primary900','primary800','primary700','primary100','primary50','accent','accentSoft','surface','background']) {
    const value = requiredString(colors[key], `brand.colors.${key}`, 7);
    if (!hex.test(value)) throw new Error(`brand.colors.${key} must be a six-digit hex color`);
    normalizedColors[key] = value.toLowerCase();
  }

  const expectedClinicCode = requiredString(input.tenant?.expectedClinicCode, 'tenant.expectedClinicCode', 24).toUpperCase();
  if (!clinicCode.test(expectedClinicCode)) throw new Error('tenant.expectedClinicCode must be 2-24 uppercase letters, digits, _ or -');
  const expectedClinicId = requiredString(input.tenant?.expectedClinicId, 'tenant.expectedClinicId', 36).toLowerCase();
  if (!uuid.test(expectedClinicId)) throw new Error('tenant.expectedClinicId must be a UUID');

  const publishableKey = validatePublishableKey(input.database?.publishableKey);
  const redirectOrigin = validateOrigin(input.auth?.redirectOrigin, 'auth.redirectOrigin');
  const logoRaw = String(input.brand?.logoUrl ?? '').trim();
  const logoUrl = logoRaw ? validateUrl(logoRaw, 'brand.logoUrl', { allowRelative: true }) : '';

  return {
    schemaVersion: 1,
    deploymentId: requiredString(input.deploymentId, 'deploymentId', 80),
    brand: {
      shortName: requiredString(input.brand?.shortName, 'brand.shortName', 60),
      nameTh: requiredString(input.brand?.nameTh, 'brand.nameTh', 160),
      nameEn: requiredString(input.brand?.nameEn, 'brand.nameEn', 160),
      productName: requiredString(input.brand?.productName, 'brand.productName', 80),
      descriptor: requiredString(input.brand?.descriptor, 'brand.descriptor', 160),
      mark: requiredString(input.brand?.mark, 'brand.mark', 4),
      logoUrl,
      colors: normalizedColors
    },
    tenant: { expectedClinicId, expectedClinicCode },
    database: {
      provider: 'supabase',
      url: validateUrl(input.database?.url, 'database.url'),
      publishableKey
    },
    auth: { redirectOrigin },
    identity: { qrIssuer: requiredString(input.identity?.qrIssuer || expectedClinicCode, 'identity.qrIssuer', 24).toUpperCase() },
    safety: { previewLocked: input.safety?.previewLocked === true }
  };
}

export function renderTenantConfig(config) {
  const payload = JSON.stringify(config, null, 2).replace(/</g, '\\u003c');
  return `// Generated by scripts/generate-tenant-config.mjs. Public browser configuration only.\n` +
    `window.CLINICAL_OS_CONFIG = Object.freeze(${payload});\n`;
}

export function renderBrandConfig(config) {
  const publicBrand = {
    schemaVersion: config.schemaVersion,
    deploymentId: config.deploymentId,
    brand: config.brand,
    tenant: { expectedClinicCode: config.tenant.expectedClinicCode },
    identity: config.identity,
    safety: config.safety
  };
  const payload = JSON.stringify(publicBrand, null, 2).replace(/</g, '\\u003c');
  return `// Generated public presentation config. Contains no database credentials.\n` +
    `window.CLINICAL_OS_CONFIG = Object.freeze(${payload});\n`;
}

export function loadTenantConfig({ env = process.env, cwd = root } = {}) {
  let config;
  if (env.CLINICAL_OS_TENANT_CONFIG_JSON) {
    config = validateTenantConfig(JSON.parse(env.CLINICAL_OS_TENANT_CONFIG_JSON));
  } else {
    const file = env.CLINICAL_OS_TENANT_CONFIG_PATH || 'config/tenant.chananya.json';
    const target = path.resolve(cwd, file);
    config = validateTenantConfig(JSON.parse(fs.readFileSync(target, 'utf8')));
  }
  const preview = env.CONTEXT === 'deploy-preview' || env.CONTEXT === 'branch-deploy';
  const dedicatedStaging = env.CLINICAL_OS_STAGING_DEPLOYMENT === 'true';
  const guardedNonProduction = preview || dedicatedStaging;
  const databaseAllowed = env.CLINICAL_OS_ALLOW_STAGING_DATABASE === 'true' ||
    env.CLINICAL_OS_ALLOW_PREVIEW_DATABASE === 'true';
  const databaseAck = env.CLINICAL_OS_STAGING_DATABASE_ACK || env.CLINICAL_OS_PREVIEW_DATABASE_ACK;
  const nonProductionOrigin = dedicatedStaging
    ? String(env.URL || config.auth.redirectOrigin).replace(/\/$/, '')
    : String(env.DEPLOY_PRIME_URL || config.auth.redirectOrigin).replace(/\/$/, '');
  if (guardedNonProduction && !databaseAllowed) {
    return {
      ...config,
      database: { provider: 'supabase', url: '', publishableKey: '' },
      auth: { redirectOrigin: nonProductionOrigin },
      safety: { previewLocked: true }
    };
  }
  if (guardedNonProduction) {
    const explicitStagingConfig = Boolean(env.CLINICAL_OS_TENANT_CONFIG_JSON || env.CLINICAL_OS_TENANT_CONFIG_PATH);
    if (!explicitStagingConfig || databaseAck !== 'STAGING_ONLY') {
      throw new Error('Non-production database access requires an explicit staging config and STAGING_ONLY acknowledgement');
    }
    if (!env.CLINICAL_OS_PRODUCTION_CONFIG_JSON && !env.CLINICAL_OS_PRODUCTION_CONFIG_PATH) {
      throw new Error('Preview database access requires an explicit Production config denylist');
    }
    const productionInput = env.CLINICAL_OS_PRODUCTION_CONFIG_JSON
      ? JSON.parse(env.CLINICAL_OS_PRODUCTION_CONFIG_JSON)
      : JSON.parse(fs.readFileSync(path.resolve(cwd, env.CLINICAL_OS_PRODUCTION_CONFIG_PATH), 'utf8'));
    const production = validateTenantConfig(productionInput);
    if (!stagingMarker.test(config.deploymentId)) {
      throw new Error('Preview database access requires a staging/non-production deploymentId');
    }
    if (new URL(config.database.url).origin === new URL(production.database.url).origin) {
      throw new Error('Preview database access cannot target the Production Supabase project');
    }
    if (config.tenant.expectedClinicCode === production.tenant.expectedClinicCode) {
      throw new Error('Preview staging clinic code must differ from Production');
    }
    if (config.tenant.expectedClinicId === production.tenant.expectedClinicId) {
      throw new Error('Preview staging clinic UUID must differ from Production');
    }
    if (config.identity.qrIssuer === production.identity.qrIssuer) {
      throw new Error('Preview staging QR issuer must differ from Production');
    }
    const stagingOrigin = validateOrigin(nonProductionOrigin, dedicatedStaging ? 'URL' : 'DEPLOY_PRIME_URL');
    if (stagingOrigin === production.auth.redirectOrigin) {
      throw new Error('Preview database access cannot use the Production site origin');
    }
    return {
      ...config,
      auth: { redirectOrigin: stagingOrigin },
      safety: { previewLocked: false }
    };
  }
  return config;
}

function main() {
  const config = loadTenantConfig();
  const output = path.join(root, 'tenant-config.js');
  fs.writeFileSync(output, renderTenantConfig(config), { encoding: 'utf8', mode: 0o644 });
  fs.writeFileSync(path.join(root, 'brand-config.js'), renderBrandConfig(config), { encoding: 'utf8', mode: 0o644 });
  process.stdout.write(`Tenant browser config generated for ${config.deploymentId} (${config.tenant.expectedClinicCode})\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
