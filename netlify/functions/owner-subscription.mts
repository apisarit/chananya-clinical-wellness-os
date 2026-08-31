import {
  allowedOwnerOrigin,
  assertOwnerProject,
  extractBearerToken,
  normalizeOwnerClinicCodes,
  normalizeOwnerEmails,
  normalizeSubscriptionRequest,
  ownerPublicError,
  readOwnerJson,
  supabaseOwnerRequest,
  validateOwnerUser
} from './_shared/owner-control.mjs';

const responseHeaders = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

function env(name) {
  return Netlify.env.get(name) || '';
}

function configuration() {
  if (env('CNYOS_OWNER_CONTROL_ENABLED') !== 'true') {
    throw new Error('CNYOS_OWNER_CONTROL_DISABLED');
  }
  const supabaseUrl = env('SUPABASE_URL');
  assertOwnerProject(supabaseUrl, env('CNYOS_OWNER_EXPECTED_PROJECT_REF'));
  return Object.freeze({
    supabaseUrl,
    serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    ownerEmails: normalizeOwnerEmails(env('CNYOS_OWNER_EMAILS')),
    clinicCodes: normalizeOwnerClinicCodes(env('CNYOS_OWNER_CLINIC_CODES'))
  });
}

async function authenticateOwner(request, config) {
  const token = extractBearerToken(request);
  const user = await supabaseOwnerRequest({
    url: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
    resource: '/auth/v1/user',
    bearer: token
  });
  return validateOwnerUser(user, config.ownerEmails);
}

async function listClinics(config) {
  const clinics = await supabaseOwnerRequest({
    url: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
    resource: '/rest/v1/rpc/list_owner_subscription_clinics',
    method: 'POST',
    body: {}
  });
  return Array.isArray(clinics)
    ? clinics.filter(clinic => config.clinicCodes.includes(String(clinic?.clinic_code || '').toUpperCase()))
    : [];
}

async function changeSubscription(request, config, owner) {
  const input = normalizeSubscriptionRequest(await readOwnerJson(request));
  if (!config.clinicCodes.includes(input.clinicCode)) throw new Error('CNYOS_OWNER_CLINIC_NOT_ALLOWED');
  return supabaseOwnerRequest({
    url: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
    resource: '/rest/v1/rpc/set_clinic_subscription_state',
    method: 'POST',
    body: {
      p_request_id: input.requestId,
      p_clinic_id: input.clinicId,
      p_expected_clinic_code: input.clinicCode,
      p_enabled: input.enabled,
      p_reason: input.reason,
      p_actor_user_id: owner.id,
      p_actor_email: owner.email
    }
  });
}

export default async (request, context) => {
  const requestId = context.requestId || crypto.randomUUID();
  if (!allowedOwnerOrigin(request)) return json({ ok: false, code: 'CNYOS_OWNER_ORIGIN_DENIED' }, 403);
  if (!['GET', 'POST'].includes(request.method)) return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);

  try {
    const config = configuration();
    const owner = await authenticateOwner(request, config);
    if (request.method === 'GET') {
      return json({ ok: true, clinics: await listClinics(config) });
    }
    const result = await changeSubscription(request, config, owner);
    return json({ ok: true, result });
  } catch (error) {
    const safe = ownerPublicError(error);
    console.error('CNYOS owner subscription request failed', {
      requestId,
      code: safe.code
    });
    return json({ ok: false, code: safe.code }, safe.status);
  }
};

export const config = {
  path: '/api/owner-subscription',
  method: ['GET', 'POST']
};
