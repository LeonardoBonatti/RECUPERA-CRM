// Atuação da equipe: o gerente vê se cada executivo está trabalhando a carteira.
// "Atuou" = o próprio executivo registrou alguma resposta no sistema (site ou planilha enviada).
import { q } from '../db.js';
import { fail, toInt } from '../http.js';
import { requireRole } from '../auth.js';

// Executivos que o usuário pode acompanhar.
function executiveScope(user) {
  if (user.role === 'NACIONAL' || user.role === 'VISUALIZADOR') return { sql: '1 = 1', params: [] };
  // Gerente regional: executivos das regionais dele e os que atendem leads em que ele é o gerente.
  return {
    sql: `(u.region_id = ANY(?::int[]) OR EXISTS (SELECT 1 FROM leads lm WHERE lm.executive_id = u.id AND lm.manager_id = ?))`,
    params: [user.region_ids?.length ? user.region_ids : [-1], user.id],
  };
}

export function registerActivityRoutes(r) {
  r.get('/api/activity', async ({ user }) => {
    requireRole(user, 'NACIONAL', 'REGIONAL', 'VISUALIZADOR');
    const scope = executiveScope(user);
    return q.all(`
      SELECT u.id, u.name, u.email, u.active, u.last_login_at, u.must_change_password, r.name AS region_name,
             count(l.id) AS leads,
             count(l.id) FILTER (WHERE l.completed_at IS NOT NULL) AS completed,
             count(l.id) FILTER (WHERE t.lead_id IS NOT NULL) AS touched,
             count(l.id) FILTER (WHERE t.lead_id IS NULL) AS untouched,
             count(l.id) FILTER (WHERE l.contact_status IS NULL) AS no_status,
             coalesce(sum(l.amount), 0) AS amount,
             (SELECT count(*) FROM lead_history h WHERE h.user_id = u.id AND h.action LIKE 'qualifica%'
                AND h.created_at > now() - interval '7 days') AS changes_7d,
             (SELECT count(*) FROM lead_history h WHERE h.user_id = u.id AND h.action LIKE 'qualifica%'
                AND h.created_at > now() - interval '30 days') AS changes_30d,
             (SELECT count(DISTINCT h.lead_id) FROM lead_history h WHERE h.user_id = u.id AND h.action LIKE 'qualifica%'
                AND h.created_at > now() - interval '7 days') AS leads_7d,
             (SELECT max(h.created_at) FROM lead_history h WHERE h.user_id = u.id AND h.action LIKE 'qualifica%') AS last_action
      FROM users u
      LEFT JOIN regions r ON r.id = u.region_id
      LEFT JOIN leads l ON l.executive_id = u.id
      LEFT JOIN LATERAL (
        SELECT h.lead_id FROM lead_history h WHERE h.lead_id = l.id AND h.user_id = u.id LIMIT 1
      ) t ON true
      WHERE u.role = 'EXECUTIVO' AND ${scope.sql}
      GROUP BY u.id, r.name
      ORDER BY last_action ASC NULLS FIRST, u.name`, ...scope.params);
  });

  // Linha do tempo de um executivo: o que ele registrou, em qual cliente e quando.
  r.get('/api/activity/:id', async ({ user, params }) => {
    requireRole(user, 'NACIONAL', 'REGIONAL', 'VISUALIZADOR');
    const id = toInt(params.id);
    const scope = executiveScope(user);
    const exec = await q.get(`SELECT u.id, u.name FROM users u WHERE u.id = ? AND u.role = 'EXECUTIVO' AND ${scope.sql}`,
      id, ...scope.params);
    if (!exec) fail(404, 'Executivo não encontrado na sua equipe.');
    const events = await q.all(`
      SELECT h.created_at, h.action, h.field, h.old_value, h.new_value, l.id AS lead_id, l.client_name, l.machine
      FROM lead_history h JOIN leads l ON l.id = h.lead_id
      WHERE h.user_id = ? ORDER BY h.id DESC LIMIT 200`, id);
    return { executive: exec, events };
  });
}
