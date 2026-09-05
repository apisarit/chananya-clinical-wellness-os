// Generated from knowledge/u-synthesise/catalog.mjs
// U Synthesise is the owner's chosen spelling. This foundation does not replace V1.
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const identity = deepFreeze({
  name: 'U Synthesise', id: 'u-synthesise', version: '0.1.0', status: 'foundation_draft',
  baselineCommit: '40cb673f02e8b9e2641c46702441cff8c8ef19bd',
  legacyFile: 'luopan-knowledge.js',
  legacySha256: '79e0c23c763aa580665cdabfedc989275b3bbbdce867f02e4fc38d618acf1951',
  purpose: 'รวมองค์ความรู้บนวงล้อ โดยรักษาพิกัดและเงื่อนไขของแต่ละศาสตร์',
});

export const sources = deepFreeze({
  compass: {kind: 'practitioner_reference', title: 'Feng Shui Natural — compass and Earth Plate', url: 'https://www.fengshuinatural.com/en/fengshuicompass.htm'},
  solar: {kind: 'astronomical_reference', title: 'Hong Kong Observatory — 24 Solar Terms', url: 'https://www.hko.gov.hk/en/gts/time/24solarterms.htm'},
  stems: {kind: 'calendar_reference', title: 'Hong Kong Observatory — Stems and Branches', url: 'https://www.hko.gov.hk/en/gts/time/stemsandbranches.htm'},
  wuxing: {kind: 'traditional_theory', title: 'Beijing University of Chinese Medicine — 五行', url: 'https://www.bucm.edu.cn/kxyj/9e3411c63652410d8d7c99d8435e7ef5.htm'},
  owner: {kind: 'project_convention', title: 'คำยืนยันผู้ใช้: กาลสมุฏฐาน 12 ชั่วโมง × 2 รอบ; วงปีเริ่มเมษายน; ชื่อ U Synthesise', recorded: '2026-09-05'},
  legacy: {kind: 'preserved_source', title: 'ข้อมูลเดิมจาก Excel 24 ชีต และ BaZi v1.8', path: 'luopan-knowledge.js', baselineCommit: identity.baselineCommit},
});

// Rendering each frame clockwise does not make its native coordinates equivalent.
export const frames = deepFreeze({
  magnetic_bearing: {unit: 'degrees', domain: 'space', zero: 'magnetic_north', positive: 'clockwise', period: 360},
  true_bearing: {unit: 'degrees', domain: 'space', zero: 'true_north', positive: 'clockwise', period: 360, conversion: 'requires_explicit_declination'},
  solar_tropical: {unit: 'degrees', domain: 'astronomy', zero: 'vernal_equinox', positive: 'eastward_along_ecliptic', period: 360},
  zodiac_sidereal: {unit: 'degrees', domain: 'astrology', zero: 'sidereal_aries', positive: 'zodiac_order', period: 360, legacyMethod: 'approximate_Lahiri'},
  civil_year_april: {unit: 'degrees', domain: 'time', zero: 'April_1_00:00_local', positive: 'elapsed_civil_time', period: 360},
  clock12: {unit: 'degrees', domain: 'time', zero: '00:00_or_12:00_local', positive: 'elapsed_clock_time', period: 360},
  clock24: {unit: 'degrees', domain: 'time', zero: '00:00_local', positive: 'elapsed_clock_time', period: 360},
  lunar_sequence: {unit: 'ordinal', domain: 'calendar', zero: 'legacy_season_start', geometry: 'display_only'},
  category: {unit: 'ordinal', domain: 'knowledge', zero: 'catalog_start', geometry: 'display_only'},
});

export const modules = deepFreeze([
  {id: 'wuxing_bazi', name: 'Wuxing–BaZi', tables: ['stems', 'branches', 'wuxing', 'elementPairs', 'godMatrix', 'godNames', 'pillars', 'chineseRelations'], scope: 'ก้านฟ้า กิ่งดิน ธาตุแฝง สี่เสา สิบเทพ และสัมพันธ์ตามเงื่อนไขเดิม'},
  {id: 'luopan', name: 'Luopan', tables: ['mountains'], scope: 'พิกัดทิศ 8 ทิศ และ 24 ขุนเขา Earth Plate'},
  {id: 'thai_astrology', name: 'โหราศาสตร์ไทย', tables: ['zodiac', 'thaiSigns', 'planets', 'thaiPairs', 'thaiNatural', 'thaiNatal', 'houses', 'taksa'], scope: 'ราศี ลัคนา ภพ เจ้าเรือน ดาว คู่สัมพันธ์ และทักษา ตามฐานตำราที่กำกับ'},
  {id: 'samutthan', name: 'สมุฏฐานเจ้าเรือน', tables: ['seasons', 'timeAge', 'ttmRaw'], scope: 'กาล ฤดู อายุ เจ้าเรือน ระคน เจือกระทบ พิกัด และจำนวนส่วน'},
]);

export const modes = deepFreeze({
  feng_shui: {name: 'โหมดทิศทาง', sensorPolicy: 'explicit_permission_and_reference_required', implementedSensor: false, acceptedReadingFrame: 'magnetic_bearing', fixedLayers: ['directions', 'mountains'], natalHouses: false},
  astro_medical: {name: 'โหมดเวลาและองค์ความรู้', sensorPolicy: 'off', core: 'kala', yearStart: '04-01', birthInput: true, clinicalDiagnosis: false},
});

export const elements = deepFreeze([
  {id: 'wood', name: 'ไม้', symbol: '木'}, {id: 'fire', name: 'ไฟ', symbol: '火'},
  {id: 'earth', name: 'ดิน', symbol: '土'}, {id: 'metal', name: 'ทอง', symbol: '金'},
  {id: 'water', name: 'น้ำ', symbol: '水'},
]);

export const stems = deepFreeze([... '甲乙丙丁戊己庚辛壬癸'].map((symbol, i) => ({
  symbol, index: i, element: elements[Math.floor(i / 2)].id,
  polarity: i % 2 ? 'yin' : 'yang', sourceIds: ['legacy'],
})));

const branchElements = ['water', 'earth', 'wood', 'wood', 'earth', 'fire', 'fire', 'earth', 'metal', 'metal', 'earth', 'water'];
const animals = ['ชวด', 'ฉลู', 'ขาล', 'เถาะ', 'มะโรง', 'มะเส็ง', 'มะเมีย', 'มะแม', 'วอก', 'ระกา', 'จอ', 'กุน'];
export const branches = deepFreeze([... '子丑寅卯辰巳午未申酉戌亥'].map((symbol, i) => ({
  symbol, index: i, animal: animals[i], element: branchElements[i], polarity: i % 2 ? 'yin' : 'yang',
  clockStartHour: (23 + i * 2) % 24, clockEndHour: (1 + i * 2) % 24,
  sourceIds: ['stems', 'legacy'],
})));

export const bagua = deepFreeze([
  ['N', 'เหนือ', '坎', '☵', 'water'], ['NE', 'ตะวันออกเฉียงเหนือ', '艮', '☶', 'earth'],
  ['E', 'ตะวันออก', '震', '☳', 'wood'], ['SE', 'ตะวันออกเฉียงใต้', '巽', '☴', 'wood'],
  ['S', 'ใต้', '離', '☲', 'fire'], ['SW', 'ตะวันตกเฉียงใต้', '坤', '☷', 'earth'],
  ['W', 'ตะวันตก', '兌', '☱', 'metal'], ['NW', 'ตะวันตกเฉียงเหนือ', '乾', '☰', 'metal'],
].map(([direction, name, symbol, trigram, element], i) => ({
  direction, name, symbol, trigram, element, center: i * 45,
  start: (i * 45 + 337.5) % 360, span: 45, frame: 'magnetic_bearing', sourceIds: ['compass'],
})));

export const mountains = deepFreeze([... '壬子癸丑艮寅甲卯乙辰巽巳丙午丁未坤申庚酉辛戌乾亥'].map((symbol, i) => ({
  symbol, code: bagua[Math.floor(i / 3)].direction + (i % 3 + 1),
  kind: branches.some(b => b.symbol === symbol) ? 'branch' : stems.some(s => s.symbol === symbol) ? 'stem' : 'trigram',
  center: (345 + i * 15) % 360, start: (337.5 + i * 15) % 360, span: 15,
  frame: 'magnetic_bearing', sourceIds: ['compass'],
  // Branch/stem yin-yang must not be reused as Flying Star mountain polarity.
  flyingStarPolarity: 'not_specified',
})));

export const solarTerms = deepFreeze([
  ['春分', 'Vernal Equinox'], ['清明', 'Bright and Clear'], ['穀雨', 'Corn Rain'],
  ['立夏', 'Summer Commences'], ['小滿', 'Corn Forms'], ['芒種', 'Corn on Ear'],
  ['夏至', 'Summer Solstice'], ['小暑', 'Moderate Heat'], ['大暑', 'Great Heat'],
  ['立秋', 'Autumn Commences'], ['處暑', 'End of Heat'], ['白露', 'White Dew'],
  ['秋分', 'Autumnal Equinox'], ['寒露', 'Cold Dew'], ['霜降', 'Frost'],
  ['立冬', 'Winter Commences'], ['小雪', 'Light Snow'], ['大雪', 'Heavy Snow'],
  ['冬至', 'Winter Solstice'], ['小寒', 'Moderate Cold'], ['大寒', 'Severe Cold'],
  ['立春', 'Spring Commences'], ['雨水', 'Spring Showers'], ['驚蟄', 'Insects Waken'],
].map(([symbol, name], i) => ({symbol, name, longitude: i * 15, frame: 'solar_tropical', sourceIds: ['solar']})));

// A traditional seasonal correspondence, not an angle conversion or calendar boundary.
export const seasonalCorrespondences = deepFreeze([
  {branch: '子', bearing: 0, solarTerm: '冬至', solarLongitude: 270, approximateMonth: 12},
  {branch: '卯', bearing: 90, solarTerm: '春分', solarLongitude: 0, approximateMonth: 3},
  {branch: '午', bearing: 180, solarTerm: '夏至', solarLongitude: 90, approximateMonth: 6},
  {branch: '酉', bearing: 270, solarTerm: '秋分', solarLongitude: 180, approximateMonth: 9},
].map(item => ({...item, relation: 'traditional_seasonal_correspondence', sourceIds: ['compass', 'solar']})));

export const kala = deepFreeze([
  {id: 'pitta', name: 'ปิตตะ', intervals: [[10, 14], [22, 2]]},
  {id: 'vata', name: 'วาตะ', intervals: [[14, 18], [2, 6]]},
  {id: 'semha', name: 'เสมหะ', intervals: [[6, 10], [18, 22]]},
].map(item => ({...item, frame: 'clock24', repeatHours: 12, boundary: '[start,end)', sourceIds: ['owner'], inference: 'time_samutthan_only'})));

// Every V1 layer retains its identity. Legacy numeric groups are not coordinates.
export const layers = deepFreeze([
  ['calendar', 'civil_year_april', 'shared', 'computed'],
  ['directions', 'magnetic_bearing', 'luopan', 'base'], ['mountains', 'magnetic_bearing', 'luopan', 'base'],
  ...['zodiac', 'thai-elements', 'rulers', 'houses', 'dignities'].map(id => [id, 'zodiac_sidereal', 'thai_astrology', 'base']),
  ['planetary', 'zodiac_sidereal', 'thai_astrology', 'computed'],
  ...['seasons', 'season-main', 'season-mix'].map(id => [id, 'lunar_sequence', 'samutthan', 'base']),
  ...['stems', 'ten-gods', 'wuxing'].map(id => [id, 'category', 'wuxing_bazi', 'base']),
  ['pillars', 'category', 'wuxing_bazi', 'computed'],
  ...['branches', 'hidden', 'hours'].map(id => [id, 'clock12', 'wuxing_bazi', 'base']),
  ...['tri', 'tu', 'eka', 'kala'].map(id => [id, 'clock12', 'samutthan', 'base']),
].map(([id, frame, module, origin]) => ({
  id, frame, module, origin, mode: module === 'luopan' ? 'feng_shui' : 'astro_medical',
  interpretation: ['lunar_sequence', 'category'].includes(frame) ? 'catalog_display' : 'within_declared_frame',
  sourceIds: ['legacy'],
})));

export const rules = deepFreeze([
  {id: 'mountain_lookup', status: 'implemented', sourceIds: ['compass'], permits: 'fixed_Earth_Plate_sector', requires: ['magnetic_bearing']},
  {id: 'kala_lookup', status: 'implemented', sourceIds: ['owner'], permits: 'time_samutthan', requires: ['local_civil_hour']},
  {id: 'wuxing_relation', status: 'implemented', sourceIds: ['wuxing'], permits: 'directed_sheng_ke_relationship', requires: ['source_element', 'target_element']},
  {id: 'branch_bearing_overlay', status: 'implemented', sourceIds: ['compass', 'stems'], permits: 'symbol_correspondence_only', requires: ['exact_branch_symbol']},
  {id: 'bazi_calculation', status: 'legacy_preserved', sourceIds: ['legacy'], requires: ['birth_time', 'timezone', 'day_boundary_convention', 'solar_term_method']},
  {id: 'thai_natal_calculation', status: 'legacy_preserved', sourceIds: ['legacy'], requires: ['birth_time', 'birth_location', 'ayanamsa', 'house_system', 'ruler_school']},
  {id: 'ttm_detailed_parts', status: 'legacy_pending_review', sourceIds: ['legacy'], requires: ['original_text', 'main_mix_contact_roles', 'parts', 'time_or_season_scope']},
  {id: 'bazi_favorable_directions', status: 'not_implemented', sourceIds: ['legacy'], requires: ['named_school', 'full_chart', 'favorable_element_method', 'transformation_conditions']},
  {id: 'flying_stars', status: 'not_implemented', sourceIds: ['compass'], requires: ['named_school', 'building_period', 'facing_and_sitting', 'mountain_polarity_method', 'chart_rules']},
  {id: 'thai_saha_ari', status: 'awaiting_project_source', sourceIds: ['legacy'], requires: ['original_project_definition']},
  {id: 'ttm_conception', status: 'not_implemented', sourceIds: ['legacy'], requires: ['documented_conception_date_method', 'uncertainty']},
  {id: 'lunar_leap8', status: 'awaiting_project_source', sourceIds: ['legacy'], requires: ['documented_intercalary_month_rule']},
  {id: 'cross_system_element_equivalence', status: 'not_authorized_by_model', sourceIds: ['legacy'], requires: ['explicit_cross_system_rule_and_source']},
  {id: 'clinical_diagnosis', status: 'not_supported', sourceIds: ['owner'], requires: ['separate_clinical_evidence_and_assessment']},
]);

export const legacyCounts = deepFreeze({
  sheets: 24, mountains: 24, branches: 12, stems: 10, wuxing: 5, elementPairs: 25,
  godMatrix: 10, godNames: 10, pillars: 4, chineseRelations: 39, zodiac: 12,
  thaiSigns: 12, planets: 8, thaiPairs: 24, thaiNatural: 49, thaiNatal: 8,
  houses: 12, taksa: 8, seasons: 18, timeAge: 44, ttmRaw: 113, sources: 18,
});
