// Módulo 3: KPIs em tempo real (substitui a consolidação manual do PowerPoint).
import { q } from '../db.js';
import { requireRole } from '../auth.js';
import { leadFilters } from '../scope.js';
import { QUALIFICATION_FIELDS, statusesWhere } from '../fields.js';

// Listas derivadas de fields.js — mudar as opções lá ajusta os KPIs automaticamente.
const CONTACTED = statusesWhere(s => s.contacted);
const WON = statusesWhere((s, stage) => stage === 'ganho');

export function registerDashboardRoutes(r) {
  r.get('/api/dashboard', async ({ user, query }) => {
    requireRole(user);
    const f = leadFilters(user, query);
    const W = `WHERE ${f.sql}`;
    const P = f.params;

    // Consultas independentes em paralelo (cada ida ao banco tem latência de rede).
    const distribution = column => q.all(`
      SELECT coalesce(l.${column}, 'Não preenchido') AS name, count(*) AS count, coalesce(sum(l.amount), 0) AS amount
      FROM leads l ${W} GROUP BY 1 ORDER BY count DESC`, ...P);
    const closedFields = QUALIFICATION_FIELDS.filter(x => x.type !== 'text');

    const [totals, byRegion, lossReasons, byExecutive, ...distributions] = await Promise.all([
      q.get(`
        SELECT count(*) AS opportunities,
               count(DISTINCT l.client_key) AS clients,
               coalesce(sum(l.quantity), 0) AS machines,
               coalesce(sum(l.amount), 0) AS amount,
               count(*) FILTER (WHERE l.region_id IS NULL) AS unrouted,
               count(*) FILTER (WHERE l.executive_id IS NOT NULL) AS assigned,
               count(*) FILTER (WHERE l.contact_status = ANY(?::text[])) AS contacted,
               count(*) FILTER (WHERE l.completed_at IS NOT NULL) AS completed,
               count(*) FILTER (WHERE l.contact_status = ANY(?::text[])) AS won,
               coalesce(sum(l.amount) FILTER (WHERE l.contact_status = ANY(?::text[])), 0) AS won_amount,
               max(l.updated_at) AS last_update
        FROM leads l ${W}`, CONTACTED, WON, WON, ...P),
      q.all(`
        SELECT coalesce(r.name, 'Sem regional') AS name, l.region_id AS id,
               count(*) AS opportunities, count(DISTINCT l.client_key) AS clients,
               coalesce(sum(l.quantity), 0) AS machines, coalesce(sum(l.amount), 0) AS amount,
               count(*) FILTER (WHERE l.completed_at IS NOT NULL) AS completed
        FROM leads l LEFT JOIN regions r ON r.id = l.region_id ${W}
        GROUP BY l.region_id, r.name ORDER BY amount DESC`, ...P),
      q.all(`
        SELECT coalesce(l.loss_reason, 'Não informado') AS name, count(*) AS count, coalesce(sum(l.amount), 0) AS amount
        FROM leads l ${W} GROUP BY 1 ORDER BY amount DESC LIMIT 8`, ...P),
      q.all(`
        SELECT u.id, u.name, r.name AS region_name, count(*) AS leads,
               count(*) FILTER (WHERE l.contact_status = ANY(?::text[])) AS contacted,
               count(*) FILTER (WHERE l.completed_at IS NOT NULL) AS completed,
               coalesce(sum(l.amount), 0) AS amount
        FROM leads l JOIN users u ON u.id = l.executive_id LEFT JOIN regions r ON r.id = u.region_id
        ${W} GROUP BY u.id, r.name ORDER BY leads DESC`, CONTACTED, ...P),
      ...closedFields.map(x => distribution(x.key)),
    ]);

    const qualification = {};
    closedFields.forEach((field, i) => { qualification[field.key] = { label: field.label, rows: distributions[i] }; });

    return { totals, byRegion, qualification, lossReasons, byExecutive, generatedAt: new Date().toISOString() };
  });

  // Base consolidada para exportação em Excel (o navegador monta o .xlsx).
  r.get('/api/export', ({ user, query }) => {
    requireRole(user, 'NACIONAL', 'REGIONAL', 'VISUALIZADOR');
    const f = leadFilters(user, query);
    return q.all(`
      SELECT i.label AS base, l.row_number, l.client_name, l.client_doc, coalesce(r.name, 'Sem regional') AS region,
             l.branch, l.machine, l.quantity, l.amount, l.loss_reason, l.origin_manager, l.origin_seller, l.contact_name,
             l.phone, l.email, l.city, l.state, l.opportunity_date, u.name AS executive, l.first_base, l.origin_return,
             l.bought_competitor, l.contact_status, l.contact_summary, l.completed_at, l.updated_at
      FROM leads l
      LEFT JOIN regions r ON r.id = l.region_id
      LEFT JOIN users u ON u.id = l.executive_id
      LEFT JOIN imports i ON i.id = l.import_id
      WHERE ${f.sql} ORDER BY region, l.amount DESC`, ...f.params);
  });
}
