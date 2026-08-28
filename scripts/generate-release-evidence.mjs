import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function exactCommit() {
  const head = git('rev-parse', 'HEAD');
  const workflowCommit = String(process.env.GITHUB_SHA || head).trim();
  if (!/^[0-9a-f]{40}$/i.test(workflowCommit) || workflowCommit !== head) {
    throw new Error('RELEASE_EVIDENCE_COMMIT_MISMATCH');
  }
  return head;
}

const status = git('status', '--porcelain', '--untracked-files=no');
if (status && process.env.RELEASE_EVIDENCE_ALLOW_DIRTY !== 'true') {
  throw new Error('RELEASE_EVIDENCE_WORKTREE_DIRTY');
}

const commit = exactCommit();
const tracked = git('ls-files', '-z').split('\0').filter(Boolean).sort();
const sourceManifest = [];
for (const relative of tracked) {
  const bytes = await fs.readFile(path.join(root, relative));
  sourceManifest.push(`${relative}\0${sha256(bytes)}`);
}
const migrations = tracked.filter(file => file.startsWith('supabase/migrations/') && file.endsWith('.sql'));
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const evidence = {
  schemaVersion: 1,
  evidenceType: 'exact_commit_source_and_contract_evidence',
  generatedAt: new Date().toISOString(),
  commit,
  tree: git('rev-parse', 'HEAD^{tree}'),
  ref: process.env.GITHUB_REF || null,
  event: process.env.GITHUB_EVENT_NAME || 'local',
  workflowRunId: process.env.GITHUB_RUN_ID || null,
  workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  workingTreeClean: status.length === 0,
  trackedFileCount: tracked.length,
  trackedSourceManifestSha256: sha256(sourceManifest.join('\n')),
  migrationCount: migrations.length,
  migrationChainSha256: sha256(migrations.map(file => sourceManifest[tracked.indexOf(file)]).join('\n')),
  packageLockSha256: sha256(await fs.readFile(path.join(root, 'package-lock.json'))),
  releaseReadinessSha256: sha256(await fs.readFile(path.join(root, 'release-readiness.json'))),
  verificationCommand: packageJson.scripts.check,
  releaseChannel: JSON.parse(await fs.readFile(path.join(root, 'release-readiness.json'), 'utf8')).releaseChannel
};

const directory = path.resolve(process.env.RELEASE_EVIDENCE_DIR || path.join(root, 'artifacts', 'release-evidence'));
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
const destination = path.join(directory, 'exact-commit.json');
await fs.writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Exact-commit evidence generated for ${commit}; ${tracked.length} tracked files, ${migrations.length} migrations: ${destination}\n`);
