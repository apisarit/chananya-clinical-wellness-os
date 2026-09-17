import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Single-host controller storage only. No credentials, RPC, network, timers,
// deployment authority or candidate imports. A protected runner owns callbacks.
const files = ['membership-lock.sqlite', 'membership-journal.sqlite'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const phases = ['off-intent', 'off-confirmed', 'on-intent', 'on-confirmed', 'completed'];
const keys = (value, expected) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'JOURNAL_OBJECT_REQUIRED');
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'JOURNAL_KEYS_INVALID');
};
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const result = JSON.stringify(value);
  assert.notEqual(result, undefined, 'JOURNAL_NON_JSON_VALUE');
  return result;
};
function checkTarget(value) {
  keys(value, ['clinicId', 'userId', 'clinicRole', 'systemRole', 'effectiveRole']);
  for (const key of ['clinicId', 'userId']) assert.match(value[key], uuid);
  for (const key of ['clinicRole', 'systemRole', 'effectiveRole']) assert.match(value[key], /^[a-z_]{1,64}$/);
}
function checkIds(value) {
  keys(value, ['off', 'on']);
  assert.match(value.off, uuid); assert.match(value.on, uuid);
  assert.notEqual(value.off, value.on, 'JOURNAL_REQUEST_IDS_MUST_DIFFER');
}
function checkBinding(value) {
  keys(value, ['schemaVersion', 'environment', 'runId', 'controllerCommit', 'candidateCommit', 'artifactSha256', 'actorId', 'target', 'requestIds']);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.environment, 'cnyos-staging');
  for (const key of ['runId', 'actorId']) assert.match(value[key], uuid);
  for (const key of ['controllerCommit', 'candidateCommit']) assert.match(value[key], /^[0-9a-f]{40}$/);
  assert.match(value.artifactSha256, /^[0-9a-f]{64}$/);
  checkTarget(value.target); checkIds(value.requestIds);
  assert.notEqual(value.actorId, value.target.userId);
}
function checkState(value, binding) {
  keys(value, ['active', 'clinic_id', 'clinic_role', 'is_primary', 'profile_id', 'profile_role', 'state_version', 'system_role']);
  assert.equal(value.clinic_id, binding.target.clinicId);
  assert.equal(value.profile_id, binding.target.userId);
  assert.equal(value.clinic_role, binding.target.clinicRole);
  assert.equal(value.system_role, binding.target.systemRole);
  assert.match(value.profile_role, /^[a-z_]{1,64}$/);
  assert.match(value.state_version, uuid);
  assert.equal(typeof value.active, 'boolean'); assert.equal(typeof value.is_primary, 'boolean');
}
function checkReceipt(value, binding, operation) {
  keys(value, ['actor_id', 'after', 'before', 'clinic_id', 'completed_at', 'operation', 'profile_id', 'request_id', 'restore_request_id', 'schema_version']);
  assert.equal(value.schema_version, 1); assert.equal(value.actor_id, binding.actorId);
  assert.equal(value.clinic_id, binding.target.clinicId); assert.equal(value.profile_id, binding.target.userId);
  assert.equal(value.operation, operation);
  assert.equal(value.request_id, binding.requestIds[operation === 'suspend' ? 'off' : 'on']);
  assert.equal(value.restore_request_id, operation === 'suspend' ? null : binding.requestIds.off);
  assert.match(value.completed_at, /^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?$/);
  assert.ok(Number.isFinite(Date.parse(value.completed_at)));
  checkState(value.before, binding); checkState(value.after, binding);
  assert.notEqual(value.before.state_version, value.after.state_version);
}
function checkSnapshot(value, binding) {
  keys(value, ['schemaVersion', 'componentVersion', 'executionKind', 'phase', 'target', 'actorId', 'requestIds', 'initial', 'off', 'on', 'denialPassed']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.componentVersion, '1.0.0-candidate.2');
  assert.ok(['uat', 'recovery'].includes(value.executionKind));
  const phase = phases.indexOf(value.phase);
  assert.ok(phase >= 0, 'JOURNAL_PHASE_INVALID');
  assert.deepEqual(value.target, binding.target); assert.equal(value.actorId, binding.actorId);
  assert.deepEqual(value.requestIds, binding.requestIds);
  checkState(value.initial, binding); assert.equal(value.initial.active, true);
  assert.ok([null, false, true].includes(value.denialPassed));
  if (phase === 0) assert.equal(value.off, null);
  else {
    checkReceipt(value.off, binding, 'suspend');
    assert.deepEqual(value.off.before, value.initial);
    assert.deepEqual({ ...value.off.after, state_version: value.initial.state_version },
      { ...value.initial, active: false, is_primary: false });
  }
  if (phase < 3) assert.equal(value.on, null);
  else {
    checkReceipt(value.on, binding, 'restore');
    assert.deepEqual(value.on.before, value.off.after);
    assert.deepEqual({ ...value.on.after, state_version: value.initial.state_version }, value.initial);
  }
  if (phase < 2) assert.equal(value.denialPassed, null);
  if (phase >= 2 && value.executionKind === 'uat') assert.equal(typeof value.denialPassed, 'boolean');
  assert.ok(Buffer.byteLength(canonical(value)) < 16384, 'JOURNAL_RECORD_TOO_LARGE');
}
function checkAdvance(previous, next) {
  if (!previous) {
    assert.equal(next.phase, 'off-intent'); assert.equal(next.executionKind, 'uat'); return;
  }
  const before = phases.indexOf(previous.phase), after = phases.indexOf(next.phase);
  assert.ok(before < 4 && after >= before && after <= before + 1, 'JOURNAL_PHASE_REGRESSION');
  if (previous.executionKind === 'recovery') assert.equal(next.executionKind, 'recovery');
  for (const key of ['initial', 'target', 'actorId', 'requestIds', 'componentVersion']) assert.deepEqual(next[key], previous[key]);
  for (const key of ['off', 'on', 'denialPassed']) if (previous[key] !== null) assert.deepEqual(next[key], previous[key]);
}
function privateDirectory(directory) {
  assert.ok(typeof directory === 'string' && path.isAbsolute(directory), 'JOURNAL_ABSOLUTE_DIRECTORY_REQUIRED');
  assert.equal(fs.realpathSync(directory), directory, 'JOURNAL_CANONICAL_DIRECTORY_REQUIRED');
  const stat = fs.lstatSync(directory);
  assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700, 'JOURNAL_PRIVATE_DIRECTORY_REQUIRED');
}
function privateFile(file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600, 'JOURNAL_PRIVATE_REGULAR_FILE_REQUIRED');
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function open(file, readOnly = false) {
  privateFile(file);
  const db = new DatabaseSync(file, { readOnly, timeout: 0, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF;');
    if (!readOnly) {
      assert.equal(db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode, 'delete');
      db.exec('PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON;');
      assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 3);
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Explicit first-time setup in an existing controller-owned 0700 directory.
 * Refuses partial/existing stores; never reinitializes a lost recovery journal.
 */
export function initializeMembershipJournal(directory) {
  privateDirectory(directory);
  for (const name of files) assert.equal(fs.existsSync(path.join(directory, name)), false, 'JOURNAL_ALREADY_INITIALIZED');
  for (const name of files) {
    const fd = fs.openSync(path.join(directory, name), 'wx', 0o600);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  syncDirectory(directory);
  for (const name of files) {
    const db = open(path.join(directory, name));
    try {
      db.exec(name === files[0]
        ? 'CREATE TABLE lease (id INTEGER PRIMARY KEY) STRICT; PRAGMA user_version=1;'
        : `CREATE TABLE runs (run_id TEXT PRIMARY KEY, binding TEXT NOT NULL, snapshot TEXT, terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0,1))) STRICT;
           CREATE TABLE requests (request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL) STRICT;
           PRAGMA user_version=1;`);
    } finally { db.close(); }
  }
  syncDirectory(directory);
}

/** Holds an OS-released SQLite write lock in a SEPARATE database while each
 * write-ahead snapshot commits durably in the data database. No PID/age-based
 * lock stealing, no background agent, and no cross-host/network-filesystem use.
 */
export async function withMembershipJournal({ directory, binding, mode }, action) {
  checkBinding(binding); binding = structuredClone(binding);
  assert.ok(['start', 'recover', 'abandon-unstarted'].includes(mode), 'JOURNAL_MODE_INVALID');
  if (mode !== 'abandon-unstarted') assert.equal(typeof action, 'function');
  privateDirectory(directory);
  const lock = open(path.join(directory, files[0]));
  let db, held = false, live = true;
  try {
    assert.equal(lock.prepare('PRAGMA user_version').get().user_version, 1);
    try { lock.exec('BEGIN IMMEDIATE'); held = true; }
    catch { throw new Error('MEMBERSHIP_JOURNAL_BUSY'); }
    db = open(path.join(directory, files[1]));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    let stored = db.prepare('SELECT * FROM runs WHERE run_id=?').get(binding.runId);
    const unfinished = db.prepare('SELECT run_id FROM runs WHERE terminal=0 AND run_id<>?').get(binding.runId);
    assert.equal(unfinished, undefined, 'MEMBERSHIP_PRIOR_RUN_UNRECONCILED');
    if (mode === 'start') {
      assert.equal(stored, undefined, 'MEMBERSHIP_JOURNAL_RUN_EXISTS');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO runs(run_id,binding) VALUES (?,?)').run(binding.runId, canonical(binding));
        for (const id of Object.values(binding.requestIds)) db.prepare('INSERT INTO requests VALUES (?,?)').run(id, binding.runId);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      stored = { binding: canonical(binding), snapshot: null, terminal: 0 };
    } else {
      assert.ok(stored, 'MEMBERSHIP_JOURNAL_RUN_NOT_FOUND');
      assert.equal(stored.binding, canonical(binding), 'MEMBERSHIP_JOURNAL_BINDING_CHANGED');
      assert.equal(stored.terminal, 0, 'MEMBERSHIP_COMPLETED_RUN_NOT_FRESH_EVIDENCE');
      if (mode === 'abandon-unstarted') {
        // No OFF intent was ever committed, so a conforming runner could not
        // have sent either mutation. Preserve the run and reserved IDs forever.
        assert.equal(stored.snapshot, null, 'MEMBERSHIP_INTENT_EXISTS_RECOVERY_REQUIRED');
        db.prepare('UPDATE runs SET terminal=1 WHERE run_id=?').run(binding.runId);
        return { disposition: 'abandoned-before-effects', freshUatEvidence: false, runId: binding.runId };
      }
      assert.notEqual(stored.snapshot, null, 'MEMBERSHIP_NO_INTENT_TO_RECOVER');
    }
    let previous = stored.snapshot === null ? null : JSON.parse(stored.snapshot);
    if (previous) checkSnapshot(previous, binding);
    const checkpoint = async value => {
      assert.ok(live, 'MEMBERSHIP_JOURNAL_CLOSED');
      const next = structuredClone(value);
      checkSnapshot(next, binding); checkAdvance(previous, next);
      if (mode === 'recover') assert.equal(next.executionKind, 'recovery');
      db.prepare('UPDATE runs SET snapshot=?,terminal=? WHERE run_id=?').run(canonical(next), next.phase === 'completed' ? 1 : 0, binding.runId);
      previous = next;
    };
    const result = await action({ snapshot: structuredClone(previous), checkpoint });
    assert.equal(previous?.phase, 'completed', 'MEMBERSHIP_JOURNAL_INCOMPLETE');
    return result;
  } finally {
    live = false;
    try { if (db) db.close(); }
    finally { try { if (held) lock.exec('ROLLBACK'); } finally { lock.close(); } }
  }
}

export function abandonUnstartedMembershipRun(options) {
  return withMembershipJournal({ ...options, mode: 'abandon-unstarted' });
}

/** Historical inspection only: never sends RPCs or issues fresh UAT evidence. */
export function readMembershipJournal({ directory, binding }) {
  checkBinding(binding); privateDirectory(directory);
  const db = open(path.join(directory, files[1]), true);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    const row = db.prepare('SELECT * FROM runs WHERE run_id=?').get(binding.runId);
    assert.ok(row, 'MEMBERSHIP_JOURNAL_RUN_NOT_FOUND');
    assert.equal(row.binding, canonical(binding), 'MEMBERSHIP_JOURNAL_BINDING_CHANGED');
    const snapshot = row.snapshot === null ? null : JSON.parse(row.snapshot);
    if (snapshot) checkSnapshot(snapshot, binding);
    if (snapshot) assert.equal(row.terminal, snapshot.phase === 'completed' ? 1 : 0, 'JOURNAL_TERMINAL_STATE_MISMATCH');
    return { historical: true, freshUatEvidence: false,
      disposition: row.terminal === 1 && snapshot === null ? 'abandoned-before-effects'
        : row.terminal === 1 ? 'completed' : 'incomplete',
      binding: structuredClone(binding), snapshot };
  } finally { db.close(); }
}
