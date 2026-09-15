import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('../supabase/migrations/20260913125900_treatment_service_invoice.sql', import.meta.url),
  'utf8'
);
const hardening = fs.readFileSync(
  new URL(
    '../supabase/migrations/20260915073000_harden_treatment_service_invoice.sql',
    import.meta.url
  ),
  'utf8'
);

assert.equal(
  createHash('sha256').update(source).digest('hex'),
  '780fffb90f0fc5ad3faaf2766c993eb0ffb3fdeb5c72a6dd17c3d247a538352d',
  'repository source must remain byte-identical to the migration applied on VPS staging'
);
assert.equal((source.match(/^begin;$/gmu) ?? []).length, 1);
assert.equal((source.match(/^commit;$/gmu) ?? []).length, 1);
assert.match(source, /create schema cnyos_billing_internal;/u);
assert.match(
  source,
  /revoke all on schema cnyos_billing_internal from public, anon, authenticated;/u
);
assert.match(source, /security definer\nset search_path = pg_catalog, public/u);
assert.match(source, /v_actor := auth\.uid\(\);/u);
assert.match(source, /v_clinic := public\.current_clinic_id\(\);/u);
assert.match(source, /public\.assert_clinic_subscription_active\(v_clinic\)/u);
assert.match(
  source,
  /public\.is_clinic_member\(v_clinic, array\['owner','admin','billing'\]\)/u
);
assert.match(source, /pg_advisory_xact_lock/u);
assert.match(source, /where e\.id=p_encounter_id and e\.clinic_id=v_clinic for update/u);
assert.match(source, /SIGNED_CLINICAL_RECORD_REQUIRED/u);
assert.match(source, /TREATMENT_SESSION_REQUIRED/u);
assert.match(source, /PRESCRIPTION_BILLING_PATH_REQUIRED/u);
assert.match(source, /ENCOUNTER_ALREADY_HAS_ACTIVE_INVOICE/u);
assert.match(source, /INVOICE_REQUEST_CONFLICT/u);
assert.match(source, /language sql volatile security invoker/u);
assert.match(
  source,
  /revoke all on function public\.issue_atomic_treatment_invoice\(uuid,uuid,numeric,text\)\n  from public, anon, authenticated, service_role;/u
);
assert.match(
  source,
  /grant execute on function public\.issue_atomic_treatment_invoice\(uuid,uuid,numeric,text\)\n  to authenticated;/u
);
assert.doesNotMatch(
  source,
  /grant execute on function public\.issue_atomic_treatment_invoice[^;]+to (?:public|anon|service_role)/u
);
assert.equal(
  createHash('sha256').update(hardening).digest('hex'),
  '298720cbeda2342609c9c9f0ab838274f7354e40ea5575b3101063e9f28e304c',
  'forward hardening migration must remain bound to its reviewed source bytes'
);
assert.match(
  hardening,
  /create unique index invoices_one_active_per_encounter_uidx[\s\S]+where encounter_id is not null and status not in \('cancelled','void'\);/u
);
assert.match(
  hardening,
  /where s\.encounter_id=p_encounter_id[\s\S]+and s\.lock_record[\s\S]+for share;/u
);
assert.ok(
  hardening.indexOf('where e.id=p_encounter_id and e.clinic_id=v_clinic for update;') <
    hardening.indexOf('for share;'),
  'encounter lock must precede the sign-off lock'
);
assert.match(
  hardening,
  /security definer\nset search_path = pg_catalog, public, pg_temp/u
);
assert.match(
  hardening,
  /revoke all on schema cnyos_billing_internal from public, anon, authenticated, service_role;/u
);
assert.match(
  hardening,
  /language plpgsql volatile security definer\nset search_path = pg_catalog, public, cnyos_billing_internal, pg_temp/u
);
assert.match(hardening, /v_actor := auth\.uid\(\);/u);
assert.match(hardening, /perform public\.assert_clinic_subscription_active\(v_clinic\);/u);
assert.equal(
  (hardening.match(/public\.is_clinic_member\(v_clinic, array\['owner','admin','billing'\]\)/gu) ?? [])
    .length,
  2,
  'both the public wrapper and private delegate must enforce the billing role boundary'
);
assert.match(
  hardening,
  /revoke all on function cnyos_billing_internal\.issue_treatment_invoice\(uuid,uuid,numeric,text\)\n  from public, anon, authenticated, service_role;/u
);

console.log(
  'Treatment-service invoice contracts passed: exact staged bytes plus forward sign-off locking, uniqueness, private delegate and terminal pg_temp'
);
