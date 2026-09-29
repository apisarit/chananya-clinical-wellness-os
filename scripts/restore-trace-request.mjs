// Bound both response headers and body consumption; never surface remote error bodies.
export async function requestRestoreTrace(url, options, {fetchImpl=fetch, timeoutMs=45000}={}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000)
    throw new Error('RESTORE_TRACE_TIMEOUT_INVALID');
  const controller=new AbortController();
  let timer;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      controller.abort();
      reject(new Error('RESTORE_TRACE_TIMEOUT'));
    },timeoutMs);
  });
  try {
    return await Promise.race([deadline,(async()=>{
      const response=await fetchImpl(url,{...options,redirect:'error',signal:controller.signal});
      if (!response.ok) throw new Error('RESTORE_TRACE_RPC_FAILED');
      try { return await response.json(); }
      catch { throw new Error('RESTORE_TRACE_RESPONSE_INVALID'); }
    })()]);
  } catch(error) {
    if (controller.signal.aborted) throw new Error('RESTORE_TRACE_TIMEOUT');
    if (['RESTORE_TRACE_RPC_FAILED','RESTORE_TRACE_RESPONSE_INVALID'].includes(error?.message)) throw error;
    throw new Error('RESTORE_TRACE_REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
