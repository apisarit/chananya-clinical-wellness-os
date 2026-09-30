const DATASET_COLUMNS = Object.freeze({
  patients: Object.freeze([
    'id', 'clinic_id', 'hn', 'prefix', 'first_name', 'last_name', 'gender',
    'date_of_birth', 'phone', 'email', 'active', 'created_at', 'updated_at'
  ]),
  encounters: Object.freeze([
    'id', 'clinic_id', 'encounter_no', 'patient_id', 'encounter_type', 'status',
    'started_at', 'completed_at', 'chief_complaint', 'thai_diagnosis',
    'practitioner_id', 'created_at', 'updated_at'
  ]),
  ttm_diagnostic_knowledge: Object.freeze([
    'id', 'domain', 'rule_key', 'input_key', 'output_value', 'element', 'samutthan',
    'coordinate', 'description', 'source_ref', 'source_class', 'review_status',
    'version', 'active'
  ]),
  audit_logs: Object.freeze([
    'id', 'occurred_at', 'user_id', 'action', 'entity', 'entity_id'
  ])
});

const DATASETS = new Set(Object.keys(DATASET_COLUMNS));
const ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/i;
const FORMULA_PREFIX = /^[=+\-@]/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function allowedDataset(value) {
  return typeof value === 'string' && DATASETS.has(value);
}

export function selectedExportHeaders(dataset) {
  if (!allowedDataset(dataset)) fail('SELECTED_EXPORT_DATASET_INVALID');
  return [...DATASET_COLUMNS[dataset]];
}

export function normalizeSelectedExportRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('SELECTED_EXPORT_REQUEST_INVALID');
  const dataset = typeof input.dataset === 'string' ? input.dataset.trim() : '';
  if (!allowedDataset(dataset)) fail('SELECTED_EXPORT_DATASET_INVALID');
  const format = typeof input.format === 'string' ? input.format.trim().toLowerCase() : '';
  if (!['csv', 'json'].includes(format)) fail('SELECTED_EXPORT_FORMAT_INVALID');
  if (!Array.isArray(input.selectedIds) || input.selectedIds.length < 1 || input.selectedIds.length > 100) {
    fail('SELECTED_EXPORT_IDS_INVALID');
  }
  const selectedIds = input.selectedIds.map(value => {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('SELECTED_EXPORT_ID_INVALID');
    return value;
  });
  if (new Set(selectedIds).size !== selectedIds.length) fail('SELECTED_EXPORT_IDS_DUPLICATE');
  if (Object.keys(input).some(key => !['dataset', 'format', 'selectedIds'].includes(key))) {
    fail('SELECTED_EXPORT_FIELD_INVALID');
  }
  return Object.freeze({ dataset, format, selectedIds: Object.freeze(selectedIds) });
}

function cellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function csvCell(value) {
  let text = cellValue(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function projectSelectedRow(dataset, row) {
  if (!allowedDataset(dataset) || !row || typeof row !== 'object' || Array.isArray(row)) {
    fail('SELECTED_EXPORT_ROW_INVALID');
  }
  const columns = DATASET_COLUMNS[dataset];
  return Object.fromEntries(columns.map(column => [column, row[column] ?? null]));
}

export function buildCsv(rows, columns) {
  if (!Array.isArray(rows) || !Array.isArray(columns) || columns.length === 0
    || columns.some(column => typeof column !== 'string')) {
    fail('SELECTED_EXPORT_COLUMNS_INVALID');
  }
  const unique = new Set(columns);
  const known = new Set(Object.values(DATASET_COLUMNS).flat());
  if (unique.size !== columns.length || columns.some(column => !known.has(column))) {
    fail('SELECTED_EXPORT_COLUMNS_INVALID');
  }
  const header = columns.map(csvCell).join(',');
  const body = rows.map(row => columns.map(column => csvCell(row?.[column])).join(','));
  return `${[header, ...body].join('\r\n')}\r\n`;
}

export const selectedExportDatasets = Object.freeze([...DATASETS]);
