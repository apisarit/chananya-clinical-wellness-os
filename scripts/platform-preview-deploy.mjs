import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizePlatformPlan, platformPlanInput, PLATFORM_FEATURES } from '../platform-config.js';
import { platformTargets } from '../netlify/functions/platform-console.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'artifacts/platform-preview');
const sha256 = value => createHash('sha256').update(value).digest('hex');

// Netlify Pretty URLs rewrites local .html anchors and changes their quote style.
// Normalize that observed HTML-only transformation; script/CSS bytes stay exact.
export function canonicalPreviewAsset(name, content) {
  if (!name.endsWith('.html')) return Buffer.from(content);
  return Buffer.from(Buffer.from(content).toString('utf8').replace(
    /\bhref=(["'])([A-Za-z0-9_./-]+)\1/g,
    (_, quote, href) => `href="${href.replace(/\.html$/, '')}"`
  ));
}

export function validatePreviewJob(env) {
  const input = JSON.parse(env.PLATFORM_PLAN_JSON || '{}');
  const normalized = { ...normalizePlatformPlan(platformPlanInput(input)), sourceCommit: input.sourceCommit };
  if (JSON.stringify(input) !== JSON.stringify(normalized)
    || !/^[a-f0-9]{40}$/.test(input.sourceCommit || '')
    || input.sourceCommit !== env.GITHUB_SHA || env.GITHUB_REF !== 'refs/heads/main'
    || sha256(JSON.stringify(normalized)) !== env.PLATFORM_PLAN_SHA256
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.PLATFORM_REQUEST_ID || '')) {
    throw new Error('PLATFORM_PREVIEW_SOURCE_OR_PLAN_MISMATCH');
  }
  const target = platformTargets(env.CNYOS_PLATFORM_PREVIEW_TARGETS_JSON).find(item => item.key === input.targetKey);
  if (!target || target.siteOrigin !== input.links.site?.url || target.projectRef !== input.links.database?.projectRef
    || (input.links.drive && input.links.drive.id !== target.driveRootId)) throw new Error('PLATFORM_PREVIEW_TARGET_MISMATCH');
  if (!env.NETLIFY_AUTH_TOKEN) throw new Error('PLATFORM_PREVIEW_NETLIFY_CONNECTION_REQUIRED');
  return { plan: normalized, target };
}

async function api(resource) {
  const response = await fetch(`https://api.netlify.com/api/v1/${resource}`, { headers: {
    Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`, Accept: 'application/json'
  }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('PLATFORM_PREVIEW_NETLIFY_READ_FAILED');
  return response.json();
}

async function prepare() {
  const { plan, target } = validatePreviewJob(process.env);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== plan.sourceCommit) throw new Error('PLATFORM_PREVIEW_CHECKOUT_MISMATCH');
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
  const site = await api(`sites/${target.siteId}`);
  if (site.id !== target.siteId || site.ssl_url !== target.siteOrigin) throw new Error('PLATFORM_PREVIEW_SITE_MISMATCH');
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(path.join(work, 'empty-functions'), { recursive: true });
  await fs.writeFile(path.join(work, 'before.json'), JSON.stringify({ siteId: site.id, publishedDeployId: site.published_deploy?.id || null }));
  const config = JSON.parse(await fs.readFile(path.join(root, 'config/tenant.staging.example.json'), 'utf8'));
  config.deploymentId = `${plan.slug}-staging`;
  config.brand = { ...config.brand, appName: plan.name, browserTitle: plan.name, shortName: plan.name.slice(0, 60), nameTh: plan.name, nameEn: plan.name, mark: 'C', logoUrl: '' };
  config.tenant = { expectedClinicId: target.clinicId, expectedClinicCode: target.clinicCode };
  config.database = { provider: 'supabase', url: `https://${target.projectRef}.supabase.co`, publishableKey: 'sb_publishable_PREVIEW_DATABASE_LOCKED' };
  config.identity = { qrIssuer: target.clinicCode };
  config.auth = { provider: 'google', redirectOrigin: target.siteOrigin };
  config.features = plan.features;
  await fs.writeFile(path.join(work, 'tenant.json'), JSON.stringify(config, null, 2));
  await fs.appendFile(process.env.GITHUB_ENV, `NETLIFY_SITE_ID=${target.siteId}\nCLINICAL_OS_SOURCE_COMMIT=${plan.sourceCommit}\nCLINICAL_OS_SOURCE_TREE=${tree}\nCLINICAL_OS_TENANT_CONFIG_PATH=artifacts/platform-preview/tenant.json\n`);
  console.log('Validated an exact-source, database-locked draft package.');
}

async function verify() {
  const { plan, target } = validatePreviewJob(process.env);
  const output = JSON.parse(await fs.readFile(path.join(work, 'deploy.json'), 'utf8'));
  const id = output.deploy_id;
  if (!/^[a-f0-9]{24}$/.test(id || '')) throw new Error('PLATFORM_PREVIEW_DEPLOY_ID_INVALID');
  const [site, deploy] = await Promise.all([api(`sites/${target.siteId}`), api(`deploys/${id}`)]);
  const before = JSON.parse(await fs.readFile(path.join(work, 'before.json'), 'utf8'));
  if (site.id !== target.siteId || deploy.site_id !== target.siteId || deploy.state !== 'ready'
    || site.published_deploy?.id === id || (site.published_deploy?.id || null) !== before.publishedDeployId
    || (Array.isArray(deploy.functions) && deploy.functions.length > 0)) throw new Error('PLATFORM_PREVIEW_PUBLICATION_BOUNDARY_FAILED');
  const origin = `https://${id}--${new URL(target.siteOrigin).hostname}`;
  if (output.deploy_url !== origin && output.deploy_ssl_url !== origin && deploy.deploy_ssl_url !== origin) throw new Error('PLATFORM_PREVIEW_URL_MISMATCH');
  const result = await fetch(`${origin}/deploy-manifest.json`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!result.ok) throw new Error('PLATFORM_PREVIEW_MANIFEST_MISSING');
  const manifest = await result.json();
  if (manifest.source?.commit !== plan.sourceCommit || manifest.source?.tree !== process.env.CLINICAL_OS_SOURCE_TREE
    || manifest.safety?.databaseLocked !== true || JSON.stringify(manifest.package?.features) !== JSON.stringify(plan.features)
    || manifest.tenant?.expectedClinicId !== target.clinicId || manifest.tenant?.expectedClinicCode !== target.clinicCode) {
    throw new Error('PLATFORM_PREVIEW_MANIFEST_MISMATCH');
  }
  const checked = [];
  for (const name of ['login.html', 'tenant-config.js', ...PLATFORM_FEATURES.flatMap(feature => feature.pages.map(page => `${page}.html`))]) {
    const feature = PLATFORM_FEATURES.find(item => item.pages.some(page => `${page}.html` === name));
    const selected = !feature || plan.features.includes(feature.id);
    const response = await fetch(`${origin}/${name}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (selected) {
      if (!response.ok) throw new Error('PLATFORM_PREVIEW_SELECTED_FILE_MISSING');
      const [remote, local] = await Promise.all([response.arrayBuffer(), fs.readFile(path.join(root, 'dist', name))]);
      if (sha256(canonicalPreviewAsset(name, remote)) !== sha256(canonicalPreviewAsset(name, local))) throw new Error('PLATFORM_PREVIEW_ASSET_MISMATCH');
    } else if (response.status !== 404) throw new Error('PLATFORM_PREVIEW_EXCLUDED_FEATURE_PRESENT');
    checked.push({ name, selected, status: response.status });
  }
  const evidence = { verifiedAt: new Date().toISOString(), requestId: process.env.PLATFORM_REQUEST_ID,
    planHash: process.env.PLATFORM_PLAN_SHA256, sourceCommit: plan.sourceCommit, sourceTree: manifest.source.tree,
    siteId: target.siteId, deployId: id, previewUrl: origin, primarySiteUnchanged: true, databaseLocked: true,
    authenticatedClinicalUseVerified: false, checked };
  await fs.writeFile(path.join(work, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## CNYOS draft verified\n\n[Open isolated draft](${origin}/ui-review.html)\n\nSource: \`${plan.sourceCommit}\`\n\nSelected package: ${plan.features.join(', ')}\n\nDatabase locked. Primary published site unchanged. See evidence.json for file checks.\n`);
  console.log('Verified exact source, selected pages and unchanged primary deployment.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2];
  (operation === 'prepare' ? prepare() : operation === 'verify' ? verify() : Promise.reject(new Error('PLATFORM_PREVIEW_OPERATION_INVALID')))
    .catch(error => { console.error(/^PLATFORM_[A-Z_]+$/.test(error?.message) ? error.message : 'PLATFORM_PREVIEW_FAILED'); process.exitCode = 1; });
}
