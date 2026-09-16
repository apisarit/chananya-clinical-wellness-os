#!/usr/bin/env bash
set -Eeuo pipefail

# Generate and run the exact staging ACL/search_path remediation from the
# classified disposition.  The default is a complete dry-run that rolls back.
# This script is intentionally VPS/staging-only; it cannot target production.

manifest="${CNYOS_ACL_MANIFEST:-/srv/cnyos-staging/evidence/live-20260916-fd7f1dd/disposition.json}"
apply="${CNYOS_STAGING_ACL_APPLY:-off}"
ack="${CNYOS_STAGING_ACL_ACK:-}"
container="${CNYOS_DB_CONTAINER:-supabase-db}"

if [[ "$apply" != off && "$apply" != on ]]; then
  echo 'CNYOS_STAGING_ACL_APPLY must be off or on' >&2
  exit 2
fi
if [[ "$apply" == on && "$ack" != CNYOS_STAGING_ACL_REMEDIATION_20260916 ]]; then
  echo 'staging acknowledgement is required for a commit' >&2
  exit 2
fi
test -r "$manifest"

sql="$(mktemp)"
trap 'rm -f "$sql"' EXIT

python3 - "$manifest" >"$sql" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
categories = [
    ("authenticated_only", True, False),
    ("authenticated_and_service", True, True),
    ("service_only", False, True),
    ("owner_only_ordinary", False, False),
    ("owner_only_trigger", False, False),
    ("owner_only_event_trigger", False, False),
]

def quote(value):
    return "'" + value.replace("'", "''") + "'"

rows = []
for category, allow_authenticated, allow_service in categories:
    for signature in manifest["routine_dispositions"][category]:
        # The disposition was prepared against the previous migration set.
        # 20260915073000 removed the public event-trigger handler
        # public.rls_auto_enable() and added the authenticated-only treatment
        # invoice wrapper.  Keep this migration-bound overlay explicit rather
        # than silently treating a stale manifest as current.
        if signature == "public.rls_auto_enable()":
            continue
        rows.append((signature, allow_authenticated, allow_service, category))
# The current public routine set remains 147: the removed event-trigger
# handler is replaced by the new authenticated-only invoice wrapper.
invoice = "public.issue_atomic_treatment_invoice(uuid,uuid,numeric,text)"
if invoice not in {row[0] for row in rows}:
    rows.append((invoice, True, False, "authenticated_only"))
if len(rows) != 147 or len({row[0] for row in rows}) != 147:
    raise SystemExit("current disposition overlay must contain exactly 147 unique routines")
values = ",\n".join(
    "  (%s,%s,%s,%s)" % (
        quote(signature),
        "true" if allow_authenticated else "false",
        "true" if allow_service else "false",
        quote(category),
    )
    for signature, allow_authenticated, allow_service, category in rows
)

print(r"""\set ON_ERROR_STOP 1
\set ON_ERROR_ROLLBACK off
BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE;
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL statement_timeout = '90s';
SET LOCAL lock_timeout = '5s';
SET LOCAL timezone = 'UTC';

DO $guard$
BEGIN
  IF current_database() <> 'postgres'
     OR session_user <> 'postgres'
     OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR current_setting('server_encoding') <> 'UTF8'
     OR (SELECT system_identifier::text FROM pg_control_system()) <> '7684592775244222498'
  THEN
    RAISE EXCEPTION 'CNYOS_STAGING_ACL_TARGET_IDENTITY_INVALID';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.clinics
    WHERE id = '784ec3b0-7618-42ad-9ba0-eed606d22358'::uuid
      AND code = 'CNYOS-VPS-STG'
  ) THEN
    RAISE EXCEPTION 'CNYOS_STAGING_ACL_CLINIC_MARKER_MISSING';
  END IF;
END $guard$;

-- The managed VPS role cannot lock system catalogs such as pg_proc. The
-- staging advisory lock plus the ordinary ledger/clinic locks still prevent
-- another CNYOS controller run from overlapping this transaction.
LOCK TABLE ONLY public.clinics IN SHARE MODE;
LOCK TABLE ONLY supabase_migrations.schema_migrations IN SHARE MODE;

CREATE TEMP TABLE cnyos_acl_plan(
  signature text PRIMARY KEY,
  allow_authenticated boolean NOT NULL,
  allow_service boolean NOT NULL,
  category text NOT NULL
) ON COMMIT DROP;
INSERT INTO cnyos_acl_plan(signature,allow_authenticated,allow_service,category) VALUES
""")
print(values + ";")
print(r"""
DO $pre$
DECLARE
  actual text[];
  expected text[];
  missing text[];
  extra text[];
  public_explicit bigint;
  anon_effective bigint;
  auth_effective bigint;
  service_effective bigint;
  security_definer bigint;
BEGIN
  SELECT array_agg(signature ORDER BY signature COLLATE "C") INTO expected
    FROM cnyos_acl_plan;
  SELECT array_agg(n.nspname||'.'||p.proname||'('||
      replace(oidvectortypes(p.proargtypes),', ',',')||')'
      ORDER BY n.nspname||'.'||p.proname||'('||
      replace(oidvectortypes(p.proargtypes),', ',',')||')' COLLATE "C")
    INTO actual
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public';
  SELECT array_agg(signature ORDER BY signature COLLATE "C") INTO missing
    FROM (SELECT signature FROM cnyos_acl_plan EXCEPT SELECT unnest(actual)) d;
  SELECT array_agg(signature ORDER BY signature COLLATE "C") INTO extra
    FROM (SELECT unnest(actual) AS signature EXCEPT SELECT signature FROM cnyos_acl_plan) d;
  IF actual IS DISTINCT FROM expected THEN
    RAISE NOTICE 'CNYOS_STAGING_ACL_ROUTINE_SET_DIFF missing=%, extra=%',missing,extra;
    RAISE EXCEPTION 'CNYOS_STAGING_ACL_ROUTINE_SET_DRIFT';
  END IF;
  SELECT count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
           WHERE a.grantee=0 AND a.privilege_type='EXECUTE')),
         count(*) FILTER (WHERE has_function_privilege('anon',p.oid,'EXECUTE')),
         count(*) FILTER (WHERE has_function_privilege('authenticated',p.oid,'EXECUTE')),
         count(*) FILTER (WHERE has_function_privilege('service_role',p.oid,'EXECUTE')),
         count(*) FILTER (WHERE p.prosecdef)
    INTO public_explicit,anon_effective,auth_effective,service_effective,
         security_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public';
  IF public_explicit<>15 OR anon_effective<>86 OR auth_effective<>90
     OR service_effective<>115 OR security_definer<>141 THEN
    RAISE EXCEPTION 'CNYOS_STAGING_ACL_PRESTATE_DRIFT: public=%, anon=%, authenticated=%, service=%, definer=%',
      public_explicit,anon_effective,auth_effective,service_effective,
      security_definer;
  END IF;
  RAISE NOTICE 'CNYOS_ACL_PRESTATE public=%, anon=%, authenticated=%, service=%, definer=%',
    public_explicit,anon_effective,auth_effective,service_effective,
    security_definer;
END $pre$;

DO $mutate_acl$
DECLARE row record;
BEGIN
  FOR row IN SELECT signature FROM cnyos_acl_plan ORDER BY signature COLLATE "C" LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      row.signature
    );
  END LOOP;
  FOR row IN SELECT signature FROM cnyos_acl_plan
    WHERE allow_authenticated ORDER BY signature COLLATE "C" LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',row.signature);
  END LOOP;
  FOR row IN SELECT signature FROM cnyos_acl_plan
    WHERE allow_service ORDER BY signature COLLATE "C" LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',row.signature);
  END LOOP;
END $mutate_acl$;

-- These are the mutable creators on this managed staging database. The
-- supabase_admin defaults are platform-owned and cannot be changed by the
-- postgres role; they remain an explicit residual boundary in the evidence.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE pg_database_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE pg_database_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

DO $mutate_path$
DECLARE row record; current_config text; target_config text;
BEGIN
  FOR row IN
    SELECT p.oid::regprocedure::text AS signature,
           coalesce(array_to_string(p.proconfig,','),'') AS config
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef
    ORDER BY p.oid::regprocedure::text COLLATE "C"
  LOOP
    current_config := row.config;
    IF current_config LIKE '%pg_temp%' THEN CONTINUE; END IF;
    IF current_config = 'search_path=pg_catalog' THEN
      target_config := 'pg_catalog, pg_temp';
    ELSIF current_config = 'search_path=pg_catalog, public'
       OR current_config = 'search_path=public'
       OR current_config = '' THEN
      target_config := 'pg_catalog, public, pg_temp';
    ELSE
      RAISE EXCEPTION 'CNYOS_STAGING_ACL_UNREVIEWED_SEARCH_PATH: %=%',
        row.signature,current_config;
    END IF;
    EXECUTE format('ALTER FUNCTION %s SET search_path TO %s',
      row.signature,target_config);
  END LOOP;
END $mutate_path$;

DO $post$
DECLARE
  actual text[]; expected text[];
  public_explicit bigint; anon_effective bigint; auth_effective bigint;
  service_effective bigint; bad_path bigint; bad_defaults bigint;
BEGIN
  SELECT array_agg(signature ORDER BY signature COLLATE "C") INTO expected
    FROM cnyos_acl_plan;
  SELECT array_agg(n.nspname||'.'||p.proname||'('||
      replace(oidvectortypes(p.proargtypes),', ',',')||')'
      ORDER BY n.nspname||'.'||p.proname||'('||
      replace(oidvectortypes(p.proargtypes),', ',',')||')' COLLATE "C")
    INTO actual
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public';
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'CNYOS_STAGING_ACL_POST_ROUTINE_SET_DRIFT';
  END IF;
  SELECT count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
           WHERE a.grantee=0 AND a.privilege_type='EXECUTE')),
         count(*) FILTER (WHERE has_function_privilege('anon',p.oid,'EXECUTE')),
         count(*) FILTER (WHERE has_function_privilege('authenticated',p.oid,'EXECUTE')),
         count(*) FILTER (WHERE has_function_privilege('service_role',p.oid,'EXECUTE'))
    INTO public_explicit,anon_effective,auth_effective,service_effective
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public';
  IF public_explicit<>0 OR anon_effective<>0 OR auth_effective<>71
     OR service_effective<>75 THEN
    RAISE EXCEPTION 'CNYOS_STAGING_ACL_POST_ACCESS_INVALID: public=%, anon=%, authenticated=%, service=%',
      public_explicit,anon_effective,auth_effective,service_effective;
  END IF;
  SELECT count(*) INTO bad_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef
      AND (coalesce(array_to_string(p.proconfig,','),'')
             NOT LIKE 'search_path=pg_catalog%'
        OR coalesce(array_to_string(p.proconfig,','),'') NOT LIKE '%pg_temp%');
  IF bad_path<>0 THEN
    RAISE EXCEPTION 'CNYOS_STAGING_ACL_POST_SEARCH_PATH_INVALID: %',bad_path;
  END IF;
  SELECT count(*) INTO bad_defaults
    FROM pg_default_acl d JOIN pg_roles owner_role ON owner_role.oid=d.defaclrole
      LEFT JOIN pg_namespace schema_row ON schema_row.oid=d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(d.defaclacl,acldefault('f',d.defaclrole))) acl
      LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
    WHERE owner_role.rolname IN ('postgres','pg_database_owner')
      AND d.defaclobjtype='f'
      AND (schema_row.nspname IS NULL OR schema_row.nspname='public')
      AND coalesce(grantee.rolname,'PUBLIC') IN
        ('PUBLIC','anon','authenticated','service_role');
  IF bad_defaults<>0 THEN
    RAISE EXCEPTION 'CNYOS_STAGING_ACL_POST_DEFAULTS_INVALID: %',bad_defaults;
  END IF;
  RAISE NOTICE 'CNYOS_ACL_POSTSTATE public=%, anon=%, authenticated=%, service=%, bad_path=%, bad_defaults=%',
    public_explicit,anon_effective,auth_effective,service_effective,bad_path,bad_defaults;
END $post$;

\if :cnyos_apply
  COMMIT;
  SELECT 'CNYOS_STAGING_ACL_REMEDIATION_COMMITTED' AS status;
\else
  ROLLBACK;
  SELECT 'CNYOS_STAGING_ACL_REMEDIATION_DRY_RUN_ROLLED_BACK' AS status;
\endif
""")
PY

docker exec -i -u postgres "$container" psql -X -v cnyos_apply="$apply" -d postgres <"$sql"
