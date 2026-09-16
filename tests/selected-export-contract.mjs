import assert from 'node:assert/strict';
import {
  allowedDataset, buildCsv, normalizeSelectedExportRequest,
  projectSelectedRow, selectedExportHeaders
} from '../netlify/functions/_shared/selected-export.mjs';

assert.equal(allowedDataset('patients'), true);
assert.equal(allowedDataset('users'), false);
assert.deepEqual(normalizeSelectedExportRequest({
  dataset: 'patients', format: 'CSV', selectedIds: ['11111111-1111-4111-8111-111111111111']
}), {
  dataset: 'patients', format: 'csv', selectedIds: ['11111111-1111-4111-8111-111111111111']
});

assert.throws(() => normalizeSelectedExportRequest({
  dataset: 'patients', format: 'csv', selectedIds: ['x', 'x']
}), error => error.code === 'SELECTED_EXPORT_IDS_DUPLICATE');
assert.throws(() => normalizeSelectedExportRequest({
  dataset: 'patients', format: 'csv', selectedIds: ['11111111-1111-4111-8111-111111111111'], destination: 'nas'
}), error => error.code === 'SELECTED_EXPORT_FIELD_INVALID');
assert.throws(() => normalizeSelectedExportRequest({
  dataset: 'patients', format: 'xlsx', selectedIds: ['11111111-1111-4111-8111-111111111111']
}), error => error.code === 'SELECTED_EXPORT_FORMAT_INVALID');
assert.throws(() => normalizeSelectedExportRequest({
  dataset: 'patients', format: 'csv', selectedIds: Array.from({ length: 101 }, (_, i) => `id-${i}`)
}), error => error.code === 'SELECTED_EXPORT_IDS_INVALID');

const patientColumns = selectedExportHeaders('patients');
assert.equal(patientColumns.includes('national_id'), false, 'national ID must not be exported by default');
assert.deepEqual(projectSelectedRow('patients', { id: 'p1', hn: 'HN1', national_id: 'secret', first_name: 'A' }), {
  id: 'p1', clinic_id: null, hn: 'HN1', prefix: null, first_name: 'A', last_name: null,
  gender: null, date_of_birth: null, phone: null, email: null, active: null, created_at: null, updated_at: null
});

const csv = buildCsv([
  { id: 'p1', hn: '=2+2', first_name: 'A, B', last_name: 'line\nname' }
], ['id', 'hn', 'first_name', 'last_name']);
assert.equal(csv, 'id,hn,first_name,last_name\r\np1,\'=2+2,"A, B","line\nname"\r\n');
assert.throws(() => buildCsv([], ['id', 'secret_column']), error => error.code === 'SELECTED_EXPORT_COLUMNS_INVALID');

console.log('Selected export contract passed: allowlist, selected IDs, fixed columns and CSV safety');
