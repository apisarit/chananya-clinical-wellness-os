import { handleBackgroundBackup } from './_shared/database-backup-runtime.mjs';

// Netlify recognizes the `-background` filename suffix and grants this worker
// the background-function execution budget. The explicit route is required for
// Netlify to apply the POST-only method restriction before enqueueing the worker.
export default async (request, context) => handleBackgroundBackup(request, context);

export const config = {
  // Keep this a literal: Netlify's build-time config extractor does not resolve
  // imported constants when materializing custom function routes.
  path: '/api/internal/database-backup-worker',
  method: 'POST'
};
