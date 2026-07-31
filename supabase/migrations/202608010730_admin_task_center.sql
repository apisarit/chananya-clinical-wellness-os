begin;

-- ============================================================
-- ADMIN TASK CENTER
-- super_admin = owner / CEO
-- admin       = operational approver
-- staff       = normal workstation user
-- ============================================================

alter table public.profiles
  add column if not exists system_role text not null default 'staff';

alter table public.profiles
  drop constraint if exists profiles_system_role_check;

alter table public.profiles
  add constraint profiles_system_role_check
  check (system_role in ('super_admin','admin','staff'));

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and system_role = 'super_admin'
  );
$$;

create or replace function public.is_admin_or_super()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and system_role in ('admin','super_admin')
  );
$$;

revoke all on function public.is_super_admin() from public;
revoke all on function public.is_admin_or_super() from public;
grant execute on function public.is_super_admin() to authenticated, service_role;
grant execute on function public.is_admin_or_super() to authenticated, service_role;

-- Super admin automatically satisfies all existing role-based RLS policies.
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

create table if not exists public.approval_tasks (
  id uuid primary key default gen_random_uuid(),
  task_no text not null unique,
  task_type text not null,
  module text not null,
  title text not null,
  description text,
  priority text not null default 'normal'
    check (priority in ('low','normal','high','urgent','critical')),
  status text not null default 'pending'
    check (status in ('pending','in_review','approved','rejected','cancelled','completed')),
  reference_type text,
  reference_id uuid,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  assigned_to uuid references auth.users(id) on delete set null,
  due_at timestamptz,
  decision_notes text,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.approval_actions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.approval_tasks(id) on delete cascade,
  action text not null,
  from_status text,
  to_status text,
  notes text,
  action_by uuid references auth.users(id) on delete set null,
  acted_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists approval_tasks_status_idx
  on public.approval_tasks(status, priority, requested_at desc);
create index if not exists approval_tasks_module_idx
  on public.approval_tasks(module, task_type, requested_at desc);
create index if not exists approval_actions_task_idx
  on public.approval_actions(task_id, acted_at desc);

drop trigger if exists approval_tasks_set_updated_at on public.approval_tasks;
create trigger approval_tasks_set_updated_at
before update on public.approval_tasks
for each row execute function public.set_updated_at();

alter table public.approval_tasks enable row level security;
alter table public.approval_actions enable row level security;

drop policy if exists approval_tasks_read_participant on public.approval_tasks;
create policy approval_tasks_read_participant
on public.approval_tasks for select to authenticated
using (
  public.is_admin_or_super()
  or requested_by = auth.uid()
  or assigned_to = auth.uid()
);

drop policy if exists approval_tasks_create_staff on public.approval_tasks;
create policy approval_tasks_create_staff
on public.approval_tasks for insert to authenticated
with check (requested_by = auth.uid());

drop policy if exists approval_tasks_update_admin on public.approval_tasks;
create policy approval_tasks_update_admin
on public.approval_tasks for update to authenticated
using (public.is_admin_or_super())
with check (public.is_admin_or_super());

drop policy if exists approval_actions_read_participant on public.approval_actions;
create policy approval_actions_read_participant
on public.approval_actions for select to authenticated
using (
  public.is_admin_or_super()
  or exists (
    select 1 from public.approval_tasks t
    where t.id = task_id
      and (t.requested_by = auth.uid() or t.assigned_to = auth.uid())
  )
);

drop policy if exists approval_actions_insert_admin on public.approval_actions;
create policy approval_actions_insert_admin
on public.approval_actions for insert to authenticated
with check (public.is_admin_or_super() and action_by = auth.uid());

grant select,insert on public.approval_tasks to authenticated;
grant update on public.approval_tasks to authenticated;
grant select,insert on public.approval_actions to authenticated;

-- Staff submits a task into the Admin Task Center.
create or replace function public.create_approval_task(
  p_task_type text,
  p_module text,
  p_title text,
  p_description text default null,
  p_priority text default 'normal',
  p_reference_type text default null,
  p_reference_id uuid default null,
  p_due_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_no text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_priority not in ('low','normal','high','urgent','critical') then
    raise exception 'Invalid priority';
  end if;
  v_no := 'AT-' || to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');
  insert into public.approval_tasks(
    task_no,task_type,module,title,description,priority,reference_type,
    reference_id,requested_by,due_at,metadata
  ) values (
    v_no,p_task_type,p_module,p_title,p_description,p_priority,p_reference_type,
    p_reference_id,auth.uid(),p_due_at,coalesce(p_metadata,'{}'::jsonb)
  ) returning id into v_id;
  return v_id;
end;
$$;

-- Admin / Super Admin approves, rejects, takes or completes a task.
create or replace function public.decide_approval_task(
  p_task_id uuid,
  p_action text,
  p_notes text default null
)
returns public.approval_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.approval_tasks;
  v_from text;
  v_to text;
begin
  if not public.is_admin_or_super() then raise exception 'Admin permission required'; end if;
  select * into v_task from public.approval_tasks where id=p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  v_from := v_task.status;
  v_to := case p_action
    when 'take' then 'in_review'
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'complete' then 'completed'
    when 'cancel' then 'cancelled'
    else null end;
  if v_to is null then raise exception 'Invalid action'; end if;
  update public.approval_tasks set
    status=v_to,
    assigned_to=case when p_action='take' then auth.uid() else coalesce(assigned_to,auth.uid()) end,
    decision_notes=case when p_action in ('approve','reject','cancel') then p_notes else decision_notes end,
    decided_by=case when p_action in ('approve','reject','cancel') then auth.uid() else decided_by end,
    decided_at=case when p_action in ('approve','reject','cancel') then now() else decided_at end,
    completed_at=case when p_action='complete' then now() else completed_at end
  where id=p_task_id
  returning * into v_task;
  insert into public.approval_actions(task_id,action,from_status,to_status,notes,action_by)
  values(p_task_id,p_action,v_from,v_to,p_notes,auth.uid());
  return v_task;
end;
$$;

-- Admin assigns only operational staff roles.
-- Assigning admin or super_admin is intentionally excluded.
create or replace function public.admin_assign_staff_role(
  p_user_id uuid,
  p_role text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_role text;
begin
  if not public.is_admin_or_super() then raise exception 'Admin permission required'; end if;
  if p_role not in ('practitioner','reception','pharmacy','production','inventory','billing','viewer') then
    raise exception 'Admin may assign operational roles only';
  end if;
  select role into v_old_role from public.profiles where id=p_user_id for update;
  if not found then raise exception 'User profile not found'; end if;
  update public.profiles
     set role=p_role, system_role='staff', updated_at=now()
   where id=p_user_id and system_role <> 'super_admin';
  insert into public.audit_logs(user_id,action,entity,entity_id,metadata)
  values(auth.uid(),'assign_staff_role','profiles',p_user_id,
    jsonb_build_object('old_role',v_old_role,'new_role',p_role,'reason',p_reason));
end;
$$;

-- Only Super Admin may appoint or remove ordinary Admin.
create or replace function public.super_admin_set_system_role(
  p_user_id uuid,
  p_system_role text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  if not public.is_super_admin() then raise exception 'Super Admin permission required'; end if;
  if p_system_role not in ('admin','staff') then
    raise exception 'This function appoints ordinary Admin or Staff only';
  end if;
  if p_user_id = auth.uid() and p_system_role <> 'super_admin' then
    raise exception 'Cannot demote current Super Admin with this function';
  end if;
  select system_role into v_old from public.profiles where id=p_user_id for update;
  if not found then raise exception 'User profile not found'; end if;
  update public.profiles set system_role=p_system_role,updated_at=now() where id=p_user_id;
  insert into public.audit_logs(user_id,action,entity,entity_id,metadata)
  values(auth.uid(),'set_system_role','profiles',p_user_id,
    jsonb_build_object('old_system_role',v_old,'new_system_role',p_system_role,'reason',p_reason));
end;
$$;

revoke all on function public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb) from public;
revoke all on function public.decide_approval_task(uuid,text,text) from public;
revoke all on function public.admin_assign_staff_role(uuid,text,text) from public;
revoke all on function public.super_admin_set_system_role(uuid,text,text) from public;

grant execute on function public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb) to authenticated;
grant execute on function public.decide_approval_task(uuid,text,text) to authenticated;
grant execute on function public.admin_assign_staff_role(uuid,text,text) to authenticated;
grant execute on function public.super_admin_set_system_role(uuid,text,text) to authenticated;

create or replace view public.admin_task_summary
with (security_invoker=true)
as
select
  count(*) filter (where status='pending') as pending,
  count(*) filter (where status='in_review') as in_review,
  count(*) filter (where priority in ('urgent','critical') and status in ('pending','in_review')) as urgent,
  count(*) filter (where due_at is not null and due_at < now() and status in ('pending','in_review')) as overdue,
  count(*) filter (where status='approved' and decided_at::date=current_date) as approved_today,
  count(*) filter (where status='rejected' and decided_at::date=current_date) as rejected_today
from public.approval_tasks;

grant select on public.admin_task_summary to authenticated;

commit;

select
  'CHANANYA_ADMIN_TASK_CENTER_READY' as status,
  (select count(*) from public.profiles where system_role='super_admin') as super_admin_accounts,
  (select count(*) from public.profiles where system_role='admin') as admin_accounts;
