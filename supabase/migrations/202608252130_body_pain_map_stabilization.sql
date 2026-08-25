begin;

alter table public.body_pain_points add column if not exists side text;
alter table public.body_pain_points add column if not exists body_region text;
alter table public.body_pain_points add column if not exists sen_line_code text;
alter table public.body_pain_points add column if not exists point_label text;
alter table public.body_pain_points add column if not exists pain_pattern_code text;
alter table public.body_pain_points add column if not exists updated_at timestamptz not null default now();

alter table public.body_pain_points drop constraint if exists body_pain_points_side_check;
alter table public.body_pain_points add constraint body_pain_points_side_check
  check (side is null or side in ('left','right','bilateral','midline','not_specified'));

create index if not exists idx_body_pain_sen on public.body_pain_points(sen_line_code);
create index if not exists idx_body_pain_region on public.body_pain_points(body_region, side);

commit;

select 'CHANANYA_BODY_PAIN_MAP_STABILIZED' as status;
