import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');

const allowedExact = new Set([
  '_headers',
  '_redirects',
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

export async function buildNetlifyPublish({ cwd = root } = {}) {
  const target = path.join(cwd, 'dist');
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true, mode: 0o755 });

  const entries = await fs.readdir(cwd, { withFileTypes: true });
  const copied = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isPublicRuntimeRootFile(entry.name)) continue;
    await fs.copyFile(path.join(cwd, entry.name), path.join(target, entry.name));
    copied.push(entry.name);
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

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fileCount: copied.length,
    files: copied.sort()
  };
  await fs.writeFile(
    path.join(target, 'runtime-publish-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 }
  );

  process.stdout.write(`Netlify runtime publish surface prepared: ${copied.length} files in dist/\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNetlifyPublish().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
