// Native, synthetic business-state verification only. Never connects to a supplied
// database URL or existing cluster. No hosted SQL, migrations, or deployment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const actor = '11111111-1111-4111-8111-111111111111';
const staff = '22222222-2222-4222-8222-222222222222';
const clinic = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourcePaths = [
  'tests/staff-membership-native-recovery.mjs',
  'tests/fixtures/staff-membership-native-fixture.sql',
  'supabase/manual/staff_membership_recovery_candidate.sql'
];

async function main() {
  assert.equal(process.argv.length, 4, 'Usage: node tests/staff-membership-native-recovery.mjs --pg-bin /absolute/PostgreSQL17/bin');
  assert.equal(process.argv[2], '--pg-bin');
  assert.ok(path.isAbsolute(process.argv[3]), 'PostgreSQL binary directory must be absolute');
  const bin = fs.realpathSync(process.argv[3]);
  const executables = Object.fromEntries(['initdb','pg_ctl','psql','postgres'].map(name => [name, path.join(bin, name)]));
  for (const executable of Object.values(executables)) fs.accessSync(executable, fs.constants.X_OK);
  const ownedRoot = fs.mkdtempSync('/tmp/cnyos-native-');
  fs.chmodSync(ownedRoot, 0o700);
  const data = path.join(ownedRoot, 'data');
  const socket = path.join(ownedRoot, 'socket');
  const log = path.join(ownedRoot, 'postgres.log');
  fs.mkdirSync(socket, { mode: 0o700 });
  // Do not inherit database/service/password/proxy configuration. The named
  // absent credential files are inside our new private directory, not $HOME.
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C',
    PGPASSFILE: path.join(ownedRoot, 'unused-passfile'),
    PGSERVICEFILE: path.join(ownedRoot, 'unused-service'),
    PGSYSCONFDIR: ownedRoot
  };
  const command = (file, args, { input, timeout = 20_000 } = {}) => new Promise(resolve => {
    const child = execFile(file, args, { env, cwd: ownedRoot, timeout, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
    child.stdin.end(input);
  });
  const must = result => {
    assert.equal(result.code, 0, `Native fixture command failed: ${result.stderr.slice(0, 1600)}`);
    return result.stdout.trim();
  };
  const port = '55437'; // No TCP listener; the new socket directory isolates runs.
  const psqlArgs = ['-X','-w','-q','-A','-t','-P','pager=off','-v','ON_ERROR_STOP=1',
    '-h',socket,'-p',port,'-U','cnyos_fixture_admin','-d','postgres'];
  const query = async sql => must(await command(executables.psql, psqlArgs, { input: sql }));
  const json = async sql => JSON.parse(await query(sql));
  const clients = new Set();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    for (const client of clients) client.child.kill('SIGTERM');
  };

  class Session {
    constructor() {
      this.child = spawn(executables.psql, psqlArgs, { env, cwd: ownedRoot, stdio: ['pipe','pipe','pipe'] });
      this.output = ''; this.stderr = ''; this.pending = null; this.closed = false;
      clients.add(this);
      this.done = new Promise(resolve => { this.resolveDone = resolve; });
      this.child.stdout.on('data', bytes => {
        this.output += bytes;
        if (this.output.length > 1024 * 1024) { this.child.kill('SIGTERM'); return; }
        const pending = this.pending;
        if (pending && this.output.includes(`${pending.marker}\n`)) {
          const [result, rest] = this.output.split(`${pending.marker}\n`);
          this.output = rest;
          this.pending = null;
          clearTimeout(pending.timer);
          pending.resolve(result.trim());
        }
      });
      this.child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes).slice(-16_384); });
      this.child.stdin.on('error', () => {});
      this.child.on('error', error => this.finish(1, error.message));
      this.child.on('close', code => this.finish(code, this.stderr));
    }
    finish(code, message) {
      if (this.closed) return;
      this.closed = true;
      clients.delete(this);
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error(message || `Native client exited: ${code}`));
        this.pending = null;
      }
      this.resolveDone(code);
    }
    send(sql) {
      assert.equal(this.closed, false, 'Native client is closed');
      assert.equal(this.pending, null, 'Only one pending command per native client');
      assert.equal(interrupted, false, 'Native fixture interrupted');
      return new Promise((resolve, reject) => {
        const marker = `NATIVE_DONE_${randomUUID().replaceAll('-', '')}`;
        const timer = setTimeout(() => {
          this.child.kill('SIGTERM');
          reject(new Error('Native client command timed out'));
        }, 10_000);
        this.pending = { marker, timer, resolve, reject };
        this.child.stdin.write(`${sql}\n\\echo ${marker}\n`);
      });
    }
    async close() {
      if (this.closed) return this.done;
      this.child.stdin.end('\\q\n');
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
      try { return await this.done; } finally { clearTimeout(timer); }
    }
  }
  const session = async (role = 'authenticated') => {
    const client = new Session();
    await client.send(`SET application_name=${sqlLiteral(`cnyos-native-${randomUUID()}`)};
      SET statement_timeout='8s'; SET idle_in_transaction_session_timeout='10s';
      SET ROLE ${role}; SET test.actor_id=${sqlLiteral(actor)};`);
    const identity = JSON.parse(await client.send('SELECT json_build_object(\'pid\',pg_backend_pid(),\'role\',current_user);'));
    assert.equal(identity.role, role);
    client.pid = identity.pid;
    return client;
  };
  const waitFor = async (sql, message) => {
    const deadline = Date.now() + 1600;
    while (Date.now() < deadline) {
      if ((await query(sql)) === 't') return;
      if (interrupted) throw new Error('Native fixture interrupted');
      await delay(20); // Poll an observed condition; elapsed time is not proof.
    }
    throw new Error(`Native barrier not observed: ${message}`);
  };
  const blockedBy = (waiting, blocker) => waitFor(
    `SELECT ${blocker.pid}=ANY(pg_blocking_pids(${waiting.pid}));`, 'session must actually wait on the expected holder');
  const gone = pid => waitFor(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${pid});`, 'backend exit');
  const snapshot = () => json(`SELECT json_build_object(
    'state',(SELECT to_jsonb(m)-'joined_at'-'updated_at' FROM public.clinic_memberships m
      WHERE clinic_id=${sqlLiteral(clinic)} AND profile_id=${sqlLiteral(staff)}),
    'receipts',(SELECT count(*)::int FROM public.staff_membership_transition_requests),
    'audits',(SELECT count(*)::int FROM public.audit_logs));`);
  const state = async () => JSON.parse(await query(`SET ROLE authenticated; SET test.actor_id=${sqlLiteral(actor)};
    SELECT public.admin_read_staff_membership_state(${sqlLiteral(clinic)},${sqlLiteral(staff)});`));
  const transitionSql = (expected, id, restore = null) => `SELECT public.admin_transition_staff_membership(
    ${sqlLiteral(clinic)}::uuid,${sqlLiteral(staff)}::uuid,${sqlLiteral(JSON.stringify(expected))}::jsonb,
    ${sqlLiteral(id)}::uuid,'Native synthetic recovery verification',${restore ? sqlLiteral(restore) : 'NULL'}::uuid);`;
  const transition = async (expected, id, restore = null) => {
    const client = await session();
    try { return JSON.parse(await client.send(transitionSql(expected, id, restore))); }
    finally { await client.close(); }
  };
  const reset = async () => {
    assert.equal(clients.size, 0, 'No sessions may remain before fixture reset');
    await query(`SET ROLE cnyos_fixture_owner;
      TRUNCATE public.staff_membership_transition_requests,public.audit_logs;
      UPDATE public.clinic_memberships SET active=true,is_primary=true,clinic_role='practitioner'
      WHERE clinic_id=${sqlLiteral(clinic)} AND profile_id=${sqlLiteral(staff)};`);
  };
  const cases = [];
  const runCase = async (name, fn) => {
    await reset();
    await fn();
    for (const client of [...clients]) await client.close();
    cases.push({ name, result: 'passed' });
    process.stderr.write(`Native fixture passed: ${name}\n`);
  };
  const sources = Object.fromEntries(sourcePaths.map(relative => [relative, hash(fs.readFileSync(path.join(root, relative)))]));
  const binaryHashes = Object.fromEntries(Object.entries(executables).map(([name, file]) => [name, hash(fs.readFileSync(file))]));
  const sourceBaseCommit = must(await command('/usr/bin/git', ['-C',root,'rev-parse','HEAD']));
  assert.match(sourceBaseCommit, /^[0-9a-f]{40}$/);
  const sourceCheckoutDirty = must(await command('/usr/bin/git', ['-C',root,'status','--porcelain=v1'])).length > 0;
  let startAttempted = false, stopped = false, failure, serverVersion;
  // Keep handlers installed through shutdown. Repeated cancellation may stop
  // test clients, but must not interrupt the separately bounded pg_ctl cleanup.
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const runDeadline = setTimeout(interrupt, 120_000);
  try {
    for (const file of Object.values(executables)) assert.match(must(await command(file, ['--version'])), /17\./);
    must(await command(executables.initdb, ['-D',data,'-U','cnyos_fixture_admin',
      '--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'], { timeout: 30_000 }));
    assert.equal(fs.statSync(data).mode & 0o777, 0o700);
    startAttempted = true;
    must(await command(executables.pg_ctl, ['start','-D',data,'-l',log,'-w','-t','15','-o',
      `-k ${socket} -p ${port} -c listen_addresses='' -c unix_socket_permissions=0700 -c max_connections=12 -c shared_buffers=32MB` ]));
    fs.chmodSync(log, 0o600);
    const identity = await json(`SELECT json_build_object('data',current_setting('data_directory'),
      'listen',current_setting('listen_addresses'),'socket',current_setting('unix_socket_directories'),
      'version',current_setting('server_version_num'),'address',inet_server_addr());`);
    assert.equal(identity.data, data);
    assert.equal(identity.listen, '');
    assert.equal(identity.socket, socket);
    assert.equal(identity.address, null);
    assert.ok(Number(identity.version) >= 170000 && Number(identity.version) < 180000);
    serverVersion = identity.version;
    const candidate = fs.readFileSync(path.join(root, sourcePaths[2]), 'utf8');
    const refused = await command(executables.psql, psqlArgs, { input: candidate });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /STAFF_MEMBERSHIP_RECOVERY_REVIEW_REQUIRED/);
    assert.equal(await query("SELECT to_regclass('public.staff_membership_transition_requests') IS NULL;"), 't');
    cases.push({ name: 'direct candidate remains refused before installation', result: 'passed' });
    const marker = '-- BEGIN LOCAL FIXTURE DEFINITIONS', endMarker = '-- END LOCAL FIXTURE DEFINITIONS';
    assert.equal(candidate.split(marker).length, 2);
    assert.equal(candidate.split(endMarker).length, 2);
    await query(fs.readFileSync(path.join(root, sourcePaths[1]), 'utf8'));
    await query(`BEGIN; SET LOCAL ROLE cnyos_fixture_owner; ${candidate.split(marker)[1].split(endMarker)[0]} COMMIT;`);
    const ownership = await json(`SELECT json_build_object(
      'ownerSuper',(SELECT rolsuper FROM pg_roles WHERE rolname='cnyos_fixture_owner'),
      'ownerBypass',(SELECT rolbypassrls FROM pg_roles WHERE rolname='cnyos_fixture_owner'),
      'functions',(SELECT count(*)::int FROM pg_proc WHERE proname IN
        ('admin_read_staff_membership_state','admin_transition_staff_membership','refresh_staff_membership_state_version')
        AND proowner='cnyos_fixture_owner'::regrole),
      'tables',(SELECT count(*)::int FROM pg_class WHERE relname IN
        ('clinic_memberships','staff_membership_transition_requests','audit_logs')
        AND relowner='cnyos_fixture_owner'::regrole));`);
    assert.deepEqual(ownership, { ownerSuper: false, ownerBypass: false, functions: 3, tables: 3 });

    await runCase('confirmed OFF/ON and historical replay', async () => {
      const before = await state(), offId = randomUUID(), onId = randomUUID();
      const off = await transition(before, offId);
      const on = await transition(off.after, onId, offId);
      assert.deepEqual(await transition(before, offId), off);
      assert.deepEqual(await transition(off.after, onId, offId), on);
      assert.deepEqual(await state(), on.after);
      assert.deepEqual({ ...on.after, state_version: before.state_version }, before);
      assert.notEqual(on.after.state_version, before.state_version);
      const after = await snapshot();
      assert.equal(after.state.active, true);
      assert.equal(after.receipts, 2); assert.equal(after.audits, 2);
    });
    await runCase('concurrent identical request produces one receipt and audit', async () => {
      const before = await state(), id = randomUUID();
      const a = await session(), b = await session();
      await a.send('BEGIN;');
      const first = JSON.parse(await a.send(transitionSql(before, id)));
      const second = b.send(transitionSql(before, id)); second.catch(() => {});
      await blockedBy(b, a);
      await a.send('COMMIT;');
      assert.deepEqual(JSON.parse(await second), first);
      assert.deepEqual(await state(), first.after);
      const after = await snapshot();
      assert.equal(after.receipts, 1); assert.equal(after.audits, 1);
    });
    await runCase('competing request IDs cannot reuse the prior state', async () => {
      const before = await state(), a = await session(), b = await session();
      await a.send('BEGIN;');
      const first = JSON.parse(await a.send(transitionSql(before, randomUUID())));
      const second = b.send(transitionSql(before, randomUUID())); second.catch(() => {});
      await blockedBy(b, a);
      await a.send('COMMIT;');
      await assert.rejects(second, /MEMBERSHIP_STATE_CONFLICT/);
      await gone(b.pid);
      assert.deepEqual(await state(), first.after);
      const after = await snapshot();
      assert.equal(after.receipts, 1); assert.equal(after.audits, 1);
    });
    await runCase('ordinary legacy membership update is preserved', async () => {
      const offId = randomUUID(), off = await transition(await state(), offId);
      const writer = await session('cnyos_fixture_owner'), restore = await session();
      await writer.send(`BEGIN; UPDATE public.clinic_memberships SET clinic_role='viewer'
        WHERE clinic_id=${sqlLiteral(clinic)} AND profile_id=${sqlLiteral(staff)};`);
      const pending = restore.send(transitionSql(off.after, randomUUID(), offId)); pending.catch(() => {});
      await blockedBy(restore, writer);
      await writer.send('COMMIT;');
      await assert.rejects(pending, /MEMBERSHIP_STATE_CONFLICT/);
      await gone(restore.pid);
      const after = await snapshot();
      assert.equal(after.state.clinic_role, 'viewer'); assert.equal(after.state.active, false);
      assert.notEqual(after.state.state_version, off.after.state_version);
      assert.equal(after.receipts, 1); assert.equal(after.audits, 1);
    });
    await runCase('native lock timeout rolls back request and audit', async () => {
      const before = await state(), baseline = await snapshot();
      const holder = await session('cnyos_fixture_owner'), waiter = await session();
      await holder.send(`BEGIN; SELECT id FROM public.profiles WHERE id=${sqlLiteral(actor)} FOR NO KEY UPDATE;`);
      const pending = waiter.send(transitionSql(before, randomUUID())); pending.catch(() => {});
      await blockedBy(waiter, holder);
      await assert.rejects(pending, /lock timeout/);
      await gone(waiter.pid);
      await holder.send('ROLLBACK;');
      assert.deepEqual(await snapshot(), baseline);
    });
    await runCase('client loss before COMMIT rolls back durable state', async () => {
      const before = await state(), baseline = await snapshot(), client = await session();
      await client.send('BEGIN;');
      const provisional = JSON.parse(await client.send(transitionSql(before, randomUUID())));
      assert.equal(provisional.after.active, false);
      assert.deepEqual(await snapshot(), baseline);
      client.child.kill('SIGTERM');
      await client.done;
      await gone(client.pid);
      assert.deepEqual(await snapshot(), baseline);
    });
    await runCase('committed restore survives caller disconnect and exact retry', async () => {
      const offId = randomUUID(), off = await transition(await state(), offId), onId = randomUUID();
      const client = await session();
      await client.send('BEGIN;');
      // Discard the provisional RPC return. A separate connection must observe
      // the commit, rather than treating a response inside BEGIN as durable proof.
      await client.send(transitionSql(off.after, onId, offId));
      client.child.stdin.write('COMMIT;\n');
      await waitFor(`SELECT EXISTS(SELECT 1 FROM public.staff_membership_transition_requests
        WHERE actor_id=${sqlLiteral(actor)} AND request_id=${sqlLiteral(onId)});`, 'independently visible committed ON receipt');
      client.child.kill('SIGTERM');
      await client.done; await gone(client.pid);
      const committed = await snapshot();
      const historical = await json(`SELECT receipt FROM public.staff_membership_transition_requests
        WHERE actor_id=${sqlLiteral(actor)} AND request_id=${sqlLiteral(onId)};`);
      const receipt = await transition(off.after, onId, offId);
      assert.deepEqual(receipt, historical);
      assert.deepEqual(receipt.after, await state());
      assert.equal(committed.state.active, true);
      const after = await snapshot();
      assert.deepEqual(after, committed);
      assert.equal(after.receipts, 2); assert.equal(after.audits, 2);
    });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(runDeadline);
    for (const client of [...clients]) await client.close();
    if (startAttempted) {
      const stop = await command(executables.pg_ctl, ['stop','-D',data,'-m','fast','-w','-t','15']);
      const status = await command(executables.pg_ctl, ['status','-D',data]);
      stopped = stop.code === 0 && status.code === 3 && !fs.existsSync(path.join(data, 'postmaster.pid'));
      if (!stopped) failure = new AggregateError([failure, new Error(`Native fixture shutdown unverified: ${stop.stderr}`)].filter(Boolean), 'Native fixture failed or shutdown remains unverified');
    }
    if (fs.existsSync(log)) fs.chmodSync(log, 0o600);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  if (failure) {
    process.stderr.write(`${JSON.stringify({ status: 'FAILED', error: failure.message,
      cause: failure instanceof AggregateError ? failure.errors.map(e => e.message) : undefined,
      ownedFixtureDirectory: ownedRoot, serverStopped: stopped, passedCases: cases })}\n`);
    process.exitCode = 1;
    return;
  }
  assert.equal(stopped, true);
  assert.equal(cases.length, 8);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, evidenceType: 'native_synthetic_membership_functional_checks',
    generatedAt: new Date().toISOString(), status: 'PASS', sourceBaseCommit, sourceCheckoutDirty,
    sourceHashes: sources, binaryHashes,
    serverVersion, transport: 'private-unix-socket-only', candidateOwnerSuperuser: false,
    workflowRole: 'authenticated', fixtureDirectory: ownedRoot, serverStopped: stopped,
    cases, hostedStagingVerified: false, durableRunnerRecoveryVerified: false,
    independentHumanApproval: false, productionAuthorized: false })}\n`);
}

main().catch(error => { process.stderr.write(`Native fixture setup failed: ${error.message}\n`); process.exitCode = 1; });
