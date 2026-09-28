import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPriceMasterFixture } from './helpers/price-master-fixture.mjs';

// Entirely disposable: installs the manual candidate only in this in-memory DB.
const { db, ids, asOwner, asUser, asAnon } = await createPriceMasterFixture();
try {
  await asOwner('select 1');
  // Hosted installations may have pre-existing direct default grants. PUBLIC-only
  // revocation must not accidentally leave internal mutators callable.
  await db.exec(`alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  // Original manual candidate from 4283e3b: upgrade populated rows, not just an
  // empty installation. This historical fixture must never be applied live.
  await db.exec(await fs.readFile(new URL('./fixtures/ttm-review-legacy.sql', import.meta.url), 'utf8'));
  const oldTarget = (await asOwner(`insert into public.ttm_concepts(concept_code,concept_type,preferred_term_th,foundation_layer,definition)
    values ('SYNTHETIC-UPGRADE','knowledge_rule','Synthetic upgrade',2,'Original') returning id`)).rows[0].id;
  const oldSuggestion = (await asUser(ids.userA, `select * from public.submit_ttm_knowledge_suggestion(
    'ttm_concepts','${oldTarget}','update','{"definition":"Proposed"}',
    'synthetic source','Synthetic legacy proposal')`)).rows[0];
  const oldEvents = (await asOwner(`select * from public.ttm_knowledge_suggestion_events where suggestion_id='${oldSuggestion.id}'`)).rows;
  await db.exec(await fs.readFile(new URL('../supabase/manual/20260917_ttm_knowledge_review_rpc_candidate.sql', import.meta.url), 'utf8'));
  // Reapplying the candidate must also preserve records and their timestamps.
  await db.exec(await fs.readFile(new URL('../supabase/manual/20260917_ttm_knowledge_review_rpc_candidate.sql', import.meta.url), 'utf8'));
  const upgraded = (await asOwner(`select * from public.ttm_knowledge_suggestions where id='${oldSuggestion.id}'`)).rows[0];
  const { target_snapshot, client_request_id, ...originalFields } = upgraded;
  assert.equal(client_request_id, null);
  assert.equal(target_snapshot, null, 'never invent a historical target snapshot');
  assert.deepEqual(originalFields, oldSuggestion);
  const upgradedEvents = (await asOwner(`select * from public.ttm_knowledge_suggestion_events where suggestion_id='${oldSuggestion.id}'`)).rows;
  assert.equal(upgradedEvents.length, oldEvents.length);
  for (const [index, event] of upgradedEvents.entries()) {
    const { target_table, target_id, before_snapshot, after_snapshot, ...originalEvent } = event;
    assert.deepEqual([target_table,target_id,before_snapshot,after_snapshot], [null,null,null,null]);
    assert.deepEqual(originalEvent, oldEvents[index]);
  }
  await assert.rejects(asUser(ids.superAdmin, `select * from public.decide_ttm_knowledge_suggestion('${oldSuggestion.id}','approve','Synthetic upgrade decision')`), /TTM_SUGGESTION_TARGET_CHANGED_RESUBMIT/);
  assert.equal((await asOwner(`select definition from public.ttm_concepts where id='${oldTarget}'`)).rows[0].definition, 'Original');
  assert.equal((await asUser(ids.superAdmin, `select * from public.decide_ttm_knowledge_suggestion('${oldSuggestion.id}','reject','Resubmit with fresh evidence')`)).rows[0].status, 'rejected');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await asOwner(`select has_function_privilege('${role}','public.apply_ttm_knowledge_suggestion(uuid)','EXECUTE') allowed`)).rows[0].allowed, false, `${role} cannot call internal apply`);
    for (const table of ['ttm_knowledge_suggestions','ttm_knowledge_suggestion_events']) {
      for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
        assert.equal((await asOwner(`select has_table_privilege('${role}','public.${table}','${privilege}') allowed`)).rows[0].allowed,
          role === 'authenticated' && privilege === 'SELECT', `${role}/${table}/${privilege}`);
      }
    }
    for (const signature of ['submit_ttm_knowledge_suggestion(text,uuid,text,jsonb,text,text)', 'decide_ttm_knowledge_suggestion(uuid,text,text)']) {
      assert.equal((await asOwner(`select has_function_privilege('${role}','public.${signature}','EXECUTE') allowed`)).rows[0].allowed, role === 'authenticated');
    }
  }
  const submit = async key => (await asUser(ids.userA, `select * from public.submit_ttm_knowledge_suggestion(
    'ttm_diagnostic_knowledge',null,'create',
    '{"domain":"constitution","rule_key":"${key}","input_key":"SYNTHETIC ONLY","output_value":"Not clinical knowledge"}',
    'synthetic source','Synthetic review regression')`)).rows[0];
  const requestId = '77777777-1111-4111-8111-111111111111';
  const submitOnceSql = (value='Synthetic replay value') => `select * from public.submit_ttm_knowledge_suggestion_once(
    '${requestId}','ttm_diagnostic_knowledge',null,'create',
    '{"domain":"constitution","rule_key":"SYNTHETIC-REPLAY","input_key":"Synthetic","output_value":"${value}"}',
    'synthetic source','Synthetic replay regression')`;
  const once = (await asUser(ids.userA, submitOnceSql())).rows[0];
  const replay = (await asUser(ids.userA, submitOnceSql())).rows[0];
  assert.deepEqual(replay, once, 'lost-response retry returns original row');
  assert.equal((await asOwner(`select count(*)::int n from public.ttm_knowledge_suggestion_events where suggestion_id='${once.id}'`)).rows[0].n, 1);
  await assert.rejects(asUser(ids.userA, submitOnceSql('Different value')), /TTM_REQUEST_CONTENT_CONFLICT/);
  await assert.rejects(asAnon(submitOnceSql()), /permission denied/);
  const otherClinic = (await asUser(ids.userB, submitOnceSql())).rows[0];
  assert.notEqual(otherClinic.id, once.id, 'another clinic cannot replay or see the first proposal');
  for (const role of ['anon','authenticated','service_role']) {
    assert.equal((await asOwner(`select has_function_privilege('${role}',
      'public.submit_ttm_knowledge_suggestion_once(uuid,text,uuid,text,jsonb,text,text)','EXECUTE') allowed`)).rows[0].allowed, role === 'authenticated');
  }
  const decide = (user, id, action) => asUser(user, `select * from public.decide_ttm_knowledge_suggestion('${id}','${action}','Synthetic decision only')`);
  await decide(ids.superAdmin, once.id, 'approve');
  const decidedReplay = (await asUser(ids.userA, submitOnceSql())).rows[0];
  assert.equal(decidedReplay.id, once.id);
  assert.equal(decidedReplay.status, 'approved', 'retry does not create a new pending proposal after decision');
  assert.equal((await asOwner(`select count(*)::int n from public.ttm_knowledge_suggestions where client_request_id='${requestId}' and requested_by='${ids.userA}'`)).rows[0].n, 1);
  const suggestion = await submit('SYNTHETIC-APPROVE');
  await assert.rejects(decide(ids.userA, suggestion.id, 'approve'), /TTM_SUPER_ADMIN_REQUIRED/);
  await assert.rejects(asAnon(`select * from public.decide_ttm_knowledge_suggestion('${suggestion.id}','approve','Synthetic decision only')`), /permission denied/);
  await assert.rejects(asUser(ids.superAdmin, `select public.apply_ttm_knowledge_suggestion('${suggestion.id}')`), /permission denied/);
  const approved = (await decide(ids.superAdmin, suggestion.id, 'approve')).rows[0];
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decided_by, ids.superAdmin);
  assert.equal((await asOwner(`select status from public.approval_tasks where id='${suggestion.approval_task_id}'`)).rows[0].status, 'approved');
  assert.equal((await asOwner(`select count(*)::int n from public.ttm_diagnostic_knowledge where rule_key='SYNTHETIC-APPROVE'`)).rows[0].n, 1);
  await assert.rejects(decide(ids.superAdmin, suggestion.id, 'approve'), /TTM_SUGGESTION_ALREADY_DECIDED/);
  const rejectedSuggestion = await submit('SYNTHETIC-REJECT');
  assert.equal((await decide(ids.superAdmin, rejectedSuggestion.id, 'reject')).rows[0].status, 'rejected');
  assert.equal((await asOwner(`select count(*)::int n from public.ttm_diagnostic_knowledge where rule_key='SYNTHETIC-REJECT'`)).rows[0].n, 0);
  const events = (await asOwner(`select event,to_status from public.ttm_knowledge_suggestion_events where suggestion_id='${suggestion.id}' order by created_at,id`)).rows;
  assert.ok(events.some(row => row.event === 'approve' && row.to_status === 'approved'));
  const target = (await asOwner(`select id from public.ttm_diagnostic_knowledge where rule_key='SYNTHETIC-APPROVE'`)).rows[0].id;
  const createdEvidence = (await asOwner(`select * from public.ttm_knowledge_suggestion_events where suggestion_id='${suggestion.id}' and event='knowledge_applied'`)).rows;
  assert.equal(createdEvidence.length, 1);
  assert.equal(createdEvidence[0].target_id, target);
  assert.equal(createdEvidence[0].before_snapshot, null);
  assert.equal(createdEvidence[0].after_snapshot.output_value, 'Not clinical knowledge');
  assert.equal(createdEvidence[0].actor_id, ids.superAdmin);
  const eventRead = `select after_snapshot from public.ttm_knowledge_suggestion_events where id='${createdEvidence[0].id}'`;
  assert.equal((await asUser(ids.userA, eventRead)).rows[0].after_snapshot.output_value, 'Not clinical knowledge');
  assert.equal((await asUser(ids.superAdmin, eventRead)).rows.length, 1);
  assert.equal((await asUser(ids.userB, eventRead)).rows.length, 0);
  await assert.rejects(asAnon(eventRead), /permission denied/);
  const update = async () => (await asUser(ids.userA, `select * from public.submit_ttm_knowledge_suggestion(
    'ttm_diagnostic_knowledge','${target}','update','{"output_value":"Synthetic revised value"}',
    'synthetic source','Synthetic update regression')`)).rows[0];
  const stale = await update();
  assert.equal(stale.target_snapshot.output_value, 'Not clinical knowledge');
  await asOwner(`update public.ttm_diagnostic_knowledge set output_value='Concurrent synthetic edit' where id='${target}'`);
  await assert.rejects(decide(ids.superAdmin, stale.id, 'approve'), /TTM_SUGGESTION_TARGET_CHANGED_RESUBMIT/);
  assert.equal((await asOwner(`select status from public.ttm_knowledge_suggestions where id='${stale.id}'`)).rows[0].status, 'pending');
  assert.equal((await asOwner(`select status from public.approval_tasks where id='${stale.approval_task_id}'`)).rows[0].status, 'pending');
  assert.equal((await asOwner(`select count(*)::int n from public.ttm_knowledge_suggestion_events where suggestion_id='${stale.id}'`)).rows[0].n, 1);
  assert.equal((await asOwner(`select output_value from public.ttm_diagnostic_knowledge where id='${target}'`)).rows[0].output_value, 'Concurrent synthetic edit');
  // Stale proposals remain rejectable; approval requires a fresh submission.
  assert.equal((await decide(ids.superAdmin, stale.id, 'reject')).rows[0].status, 'rejected');
  const fresh = await update();
  assert.equal((await decide(ids.superAdmin, fresh.id, 'approve')).rows[0].status, 'approved');
  assert.equal((await asOwner(`select output_value from public.ttm_diagnostic_knowledge where id='${target}'`)).rows[0].output_value, 'Synthetic revised value');
  const updatedEvidence = (await asOwner(`select * from public.ttm_knowledge_suggestion_events where suggestion_id='${fresh.id}' and event='knowledge_applied'`)).rows[0];
  assert.equal(updatedEvidence.before_snapshot.output_value, 'Concurrent synthetic edit');
  assert.equal(updatedEvidence.after_snapshot.output_value, 'Synthetic revised value');
  await assert.rejects(asUser(ids.superAdmin, `update public.ttm_knowledge_suggestion_events set after_snapshot='{}' where id='${updatedEvidence.id}'`), /permission denied/);
  await assert.rejects(asOwner(`delete from public.ttm_knowledge_suggestion_events where id='${updatedEvidence.id}'`), /APPEND_ONLY/i);
  const legacy = await update();
  await asOwner(`update public.ttm_knowledge_suggestions set target_snapshot=null where id='${legacy.id}'`);
  await assert.rejects(decide(ids.superAdmin, legacy.id, 'approve'), /TTM_SUGGESTION_TARGET_CHANGED_RESUBMIT/);
  await assert.rejects(asUser(ids.superAdmin, `select * from public.decide_ttm_knowledge_suggestion('${legacy.id}',null,'Synthetic decision only')`), /TTM_DECISION_INVALID/);
  const conceptId = (await asOwner(`insert into public.ttm_concepts(concept_code,concept_type,preferred_term_th,foundation_layer,definition)
    values ('SYNTHETIC-REVIEW','knowledge_rule','Synthetic concept',2,'Original synthetic text') returning id`)).rows[0].id;
  const proposeConcept = async () => (await asUser(ids.userA, `select * from public.submit_ttm_knowledge_suggestion(
    'ttm_concepts','${conceptId}','update',
    '{"concept_code":"SYNTHETIC-REVIEW","concept_type":"knowledge_rule","preferred_term_th":"Synthetic concept","definition":"Reviewed synthetic text"}',
    'synthetic source','Synthetic concept update')`)).rows[0];
  const conceptStale = await proposeConcept();
  await asOwner(`update public.ttm_concepts set definition='Newer synthetic text' where id='${conceptId}'`);
  await assert.rejects(decide(ids.superAdmin, conceptStale.id, 'approve'), /TTM_SUGGESTION_TARGET_CHANGED_RESUBMIT/);
  const conceptFresh = await proposeConcept();
  assert.equal((await decide(ids.superAdmin, conceptFresh.id, 'approve')).rows[0].status, 'approved');
  assert.equal((await asOwner(`select definition from public.ttm_concepts where id='${conceptId}'`)).rows[0].definition, 'Reviewed synthetic text');
  const conceptEvidence = (await asOwner(`select before_snapshot,after_snapshot from public.ttm_knowledge_suggestion_events where suggestion_id='${conceptFresh.id}' and event='knowledge_applied'`)).rows[0];
  assert.equal(conceptEvidence.before_snapshot.definition, 'Newer synthetic text');
  assert.equal(conceptEvidence.after_snapshot.definition, 'Reviewed synthetic text');
  assert.equal((await asUser(ids.userB, `select id from public.ttm_knowledge_suggestions where id='${legacy.id}'`)).rows.length, 0);
  await asOwner(`update public.profiles set system_role='super_admin' where id='${ids.userB}'`);
  await assert.rejects(decide(ids.userB, legacy.id, 'approve'), /TTM_SUGGESTION_NOT_FOUND/);
  // Producer/approver separation still applies even after the producer gains support role.
  await asOwner(`update public.profiles set system_role='super_admin' where id='${ids.userA}'`);
  await assert.rejects(decide(ids.userA, legacy.id, 'reject'), /TTM_PRODUCER_CANNOT_APPROVE/);
  console.log('TTM manual candidate behavioral decisions passed: approve/reject, atomic task state, stale/missing-snapshot refusal, resubmit, duplicate and unauthorized denial; not live authorization');
} finally { await db.close(); }
