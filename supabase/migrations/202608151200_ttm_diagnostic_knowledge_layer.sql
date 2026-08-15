begin;

-- Chananya TTM Diagnostic Knowledge Layer
-- Source basis: TTM_Diagnostic_Knowledge_Review_v1.xlsx supplied by project owner.
-- IMPORTANT: rows marked review_required remain decision support only until practitioner review.

create table if not exists public.ttm_diagnostic_knowledge (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  rule_key text not null,
  input_key text,
  output_value text,
  element text,
  samutthan text,
  coordinate text,
  description text,
  source_ref text,
  source_class text not null default 'source_derived',
  review_status text not null default 'review_required' check (review_status in ('review_required','approved','rejected')),
  version text not null default 'TTM-DKR-v1',
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(domain, rule_key, input_key, version)
);

create index if not exists idx_ttm_knowledge_domain on public.ttm_diagnostic_knowledge(domain, active, review_status);

create table if not exists public.ttm_diagnostic_contexts (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null unique references public.encounters(id) on delete cascade,
  birth_element text,
  current_element text,
  primary_element text,
  secondary_element text,
  ayu_samutthan text,
  kala_samutthan text,
  season_4 text,
  season_6 text,
  season_pitsadan text,
  zodiac_samutthan text,
  pradesa_samutthan text,
  dosha_state text,
  coordinate text,
  mixed_coordinate text,
  derived_suggestions jsonb not null default '[]'::jsonb,
  practitioner_confirmed boolean not null default false,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  knowledge_version text not null default 'TTM-DKR-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Extend existing structured diagnosis without breaking old records.
alter table public.ttm_structured_diagnoses add column if not exists coordinate text;
alter table public.ttm_structured_diagnoses add column if not exists mixed_coordinate text;
alter table public.ttm_structured_diagnoses add column if not exists dosha_state text;
alter table public.ttm_structured_diagnoses add column if not exists season_4 text;
alter table public.ttm_structured_diagnoses add column if not exists season_6 text;
alter table public.ttm_structured_diagnoses add column if not exists season_pitsadan text;
alter table public.ttm_structured_diagnoses add column if not exists zodiac_samutthan text;
alter table public.ttm_structured_diagnoses add column if not exists knowledge_version text default 'TTM-DKR-v1';
alter table public.ttm_structured_diagnoses add column if not exists practitioner_confirmed boolean not null default false;

-- Seed only source-derived rules that can be represented without silently adding interpretation.
insert into public.ttm_diagnostic_knowledge(domain,rule_key,input_key,output_value,element,source_ref,source_class,review_status,description) values
('constitution','definition','ธาตุเจ้าเรือน/ธาตุกำเนิด','ธาตุทั้ง 4 มีครบ แต่มีธาตุหนึ่งเด่นกว่าธาตุอื่น เป็นลักษณะเฉพาะแต่กำเนิด',null,'เอกสารธาตุเจ้าเรือน หน้า 1','source_derived','approved','นิยาม'),
('constitution','type','ธาตุเจ้าเรือนเกิด','พิจารณาตามวันเดือนปีเกิด',null,'เอกสารธาตุเจ้าเรือน หน้า 3','source_derived','approved','แยกจากธาตุเจ้าเรือนปัจจุบัน'),
('constitution','type','ธาตุเจ้าเรือนปัจจุบัน','พิจารณาจากบุคลิกลักษณะ อุปนิสัย และภาวะสุขภาพ',null,'เอกสารธาตุเจ้าเรือน หน้า 3','source_derived','approved','ไม่ควรแทนค่าจากวันเกิดอัตโนมัติ'),
('birth_weekday','weekday','อาทิตย์, เสาร์','ธาตุไฟ','ไฟ','พระคัมภีร์ฉันทศาสตร์ ตามเอกสาร หน้า 2','source_derived','approved',null),
('birth_weekday','weekday','จันทร์, พฤหัสบดี','ธาตุดิน','ดิน','พระคัมภีร์ฉันทศาสตร์ ตามเอกสาร หน้า 2','source_derived','approved',null),
('birth_weekday','weekday','อังคาร','ธาตุลม','ลม','พระคัมภีร์ฉันทศาสตร์ ตามเอกสาร หน้า 2','source_derived','approved',null),
('birth_weekday','weekday','พุธ, ศุกร์','ธาตุน้ำ','น้ำ','พระคัมภีร์ฉันทศาสตร์ ตามเอกสาร หน้า 2','source_derived','approved',null),
('age_samutthan','ปฐมวัย','แรกเกิด–16 ปี','เสมหะ',null,'03_อายุสมุฏฐาน','image_transcribed','review_required','เสมหะเป็นอาทิ วาตะเป็นที่สุด'),
('age_samutthan','มัชฌิมวัย','16–30 ปี','ปิตตะ',null,'03_อายุสมุฏฐาน','image_transcribed','review_required','ปิตตะเป็นต้น เสมหะเป็นที่สุด'),
('age_samutthan','ปัจฉิมวัย','30 ปี–เสียชีวิต','วาตะ',null,'03_อายุสมุฏฐาน','image_transcribed','review_required','วาตะเป็นต้น ปิตตะเป็นที่สุด'),
('kala_samutthan','main','06:00-10:00 / 18:00-22:00','เสมหะ',null,'04_กาลสมุฏฐาน','image_transcribed','review_required','บริโภคอาหาร, พลบค่ำ'),
('kala_samutthan','main','11:00-14:00 / 23:00-02:00','ปิตตะ',null,'04_กาลสมุฏฐาน','image_transcribed','review_required','อาหารยังไม่ย่อย, เที่ยงคืน'),
('kala_samutthan','main','15:00-18:00 / 03:00-06:00','วาตะ',null,'04_กาลสมุฏฐาน','image_transcribed','review_required','อาหารย่อยแล้ว, นอนหลับ'),
('coordinate','ปิตตะ','พัทธปิตตะ','ดีในฝัก','ไฟ','02_พิกัดสมุฏฐาน','source_derived','review_required','เกี่ยวกับระบบน้ำดีภายในถุงน้ำดีและตับ'),
('coordinate','ปิตตะ','อพัทธปิตตะ','ดีนอกฝัก','ไฟ','02_พิกัดสมุฏฐาน','source_derived','review_required','เกี่ยวกับน้ำดี/การย่อยอาหาร'),
('coordinate','ปิตตะ','กำเดา','เปลวความร้อน/ความร้อนภายใน/ไข้/ตัวร้อน','ไฟ','02_พิกัดสมุฏฐาน','source_derived','review_required',null),
('coordinate','วาตะ','หทัยวาตะ','ลมเกี่ยวกับการเต้นหัวใจ จิตใจ สภาพอารมณ์','ลม','02_พิกัดสมุฏฐาน','source_derived','review_required',null),
('coordinate','วาตะ','สัตถกวาตะ','ลมแหลมคม; ระบบประสาทและเส้นเลือดฝอย','ลม','02_พิกัดสมุฏฐาน','source_derived','review_required',null),
('coordinate','วาตะ','สุมนาวาตะ','ลมจากหัวใจและหลอดเลือดใหญ่กลางลำตัว','ลม','02_พิกัดสมุฏฐาน','source_derived','review_required',null),
('coordinate','เสมหะ','ศอเสมหะ','ทางเดินหายใจส่วนบน เมือกในลำคอ หลอดลมตอนต้น','น้ำ','02_พิกัดสมุฏฐาน','source_derived','review_required',null),
('coordinate','เสมหะ','อุระเสมหะ','ทรวงอก ปอด เสมหะ/น้ำย่อยบริเวณช่วงกลางตัว','น้ำ','02_พิกัดสมุฏฐาน','source_derived','review_required',null),
('coordinate','เสมหะ','คูถเสมหะ','ทางเดินอาหารส่วนปลาย เมือกมูกในลำไส้/น้ำในกระเพาะปัสสาวะ','น้ำ','02_พิกัดสมุฏฐาน','source_derived','review_required',null),
('coordinate','ปถวี','ปถวีธาตุ','โครงสร้าง/อวัยวะ เช่น กล้ามเนื้อ มดลูก หัวใจ กระดูก','ดิน','02_พิกัดสมุฏฐาน','source_derived','review_required',null)
on conflict do nothing;

alter table public.ttm_diagnostic_knowledge enable row level security;
alter table public.ttm_diagnostic_contexts enable row level security;

drop policy if exists ttm_diagnostic_knowledge_read on public.ttm_diagnostic_knowledge;
create policy ttm_diagnostic_knowledge_read on public.ttm_diagnostic_knowledge for select to authenticated using (true);

drop policy if exists ttm_diagnostic_contexts_read on public.ttm_diagnostic_contexts;
create policy ttm_diagnostic_contexts_read on public.ttm_diagnostic_contexts for select to authenticated using (public.has_role(array['admin','practitioner','pharmacy']));
drop policy if exists ttm_diagnostic_contexts_write on public.ttm_diagnostic_contexts;
create policy ttm_diagnostic_contexts_write on public.ttm_diagnostic_contexts for all to authenticated using (public.has_role(array['admin','practitioner'])) with check (public.has_role(array['admin','practitioner']));

grant select on public.ttm_diagnostic_knowledge to authenticated;
grant select,insert,update,delete on public.ttm_diagnostic_contexts to authenticated;

commit;

select 'CHANANYA_TTM_DIAGNOSTIC_KNOWLEDGE_READY' as status,
       (select count(*) from public.ttm_diagnostic_knowledge) as seeded_rules;
