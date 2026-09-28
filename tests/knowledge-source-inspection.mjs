import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { captureKnowledgeSourceCandidate, writeKnowledgeSourceCandidate } from '../scripts/knowledge-source-candidate.mjs';
import { inspectKnowledgeCandidate } from '../scripts/inspect-knowledge-candidate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packet = await captureKnowledgeSourceCandidate(root);
const data = JSON.parse(gunzipSync(Buffer.from(packet.files[0].base64, 'base64')));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function packetWithBytes(bytes) {
  const copy = structuredClone(packet);
  copy.files[0] = { path: copy.files[0].path, bytes: bytes.length, sha256: digest(bytes), base64: bytes.toString('base64') };
  copy.candidateId = digest(JSON.stringify({ schema: copy.schema, purpose: copy.purpose,
    reviewStatus: copy.reviewStatus, clinicalUse: copy.clinicalUse,
    files: copy.files.map(({ path: sourcePath, bytes, sha256 }) => ({ path: sourcePath, bytes, sha256 })) }));
  return copy;
}
function changed(mutator) {
  const copy = structuredClone(data);
  mutator(copy);
  return packetWithBytes(gzipSync(JSON.stringify(copy)));
}
function blocked(mutator, reason, { source = false } = {}) {
  const report = inspectKnowledgeCandidate(changed(mutator));
  assert.equal(report.readiness, 'blocked');
  assert.equal(report.publicationAuthorized, false);
  assert.equal(report.clinicalUse, false);
  assert.ok(source ? report.sourceIssues.includes(reason)
    : report.rejectedRows.some(row => row.reasons.includes(reason)), reason);
  return report;
}

const original = JSON.stringify(packet);
const good = inspectKnowledgeCandidate(packet);
assert.equal(good.readiness, 'ready_for_source_review');
assert.equal(good.structurallyValidRows.length, 113);
assert.deepEqual(good.rejectedRows, []);
assert.deepEqual(good.sourceIssues, []);
assert.equal(good.matchesArchivedBaseline, true);
assert.equal(good.workbookVerified, false);
assert.equal(good.publicationAuthorized, false);
assert.equal(good.clinicalUse, false);
assert.equal(good.candidateId, packet.candidateId);
assert.deepEqual(good.structurallyValidRows.map(row => row.content), data.rules);
assert.equal(JSON.stringify(packet), original, 'inspection must not mutate the captured evidence');

blocked(d => { d.rules[0].source_ref = ''; }, 'REQUIRED_TEXT:source_ref');
blocked(d => { d.rules[0].review_status = 'approved'; }, 'REVIEW_STATE_NOT_SUPPORTED_BY_SOURCE_IMPORT');
blocked(d => { d.rules[0].metadata.clinical_inference_allowed = true; }, 'METADATA_UNSUPPORTED');
blocked(d => { d.rules[0].domain = 'unknown'; }, 'DOMAIN_UNSUPPORTED');
blocked(d => { d.rules[0].sheet_row = '3'; }, 'SHEET_ROW_INVALID');
blocked(d => { d.rules[0].active = 'true'; }, 'ACTIVE_FLAG_INVALID');
blocked(d => { d.rules[0].metadata.proportions = { unknown: 1 }; }, 'PROPORTIONS_INVALID');
blocked(d => { d.rules[0].metadata.proportions = { 'ปิตตะ': '2' }; }, 'PROPORTIONS_INVALID');
blocked(d => { d.rules[0].extra = 'silently dropped data'; }, 'ROW_SHAPE_UNSUPPORTED');
blocked(d => { d.rules[0] = null; }, 'ROW_SHAPE_UNSUPPORTED');
blocked(d => { d.dataset_version = 'new-unsupported-format'; }, 'DATASET_VERSION_UNSUPPORTED', { source: true });
blocked(d => { d.source.citation = ''; }, 'SOURCE_PROVENANCE_OR_REVIEW_INVALID', { source: true });
blocked(d => { d.source.metadata.clinical_use = 'approved'; }, 'SOURCE_PROVENANCE_OR_REVIEW_INVALID', { source: true });
blocked(d => { d.safety.context_is_not_diagnosis = false; }, 'SAFETY_DECLARATION_INVALID', { source: true });
blocked(d => { d.summary.rules++; }, 'DECLARED_ROW_COUNT_MISMATCH', { source: true });
blocked(d => { d.summary.domain_counts.constitution++; }, 'SUMMARY_MISMATCH:domain_counts', { source: true });
blocked(d => { d.body_model.groups[0].target_count = -1; }, 'BODY_MODEL_REVIEW_INVALID', { source: true });
blocked(d => { d.body_model.groups[1] = d.body_model.groups[0]; }, 'BODY_MODEL_REVIEW_INVALID', { source: true });

for (const [name, mutate] of [
  ['CONCEPT_CODE', d => { d.rules[1].concept_code = d.rules[0].concept_code; }],
  ['RULE_IDENTITY', d => { for (const key of ['domain', 'rule_key', 'input_key', 'version']) d.rules[1][key] = d.rules[0][key]; }],
  ['SOURCE_LOCATION', d => { d.rules[1].sheet_name = d.rules[0].sheet_name; d.rules[1].sheet_row = d.rules[0].sheet_row; }],
]) {
  const report = blocked(mutate, `DUPLICATE_${name}`);
  assert.deepEqual(report.rejectedRows.filter(row => row.reasons.includes(`DUPLICATE_${name}`)).map(row => row.index), [0, 1]);
}
for (const bytes of [Buffer.from('not gzip'), gzipSync(Buffer.from('{invalid json')),
  gzipSync(Buffer.from([0xff, 0xfe])), gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 32))]) {
  const report = inspectKnowledgeCandidate(packetWithBytes(bytes));
  assert.equal(report.readiness, 'blocked');
  assert.deepEqual(report.sourceIssues, ['ARCHIVE_DECODE_FAILED_OR_LIMIT_EXCEEDED']);
  assert.deepEqual(report.structurallyValidRows, []);
}
const altered = changed(d => { d.rules[0].description = 'Synthetic proposed revision; not clinical approval'; });
const proposed = inspectKnowledgeCandidate(altered);
assert.notEqual(proposed.candidateId, good.candidateId);
assert.notEqual(proposed.structurallyValidRows[0].rowSHA256, good.structurallyValidRows[0].rowSHA256);
assert.equal(proposed.matchesArchivedBaseline, false);
assert.equal(proposed.readiness, 'ready_for_source_review');
assert.equal(proposed.publicationAuthorized, false);
const reordered = inspectKnowledgeCandidate(changed(d => { d.rules[0] = Object.fromEntries(Object.entries(d.rules[0]).reverse()); }));
assert.equal(reordered.structurallyValidRows[0].rowSHA256, good.structurallyValidRows[0].rowSHA256);
const tampered = structuredClone(packet);
tampered.files[0].sha256 = '0'.repeat(64);
assert.throws(() => inspectKnowledgeCandidate(tampered), /CONTENT_MISMATCH/);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cnyos-knowledge-inspect-'));
try {
  const input = path.join(temp, 'input.json');
  const output = path.join(temp, 'report.json');
  await writeKnowledgeSourceCandidate(packet, input);
  const script = path.join(root, 'scripts/inspect-knowledge-candidate.mjs');
  const args = [script, '--input', input, '--output', output];
  const summary = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  assert.equal(summary.validRows, 113);
  assert.equal(summary.publicationAuthorized, false);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), good);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), error => error.status === 1);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), good, 'existing report must not be overwritten');
  const badInput = path.join(temp, 'rejected-input.json');
  const badOutput = path.join(temp, 'rejected-report.json');
  await writeKnowledgeSourceCandidate(changed(d => { d.rules[0].source_ref = ''; }), badInput);
  assert.throws(() => execFileSync(process.execPath, [script, '--input', badInput, '--output', badOutput], { stdio: 'pipe' }),
    error => error.status === 1);
  const rejected = JSON.parse(await fs.readFile(badOutput, 'utf8'));
  assert.equal(rejected.readiness, 'blocked');
  assert.deepEqual(rejected.rejectedRows[0], { index: 0, sheet: data.rules[0].sheet_name,
    row: data.rules[0].sheet_row, reasons: ['REQUIRED_TEXT:source_ref'] });
} finally { await fs.rm(temp, { recursive: true, force: true }); }
console.log('Knowledge inspection passed: 113 source rows retained; explicit rejected rows, duplicate groups, provenance/summary checks, bounded decoding, CLI readback and non-authorization.');
