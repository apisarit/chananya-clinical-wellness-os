begin;

-- Staging-only ACL remediation for the security-invoker traceability view.
-- The view already enforces invoker RLS; remove the default PUBLIC/anon
-- exposure while retaining the reviewed authenticated read path.
revoke select on table public.v_clinical_herbal_traceability from public, anon;
grant select on table public.v_clinical_herbal_traceability to authenticated;

commit;
