import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FUNCTION_TREE_DIGEST_DOMAIN = 'CNYOS_STAGING_FUNCTION_INPUT_TREE_V1\0';
export const FUNCTION_TREE_DIGEST_FORMAT =
  'utf8-domain; repeated uint64be(path-length), path-utf8, uint64be(mode-length), mode-ascii, uint64be(content-length), raw-content';

const REGULAR_GIT_MODES = new Set(['100644', '100755']);
const MAX_FILE_COUNT = 4096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = MAX_TOTAL_BYTES + (1024 * 1024);
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function fail(code, detail = '') {
  const suffix = detail ? `: ${detail}` : '';
  throw new Error(`${code}${suffix}`);
}

function bytewisePathCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function gitEnvironment(env = process.env) {
  const isolated = { ...env };
  for (const name of Object.keys(isolated)) {
    if (name.startsWith('GIT_')) delete isolated[name];
  }
  isolated.GIT_CONFIG_NOSYSTEM = '1';
  isolated.GIT_CONFIG_GLOBAL = '/dev/null';
  isolated.GIT_OPTIONAL_LOCKS = '0';
  isolated.LC_ALL = 'C';
  return isolated;
}

function runGit(cwd, args, { encoding = 'buffer', maxBuffer = MAX_GIT_OUTPUT_BYTES } = {}) {
  try {
    return execFileSync('git', ['--no-replace-objects', ...args], {
      cwd,
      encoding,
      env: gitEnvironment(),
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    fail('STAGING_FUNCTION_GIT_COMMAND_FAILED', args[0] || 'unknown');
  }
}

function decodeGitText(buffer, code) {
  try {
    return textDecoder.decode(buffer);
  } catch {
    fail(code);
  }
}

export function assertSafeGitPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    fail('STAGING_FUNCTION_PATH_EMPTY');
  }
  if (Buffer.byteLength(candidate, 'utf8') > 4096) {
    fail('STAGING_FUNCTION_PATH_TOO_LONG', candidate.slice(0, 80));
  }
  if (candidate.startsWith('/') || candidate.includes('\\')) {
    fail('STAGING_FUNCTION_PATH_UNSAFE', candidate);
  }
  if (/[\u0000-\u001f\u007f]/u.test(candidate)) {
    fail('STAGING_FUNCTION_PATH_CONTROL_CHARACTER');
  }
  if (candidate.normalize('NFC') !== candidate) {
    fail('STAGING_FUNCTION_PATH_NON_CANONICAL_UNICODE', candidate);
  }
  const segments = candidate.split('/');
  if (
    segments.some(segment =>
      segment.length === 0 || segment === '.' || segment === '..' || segment.toLowerCase() === '.git'
    )
  ) {
    fail('STAGING_FUNCTION_PATH_TRAVERSAL', candidate);
  }
  if (path.posix.normalize(candidate) !== candidate) {
    fail('STAGING_FUNCTION_PATH_NON_CANONICAL', candidate);
  }
  return candidate;
}

function splitNullRecords(raw) {
  if (!Buffer.isBuffer(raw)) fail('STAGING_FUNCTION_TREE_LIST_BUFFER_REQUIRED');
  if (raw.length === 0) return [];
  if (raw[raw.length - 1] !== 0) fail('STAGING_FUNCTION_TREE_LIST_TRUNCATED');
  const records = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== 0) continue;
    if (index === start) fail('STAGING_FUNCTION_TREE_LIST_EMPTY_RECORD');
    records.push(raw.subarray(start, index));
    start = index + 1;
  }
  return records;
}

export function parseGitTreeInventory(raw) {
  const inventory = [];
  const exactPaths = new Set();
  const portablePaths = new Set();

  for (const rawRecord of splitNullRecords(raw)) {
    const tab = rawRecord.indexOf(0x09);
    if (tab <= 0 || tab === rawRecord.length - 1) {
      fail('STAGING_FUNCTION_TREE_RECORD_INVALID');
    }
    const header = decodeGitText(rawRecord.subarray(0, tab), 'STAGING_FUNCTION_TREE_HEADER_ENCODING_INVALID');
    const candidate = decodeGitText(rawRecord.subarray(tab + 1), 'STAGING_FUNCTION_PATH_ENCODING_INVALID');
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(header);
    if (!match) fail('STAGING_FUNCTION_TREE_HEADER_INVALID');
    const [, mode, type, objectId] = match;
    assertSafeGitPath(candidate);
    if (type !== 'blob' || !REGULAR_GIT_MODES.has(mode)) {
      fail('STAGING_FUNCTION_NON_REGULAR_ENTRY', `${candidate} (${mode} ${type})`);
    }
    if (exactPaths.has(candidate)) fail('STAGING_FUNCTION_DUPLICATE_PATH', candidate);
    const portableKey = candidate.normalize('NFC').toLowerCase();
    if (portablePaths.has(portableKey)) fail('STAGING_FUNCTION_PORTABLE_PATH_COLLISION', candidate);
    exactPaths.add(candidate);
    portablePaths.add(portableKey);
    inventory.push(Object.freeze({ path: candidate, mode, objectId }));
  }

  if (inventory.length === 0) fail('STAGING_FUNCTION_TREE_EMPTY');
  if (inventory.length > MAX_FILE_COUNT) fail('STAGING_FUNCTION_TREE_FILE_LIMIT_EXCEEDED');
  inventory.sort((left, right) => bytewisePathCompare(left.path, right.path));
  return Object.freeze(inventory);
}

function uint64(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('STAGING_FUNCTION_DIGEST_LENGTH_INVALID');
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

// The framing is deliberately independent of JSON serialization. A controller can
// reproduce it by hashing the domain bytes once, followed by three length-prefixed
// fields (path, mode, blob) for every bytewise-path-sorted Git tree entry.
export function computeFunctionTreeSha256(files) {
  if (!Array.isArray(files)) fail('STAGING_FUNCTION_DIGEST_FILES_ARRAY_REQUIRED');
  const canonicalFiles = [...files].sort((left, right) => bytewisePathCompare(left.path, right.path));
  const digest = crypto.createHash('sha256');
  digest.update(Buffer.from(FUNCTION_TREE_DIGEST_DOMAIN, 'utf8'));
  let previousPath = null;
  for (const file of canonicalFiles) {
    assertSafeGitPath(file.path);
    if (!REGULAR_GIT_MODES.has(file.mode)) fail('STAGING_FUNCTION_DIGEST_MODE_INVALID', file.path);
    if (previousPath === file.path) fail('STAGING_FUNCTION_DIGEST_DUPLICATE_PATH', file.path);
    previousPath = file.path;
    const pathBytes = Buffer.from(file.path, 'utf8');
    const modeBytes = Buffer.from(file.mode, 'ascii');
    if (!Buffer.isBuffer(file.content)) fail('STAGING_FUNCTION_DIGEST_CONTENT_BUFFER_REQUIRED', file.path);
    digest.update(uint64(pathBytes.length));
    digest.update(pathBytes);
    digest.update(uint64(modeBytes.length));
    digest.update(modeBytes);
    digest.update(uint64(file.content.length));
    digest.update(file.content);
  }
  return digest.digest('hex');
}

export function computeFunctionManifestSha256(entries) {
  if (!Array.isArray(entries)) fail('STAGING_FUNCTION_MANIFEST_ENTRIES_ARRAY_REQUIRED');
  const canonicalEntries = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('STAGING_FUNCTION_MANIFEST_ENTRY_INVALID');
    }
    assertSafeGitPath(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) {
      fail('STAGING_FUNCTION_MANIFEST_SIZE_INVALID', entry.path);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) fail('STAGING_FUNCTION_MANIFEST_SHA256_INVALID', entry.path);
    if (!REGULAR_GIT_MODES.has(entry.mode)) fail('STAGING_FUNCTION_MANIFEST_MODE_INVALID', entry.path);
    const keys = Object.keys(entry).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['mode', 'path', 'sha256', 'size'])) {
      fail('STAGING_FUNCTION_MANIFEST_ENTRY_KEYS_INVALID', entry.path);
    }
    return Object.freeze({
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256,
      mode: entry.mode
    });
  }).sort((left, right) => bytewisePathCompare(left.path, right.path));
  for (let index = 1; index < canonicalEntries.length; index += 1) {
    if (canonicalEntries[index - 1].path === canonicalEntries[index].path) {
      fail('STAGING_FUNCTION_MANIFEST_DUPLICATE_PATH', canonicalEntries[index].path);
    }
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonicalEntries), 'utf8').digest('hex');
}

function validateRef(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) fail(label);
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(label);
  return value;
}

function normalizeSourcePath(value) {
  validateRef(value, 'STAGING_FUNCTION_SOURCE_PATH_INVALID');
  return assertSafeGitPath(value);
}

function resolveObject(cwd, expression, failureCode) {
  const raw = runGit(cwd, ['rev-parse', '--verify', '--end-of-options', expression], {
    encoding: 'utf8',
    maxBuffer: 4096
  });
  const objectId = String(raw).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId)) fail(failureCode);
  return objectId;
}

function objectType(cwd, objectId) {
  const type = String(runGit(cwd, ['cat-file', '-t', objectId], {
    encoding: 'utf8',
    maxBuffer: 128
  })).trim();
  return type;
}

export function resolveFunctionSource({
  cwd = root,
  ref = 'HEAD',
  sourcePath = 'netlify/functions',
  sourceTreeObjectId = null
} = {}) {
  const repository = path.resolve(cwd);
  const objectFormat = String(runGit(repository, ['rev-parse', '--show-object-format'], {
    encoding: 'utf8',
    maxBuffer: 128
  })).trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) fail('STAGING_FUNCTION_GIT_OBJECT_FORMAT_UNSUPPORTED');

  if (sourceTreeObjectId !== null) {
    validateRef(sourceTreeObjectId, 'STAGING_FUNCTION_SOURCE_TREE_INVALID');
    const treeObjectId = resolveObject(
      repository,
      `${sourceTreeObjectId}^{object}`,
      'STAGING_FUNCTION_SOURCE_TREE_INVALID'
    );
    if (objectType(repository, treeObjectId) !== 'tree') fail('STAGING_FUNCTION_SOURCE_NOT_TREE');
    return Object.freeze({
      gitObjectFormat: objectFormat,
      requestedRef: null,
      resolvedRefObjectId: treeObjectId,
      sourcePath: null,
      sourceTreeObjectId: treeObjectId
    });
  }

  validateRef(ref, 'STAGING_FUNCTION_REF_INVALID');
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  const resolvedRefObjectId = resolveObject(
    repository,
    `${ref}^{object}`,
    'STAGING_FUNCTION_REF_UNRESOLVED'
  );
  if (!['commit', 'tree'].includes(objectType(repository, resolvedRefObjectId))) {
    fail('STAGING_FUNCTION_REF_NOT_COMMIT_OR_TREE');
  }
  const sourceTree = resolveObject(
    repository,
    `${resolvedRefObjectId}:${normalizedSourcePath}`,
    'STAGING_FUNCTION_SOURCE_TREE_UNRESOLVED'
  );
  if (objectType(repository, sourceTree) !== 'tree') fail('STAGING_FUNCTION_SOURCE_NOT_TREE');
  return Object.freeze({
    gitObjectFormat: objectFormat,
    requestedRef: ref,
    resolvedRefObjectId,
    sourcePath: normalizedSourcePath,
    sourceTreeObjectId: sourceTree
  });
}

function expectedObjectIdPattern(objectFormat) {
  return objectFormat === 'sha256' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
}

function verifyGitBlobObjectId(content, expectedObjectId, objectFormat, filePath) {
  if (!expectedObjectIdPattern(objectFormat).test(expectedObjectId)) {
    fail('STAGING_FUNCTION_BLOB_OBJECT_ID_FORMAT_INVALID', filePath);
  }
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  const observedObjectId = crypto.createHash(objectFormat).update(header).update(content).digest('hex');
  if (observedObjectId !== expectedObjectId) fail('STAGING_FUNCTION_BLOB_OBJECT_ID_MISMATCH', filePath);
}

// Synchronous by design so release authorization can bind the exact immutable Git
// inputs without ever consulting the index or working tree. No checkout filters,
// ignored files, untracked files, or local modifications participate in this read.
export function readFunctionInputsFromGit({
  cwd = root,
  ref = 'HEAD',
  sourcePath = 'netlify/functions',
  sourceTreeObjectId = null
} = {}) {
  const repository = path.resolve(cwd);
  const source = resolveFunctionSource({ cwd: repository, ref, sourcePath, sourceTreeObjectId });
  if (!expectedObjectIdPattern(source.gitObjectFormat).test(source.sourceTreeObjectId)) {
    fail('STAGING_FUNCTION_SOURCE_TREE_OBJECT_ID_FORMAT_INVALID');
  }
  const rawInventory = runGit(repository, [
    'ls-tree', '-r', '-z', '--full-tree', source.sourceTreeObjectId
  ]);
  const inventory = parseGitTreeInventory(rawInventory);
  const blobs = [];
  let totalBytes = 0;
  for (const item of inventory) {
    const content = runGit(repository, ['cat-file', 'blob', item.objectId], {
      maxBuffer: MAX_FILE_BYTES + 1
    });
    if (content.length > MAX_FILE_BYTES) fail('STAGING_FUNCTION_FILE_LIMIT_EXCEEDED', item.path);
    verifyGitBlobObjectId(content, item.objectId, source.gitObjectFormat, item.path);
    totalBytes += content.length;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
      fail('STAGING_FUNCTION_TREE_BYTE_LIMIT_EXCEEDED');
    }
    blobs.push(Object.freeze({ ...item, content }));
  }

  const files = blobs.map(file => Object.freeze({
    path: file.path,
    size: file.content.length,
    sha256: crypto.createHash('sha256').update(file.content).digest('hex'),
    mode: file.mode
  }));
  const manifestSha256 = computeFunctionManifestSha256(files);
  const treeSha256 = computeFunctionTreeSha256(blobs);
  return Object.freeze({
    source,
    blobs: Object.freeze(blobs),
    files: Object.freeze(files),
    fileCount: files.length,
    totalBytes,
    manifestSha256,
    treeSha256,
    overallSha256: treeSha256
  });
}

function safeDestination(repository, candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') fail(`${label}_REQUIRED`);
  if (/[\u0000-\u001f\u007f]/u.test(candidate)) fail(`${label}_INVALID`);
  const destination = path.resolve(repository, candidate);
  const relative = path.relative(repository, destination);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    fail(`${label}_OUTSIDE_REPOSITORY`);
  }
  const segments = relative.split(path.sep);
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail(`${label}_INVALID`);
  }
  if (segments[0].toLowerCase() === '.git') fail(`${label}_GIT_DIRECTORY_FORBIDDEN`);
  return destination;
}

function containsPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertDestinationDoesNotReplaceTrackedHead(repository, destination, label) {
  const relative = path.relative(repository, destination).split(path.sep).join('/');
  const tracked = runGit(repository, [
    'ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', `:(literal)${relative}`
  ]);
  if (tracked.length > 0) fail(`${label}_TRACKED_PATH_FORBIDDEN`, relative);
}

async function lstatOrNull(candidate) {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoSymlinkAncestors(repository, candidate, label) {
  const relative = path.relative(repository, candidate);
  let cursor = repository;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = await lstatOrNull(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) fail(`${label}_SYMLINK_FORBIDDEN`, path.relative(repository, cursor));
  }
}

async function clearDestination(outputDirectory, manifestPath) {
  const outputStat = await lstatOrNull(outputDirectory);
  if (outputStat?.isSymbolicLink()) {
    await fs.unlink(outputDirectory);
    fail('STAGING_FUNCTION_OUTPUT_SYMLINK_FORBIDDEN');
  }
  if (outputStat && !outputStat.isDirectory()) fail('STAGING_FUNCTION_OUTPUT_NOT_DIRECTORY');
  if (outputStat) await fs.rm(outputDirectory, { recursive: true, force: true });

  const manifestStat = await lstatOrNull(manifestPath);
  if (manifestStat?.isSymbolicLink()) {
    await fs.unlink(manifestPath);
    fail('STAGING_FUNCTION_MANIFEST_SYMLINK_FORBIDDEN');
  }
  if (manifestStat && !manifestStat.isFile()) fail('STAGING_FUNCTION_MANIFEST_NOT_FILE');
  if (manifestStat) await fs.unlink(manifestPath);
}

async function writeExactFile(destination, content, mode) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  const handle = await fs.open(destination, 'wx', mode === '100755' ? 0o755 : 0o644);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  await fs.chmod(destination, mode === '100755' ? 0o755 : 0o644);
}

async function verifyClosedWorldOutput(outputDirectory, files) {
  const expected = new Map(files.map(file => [file.path, file]));
  const observed = [];

  async function visit(directory, prefix = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertSafeGitPath(relative);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('STAGING_FUNCTION_OUTPUT_CONTAINS_SYMLINK', relative);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) fail('STAGING_FUNCTION_OUTPUT_NON_REGULAR_ENTRY', relative);
      observed.push(relative);
      const expectedFile = expected.get(relative);
      if (!expectedFile) fail('STAGING_FUNCTION_OUTPUT_AMBIENT_OVERLAY', relative);
      const stat = await fs.lstat(absolute);
      if (!stat.isFile()) fail('STAGING_FUNCTION_OUTPUT_NON_REGULAR_ENTRY', relative);
      const observedMode = stat.mode & 0o777;
      const expectedMode = expectedFile.mode === '100755' ? 0o755 : 0o644;
      if (observedMode !== expectedMode) fail('STAGING_FUNCTION_OUTPUT_MODE_MISMATCH', relative);
      const content = await fs.readFile(absolute);
      if (content.length !== expectedFile.content.length || !content.equals(expectedFile.content)) {
        fail('STAGING_FUNCTION_OUTPUT_CONTENT_MISMATCH', relative);
      }
    }
  }

  await visit(outputDirectory);
  observed.sort(bytewisePathCompare);
  const expectedPaths = [...expected.keys()].sort(bytewisePathCompare);
  if (JSON.stringify(observed) !== JSON.stringify(expectedPaths)) {
    fail('STAGING_FUNCTION_OUTPUT_CLOSED_WORLD_MISMATCH');
  }
}

export async function materializeStagingFunctions({
  cwd = root,
  ref = 'HEAD',
  sourcePath = 'netlify/functions',
  sourceTreeObjectId = null,
  outputDirectory = 'artifacts/staging-candidate/functions',
  manifestPath = 'artifacts/staging-candidate/function-input-manifest.json'
} = {}) {
  const repository = await fs.realpath(path.resolve(cwd));
  const output = safeDestination(repository, outputDirectory, 'STAGING_FUNCTION_OUTPUT');
  const manifestDestination = safeDestination(repository, manifestPath, 'STAGING_FUNCTION_MANIFEST');
  if (containsPath(output, manifestDestination)) fail('STAGING_FUNCTION_MANIFEST_INSIDE_OUTPUT');
  if (output === manifestDestination) fail('STAGING_FUNCTION_OUTPUT_MANIFEST_COLLISION');
  assertDestinationDoesNotReplaceTrackedHead(repository, output, 'STAGING_FUNCTION_OUTPUT');
  assertDestinationDoesNotReplaceTrackedHead(
    repository,
    manifestDestination,
    'STAGING_FUNCTION_MANIFEST'
  );

  await assertNoSymlinkAncestors(repository, path.dirname(output), 'STAGING_FUNCTION_OUTPUT');
  await assertNoSymlinkAncestors(repository, path.dirname(manifestDestination), 'STAGING_FUNCTION_MANIFEST');
  await clearDestination(output, manifestDestination);

  const inputs = readFunctionInputsFromGit({ cwd: repository, ref, sourcePath, sourceTreeObjectId });
  const { source, blobs: files, files: entries, totalBytes, manifestSha256, treeSha256 } = inputs;
  const manifest = Object.freeze({
    schemaVersion: 1,
    artifactType: 'cnyos-staging-function-inputs',
    source,
    fileCount: entries.length,
    totalBytes,
    files: entries,
    manifestDigestAlgorithm: 'sha256',
    manifestDigestEncoding: 'utf8-json-stringify-files-array-v1',
    manifestSha256,
    treeDigestAlgorithm: 'sha256',
    treeDigestDomain: FUNCTION_TREE_DIGEST_DOMAIN,
    treeDigestEncoding: FUNCTION_TREE_DIGEST_FORMAT,
    treeSha256,
    overallSha256: treeSha256
  });

  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.dirname(manifestDestination), { recursive: true, mode: 0o755 });
  await assertNoSymlinkAncestors(repository, path.dirname(output), 'STAGING_FUNCTION_OUTPUT');
  await assertNoSymlinkAncestors(repository, path.dirname(manifestDestination), 'STAGING_FUNCTION_MANIFEST');

  const temporaryOutput = await fs.mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.tmp-`));
  const temporaryManifest = path.join(
    path.dirname(manifestDestination),
    `.${path.basename(manifestDestination)}.tmp-${crypto.randomBytes(12).toString('hex')}`
  );
  let outputPublished = false;
  try {
    for (const file of files) {
      const destination = path.join(temporaryOutput, ...file.path.split('/'));
      if (!containsPath(temporaryOutput, destination)) fail('STAGING_FUNCTION_OUTPUT_PATH_ESCAPE', file.path);
      await writeExactFile(destination, file.content, file.mode);
    }
    await verifyClosedWorldOutput(temporaryOutput, files);
    await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    await fs.rename(temporaryOutput, output);
    outputPublished = true;
    await fs.rename(temporaryManifest, manifestDestination);
  } catch (error) {
    await fs.rm(temporaryOutput, { recursive: true, force: true }).catch(() => {});
    await fs.rm(temporaryManifest, { force: true }).catch(() => {});
    if (outputPublished) await fs.rm(output, { recursive: true, force: true }).catch(() => {});
    await fs.rm(manifestDestination, { force: true }).catch(() => {});
    throw error;
  }

  return manifest;
}

function parseArguments(argv) {
  const options = {};
  const valueArguments = new Map([
    ['--ref', 'ref'],
    ['--source-path', 'sourcePath'],
    ['--source-tree', 'sourceTreeObjectId'],
    ['--output', 'outputDirectory'],
    ['--manifest', 'manifestPath']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const key = valueArguments.get(name);
    if (!key || index + 1 >= argv.length) fail('STAGING_FUNCTION_ARGUMENT_INVALID', name);
    if (Object.hasOwn(options, key)) fail('STAGING_FUNCTION_ARGUMENT_DUPLICATE', name);
    options[key] = argv[index + 1];
    index += 1;
  }
  if (options.sourceTreeObjectId && (options.ref || options.sourcePath)) {
    fail('STAGING_FUNCTION_SOURCE_ARGUMENTS_CONFLICT');
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  materializeStagingFunctions(parseArguments(process.argv.slice(2)))
    .then(manifest => {
      process.stdout.write(`${manifest.overallSha256}\n`);
    })
    .catch(error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
