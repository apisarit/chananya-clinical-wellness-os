begin;

-- ============================================================
-- SUPER ADMIN COMPATIBILITY BRIDGE
-- Keeps profiles.role = 'admin' temporarily so the existing
-- Clinical / Pharmacy / Production front ends remain compatible.
-- system_role is the authoritative elevated access level.
-- ============================================================

alter table public.profiles
  add column if not exists system_role text not null default 'staff';

alter table public.profiles
  drop constraint if exists profiles_system_role_check;

alter table public.profiles
  add constraint profiles_system_role_check
  check (system_role in ('super_admin','staff'));

-- Promote every current admin account to CEO / Super Admin.
update public.profiles
set system_role = 'super_admin'
where role = 'admin';

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and system_role = 'super_admin'
  );
$$;

revoke all on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated, service_role;

-- Super Admin automatically satisfies every existing role-based RLS policy.
create or replace function public.has_role(allowed text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin()
      or public.current_user_role() = any(allowed);
$$;

revoke all on function public.has_role(text[]) from public;
grant execute on function public.has_role(text[]) to authenticated, service_role;

-- Safe profile view for the front end and future Admin Task Center.
create or replace view public.user_access_summary
with (security_invoker = true)
as
select
  id,
  full_name,
  role,
  system_role,
  case
    when system_role = 'super_admin' then 'super_admin'
    else role
  end as effective_role,
  created_at,
  updated_at
from public.profiles;

grant select on public.user_access_summary to authenticated;

commit;

select
  'CHANANYA_SUPER_ADMIN_BRIDGE_READY' as status,
  count(*) filter (where system_role = 'super_admin') as super_admin_accounts
from public.profiles;
