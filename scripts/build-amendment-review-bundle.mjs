// Source-only review artifact. No database access, authorization or activation.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const candidates=[
  ['supabase/manual/clinical_amendment_recovery_candidate.sql','CLINICAL_AMENDMENT_RECOVERY_REVIEW_REQUIRED'],
  ['supabase/manual/clinical_amendment_backup_candidate.sql','CLINICAL_AMENDMENT_BACKUP_REVIEW_REQUIRED']
];
export const amendmentReviewFiles=Object.freeze([
  ...candidates.map(([file])=>file),
  'admin.html','admin-clinical-audit.js','amendment-journal.js',
  'netlify/functions/_shared/database-backup.mjs',
  'netlify/functions/_shared/database-backup-runtime.mjs',
  'scripts/verify-restore-set.mjs','scripts/verify-restored-database.mjs',
  'scripts/restore-trace-request.mjs','scripts/restore-count-comparison.mjs',
  'scripts/generate-tenant-config.mjs','platform-config.js'
]);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function buildAmendmentReviewBundle(read=file=>fs.readFile(path.join(root,file))) {
  const sources=[]; const contents=new Map();
  for(const file of amendmentReviewFiles) {
    const bytes=Buffer.from(await read(file));
    if(!bytes.length) throw new Error(`AMENDMENT_REVIEW_SOURCE_EMPTY: ${file}`);
    sources.push({file,bytes:bytes.length,sha256:digest(bytes)});
    contents.set(file,bytes.toString('utf8'));
  }
  const bodies=candidates.map(([file,code])=>{
    const source=contents.get(file);
    const blocker=`do $$ begin raise exception '${code}'; end $$;`;
    if(source.split(blocker).length!==2) throw new Error(`AMENDMENT_REVIEW_GUARD_INVALID: ${file}`);
    // This is deliberately not a general SQL parser or migration rewriter.
    // Accept only these candidates' explicit outer transaction envelope.
    if((source.match(/^begin;$/gm)||[]).length!==1 || (source.match(/^commit;$/gm)||[]).length!==1
      || !/\ncommit;\s*$/.test(source)) throw new Error(`AMENDMENT_REVIEW_ENVELOPE_INVALID: ${file}`);
    return `-- Source: ${file}\n${source.replace(/^begin;\n/m,'').replace(/\ncommit;\s*$/,'')}\n`;
  });
  const sql=`-- NOT AUTHORIZED: source-only atomic review proposal; both guards retained.\nbegin;\n${bodies.join('\n')}commit;\n`;
  return {
    format:'cnyos-amendment-review-bundle/v1',authorization:false,productionEligible:false,
    sourceBasis:'working-tree-byte-hashes-not-release-approval',
    requiredBackupSchemaVersion:'2026-09-27.2',
    requirements:['independent-review','migration-provenance','matching-ui-and-backup-runtime',
      'protected-deployment','authorized-live-acceptance'],
    sources,sqlSha256:digest(sql),sql
  };
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if(process.argv.length!==2) throw new Error('AMENDMENT_REVIEW_NO_ACTIVATION_ARGUMENTS');
    process.stdout.write(`${JSON.stringify(await buildAmendmentReviewBundle(),null,2)}\n`);
  } catch(error) {
    process.stderr.write(`${String(error.message)}\n`);process.exitCode=1;
  }
}
