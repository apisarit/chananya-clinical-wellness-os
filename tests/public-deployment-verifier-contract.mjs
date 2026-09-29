import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSameOriginFramePolicy } from '../scripts/netlify-frame-policy.mjs';
import {
  assertProductionManifestClassification,
  forbiddenPublicPaths,
  publicDeploymentRequestPolicy,
  requestPublicDeployment,
  verifyServedCode,
  assertRuntimeCodeInventory,
  validateProductionOrigin
} from '../scripts/verify-public-deployment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
{
  const bodies = { 'app.js': Buffer.from('const title="ทดสอบ";'), 'app.css': Buffer.from('body{}'), 'tenant-config.js': Buffer.from('config={}'), 'brand-config.js': Buffer.from('brand="custom"'), 'evidence-page.mjs': Buffer.from('export const x=1;'), 'index.html': Buffer.from('<html>') };
  const files = Object.keys(bodies);
  const manifest = {fileCount: files.length, files, integrity: files.map(path => ({path,size:bodies[path].length,sha256:createHash('sha256').update(bodies[path]).digest('hex')}))};
  const seen=[];
  const request=async(origin,path,options)=>{
    assert.equal(origin,'https://synthetic.example');
    assert.equal(options.binary,true);
    seen.push(path);
    return {body:bodies[path.slice(1)]};
  };
  const readCommitted=name=>{ assert.ok(!['tenant-config.js','brand-config.js'].includes(name)); return bodies[name]; };
  const evidence=await verifyServedCode('https://synthetic.example',manifest,{request,readCommitted});
  assert.equal(evidence.length,5);
  assert.deepEqual(seen,['/app.js','/app.css','/tenant-config.js','/brand-config.js','/evidence-page.mjs']);
  assert.equal(evidence.find(x=>x.path==='tenant-config.js').sourceBound,false);
  assert.equal(evidence.find(x=>x.path==='brand-config.js').sourceBound,false);
  assert.equal(evidence.find(x=>x.path==='evidence-page.mjs').sourceBound,true);
  const sources=new Map(Object.entries(bodies).filter(([name])=>!['tenant-config.js','brand-config.js'].includes(name)));
  assertRuntimeCodeInventory(manifest,sources);
  assert.throws(()=>assertRuntimeCodeInventory({...manifest,files:files.filter(name=>name!=='evidence-page.mjs')},sources),/runtime code inventory/);
  assert.throws(()=>assertRuntimeCodeInventory({...manifest,files:[...files,'unexpected.js']},sources),/runtime code inventory/);
  await assert.rejects(verifyServedCode('https://synthetic.example',manifest,{request:async()=>({body:Buffer.from('old')}),readCommitted}),/served asset size mismatch/);
  await assert.rejects(verifyServedCode('https://synthetic.example',manifest,{request:async()=>({body:Buffer.alloc(bodies['app.js'].length)}),readCommitted}),/served asset digest mismatch/);
  await assert.rejects(verifyServedCode('https://synthetic.example',manifest,{request,readCommitted:()=>Buffer.from('different commit')}),/served asset source mismatch/);
  for(const mutate of [
    m=>{m.fileCount++;},
    m=>{m.files[1]=m.files[0];},
    m=>{m.integrity[0].path='wrong.js';},
    m=>{m.integrity[0].sha256='bad';},
    m=>{m.integrity[0].size=-1;},
    ...['../app.js','https://evil.example/x.js','//evil.example/x.js','app.js?x','%2e%2e.js'].map(path=>m=>{m.files[0]=path;m.integrity[0].path=path;})
  ]) {
    const altered=structuredClone(manifest);mutate(altered);
    let calls=0;
    await assert.rejects(verifyServedCode('https://synthetic.example',altered,{request:async()=>{calls++;throw new Error('unexpected request');},readCommitted}));
    assert.equal(calls,0,'invalid inventory must fail before network access');
  }
  const binary=await requestPublicDeployment('https://synthetic.example','/app.js',{binary:true,expectedStatus:200,fetchImpl:async()=>new Response(bodies['app.js'])});
  assert.deepEqual(binary.body,bodies['app.js']);
}
const source = fs.readFileSync(path.join(root, 'scripts', 'verify-public-deployment.mjs'), 'utf8');
const framePolicySource = fs.readFileSync(path.join(root, 'scripts', 'netlify-frame-policy.mjs'), 'utf8');
const staticHeadersSource = fs.readFileSync(path.join(root, '_headers'), 'utf8');
const netlifyConfigSource = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');

assert.equal(validateProductionOrigin('https://cnyos.netlify.app', 'cnyos.netlify.app'), 'https://cnyos.netlify.app');
assert.equal(validateProductionOrigin('https://cnyos.cloud:443', 'cnyos.cloud'), 'https://cnyos.cloud');
assert.throws(() => validateProductionOrigin('https://cnyos.cloud:8443', 'cnyos.cloud'), /PRODUCTION_SITE_URL_INVALID/);
assert.throws(() => validateProductionOrigin('https://[::1]', '[::1]'), /PRODUCTION_SITE_HOST_INVALID/);
assert.throws(() => validateProductionOrigin('http://cnyos.netlify.app', 'cnyos.netlify.app'), /PRODUCTION_SITE_URL_INVALID/);
assert.throws(() => validateProductionOrigin('https://cnyos.netlify.app/path', 'cnyos.netlify.app'), /PRODUCTION_SITE_URL_MUST_BE_ORIGIN/);
assert.throws(() => validateProductionOrigin('https://evil.example', 'cnyos.netlify.app'), /PRODUCTION_SITE_HOST_MISMATCH/);
assert.throws(() => validateProductionOrigin('https://localhost', 'localhost'), /PRODUCTION_SITE_HOST_INVALID/);

assert.deepEqual(
  publicDeploymentRequestPolicy,
  { maxAttempts: 3, timeoutMs: 45_000, initialDelayMs: 1_000 },
  'public deployment verification must use a bounded three-attempt retry policy'
);

{
  let calls = 0;
  const delays = [];
  const messages = [];
  const result = await requestPublicDeployment('https://cnyos.cloud', '/', {
    expectedStatus: 200,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error('synthetic timeout');
      return new Response('ready', { status: 200 });
    },
    sleepImpl: async delay => { delays.push(delay); },
    logImpl: message => { messages.push(message); }
  });
  assert.equal(result.body, 'ready');
  assert.equal(calls, 3, 'transient network failures must retry at most three times');
  assert.deepEqual(delays, [1_000, 2_000], 'retry backoff must remain bounded and deterministic');
  assert.equal(messages.length, 2, 'each retry must be visible in workflow logs');
}

{
  let calls = 0;
  await assert.rejects(
    requestPublicDeployment('https://cnyos.cloud', '/', {
      expectedStatus: 200,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('synthetic timeout');
      },
      sleepImpl: async () => {},
      logImpl: () => {}
    }),
    /PUBLIC_DEPLOYMENT_REQUEST_FAILED \/ after 3 attempts: synthetic timeout/
  );
  assert.equal(calls, 3, 'persistent network failures must fail closed after three attempts');
}

{
  let calls = 0;
  await assert.rejects(
    requestPublicDeployment('https://cnyos.cloud', '/', {
      expectedStatus: 200,
      fetchImpl: async () => {
        calls += 1;
        return new Response('not found', { status: 404 });
      },
      sleepImpl: async () => {},
      logImpl: () => {}
    }),
    /PUBLIC_DEPLOYMENT_STATUS_MISMATCH \/: expected 200, received 404/
  );
  assert.equal(calls, 1, 'non-transient status mismatches must not be retried');
}

{
  let calls = 0;
  const result = await requestPublicDeployment('https://cnyos.cloud', '/', {
    expectedStatus: 200,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response('unavailable', { status: 503 })
        : new Response('ready', { status: 200 });
    },
    sleepImpl: async () => {},
    logImpl: () => {}
  });
  assert.equal(result.body, 'ready');
  assert.equal(calls, 2, 'transient HTTP status failures must be retried');
}

const productionManifestClassification = {
  deploymentId: 'chananya-clinical-production',
  tenant: { expectedClinicCode: 'CHANANYA' },
  identity: { qrIssuer: 'CHANANYA' },
  build: { deploymentClass: 'production' },
  safety: { stagingDatabaseExplicitlyAcknowledged: false }
};
assert.doesNotThrow(() => assertProductionManifestClassification(productionManifestClassification));
for (const [label, candidate, expectedError] of [
  [
    'missing deployment class',
    { build: {}, safety: { stagingDatabaseExplicitlyAcknowledged: false } },
    /deploymentClass=production/
  ],
  [
    'staging deployment class',
    { build: { deploymentClass: 'dedicated-staging' }, safety: { stagingDatabaseExplicitlyAcknowledged: false } },
    /deploymentClass=production/
  ],
  [
    'missing staging acknowledgement marker',
    { build: { deploymentClass: 'production' }, safety: {} },
    /stagingDatabaseExplicitlyAcknowledged=false/
  ],
  [
    'staging acknowledgement enabled',
    { build: { deploymentClass: 'production' }, safety: { stagingDatabaseExplicitlyAcknowledged: true } },
    /stagingDatabaseExplicitlyAcknowledged=false/
  ],
  [
    'staging deployment identity',
    {
      deploymentId: 'chananya-clinical-staging',
      tenant: { expectedClinicCode: 'CHANANYA-STG' },
      identity: { qrIssuer: 'CHANANYA-STG' },
      build: { deploymentClass: 'production' },
      safety: { stagingDatabaseExplicitlyAcknowledged: false }
    },
    /must not contain a staging identity/
  ]
]) {
  assert.throws(
    () => assertProductionManifestClassification(candidate),
    expectedError,
    `${label} must fail closed`
  );
}

for (const requiredForbidden of [
  '/.env.example',
  '/package.json',
  '/release-readiness.json',
  '/config/tenant.chananya.json',
  '/scripts/generate-tenant-config.mjs',
  '/tests/commercial-release-gate.mjs',
  '/supabase/migrations/'
]) {
  assert.ok(forbiddenPublicPaths.includes(requiredForbidden), `missing forbidden-path assertion ${requiredForbidden}`);
}

assert.match(source, /rev-parse', 'HEAD'/, 'attestation must bind to the exact checked-out commit');
assert.match(source, /rev-parse', 'HEAD\^\{tree\}'/, 'attestation must derive the exact checked-out Git tree');
assert.match(source, /source\?\.commit, expectedCommit/, 'attestation must compare the deployed source commit');
assert.match(source, /source\?\.tree, checkoutTree/, 'attestation must compare the deployed source tree');
assert.match(source, /build\?\.context, 'production'/, 'attestation must require production context');
assert.match(source, /assertProductionManifestClassification\(deploy\.body\)/, 'attestation must require production manifest classification');
assert.match(source, /previewLocked, false/, 'attestation must reject preview-locked deployments');
assert.match(source, /runtime-publish-manifest\.json/, 'attestation must verify the runtime publish manifest');
assert.match(source, /strict-transport-security/, 'attestation must verify HSTS');
assert.match(source, /assertSameOriginFramePolicy/, 'attestation must enforce the shared frame policy');
assert.match(framePolicySource, /content-security-policy/, 'shared frame policy must verify CSP');
assert.match(source, /expectedStatus: 404/, 'attestation must prove internal paths are not public');
assert.doesNotMatch(staticHeadersSource, /X-Frame-Options:\s*DENY/, 'static headers must not conflict with the same-origin frame policy');
assert.equal(
  (staticHeadersSource.match(/X-Frame-Options:\s*SAMEORIGIN/g) || []).length,
  4,
  'all four route-specific frame declarations must align with the global same-origin policy'
);

const configuredFrameOptions = netlifyConfigSource.match(/X-Frame-Options = "([^"]+)"/);
const configuredContentSecurityPolicy = netlifyConfigSource.match(/Content-Security-Policy = "([^"]+)"/);
assert.ok(configuredFrameOptions, 'netlify.toml must declare X-Frame-Options');
assert.ok(configuredContentSecurityPolicy, 'netlify.toml must declare Content-Security-Policy');
const validFrameHeaders = {
  'X-Frame-Options': configuredFrameOptions[1],
  'Content-Security-Policy': configuredContentSecurityPolicy[1]
};
assert.doesNotThrow(() => assertSameOriginFramePolicy(new Headers(validFrameHeaders), '/'));
for (const [name, headers] of [
  ['missing X-Frame-Options', { 'Content-Security-Policy': "frame-ancestors 'self'" }],
  ['missing Content-Security-Policy', { 'X-Frame-Options': 'SAMEORIGIN' }],
  ['legacy ALLOW-FROM', { ...validFrameHeaders, 'X-Frame-Options': 'ALLOW-FROM https://attacker.example' }],
  ['wildcard ancestor', { ...validFrameHeaders, 'Content-Security-Policy': 'frame-ancestors *' }],
  ['extra cross-origin ancestor', {
    ...validFrameHeaders,
    'Content-Security-Policy': "frame-ancestors 'self' https://attacker.example"
  }]
]) {
  assert.throws(
    () => assertSameOriginFramePolicy(new Headers(headers), '/'),
    undefined,
    `${name} must fail the shared frame policy`
  );
}

console.log('Public deployment verifier contract passed: exact commit/tree, headers and forbidden paths required');
