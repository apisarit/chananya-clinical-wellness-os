import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {identity, frames, sources, modules, mountains, bagua, stems, branches, layers, rules, seasonalCorrespondences} from '../knowledge/u-synthesise/catalog.mjs';
import {angle, readBearing, readKala, readChineseHour, clockPosition, parseCivilDateTime, civilYearPosition, readSolarTerm, branchBearingOverlay, relateElements, readBirthTime, attachLegacyKnowledge} from '../knowledge/u-synthesise/engine.mjs';

const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const bearing = degrees => readBearing({position: angle('magnetic_bearing', degrees), uncertaintyDegrees: 0});

// Independent cardinal and boundary expectations, including the north wraparound.
for (const [degrees, symbol, code, trigram, element] of [
  [0, '子', 'N2', '坎', 'water'], [90, '卯', 'E2', '震', 'wood'],
  [180, '午', 'S2', '離', 'fire'], [270, '酉', 'W2', '兌', 'metal'],
  [330, '亥', 'NW3', '乾', 'metal'],
]) {
  const value = bearing(degrees);
  assert.equal(value.mountain.symbol, symbol);
  assert.equal(value.mountain.code, code);
  assert.equal(value.bagua.symbol, trigram);
  assert.equal(value.bagua.element, element);
  assert.equal(value.auspiciousness, 'not_evaluated');
}
for (const [degrees, symbol] of [[352.499, '壬'], [352.5, '子'], [359.999, '子'], [360, '子'], [-0.001, '子'], [7.499, '子'], [7.5, '癸'], [322.499, '乾'], [322.5, '亥'], [337.499, '亥'], [337.5, '壬']]) assert.equal(bearing(degrees).mountain.symbol, symbol);
assert.equal(mountains.length, 24);
assert.equal(new Set(mountains.map(item => item.symbol)).size, 24);
assert.deepEqual(['branch', 'stem', 'trigram'].map(kind => mountains.filter(item => item.kind === kind).length), [12, 8, 4]);
assert.ok(!mountains.some(item => ['戊', '己'].includes(item.symbol)));
assert.deepEqual(mountains.filter(item => item.kind === 'trigram').map(item => item.symbol).sort(), ['乾', '坤', '巽', '艮'].sort());
for (let degrees = 0; degrees < 360; degrees += 0.5) {
  assert.equal(mountains.filter(item => ((degrees - item.start + 360) % 360) < item.span).length, 1);
  assert.equal(bagua.filter(item => ((degrees - item.start + 360) % 360) < item.span).length, 1);
}

// Same number in a different frame must never become a measured direction.
for (const frame of ['civil_year_april', 'clock12', 'clock24', 'solar_tropical', 'zodiac_sidereal', 'true_bearing']) assert.throws(() => readBearing({position: angle(frame, 0)}), /no implicit coordinate conversion/);
assert.throws(() => angle('category', 10));
assert.throws(() => angle('toString', 10));
for (const value of [NaN, Infinity, '90', null]) assert.throws(() => angle('magnetic_bearing', value));
assert.throws(() => readSolarTerm(angle('magnetic_bearing', 0)));
assert.equal(readSolarTerm(angle('solar_tropical', 0)).intervalStartingAt.symbol, '春分');
assert.equal(readSolarTerm(angle('solar_tropical', 314.999)).intervalStartingAt.symbol, '大寒');
assert.equal(readSolarTerm(angle('solar_tropical', 315)).intervalStartingAt.symbol, '立春');
assert.equal(readSolarTerm(angle('solar_tropical', 360)).intervalStartingAt.symbol, '春分');
assert.deepEqual(seasonalCorrespondences.find(item => item.branch === '子'), {branch: '子', bearing: 0, solarTerm: '冬至', solarLongitude: 270, approximateMonth: 12, relation: 'traditional_seasonal_correspondence', sourceIds: ['compass', 'solar']});

// An unknown sensor error is not zero; a straddled boundary reports ambiguity.
const unknown = readBearing({position: angle('magnetic_bearing', 330)});
assert.equal(unknown.quality, 'uncertainty_unknown');
assert.equal(unknown.candidates, null);
const uncertain = readBearing({position: angle('magnetic_bearing', 337.4), source: 'sensor', uncertaintyDegrees: 0.2});
assert.equal(uncertain.quality, 'multiple_sectors');
assert.deepEqual(uncertain.candidates.map(item => item.symbol).sort(), ['壬', '亥'].sort());
assert.equal(readBearing({position: angle('magnetic_bearing', 0), uncertaintyDegrees: 180}).candidates.length, 24);
for (const uncertaintyDegrees of [-1, 181, NaN, '0']) assert.throws(() => readBearing({position: angle('magnetic_bearing', 0), uncertaintyDegrees}));

// Owner-confirmed Kala boundaries and the actual, unfolded Chinese hour.
for (const [hour, minute, name] of [[0, 0, 'ปิตตะ'], [1, 59, 'ปิตตะ'], [2, 0, 'วาตะ'], [5, 59, 'วาตะ'], [6, 0, 'เสมหะ'], [9, 59, 'เสมหะ'], [10, 0, 'ปิตตะ'], [13, 59, 'ปิตตะ'], [14, 0, 'วาตะ'], [17, 59, 'วาตะ'], [18, 0, 'เสมหะ'], [21, 59, 'เสมหะ'], [22, 0, 'ปิตตะ'], [23, 59, 'ปิตตะ']]) assert.equal(readKala({hour, minute}).name, name);
for (let minute = 0; minute < 720; minute++) {
  const morning = {hour: Math.floor(minute / 60), minute: minute % 60};
  const evening = {...morning, hour: morning.hour + 12};
  assert.equal(readKala(morning).id, readKala(evening).id);
  assert.deepEqual(clockPosition(morning), clockPosition(evening));
  assert.notEqual(readChineseHour(morning).symbol, readChineseHour(evening).symbol);
}
for (const [hour, minute, symbol] of [[0, 0, '子'], [0, 59, '子'], [1, 0, '丑'], [21, 0, '亥'], [22, 59, '亥'], [23, 0, '子']]) assert.equal(readChineseHour({hour, minute}).symbol, symbol);
assert.equal(branchBearingOverlay('子').position.degrees, 0);
assert.equal(branchBearingOverlay('午').position.degrees, 180);
assert.equal(branchBearingOverlay('亥').mountain.start, 322.5);
assert.equal(branchBearingOverlay('亥').measurement, false);
assert.equal(branchBearingOverlay('亥').auspiciousness, 'not_evaluated');
assert.throws(() => branchBearingOverlay('戊'));

const options = {era: 'BE', utcOffsetMinutes: 420};
const birth = readBirthTime('29/10/2530 22.19', options);
assert.equal(birth.system, 'U Synthesise');
assert.equal(birth.civil.instant, '1987-10-29T15:19:00.000Z');
assert.equal(birth.kala.name, 'ปิตตะ');
assert.equal(birth.chineseHour.symbol, '亥');
assert.equal(birth.year.position.frame, 'civil_year_april');
assert.ok(Math.abs(birth.year.position.degrees - 208.4556010928962) < 1e-10);
assert.equal(birth.compassBearing, null);
assert.equal(birth.constitution, 'not_inferred_from_kala_alone');
assert.equal(parseCivilDateTime('29/10/1987 22:19', {...options, era: 'CE'}).instant, birth.civil.instant);
assert.throws(() => parseCivilDateTime('29/10/2530 22:19', {utcOffsetMinutes: 420}));
for (const value of ['31/04/2530 22:19', '29/02/2530 22:19', '01/13/2530 22:19', '29/10/2530 24:00', '29/10/2530 22:60']) assert.throws(() => parseCivilDateTime(value, options));
assert.equal(civilYearPosition(parseCivilDateTime('01/04/2567 00:00', options)).position.degrees, 0);
const leap = civilYearPosition(parseCivilDateTime('29/02/2567 00:00', options));
assert.equal(leap.days, 366);
assert.equal(leap.startYearCE, 2023);
assert.equal(civilYearPosition(parseCivilDateTime('01/04/2567 00:00', options)).days, 365);

// Directed cycles are a theory relationship; benefit is a separate evaluation.
for (const [a, b] of [['wood', 'fire'], ['fire', 'earth'], ['earth', 'metal'], ['metal', 'water'], ['water', 'wood']]) {
  assert.equal(relateElements(a, b).relation, 'generates');
  assert.equal(relateElements(b, a).relation, 'generated_by');
}
for (const [a, b] of [['wood', 'earth'], ['earth', 'water'], ['water', 'fire'], ['fire', 'metal'], ['metal', 'wood']]) {
  assert.equal(relateElements(a, b).relation, 'controls');
  assert.equal(relateElements(b, a).relation, 'controlled_by');
}
assert.equal(relateElements('fire', 'fire').relation, 'same_element');
assert.equal(relateElements('wood', 'fire').benefit, 'not_evaluated');
assert.throws(() => relateElements('pitta', 'fire'), /Wuxing/);
assert.equal(stems.length, 10); assert.equal(branches.length, 12);

// Preserve all prior data, source statuses and layers; never edit the V1 payload.
const code = read('luopan-knowledge.js');
assert.equal(createHash('sha256').update(code).digest('hex'), identity.legacySha256);
const context = {window: {}};
vm.runInNewContext(code, context, {filename: 'luopan-knowledge.js'});
const legacy = context.window.LuopanKnowledgeV1;
const before = JSON.stringify(legacy);
const attached = attachLegacyKnowledge(legacy);
assert.equal(JSON.stringify(attached.legacy), before);
assert.equal(JSON.stringify(legacy), before);
assert.equal(Object.isFrozen(legacy), false);
assert.equal(Object.isFrozen(attached.legacy.source.ttmRaw), true);
assert.equal(attached.legacy.source.ttmRaw.length, 113);
assert.equal(attached.legacy.source.chineseRelations.length, 39);
assert.equal(attached.legacy.lunar.length, 2707);
assert.equal(layers.length, 23);
assert.equal(layers.filter(layer => layer.origin === 'base').length, 20);
assert.equal(layers.find(layer => layer.id === 'calendar').frame, 'civil_year_april');
assert.deepEqual(layers.filter(layer => layer.mode === 'feng_shui').map(layer => layer.id), ['directions', 'mountains']);
assert.deepEqual(modules.map(module => module.id), ['wuxing_bazi', 'luopan', 'thai_astrology', 'samutthan']);
for (const item of [...layers, ...rules, ...mountains, ...stems, ...branches]) assert.ok(item.sourceIds.every(id => Object.hasOwn(sources, id)));
for (const layer of layers) assert.ok(Object.hasOwn(frames, layer.frame));
assert.equal(rules.find(rule => rule.id === 'flying_stars').status, 'not_implemented');
assert.equal(rules.find(rule => rule.id === 'thai_saha_ari').status, 'awaiting_project_source');
assert.throws(() => { attached.legacy.source.ttmRaw.pop(); });
const incomplete = structuredClone(legacy); incomplete.source.ttmRaw.pop();
assert.throws(() => attachLegacyKnowledge(incomplete), /baseline changed/);

console.log('U Synthesise foundation passed: separate coordinate frames, 24 mountains, uncertainty, Kala boundaries, calendar, Wuxing and lossless 113-rule legacy bridge');
