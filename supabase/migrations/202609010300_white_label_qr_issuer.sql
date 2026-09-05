begin;

-- Resolve the configured tenant QR prefix rather than accepting only the
-- historical CHANANYA prefix. The opaque 256-bit token remains the only value
-- hashed and stored by the database.
create or replace function public.resolve_patient_qr(
  p_token text default null,
  p_display_code text default null
)
returns table (
  qr_session_id uuid,
  patient_id uuid,
  hn text,
  display_name text,
  date_of_birth date,
  phone_last4 text,
  active_allergies jsonb,
  expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := public.current_clinic_id();
  v_issuer text;
  v_token text := btrim(coalesce(p_token, ''));
  v_code text := regexp_replace(coalesce(p_display_code, ''), '\\D', '', 'g');
  v_session public.patient_qr_sessions%rowtype;
  v_patient public.patients%rowtype;
  v_allergies jsonb;
begin
  if not public.is_clinic_member(
    v_clinic_id,
    array['owner','admin','practitioner','doctor','reception']
  ) then
    raise exception 'PERMISSION_DENIED';
  end if;

  select c.code into v_issuer
  from public.clinics c
  where c.id = v_clinic_id
    and c.active
    and c.subscription_state = 'active';

  if v_issuer is null then
    raise exception 'CLINIC_CONTEXT_REQUIRED';
  end if;

  if position(':PT1:' in v_token) > 0 then
    if left(v_token, length(v_issuer) + 5) <> v_issuer || ':PT1:' then
      raise exception 'QR_ISSUER_MISMATCH';
    end if;
    v_token := substr(v_token, length(v_issuer) + 6);
  end if;
  if v_token <> '' and v_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'QR_CREDENTIAL_FORMAT_INVALID';
  end if;
  if v_token = '' and length(v_code) <> 6 then
    raise exception 'QR_OR_SIX_DIGIT_CODE_REQUIRED';
  end if;
  if v_token = '' and not public.consume_patient_identity_rate_limit(
    encode(digest(
      v_clinic_id::text || ':' || auth.uid()::text || ':staff_display_code',
      'sha256'
    ), 'hex'),
    20,
    300
  ) then
    raise exception 'RATE_LIMITED';
  end if;

  select * into v_session
  from public.patient_qr_sessions q
  where q.clinic_id = v_clinic_id
    and q.used_at is null
    and q.expires_at > now()
    and (
      (v_token <> '' and q.token_hash = encode(digest(v_token, 'sha256'), 'hex'))
      or (v_token = '' and q.display_code_hash = encode(digest(v_code, 'sha256'), 'hex'))
    )
  order by q.created_at desc
  limit 1
  for update;

  if not found then
    if v_token = '' then
      insert into public.patient_identity_events (
        clinic_id, event_type, actor_profile_id, metadata
      ) values (
        v_clinic_id,
        'PATIENT_QR_LOOKUP_FAILED',
        auth.uid(),
        jsonb_build_object('credential', 'display_code')
      );
      return;
    end if;
    raise exception 'QR_INVALID_EXPIRED_OR_USED';
  end if;

  update public.patient_qr_sessions
  set resolved_at = now(), resolved_by = auth.uid()
  where id = v_session.id;

  select * into v_patient
  from public.patients p
  where p.id = v_session.patient_id
    and p.clinic_id = v_clinic_id
    and p.active;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', a.allergen_name,
        'reaction', a.reaction,
        'severity', a.severity
      ) order by a.allergen_name
    ) filter (where a.id is not null),
    '[]'::jsonb
  ) into v_allergies
  from public.patient_allergies a
  where a.patient_id = v_patient.id
    and a.clinic_id = v_clinic_id
    and a.status = 'active';

  insert into public.patient_identity_events (
    clinic_id, patient_id, event_type, actor_profile_id, qr_session_id,
    metadata
  ) values (
    v_clinic_id,
    v_patient.id,
    'PATIENT_QR_RESOLVED',
    auth.uid(),
    v_session.id,
    jsonb_build_object('credential', case when v_token <> '' then 'qr' else 'display_code' end)
  );

  return query
  select
    v_session.id,
    v_patient.id,
    v_patient.hn,
    concat_ws(' ', nullif(v_patient.prefix, ''), v_patient.first_name, v_patient.last_name),
    v_patient.date_of_birth,
    case
      when length(regexp_replace(coalesce(v_patient.phone, ''), '\\D', '', 'g')) >= 4
      then right(regexp_replace(v_patient.phone, '\\D', '', 'g'), 4)
      else null
    end,
    v_allergies,
    v_session.expires_at;
end;
$$;

revoke all on function public.resolve_patient_qr(text,text) from public;
grant execute on function public.resolve_patient_qr(text,text) to authenticated;

commit;

select 'CLINICAL_OS_WHITE_LABEL_QR_ISSUER_READY' as status;
