import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'ttm-reasoning.js'), 'utf8');
const context = vm.createContext({ console });
vm.runInContext(source, context, { filename: 'ttm-reasoning.js' });
const engine = context.ChananyaTtmReasoning;
const plain = value => JSON.parse(JSON.stringify(value));

assert.ok(engine, 'reasoning engine must publish a stable browser API');
assert.equal(engine.computeAge('2000-09-01', new Date('2026-08-30T12:00:00Z')), 25);
assert.equal(engine.computeAge('2000-02-30', new Date('2026-08-30T12:00:00Z')), null, 'invalid dates must be rejected');
assert.equal(engine.weekdayThai('2000-01-01'), 'เสาร์');
assert.equal(engine.timeRuleMatches('23:30', '23:00-02:00'), true, 'midnight-spanning ranges must work');
assert.equal(engine.timeRuleMatches('01:59', '23:00-02:00'), true);
assert.equal(engine.timeRuleMatches('02:00', '23:00-02:00'), false, 'range end must be exclusive');
assert.deepEqual(plain(engine.parseDoshaWeights({ metadata: { proportions: { ปิตตะ: 2, วาตะ: 1 } } })), { pitta: 2, vata: 1 });

const contextRules = [
  {
    id: 'age-young', domain: 'age_samutthan', rule_key: 'ปฐมวัย', input_key: 'แรกเกิด–16 ปี', output_value: 'เสมหะ',
    source_ref: '03_อายุสมุฏฐาน', source_class: 'image_transcribed', review_status: 'review_required', active: true,
    metadata: { rule_role: 'context_only', clinical_inference_allowed: false }
  },
  {
    id: 'age-middle', domain: 'age_samutthan', rule_key: 'มัชฌิมวัย', input_key: '16–30 ปี', output_value: 'ปิตตะ',
    source_ref: '03_อายุสมุฏฐาน', source_class: 'image_transcribed', review_status: 'review_required', active: true,
    metadata: { rule_role: 'context_only', clinical_inference_allowed: false }
  },
  {
    id: 'time-pitta', domain: 'kala_samutthan', rule_key: 'main', input_key: '23:00-02:00', output_value: 'ปิตตะ',
    source_ref: '04_กาลสมุฏฐาน', source_class: 'image_transcribed', review_status: 'review_required', active: true,
    metadata: { rule_role: 'context_only', clinical_inference_allowed: false }
  }
];

const boundary = engine.buildContextReasoning({
  birthDate: '2010-08-30', symptomTime: '23:30', kalaMode: 'main', observationText: 'ตัวร้อน'
}, contextRules, new Date('2026-08-30T12:00:00Z'));
assert.equal(boundary.constitution.age, 16);
assert.equal(boundary.evidence.filter(item => item.lens === 'age').length, 2, 'overlapping age boundaries must preserve both source rules');
assert.ok(boundary.conflicts.some(message => message.includes('ขอบเขตอายุ 16 ปีซ้อนกัน')));
assert.ok(boundary.context.percent.pitta > 0, 'review-required context may be visualized as context');
assert.ok(boundary.context.percent.semha > 0);
assert.equal(boundary.clinical.status, 'insufficient_evidence', 'context must never become diagnosis');
assert.equal(boundary.clinical.evidenceCount, 0);
assert.ok(boundary.gaps.some(message => message.includes('ยังไม่มีกฎอาการ/สิ่งตรวจพบ')));
assert.ok(boundary.gaps.some(message => message.includes('ยังไม่ถูกแปลงเป็นคะแนนอัตโนมัติ')));

const clinicalRule = {
  id: 'finding-hot-to-pitta', domain: 'clinical_finding', rule_key: 'hot-pattern', input_key: 'finding.hot',
  output_value: 'ปิตตะ', source_ref: 'expert-review-1', source_class: 'practitioner_curated',
  review_status: 'approved', active: true,
  metadata: {
    rule_role: 'finding_to_hypothesis', clinical_inference_allowed: true,
    finding_codes: ['finding.hot'], match_policy: 'all', hypothesis_axis: 'pitta', weight: 2
  }
};
const clinical = engine.buildContextReasoning({ findingCodes: ['finding.hot'] }, [clinicalRule], new Date('2026-08-30T12:00:00Z'));
assert.equal(clinical.clinical.status, 'candidate_only');
assert.equal(clinical.clinical.topAxis, 'pitta');
assert.equal(clinical.clinical.evidenceCount, 1);

const unapproved = engine.buildContextReasoning({ findingCodes: ['finding.hot'] }, [{ ...clinicalRule, review_status: 'review_required' }], new Date('2026-08-30T12:00:00Z'));
assert.equal(unapproved.clinical.status, 'insufficient_evidence', 'review-required clinical rules must never unlock inference');

console.log('TTM reasoning contracts passed: separate lenses, midnight ranges, conflict visibility and approved-only clinical gate');
