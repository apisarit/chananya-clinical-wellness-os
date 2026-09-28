import assert from 'node:assert/strict';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

const { db, ids, asOwner, asUser, asAnon } = await createPriceMasterFixture();
try {
  await asOwner('select 1');
  await db.exec(`
    update public.profiles set role='admin' where id='${ids.userA}';
    update public.clinic_memberships set clinic_role='admin' where profile_id='${ids.userA}' and clinic_id='${ids.clinicA}';
    insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata) values
      ('${ids.clinicA}','${ids.userA}','assign_department_role','clinic_memberships','AUDIT-SYN-A','{"old_clinic_role":"viewer","new_clinic_role":"billing","reason":"synthetic test"}'),
      ('${ids.clinicB}','${ids.userB}','assign_department_role','clinic_memberships','AUDIT-SYN-B','{"old_clinic_role":"viewer","new_clinic_role":"billing","reason":"synthetic test"}');
  `);
  const query = `select entity_id,metadata->>'old_clinic_role' old_role,metadata->>'new_clinic_role' new_role from public.audit_logs where entity_id in ('AUDIT-SYN-A','AUDIT-SYN-B') order by entity_id`;
  const admin = await asUser(ids.userA, query);
  assert.deepEqual(admin.rows,[{entity_id:'AUDIT-SYN-A',old_role:'viewer',new_role:'billing'}]);
  assert.equal((await asUser(ids.userA, query.replace('order by entity_id',`and clinic_id='${ids.clinicB}' order by entity_id`))).rows.length,0);
  assert.equal((await asUser(ids.userB, query)).rows.length,0,'practitioner cannot read role-change history');
  await assert.rejects(asAnon(query),/permission denied/);
  await asOwner('select 1');
  await db.exec(`update public.profiles set role='admin' where id='${ids.userB}';
    update public.clinic_memberships set active=false where profile_id='${ids.userB}' and clinic_id='${ids.clinicA}';
    update public.clinic_memberships set clinic_role='admin' where profile_id='${ids.userB}' and clinic_id='${ids.clinicB}';`);
  assert.deepEqual((await asUser(ids.userB,query)).rows,[{entity_id:'AUDIT-SYN-B',old_role:'viewer',new_role:'billing'}]);
  const owner = await asUser(ids.owner,query);
  assert.deepEqual(owner.rows,[{entity_id:'AUDIT-SYN-A',old_role:'viewer',new_role:'billing'}]);
  await asOwner(`insert into public.audit_logs(clinic_id,user_id,action,entity,entity_id,metadata) values
    ('${ids.clinicA}','${ids.userA}','clinical_view','encounters','AUDIT-SYN-UNRELATED','{}')`);
  assert.equal((await asUser(ids.userA,"select id from public.audit_logs where entity_id='AUDIT-SYN-UNRELATED'")).rows.length,0);
  await asOwner(`update public.clinic_memberships set active=false where profile_id='${ids.userA}'`);
  assert.equal((await asUser(ids.userA,query)).rows.length,0,'inactive admin denied');
  const state = (await asOwner(`select subscription_version from public.clinics where id='${ids.clinicA}'`)).rows[0];
  await asOwner(`select public.set_clinic_subscription_state(
    'f1111111-1111-4111-a111-111111111111'::uuid,
    '${ids.clinicA}'::uuid,'CHANANYA',false,${state.subscription_version}::bigint,
    'Synthetic role history OFF test','${ids.owner}'::uuid,'owner@example.test')`);
  assert.equal((await asUser(ids.owner,query)).rows.length,0,'suspended clinic owner denied');
  console.log('Admin role audit boundary passed: own-clinic old/new values, bidirectional cross-clinic exclusion, practitioner and anonymous denial');
} finally { await db.close(); }
