begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Treatment-only billing uses the existing payment/encounter-closing RPC.
-- No prescriptions, payments, clinical signatures, or fee waivers are created.
create schema cnyos_billing_internal;
revoke all on schema cnyos_billing_internal from public, anon, authenticated;
grant usage on schema cnyos_billing_internal to authenticated;

alter table public.invoices
  add column source_service_request_key uuid,
  add column service_request_fingerprint text;
create unique index invoices_service_request_uidx
  on public.invoices(source_service_request_key)
  where source_service_request_key is not null;

create function cnyos_billing_internal.issue_treatment_invoice(
  p_request_key uuid, p_encounter_id uuid, p_amount numeric, p_description text
)
returns table(invoice_id uuid, invoice_number text, grand_total numeric, balance_due numeric)
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_clinic uuid;
  v_actor uuid;
  v_encounter public.encounters%rowtype;
  v_invoice public.invoices%rowtype;
  v_fingerprint text;
  v_code text;
begin
  v_actor := auth.uid();
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  v_clinic := public.current_clinic_id();
  if v_clinic is null then raise exception 'CLINIC_CONTEXT_REQUIRED'; end if;
  perform public.assert_clinic_subscription_active(v_clinic);
  if not public.is_clinic_member(v_clinic, array['owner','admin','billing']) then
    raise exception 'PERMISSION_DENIED';
  end if;
  if p_request_key is null or p_encounter_id is null then
    raise exception 'REQUEST_AND_ENCOUNTER_REQUIRED';
  end if;
  if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity')
     or p_amount <= 0 or p_amount > 10000000 or p_amount <> round(p_amount,2) then
    raise exception 'INVOICE_AMOUNT_INVALID';
  end if;
  if p_description is null or length(btrim(p_description)) < 1
     or length(btrim(p_description)) > 500 then
    raise exception 'SERVICE_DESCRIPTION_REQUIRED';
  end if;
  v_fingerprint := encode(sha256(convert_to(jsonb_build_array(
    v_clinic, v_actor, p_encounter_id, p_amount::numeric(18,2), btrim(p_description)
  )::text, 'UTF8')), 'hex');
  -- Serialize the request key first, then the exact encounter. No remote calls
  -- or payment locks are taken inside this transaction.
  perform pg_advisory_xact_lock(hashtextextended('cnyos-service-invoice:'||p_request_key::text,0));
  select e.* into v_encounter from public.encounters e
    where e.id=p_encounter_id and e.clinic_id=v_clinic for update;
  if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  if not exists(select 1 from public.patients p
    where p.id=v_encounter.patient_id and p.clinic_id=v_clinic) then
    raise exception 'ENCOUNTER_PATIENT_MISMATCH';
  end if;
  select i.* into v_invoice from public.invoices i
    where i.source_service_request_key=p_request_key;
  if found then
    if v_invoice.encounter_id<>p_encounter_id
       or v_invoice.patient_id<>v_encounter.patient_id
       or v_invoice.service_request_fingerprint is distinct from v_fingerprint then
      raise exception 'INVOICE_REQUEST_CONFLICT';
    end if;
    return query select v_invoice.id,v_invoice.invoice_number,v_invoice.grand_total,v_invoice.balance_due;
    return;
  end if;
  if v_encounter.status in ('closed','cancelled','void') then
    raise exception 'ENCOUNTER_NOT_OPEN';
  end if;
  if not exists(select 1 from public.clinical_record_signoffs s
    where s.encounter_id=p_encounter_id and s.record_section='complete_record' and s.lock_record) then
    raise exception 'SIGNED_CLINICAL_RECORD_REQUIRED';
  end if;
  if not exists(select 1 from public.clinical_treatment_sessions s where s.encounter_id=p_encounter_id) then
    raise exception 'TREATMENT_SESSION_REQUIRED';
  end if;
  -- Prescription-bearing visits must keep the established pharmacy pathway.
  if exists(select 1 from public.prescriptions p
    where p.encounter_id=p_encounter_id and p.status not in ('cancelled','void')) then
    raise exception 'PRESCRIPTION_BILLING_PATH_REQUIRED';
  end if;
  if exists(select 1 from public.invoices i where i.encounter_id=p_encounter_id
    and i.status not in ('cancelled','void')) then
    raise exception 'ENCOUNTER_ALREADY_HAS_ACTIVE_INVOICE';
  end if;
  select coalesce(nullif(regexp_replace(upper(c.code),'[^A-Z0-9]','','g'),''),'CLN')
    into v_code from public.clinics c where c.id=v_clinic;
  insert into public.invoices(invoice_number,patient_id,encounter_id,status,
    subtotal,discount_total,tax_total,rounding,grand_total,paid_amount,balance_due,
    issued_at,created_by,source_service_request_key,service_request_fingerprint)
  values('INV-'||v_code||'-'||to_char(current_date,'YYYYMMDD')||'-'||
    lpad(public.next_clinic_counter(v_clinic,'invoice')::text,8,'0'),
    v_encounter.patient_id,p_encounter_id,'issued',p_amount,0,0,0,p_amount,0,p_amount,
    now(),v_actor,p_request_key,v_fingerprint) returning * into v_invoice;
  insert into public.invoice_items(invoice_id,item_type,description,quantity,unit_price,line_total)
    values(v_invoice.id,'service',btrim(p_description),1,p_amount,p_amount);
  insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
    values(v_clinic,v_actor,'issue_treatment_invoice','invoices',v_invoice.id::text,
      jsonb_build_object('request_key',p_request_key,'encounter_id',p_encounter_id,
        'amount',p_amount,'service_only',true));
  return query select v_invoice.id,v_invoice.invoice_number,v_invoice.grand_total,v_invoice.balance_due;
end;
$$;
revoke all on function cnyos_billing_internal.issue_treatment_invoice(uuid,uuid,numeric,text)
  from public, anon, authenticated, service_role;
grant execute on function cnyos_billing_internal.issue_treatment_invoice(uuid,uuid,numeric,text)
  to authenticated;

create function public.issue_atomic_treatment_invoice(
  p_request_key uuid, p_encounter_id uuid, p_amount numeric, p_description text
)
returns table(invoice_id uuid, invoice_number text, grand_total numeric, balance_due numeric)
language sql volatile security invoker
set search_path = pg_catalog, public
as $$
  select * from cnyos_billing_internal.issue_treatment_invoice(
    p_request_key,p_encounter_id,p_amount,p_description);
$$;
revoke all on function public.issue_atomic_treatment_invoice(uuid,uuid,numeric,text)
  from public, anon, authenticated, service_role;
grant execute on function public.issue_atomic_treatment_invoice(uuid,uuid,numeric,text)
  to authenticated;
comment on function public.issue_atomic_treatment_invoice(uuid,uuid,numeric,text) is
  'Tenant/role checked, request-idempotent service-only invoice for signed treatment visits. Does not record payment or close an encounter.';
notify pgrst, 'reload schema';
commit;
