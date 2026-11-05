// Tratador da API, compartilhado pela função serverless da Vercel (api/index.js)
// e pelo servidor local de desenvolvimento (server/index.js).
import { createRouter, sendJson, readJson, HttpError } from './http.js';
import { currentUser } from './auth.js';
import { ensureReady } from './setup.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerLeadRoutes } from './routes/leads.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerActivityRoutes } from './routes/activity.js';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

const router = createRouter();
registerAdminRoutes(router);
registerLeadRoutes(router);
registerDashboardRoutes(router);
registerActivityRoutes(router);

export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    const match = router.match(req.method, url.pathname);
    if (!match) return sendJson(res, 404, { error: 'Rota não encontrada.' }, SECURITY_HEADERS);
    await ensureReady();
    const ctx = {
      req, res,
      params: match.params,
      query: url.searchParams,
      user: await currentUser(req),
      json: () => readJson(req),
    };
    const result = await match.handler(ctx);
    if (!res.headersSent) sendJson(res, 200, result, SECURITY_HEADERS);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, SECURITY_HEADERS);
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erro interno. Tente novamente.' }, SECURITY_HEADERS);
  }
}
