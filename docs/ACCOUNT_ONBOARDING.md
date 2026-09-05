# CNYOS account onboarding

The historical profile SELECT policy checks `current_user_role() = 'admin'`, while the current role function returns `super_admin` or `governance_admin`. The subscription boundary also hides profiles from authenticated users without an active clinic membership. As a result, new users see “ไม่พบ Profile”, and the Admin list can contain only the caller.

`POST /api/account-access` provides a narrowly scoped account workflow while retaining the existing database policies and subscription switch:

- `status` verifies the bearer with Supabase Auth and reads only that user's identity. A genuinely missing profile is inserted as `viewer` / `staff`, ignoring an existing row on conflict. It never creates or activates clinic membership, changes roles, or reads clinical data.
- `staff_list` verifies the caller's current database access context against the deployment clinic. An active governance user sees members of that clinic. An active Super Admin also sees profiles with no membership in any clinic. Accounts already attached to another clinic are excluded. The server rechecks access before returning the list. Responses are limited to 500 accounts and report truncation.
- Missing-profile browser responses are identity-only and always have `access_context_ready: false`. The operations and Luopan entry pages show a waiting/access-unavailable screen with retry and sign-out controls. Existing department checks still govern access after approval.

Super Admin workflow: user signs in with Google → open **ศูนย์ควบคุม → ผู้ใช้และสิทธิ์ → โหลดรายชื่อใหม่** → choose the pending user under **กำหนด Role ปฏิบัติงาน** → choose a department and save. `viewer` permits U Synthesise without clinical privileges. Membership assignment continues through the existing audited `admin_assign_staff_role` RPC. System-role promotion is offered only after the account is an active clinic member.

The function uses the existing server-only Supabase key and site/project pins. Set function-scoped production variables `CNYOS_ACCOUNT_CLINIC_ID` and `CNYOS_ACCOUNT_CLINIC_CODE` to the same tenant values as the published config. Deployment previews and mismatched sites/projects are rejected. No authentication key is exposed to the browser, and no SQL migration is required.

Validation: `tests/account-access.mjs` covers missing/existing profiles, malformed and unverified sessions, attempted role or subject injection, cross-clinic records, ordinary-admin restrictions, suspension during a request, preview denial, and browser fail-closed handling. Actual Google consent on a new person's device still requires that person's session.
