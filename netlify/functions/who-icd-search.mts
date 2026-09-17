import { handleWhoIcd } from './_shared/who-icd.mjs';

export default async (request, context) => handleWhoIcd(request, context, {
  getEnv: name => Netlify.env.get(name) || ''
});

export const config = {
  path: '/api/who-icd-search',
  method: 'POST',
  rateLimit: {
    windowLimit: 20,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};
