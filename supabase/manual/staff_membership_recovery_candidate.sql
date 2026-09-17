-- LOCAL REVIEW CANDIDATE ONLY. Not part of the ordered migration chain.
-- Promotion requires a separately reviewed migration and native staging tests.
-- This transaction deliberately aborts before any schema or data change.
BEGIN;
DO $unapproved$
BEGIN
  RAISE EXCEPTION 'STAFF_MEMBERSHIP_RECOVERY_REVIEW_REQUIRED';
END
$unapproved$;

-- BEGIN LOCAL FIXTURE DEFINITIONS
-- Tests load this region into a newly constructed in-memory database only.
-- UUID versions cover ordinary legacy writes, including delete/reinsert ABA.
ALTER TABLE public.clinic_memberships
  ADD COLUMN state_version uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid();

CREATE FUNCTION public.refresh_staff_membership_state_version()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  NEW.state_version := pg_catalog.gen_random_uuid();
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.refresh_staff_membership_state_version()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER refresh_staff_membership_state_version
  BEFORE INSERT OR UPDATE ON public.clinic_memberships
  FOR EACH ROW EXECUTE FUNCTION public.refresh_staff_membership_state_version();

-- No runtime role may read, insert, change, or delete receipts directly.
-- No cascading FK: removing a membership must not erase its receipt history.
CREATE TABLE public.staff_membership_transition_requests (
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  receipt jsonb,
  PRIMARY KEY (actor_id, request_id),
  CHECK (pg_catalog.jsonb_typeof(request_payload) = 'object'),
  CHECK (receipt IS NULL OR pg_catalog.jsonb_typeof(receipt) = 'object')
);
ALTER TABLE public.staff_membership_transition_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.staff_membership_transition_requests
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.admin_read_staff_membership_state(
  p_clinic_id uuid, p_user_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_state jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_clinic_id IS NULL OR p_user_id IS NULL
     OR public.current_clinic_id() IS DISTINCT FROM p_clinic_id
     OR public.department_can('governance') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'GOVERNANCE_DEPARTMENT_REQUIRED';
  END IF;
  SELECT pg_catalog.jsonb_build_object(
    'clinic_id', m.clinic_id, 'profile_id', m.profile_id,
    'state_version', m.state_version, 'active', m.active,
    'is_primary', m.is_primary, 'clinic_role', m.clinic_role,
    'profile_role', p.role, 'system_role', p.system_role
  ) INTO v_state
  FROM public.clinic_memberships m
  JOIN public.profiles p ON p.id = m.profile_id
  WHERE m.clinic_id = p_clinic_id AND m.profile_id = p_user_id;
  IF v_state IS NULL THEN RAISE EXCEPTION 'CLINIC_MEMBERSHIP_NOT_FOUND'; END IF;
  RETURN v_state;
END
$function$;
REVOKE ALL ON FUNCTION public.admin_read_staff_membership_state(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_read_staff_membership_state(uuid,uuid)
  TO authenticated;

-- Suspend when p_restore_request_id is NULL. Otherwise restore only the exact
-- prior suspension made by this actor. This is NOT an arbitrary activate API.
-- Privileged owner/admin accounts are deliberately outside this staff proof.
CREATE FUNCTION public.admin_transition_staff_membership(
  p_clinic_id uuid,
  p_user_id uuid,
  p_expected_state jsonb,
  p_request_id uuid,
  p_reason text,
  p_restore_request_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '2s'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
  v_payload jsonb;
  v_saved public.staff_membership_transition_requests%ROWTYPE;
  v_suspension jsonb;
  v_before jsonb;
  v_after jsonb;
  v_receipt jsonb;
  v_primary boolean;
BEGIN
  IF v_actor IS NULL OR p_clinic_id IS NULL OR p_user_id IS NULL
     OR public.current_clinic_id() IS DISTINCT FROM p_clinic_id
     OR public.department_can('governance') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'GOVERNANCE_DEPARTMENT_REQUIRED';
  END IF;
  IF p_request_id IS NULL OR pg_catalog.jsonb_typeof(p_expected_state) IS DISTINCT FROM 'object'
     OR pg_catalog.length(v_reason) NOT BETWEEN 5 AND 256
     OR p_request_id = p_restore_request_id THEN
    RAISE EXCEPTION 'MEMBERSHIP_TRANSITION_ARGUMENTS_INVALID';
  END IF;
  IF p_user_id = v_actor THEN RAISE EXCEPTION 'SELF_MEMBERSHIP_TRANSITION_NOT_ALLOWED'; END IF;

  -- Existing department assignment locks the target profile before membership.
  -- Sort both profile locks; NO KEY UPDATE does not block audit FK key checks.
  PERFORM p.id FROM public.profiles p WHERE p.id IN (v_actor, p_user_id)
    ORDER BY p.id FOR NO KEY UPDATE;
  PERFORM m.clinic_id FROM public.clinic_memberships m WHERE m.profile_id = v_actor
    ORDER BY m.clinic_id FOR SHARE;
  IF public.current_clinic_id() IS DISTINCT FROM p_clinic_id
     OR public.department_can('governance') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'GOVERNANCE_DEPARTMENT_REQUIRED';
  END IF;

  v_payload := pg_catalog.jsonb_build_object(
    'clinic_id', p_clinic_id, 'profile_id', p_user_id,
    'expected_state', p_expected_state, 'reason', v_reason,
    'restore_request_id', p_restore_request_id
  );
  INSERT INTO public.staff_membership_transition_requests(actor_id,request_id,request_payload)
    VALUES (v_actor,p_request_id,v_payload)
    ON CONFLICT (actor_id,request_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT r.* INTO v_saved FROM public.staff_membership_transition_requests r
      WHERE r.actor_id = v_actor AND r.request_id = p_request_id FOR UPDATE;
    IF v_saved.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'MEMBERSHIP_REQUEST_ID_CONFLICT';
    END IF;
    IF v_saved.receipt IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_RECEIPT_INCOMPLETE'; END IF;
    -- A replay returns a historical receipt, never an assertion of current state.
    RETURN v_saved.receipt;
  END IF;

  PERFORM m.profile_id FROM public.clinic_memberships m
    WHERE m.clinic_id = p_clinic_id AND m.profile_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLINIC_MEMBERSHIP_NOT_FOUND'; END IF;
  v_before := public.admin_read_staff_membership_state(p_clinic_id,p_user_id);
  IF v_before IS DISTINCT FROM p_expected_state THEN
    RAISE EXCEPTION 'MEMBERSHIP_STATE_CONFLICT';
  END IF;
  IF v_before->>'system_role' IN ('super_admin','admin')
     OR v_before->>'clinic_role' IN ('owner','admin') THEN
    RAISE EXCEPTION 'PRIVILEGED_MEMBERSHIP_PROTECTED';
  END IF;

  IF p_restore_request_id IS NULL THEN
    IF (v_before->>'active')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'MEMBERSHIP_ALREADY_INACTIVE';
    END IF;
    v_primary := false;
  ELSE
    SELECT r.receipt INTO v_suspension FROM public.staff_membership_transition_requests r
      WHERE r.actor_id = v_actor AND r.request_id = p_restore_request_id FOR SHARE;
    IF v_suspension IS NULL OR v_suspension->>'operation' IS DISTINCT FROM 'suspend'
       OR v_suspension->>'clinic_id' IS DISTINCT FROM p_clinic_id::text
       OR v_suspension->>'profile_id' IS DISTINCT FROM p_user_id::text
       OR v_suspension->'after' IS DISTINCT FROM v_before
       OR (v_suspension->'before'->>'active')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'MEMBERSHIP_RESTORE_RECEIPT_MISMATCH';
    END IF;
    v_primary := (v_suspension->'before'->>'is_primary')::boolean;
    IF v_primary AND EXISTS (
      SELECT 1 FROM public.clinic_memberships m
      WHERE m.profile_id = p_user_id AND m.clinic_id <> p_clinic_id AND m.active AND m.is_primary
    ) THEN RAISE EXCEPTION 'MEMBERSHIP_PRIMARY_CONFLICT'; END IF;
  END IF;

  UPDATE public.clinic_memberships
    SET active = (p_restore_request_id IS NOT NULL), is_primary = v_primary,
        updated_at = pg_catalog.now()
    WHERE clinic_id = p_clinic_id AND profile_id = p_user_id;
  v_after := public.admin_read_staff_membership_state(p_clinic_id,p_user_id);
  v_receipt := pg_catalog.jsonb_build_object(
    'schema_version', 1, 'actor_id', v_actor, 'request_id', p_request_id,
    'clinic_id', p_clinic_id, 'profile_id', p_user_id,
    'operation', CASE WHEN p_restore_request_id IS NULL THEN 'suspend' ELSE 'restore' END,
    'restore_request_id', p_restore_request_id, 'before', v_before, 'after', v_after,
    'completed_at', pg_catalog.clock_timestamp()
  );
  INSERT INTO public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata)
    VALUES(p_clinic_id,v_actor,
      CASE WHEN p_restore_request_id IS NULL THEN 'suspend_staff_membership_v2' ELSE 'restore_staff_membership_v2' END,
      'clinic_memberships',p_user_id::text,
      pg_catalog.jsonb_build_object('receipt',v_receipt,'reason',v_reason));
  UPDATE public.staff_membership_transition_requests SET receipt = v_receipt
    WHERE actor_id = v_actor AND request_id = p_request_id AND receipt IS NULL;
  RETURN v_receipt;
END
$function$;
REVOKE ALL ON FUNCTION public.admin_transition_staff_membership(uuid,uuid,jsonb,uuid,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_transition_staff_membership(uuid,uuid,jsonb,uuid,text,uuid)
  TO authenticated;
-- END LOCAL FIXTURE DEFINITIONS
COMMIT;
