import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const runbook = read('docs/PRODUCTION_OPERATIONS_RUNBOOK.md');
const milestone = read('docs/PRODUCTION_MILESTONE_STACK.md');
const readiness = JSON.parse(read('release-readiness.json'));

const operationsGate = readiness.requiredGates.find(gate => gate.id === 'operational_monitoring_incident_response');
assert.ok(operationsGate, 'production operations must remain an explicit pre-deployment release gate');
assert.equal(operationsGate.status, 'pending', 'operations gate must fail closed before retained live evidence exists');
assert.equal(operationsGate.evidence, null, 'operations evidence must not be invented');

for (const required of [
  'Incident Commander',
  'Platform/Infrastructure Owner',
  'Clinical Safety Owner',
  'Privacy/Data Owner',
  'Clinic/Business Owner',
  'SEV-0',
  'SEV-1',
  'Minimum production monitoring',
  'Alert routing and evidence',
  'Containment order',
  'Rollback rule',
  'Backup and recovery during an incident',
  'Security and privacy incident handling',
  'Clinical-safety reopening criteria',
  'Required operations-gate artifact',
  'Post-deploy observation before real-data admission'
]) {
  assert.match(runbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `operations runbook missing ${required}`);
}

assert.match(runbook, /target human acknowledgement is 15 minutes or less/i, 'SEV-0 acknowledgement target must be explicit');
assert.match(runbook, /target acknowledgement is 30 minutes or less/i, 'SEV-1 acknowledgement target must be explicit');
assert.match(runbook, /dashboard without tested alert delivery is not sufficient/i, 'dashboard-only monitoring must not satisfy the gate');
assert.match(runbook, /do not use a client-side UI toggle as the only containment control/i, 'authorization incidents require server-side containment');
assert.match(runbook, /Never assume application rollback automatically reverses database migrations/i, 'application and database rollback must remain separate decisions');
assert.match(runbook, /runbook alone is not evidence that operations are active/i, 'documentation alone must never satisfy production operations');
assert.match(runbook, /same exact release commit required by `release-readiness\.json`/i, 'operations evidence must bind to the exact release commit');
assert.match(milestone, /M7 — Production operations/, 'milestone stack must include production operations before release controls');
assert.match(milestone, /M10 — Production deploy \+ admission/, 'deployment/admission must remain after operations and promotion');

console.log('Production operations contract passed: monitoring, ownership, incident, rollback and recovery remain fail-closed release requirements');
