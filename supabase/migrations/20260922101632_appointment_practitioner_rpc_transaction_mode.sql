-- The POST RPC calls assert_clinic_subscription_active(), which takes a
-- FOR SHARE lock. STABLE makes PostgREST use a read-only transaction and
-- prevents appointment initialization. Preserve the assertion and its lock.
begin;
alter function public.list_appointment_practitioners() volatile;
notify pgrst, 'reload schema';
commit;
