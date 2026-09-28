import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { verifyKnowledgeSourceCandidate } from './knowledge-source-candidate.mjs';

export const DKR_REVIEW_PARSER = 'dkr-source-review/1';
const ARCHIVE_PATH = 'data/ttm/ttm-dkr-v1-complete-20260830.json.gz';
const BASELINE_SHA = '40fd0877c4a46bc5d8f4412e2058f096c7c82a4f64d2bf8343399288a035477a';
const VERSION = 'TTM-DKR-v1-complete-20260830';
const DOMAINS = new Set(['constitution', 'conception_month', 'birth_weekday', 'coordinate',
  'age_samutthan', 'kala_samutthan', 'kala_ekadot', 'kala_duvandot', 'kala_tridot',
  'season_4', 'season_6', 'season_pitsadan', 'zodiac_samutthan', 'pradesa_samutthan', 'food_taste']);
const ROW_KEYS = ['domain', 'rule_key', 'input_key', 'output_value', 'element', 'samutthan',
  'coordinate', 'description', 'source_ref', 'source_class', 'sheet_name', 'sheet_row',
  'metadata', 'review_status', 'version', 'active', 'concept_code'];
const META_KEYS = new Set(['input_type', 'color_code', 'alternate_name', 'strength', 'day_range',
  'night_range', 'proportions', 'season', 'sequence', 'mixed_coordinate', 'dhatu_state', 'tastes']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 32768;
const exactKeys = (value, keys) => object(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function validJson(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 32768;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => validJson(item, depth + 1));
  return object(value) && Object.keys(value).length <= 1000
    && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key)
      && validJson(item, depth + 1));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function inspectKnowledgeCandidate(packet) {
  verifyKnowledgeSourceCandidate(packet);
  const file = packet.files.find(entry => entry.path === ARCHIVE_PATH);
  const report = {
    schema: 'cnyos-knowledge-source-review/v1', parserVersion: DKR_REVIEW_PARSER,
    candidateId: packet.candidateId, archivePath: ARCHIVE_PATH, archiveSHA256: file.sha256,
    matchesArchivedBaseline: file.sha256 === BASELINE_SHA,
    reviewStatus: 'not_reviewed', clinicalUse: false, publicationAuthorized: false,
    readiness: 'blocked', datasetVersion: null, citation: null, claimedWorkbookSHA256: null,
    workbookVerified: false, sourceIssues: [], structurallyValidRows: [], rejectedRows: [],
    limitations: ['No Drive revision authentication', 'No source-license or clinical validation',
      'Referenced pages and external concepts are not resolved by this offline parser',
      'U Synthesize JavaScript is retained but not executed or semantically validated'],
  };
  let data;
  try {
    const raw = gunzipSync(Buffer.from(file.base64, 'base64'), { maxOutputLength: 2 * 1024 * 1024 });
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    report.sourceIssues.push('ARCHIVE_DECODE_FAILED_OR_LIMIT_EXCEEDED');
    return report;
  }
  if (!exactKeys(data, ['dataset_version', 'source', 'body_model', 'summary', 'safety', 'rules'])) {
    report.sourceIssues.push('DATASET_SHAPE_UNSUPPORTED');
  }
  if (!object(data)) return report;
  if (data.dataset_version !== VERSION) report.sourceIssues.push('DATASET_VERSION_UNSUPPORTED');
  report.datasetVersion = text(data.dataset_version) ? data.dataset_version : null;
  const source = data.source;
  if (!exactKeys(source, ['source_code', 'title_th', 'title_en', 'source_type', 'citation', 'provenance', 'review_status', 'version', 'metadata'])
      || !validJson(source) || source.source_code !== 'TTM-DKR-v1' || source.review_status !== 'review_required'
      || source.version !== '1' || source.source_type !== 'owner_dataset' || source.provenance !== 'source_derived'
      || !text(source.title_th) || !text(source.title_en) || !text(source.citation)
      || !exactKeys(source.metadata, ['workbook_sha256', 'workbook_rule_count', 'workbook_sheet_count', 'clinical_use', 'import_revision'])
      || source.metadata.clinical_use !== 'context_only_pending_practitioner_review'
      || !Number.isSafeInteger(source.metadata.workbook_sheet_count) || source.metadata.workbook_sheet_count < 1
      || !text(source.metadata.import_revision)
      || !/^[a-f0-9]{64}$/.test(source.metadata.workbook_sha256 || '')) {
    report.sourceIssues.push('SOURCE_PROVENANCE_OR_REVIEW_INVALID');
  } else {
    report.citation = source.citation;
    report.claimedWorkbookSHA256 = source.metadata.workbook_sha256;
  }
  const safety = data.safety;
  if (!exactKeys(safety, ['context_is_not_diagnosis', 'unapproved_rules_do_not_score_clinical_hypotheses',
    'practitioner_confirmation_required', 'icd_who_mapping']) || safety.context_is_not_diagnosis !== true
      || safety.unapproved_rules_do_not_score_clinical_hypotheses !== true
      || safety.practitioner_confirmation_required !== true || safety.icd_who_mapping !== 'secondary_only') {
    report.sourceIssues.push('SAFETY_DECLARATION_INVALID');
  }
  const body = data.body_model;
  if (!exactKeys(body, ['source_code', 'version', 'review_status', 'member_policy', 'groups'])
      || !validJson(body) || body.review_status !== 'review_required' || !text(body.member_policy)
      || !text(body.source_code) || !text(body.version) || !Array.isArray(body.groups) || !body.groups.length
      || body.groups.some(group => !exactKeys(group, ['code', 'label', 'target_count', 'anchor_code', 'anchor_version'])
        || !['code', 'label', 'anchor_code', 'anchor_version'].every(key => text(group[key]))
        || !Number.isSafeInteger(group.target_count) || group.target_count <= 0)
      || new Set(body.groups.map(group => group.code)).size !== body.groups.length) {
    report.sourceIssues.push('BODY_MODEL_REVIEW_INVALID');
  } else if (body.groups.reduce((sum, group) => sum + group.target_count, 0) !== data.summary?.body_group_targets) {
    report.sourceIssues.push('BODY_TARGET_SUMMARY_MISMATCH');
  }
  if (!Array.isArray(data.rules) || !data.rules.length || data.rules.length > 5000) {
    report.sourceIssues.push('RULE_LIST_INVALID_OR_LIMIT_EXCEEDED');
    return report;
  }
  if (data.summary?.rules !== data.rules.length || source?.metadata?.workbook_rule_count !== data.rules.length) {
    report.sourceIssues.push('DECLARED_ROW_COUNT_MISMATCH');
  }
  for (const [field, summaryKey] of [['domain', 'domain_counts'], ['source_class', 'source_class_counts']]) {
    const counts = new Map();
    for (const row of data.rules) {
      if (typeof row?.[field] === 'string') counts.set(row[field], (counts.get(row[field]) || 0) + 1);
    }
    if (!object(data.summary?.[summaryKey]) || !validJson(data.summary[summaryKey])
        || JSON.stringify(canonical(data.summary[summaryKey])) !== JSON.stringify(canonical(Object.fromEntries(counts)))) {
      report.sourceIssues.push(`SUMMARY_MISMATCH:${summaryKey}`);
    }
  }
  const candidates = data.rules.map((row, index) => ({ row, index, issues: [] }));
  for (const entry of candidates) {
    const { row, issues } = entry;
    if (!exactKeys(row, ROW_KEYS)) issues.push('ROW_SHAPE_UNSUPPORTED');
    if (!object(row)) continue;
    for (const key of ['rule_key', 'input_key', 'output_value', 'source_ref', 'sheet_name']) {
      if (!text(row[key])) issues.push(`REQUIRED_TEXT:${key}`);
    }
    for (const key of ['element', 'samutthan', 'coordinate', 'description']) {
      if (row[key] !== null && !text(row[key])) issues.push(`OPTIONAL_TEXT_INVALID:${key}`);
    }
    if (!DOMAINS.has(row.domain)) issues.push('DOMAIN_UNSUPPORTED');
    if (!['source_derived', 'image_transcribed'].includes(row.source_class)) issues.push('SOURCE_CLASS_UNSUPPORTED');
    if (!Number.isSafeInteger(row.sheet_row) || row.sheet_row < 1) issues.push('SHEET_ROW_INVALID');
    if (row.version !== 'TTM-DKR-v1') issues.push('ROW_VERSION_UNSUPPORTED');
    if (row.review_status !== 'review_required') issues.push('REVIEW_STATE_NOT_SUPPORTED_BY_SOURCE_IMPORT');
    if (typeof row.active !== 'boolean') issues.push('ACTIVE_FLAG_INVALID');
    if (typeof row.concept_code !== 'string' || !/^legacy-rule\.[a-f0-9]{64}$/.test(row.concept_code)) issues.push('CONCEPT_CODE_INVALID');
    if (!object(row.metadata) || !validJson(row.metadata)
        || Object.keys(row.metadata).some(key => !META_KEYS.has(key))) issues.push('METADATA_UNSUPPORTED');
    const weights = row.metadata?.proportions;
    if (weights !== undefined && (!object(weights) || !Object.keys(weights).length
        || Object.entries(weights).some(([axis, weight]) => !['ปิตตะ', 'วาตะ', 'เสมหะ'].includes(axis)
          || typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0))) issues.push('PROPORTIONS_INVALID');
  }
  // Reject every member of a duplicate set, not merely the second occurrence.
  for (const [name, keyOf] of [
    ['CONCEPT_CODE', row => text(row.concept_code) ? row.concept_code : null],
    ['RULE_IDENTITY', row => ['domain', 'rule_key', 'input_key', 'version'].every(key => text(row[key]))
      ? JSON.stringify([row.domain, row.rule_key, row.input_key, row.version]) : null],
    ['SOURCE_LOCATION', row => text(row.sheet_name) && Number.isSafeInteger(row.sheet_row)
      ? JSON.stringify([row.sheet_name, row.sheet_row]) : null],
  ]) {
    const groups = new Map();
    for (const entry of candidates) {
      const key = object(entry.row) ? keyOf(entry.row) : null;
      if (key !== null) groups.set(key, [...(groups.get(key) || []), entry]);
    }
    for (const group of groups.values()) if (group.length > 1) {
      for (const entry of group) entry.issues.push(`DUPLICATE_${name}`);
    }
  }
  for (const { row, index, issues } of candidates) {
    const locator = { index, sheet: text(row?.sheet_name) ? row.sheet_name : null,
      row: Number.isSafeInteger(row?.sheet_row) ? row.sheet_row : null };
    if (issues.length) report.rejectedRows.push({ ...locator, reasons: issues });
    else report.structurallyValidRows.push({ ...locator, rowSHA256: sha(JSON.stringify(canonical(row))),
      content: row, reviewStatus: 'not_reviewed', clinicalUse: false });
  }
  if (!report.sourceIssues.length && !report.rejectedRows.length) report.readiness = 'ready_for_source_review';
  return report;
}

export async function readKnowledgeCandidateFile(filename) {
  const input = await fs.open(path.resolve(filename), 'r');
  let packet;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size > 24 * 1024 * 1024) throw new Error('KNOWLEDGE_PACKET_INPUT_LIMIT');
    const chunks = [];
    let size = 0;
    const limit = 24 * 1024 * 1024;
    while (size <= limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - size));
      const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > limit) throw new Error('KNOWLEDGE_PACKET_INPUT_LIMIT');
    packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await input.close(); }
  verifyKnowledgeSourceCandidate(packet);
  return packet;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[2] !== '--input' || process.argv[4] !== '--output') {
    throw new Error('Usage: node scripts/inspect-knowledge-candidate.mjs --input <packet.json> --output <new-report.json>');
  }
  const packet = await readKnowledgeCandidateFile(process.argv[3]);
  const report = inspectKnowledgeCandidate(packet);
  await fs.writeFile(path.resolve(process.argv[5]), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ candidateId: report.candidateId, readiness: report.readiness,
    validRows: report.structurallyValidRows.length, rejectedRows: report.rejectedRows.length,
    sourceIssues: report.sourceIssues, publicationAuthorized: false }));
  if (report.readiness === 'blocked') process.exitCode = 1;
}
