import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('foundation.html');
const controller = read('foundation.js');
const shell = read('app-shell.js');
const clinical = read('clinical-v3.html');
const migration = read('supabase/migrations/202608270100_ttm_foundation_ontology.sql');
const diagnosisHardening = read('supabase/migrations/202608270910_ttm_diagnosis_definer_hardening.sql');

assert.doesNotThrow(() => new vm.Script(controller, { filename: 'foundation.js' }), 'foundation controller should parse');
assert.match(shell, /key: 'foundation'/, 'foundation must be a first-class workspace');
assert.match(shell, /label: 'รากวิชา'/, 'foundation route must be visible as รากวิชา');

for (const layer of ['โลก–มนุษย์–ธาตุ', 'วินิจฉัยเชิงหน้าที่', 'โรคและคัมภีร์เฉพาะ', 'เภสัชและการรักษา', 'หัตถการและเส้น']) {
  assert.match(html, new RegExp(layer), `foundation UI should preserve layer: ${layer}`);
}

assert.match(html, /คัมภีร์ \/ Dataset[\s\S]*?Concept[\s\S]*?Relation[\s\S]*?Encounter Evidence[\s\S]*?Practitioner Confirmation/, 'foundation must show the provenance chain');
assert.match(html, /ปิตตะ 42 \/ วาตะ 80 \/ เสมหะ 20/, 'known diagnostic coverage targets must remain visible');
assert.match(html, /ICD\/WHO เป็น secondary mapping เท่านั้น/, 'international mapping must remain secondary');
assert.match(html, /AI ห้ามวินิจฉัยแทนผู้ประกอบวิชาชีพ/, 'AI must remain subordinate to practitioner authority');
assert.match(diagnosisHardening, /security definer/i, 'diagnosis must remain callable after direct table writes are revoked');
assert.match(diagnosisHardening, /e\.clinic_id = v_clinic_id/i, 'diagnosis must be tenant-bound inside the definer function');
assert.match(diagnosisHardening, /not public\.department_can\('clinical'\)/i, 'diagnosis must require the Clinical department');
assert.match(diagnosisHardening, /'save_ttm_diagnosis_atomic'/i, 'diagnosis write must append audit evidence');
assert.match(clinical, /Clinical record ไม่ใช่ฐานความรู้/, 'clinical workflow must not pretend to be the knowledge foundation');

for (const table of ['ttm_sources', 'ttm_concepts', 'ttm_concept_terms', 'ttm_concept_relations', 'ttm_encounter_concepts']) {
  assert.match(migration, new RegExp(`create table if not exists public\\.${table}`), `migration must create ${table}`);
}
assert.match(migration, /create or replace view public\.v_ttm_foundation_graph/, 'migration must expose a traceable graph view');
assert.match(migration, /source_id uuid references public\.ttm_sources/, 'ontology statements must retain source identity');
assert.match(migration, /review_status text not null default 'review_required'/, 'knowledge must default to review required');
assert.match(migration, /practitioner_confirmed boolean not null default false/, 'encounter bindings must require explicit practitioner confirmation');

assert.doesNotMatch(controller, /\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.rpc\s*\(/, 'foundation browser must remain read-only');
assert.doesNotMatch(controller, /localStorage|MutationObserver|setInterval\s*\(/, 'foundation browser must not introduce a second state engine');

console.log('TTM foundation contracts passed: 5 layers + provenance + ontology schema + clinical boundary');
