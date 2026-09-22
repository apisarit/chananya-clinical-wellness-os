# Appointment provider display and clinic workflow handoff

## Verified, not inferred

- On 2026-09-22 the public `https://cnyos.cloud/appointments.js` still lacked
  the merged `practitionerNames` lookup and rendered missing provider/specialty
  as `-`. Local source fixes are not proof of publication.
- Read-only production inspection found three active scheduling-eligible
  profiles: Chayaporn Dokpikul, Chmixball Th and Tippawan Sansaneeyasunthorn.
- Owner explicitly confirmed **Jaoball = Chmixball Th** in this conversation.
  Do not rename/reassign Chayaporn's schedules to Jaoball.
- Schedules starting on/after 2026-09-22 were found for Tippawan and Chayaporn,
  not Chmixball. This is a separate issue from rendering missing names.
- No live appointment, profile, membership or schedule was changed by this
  investigation. No independent release approval is claimed here.

## Local correction

`appointments.js` labels the provider, hides absent optional specialty,
explains missing provider names, and renders capacity in words. Placeholder
and whitespace names fall back to the authorized provider directory. Card,
button and selected-slot labels remain escaped. Existing booking permissions
are unchanged. Tests exercise the actual renderer with synthetic fixtures.

## Next scoped implementation

1. Publish the reviewed name-lookup and UI changes through the protected release
   workflow; verify actual provider choices and a synthetic booking read-back.
2. Give Admin Console a clinic-scoped provider/room management panel. The
   current page only assigns staff roles, and room codes are free text; there
   is no room registry yet. This feature has NOT been implemented.
3. Separate **accepting appointments** from **account/membership access**.
   Pausing new appointments must not revoke clinical access or hide existing
   appointments. Use a scheduling setting, not `clinic_memberships.active`,
   for this UX. Room/provider reductions must preserve existing bookings and
   surface conflicts for explicit resolution. Do not silently move bookings.
4. Before adding Jaoball availability, resolve room/time conflicts with existing
   schedules. The requested default is Mon–Sun, 10–12, 13–15, 15–18, 18–21,
   capacity 2; do not automatically duplicate another provider's occupied room.
5. Next end-to-end acceptance path: appointment → check-in → encounter/OPD →
   dispensing → payment. Pharmacy stock entry and receiving need a separate
   usability pass. These steps are requested, not yet verified as complete.

## Release status

The previous protected deployment failed because its attestation referenced
an older commit. Do not rewrite approval/evidence SHAs and assert re-review.
Include this delta in the exact-commit release handoff; verify the resulting
runtime before reporting that the live defect is fixed.
