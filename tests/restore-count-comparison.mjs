import assert from 'node:assert/strict';
import { compareRestoreCounts, compareRestoreHashes } from '../scripts/restore-count-comparison.mjs';

const bindings = { invoices: ['transactions', 'invoices'] };
const source = count => ({ domains: { transactions: { row_counts: { invoices: count } } } });
for (const count of [0, 1, 42]) {
  assert.deepEqual(compareRestoreCounts(source(count), { invoices: count }, bindings),
    { invoices: { expected: count, actual: count } });
}
for (const invalid of [undefined, null, '', '0', false, true, [], {}, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => compareRestoreCounts(source(0), { invoices: invalid }, bindings),
    /restored count missing or invalid/);
  assert.throws(() => compareRestoreCounts(source(invalid), { invoices: 0 }, bindings),
    /source count missing or invalid/);
}
assert.throws(() => compareRestoreCounts(source(0), undefined, bindings), /restored count missing/);
assert.throws(() => compareRestoreCounts({}, { invoices: 0 }, bindings), /source count missing/);
assert.throws(() => compareRestoreCounts(source(2), { invoices: 1 }, bindings), /does not equal/);
console.log('Restore count evidence: explicit integer zero accepted; missing, coerced and mismatched counts rejected');

const hash = 'a'.repeat(64);
const hashSource = { domains: { transactions: { table_sha256: { invoices: hash } } } };
const hashBindings = { transactions: ['invoices'] };
assert.deepEqual(compareRestoreHashes(hashSource, { invoices: hash }, hashBindings),
  { invoices: { expected: hash, actual: hash } });
for (const invalid of [undefined, null, '', 0, 'a'.repeat(63), 'A'.repeat(64), []]) {
  assert.throws(() => compareRestoreHashes(hashSource, { invoices: invalid }, hashBindings), /restored hash missing/);
}
assert.throws(() => compareRestoreHashes({}, { invoices: hash }, hashBindings), /source hash missing/);
assert.throws(() => compareRestoreHashes(hashSource, { invoices: 'b'.repeat(64) }, hashBindings), /content hash mismatch/);
console.log('Restore financial content: matching SHA256 required; equal row counts cannot hide changed content');
