import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'cnyos-knowledge-source-candidate/v1';
const PURPOSE = 'offline_source_review_only';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

// This is a deliberately bounded source packet, not a complete Foundation DB
// export, a Drive revision, or an executable/importable knowledge release.
export const SOURCE_PATHS = Object.freeze([
  'data/ttm/ttm-dkr-v1-complete-20260830.json.gz',
  'knowledge/u-synthesise/catalog.mjs',
  'knowledge/u-synthesise/classical.mjs',
  'knowledge/u-synthesise/engine.mjs',
  'knowledge/u-synthesise/landscape.mjs',
  'luopan-knowledge.js',
  'scripts/build-u-synthesise.mjs',
  'scripts/import-ttm-dkr-staging.mjs',
]);

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(`KNOWLEDGE_CANDIDATE_${code}`); };
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail('INVALID_SHAPE');
}

function descriptor(file) {
  return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
}

function identity(files) {
  // Fixed key and path ordering is part of this format. No wall clock or
  // unverified Git/Drive revision is used as a claim about the captured bytes.
  return hash(JSON.stringify({ schema: SCHEMA, purpose: PURPOSE,
    reviewStatus: 'not_reviewed', clinicalUse: false, files: files.map(descriptor) }));
}

export function verifyKnowledgeSourceCandidate(packet) {
  exactKeys(packet, ['schema', 'purpose', 'reviewStatus', 'clinicalUse', 'candidateId', 'files']);
  if (packet.schema !== SCHEMA || packet.purpose !== PURPOSE
      || packet.reviewStatus !== 'not_reviewed' || packet.clinicalUse !== false) fail('NON_AUTHORIZING_ONLY');
  if (!Array.isArray(packet.files) || packet.files.length !== SOURCE_PATHS.length) fail('SOURCE_SET_MISMATCH');
  let total = 0;
  for (const [index, file] of packet.files.entries()) {
    exactKeys(file, ['path', 'bytes', 'sha256', 'base64']);
    if (file.path !== SOURCE_PATHS[index]) fail('SOURCE_SET_MISMATCH');
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_FILE_BYTES) fail('SIZE_LIMIT');
    total += file.bytes;
    if (total > MAX_TOTAL_BYTES) fail('SIZE_LIMIT');
    if (typeof file.base64 !== 'string' || file.base64.length !== 4 * Math.ceil(file.bytes / 3)) fail('INVALID_ENCODING');
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length !== file.bytes || bytes.toString('base64') !== file.base64) fail('INVALID_ENCODING');
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
        || hash(bytes) !== file.sha256) fail('CONTENT_MISMATCH');
  }
  if (packet.candidateId !== identity(packet.files)) fail('IDENTITY_MISMATCH');
  // A successful return certifies byte integrity only. It must never be used
  // as a reviewer decision, clinical authorization, or publication gate.
  return Object.freeze({ candidateId: packet.candidateId, integrity: 'verified',
    reviewStatus: 'not_reviewed', clinicalUse: false, publicationAuthorized: false,
    fileCount: packet.files.length, totalBytes: total });
}

export async function captureKnowledgeSourceCandidate(cwd = root) {
  const base = await fs.realpath(cwd);
  const files = [];
  for (const relative of SOURCE_PATHS) {
    const target = path.join(base, relative);
    // Do not follow source symlinks to unrelated files or credentials.
    if (await fs.realpath(target) !== target) fail('SYMLINK_SOURCE');
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) fail('SIZE_LIMIT');
      // Bounded read even if the file grows after stat. One extra byte detects
      // growth past the limit without allocating an unbounded readFile buffer.
      const chunks = [];
      let size = 0;
      while (size <= MAX_FILE_BYTES) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - size));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead));
        size += bytesRead;
      }
      if (size > MAX_FILE_BYTES) fail('SIZE_LIMIT');
      const bytes = Buffer.concat(chunks);
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') });
    } finally { await handle.close(); }
  }
  const packet = { schema: SCHEMA, purpose: PURPOSE, reviewStatus: 'not_reviewed',
    clinicalUse: false, candidateId: identity(files), files };
  verifyKnowledgeSourceCandidate(packet);
  return packet;
}

export async function writeKnowledgeSourceCandidate(packet, target) {
  verifyKnowledgeSourceCandidate(packet);
  // No overwrite: an older review packet must not be silently replaced.
  await fs.writeFile(target, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--output') {
    throw new Error('Usage: node scripts/knowledge-source-candidate.mjs --output <new-file.json>');
  }
  const packet = await captureKnowledgeSourceCandidate();
  await writeKnowledgeSourceCandidate(packet, path.resolve(process.argv[3]));
  console.log(JSON.stringify(verifyKnowledgeSourceCandidate(packet)));
}
