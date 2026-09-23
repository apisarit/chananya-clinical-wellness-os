-- Repair only the query digest expression in the existing check-in search RPC.
-- CREATE OR REPLACE preserves the function OID, owner, ACL, and attributes.
do $$
declare
  v_oid oid := 'public.search_patients_for_checkin(text)'::regprocedure;
  v_definition text;
  v_original text := $expr$encode(digest(lower(v_query), 'sha256'), 'hex')$expr$;
  v_repaired text := $expr$encode(pg_catalog.sha256(pg_catalog.convert_to(lower(v_query), pg_catalog.current_setting('server_encoding'))), 'hex')$expr$;
  v_before_owner oid;
  v_before_acl aclitem[];
  v_before_config text[];
  v_before_secdef boolean;
  v_after_definition text;
  v_after_owner oid;
  v_after_acl aclitem[];
  v_after_config text[];
  v_after_secdef boolean;
begin
  select pg_catalog.pg_get_functiondef(v_oid), p.proowner, p.proacl, p.proconfig, p.prosecdef
    into v_definition, v_before_owner, v_before_acl, v_before_config, v_before_secdef
  from pg_catalog.pg_proc p
  where p.oid = v_oid;

  if v_definition is null then
    raise exception 'CHECKIN_SEARCH_DIGEST_TARGET_MISSING';
  end if;

  if position(v_repaired in v_definition) > 0
     and position(v_original in v_definition) = 0 then
    return; -- already repaired; deliberately idempotent
  end if;

  if position(v_original in v_definition) = 0
     or (length(v_definition) - length(replace(v_definition, v_original, ''))) / length(v_original) <> 1 then
    raise exception 'CHECKIN_SEARCH_DIGEST_UNEXPECTED_FUNCTION_SHAPE';
  end if;

  execute replace(v_definition, v_original, v_repaired);

  select pg_catalog.pg_get_functiondef(v_oid), p.proowner, p.proacl, p.proconfig, p.prosecdef
    into v_after_definition, v_after_owner, v_after_acl, v_after_config, v_after_secdef
  from pg_catalog.pg_proc p
  where p.oid = v_oid;

  if position(v_repaired in v_after_definition) = 0
     or position(v_original in v_after_definition) > 0 then
    raise exception 'CHECKIN_SEARCH_DIGEST_REPAIR_FAILED';
  end if;
  if v_after_owner is distinct from v_before_owner
     or v_after_acl is distinct from v_before_acl
     or v_after_config is distinct from v_before_config
     or v_after_secdef is distinct from v_before_secdef then
    raise exception 'CHECKIN_SEARCH_DIGEST_ATTRIBUTES_CHANGED';
  end if;
end;
$$;
