begin;
-- Match the existing booking operator predicate, without changing clinical
-- permissions or either restrictive tenant/subscription policy.
alter policy clinic_appointments_staff_read on public.clinic_appointments
using (
  clinic_id = public.current_clinic_id()
  and (
    public.is_appointment_operator()
    or practitioner_id = auth.uid()
    or exists (
      select 1 from public.patient_user_links l
      where l.patient_id = clinic_appointments.patient_id
        and l.user_id = auth.uid() and l.active
    )
  )
);
notify pgrst, 'reload schema';
commit;
