-- The legacy audit_read_admin predicate expects 'admin', while the current
-- role resolver returns 'governance_admin'. Restore only the intended role
-- history read path, not access to unrelated patient or financial audit rows.
begin;
create policy audit_role_history_read_governance
on public.audit_logs for select to authenticated
using (
  clinic_id = public.current_clinic_id()
  and public.is_admin_or_super()
  and action in ('assign_staff_role', 'assign_department_role', 'set_system_role')
);
commit;
