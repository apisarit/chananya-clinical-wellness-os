# Isolated staging test-case buffer

This buffer contains five fictional Ollama-generated cases (`TEST-001` through
`TEST-005`) for staging verification only. It is deliberately separate from
`patients`, `encounters`, billing, clinical, and production tables. The cases
are not real patients and must never be used for clinical care.

## Apply only to the isolated staging database

The SQL is kept under `supabase/manual/` because the repository migration ledger
is a reviewed 47-file baseline. Before applying it, verify the Supabase project
ref and environment out of band. Do not run it against the production project,
and do not paste credentials into chat or source control.

Apply:

```bash
psql "$STAGING_DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  --file=supabase/manual/20260917090000_staging_test_case_buffer.sql
```

The SQL enables and forces RLS, revokes direct table DML, seeds the five cases,
and exposes only authenticated `admin`/`super_admin` RPC access. A physical
`DELETE` is rejected; use the soft-delete RPC instead.

## Verify the seed

```sql
select case_key, status, version, payload->>'first' as first_name
from public.staging_test_case_buffer
order by case_key;
```

Exactly five active rows (`TEST-001` … `TEST-005`) should be present. The
`staging_test_case_buffer_events` table should contain a `created` event for
each row.

## Correct, remove, or restore a case

These calls require an authenticated `admin` or `super_admin` session. Supply
the current `version` for optimistic concurrency; a stale version fails with
`STAGING_TEST_CASE_VERSION_CONFLICT`.

```sql
select * from public.edit_staging_test_case(
  'TEST-001',
  '{
    "id": "TEST-001",
    "prefix": "นาย",
    "first": "สาธิต",
    "last": "กรณีหนึ่งแก้ไข",
    "gender": "male",
    "dob": "1991-05-12",
    "symptom": "staging-only not-for-clinical-use: corrected demonstration symptom",
    "diagnosis": "ข้อมูลสาธิต — ไม่ใช่คำแนะนำทางคลินิก",
    "dosha": "ข้อมูลสาธิต",
    "product": "ข้อมูลสาธิต — ห้ามใช้รักษาจริง",
    "qty": 2,
    "price": 150,
    "serviceFee": 30,
    "discount": 15,
    "channel": "qr"
  }'::jsonb,
  'Correct synthetic fixture label',
  1
);

select * from public.remove_staging_test_case(
  'TEST-005',
  'Remove synthetic case from staging rehearsal'
);

select * from public.restore_staging_test_case(
  'TEST-005',
  'Restore synthetic case for another staging rehearsal'
);
```

Every edit, removal, and restoration is recorded in the append-only event
ledger. No call in this runbook authorizes production deployment or admission
of real patient data.
