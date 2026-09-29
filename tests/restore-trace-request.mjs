import assert from 'node:assert/strict';
import {requestRestoreTrace} from '../scripts/restore-trace-request.mjs';
const url='https://restore.invalid/rpc';
let calls=0,signal;
assert.deepEqual(await requestRestoreTrace(url,{method:'POST'},{fetchImpl:async(actual,options)=>{
  calls++;signal=options.signal;assert.equal(actual,url);assert.equal(options.redirect,'error');
  return {ok:true,json:async()=>({ready:true})};
}}),{ready:true});
assert.equal(calls,1);assert.equal(signal.aborted,true);
for(const body of [false,true]){
  calls=0;
  await assert.rejects(requestRestoreTrace(url,{}, {timeoutMs:10,fetchImpl:async(_,options)=>{
    calls++;signal=options.signal;
    const stalled=new Promise(()=>{});
    return body?{ok:true,json:()=>stalled}:stalled;
  }}),{message:'RESTORE_TRACE_TIMEOUT'});
  assert.equal(signal.aborted,true);assert.equal(calls,1);
}
for(const [fetchImpl,code] of [
  [async()=>{throw new Error('secret remote connection details');},'RESTORE_TRACE_REQUEST_FAILED'],
  [async()=>({ok:false,json:()=>{throw new Error('must not read error body');}}),'RESTORE_TRACE_RPC_FAILED'],
  [async()=>({ok:true,json:async()=>{throw new Error('secret body');}}),'RESTORE_TRACE_RESPONSE_INVALID']
]) await assert.rejects(requestRestoreTrace(url,{}, {fetchImpl}),{message:code});
for(const timeoutMs of [0,-1,45001,NaN,'45'])
  await assert.rejects(requestRestoreTrace(url,{}, {timeoutMs}),{message:'RESTORE_TRACE_TIMEOUT_INVALID'});
console.log('Restore trace transport passed: bounded headers/body, abort, no retry, redirect refusal and sanitized errors; no live connection.');
