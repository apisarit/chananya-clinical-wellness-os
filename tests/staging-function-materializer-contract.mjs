import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FUNCTION_TREE_DIGEST_DOMAIN,
  FUNCTION_TREE_DIGEST_FORMAT,
  assertSafeGitPath,
  computeFunctionManifestSha256,
  computeFunctionTreeSha256,
  materializeStagingFunctions,
  parseGitTreeInventory,
  readFunctionInputsFromGit,
  resolveFunctionSource
} from '../scripts/materialize-staging-functions.mjs';

const objectId = '0123456789abcdef0123456789abcdef01234567';

function git(cwd, args, input = undefined) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
}

function treeRecord({
  mode = '100644',
  type = 'blob',
  oid = objectId,
  name = 'handler.mjs'
} = {}) {
  return Buffer.from(`${mode} ${type} ${oid}\t${name}\0`, 'utf8');
}

function initializeRepository() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cnyos-staging-functions-'));
  git(fixture, ['init', '-q']);
  git(fixture, ['config', 'user.name', 'CNYOS Contract']);
  git(fixture, ['config', 'user.email', 'contract@example.invalid']);
  fs.mkdirSync(path.join(fixture, 'netlify/functions/_shared'), { recursive: true });
  fs.writeFileSync(path.join(fixture, '.gitignore'), [
    'artifacts/',
    'netlify/functions/ignored-overlay.mjs',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(fixture, 'netlify/functions/alpha.mjs'), 'export const version = "v1";\n');
  fs.writeFileSync(
    path.join(fixture, 'netlify/functions/_shared/helper.mjs'),
    'export const helper = () => "tracked";\n'
  );
  fs.writeFileSync(path.join(fixture, 'netlify/functions/executable.mjs'), '#!/usr/bin/env node\nexport {};\n');
  fs.chmodSync(path.join(fixture, 'netlify/functions/executable.mjs'), 0o755);
  git(fixture, ['add', '.gitignore', 'netlify/functions']);
  git(fixture, ['commit', '-q', '-m', 'first function tree']);
  const firstCommit = git(fixture, ['rev-parse', 'HEAD']);
  const firstTree = git(fixture, ['rev-parse', `${firstCommit}:netlify/functions`]);

  fs.writeFileSync(path.join(fixture, 'netlify/functions/alpha.mjs'), 'export const version = "v2";\n');
  git(fixture, ['add', 'netlify/functions/alpha.mjs']);
  git(fixture, ['commit', '-q', '-m', 'second function tree']);
  const secondCommit = git(fixture, ['rev-parse', 'HEAD']);
  const secondTree = git(fixture, ['rev-parse', `${secondCommit}:netlify/functions`]);

  return { fixture, firstCommit, firstTree, secondCommit, secondTree };
}

function uint64(value) {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

function independentlyComputeTreeDigest(outputDirectory, entries) {
  const digest = crypto.createHash('sha256');
  digest.update(Buffer.from('CNYOS_STAGING_FUNCTION_INPUT_TREE_V1\0', 'utf8'));
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    const modeBytes = Buffer.from(entry.mode, 'ascii');
    const content = fs.readFileSync(path.join(outputDirectory, ...entry.path.split('/')));
    digest.update(uint64(pathBytes.length));
    digest.update(pathBytes);
    digest.update(uint64(modeBytes.length));
    digest.update(modeBytes);
    digest.update(uint64(content.length));
    digest.update(content);
  }
  return digest.digest('hex');
}

assert.equal(FUNCTION_TREE_DIGEST_DOMAIN, 'CNYOS_STAGING_FUNCTION_INPUT_TREE_V1\0');
assert.match(FUNCTION_TREE_DIGEST_FORMAT, /uint64be\(path-length\).*raw-content/);

for (const unsafe of [
  '../escape.mjs',
  'nested/../../escape.mjs',
  '/absolute.mjs',
  'windows\\escape.mjs',
  './relative.mjs',
  'nested//empty.mjs',
  '.git/config',
  'nested/.GIT/config',
  'control\nname.mjs',
  'decomposed-e\u0301.mjs'
]) {
  assert.throws(() => assertSafeGitPath(unsafe), /STAGING_FUNCTION_PATH_/);
}
assert.equal(assertSafeGitPath('_shared/runtime.mjs'), '_shared/runtime.mjs');

for (const hostileRecord of [
  treeRecord({ mode: '120000', type: 'blob', name: 'linked.mjs' }),
  treeRecord({ mode: '160000', type: 'commit', name: 'vendored' }),
  treeRecord({ mode: '040000', type: 'tree', name: 'nested' }),
  treeRecord({ mode: '100664', type: 'blob', name: 'group-writable.mjs' })
]) {
  assert.throws(
    () => parseGitTreeInventory(hostileRecord),
    /STAGING_FUNCTION_NON_REGULAR_ENTRY/
  );
}
assert.throws(
  () => parseGitTreeInventory(treeRecord({ name: '../escape.mjs' })),
  /STAGING_FUNCTION_PATH_TRAVERSAL/
);
assert.throws(
  () => parseGitTreeInventory(Buffer.concat([
    treeRecord({ name: 'Handler.mjs' }),
    treeRecord({ oid: '1123456789abcdef0123456789abcdef01234567', name: 'handler.mjs' })
  ])),
  /STAGING_FUNCTION_PORTABLE_PATH_COLLISION/
);
assert.throws(
  () => parseGitTreeInventory(Buffer.from(`100644 blob ${objectId}\thandler.mjs`, 'utf8')),
  /STAGING_FUNCTION_TREE_LIST_TRUNCATED/
);
assert.throws(
  () => parseGitTreeInventory(Buffer.from([
    ...Buffer.from(`100644 blob ${objectId}\t`, 'utf8'),
    0xff,
    0x00
  ])),
  /STAGING_FUNCTION_PATH_ENCODING_INVALID/
);

const { fixture, firstCommit, firstTree, secondCommit, secondTree } = initializeRepository();
try {
  const output = path.join(fixture, 'artifacts/staging-candidate/functions');
  const manifestPath = path.join(fixture, 'artifacts/staging-candidate/function-input-manifest.json');

  // These tracked, untracked, ignored, and stale-output overlays must never be source inputs.
  fs.writeFileSync(path.join(fixture, 'netlify/functions/alpha.mjs'), 'export const version = "ambient-v3";\n');
  fs.writeFileSync(path.join(fixture, 'netlify/functions/untracked-overlay.mjs'), 'throw new Error("ambient");\n');
  fs.writeFileSync(path.join(fixture, 'netlify/functions/ignored-overlay.mjs'), 'throw new Error("ignored");\n');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'stale-overlay.mjs'), 'stale\n');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, '{"stale":true}\n');

  const manifest = await materializeStagingFunctions({
    cwd: fixture,
    ref: firstCommit,
    outputDirectory: 'artifacts/staging-candidate/functions',
    manifestPath: 'artifacts/staging-candidate/function-input-manifest.json'
  });
  assert.equal(fs.readFileSync(path.join(output, 'alpha.mjs'), 'utf8'), 'export const version = "v1";\n');
  assert.equal(fs.existsSync(path.join(output, 'untracked-overlay.mjs')), false);
  assert.equal(fs.existsSync(path.join(output, 'ignored-overlay.mjs')), false);
  assert.equal(fs.existsSync(path.join(output, 'stale-overlay.mjs')), false);
  assert.deepEqual(
    manifest.files.map(entry => entry.path),
    ['_shared/helper.mjs', 'alpha.mjs', 'executable.mjs']
  );
  assert.deepEqual(
    Object.keys(manifest.files[0]),
    ['path', 'size', 'sha256', 'mode'],
    'canonical entry field order is part of the manifest digest contract'
  );
  assert.equal(manifest.fileCount, 3);
  assert.equal(manifest.source.requestedRef, firstCommit);
  assert.equal(manifest.source.resolvedRefObjectId, firstCommit);
  assert.equal(manifest.source.sourcePath, 'netlify/functions');
  assert.equal(manifest.source.sourceTreeObjectId, firstTree);
  assert.equal(manifest.manifestSha256, crypto.createHash('sha256')
    .update(JSON.stringify(manifest.files), 'utf8')
    .digest('hex'));
  assert.equal(manifest.manifestSha256, computeFunctionManifestSha256(manifest.files));
  assert.equal(manifest.treeSha256, independentlyComputeTreeDigest(output, manifest.files));
  assert.equal(manifest.overallSha256, manifest.treeSha256);
  assert.match(manifest.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.treeSha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(output, 'executable.mjs')).mode & 0o777, 0o755);

  const storedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(storedManifest, manifest);

  const repeatOutput = path.join(fixture, 'artifacts/repeat/functions');
  const repeatManifestPath = path.join(fixture, 'artifacts/repeat/function-input-manifest.json');
  const repeated = await materializeStagingFunctions({
    cwd: fixture,
    ref: firstCommit,
    outputDirectory: 'artifacts/repeat/functions',
    manifestPath: 'artifacts/repeat/function-input-manifest.json'
  });
  assert.deepEqual(repeated, manifest, 'same immutable Git input must emit the same deterministic manifest');
  assert.equal(
    fs.readFileSync(repeatManifestPath, 'utf8'),
    fs.readFileSync(manifestPath, 'utf8'),
    'serialized manifest must be deterministic'
  );

  const exactTreeOutput = path.join(fixture, 'artifacts/exact-tree/functions');
  const exactTree = await materializeStagingFunctions({
    cwd: fixture,
    sourceTreeObjectId: firstTree,
    outputDirectory: 'artifacts/exact-tree/functions',
    manifestPath: 'artifacts/exact-tree/function-input-manifest.json'
  });
  assert.equal(exactTree.source.requestedRef, null);
  assert.equal(exactTree.source.sourceTreeObjectId, firstTree);
  assert.equal(exactTree.manifestSha256, manifest.manifestSha256);
  assert.equal(exactTree.treeSha256, manifest.treeSha256);

  const headOutput = path.join(fixture, 'artifacts/head/functions');
  const head = await materializeStagingFunctions({
    cwd: fixture,
    outputDirectory: 'artifacts/head/functions',
    manifestPath: 'artifacts/head/function-input-manifest.json'
  });
  assert.equal(head.source.requestedRef, 'HEAD');
  assert.equal(head.source.resolvedRefObjectId, secondCommit);
  assert.equal(head.source.sourceTreeObjectId, secondTree);
  assert.equal(fs.readFileSync(path.join(headOutput, 'alpha.mjs'), 'utf8'), 'export const version = "v2";\n');
  assert.notEqual(head.treeSha256, manifest.treeSha256, 'tracked content change must change the tree digest');

  const source = resolveFunctionSource({ cwd: fixture, ref: firstCommit });
  assert.equal(source.sourceTreeObjectId, firstTree);
  const readOnlyInputs = readFunctionInputsFromGit({ cwd: fixture, ref: firstCommit });
  assert.equal(readOnlyInputs.source.sourceTreeObjectId, firstTree);
  assert.equal(readOnlyInputs.fileCount, 3);
  assert.equal(readOnlyInputs.manifestSha256, manifest.manifestSha256);
  assert.equal(readOnlyInputs.treeSha256, manifest.treeSha256);
  assert.ok(readOnlyInputs.blobs.every(blob => Buffer.isBuffer(blob.content)));

  const syntheticFiles = [{ path: 'same.mjs', mode: '100644', content: Buffer.from('same') }];
  const executableSyntheticFiles = [{ path: 'same.mjs', mode: '100755', content: Buffer.from('same') }];
  const syntheticEntries = [{
    path: 'same.mjs',
    size: 4,
    sha256: '0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5',
    mode: '100644'
  }];
  assert.equal(
    computeFunctionManifestSha256(syntheticEntries),
    '6d036d371d7a6495ce1d8239a80a713712f65ba8cf1b642bbe8b0b3ba0becfc4',
    'canonical manifest digest test vector changed'
  );
  assert.equal(
    computeFunctionTreeSha256(syntheticFiles),
    'debb167c319c295981666b4d8bcdadf732865c5fda8f3eaea48a730d156741ad',
    'domain-separated raw tree digest test vector changed'
  );
  assert.notEqual(
    computeFunctionTreeSha256(syntheticFiles),
    computeFunctionTreeSha256(executableSyntheticFiles),
    'Git regular-file mode must be bound into the tree digest'
  );

  // A symlink committed inside the source tree is rejected, and stale destinations are removed first.
  fs.rmSync(path.join(fixture, 'netlify/functions/untracked-overlay.mjs'));
  fs.rmSync(path.join(fixture, 'netlify/functions/ignored-overlay.mjs'));
  git(fixture, ['restore', 'netlify/functions/alpha.mjs']);
  fs.symlinkSync('alpha.mjs', path.join(fixture, 'netlify/functions/linked.mjs'));
  git(fixture, ['add', 'netlify/functions/linked.mjs']);
  git(fixture, ['commit', '-q', '-m', 'hostile symlink']);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'must-be-cleared.mjs'), 'stale');
  fs.writeFileSync(manifestPath, '{"stale":true}\n');
  await assert.rejects(
    materializeStagingFunctions({
      cwd: fixture,
      outputDirectory: 'artifacts/staging-candidate/functions',
      manifestPath: 'artifacts/staging-candidate/function-input-manifest.json'
    }),
    /STAGING_FUNCTION_NON_REGULAR_ENTRY/
  );
  assert.equal(fs.existsSync(output), false, 'failed materialization must not leave a stale output tree');
  assert.equal(fs.existsSync(manifestPath), false, 'failed materialization must not leave a stale manifest');

  // A destination symlink is unlinked and rejected without following it into the victim directory.
  const victim = path.join(fixture, 'victim');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'do not overwrite\n');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.symlinkSync(victim, output);
  await assert.rejects(
    materializeStagingFunctions({
      cwd: fixture,
      ref: firstCommit,
      outputDirectory: 'artifacts/staging-candidate/functions',
      manifestPath: 'artifacts/staging-candidate/function-input-manifest.json'
    }),
    /STAGING_FUNCTION_OUTPUT_SYMLINK_FORBIDDEN/
  );
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'do not overwrite\n');

  const linkedParent = path.join(fixture, 'linked-artifacts');
  fs.symlinkSync(victim, linkedParent);
  await assert.rejects(
    materializeStagingFunctions({
      cwd: fixture,
      ref: firstCommit,
      outputDirectory: 'linked-artifacts/functions',
      manifestPath: 'artifacts/linked-parent-test-manifest.json'
    }),
    /STAGING_FUNCTION_OUTPUT_SYMLINK_FORBIDDEN/
  );
  assert.equal(fs.existsSync(path.join(victim, 'functions')), false);
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'do not overwrite\n');

  await assert.rejects(
    materializeStagingFunctions({
      cwd: fixture,
      ref: firstCommit,
      outputDirectory: '../outside-functions',
      manifestPath: 'artifacts/outside-test-manifest.json'
    }),
    /STAGING_FUNCTION_OUTPUT_OUTSIDE_REPOSITORY/
  );
  await assert.rejects(
    materializeStagingFunctions({
      cwd: fixture,
      ref: firstCommit,
      outputDirectory: 'artifacts/inside/functions',
      manifestPath: 'artifacts/inside/functions/manifest.json'
    }),
    /STAGING_FUNCTION_MANIFEST_INSIDE_OUTPUT/
  );
  await assert.rejects(
    materializeStagingFunctions({
      cwd: fixture,
      ref: firstCommit,
      outputDirectory: 'netlify/functions',
      manifestPath: 'artifacts/tracked-output-test-manifest.json'
    }),
    /STAGING_FUNCTION_OUTPUT_TRACKED_PATH_FORBIDDEN/
  );
  assert.equal(
    fs.readFileSync(path.join(fixture, 'netlify/functions/alpha.mjs'), 'utf8'),
    'export const version = "v2";\n',
    'a mistaken tracked output target must be rejected without modifying the checkout'
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log('Staging Function materializer contract passed: exact Git blobs, closed-world output, deterministic digests');
