begin;

-- ============================================================
-- BROWSER RPC ACL DRIFT CLOSURE — MIGRATION CANDIDATE
--
-- Do not move into supabase/migrations or apply until the target staging
-- migration ledger has passed the guarded 45-file fingerprint verification.
-- This candidate removes only runtime grants that are outside the exact
-- browser/service allowlist already enforced by the generated ledger guard.
-- It never creates or expands a grant.
-- ============================================================

do $$
declare
  v_signature text;
  v_missing text;
begin
  for v_signature in
    select unnest(array[
      'public.is_clinic_admin()',
      'public.is_reception_or_admin()',
      'public.is_practitioner()',
      'public.is_appointment_operator()',
      'public.is_appointment_practitioner()',
      'public.is_admin_or_super()',
      'public.current_user_role()',
      'public.clinical_financial_handoffs_healthcheck()',
      'public.department_persistence_healthcheck()',
      'public.production_execution_healthcheck()',
      'public.quality_release_healthcheck()',
      'public.prescription_dispensing_healthcheck()',
      'public.book_clinic_appointment(uuid,uuid,text,text,text)',
      'public.cancel_clinic_appointment(uuid,text)',
      'public.set_clinic_appointment_status(uuid,text,text)',
      'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
      'public.decide_approval_task(uuid,text,text)',
      'public.sign_clinical_record_complete(uuid,text,text,text)',
      'public.unlock_clinical_record_for_amendment(uuid,text)'
    ]::text[])
  loop
    if to_regprocedure(v_signature) is null then
      raise exception 'CNYOS_BROWSER_RPC_REQUIRED_FUNCTION_MISSING: %', v_signature;
    end if;
    execute format(
      'revoke all privileges on function %s from public, anon',
      v_signature
    );
  end loop;

  -- Browser workflow mutations must not become an alternative service-role
  -- bypass. Service endpoints use their dedicated tenant-bound RPCs.
  for v_signature in
    select unnest(array[
      'public.book_clinic_appointment(uuid,uuid,text,text,text)',
      'public.cancel_clinic_appointment(uuid,text)',
      'public.set_clinic_appointment_status(uuid,text,text)',
      'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
      'public.decide_approval_task(uuid,text,text)',
      'public.sign_clinical_record_complete(uuid,text,text,text)',
      'public.unlock_clinical_record_for_amendment(uuid,text)'
    ]::text[])
  loop
    execute format(
      'revoke all privileges on function %s from service_role',
      v_signature
    );
  end loop;
  select string_agg(signature, ', ' order by signature) into v_missing
  from unnest(array[
    'public.is_clinic_admin()',
    'public.is_reception_or_admin()',
    'public.is_practitioner()',
    'public.is_appointment_operator()',
    'public.is_appointment_practitioner()',
    'public.is_admin_or_super()',
    'public.current_user_role()',
    'public.clinical_financial_handoffs_healthcheck()',
    'public.department_persistence_healthcheck()',
    'public.production_execution_healthcheck()',
    'public.quality_release_healthcheck()',
    'public.prescription_dispensing_healthcheck()',
    'public.book_clinic_appointment(uuid,uuid,text,text,text)',
    'public.cancel_clinic_appointment(uuid,text)',
    'public.set_clinic_appointment_status(uuid,text,text)',
    'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
    'public.decide_approval_task(uuid,text,text)',
    'public.sign_clinical_record_complete(uuid,text,text,text)',
    'public.unlock_clinical_record_for_amendment(uuid,text)'
  ]::text[]) expected(signature)
  where has_function_privilege('anon', signature, 'EXECUTE');
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_RPC_ANON_EXECUTE_PRESENT: %', v_missing;
  end if;

  select string_agg(signature, ', ' order by signature) into v_missing
  from unnest(array[
    'public.book_clinic_appointment(uuid,uuid,text,text,text)',
    'public.cancel_clinic_appointment(uuid,text)',
    'public.set_clinic_appointment_status(uuid,text,text)',
    'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
    'public.decide_approval_task(uuid,text,text)',
    'public.sign_clinical_record_complete(uuid,text,text,text)',
    'public.unlock_clinical_record_for_amendment(uuid,text)'
  ]::text[]) expected(signature)
  where has_function_privilege('service_role', signature, 'EXECUTE');
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_WRITE_SERVICE_EXECUTE_PRESENT: %', v_missing;
  end if;

  select string_agg(signature, ', ' order by signature) into v_missing
  from unnest(array[
    'public.is_clinic_admin()',
    'public.is_reception_or_admin()',
    'public.is_practitioner()',
    'public.is_appointment_operator()',
    'public.is_appointment_practitioner()',
    'public.is_admin_or_super()',
    'public.current_user_role()',
    'public.clinical_financial_handoffs_healthcheck()',
    'public.department_persistence_healthcheck()',
    'public.production_execution_healthcheck()',
    'public.quality_release_healthcheck()',
    'public.prescription_dispensing_healthcheck()',
    'public.book_clinic_appointment(uuid,uuid,text,text,text)',
    'public.cancel_clinic_appointment(uuid,text)',
    'public.set_clinic_appointment_status(uuid,text,text)',
    'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
    'public.decide_approval_task(uuid,text,text)',
    'public.sign_clinical_record_complete(uuid,text,text,text)',
    'public.unlock_clinical_record_for_amendment(uuid,text)'
  ]::text[]) expected(signature)
  where not has_function_privilege('authenticated', signature, 'EXECUTE');
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_RPC_AUTHENTICATED_EXECUTE_MISSING: %', v_missing;
  end if;

  select string_agg(signature, ', ' order by signature) into v_missing
  from unnest(array[
    'public.is_clinic_admin()',
    'public.is_reception_or_admin()',
    'public.is_practitioner()',
    'public.is_appointment_operator()',
    'public.is_appointment_practitioner()',
    'public.is_admin_or_super()',
    'public.current_user_role()',
    'public.clinical_financial_handoffs_healthcheck()',
    'public.department_persistence_healthcheck()',
    'public.production_execution_healthcheck()',
    'public.quality_release_healthcheck()',
    'public.prescription_dispensing_healthcheck()'
  ]::text[]) expected(signature)
  where not has_function_privilege('service_role', signature, 'EXECUTE');
  if v_missing is not null then
    raise exception 'CNYOS_BROWSER_HELPER_SERVICE_EXECUTE_MISSING: %', v_missing;
  end if;
  -- This is provisional until the caller confirms COMMIT without any errors.
  raise notice 'CNYOS_BROWSER_RPC_ACL_DRIFT_CHECKS_PASSED; commit required';
end $$;

commit;
