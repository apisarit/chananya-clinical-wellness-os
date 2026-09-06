import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const triggerSql = await fs.readFile(new URL('../supabase/manual/202609060700_revoke_trigger_function_data_api_execute_candidate.sql', import.meta.url), 'utf8');
const browserSql = await fs.readFile(new URL('../supabase/manual/202609060710_close_browser_rpc_acl_drift_candidate.sql', import.meta.url), 'utf8');
const triggerNotice = 'CNYOS_TRIGGER_FUNCTION_DATA_API_CHECKS_PASSED';
const browserNotice = 'CNYOS_BROWSER_RPC_ACL_DRIFT_CHECKS_PASSED';
const browserHelpers = [
  'public.is_clinic_admin()',
  'public.is_reception_or_admin()',
  'public.is_practitioner()',
  'public.is_appointment_operator()',
  'public.is_appointment_practitioner()',
  'public.is_admin_or_super()',
  'public.current_user_role()',
  'public.clinical_financial_handoffs_healthcheck()',
  'public.department_persistence_healthcheck()',
  'public.production_execution_healthcheck()',
  'public.quality_release_healthcheck()',
  'public.prescription_dispensing_healthcheck()'
];
const browserWrites = [
  'public.book_clinic_appointment(uuid,uuid,text,text,text)',
  'public.cancel_clinic_appointment(uuid,text)',
  'public.set_clinic_appointment_status(uuid,text,text)',
  'public.create_approval_task(text,text,text,text,text,text,uuid,timestamptz,jsonb)',
  'public.decide_approval_task(uuid,text,text)',
  'public.sign_clinical_record_complete(uuid,text,text,text)',
  'public.unlock_clinical_record_for_amendment(uuid,text)'
];
const browserProcedures = [...browserHelpers, ...browserWrites];

function createBooleanFunction(signature) {
  return `create function ${signature} returns boolean language sql as 'select true';`;
}

const db = new PGlite();
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.acl_probe(id integer primary key, value integer, updated_at timestamptz);
    grant select, insert, update on public.acl_probe to anon, authenticated, service_role;
    create function public.set_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := pg_catalog.clock_timestamp(); return new; end $$;
    create function public.guard_acl_probe() returns trigger language plpgsql security definer
    set search_path = pg_catalog, public as $$
    begin
      if new.value < 0 then raise exception 'ACL_PROBE_NEGATIVE_VALUE_DENIED'; end if;
      return new;
    end $$;
    grant execute on function public.set_updated_at(), public.guard_acl_probe() to anon, authenticated, service_role;
    create trigger acl_probe_timestamp before insert or update on public.acl_probe
      for each row execute function public.set_updated_at();
    create trigger acl_probe_guard before insert or update on public.acl_probe
      for each row execute function public.guard_acl_probe();
  `);
  const bindings = async () => (await db.query('select oid,tgfoid,tgenabled from pg_trigger where not tgisinternal order by oid')).rows;
  const aclSnapshot = async () => (await db.query("select oid,proacl::text,proconfig from pg_proc where pronamespace='public'::regnamespace order by oid")).rows;

  // Run a failed candidate the way both ordinary continue-on-error clients and
  // clients using per-statement savepoints do. Neither may retain partial ACL
  // changes or emit a provisional success notice.
  async function assertAtomicFailure(sql, expectedError, noticePrefix) {
    const start = sql.indexOf('do $$\n');
    const end = sql.indexOf('\nend $$;') + '\nend $$;'.length;
    assert.ok(start > 0 && end > start);
    assert.equal((sql.match(/do \$\$/g) || []).length, 1);
    assert.equal(sql.slice(end).trim(), 'commit;');
    for (const useSavepoint of [false, true]) {
      const before = await aclSnapshot();
      const notices = [];
      const options = { onNotice: notice => notices.push(notice.message) };
      await db.exec(sql.slice(0, start), options);
      if (useSavepoint) await db.exec('savepoint client_statement;');
      await assert.rejects(db.exec(sql.slice(start, end), options), expectedError);
      if (useSavepoint) await db.exec('rollback to savepoint client_statement;');
      await db.exec(sql.slice(end), options);
      assert.deepEqual(await aclSnapshot(), before, 'a failed candidate must preserve every original ACL and function setting');
      assert.ok(!notices.some(message => message.startsWith(noticePrefix)), 'a failed candidate must not report success');
    }
  }

  await db.exec(`
    create role inherited_trigger_executor;
    grant execute on function public.guard_acl_probe() to inherited_trigger_executor;
    grant inherited_trigger_executor to authenticated;
  `);
  await assertAtomicFailure(triggerSql, /CNYOS_TRIGGER_FUNCTION_RUNTIME_EXECUTE_PRESENT/, triggerNotice);
  await db.exec('revoke inherited_trigger_executor from authenticated; revoke execute on function public.guard_acl_probe() from inherited_trigger_executor;');

  const beforeBindings = await bindings();
  const notices = [];
  await db.exec(triggerSql, { onNotice: notice => notices.push(notice.message) });
  assert.equal(notices.filter(message => message.startsWith(triggerNotice)).length, 1);
  assert.deepEqual(await bindings(), beforeBindings);
  for (const [index, role] of ['anon', 'authenticated', 'service_role'].entries()) {
    const privileges = (await db.query("select has_function_privilege($1, 'public.set_updated_at()', 'EXECUTE') timestamp_execute, has_function_privilege($1, 'public.guard_acl_probe()', 'EXECUTE') guard_execute", [role])).rows[0];
    assert.deepEqual(privileges, { timestamp_execute: false, guard_execute: false });
    await db.exec(`set role ${role}; insert into public.acl_probe(id,value) values (${index},1); update public.acl_probe set value=2 where id=${index};`);
    await assert.rejects(db.exec(`update public.acl_probe set value=-1 where id=${index};`), /ACL_PROBE_NEGATIVE_VALUE_DENIED/);
    await assert.rejects(db.exec('select public.set_updated_at();'), /permission denied for function set_updated_at/);
    await db.exec('reset role;');
  }
  assert.equal((await db.query('select count(*)::int count from public.acl_probe where value=2 and updated_at is not null')).rows[0].count, 3);

  // A missing function fails after earlier revokes have already run in the DO.
  await db.exec('drop function public.set_updated_at() cascade; grant execute on function public.guard_acl_probe() to anon, authenticated, service_role;');
  await assertAtomicFailure(triggerSql, /set_updated_at\(\).*does not exist/, triggerNotice);

  await db.exec(`
    create function public.is_clinic_admin() returns boolean language sql as 'select true';
    grant execute on function public.is_clinic_admin() to anon, authenticated, service_role;
  `);
  await assertAtomicFailure(browserSql, /CNYOS_BROWSER_RPC_REQUIRED_FUNCTION_MISSING/, browserNotice);

  await db.exec(browserProcedures.slice(1).map(createBooleanFunction).join('\n'));
  await db.exec(`
    grant execute on function ${browserProcedures.join(', ')} to anon, authenticated;
    grant execute on function ${browserHelpers.join(', ')} to service_role;
    grant execute on function ${browserWrites.join(', ')} to service_role;
  `);

  // A successful closure must leave exactly the direct, owner-issued,
  // non-grantable browser/service matrix and no default PUBLIC entry.
  const browserNotices = [];
  await db.exec(browserSql, { onNotice: notice => browserNotices.push(notice.message) });
  assert.equal(browserNotices.filter(message => message.startsWith(browserNotice)).length, 1);
  for (const signature of browserProcedures) {
    const rows = (await db.query(`
      select coalesce(grantee.rolname, 'PUBLIC') grantee,
             acl.privilege_type,
             acl.is_grantable,
             acl.grantor = p.proowner owner_grantor
      from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      left join pg_roles grantee on grantee.oid = acl.grantee
      where p.oid = to_regprocedure($1)
        and acl.grantee <> p.proowner
      order by grantee
    `, [signature])).rows;
    const expectedGrantees = browserHelpers.includes(signature)
      ? ['authenticated', 'service_role']
      : ['authenticated'];
    assert.deepEqual(rows, expectedGrantees.map(grantee => ({
      grantee,
      privilege_type: 'EXECUTE',
      is_grantable: false,
      owner_grantor: true
    })));
  }

  await db.exec('create role rogue_browser_executor; grant execute on function public.is_clinic_admin() to rogue_browser_executor;');
  await assertAtomicFailure(browserSql, /CNYOS_BROWSER_RPC_ACL_INVALID/, browserNotice);
  await db.exec('revoke execute on function public.is_clinic_admin() from rogue_browser_executor;');

  await db.exec('grant execute on function public.is_clinic_admin() to authenticated with grant option;');
  await assertAtomicFailure(browserSql, /CNYOS_BROWSER_RPC_ACL_(?:MISSING|INVALID)/, browserNotice);
  await db.exec('revoke grant option for execute on function public.is_clinic_admin() from authenticated;');

  await db.exec(`
    create role delegated_acl_grantor;
    grant execute on function public.is_clinic_admin() to delegated_acl_grantor with grant option;
    set role delegated_acl_grantor;
    grant execute on function public.is_clinic_admin() to authenticated;
    reset role;
  `);
  await assertAtomicFailure(browserSql, /CNYOS_BROWSER_RPC_ACL_INVALID/, browserNotice);
  await db.exec(`
    set role delegated_acl_grantor;
    revoke execute on function public.is_clinic_admin() from authenticated;
    reset role;
    revoke grant option for execute on function public.is_clinic_admin() from delegated_acl_grantor cascade;
    revoke execute on function public.is_clinic_admin() from delegated_acl_grantor;
  `);

  await db.exec(`
    create role inherited_browser_executor;
    grant execute on function public.book_clinic_appointment(uuid,uuid,text,text,text) to inherited_browser_executor;
    grant inherited_browser_executor to authenticated;
    revoke execute on function public.book_clinic_appointment(uuid,uuid,text,text,text) from authenticated;
  `);
  await assertAtomicFailure(browserSql, /CNYOS_BROWSER_RPC_ACL_MISSING/, browserNotice);
} finally {
  await db.close();
}

const shadowDb = new PGlite();
try {
  await shadowDb.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.shadow_probe(id integer, updated_at timestamptz);
    create function public.set_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := pg_catalog.clock_timestamp(); return new; end $$;
    create trigger shadow_probe_timestamp before insert or update on public.shadow_probe
      for each row execute function public.set_updated_at();
    grant execute on function public.set_updated_at() to anon, authenticated, service_role;
    ${browserProcedures.map(createBooleanFunction).join('\n')}
    grant execute on function ${browserProcedures.join(', ')} to anon, authenticated;
    grant execute on function ${browserHelpers.join(', ')} to service_role;
    grant execute on function ${browserWrites.join(', ')} to service_role;
    create temp table pg_proc(blocker integer);
    create temp table pg_namespace(blocker integer);
    create temp table pg_trigger(blocker integer);
    create temp table pg_roles(blocker integer);
  `);
  const shadowNotices = [];
  const shadowOptions = { onNotice: notice => shadowNotices.push(notice.message) };
  await shadowDb.exec(triggerSql, shadowOptions);
  await shadowDb.exec(browserSql, shadowOptions);
  assert.equal(shadowNotices.filter(message => message.startsWith(triggerNotice)).length, 1);
  assert.equal(shadowNotices.filter(message => message.startsWith(browserNotice)).length, 1);
} finally {
  await shadowDb.close();
}

console.log('ACL candidate PostgreSQL contract passed: exact browser ACLs, rogue/grantable/inherited/non-owner-grantor drift rollback, missing functions, inherited trigger grants, and bound-trigger behavior');
