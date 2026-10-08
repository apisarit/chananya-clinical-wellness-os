import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SYNTHETIC_UAT_CASES } from '../tests/fixtures/synthetic-uat-cases.mjs';
import {
  loadStagingCredentials,
  loadStagingTarget,
  requestJson,
  rpc,
  signInStagingRole,
  sourceCommit,
  supabaseUrl,
  writeEvidence
} from './staging-support.mjs';

const target = loadStagingTarget();
const credentials = loadStagingCredentials();
if (process.env.STAGING_SYNTHETIC_UAT_ACK !== 'CREATE_SYNTHETIC_RECORDS') {
  throw new Error('STAGING_SYNTHETIC_UAT_ACK=CREATE_SYNTHETIC_RECORDS is required');
}

const rawRun = process.env.STAGING_UAT_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;
const runId = rawRun.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 24);
if (runId.length < 8) throw new Error('STAGING_UAT_RUN_ID must contain at least 8 letters or digits');

const signedIn = {};
for (const role of ['reception', 'practitioner', 'pharmacy_reviewer', 'pharmacy_dispenser', 'billing']) {
  signedIn[role] = await signInStagingRole(target, role);
}
const token = role => signedIn[role].session.access_token;
const first = value => Array.isArray(value) ? value[0] : value;
assert.notEqual(
  signedIn.reception.session.user.id,
  signedIn.practitioner.session.user.id,
  'Reception and practitioner staging evidence must use distinct authenticated accounts'
);

async function serviceRequest(resource, options = {}) {
  return requestJson(supabaseUrl(target, resource), {
    key: credentials.serviceRoleKey,
    bearer: credentials.serviceRoleKey,
    ...options
  });
}

async function expectDenied(action, pattern, label) {
  try {
    await action();
  } catch (error) {
    assert.match(error.message, pattern, label);
    return;
  }
  assert.fail(`${label}: operation unexpectedly succeeded`);
}

function futureDate(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function futureSchedule(index) {
  const startsAt = new Date(Date.now() + (48 * 60 + index * 60) * 60_000);
  startsAt.setUTCSeconds(0, 0);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

const results = [];
for (const [index, demo] of SYNTHETIC_UAT_CASES.entries()) {
  const caseId = `STG-${runId}-${demo.id}`;
  const sku = `E2E-${runId}-${demo.id}`;
  const product = first(await rpc(target, token('pharmacy_reviewer'), 'upsert_product_master', {
    p_product_id: null,
    p_sku: sku,
    p_name_th: demo.product,
    p_name_en: 'SYNTHETIC STAGING PRODUCT — NOT FOR CLINICAL USE',
    p_category: 'medicine',
    p_dosage_form: 'synthetic-e2e',
    p_purchase_unit: 'ขวด',
    p_stock_unit: 'ขวด',
    p_dispense_unit: 'ขวด',
    p_conversion_factor: 1,
    p_standard_cost: 25,
    p_min_stock: 0,
    p_reorder_level: 0
  }));
  assert.ok(product?.id, `${caseId}: product was not created`);
  const configuredPrice = first(await rpc(target, token('billing'), 'set_clinic_product_price', {
    p_product_id: product.id,
    p_unit_price: demo.price,
    p_currency: 'THB',
    p_reason: `Synthetic staging price for ${caseId}`
  }));
  assert.equal(Number(configuredPrice?.unit_price), demo.price, `${caseId}: governed product price was not configured`);

  const lotRows = [
    {
      clinic_id: target.config.tenant.expectedClinicId,
      product_id: product.id,
      lot_number: `${caseId}-FEFO-1`,
      expiry_date: futureDate(30),
      received_quantity: 1,
      current_quantity: 1,
      unit: 'ขวด',
      purchase_cost: 25,
      status: 'active'
    },
    {
      clinic_id: target.config.tenant.expectedClinicId,
      product_id: product.id,
      lot_number: `${caseId}-FEFO-2`,
      expiry_date: futureDate(180),
      received_quantity: 20,
      current_quantity: 20,
      unit: 'ขวด',
      purchase_cost: 25,
      status: 'active'
    }
  ];
  const lots = await serviceRequest('/rest/v1/inventory_lots', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: lotRows,
    expected: [200, 201]
  });
  assert.equal(lots.length, 2, `${caseId}: two FEFO lots were not created`);
  await serviceRequest('/rest/v1/audit_logs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: lots.map(lot => ({
      clinic_id: target.config.tenant.expectedClinicId,
      user_id: null,
      action: 'seed_synthetic_staging_inventory_lot',
      entity: 'inventory_lots',
      entity_id: lot.id,
      metadata: { synthetic_only: true, staging_run_id: runId, case_id: caseId }
    })),
    expected: [200, 201, 204]
  });

  const patient = first(await rpc(target, token('reception'), 'upsert_patient_registration', {
    p_patient_id: null,
    p_prefix: demo.prefix,
    p_first_name: `${demo.first}${runId.slice(-4)}`,
    p_last_name: demo.last,
    p_national_id: null,
    p_gender: demo.gender,
    p_date_of_birth: demo.dob,
    p_phone: null,
    p_address: 'ข้อมูลสังเคราะห์สำหรับ isolated staging เท่านั้น',
    p_payment_right: 'SYNTHETIC-E2E',
    p_emergency_contact_name: null,
    p_allergy: 'ไม่มี — ข้อมูลสังเคราะห์'
  }));
  assert.ok(patient?.id && patient?.hn, `${caseId}: patient registration failed`);

  const { startsAt, endsAt } = futureSchedule(index);
  const schedule = first(await rpc(target, token('reception'), 'create_practitioner_schedule', {
    p_practitioner_id: signedIn.practitioner.session.user.id,
    p_title: `Synthetic staging appointment ${caseId}`,
    p_starts_at: startsAt,
    p_ends_at: endsAt,
    p_branch_code: 'SYNTHETIC',
    p_room_code: `E2E-${index + 1}`,
    p_max_patients: 1,
    p_slot_minutes: 30,
    p_notes: `Synthetic UAT only; staging run ${runId}`
  }));
  assert.ok(schedule?.id, `${caseId}: reception could not create the practitioner schedule`);
  assert.equal(
    schedule.practitioner_id,
    signedIn.practitioner.session.user.id,
    `${caseId}: schedule was not assigned to the authenticated practitioner`
  );

  const appointment = first(await rpc(target, token('reception'), 'book_clinic_appointment', {
    p_patient_id: patient.id,
    p_schedule_id: schedule.id,
    p_chief_complaint: demo.symptom,
    p_notes: `Synthetic reception booking ${caseId}`,
    p_booking_source: 'staff'
  }));
  assert.ok(appointment?.id && appointment?.appointment_no, `${caseId}: reception booking failed`);
  assert.equal(appointment.patient_id, patient.id, `${caseId}: appointment patient changed during booking`);
  assert.equal(
    appointment.practitioner_id,
    signedIn.practitioner.session.user.id,
    `${caseId}: appointment lost the selected practitioner assignment`
  );
  assert.equal(
    appointment.created_by,
    signedIn.reception.session.user.id,
    `${caseId}: appointment was not created by the reception account`
  );

  const encounter = first(await rpc(target, token('reception'), 'check_in_clinic_appointment', {
    p_appointment_id: appointment.id,
    p_patient_id: patient.id,
    p_qr_session_id: null,
    p_verification_method: 'manual_hn',
    p_patient_present_confirmed: true,
    p_verification_note: `Synthetic reception check-in ${caseId}`,
    p_chief_complaint: demo.symptom,
    p_intake: { pulse: 72, pain_before: 3, synthetic_only: true, staging_run_id: runId }
  }));
  assert.ok(encounter?.encounter_id, `${caseId}: reception check-in did not create an encounter`);
  assert.equal(encounter.patient_id, patient.id, `${caseId}: check-in encounter patient mismatch`);
  assert.equal(
    encounter.practitioner_id,
    signedIn.practitioner.session.user.id,
    `${caseId}: check-in did not preserve the appointment practitioner`
  );
  assert.equal(encounter.appointment_status, 'checked_in', `${caseId}: appointment was not checked in`);
  assert.equal(encounter.reused, false, `${caseId}: fresh synthetic appointment unexpectedly reused an encounter`);

  const encounterRows = await requestJson(
    supabaseUrl(
      target,
      `/rest/v1/encounters?select=id,patient_id,practitioner_id,created_by,status&id=eq.${encounter.encounter_id}`
    ),
    {
      key: target.config.database.publishableKey,
      bearer: token('practitioner')
    }
  );
  assert.equal(encounterRows.length, 1, `${caseId}: checked-in encounter was not persisted`);
  assert.equal(
    encounterRows[0].created_by,
    signedIn.reception.session.user.id,
    `${caseId}: encounter creator is not the reception check-in actor`
  );
  assert.equal(
    encounterRows[0].practitioner_id,
    signedIn.practitioner.session.user.id,
    `${caseId}: persisted encounter assignment differs from the booked practitioner`
  );

  const startedAppointment = first(await rpc(target, token('practitioner'), 'set_clinic_appointment_status', {
    p_appointment_id: appointment.id,
    p_new_status: 'in_service',
    p_note: `Synthetic practitioner accepted handoff ${caseId}`
  }));
  assert.equal(startedAppointment.status, 'in_service', `${caseId}: practitioner did not accept the checked-in case`);
  assert.equal(
    startedAppointment.practitioner_id,
    signedIn.practitioner.session.user.id,
    `${caseId}: practitioner accepted an appointment assigned to another account`
  );
  const appointmentEvents = await requestJson(
    supabaseUrl(
      target,
      `/rest/v1/appointment_events?select=event_type,new_status,actor_id&appointment_id=eq.${appointment.id}&order=created_at.asc`
    ),
    {
      key: target.config.database.publishableKey,
      bearer: token('reception')
    }
  );
  const bookedEvent = appointmentEvents.find(event => event.event_type === 'booked');
  const checkInEvent = appointmentEvents.find(event => event.event_type === 'encounter_opened');
  const inServiceEvent = appointmentEvents.find(
    event => event.event_type === 'status_changed' && event.new_status === 'in_service'
  );
  assert.equal(bookedEvent?.actor_id, signedIn.reception.session.user.id, `${caseId}: booking actor is not reception`);
  assert.equal(checkInEvent?.actor_id, signedIn.reception.session.user.id, `${caseId}: check-in actor is not reception`);
  assert.equal(
    inServiceEvent?.actor_id,
    signedIn.practitioner.session.user.id,
    `${caseId}: in-service handoff was not accepted by the assigned practitioner`
  );

  const diagnosisId = await rpc(target, token('practitioner'), 'save_ttm_diagnosis_atomic', {
    p_encounter_id: encounter.encounter_id,
    p_dhatu_samutthan: 'วาโย',
    p_present_constitution: demo.dosha,
    p_analysis_summary: `Synthetic staging UAT ${caseId}: ${demo.symptom}`,
    p_thai_diagnosis: demo.diagnosis,
    p_dosha_state: demo.dosha,
    p_practitioner_confirmed: true,
    p_knowledge_version: 'TTM-SYNTHETIC-STAGING-v1'
  });
  assert.match(String(diagnosisId), /^[0-9a-f-]{36}$/i, `${caseId}: diagnosis was not saved`);

  const prescription = first(await rpc(target, token('practitioner'), 'create_atomic_prescription_handoff', {
    p_request_key: randomUUID(),
    p_encounter_id: encounter.encounter_id,
    p_clinical_notes: `${caseId} synthetic practitioner handoff — not clinical advice`,
    p_items: [{
      product_id: product.id,
      quantity_prescribed: demo.qty,
      unit: 'ขวด',
      dose: 'ตามฉลากสาธิต',
      frequency: 'demo only',
      duration: 'demo only',
      instructions: 'ข้อมูลสังเคราะห์ ห้ามใช้เป็นคำแนะนำการรักษา'
    }]
  }));
  assert.ok(prescription?.prescription_id && prescription?.dispensing_order_id, `${caseId}: prescription handoff failed`);

  if (index === 0) {
    await expectDenied(
      () => rpc(target, token('practitioner'), 'transition_atomic_prescription_dispensing', {
        p_dispensing_order_id: prescription.dispensing_order_id,
        p_action: 'review',
        p_item_prices: [],
        p_reason: null
      }),
      /PHARMACY_DEPARTMENT_REQUIRED/,
      'Practitioner must not perform Pharmacy review'
    );
  }

  await rpc(target, token('pharmacy_reviewer'), 'transition_atomic_prescription_dispensing', {
    p_dispensing_order_id: prescription.dispensing_order_id,
    p_action: 'review',
    p_item_prices: [],
    p_reason: 'Synthetic UAT pharmacist review'
  });
  const items = await requestJson(supabaseUrl(target, `/rest/v1/prescription_items?select=id,product_id,quantity_prescribed,unit&prescription_id=eq.${prescription.prescription_id}`), {
    key: target.config.database.publishableKey,
    bearer: token('pharmacy_reviewer')
  });
  assert.equal(items.length, 1, `${caseId}: Pharmacy cannot read its prescription item`);
  await expectDenied(
    () => rpc(target, token('pharmacy_reviewer'), 'transition_atomic_prescription_dispensing', {
      p_dispensing_order_id: prescription.dispensing_order_id,
      p_action: 'dispense',
      p_item_prices: [],
      p_reason: 'Synthetic UAT same-actor separation proof'
    }),
    /PRESCRIPTION_REVIEWER_DISPENSER_MUST_DIFFER/,
    'The Pharmacy reviewer must not dispense the order they reviewed'
  );
  const dispensed = await rpc(target, token('pharmacy_dispenser'), 'transition_atomic_prescription_dispensing', {
    p_dispensing_order_id: prescription.dispensing_order_id,
    p_action: 'dispense',
    p_item_prices: [],
    p_reason: 'Synthetic UAT FEFO dispense'
  });
  assert.equal(dispensed.status, 'dispensed', `${caseId}: dispense did not complete`);
  assert.equal(dispensed.allocation_count, demo.qty > 1 ? 2 : 1, `${caseId}: FEFO allocation count mismatch`);
  const retry = await rpc(target, token('pharmacy_dispenser'), 'transition_atomic_prescription_dispensing', {
    p_dispensing_order_id: prescription.dispensing_order_id,
    p_action: 'dispense',
    p_item_prices: [],
    p_reason: 'Synthetic UAT idempotency retry'
  });
  assert.equal(retry.idempotent, true, `${caseId}: dispensing retry was not idempotent`);
  await rpc(target, token('pharmacy_dispenser'), 'transition_atomic_prescription_dispensing', {
    p_dispensing_order_id: prescription.dispensing_order_id,
    p_action: 'submit_billing',
    p_item_prices: [],
    p_reason: 'Synthetic UAT checkout handoff'
  });

  if (index === 0) {
    await expectDenied(
      () => rpc(target, token('pharmacy_dispenser'), 'issue_atomic_dispensing_invoice', {
        p_dispensing_order_id: prescription.dispensing_order_id,
        p_service_fee: demo.serviceFee,
        p_discount: demo.discount
      }),
      /PERMISSION_DENIED/,
      'Pharmacy must not issue the Billing invoice'
    );
  }

  const invoice = first(await rpc(target, token('billing'), 'issue_atomic_dispensing_invoice', {
    p_dispensing_order_id: prescription.dispensing_order_id,
    p_service_fee: demo.serviceFee,
    p_discount: demo.discount
  }));
  const expectedTotal = demo.qty * demo.price + demo.serviceFee - demo.discount;
  assert.equal(Number(invoice?.grand_total), expectedTotal, `${caseId}: invoice total mismatch`);
  const payment = first(await rpc(target, token('billing'), 'record_atomic_invoice_payment', {
    p_request_key: randomUUID(),
    p_invoice_id: invoice.invoice_id,
    p_amount: expectedTotal,
    p_channel: demo.channel,
    p_reference_note: `${caseId}-FULL-PAYMENT`
  }));
  assert.equal(payment?.invoice_status, 'paid', `${caseId}: invoice did not close as paid`);
  assert.equal(payment?.encounter_closed, true, `${caseId}: encounter did not close after full payment`);

  const allocations = await serviceRequest(`/rest/v1/dispensing_items?select=id,inventory_lot_id,quantity_dispensed,unit_price,status&dispensing_order_id=eq.${prescription.dispensing_order_id}`);
  const eventResource = `/rest/v1/dispensing_order_events?select=action,from_status,to_status,actor_id,actor_role,reason,request_key,created_at&dispensing_order_id=eq.${prescription.dispensing_order_id}&order=created_at.asc`;
  const reviewerEvents = await requestJson(supabaseUrl(target, eventResource), {
    key: target.config.database.publishableKey,
    bearer: token('pharmacy_reviewer')
  });
  const dispenserEvents = await requestJson(supabaseUrl(target, eventResource), {
    key: target.config.database.publishableKey,
    bearer: token('pharmacy_dispenser')
  });
  assert.deepEqual(dispenserEvents, reviewerEvents, `${caseId}: queue history changed across authenticated Pharmacy API account switch`);
  assert.deepEqual(
    reviewerEvents.map(event => `${event.from_status}->${event.to_status}`),
    ['waiting->reviewed', 'reviewed->dispensed', 'dispensed->submitted_to_billing'],
    `${caseId}: durable Pharmacy transition history mismatch`
  );
  assert.equal(reviewerEvents[0].actor_id, signedIn.pharmacy_reviewer.session.user.id, `${caseId}: reviewer actor evidence mismatch`);
  assert.equal(reviewerEvents[1].actor_id, signedIn.pharmacy_dispenser.session.user.id, `${caseId}: dispenser actor evidence mismatch`);
  assert.notEqual(reviewerEvents[0].actor_id, reviewerEvents[1].actor_id, `${caseId}: reviewer and dispenser must be different accounts`);
  const auditEntityIds = [prescription.prescription_id, prescription.dispensing_order_id, invoice.invoice_id, payment.payment_id];
  const auditFilter = encodeURIComponent(`(${auditEntityIds.join(',')})`);
  const audit = await serviceRequest(`/rest/v1/audit_logs?select=action,entity,entity_id&entity_id=in.${auditFilter}`);
  const actions = audit.map(entry => entry.action);
  for (const required of ['create_prescription_handoff', 'dispense_prescription_order', 'record_invoice_payment']) {
    assert.ok(actions.includes(required), `${caseId}: missing audit action ${required}`);
  }
  const checkInAudit = await serviceRequest(
    `/rest/v1/audit_logs?select=action,user_id,metadata&entity_id=eq.${encounter.encounter_id}&action=eq.check_in_appointment_encounter`
  );
  assert.equal(checkInAudit.length, 1, `${caseId}: reception check-in audit is missing or duplicated`);
  assert.equal(
    checkInAudit[0].user_id,
    signedIn.reception.session.user.id,
    `${caseId}: check-in audit actor is not the reception account`
  );
  assert.equal(
    checkInAudit[0].metadata?.appointment_id,
    appointment.id,
    `${caseId}: check-in audit does not identify the appointment`
  );
  assert.equal(
    checkInAudit[0].metadata?.practitioner_id,
    signedIn.practitioner.session.user.id,
    `${caseId}: check-in audit does not preserve practitioner assignment`
  );

  results.push({
    caseId,
    syntheticOnly: true,
    receptionActorId: signedIn.reception.session.user.id,
    practitionerActorId: signedIn.practitioner.session.user.id,
    appointmentNumber: appointment.appointment_no,
    appointmentId: appointment.id,
    appointmentHandoff: 'reception_checked_in_then_practitioner_in_service',
    appointmentEventActors: appointmentEvents.map(event => ({
      eventType: event.event_type,
      newStatus: event.new_status,
      actorId: event.actor_id
    })),
    hn: patient.hn,
    encounterNo: encounter.encounter_no,
    symptom: demo.symptom,
    thaiDiagnosis: demo.diagnosis,
    productSku: sku,
    productName: demo.product,
    quantity: demo.qty,
    unitPrice: demo.price,
    serviceFee: demo.serviceFee,
    discount: demo.discount,
    total: expectedTotal,
    paymentChannel: demo.channel,
    prescriptionNo: prescription.prescription_no,
    queueNumber: prescription.queue_number,
    invoiceNumber: invoice.invoice_number,
    paymentReference: payment.payment_reference,
    encounterClosed: payment.encounter_closed,
    fefoAllocationCount: allocations.length,
    pharmacyEventTransitions: reviewerEvents.map(event => ({
      action: event.action,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      actorId: event.actor_id,
      actorRole: event.actor_role,
      requestKey: event.request_key,
      createdAt: event.created_at
    })),
    requiredAuditActions: actions.filter(action => ['create_prescription_handoff', 'dispense_prescription_order', 'record_invoice_payment'].includes(action))
  });
}

const total = results.reduce((sum, result) => sum + result.total, 0);
const evidence = {
  schemaVersion: 1,
  evidenceType: 'authenticated_staging_synthetic_api_rpc_uat',
  evidenceScope: 'api_rpc_database_only',
  browserProof: {
    status: 'pending',
    reloadVerified: false,
    accountSwitchVerified: false,
    note: 'This runner does not open a hosted browser. Reload and browser account-switch evidence must be captured separately.'
  },
  syntheticOnly: true,
  clinicalAdvice: false,
  sourceCommit: sourceCommit(),
  generatedAt: new Date().toISOString(),
  deploymentId: target.config.deploymentId,
  databaseProjectRef: target.projectRef,
  clinicId: target.config.tenant.expectedClinicId,
  clinicCode: target.config.tenant.expectedClinicCode,
  runId,
  caseCount: results.length,
  totalAmountThb: total,
  segregationChecks: [
    'reception_registers_books_and_checks_in_before_practitioner',
    'appointment_assignment_is_preserved_in_encounter_and_audit',
    'practitioner_cannot_review_or_dispense',
    'pharmacy_reviewer_cannot_dispense_own_review',
    'distinct_pharmacy_dispenser_completes_fefo',
    'pharmacy_cannot_issue_invoice',
    'billing_closes_paid_encounter'
  ],
  cases: results
};

assert.equal(results.length, 10, 'Exactly ten synthetic staging flows must pass');
const evidencePath = writeEvidence('authenticated-staging-synthetic-uat.json', evidence);
process.stdout.write(`Authenticated API/RPC staging UAT passed ${results.length}/10 synthetic Reception → Practitioner → Pharmacy → Billing flows (THB ${total}). Hosted-browser reload/account-switch proof remains pending; API/RPC evidence: ${evidencePath}\n`);
