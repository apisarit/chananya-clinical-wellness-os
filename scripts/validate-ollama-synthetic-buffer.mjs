import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PATH = path.resolve('tests/fixtures/ollama-synthetic-buffer.json');
const filePath = path.resolve(process.env.SYNTHETIC_BUFFER_PATH || DEFAULT_PATH);
const allowedChannels = new Set(['qr', 'cash', 'bank_transfer', 'card']);
const requiredKeys = [
  'id', 'prefix', 'first', 'last', 'gender', 'dob', 'symptom', 'diagnosis',
  'dosha', 'product', 'qty', 'price', 'serviceFee', 'discount', 'channel'
];

function readBuffer() {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(value.schemaVersion, 1, 'synthetic buffer schema version must be 1');
  assert.equal(value.editable, true, 'synthetic buffer must remain editable');
  assert.equal(value.deletable, true, 'synthetic buffer must remain deletable');
  assert.equal(value.stagingOnly, true, 'synthetic buffer must be staging-only');
  assert.equal(value.productionImportable, false, 'synthetic buffer must never be production-importable');
  assert.match(value.purpose, /isolated staging tests only/i);
  assert.equal(value.source?.provider, 'ollama-local');
  assert.equal(value.source?.network, 'loopback-only');
  assert.ok(Array.isArray(value.cases), 'synthetic buffer cases must be an array');
  assert.ok(value.cases.length <= 5, 'synthetic buffer cannot contain more than five cases');
  return value;
}

function validateCases(value) {
  const seen = new Set();
  for (const [index, item] of value.cases.entries()) {
    assert.deepEqual(Object.keys(item).sort(), [...requiredKeys].sort(), `${item.id}: unexpected fields`);
    assert.match(item.id, /^TEST-00[1-5]$/u, `${item.id}: unexpected test ID`);
    assert.ok(!seen.has(item.id), `${item.id}: duplicate test ID`);
    seen.add(item.id);
    assert.ok(index === 0 || item.id > value.cases[index - 1].id, `${item.id}: IDs must be ordered`);
    assert.match(item.first, /สาธิต/u, `${item.id}: first name must be synthetic`);
    assert.match(item.last, /กรณี/u, `${item.id}: last name must be synthetic`);
    assert.match(item.symptom, /staging-only not-for-clinical-use/i);
    assert.match(item.diagnosis, /ข้อมูลสาธิต/u);
    assert.match(item.product, /ข้อมูลสาธิต/u);
    assert.match(item.diagnosis, /ไม่ใช่คำแนะนำทางคลินิก/u);
    assert.match(item.product, /ห้ามใช้รักษาจริง/u);
    assert.match(item.dob, /^199[0-4]-\d{2}-\d{2}$/u);
    for (const field of ['first', 'last', 'symptom', 'diagnosis', 'dosha', 'product']) {
      assert.doesNotMatch(item[field], /@|\b(?:email|phone|national[_ -]?id|patient[_ -]?id|uuid)\b/i, `${item.id}: personal identifier in ${field}`);
    }
    assert.ok(Number.isInteger(item.qty) && item.qty >= 1 && item.qty <= 3, `${item.id}: qty out of range`);
    for (const field of ['price', 'serviceFee', 'discount']) {
      assert.equal(typeof item[field], 'number', `${item.id}: ${field} must be numeric`);
      assert.ok(Number.isFinite(item[field]) && item[field] >= 0, `${item.id}: ${field} must be non-negative`);
    }
    assert.ok(item.discount <= item.serviceFee, `${item.id}: discount exceeds service fee`);
    assert.ok(allowedChannels.has(item.channel), `${item.id}: invalid payment channel`);
  }
}

function writeBuffer(value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const [, , command = 'check', requestedId] = process.argv;
if (command === 'check') {
  const value = readBuffer();
  validateCases(value);
  console.log(`Ollama synthetic buffer valid: ${value.cases.length} cases (${filePath})`);
} else if (command === 'list') {
  const value = readBuffer();
  validateCases(value);
  for (const item of value.cases) console.log(`${item.id}\t${item.first} ${item.last}`);
} else if (command === 'remove') {
  assert.match(requestedId || '', /^TEST-00[1-5]$/u, 'remove requires TEST-001 through TEST-005');
  assert.equal(process.env.SYNTHETIC_BUFFER_DELETE_ACK, 'DELETE_SYNTHETIC_BUFFER', 'set SYNTHETIC_BUFFER_DELETE_ACK=DELETE_SYNTHETIC_BUFFER to remove a case');
  const value = readBuffer();
  validateCases(value);
  const remaining = value.cases.filter(item => item.id !== requestedId);
  assert.equal(remaining.length, value.cases.length - 1, `${requestedId}: case not found`);
  value.cases = remaining;
  writeBuffer(value);
  console.log(`Removed ${requestedId} from synthetic buffer; ${remaining.length} cases remain`);
} else if (command === 'clear') {
  assert.equal(process.env.SYNTHETIC_BUFFER_DELETE_ACK, 'DELETE_SYNTHETIC_BUFFER', 'set SYNTHETIC_BUFFER_DELETE_ACK=DELETE_SYNTHETIC_BUFFER to clear the buffer');
  const value = readBuffer();
  value.cases = [];
  writeBuffer(value);
  console.log('Cleared synthetic buffer cases');
} else {
  throw new Error(`Unknown command ${command}; use check, list, remove TEST-001, or clear`);
}
