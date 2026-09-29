begin;

-- Owner financial operation is an explicit finance capability.  Keep it
-- separate from the governance `admin` marker: current_user_role() returns
-- governance_admin for owner/admin accounts, so the legacy read_staff policy
-- intentionally does not expose these rows to either role.
--
-- These are SELECT-only policies.  Invoice, invoice-item and payment writes
-- remain RPC-only; authenticated direct INSERT/UPDATE/DELETE privileges were
-- revoked by 202608270400_atomic_clinical_financial_handoffs.sql.
drop policy if exists invoices_read_owner_finance on public.invoices;
create policy invoices_read_owner_finance
  on public.invoices for select to authenticated
  using (
    public.is_clinic_member(public.current_clinic_id(), array['owner'])
    and public.can_access_invoice(id)
  );

drop policy if exists invoice_items_read_owner_finance on public.invoice_items;
create policy invoice_items_read_owner_finance
  on public.invoice_items for select to authenticated
  using (
    public.is_clinic_member(public.current_clinic_id(), array['owner'])
    and public.can_access_invoice(invoice_id)
  );

drop policy if exists payments_read_owner_finance on public.payments;
create policy payments_read_owner_finance
  on public.payments for select to authenticated
  using (
    public.is_clinic_member(public.current_clinic_id(), array['owner'])
    and public.can_access_invoice(invoice_id)
  );

-- The Owner finance screen must not receive broad patient/encounter SELECT
-- access merely to render a receipt. This narrow read-back surface exposes
-- only the invoice's tenant and display identity after the same current-clinic,
-- active-membership, subscription and invoice-boundary checks.
create or replace function public.get_owner_invoice_context(p_invoice_id uuid)
returns table(
  invoice_id uuid,
  clinic_id uuid,
  patient_id uuid,
  first_name text,
  last_name text,
  encounter_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  if not public.is_clinic_member(v_clinic_id, array['owner']) then
    raise exception 'PERMISSION_DENIED';
  end if;

  return query
  select i.id, p.clinic_id, p.id, p.first_name, p.last_name, i.encounter_id
  from public.invoices i
  join public.patients p on p.id = i.patient_id
  where i.id = p_invoice_id
    and p.clinic_id = v_clinic_id
    and public.can_access_invoice(i.id);
end;
$$;

revoke all on function public.get_owner_invoice_context(uuid) from public, anon, service_role;
grant execute on function public.get_owner_invoice_context(uuid) to authenticated;
comment on function public.get_owner_invoice_context(uuid) is
  'Narrow Owner financial read-back identity; does not grant patient or encounter table access';

comment on policy invoices_read_owner_finance on public.invoices is
  'Owner-only current-clinic financial read; mutations remain RPC-only';
comment on policy invoice_items_read_owner_finance on public.invoice_items is
  'Owner-only current-clinic invoice-line read; mutations remain RPC-only';
comment on policy payments_read_owner_finance on public.payments is
  'Owner-only current-clinic payment read; mutations remain RPC-only';

create or replace function public.list_owner_finance_context()
returns table(clinic_id uuid, encounter_id uuid, encounter_no text,
  patient_id uuid, hn text, prefix text, first_name text, last_name text,
  has_prescription boolean)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_clinic_id uuid := public.current_clinic_id();
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_clinic_id is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic_id);
  if not public.is_clinic_member(v_clinic_id, array['owner']) then
    raise exception 'PERMISSION_DENIED';
  end if;
  return query
  select p.clinic_id, e.id, e.encounter_no::text, p.id,
    p.hn::text, p.prefix::text, p.first_name::text, p.last_name::text,
    exists(select 1 from public.prescriptions r where r.encounter_id=e.id
      and r.status not in ('cancelled','void'))
  from public.encounters e
  join public.patients p on p.id=e.patient_id
  where e.clinic_id=v_clinic_id and p.clinic_id=v_clinic_id
    and (exists(select 1 from public.prescriptions r where r.encounter_id=e.id
      and r.status not in ('cancelled','void'))
      or exists(select 1 from public.clinical_treatment_sessions t where t.encounter_id=e.id)
      or exists(select 1 from public.invoices i where i.encounter_id=e.id and i.patient_id=p.id))
  union
  select p.clinic_id, null::uuid, null::text, p.id,
    p.hn::text, p.prefix::text, p.first_name::text, p.last_name::text, false
  from public.patients p
  where p.clinic_id=v_clinic_id and exists(select 1 from public.invoices i
    where i.patient_id=p.id and i.encounter_id is null);
end;
$$;
revoke all on function public.list_owner_finance_context() from public, anon, service_role;
grant execute on function public.list_owner_finance_context() to authenticated;
comment on function public.list_owner_finance_context() is
  'Minimal current-clinic Owner finance queue labels; no clinical notes or table grants';

notify pgrst, 'reload schema';
commit;
