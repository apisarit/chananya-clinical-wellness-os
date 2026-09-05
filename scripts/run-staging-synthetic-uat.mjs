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
for (const role of ['practitioner', 'pharmacy', 'billing']) {
  signedIn[role] = await signInStagingRole(target, role);
}
const token = role => signedIn[role].session.access_token;
const first = value => Array.isArray(value) ? value[0] : value;

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

const results = [];
for (const [index, demo] of SYNTHETIC_UAT_CASES.entries()) {
  const caseId = `STG-${runId}-${demo.id}`;
  const sku = `E2E-${runId}-${demo.id}`;
  const product = first(await rpc(target, token('pharmacy'), 'upsert_product_master', {
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

  const patient = first(await rpc(target, token('practitioner'), 'upsert_patient_registration', {
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

  const encounter = first(await rpc(target, token('practitioner'), 'start_manual_patient_encounter', {
    p_patient_id: patient.id,
    p_verification_method: 'manual_hn',
    p_patient_present_confirmed: true,
    p_verification_note: `Synthetic UAT ${caseId}`,
    p_chief_complaint: demo.symptom,
    p_intake: { pulse: 72, pain_before: 3, synthetic_only: true, staging_run_id: runId }
  }));
  assert.ok(encounter?.encounter_id, `${caseId}: encounter creation failed`);

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

  await rpc(target, token('pharmacy'), 'transition_atomic_prescription_dispensing', {
    p_dispensing_order_id: prescription.dispensing_order_id,
    p_action: 'review',
    p_item_prices: [],
    p_reason: 'Synthetic UAT pharmacist review'
  });
  const items = await requestJson(supabaseUrl(target, `/rest/v1/prescription_items?select=id,product_id,quantity_prescribed,unit&prescription_id=eq.${prescription.prescription_id}`), {
    key: target.config.database.publishableKey,
    bearer: token('pharmacy')
  });
  assert.equal(items.length, 1, `${caseId}: Pharmacy cannot read its prescription item`);
  const prices = [{ prescription_item_id: items[0].id, unit_price: demo.price }];
  const dispensed = await rpc(target, token('pharmacy'), 'transition_atomic_prescription_dispensing', {
    p_dispensing_order_id: prescription.dispensing_order_id,
    p_action: 'dispense',
    p_item_prices: prices,
    p_reason: 'Synthetic UAT FEFO dispense'
  });
  assert.equal(dispensed.status, 'dispensed', `${caseId}: dispense did not complete`);
  assert.equal(dispensed.allocation_count, demo.qty > 1 ? 2 : 1, `${caseId}: FEFO allocation count mismatch`);
  const retry = await rpc(target, token('pharmacy'), 'transition_atomic_prescription_dispensing', {
    p_dispensing_order_id: prescription.dispensing_order_id,
    p_action: 'dispense',
    p_item_prices: prices,
    p_reason: 'Synthetic UAT idempotency retry'
  });
  assert.equal(retry.idempotent, true, `${caseId}: dispensing retry was not idempotent`);
  await rpc(target, token('pharmacy'), 'transition_atomic_prescription_dispensing', {
    p_dispensing_order_id: prescription.dispensing_order_id,
    p_action: 'submit_billing',
    p_item_prices: [],
    p_reason: 'Synthetic UAT checkout handoff'
  });

  if (index === 0) {
    await expectDenied(
      () => rpc(target, token('pharmacy'), 'issue_atomic_dispensing_invoice', {
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
  const auditEntityIds = [prescription.prescription_id, prescription.dispensing_order_id, invoice.invoice_id, payment.payment_id];
  const auditFilter = encodeURIComponent(`(${auditEntityIds.join(',')})`);
  const audit = await serviceRequest(`/rest/v1/audit_logs?select=action,entity,entity_id&entity_id=in.${auditFilter}`);
  const actions = audit.map(entry => entry.action);
  for (const required of ['create_prescription_handoff', 'dispense_prescription_order', 'record_invoice_payment']) {
    assert.ok(actions.includes(required), `${caseId}: missing audit action ${required}`);
  }

  results.push({
    caseId,
    syntheticOnly: true,
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
    requiredAuditActions: actions.filter(action => ['create_prescription_handoff', 'dispense_prescription_order', 'record_invoice_payment'].includes(action))
  });
}

const total = results.reduce((sum, result) => sum + result.total, 0);
const evidence = {
  schemaVersion: 1,
  evidenceType: 'authenticated_staging_synthetic_end_to_end_uat',
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
    'practitioner_cannot_review_or_dispense',
    'pharmacy_cannot_issue_invoice',
    'billing_closes_paid_encounter'
  ],
  cases: results
};

assert.equal(results.length, 10, 'Exactly ten synthetic staging flows must pass');
const evidencePath = writeEvidence('authenticated-staging-synthetic-uat.json', evidence);
process.stdout.write(`Authenticated staging UAT passed ${results.length}/10 synthetic Practitioner → Pharmacy → Billing flows (THB ${total}); evidence: ${evidencePath}\n`);
