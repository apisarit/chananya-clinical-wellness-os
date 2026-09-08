import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_FEATURES, resolvePlatformFeatures } from '../platform-config.js';
import { GENERATED_CONFIG_DIRECTORY } from './generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');

const allowedExact = new Set([
  '_headers',
  '_redirects',
  'tenant-config.js',
  'brand-config.js',
  'deploy-manifest.json'
]);

const generatedConfigFiles = Object.freeze([
  'tenant-config.js',
  'brand-config.js',
  'deploy-manifest.json'
]);

const allowedExtensions = new Set([
  '.html',
  '.js',
  '.css',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ico',
  '.webmanifest'
]);

export function isPublicRuntimeRootFile(name) {
  if (!name || name.includes('/') || name.includes('\\')) return false;
  if (allowedExact.has(name)) return true;
  return allowedExtensions.has(path.extname(name).toLowerCase());
}

export function loadExactGitRootBlobs(cwd = root) {
  const raw = execFileSync('git', ['ls-tree', '-z', 'HEAD'], { cwd, encoding: 'utf8' });
  const files = new Map();
  for (const record of raw.split('\0').filter(Boolean)) {
    const match = record.match(/^(\d+)\s+(\S+)\s+[0-9a-f]+\t(.+)$/);
    if (!match) throw new Error('NETLIFY_PUBLISH_GIT_TREE_INVALID');
    const [, mode, type, name] = match;
    if (type !== 'blob' || !isPublicRuntimeRootFile(name) || generatedConfigFiles.includes(name)) continue;
    if (!['100644', '100755'].includes(mode)) {
      throw new Error(`NETLIFY_PUBLISH_UNSAFE_GIT_MODE: ${name}`);
    }
    files.set(name, execFileSync('git', ['show', `HEAD:${name}`], { cwd, encoding: 'buffer' }));
  }
  return files;
}

export function selectRuntimeSourceFiles(sourceFiles, deployment) {
  if (!(sourceFiles instanceof Map)) throw new Error('NETLIFY_PUBLISH_SOURCE_MAP_REQUIRED');
  const selected = deployment.package?.features ? resolvePlatformFeatures(deployment.package.features) : null;
  const excludedPages = selected ? PLATFORM_FEATURES.filter(item => !selected.includes(item.id)).flatMap(item => item.pages) : [];
  const excludedFile = name => selected && (
    excludedPages.some(page => name === `${page}.html` || name === `${page}.js` || name === `${page}.css`)
    || (!selected.includes('u-synthesise') && /^(?:luopan|u-synthesise)[-.]/.test(name))
    || /^(?:platform-console|platform-config|owner-control)[.]/.test(name)
  );
  return new Map([...sourceFiles.entries()].filter(([name]) =>
    isPublicRuntimeRootFile(name) && !generatedConfigFiles.includes(name) && !excludedFile(name)
  ));
}

export async function assertRuntimeWorktreeMatchesGit(cwd, sourceFiles) {
  for (const [name, expected] of sourceFiles) {
    let observed;
    try {
      observed = await fs.readFile(path.join(cwd, name));
    } catch {
      throw new Error(`NETLIFY_PUBLISH_TRACKED_SOURCE_MISSING: ${name}`);
    }
    if (!Buffer.isBuffer(expected) || !observed.equals(expected)) {
      throw new Error(`NETLIFY_PUBLISH_TRACKED_SOURCE_DRIFT: ${name}`);
    }
  }
}

export async function buildNetlifyPublish({
  cwd = root,
  env = process.env,
  now = () => new Date(),
  sourceFiles = null
} = {}) {
  const target = path.join(cwd, 'dist');
  const generated = path.join(cwd, GENERATED_CONFIG_DIRECTORY);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true, mode: 0o755 });

  const deployment = JSON.parse(await fs.readFile(path.join(generated, 'deploy-manifest.json'), 'utf8'));
  const selectedSources = selectRuntimeSourceFiles(sourceFiles || loadExactGitRootBlobs(cwd), deployment);
  await assertRuntimeWorktreeMatchesGit(cwd, selectedSources);
  const copied = [];
  for (const [name, content] of selectedSources) {
    await fs.writeFile(path.join(target, name), content, { mode: 0o644 });
    copied.push(name);
  }
  for (const name of generatedConfigFiles) {
    await fs.copyFile(path.join(generated, name), path.join(target, name));
    copied.push(name);
  }

  const required = [
    'index.html',
    'login.html',
    'auth-callback.html',
    'app.js',
    'app.css',
    'auth-config.js',
    'tenant-config.js',
    'brand-config.js',
    'deploy-manifest.json'
  ];
  const copiedSet = new Set(copied);
  const missing = required.filter(name => !copiedSet.has(name));
  if (missing.length) {
    throw new Error(`NETLIFY_PUBLISH_MISSING_RUNTIME_FILES: ${missing.join(', ')}`);
  }

  const forbidden = [
    '.env.example',
    'netlify.toml',
    'package.json',
    'package-lock.json',
    'release-readiness.json',
    'Chananya_Clinical_Wellness_OS_MVP_singlefile.zip'
  ];
  for (const name of forbidden) {
    try {
      await fs.access(path.join(target, name));
      throw new Error(`NETLIFY_PUBLISH_FORBIDDEN_FILE: ${name}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const files = copied.sort();
  const integrity = [];
  for (const name of files) {
    const content = await fs.readFile(path.join(target, name));
    integrity.push(Object.freeze({
      path: name,
      size: content.byteLength,
      sha256: crypto.createHash('sha256').update(content).digest('hex')
    }));
  }
  const explicitTimestamp = String(env.CLINICAL_OS_BUILD_TIMESTAMP || '').trim();
  const generatedAt = explicitTimestamp ? new Date(explicitTimestamp) : now();
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    throw new Error('NETLIFY_PUBLISH_TIMESTAMP_INVALID');
  }
  const manifest = {
    schemaVersion: 2,
    generatedAt: generatedAt.toISOString(),
    fileCount: files.length,
    files,
    integrityAlgorithm: 'sha256',
    integrity
  };
  await fs.writeFile(
    path.join(target, 'runtime-publish-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 }
  );
  await fs.rm(generated, { recursive: true, force: true });

  process.stdout.write(`Netlify runtime publish surface prepared: ${copied.length} files in dist/\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNetlifyPublish().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
