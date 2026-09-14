# CNYOS Owner Console recovery repair

## Scope and verified starting point

User requested repair of CNYOS Owner OS. The existing entry point is `/owner-control.html`; it is not a separate owner-onoff website. This change addresses Owner UI/session/recovery, not staff approval, patient care or subscription policy.

Source baseline: main `f21d9388217b8bb75632203be11bd490e7051f7a`, tree `d7790f6eb0af3cbd6af149190f2db2df57a4d0d2`. Preserve the merged PR #28 account-onboarding work and all production release controls. PR #13 is still draft and unmerged; its Owner session changes are ported selectively rather than merging its outdated package manifest.

Netlify readback at investigation: CNYOS deploy `6a9c4b988cfa1b71dde0adc6` ready, with source metadata matching the baseline above. The application remains Chananya isolated staging despite the hosting context being called production. Owner subscription control is enabled; Owner Drive and backup are disabled. No configuration switch is changed by this patch. A read-only Supabase catalog query confirmed `current_clinic_id`, `list_owner_subscription_clinics` and the versioned `set_clinic_subscription_state` RPC exist on Chananya staging. Existence is not live behavioral verification.

## Repairs

- Port current-session reads, synchronous auth-state callbacks, cancellation and generation isolation from PR #13. Logout, account switch and browser-history restoration cannot retain the previous Owner view.
- Bound initial session lookup, API work and sign-out. A failed/hanging load presents explicit page-reload and sign-out/re-authentication controls instead of leaving recovery behind a hidden console.
- Handle 401/403 before response-body parsing. Keep the console locked and offer explicit recovery; do not bounce the same rejected session between login and Owner routes.
- Add a read-only subscription refresh button. Block duplicate submissions, refresh while a write is pending, and further writes after an uncertain result until a fresh state read succeeds.
- Distinguish successful writes followed by refresh failure from unknown outcomes. Never automatically retry a subscription or Drive mutation.
- Present disabled Drive configuration separately from authorized subscription control. Do not enable backup or bypass missing credentials.
- Ensure hidden recovery/setup elements remain hidden under form layout CSS; preserve pinned Supabase SDK integrity and all backend authorization.

## Verification boundaries

Local verification before source publication: 37/37 executable synthetic browser-controller cases; HTML wiring/disabled-state/SDK-integrity contract; 5/5 isolated Chromium DOM cases using the real page controls and controller with synthetic Auth/API and minimal layout fixtures. These are not live Google Owner E2E, live subscription OFF/ON, deployed visual approval, or a production-readiness attestation.

Full repository CI is required after this commit. Live Owner Google login, authenticated GET, controlled staging OFF/ON evidence and exact deployment readback remain separate gates. No patient data, clinic subscription, database role, credential, environment variable, backend Function or SQL migration is changed.

## Release and rollback

Keep source-only changes off automatic production deployment until the exact candidate is verified. Use an explicit staging deployment for the existing staging application; production release gates stay unchanged. A hosting success alone is not a clinical production approval. Roll back this isolated UI change by restoring the baseline Owner HTML/controller and removing the added stylesheet, without changing database or subscription state.
