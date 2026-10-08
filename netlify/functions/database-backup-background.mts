import { handleBackgroundBackup } from './_shared/database-backup-runtime.mjs';

// Netlify recognizes the `-background` filename suffix and grants this worker
// the background-function execution budget. Netlify rejects non-POST requests
// before enqueueing the worker, and the handler authenticates every dispatch.
export default async (request, context) => handleBackgroundBackup(request, context);

export const config = {
  method: 'POST'
};
