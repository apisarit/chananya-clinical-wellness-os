import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { SOURCE_PATHS, captureKnowledgeSourceCandidate, verifyKnowledgeSourceCandidate,
  writeKnowledgeSourceCandidate } from '../scripts/knowledge-source-candidate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const packet = await captureKnowledgeSourceCandidate(root);
assert.deepEqual(await captureKnowledgeSourceCandidate(root), packet, 'unchanged bytes have repeatable identity');
const result = verifyKnowledgeSourceCandidate(JSON.parse(JSON.stringify(packet)));
assert.equal(result.fileCount, SOURCE_PATHS.length);
assert.equal(result.reviewStatus, 'not_reviewed');
assert.equal(result.clinicalUse, false);
assert.equal(result.publicationAuthorized, false);
for (const file of packet.files) {
  assert.deepEqual(Buffer.from(file.base64, 'base64'), await fs.readFile(path.join(root, file.path)),
    'review packet retains actual bytes, not only mutable source locations');
}
const dkr = JSON.parse(gunzipSync(Buffer.from(packet.files[0].base64, 'base64')).toString('utf8'));
assert.ok(dkr.rules.every(rule => rule.review_status === 'review_required'), 'source flags are not upgraded by packaging');

function rejects(change, pattern) {
  const modified = structuredClone(packet);
  change(modified);
  assert.throws(() => verifyKnowledgeSourceCandidate(modified), pattern);
}
rejects(p => { p.clinicalUse = true; }, /NON_AUTHORIZING_ONLY/);
rejects(p => { p.reviewStatus = 'approved'; }, /NON_AUTHORIZING_ONLY/);
rejects(p => { p.approval = { reviewer: 'synthetic' }; }, /INVALID_SHAPE/);
rejects(p => { p.schema = 'future'; }, /NON_AUTHORIZING_ONLY/);
rejects(p => { p.files.pop(); }, /SOURCE_SET_MISMATCH/);
rejects(p => { p.files[1] = p.files[0]; }, /SOURCE_SET_MISMATCH/);
rejects(p => { p.files.reverse(); }, /SOURCE_SET_MISMATCH/);
rejects(p => { p.files[0].path = '../.env'; }, /SOURCE_SET_MISMATCH/);
rejects(p => { p.files[0].bytes = 0; }, /SIZE_LIMIT/);
rejects(p => { p.files[0].bytes = 4 * 1024 * 1024 + 1; }, /SIZE_LIMIT/);
rejects(p => { p.files[0].bytes = '10795'; }, /SIZE_LIMIT/);
rejects(p => { p.files[0].base64 += '\n'; }, /INVALID_ENCODING/);
rejects(p => { p.files[0].base64 = '!'.repeat(p.files[0].base64.length); }, /INVALID_ENCODING/);
rejects(p => { p.files[0].sha256 = '0'.repeat(64); }, /CONTENT_MISMATCH/);
rejects(p => { p.candidateId = '0'.repeat(64); }, /IDENTITY_MISMATCH/);
rejects(p => {
  const bytes = Buffer.from(p.files[1].base64, 'base64');
  bytes[0] ^= 1;
  p.files[1].base64 = bytes.toString('base64');
}, /CONTENT_MISMATCH/);
rejects(p => {
  const bytes = Buffer.from(p.files[1].base64, 'base64');
  bytes[0] ^= 1;
  p.files[1].base64 = bytes.toString('base64');
  p.files[1].sha256 = digest(bytes);
}, /IDENTITY_MISMATCH/);

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cnyos-knowledge-candidate-'));
try {
  for (const relative of SOURCE_PATHS) {
    await fs.mkdir(path.dirname(path.join(fixture, relative)), { recursive: true });
    // Deliberately not executable/parseable knowledge. The capture layer treats
    // bytes as data; semantic acceptance is a separate, still required stage.
    await fs.writeFile(path.join(fixture, relative), `throw new Error('SOURCE_EXECUTED'); // ${relative}\n`);
  }
  const first = await captureKnowledgeSourceCandidate(fixture);
  const target = path.join(fixture, 'review-packet.json');
  await writeKnowledgeSourceCandidate(first, target);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  const originalOutput = await fs.readFile(target);
  await fs.appendFile(path.join(fixture, SOURCE_PATHS[1]), '// revision B\n');
  const second = await captureKnowledgeSourceCandidate(fixture);
  assert.notEqual(first.candidateId, second.candidateId, 'changed source cannot reuse revision A identity');
  assert.equal(verifyKnowledgeSourceCandidate(first).publicationAuthorized, false);
  assert.equal(verifyKnowledgeSourceCandidate(second).publicationAuthorized, false);
  assert.equal(verifyKnowledgeSourceCandidate(JSON.parse(originalOutput)).candidateId, first.candidateId,
    'saved source remains verifiable after working files change');
  await assert.rejects(writeKnowledgeSourceCandidate(second, target), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(target), originalOutput, 'write refusal preserves existing review packet');
  const invalid = structuredClone(second);
  invalid.clinicalUse = true;
  const invalidTarget = path.join(fixture, 'invalid.json');
  await assert.rejects(writeKnowledgeSourceCandidate(invalid, invalidTarget), /NON_AUTHORIZING_ONLY/);
  await assert.rejects(fs.stat(invalidTarget), { code: 'ENOENT' });
  const firstPath = path.join(fixture, SOURCE_PATHS[0]);
  await fs.unlink(firstPath);
  await assert.rejects(captureKnowledgeSourceCandidate(fixture), { code: 'ENOENT' });
  await fs.symlink(target, firstPath);
  await assert.rejects(captureKnowledgeSourceCandidate(fixture), /SYMLINK_SOURCE/);
  await fs.unlink(firstPath);
  await fs.writeFile(firstPath, '');
  await assert.rejects(captureKnowledgeSourceCandidate(fixture), /SIZE_LIMIT/);
  await fs.writeFile(firstPath, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(captureKnowledgeSourceCandidate(fixture), /SIZE_LIMIT/);
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
console.log('Knowledge source candidate: exact bytes, stable identity, tamper/source-set rejection, retained snapshots and non-authorizing boundary passed.');
