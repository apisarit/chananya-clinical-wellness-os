(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));

  const TYPE_LABELS = Object.freeze({
    cosmology: 'โลกและแบบจำลองมนุษย์', constitution: 'ธาตุเจ้าเรือน', element: 'ธาตุ',
    dhatu_state: 'สถานะธาตุ', samutthan: 'สมุฏฐาน', coordinate: 'พิกัด', organ: 'อวัยวะ/รูปธาตุ',
    disease: 'โรคแผนไทย', symptom: 'อาการ', specialty: 'องค์ความรู้เฉพาะ', canon: 'คัมภีร์',
    therapeutic_principle: 'หลักการรักษา', formula: 'ตำรับยา', herb: 'สมุนไพร', taste: 'รสยา',
    procedure: 'หัตถการ', sen_line: 'เส้น', knowledge_rule: 'กฎความรู้', category: 'หมวดรากวิชา'
  });

  const LEGACY_DOMAIN = Object.freeze({
    constitution: ['constitution', 1], birth_weekday: ['constitution', 1],
    age_samutthan: ['samutthan', 2], kala_samutthan: ['samutthan', 2],
    coordinate: ['coordinate', 2]
  });

  let db;
  let session;
  let profile;
  let selectedLayer = 'all';
  let state = { mode: 'loading', concepts: [], sources: [], relations: [] };

  function sourceOf(concept) {
    return state.sources.find(source => source.id === concept.source_id || source.source_code === concept.source_code) || null;
  }

  function layerOf(concept) {
    const explicit = Number(concept.foundation_layer);
    if (explicit >= 1 && explicit <= 5) return explicit;
    if (['cosmology', 'constitution', 'element'].includes(concept.concept_type)) return 1;
    if (['dhatu_state', 'samutthan', 'coordinate', 'organ'].includes(concept.concept_type)) return 2;
    if (['disease', 'symptom', 'specialty', 'canon'].includes(concept.concept_type)) return 3;
    if (['therapeutic_principle', 'formula', 'herb', 'taste'].includes(concept.concept_type)) return 4;
    if (['procedure', 'sen_line'].includes(concept.concept_type)) return 5;
    return 2;
  }

  function setMode(text, warning = false) {
    const mode = $('#foundation-mode');
    mode.textContent = text;
    mode.classList.toggle('warning-badge', warning);
  }

  async function loadOntology() {
    const [conceptResult, sourceResult, relationResult] = await Promise.all([
      db.from('ttm_concepts').select('id,concept_code,concept_type,preferred_term_th,preferred_term_en,foundation_layer,definition,review_status,version,active,metadata').eq('active', true).order('foundation_layer').order('preferred_term_th'),
      db.from('ttm_sources').select('id,source_code,title_th,title_en,source_type,citation,review_status,version,active').eq('active', true).order('title_th'),
      db.from('ttm_concept_relations').select('id,subject_concept_id,predicate,object_concept_id,source_id,evidence_note,review_status,version,active').eq('active', true)
    ]);
    if (conceptResult.error) throw conceptResult.error;
    if (sourceResult.error) throw sourceResult.error;
    if (relationResult.error) throw relationResult.error;
    state = {
      mode: 'ontology',
      concepts: conceptResult.data || [],
      sources: sourceResult.data || [],
      relations: relationResult.data || []
    };
    setMode('Ontology foundation • source-traceable');
  }

  async function loadLegacy() {
    const [ruleResult, senResult] = await Promise.all([
      db.from('ttm_diagnostic_knowledge').select('*').eq('active', true).order('domain').order('rule_key'),
      db.from('sen_line_master').select('code,name_th,name_en,description,clinical_notes,is_active').eq('is_active', true).order('code')
    ]);
    if (ruleResult.error) throw ruleResult.error;
    const rules = ruleResult.data || [];
    const sourceMap = new Map();
    const concepts = rules.map(rule => {
      const [conceptType, foundationLayer] = LEGACY_DOMAIN[rule.domain] || ['knowledge_rule', 2];
      const sourceCode = rule.source_ref ? `legacy:${rule.source_ref}` : 'legacy:unspecified';
      if (!sourceMap.has(sourceCode)) {
        sourceMap.set(sourceCode, {
          id: sourceCode,
          source_code: sourceCode,
          title_th: rule.source_ref || 'ยังไม่ระบุแหล่งอ้างอิง',
          source_type: 'legacy_reference',
          citation: rule.source_ref || null,
          review_status: rule.review_status || 'review_required',
          version: rule.version || 'TTM-DKR-v1'
        });
      }
      return {
        id: rule.id,
        concept_code: `legacy.${rule.domain}.${rule.id}`,
        concept_type: conceptType,
        preferred_term_th: rule.input_key || rule.rule_key,
        preferred_term_en: null,
        foundation_layer: foundationLayer,
        definition: [rule.output_value, rule.description].filter(Boolean).join(' — '),
        review_status: rule.review_status || 'review_required',
        version: rule.version || 'TTM-DKR-v1',
        source_code: sourceCode,
        metadata: { domain: rule.domain, rule_key: rule.rule_key, element: rule.element }
      };
    });
    if (!senResult.error) {
      for (const line of senResult.data || []) {
        concepts.push({
          id: `sen:${line.code}`,
          concept_code: `sen.${line.code}`,
          concept_type: 'sen_line',
          preferred_term_th: line.name_th,
          preferred_term_en: line.name_en,
          foundation_layer: 5,
          definition: line.description || line.clinical_notes || 'ยังเป็นรหัส placeholder และต้องลงชื่อเส้น/แนวเส้นที่รับรอง',
          review_status: line.name_th?.startsWith('แนวเส้น S.') ? 'review_required' : 'approved',
          version: 'legacy-sen-line',
          source_code: 'legacy:sen-line-master',
          metadata: { code: line.code }
        });
      }
      sourceMap.set('legacy:sen-line-master', {
        id: 'legacy:sen-line-master', source_code: 'legacy:sen-line-master', title_th: 'Sen Line Master เดิม',
        source_type: 'legacy_master', citation: null, review_status: 'review_required', version: 'legacy-sen-line'
      });
    }
    state = { mode: 'legacy', concepts, sources: [...sourceMap.values()], relations: [] };
    setMode('Legacy bridge • รอใช้ ontology migration', true);
  }

  function updateStats() {
    const approved = state.concepts.filter(concept => concept.review_status === 'approved').length;
    $('#foundation-source-count').textContent = state.sources.length;
    $('#foundation-concept-count').textContent = state.concepts.length;
    $('#foundation-relation-count').textContent = state.relations.length;
    $('#foundation-approved-count').textContent = approved;
    $('#foundation-review-count').textContent = state.concepts.length - approved;
    $('#layer-count-all').textContent = state.concepts.length;
    for (let layer = 1; layer <= 5; layer += 1) {
      $(`#layer-count-${layer}`).textContent = state.concepts.filter(concept => layerOf(concept) === layer).length;
    }
  }

  function renderTypeOptions() {
    const types = [...new Set(state.concepts.map(concept => concept.concept_type).filter(Boolean))].sort();
    $('#foundation-type').innerHTML = '<option value="">ทุกชนิด</option>' + types.map(type => `<option value="${esc(type)}">${esc(TYPE_LABELS[type] || type)}</option>`).join('');
  }

  function visibleConcepts() {
    const search = $('#foundation-search').value.trim().toLocaleLowerCase('th');
    const type = $('#foundation-type').value;
    return state.concepts.filter(concept => {
      if (selectedLayer !== 'all' && layerOf(concept) !== Number(selectedLayer)) return false;
      if (type && concept.concept_type !== type) return false;
      if (!search) return true;
      const source = sourceOf(concept);
      const haystack = [concept.preferred_term_th, concept.preferred_term_en, concept.definition, concept.concept_code, source?.title_th, source?.citation, concept.metadata?.domain, concept.metadata?.element].filter(Boolean).join(' ').toLocaleLowerCase('th');
      return haystack.includes(search);
    });
  }

  function renderConcepts() {
    const concepts = visibleConcepts();
    $('#foundation-result-meta').textContent = `พบ ${concepts.length} จาก ${state.concepts.length} แนวคิด`;
    $('#foundation-results').innerHTML = concepts.map(concept => {
      const source = sourceOf(concept);
      const status = concept.review_status === 'approved' ? 'รับรองแล้ว' : 'รอทบทวน';
      return `<button type="button" class="foundation-concept" data-foundation-concept="${esc(concept.id)}"><span class="foundation-concept-main"><small>ชั้น ${layerOf(concept)} • ${esc(TYPE_LABELS[concept.concept_type] || concept.concept_type)}</small><b>${esc(concept.preferred_term_th)}</b><span>${esc(concept.definition || 'ยังไม่มีคำอธิบายที่รับรอง')}</span></span><span class="foundation-concept-side"><em class="${concept.review_status === 'approved' ? 'approved' : 'review'}">${status}</em><small>${esc(source?.title_th || concept.version || 'ไม่ระบุ source')}</small></span></button>`;
    }).join('') || '<div class="status">ไม่พบแนวคิดตามตัวกรองนี้</div>';
    $$('[data-foundation-concept]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.foundationConcept)));
  }

  function showDetail(conceptId) {
    const concept = state.concepts.find(item => String(item.id) === String(conceptId));
    if (!concept) return;
    const source = sourceOf(concept);
    const outgoing = state.relations.filter(relation => relation.subject_concept_id === concept.id);
    const incoming = state.relations.filter(relation => relation.object_concept_id === concept.id);
    const relationRows = [...outgoing.map(relation => ({ relation, direction: 'out' })), ...incoming.map(relation => ({ relation, direction: 'in' }))];
    const relationMarkup = relationRows.map(({ relation, direction }) => {
      const peerId = direction === 'out' ? relation.object_concept_id : relation.subject_concept_id;
      const peer = state.concepts.find(item => item.id === peerId);
      const arrow = direction === 'out' ? '→' : '←';
      return `<li><span>${arrow} ${esc(relation.predicate)}</span><b>${esc(peer?.preferred_term_th || peerId)}</b><small>${esc(relation.evidence_note || relation.review_status || '')}</small></li>`;
    }).join('') || '<li><span>ยังไม่มี relation แบบโครงสร้าง</span><small>Legacy flat rule จะถูกเชื่อมหลังใช้ foundation migration</small></li>';
    $('#foundation-detail-content').className = 'foundation-detail-content';
    $('#foundation-detail-content').innerHTML = `<span class="badge">ชั้น ${layerOf(concept)} • ${esc(TYPE_LABELS[concept.concept_type] || concept.concept_type)}</span><h3>${esc(concept.preferred_term_th)}</h3><p>${esc(concept.definition || 'ยังไม่มีคำอธิบายที่รับรอง')}</p><dl><dt>Concept code</dt><dd>${esc(concept.concept_code)}</dd><dt>สถานะ</dt><dd>${esc(concept.review_status || 'review_required')}</dd><dt>Version</dt><dd>${esc(concept.version || '-')}</dd><dt>แหล่งอ้างอิง</dt><dd>${esc(source?.title_th || 'ยังไม่ผูก source')}</dd><dt>Citation</dt><dd>${esc(source?.citation || 'ยังไม่มี citation ระดับหน้า/ข้อความ')}</dd></dl><h4>ความสัมพันธ์</h4><ul>${relationMarkup}</ul>`;
  }

  function bindFilters() {
    $('#foundation-search').addEventListener('input', renderConcepts);
    $('#foundation-type').addEventListener('change', renderConcepts);
    $('#foundation-reset').addEventListener('click', () => {
      selectedLayer = 'all';
      $('#foundation-search').value = '';
      $('#foundation-type').value = '';
      $$('[data-foundation-layer]').forEach(button => button.classList.toggle('active', button.dataset.foundationLayer === 'all'));
      renderConcepts();
    });
    $$('[data-foundation-layer]').forEach(button => button.addEventListener('click', () => {
      selectedLayer = button.dataset.foundationLayer;
      $$('[data-foundation-layer]').forEach(item => item.classList.toggle('active', item === button));
      renderConcepts();
    }));
  }

  async function init() {
    try {
      const runtime = window.ChananyaRuntime;
      if (!runtime) throw new Error('ChananyaRuntime ไม่พร้อมใช้งาน');
      db = runtime.getDb();
      session = await runtime.getSession();
      if (!session) { location.replace('/login.html'); return; }
      profile = await runtime.getProfile(session.user.id);
      if (!profile) throw new Error('ไม่พบ Profile');
      if (!runtime.can(profile, 'knowledge_read')) throw new Error('บัญชีนี้ไม่มีสิทธิ์อ่านรากวิชา');
      window.ChananyaShell?.mount({ profile, session, active: 'foundation' });
      try {
        await loadOntology();
      } catch (ontologyError) {
        console.warn('Foundation ontology is not installed; using legacy bridge', ontologyError);
        await loadLegacy();
      }
      updateStats();
      renderTypeOptions();
      bindFilters();
      renderConcepts();
      $('#app').classList.remove('hidden');
      $('#boot').classList.add('hidden');
    } catch (error) {
      console.error(error);
      $('#boot-error').textContent = error.message;
    }
  }

  $('#logout').addEventListener('click', async () => { await db.auth.signOut(); location.replace('/login.html'); });
  init();
})();
