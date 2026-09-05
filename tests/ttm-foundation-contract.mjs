import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('foundation.html');
const controller = read('foundation.js');
const reasoning = read('ttm-reasoning.js');
const shell = read('app-shell.js');
const clinical = read('clinical-v3.html');
const migration = read('supabase/migrations/202608270100_ttm_foundation_ontology.sql');
const diagnosisHardening = read('supabase/migrations/202608270910_ttm_diagnosis_definer_hardening.sql');

assert.doesNotThrow(() => new vm.Script(controller, { filename: 'foundation.js' }), 'foundation controller should parse');
assert.doesNotThrow(() => new vm.Script(reasoning, { filename: 'ttm-reasoning.js' }), 'reasoning engine should parse');
assert.match(shell, /key: 'foundation'/, 'foundation must be a first-class workspace');
assert.match(shell, /label: 'รากวิชา'/, 'foundation route must be visible as รากวิชา');

for (const layer of ['โลก–มนุษย์–ธาตุ', 'วินิจฉัยเชิงหน้าที่', 'โรคและคัมภีร์เฉพาะ', 'เภสัชและการรักษา', 'หัตถการและเส้น']) {
  assert.match(html, new RegExp(layer), `foundation UI should preserve layer: ${layer}`);
}

assert.match(html, /Source[\s\S]*?Concept[\s\S]*?Typed relation[\s\S]*?Finding[\s\S]*?Practitioner confirmation/, 'foundation must show the provenance chain');
assert.match(html, /id="foundation-browser"/, 'layer filtering must expose a concrete result scroll target');
assert.match(html, /id="foundation-result-meta"[^>]*role="status"[^>]*aria-live="polite"/, 'layer filtering must announce its result on mobile and assistive technology');
assert.match(html, /data-foundation-layer="1"[^>]*aria-pressed="false"[^>]*aria-controls="foundation-results"/, 'layer controls must expose their pressed state and target');
assert.match(html, /แตะเพื่อดูรายการ ↓/, 'layer cards must communicate their mobile interaction');
assert.match(controller, /function selectLayer\([\s\S]*?scrollIntoView\(/, 'layer selection must move the user to the filtered results');
assert.match(controller, /setAttribute\('aria-pressed', String\(active\)\)/, 'layer selection must synchronize its accessible state');
for (const tab of ['data-foundation-tab="case"', 'data-foundation-tab="knowledge"', 'data-foundation-tab="coverage"']) {
  assert.match(html, new RegExp(tab), `foundation must expose reasoning tab ${tab}`);
}
for (const id of ['ttm-case-form', 'ttm-clinical-gate', 'ttm-lenses', 'ttm-context-axis-cards', 'ttm-conflicts', 'ttm-gaps', 'ttm-reasoning-path', 'ttm-evidence-audit', 'ttm-therapy-candidates']) {
  assert.match(html, new RegExp(`id="${id}"`), `reasoning workbench must expose ${id}`);
}
assert.match(html, /ปิตตะ 4 • วาตะ 6 • เสมหะ 12 • ปถวี 20/, 'asymmetric TTM body registry targets must remain visible');
assert.match(html, /AI และ ICD\/WHO อยู่ปลายทางเท่านั้น/, 'international mapping and AI must remain secondary');
assert.match(html, /ช่วยตั้งสมมติฐาน ไม่วินิจฉัยแทนผู้ประกอบวิชาชีพ/, 'practitioner authority must remain explicit');
assert.match(html, /review_required ห้ามสร้างข้อสรุป/, 'unapproved knowledge must never produce automatic conclusions');
assert.match(controller, /has_traditional_claim_for/, 'therapy claims must be traversed through typed relations');
assert.match(controller, /กฎ finding → hypothesis ที่อนุมัติ/, 'clinical gate must report the actual approved-rule count');
assert.match(reasoning, /rule_role === 'finding_to_hypothesis'/, 'clinical inference must require the finding-to-hypothesis rule role');
assert.match(reasoning, /review_status === 'approved'/, 'clinical inference must require approved rules');
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
