(() => {
  'use strict';

  const AXES = Object.freeze({
    pitta: Object.freeze({ code: 'pitta', term: 'ปิตตะ', conceptCode: 'dosha.pitta' }),
    vata: Object.freeze({ code: 'vata', term: 'วาตะ', conceptCode: 'dosha.vata' }),
    semha: Object.freeze({ code: 'semha', term: 'เสมหะ', conceptCode: 'dosha.semha' })
  });
  const AXIS_BY_TERM = Object.freeze(Object.fromEntries(Object.values(AXES).map(axis => [axis.term, axis.code])));
  const WEEKDAYS = Object.freeze(['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']);
  const KALA_DOMAINS = Object.freeze({
    main: 'kala_samutthan',
    ekadot: 'kala_ekadot',
    duvandot: 'kala_duvandot',
    tridot: 'kala_tridot'
  });

  function parseDateParts(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { year, month, day, date };
  }

  function computeAge(birthDate, asOf = new Date()) {
    const birth = parseDateParts(birthDate);
    if (!birth || !asOf || typeof asOf.getTime !== 'function' || Number.isNaN(asOf.getTime())) return null;
    let age = asOf.getUTCFullYear() - birth.year;
    const monthDelta = asOf.getUTCMonth() + 1 - birth.month;
    if (monthDelta < 0 || (monthDelta === 0 && asOf.getUTCDate() < birth.day)) age -= 1;
    return age >= 0 && age <= 130 ? age : null;
  }

  function weekdayThai(birthDate) {
    const parts = parseDateParts(birthDate);
    return parts ? WEEKDAYS[parts.date.getUTCDay()] : null;
  }

  function parseClock(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 24 || minute < 0 || minute > 59 || (hour === 24 && minute !== 0)) return null;
    return hour * 60 + minute;
  }

  function timeInRange(minutes, start, end) {
    if ([minutes, start, end].some(value => value === null)) return false;
    if (start === end) return true;
    if (end > start) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
  }

  function timeRuleMatches(time, inputKey) {
    const minutes = parseClock(time);
    if (minutes === null) return false;
    const ranges = String(inputKey || '').split('/').map(value => value.trim()).filter(Boolean);
    return ranges.some(range => {
      const match = range.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
      return Boolean(match && timeInRange(minutes, parseClock(match[1]), parseClock(match[2])));
    });
  }

  function parseDoshaWeights(rule) {
    const metadata = rule?.metadata && typeof rule.metadata === 'object' ? rule.metadata : {};
    if (AXES[metadata.hypothesis_axis]) {
      return { [metadata.hypothesis_axis]: Number(metadata.weight) > 0 ? Number(metadata.weight) : 1 };
    }
    if (metadata.proportions && typeof metadata.proportions === 'object') {
      const weights = {};
      for (const [term, value] of Object.entries(metadata.proportions)) {
        const axis = AXIS_BY_TERM[term];
        if (axis && Number(value) > 0) weights[axis] = Number(value);
      }
      if (Object.keys(weights).length) return weights;
    }
    const text = [rule?.samutthan, rule?.output_value, rule?.description].filter(Boolean).join(' ');
    const weights = {};
    for (const [term, axis] of Object.entries(AXIS_BY_TERM)) {
      if (!text.includes(term)) continue;
      const match = text.match(new RegExp(`${term}[^0-9]{0,18}(\\d+)\\s*ส่วน`));
      weights[axis] = match ? Number(match[1]) : 1;
    }
    return weights;
  }

  function normalizeWeights(weights) {
    const total = Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0);
    return Object.fromEntries(Object.keys(AXES).map(axis => [axis, total ? Math.round((Number(weights[axis] || 0) / total) * 1000) / 10 : 0]));
  }

  function ageRuleCandidates(age, rules) {
    if (!Number.isFinite(age)) return [];
    const byKey = key => rules.filter(rule => rule.domain === 'age_samutthan' && rule.rule_key === key);
    if (age < 16) return byKey('ปฐมวัย');
    if (age === 16) return [...byKey('ปฐมวัย'), ...byKey('มัชฌิมวัย')];
    if (age < 30) return byKey('มัชฌิมวัย');
    if (age === 30) return [...byKey('มัชฌิมวัย'), ...byKey('ปัจฉิมวัย')];
    return byKey('ปัจฉิมวัย');
  }

  function ruleEvidence(rule, lens, label) {
    const weights = parseDoshaWeights(rule);
    return Object.freeze({
      id: rule.id || `${rule.domain}:${rule.rule_key}:${rule.input_key || ''}`,
      lens,
      label,
      ruleKey: rule.rule_key,
      input: rule.input_key,
      output: rule.output_value,
      description: rule.description,
      weights,
      reviewStatus: rule.review_status || 'review_required',
      sourceRef: rule.source_ref || 'ยังไม่ระบุ source',
      sourceClass: rule.source_class || 'unspecified',
      clinicalInferenceAllowed: rule.review_status === 'approved' && rule.metadata?.clinical_inference_allowed === true,
      metadata: rule.metadata || {}
    });
  }

  function topAxis(weights) {
    const entries = Object.entries(weights).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
    if (!entries.length || (entries[1] && entries[0][1] === entries[1][1])) return null;
    return entries[0][0];
  }

  function buildContextReasoning(input = {}, rules = [], asOf = new Date()) {
    const activeRules = rules.filter(rule => rule && rule.active !== false && rule.review_status !== 'rejected');
    const evidence = [];
    const conflicts = [];
    const gaps = [];
    const age = computeAge(input.birthDate, asOf);
    const weekday = weekdayThai(input.birthDate);

    const constitution = { weekday, age, birthElement: null, conceptionElement: null, evidence: [] };
    if (weekday) {
      const weekdayRule = activeRules.find(rule => rule.domain === 'birth_weekday' && String(rule.input_key || '').split(',').map(value => value.trim()).includes(weekday));
      if (weekdayRule) {
        constitution.birthElement = weekdayRule.output_value || weekdayRule.element || null;
        constitution.evidence.push(ruleEvidence(weekdayRule, 'constitution', `วันเกิด${weekday}`));
      } else gaps.push('ยังไม่มีกฎวันเกิดที่ตรงกับข้อมูลนี้');
    }

    const conceptionMonth = Number(input.conceptionMonth || 0);
    if (conceptionMonth >= 1 && conceptionMonth <= 12) {
      const conceptionRule = activeRules.find(rule => rule.domain === 'conception_month' && String(rule.input_key || '').split(',').map(Number).includes(conceptionMonth));
      if (conceptionRule) {
        constitution.conceptionElement = conceptionRule.output_value || conceptionRule.element || null;
        constitution.evidence.push(ruleEvidence(conceptionRule, 'constitution', `เดือนปฏิสนธิ ${conceptionMonth}`));
      } else gaps.push('ยังไม่มีกฎเดือนปฏิสนธิที่ตรงกับข้อมูลนี้');
    }

    if (age !== null) {
      const ageRules = ageRuleCandidates(age, activeRules);
      if (!ageRules.length) gaps.push('ยังไม่มีกฎอายุสมุฏฐานที่ตรงกับข้อมูลนี้');
      ageRules.forEach(rule => evidence.push(ruleEvidence(rule, 'age', `อายุ ${age} ปี`)));
      if (ageRules.length > 1) conflicts.push(`ขอบเขตอายุ ${age} ปีซ้อนกันในต้นทาง จึงไม่เลือกช่วงใดอัตโนมัติ`);
    }

    const kalaMode = KALA_DOMAINS[input.kalaMode] ? input.kalaMode : 'main';
    if (input.symptomTime) {
      const timeRules = activeRules.filter(rule => rule.domain === KALA_DOMAINS[kalaMode] && timeRuleMatches(input.symptomTime, rule.input_key));
      if (!timeRules.length) gaps.push(`ไม่พบกฎเวลา ${input.symptomTime} ในเลนส์ ${kalaMode}`);
      timeRules.forEach(rule => evidence.push(ruleEvidence(rule, 'time', `อาการเด่น ${input.symptomTime}`)));
    }

    const rawWeights = Object.fromEntries(Object.keys(AXES).map(axis => [axis, 0]));
    evidence.forEach(item => Object.entries(item.weights).forEach(([axis, weight]) => { rawWeights[axis] += Number(weight || 0); }));
    const contextPercent = normalizeWeights(rawWeights);

    const lensTops = new Map();
    for (const lens of ['age', 'time']) {
      const lensWeights = Object.fromEntries(Object.keys(AXES).map(axis => [axis, 0]));
      evidence.filter(item => item.lens === lens).forEach(item => Object.entries(item.weights).forEach(([axis, weight]) => { lensWeights[axis] += Number(weight || 0); }));
      const top = topAxis(lensWeights);
      if (top) lensTops.set(lens, top);
    }
    if (new Set(lensTops.values()).size > 1) {
      conflicts.push('อายุสมุฏฐานและกาลสมุฏฐานชี้คนละแกน ระบบจึงแยกเลนส์และไม่รวมเป็นข้อสรุปเดียว');
    }

    const findingCodes = new Set(Array.isArray(input.findingCodes) ? input.findingCodes.map(String).filter(Boolean) : []);
    const clinicalRules = activeRules.filter(rule => rule.review_status === 'approved'
      && rule.metadata?.clinical_inference_allowed === true
      && rule.metadata?.rule_role === 'finding_to_hypothesis');
    const clinicalEvidence = clinicalRules.filter(rule => {
      const required = Array.isArray(rule.metadata?.finding_codes)
        ? rule.metadata.finding_codes.map(String).filter(Boolean)
        : String(rule.input_key || '').split(',').map(value => value.trim()).filter(Boolean);
      if (!required.length || !findingCodes.size) return false;
      return rule.metadata?.match_policy === 'any'
        ? required.some(code => findingCodes.has(code))
        : required.every(code => findingCodes.has(code));
    }).map(rule => ruleEvidence(rule, 'clinical', 'สิ่งตรวจพบแบบ structured'));
    const clinicalRaw = Object.fromEntries(Object.keys(AXES).map(axis => [axis, 0]));
    clinicalEvidence.forEach(item => Object.entries(item.weights).forEach(([axis, weight]) => { clinicalRaw[axis] += Number(weight || 0); }));
    if (!clinicalRules.length) gaps.push('ยังไม่มีกฎอาการ/สิ่งตรวจพบ → สมมติฐาน ที่ผ่านการอนุมัติ');
    else if (!findingCodes.size) gaps.push('มีกฎคลินิกที่อนุมัติ แต่ยังไม่มี finding code แบบ structured สำหรับจับคู่');
    if (String(input.observationText || '').trim()) gaps.push('บันทึกอาการถูกเก็บเป็นหลักฐานอ่านประกอบ แต่ยังไม่ถูกแปลงเป็นคะแนนอัตโนมัติ');

    const clinicalPercent = normalizeWeights(clinicalRaw);
    const clinicalTop = topAxis(clinicalRaw);
    const approvedEvidenceCount = evidence.filter(item => item.reviewStatus === 'approved').length;
    const reviewEvidenceCount = evidence.filter(item => item.reviewStatus !== 'approved').length;
    return Object.freeze({
      input: { ...input, kalaMode },
      constitution: Object.freeze(constitution),
      evidence: Object.freeze(evidence),
      context: Object.freeze({ raw: Object.freeze(rawWeights), percent: Object.freeze(contextPercent), topAxis: topAxis(rawWeights), lensTops: Object.freeze(Object.fromEntries(lensTops)) }),
      clinical: Object.freeze({ raw: Object.freeze(clinicalRaw), percent: Object.freeze(clinicalPercent), topAxis: clinicalTop, approvedRuleCount: clinicalRules.length, evidenceCount: clinicalEvidence.length, evidence: Object.freeze(clinicalEvidence), status: clinicalTop ? 'candidate_only' : 'insufficient_evidence' }),
      hypothesis: Object.freeze({ axis: AXES[input.hypothesisAxis] ? input.hypothesisAxis : null, state: ['กำเริบ', 'หย่อน', 'พิการ'].includes(input.hypothesisState) ? input.hypothesisState : null, practitionerConfirmed: false }),
      conflicts: Object.freeze(conflicts),
      gaps: Object.freeze(gaps),
      counts: Object.freeze({ approvedEvidence: approvedEvidenceCount, reviewRequiredEvidence: reviewEvidenceCount })
    });
  }

  function coverageByDomain(rules = []) {
    const map = new Map();
    for (const rule of rules) {
      if (!rule?.domain || rule.active === false) continue;
      const item = map.get(rule.domain) || { domain: rule.domain, total: 0, approved: 0, reviewRequired: 0, rejected: 0 };
      item.total += 1;
      if (rule.review_status === 'approved') item.approved += 1;
      else if (rule.review_status === 'rejected') item.rejected += 1;
      else item.reviewRequired += 1;
      map.set(rule.domain, item);
    }
    return [...map.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  }

  globalThis.ChananyaTtmReasoning = Object.freeze({
    AXES,
    KALA_DOMAINS,
    computeAge,
    weekdayThai,
    parseClock,
    timeRuleMatches,
    parseDoshaWeights,
    normalizeWeights,
    buildContextReasoning,
    coverageByDomain
  });
})();
