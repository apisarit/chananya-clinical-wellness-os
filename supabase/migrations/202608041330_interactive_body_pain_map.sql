begin;

create extension if not exists pgcrypto;

alter table public.body_pain_points
  add column if not exists point_code text,
  add column if not exists pain_pattern_code text,
  add column if not exists body_region text,
  add column if not exists side text,
  add column if not exists sen_line_code text,
  add column if not exists marker_label text,
  add column if not exists coordinate_version text not null default 'chananya_bodymap_v1',
  add column if not exists updated_at timestamptz not null default now();

update public.body_pain_points
set point_code = 'PP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
where point_code is null or btrim(point_code) = '';

alter table public.body_pain_points
  alter column point_code set default ('PP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  alter column point_code set not null;

create unique index if not exists body_pain_points_point_code_uidx
  on public.body_pain_points(point_code);

create index if not exists body_pain_points_encounter_stage_idx
  on public.body_pain_points(encounter_id, assessment_stage, recorded_at);

create index if not exists body_pain_points_sen_line_idx
  on public.body_pain_points(sen_line_code)
  where sen_line_code is not null;

create table if not exists public.sen_line_master (
  code text primary key,
  name_th text not null,
  name_en text,
  description text,
  anatomical_course text,
  clinical_notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.sen_line_master(code, name_th)
select
  'S.' || lpad(n::text, 2, '0'),
  'แนวเส้น S.' || lpad(n::text, 2, '0')
from generate_series(1, 20) as n
on conflict (code) do nothing;

alter table public.sen_line_master enable row level security;

drop policy if exists sen_line_master_read_authenticated on public.sen_line_master;
create policy sen_line_master_read_authenticated
on public.sen_line_master
for select
to authenticated
using (true);

drop policy if exists sen_line_master_write_admin on public.sen_line_master;
create policy sen_line_master_write_admin
on public.sen_line_master
for all
to authenticated
using (public.has_role(array['admin']))
with check (public.has_role(array['admin']));

grant select on public.sen_line_master to authenticated;
grant insert, update, delete on public.sen_line_master to authenticated;
grant select, insert, update, delete on public.sen_line_master to service_role;

create or replace function public.set_body_pain_point_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  if new.point_code is null or btrim(new.point_code) = '' then
    new.point_code := 'PP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_body_pain_points_updated_at on public.body_pain_points;
create trigger trg_body_pain_points_updated_at
before insert or update on public.body_pain_points
for each row execute function public.set_body_pain_point_updated_at();

commit;

select
  'CHANANYA_INTERACTIVE_BODY_PAIN_MAP_READY' as status,
  count(*) filter (where column_name in (
    'point_code','pain_pattern_code','body_region','side',
    'sen_line_code','marker_label','coordinate_version','updated_at'
  )) as body_pain_columns_ready
from information_schema.columns
where table_schema = 'public'
  and table_name = 'body_pain_points';
