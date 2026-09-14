// Generated from knowledge/u-synthesise/engine.mjs
import {identity, frames, mountains, bagua, branches, elements, solarTerms, kala, layers, legacyCounts, deepFreeze} from './u-synthesise-catalog.js';

const mod = (number, period) => ((number % period) + period) % period;
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function angle(frame, degrees) {
  if (!Object.hasOwn(frames, frame) || frames[frame].unit !== 'degrees') throw new TypeError('An angular coordinate frame is required');
  if (!finite(degrees)) throw new TypeError('Degrees must be a finite number');
  return Object.freeze({frame, degrees: mod(degrees, 360)});
}

function requireAngle(position, expectedFrame) {
  if (!position || position.frame !== expectedFrame) throw new TypeError(`Expected ${expectedFrame}; no implicit coordinate conversion`);
  return angle(position.frame, position.degrees).degrees;
}

function sectorAt(items, degrees) {
  return items.find(item => mod(degrees - item.start, 360) < item.span);
}

function candidatesAt(items, degrees, uncertaintyDegrees) {
  if (uncertaintyDegrees === null) return null;
  if (uncertaintyDegrees === 0) return [sectorAt(items, degrees)];
  // Conservatively include both sides when the uncertainty range touches a boundary.
  return items.filter(item => Math.abs(mod(degrees - item.center + 180, 360) - 180) <= uncertaintyDegrees + item.span / 2);
}

export function readBearing({position, source = 'manual', uncertaintyDegrees = null} = {}) {
  const degrees = requireAngle(position, 'magnetic_bearing');
  if (!['manual', 'sensor'].includes(source)) throw new TypeError('Measurement source must be manual or sensor');
  if (uncertaintyDegrees !== null && (!finite(uncertaintyDegrees) || uncertaintyDegrees < 0 || uncertaintyDegrees > 180)) throw new RangeError('Uncertainty must be null or 0–180 degrees');
  const candidates = candidatesAt(mountains, degrees, uncertaintyDegrees);
  return deepFreeze({
    position: angle('magnetic_bearing', degrees), source, uncertaintyDegrees,
    mountain: sectorAt(mountains, degrees), bagua: sectorAt(bagua, degrees),
    candidates, baguaCandidates: candidatesAt(bagua, degrees, uncertaintyDegrees),
    quality: candidates === null ? 'uncertainty_unknown' : candidates.length > 1 ? 'multiple_sectors' : 'within_one_sector_at_declared_uncertainty',
    auspiciousness: 'not_evaluated', ruleId: 'mountain_lookup',
  });
}

function minutesOfDay({hour, minute = 0} = {}) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError('Local time must be 00:00–23:59');
  return hour * 60 + minute;
}

export function readKala(localTime) {
  const hour = minutesOfDay(localTime) / 60;
  return kala.find(item => item.intervals.some(([start, end]) => start < end ? hour >= start && hour < end : hour >= start || hour < end));
}

export function readChineseHour(localTime) {
  const minutes = minutesOfDay(localTime);
  return branches[Math.floor(mod(minutes + 60, 1440) / 120)];
}

export function clockPosition(localTime, frame = 'clock12') {
  if (!['clock12', 'clock24'].includes(frame)) throw new TypeError('Expected clock12 or clock24');
  return angle(frame, minutesOfDay(localTime) * (frame === 'clock12' ? 0.5 : 0.25));
}

function civilMilliseconds({year, month, day, hour = 0, minute = 0} = {}) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100 || !Number.isInteger(month) || !Number.isInteger(day)) throw new RangeError('Gregorian date must be in 1900–2100');
  minutesOfDay({hour, minute});
  const time = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new RangeError('Invalid Gregorian calendar date');
  return time;
}

export function parseCivilDateTime(text, {era, utcOffsetMinutes} = {}) {
  if (!['BE', 'CE'].includes(era)) throw new TypeError('Specify BE or CE explicitly');
  if (!Number.isInteger(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 840) throw new RangeError('Specify the UTC offset in minutes for this date');
  const match = typeof text === 'string' && text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})[:.](\d{2})$/);
  if (!match) throw new TypeError('Use DD/MM/YYYY HH:mm or DD/MM/YYYY HH.mm');
  const [, d, m, y, h, min] = match;
  const value = {year: Number(y) - (era === 'BE' ? 543 : 0), month: Number(m), day: Number(d), hour: Number(h), minute: Number(min), utcOffsetMinutes};
  const civil = civilMilliseconds(value);
  return deepFreeze({...value, calendar: 'gregorian', inputEra: era, instant: new Date(civil - utcOffsetMinutes * 60000).toISOString()});
}

export function civilYearPosition(civilDate) {
  const now = civilMilliseconds(civilDate);
  const year = civilDate.month < 4 ? civilDate.year - 1 : civilDate.year;
  const begin = Date.UTC(year, 3, 1), end = Date.UTC(year + 1, 3, 1);
  return deepFreeze({
    position: angle('civil_year_april', (now - begin) / (end - begin) * 360),
    startYearCE: year, days: (end - begin) / 86400000,
    method: 'uniform_local_civil_days', sourceIds: ['owner'],
  });
}

export function readSolarTerm(position) {
  const degrees = requireAngle(position, 'solar_tropical');
  const term = solarTerms[Math.floor(degrees / 15)];
  return deepFreeze({position: angle('solar_tropical', degrees), intervalStartingAt: term, nextLongitude: mod(term.longitude + 15, 360), sourceIds: ['solar']});
}

export function branchBearingOverlay(symbol) {
  if (!branches.some(branch => branch.symbol === symbol)) throw new TypeError('An exact Earthly Branch symbol is required');
  const mountain = mountains.find(item => item.symbol === symbol);
  return deepFreeze({
    symbol, mountain, position: angle('magnetic_bearing', mountain.center),
    relation: 'symbol_correspondence', measurement: false, auspiciousness: 'not_evaluated',
    ruleId: 'branch_bearing_overlay',
  });
}

export function relateElements(sourceElement, targetElement) {
  const from = elements.findIndex(element => element.id === sourceElement);
  const to = elements.findIndex(element => element.id === targetElement);
  if (from < 0 || to < 0) throw new TypeError('Use wood, fire, earth, metal or water in the Wuxing system');
  const relations = ['same_element', 'generates', 'controls', 'controlled_by', 'generated_by'];
  return deepFreeze({sourceElement, targetElement, relation: relations[mod(to - from, 5)], ruleId: 'wuxing_relation', benefit: 'not_evaluated'});
}

export function readBirthTime(text, options) {
  const civil = parseCivilDateTime(text, options);
  return deepFreeze({
    system: identity.name, civil, kala: readKala(civil), chineseHour: readChineseHour(civil),
    clock: clockPosition(civil), year: civilYearPosition(civil),
    baziFourPillars: 'delegate_to_existing_engine', thaiNatal: 'delegate_with_birth_location_and_school',
    constitution: 'not_inferred_from_kala_alone', compassBearing: null,
  });
}

// A lossless bridge; no table is narrowed, filtered, scored, or silently promoted.
// Call with window.LuopanKnowledgeV1. This module does not read a browser/global itself.
export function attachLegacyKnowledge(legacy) {
  if (!legacy?.source || !Array.isArray(legacy.model?.layers) || !Array.isArray(legacy.lunar)) throw new TypeError('Expected the complete LuopanKnowledgeV1 payload');
  for (const [name, count] of Object.entries(legacyCounts)) {
    if (!Array.isArray(legacy.source[name]) || legacy.source[name].length !== count) throw new RangeError(`Legacy ${name} baseline changed; review the migration`);
  }
  const baseIds = layers.filter(layer => layer.origin === 'base').map(layer => layer.id);
  const receivedIds = legacy.model.layers.map(layer => layer.id);
  if (receivedIds.length !== baseIds.length || new Set(receivedIds).size !== baseIds.length || baseIds.some(id => !receivedIds.includes(id))) throw new RangeError('Legacy layer registry changed; review the migration');
  const preserved = structuredClone(legacy);
  return deepFreeze({identity, layers, legacy: preserved, reviewStatus: 'original_row_statuses_preserved'});
}
