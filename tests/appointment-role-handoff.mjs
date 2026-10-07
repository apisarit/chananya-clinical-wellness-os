// Isolated UI policy regression. Server ACL/RLS remain the authority.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../appointments.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function loadAppointments()');
const end = source.indexOf('  async function setStatus(', start);
assert.ok(start > 0 && end > start);
assert.match(source, /canOpenClinicalRecord = runtime\.can\(profile, 'clinical_write'\)/);

for (const role of ['reception', 'practitioner', 'super_admin', 'viewer']) {
  for (const assigned of [true, false]) {
    for (const status of ['booked', 'checked_in', 'completed']) {
      const list = { innerHTML: '' };
      const canOperate = ['reception', 'super_admin'].includes(role);
      const canClinicalStatus = ['practitioner', 'super_admin'].includes(role);
      const canOpenClinicalRecord = canClinicalStatus;
      const encounterId = '00000000-0000-4000-8000-000000000003';
      const context = vm.createContext({
        $: selector => selector === '#appointment-list' ? list : { value: '' },
        appointmentRequestVersion: 0,
        canOperate, canClinicalStatus, canOpenClinicalRecord,
        session: { user: { id: 'synthetic-actor' } },
        esc: value => String(value ?? ''),
        patientLabel: () => 'SYNTHETIC ONLY', dateTime: () => 'synthetic date',
        appointmentStatusLabel: value => value,
        document: { querySelectorAll: () => [] },
        db: { from() {
          const query = {
            select() { return query; }, order() { return query; },
            then(resolve, reject) { return Promise.resolve({ data: [{
              id: '00000000-0000-4000-8000-000000000001',
              appointment_no: 'SYNTHETIC-ONLY', queue_number: 1,
              patient: {}, status,
              practitioner_id: assigned ? 'synthetic-actor' : 'synthetic-other',
              encounter_id: status === 'booked' ? null : encounterId
            }] }).then(resolve, reject); }
          };
          return query;
        } }
      });
      vm.runInContext(source.slice(start, end) + '\nglobalThis.load = loadAppointments;', context);
      await context.load();
      const ownsAction = canOperate || (canClinicalStatus && assigned);
      const clinicalLink = `/clinical-v3.html?encounter=${encounterId}&step=history`;
      assert.equal(list.innerHTML.includes(clinicalLink),
        Boolean(status !== 'booked' && canOpenClinicalRecord && ownsAction),
        `${role}/${status}/${assigned}: destination follows clinical capability`);
      assert.equal(list.innerHTML.includes('/check-in.html?appointment='),
        Boolean(status === 'booked' && ownsAction),
        `${role}/${status}/${assigned}: existing verified check-in path preserved`);
    }
  }
}
console.log('PASS 24 appointment role/status/assignment cases: reception keeps check-in, no inaccessible clinical link; practitioner assignment preserved. UI simulation only.');
