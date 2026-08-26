begin;

-- Chananya Thai Medicine Foundation
-- Canon / dataset -> concept -> relation -> encounter evidence -> practitioner confirmation.
-- This is additive. Existing TTM-DKR-v1 rules and clinical records remain unchanged.

create extension if not exists pgcrypto;

create table if not exists public.ttm_sources (
  id uuid primary key default gen_random_uuid(),
  source_code text not null unique,
  title_th text not null,
  title_en text,
  source_type text not null,
  edition text,
  citation text,
  provenance text not null default 'source_derived',
  review_status text not null default 'review_required'
    check (review_status in ('review_required','approved','rejected')),
  version text not null default '1',
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ttm_concepts (
  id uuid primary key default gen_random_uuid(),
  concept_code text not null,
  concept_type text not null,
  preferred_term_th text not null,
  preferred_term_en text,
  foundation_layer smallint not null check (foundation_layer between 1 and 5),
  definition text,
  source_id uuid references public.ttm_sources(id) on delete set null,
  review_status text not null default 'review_required'
    check (review_status in ('review_required','approved','rejected')),
  version text not null default 'TTM-FOUNDATION-v1',
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(concept_code, version)
);

create table if not exists public.ttm_concept_terms (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references public.ttm_concepts(id) on delete cascade,
  term text not null,
  language_code text not null default 'th',
  term_type text not null default 'synonym'
    check (term_type in ('preferred','synonym','historic','transliteration','abbreviation')),
  source_id uuid references public.ttm_sources(id) on delete set null,
  review_status text not null default 'review_required'
    check (review_status in ('review_required','approved','rejected')),
  created_at timestamptz not null default now(),
  unique(concept_id, term, language_code, term_type)
);

create table if not exists public.ttm_concept_relations (
  id uuid primary key default gen_random_uuid(),
  subject_concept_id uuid not null references public.ttm_concepts(id) on delete cascade,
  predicate text not null,
  object_concept_id uuid not null references public.ttm_concepts(id) on delete cascade,
  source_id uuid references public.ttm_sources(id) on delete set null,
  evidence_note text,
  qualifiers jsonb not null default '{}'::jsonb,
  review_status text not null default 'review_required'
    check (review_status in ('review_required','approved','rejected')),
  version text not null default 'TTM-FOUNDATION-v1',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(subject_concept_id, predicate, object_concept_id, source_id, version)
);

create table if not exists public.ttm_encounter_concepts (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  concept_id uuid not null references public.ttm_concepts(id) on delete restrict,
  usage_role text not null check (usage_role in (
    'presenting_symptom','finding','samutthan','element','dhatu_state','coordinate',
    'organ','thai_diagnosis','differential','treatment_principle','formula','herb',
    'procedure','sen_line','outcome'
  )),
  assertion_status text not null default 'present'
    check (assertion_status in ('present','suspected','absent','considered','resolved')),
  evidence_note text,
  practitioner_confirmed boolean not null default false,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(encounter_id, concept_id, usage_role, assertion_status)
);

create index if not exists idx_ttm_concepts_layer_type
  on public.ttm_concepts(foundation_layer, concept_type, active, review_status);
create index if not exists idx_ttm_concepts_source
  on public.ttm_concepts(source_id) where source_id is not null;
create index if not exists idx_ttm_relations_subject
  on public.ttm_concept_relations(subject_concept_id, predicate) where active;
create index if not exists idx_ttm_relations_object
  on public.ttm_concept_relations(object_concept_id, predicate) where active;
create index if not exists idx_ttm_encounter_concepts_encounter
  on public.ttm_encounter_concepts(encounter_id, usage_role);

insert into public.ttm_sources(
  source_code,title_th,title_en,source_type,citation,provenance,review_status,version,metadata
) values
  ('TTM-DKR-v1','TTM Diagnostic Knowledge Review v1','TTM Diagnostic Knowledge Review v1','owner_dataset','ฐานข้อมูลที่เจ้าของโครงการส่งมอบ','source_derived','review_required','1',jsonb_build_object('legacy_table','ttm_diagnostic_knowledge')),
  ('HOUSE-ELEMENT-OFFICIAL','โหราเวชศาสตร์ทางการแพทย์แผนไทย: องค์ความรู้ธาตุเจ้าเรือนในการดูแลสุขภาพ',null,'official_academic_document','กลุ่มงานวิชาการเวชกรรมไทย สถาบันการแพทย์แผนไทย กรมการแพทย์แผนไทยและการแพทย์ทางเลือก','primary_source','approved','1','{}'::jsonb),
  ('OPD-TTM-070869','OPD เวชกรรมไทยฉบับแก้ไข 7-8-69',null,'clinical_form','แบบอ้างอิงโครงสร้างการซักประวัติและตรวจร่างกาย','owner_dataset','review_required','1','{}'::jsonb),
  ('PHRA-KHAMPI-CHANDASAT','พระคัมภีร์ฉันทศาสตร์',null,'canon','ต้องลงฉบับ เล่ม และหน้าที่ใช้อ้างอิงให้ครบก่อนรับรอง relation','source_derived','review_required','1','{}'::jsonb)
on conflict (source_code) do nothing;

with concept_seed(concept_code,concept_type,preferred_term_th,preferred_term_en,foundation_layer,definition,source_code,review_status,metadata) as (
  values
    ('element.pathavi','element','ปถวีธาตุ','Earth element',1,'ธาตุดิน/โครงสร้าง; ต้องเชื่อมรายละเอียดรูปธาตุจากแหล่งอ้างอิงที่รับรอง','TTM-DKR-v1','review_required','{}'::jsonb),
    ('element.apo','element','อาโปธาตุ','Water element',1,'ธาตุน้ำ; ต้องเชื่อมรายละเอียดรูปธาตุจากแหล่งอ้างอิงที่รับรอง','TTM-DKR-v1','review_required','{}'::jsonb),
    ('element.vayo','element','วาโยธาตุ','Wind element',1,'ธาตุลม; ต้องเชื่อมรายละเอียดรูปธาตุจากแหล่งอ้างอิงที่รับรอง','TTM-DKR-v1','review_required','{}'::jsonb),
    ('element.tejo','element','เตโชธาตุ','Fire element',1,'ธาตุไฟ; ต้องเชื่อมรายละเอียดรูปธาตุจากแหล่งอ้างอิงที่รับรอง','TTM-DKR-v1','review_required','{}'::jsonb),
    ('constitution.birth','constitution','ธาตุเจ้าเรือนเกิด','Birth constitution',1,'พิจารณาจากวันเดือนปีเกิด และต้องไม่แทนค่าธาตุปัจจุบันอัตโนมัติ','HOUSE-ELEMENT-OFFICIAL','approved','{}'::jsonb),
    ('constitution.current','constitution','ธาตุเจ้าเรือนปัจจุบัน','Current constitution',1,'ประเมินจากบุคลิกลักษณะ อุปนิสัย และภาวะสุขภาพปัจจุบัน','HOUSE-ELEMENT-OFFICIAL','approved','{}'::jsonb),

    ('dosha.pitta','samutthan','ปิตตะ','Pitta',2,'แกนวินิจฉัยเชิงหน้าที่ ต้องเชื่อมพิกัดและสภาวะธาตุโดยมี source','TTM-DKR-v1','review_required','{}'::jsonb),
    ('dosha.vata','samutthan','วาตะ','Vata',2,'แกนวินิจฉัยเชิงหน้าที่ ต้องเชื่อมพิกัดและสภาวะธาตุโดยมี source','TTM-DKR-v1','review_required','{}'::jsonb),
    ('dosha.semha','samutthan','เสมหะ','Semha',2,'แกนวินิจฉัยเชิงหน้าที่ ต้องเชื่อมพิกัดและสภาวะธาตุโดยมี source','TTM-DKR-v1','review_required','{}'::jsonb),
    ('dhatu_state.excess','dhatu_state','กำเริบ','Excess',2,'สถานะธาตุ; การใช้กับผู้ป่วยต้องได้รับการยืนยันจากผู้ประกอบวิชาชีพ','TTM-DKR-v1','review_required','{}'::jsonb),
    ('dhatu_state.deficient','dhatu_state','หย่อน','Deficient',2,'สถานะธาตุ; การใช้กับผู้ป่วยต้องได้รับการยืนยันจากผู้ประกอบวิชาชีพ','TTM-DKR-v1','review_required','{}'::jsonb),
    ('dhatu_state.disordered','dhatu_state','พิการ','Disordered',2,'สถานะธาตุ; การใช้กับผู้ป่วยต้องได้รับการยืนยันจากผู้ประกอบวิชาชีพ','TTM-DKR-v1','review_required','{}'::jsonb),
    ('samutthan.dhatu','samutthan','ธาตุสมุฏฐาน','Dhatu Samutthan',2,null,'TTM-DKR-v1','review_required','{}'::jsonb),
    ('samutthan.utu','samutthan','อุตุสมุฏฐาน','Utu Samutthan',2,null,'TTM-DKR-v1','review_required','{}'::jsonb),
    ('samutthan.ayu','samutthan','อายุสมุฏฐาน','Ayu Samutthan',2,null,'TTM-DKR-v1','review_required','{}'::jsonb),
    ('samutthan.kala','samutthan','กาลสมุฏฐาน','Kala Samutthan',2,null,'TTM-DKR-v1','review_required','{}'::jsonb),
    ('samutthan.pradesa','samutthan','ประเทศสมุฏฐาน','Pradesa Samutthan',2,null,'TTM-DKR-v1','review_required','{}'::jsonb),
    ('samutthan.season','samutthan','ฤดูสมุฏฐาน','Seasonal Samutthan',2,'รองรับฤดู 4 ฤดู 6 และฤดูพิสดาร โดยต้องเก็บ version/source','TTM-DKR-v1','review_required','{}'::jsonb),
    ('samutthan.zodiac','samutthan','ราศีสมุฏฐาน','Zodiac Samutthan',2,'เป็นบริบทแผนไทยตาม source ไม่ใช่ BaZi และไม่วินิจฉัยอัตโนมัติ','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.pitta.pattha','coordinate','พัทธปิตตะ',null,2,'ดีในฝัก','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.pitta.apattha','coordinate','อพัทธปิตตะ',null,2,'ดีนอกฝัก','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.pitta.kamdao','coordinate','กำเดา',null,2,'เปลวความร้อน/ความร้อนภายใน/ไข้/ตัวร้อน','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.vata.hathai','coordinate','หทัยวาตะ',null,2,'ลมเกี่ยวกับการเต้นหัวใจ จิตใจ และสภาพอารมณ์','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.vata.satthaka','coordinate','สัตถกวาตะ',null,2,'ลมแหลมคม; ระบบประสาทและเส้นเลือดฝอย','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.vata.sumana','coordinate','สุมนาวาตะ',null,2,'ลมจากหัวใจและหลอดเลือดใหญ่กลางลำตัว','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.semha.saw','coordinate','ศอเสมหะ',null,2,'ทางเดินหายใจส่วนบน เมือกในลำคอ และหลอดลมตอนต้น','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.semha.ura','coordinate','อุระเสมหะ',null,2,'ทรวงอก ปอด เสมหะ/น้ำย่อยบริเวณช่วงกลางตัว','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.semha.kutha','coordinate','คูถเสมหะ',null,2,'ทางเดินอาหารส่วนปลายและบริบทของน้ำในส่วนล่าง','TTM-DKR-v1','review_required','{}'::jsonb),
    ('coordinate.pathavi','coordinate','ปถวีธาตุ/รูปธาตุ',null,2,'โครงสร้างและอวัยวะ ต้องแตกเป็นรูปธาตุที่มี source รองรับ','TTM-DKR-v1','review_required','{}'::jsonb),
    ('category.rupadhatu42','organ','รูปธาตุ 42 และอวัยวะแผนไทย','Rupa-dhatu and TTM organs',2,'ทะเบียนอวัยวะและรูปธาตุยังต้องเติมจากคัมภีร์ที่รับรอง','TTM-DKR-v1','review_required',jsonb_build_object('coverage','required')),

    ('category.canon','canon','ทะเบียนคัมภีร์แพทย์แผนไทย','Thai medicine canon registry',3,'ทุกข้อวินิจฉัยต้องย้อนกลับมาที่คัมภีร์/ชุดข้อมูลและ citation ได้','PHRA-KHAMPI-CHANDASAT','review_required',jsonb_build_object('coverage','required')),
    ('category.disease','disease','ทะเบียนโรคแผนไทย','Thai medicine disease registry',3,'โรคแผนไทยเป็น primary ontology; ICD/WHO อยู่ชั้น mapping ภายหลัง','TTM-DKR-v1','review_required',jsonb_build_object('coverage','required')),
    ('category.symptom','symptom','ทะเบียนอาการแผนไทย','Thai medicine symptom registry',3,'ต้องเชื่อมอาการกับธาตุ สมุฏฐาน พิกัด อวัยวะ และโรคโดยมี source','TTM-DKR-v1','review_required',jsonb_build_object('target_groups',jsonb_build_object('pitta',42,'vata',80,'semha',20))),
    ('category.specialty','specialty','คัมภีร์และเวชกรรมเฉพาะสาขา','Specialty knowledge',3,'แยกองค์ความรู้เฉพาะ ไม่ยุบรวมเป็นช่องข้อความเดียว','PHRA-KHAMPI-CHANDASAT','review_required',jsonb_build_object('coverage','required')),

    ('category.therapeutic_principle','therapeutic_principle','หลักการรักษาแผนไทย','TTM therapeutic principles',4,'เชื่อม diagnosis กับเหตุผลการรักษา ไม่ข้ามจากอาการไปสั่งยาโดยตรง','TTM-DKR-v1','review_required',jsonb_build_object('coverage','required')),
    ('category.formula','formula','ทะเบียนตำรับยา','Formula registry',4,'ต้องเชื่อมสูตร ส่วนประกอบ ปริมาณ หน่วย revision และข้อควรระวัง','TTM-DKR-v1','review_required',jsonb_build_object('coverage','required')),
    ('category.herb','herb','ทะเบียนสมุนไพรและเภสัชวัตถุ','Herb and materia medica registry',4,'เชื่อมส่วนใช้ รสยา สรรพคุณ ข้อห้าม และแหล่งอ้างอิง','TTM-DKR-v1','review_required',jsonb_build_object('coverage','required')),
    ('category.taste','taste','รสยาและพิกัดเภสัชกรรม','Taste and pharmacy coordinates',4,'ใช้เป็น ontology เภสัชกรรม ไม่ใช่ข้อความ free text','TTM-DKR-v1','review_required',jsonb_build_object('coverage','required')),

    ('category.procedure','procedure','ทะเบียนหัตถการแพทย์แผนไทย','TTM procedure registry',5,'เชื่อมข้อบ่งใช้ ข้อห้าม ขั้นตอน และ outcome','OPD-TTM-070869','review_required',jsonb_build_object('coverage','required')),
    ('category.sen_prathan_sip','sen_line','เส้นประธานสิบ','Sen Prathan Sip',5,'ต้องแทนรหัส placeholder ด้วยชื่อ แนวเส้น จุด และ source ที่รับรอง','OPD-TTM-070869','review_required',jsonb_build_object('coverage','required')),
    ('category.body_point','procedure','จุดและตำแหน่งหัตถการ','Body points and treatment locations',5,'เชื่อม Body Map กับเส้น/จุดและวิธีรักษาที่รับรอง','OPD-TTM-070869','review_required',jsonb_build_object('coverage','required'))
)
insert into public.ttm_concepts(
  concept_code,concept_type,preferred_term_th,preferred_term_en,foundation_layer,
  definition,source_id,review_status,version,metadata
)
select seed.concept_code,seed.concept_type,seed.preferred_term_th,seed.preferred_term_en,
       seed.foundation_layer,seed.definition,source.id,seed.review_status,'TTM-FOUNDATION-v1',seed.metadata
from concept_seed seed
left join public.ttm_sources source on source.source_code=seed.source_code
on conflict (concept_code,version) do nothing;

with relation_seed(subject_code,predicate,object_code,source_code,evidence_note,review_status) as (
  values
    ('constitution.birth','distinct_from','constitution.current','HOUSE-ELEMENT-OFFICIAL','ธาตุเจ้าเรือนเกิดและธาตุปัจจุบันเป็นคนละการประเมิน','approved'),
    ('dosha.pitta','associated_element','element.tejo','TTM-DKR-v1','mapping จากพิกัดปิตตะใน dataset เดิม','review_required'),
    ('dosha.vata','associated_element','element.vayo','TTM-DKR-v1','mapping จากพิกัดวาตะใน dataset เดิม','review_required'),
    ('dosha.semha','associated_element','element.apo','TTM-DKR-v1','mapping จากพิกัดเสมหะใน dataset เดิม','review_required'),
    ('coordinate.pitta.pattha','coordinate_of','dosha.pitta','TTM-DKR-v1','พิกัดปิตตะ','review_required'),
    ('coordinate.pitta.apattha','coordinate_of','dosha.pitta','TTM-DKR-v1','พิกัดปิตตะ','review_required'),
    ('coordinate.pitta.kamdao','coordinate_of','dosha.pitta','TTM-DKR-v1','พิกัดปิตตะ','review_required'),
    ('coordinate.vata.hathai','coordinate_of','dosha.vata','TTM-DKR-v1','พิกัดวาตะ','review_required'),
    ('coordinate.vata.satthaka','coordinate_of','dosha.vata','TTM-DKR-v1','พิกัดวาตะ','review_required'),
    ('coordinate.vata.sumana','coordinate_of','dosha.vata','TTM-DKR-v1','พิกัดวาตะ','review_required'),
    ('coordinate.semha.saw','coordinate_of','dosha.semha','TTM-DKR-v1','พิกัดเสมหะ','review_required'),
    ('coordinate.semha.ura','coordinate_of','dosha.semha','TTM-DKR-v1','พิกัดเสมหะ','review_required'),
    ('coordinate.semha.kutha','coordinate_of','dosha.semha','TTM-DKR-v1','พิกัดเสมหะ','review_required'),
    ('coordinate.pathavi','associated_element','element.pathavi','TTM-DKR-v1','ปถวีธาตุ/โครงสร้างและอวัยวะ','review_required')
)
insert into public.ttm_concept_relations(
  subject_concept_id,predicate,object_concept_id,source_id,evidence_note,review_status,version
)
select subject.id,seed.predicate,object.id,source.id,seed.evidence_note,seed.review_status,'TTM-FOUNDATION-v1'
from relation_seed seed
join public.ttm_concepts subject on subject.concept_code=seed.subject_code and subject.version='TTM-FOUNDATION-v1'
join public.ttm_concepts object on object.concept_code=seed.object_code and object.version='TTM-FOUNDATION-v1'
left join public.ttm_sources source on source.source_code=seed.source_code
on conflict do nothing;

-- Preserve every existing flat TTM-DKR row as a traceable concept while the curated graph grows.
insert into public.ttm_concepts(
  concept_code,concept_type,preferred_term_th,foundation_layer,definition,source_id,
  review_status,version,metadata
)
select
  'legacy-rule.' || encode(digest(concat_ws('|',knowledge.domain,knowledge.rule_key,knowledge.input_key,knowledge.version),'sha256'),'hex'),
  case
    when knowledge.domain in ('constitution','birth_weekday') then 'constitution'
    when knowledge.domain in ('age_samutthan','kala_samutthan') then 'samutthan'
    when knowledge.domain='coordinate' then 'coordinate'
    else 'knowledge_rule'
  end,
  coalesce(nullif(knowledge.input_key,''),knowledge.rule_key),
  case when knowledge.domain in ('constitution','birth_weekday') then 1 else 2 end,
  concat_ws(' — ',nullif(knowledge.output_value,''),nullif(knowledge.description,'')),
  source.id,
  knowledge.review_status,
  coalesce(knowledge.version,'TTM-DKR-v1'),
  jsonb_build_object(
    'legacy_rule_id',knowledge.id,
    'domain',knowledge.domain,
    'rule_key',knowledge.rule_key,
    'element',knowledge.element,
    'source_ref',knowledge.source_ref
  )
from public.ttm_diagnostic_knowledge knowledge
left join public.ttm_sources source on source.source_code='TTM-DKR-v1'
where knowledge.active
on conflict (concept_code,version) do nothing;

create or replace view public.v_ttm_foundation_graph as
select
  relation.id as relation_id,
  subject.id as subject_id,
  subject.concept_code as subject_code,
  subject.preferred_term_th as subject_term_th,
  subject.concept_type as subject_type,
  subject.foundation_layer as subject_layer,
  relation.predicate,
  object.id as object_id,
  object.concept_code as object_code,
  object.preferred_term_th as object_term_th,
  object.concept_type as object_type,
  object.foundation_layer as object_layer,
  source.source_code,
  source.title_th as source_title_th,
  source.citation,
  relation.evidence_note,
  relation.review_status,
  relation.version
from public.ttm_concept_relations relation
join public.ttm_concepts subject on subject.id=relation.subject_concept_id
join public.ttm_concepts object on object.id=relation.object_concept_id
left join public.ttm_sources source on source.id=relation.source_id
where relation.active and subject.active and object.active;

create or replace view public.v_ttm_foundation_coverage as
select
  foundation_layer,
  concept_type,
  count(*) filter (where active) as active_concepts,
  count(*) filter (where active and review_status='approved') as approved_concepts,
  count(*) filter (where active and review_status='review_required') as review_required_concepts
from public.ttm_concepts
group by foundation_layer,concept_type;

alter table public.ttm_sources enable row level security;
alter table public.ttm_concepts enable row level security;
alter table public.ttm_concept_terms enable row level security;
alter table public.ttm_concept_relations enable row level security;
alter table public.ttm_encounter_concepts enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['ttm_sources','ttm_concepts','ttm_concept_terms','ttm_concept_relations'] loop
    execute format('drop policy if exists %I_read_authenticated on public.%I',table_name,table_name);
    execute format('create policy %I_read_authenticated on public.%I for select to authenticated using (true)',table_name,table_name);
    execute format('drop policy if exists %I_write_admin on public.%I',table_name,table_name);
    execute format('create policy %I_write_admin on public.%I for all to authenticated using (public.has_role(array[''admin''])) with check (public.has_role(array[''admin'']))',table_name,table_name);
  end loop;
end $$;

drop policy if exists ttm_encounter_concepts_read on public.ttm_encounter_concepts;
create policy ttm_encounter_concepts_read on public.ttm_encounter_concepts
for select to authenticated
using (public.has_role(array['admin','practitioner','pharmacy']));

drop policy if exists ttm_encounter_concepts_write on public.ttm_encounter_concepts;
create policy ttm_encounter_concepts_write on public.ttm_encounter_concepts
for all to authenticated
using (public.has_role(array['admin','practitioner']))
with check (public.has_role(array['admin','practitioner']));

grant select on public.ttm_sources,public.ttm_concepts,public.ttm_concept_terms,public.ttm_concept_relations to authenticated;
grant insert,update,delete on public.ttm_sources,public.ttm_concepts,public.ttm_concept_terms,public.ttm_concept_relations to authenticated;
grant select,insert,update,delete on public.ttm_encounter_concepts to authenticated;
grant select on public.v_ttm_foundation_graph,public.v_ttm_foundation_coverage to authenticated;

commit;

select
  'CHANANYA_TTM_FOUNDATION_READY' as status,
  (select count(*) from public.ttm_sources where active) as sources,
  (select count(*) from public.ttm_concepts where active) as concepts,
  (select count(*) from public.ttm_concept_relations where active) as relations;
