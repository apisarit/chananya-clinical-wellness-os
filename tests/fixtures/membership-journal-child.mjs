// IPC-only functional fixture. Never reads credentials or talks to a service.
import { withMembershipJournal, readMembershipJournal } from '../../ops/cnyos-staging-controller/scripts/membership-journal-store.mjs';
import { runStaffMembershipProof, recoverStaffMembershipProof } from '../../scripts/staging-membership-proof.mjs';

let sequence = 0;
const waiting = new Map();
const request = (kind, value) => new Promise((resolve, reject) => {
  const id = ++sequence;
  waiting.set(id, { resolve, reject });
  process.send({ kind, id, value });
});
process.on('message', message => {
  if (message.kind === 'response') {
    const item = waiting.get(message.id);
    if (!item) return;
    waiting.delete(message.id);
    if (message.error) item.reject(new Error(message.error));
    else item.resolve(message.value);
  }
});
process.once('message', async ({ directory, binding, mode }) => {
  try {
    if (mode === 'status') {
      process.send({ kind: 'result', value: readMembershipJournal({ directory, binding }) });
    } else {
      const value = await withMembershipJournal({ directory, binding, mode }, async ({ snapshot, checkpoint }) => {
        const args = {
          rpc: (name, body) => request('rpc', { name, body }),
          readAccessContext: () => request('context'),
          readClinicalCapability: () => request('capability'),
          target: binding.target, actorId: binding.actorId, requestIds: binding.requestIds,
          checkpoint: async value => {
            await checkpoint(value);
            // Acknowledged barrier: parent may kill us before the next effect.
            await request('checkpoint', value);
          }
        };
        return mode === 'start' ? runStaffMembershipProof(args)
          : recoverStaffMembershipProof({ ...args, snapshot });
      });
      process.send({ kind: 'result', value });
    }
    process.disconnect();
  } catch (error) {
    process.send({ kind: 'failure', code: error.message });
    process.exitCode = 1;
    process.disconnect();
  }
});
