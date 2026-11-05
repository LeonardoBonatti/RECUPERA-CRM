// Módulo 1 (entrada e roteamento) e Módulo 2 (área de trabalho do executivo).
import { q, transaction, logHistory } from '../db.js';
import { fail, toInt } from '../http.js';
import { requireRole, USER_REGION_COLUMNS } from '../auth.js';
import { leadScope, leadFilters } from '../scope.js';
import { QUALIFICATION_FIELDS, optionValues, isComplete, statusStage } from '../fields.js';
import {
  normKey, cleanText, parseMoney, parseQuantity, parseDate, matchOption, clientKey, digits, opportunityKey,
} from '../normalize.js';
import { createNameMatcher } from '../match.js';

// A Vercel limita o corpo da requisição a 4,5 MB: o navegador envia a planilha em lotes.
const MAX_ROWS_PER_BATCH = 500;

const LIST_COLUMNS = `
  l.id, l.import_id, l.row_number, l.client_name, l.client_doc, l.region_label, l.branch, l.region_id,
  l.machine, l.quantity, l.amount, l.loss_reason, l.origin_manager, l.origin_seller, l.contact_name, l.phone, l.email,
  l.city, l.state, l.opportunity_date, l.in_previous_base, l.executive_id, l.assigned_at,
  l.first_base, l.origin_return, l.bought_competitor, l.contact_status, l.contact_summary,
  l.completed_at, l.updated_at, l.manager_id, l.partner_manager_label, l.partner_executive_label,
  r.name AS region_name, u.name AS executive_name, u.active AS executive_active, i.label AS import_label,
  m.name AS manager_name, ub.name AS updated_by_name`;

const LIST_FROM = `
  FROM leads l
  LEFT JOIN regions r ON r.id = l.region_id
  LEFT JOIN users u ON u.id = l.executive_id
  LEFT JOIN users m ON m.id = l.manager_id
  LEFT JOIN users ub ON ub.id = l.updated_by
  LEFT JOIN imports i ON i.id = l.import_id`;

const INSERT_COLUMNS = [
  'import_id', 'row_number', 'client_name', 'client_doc', 'client_key', 'region_label', 'branch', 'region_id',
  'machine', 'quantity', 'amount', 'loss_reason', 'origin_manager', 'origin_seller', 'contact_name', 'phone',
  'email', 'city', 'state', 'opportunity_date', 'raw_data', 'legacy_values', 'in_previous_base',
  'first_base', 'origin_return', 'bought_competitor', 'contact_status', 'contact_summary', 'completed_at',
  'executive_id', 'manager_id', 'assigned_at', 'partner_manager_label', 'partner_executive_label', 'dedup_key',
];

// Oportunidades que já existem no sistema, pela impressão digital.
async function existingByKey(keys) {
  if (!keys.length) return new Map();
  const rows = await q.all(`
    SELECT DISTINCT ON (l.dedup_key) l.dedup_key, l.id, l.client_name, l.import_id, i.label AS import_label,
           u.name AS executive_name, l.updated_by,
           l.first_base, l.origin_return, l.bought_competitor, l.contact_status, l.contact_summary
    FROM leads l LEFT JOIN imports i ON i.id = l.import_id LEFT JOIN users u ON u.id = l.executive_id
    WHERE l.dedup_key = ANY(?::text[])
    ORDER BY l.dedup_key, l.id`, keys);
  return new Map(rows.map(r => [r.dedup_key, r]));
}

// Quão avançada está a resposta de uma cópia: status final > em andamento > tentando > vazio,
// e, no empate, quantos campos estão preenchidos.
const STAGE_RANK = { ganho: 5, perdido: 4, encerrado: 4, andamento: 3, tentativa: 2 };
function answerScore(p) {
  const filled = QUALIFICATION_FIELDS.filter(f => p[f.key]).length;
  return (STAGE_RANK[statusStage(p.contact_status)] || 0) * 10 + filled;
}
function pickAnswers(p) {
  const out = Object.fromEntries(QUALIFICATION_FIELDS.map(f => [f.key, p[f.key] ?? null]));
  return { ...out, complete: isComplete(out) };
}
function answersText(p) {
  const parts = [];
  if (p.contact_status) parts.push(`Status: ${p.contact_status}`);
  if (p.origin_return) parts.push(`Retorno: ${p.origin_return}`);
  if (p.bought_competitor) parts.push(`Comprou concorrente: ${p.bought_competitor}`);
  if (p.contact_summary) parts.push(`Resumo: ${p.contact_summary}`);
  return parts.length ? parts.join(' · ') : 'cópia sem respostas';
}

// No histórico da oportunidade original: "reapareceu em nova base: Novembro/26".
function markReappeared(db, leadIds, userId, importId) {
  return db.run(`
    INSERT INTO lead_history (lead_id, user_id, action, field, new_value)
    SELECT unnest(?::int[]), ?::int, 'reapareceu em nova base', 'import_id', (SELECT label FROM imports WHERE id = ?::int)`,
  leadIds, userId, importId);
}

// Equipe ativa com regionais, para distribuir pelos nomes da planilha.
async function loadTeam() {
  const users = await q.all(`
    SELECT u.id, u.name, u.role, u.region_id, u.aliases, ${USER_REGION_COLUMNS}
    FROM users u LEFT JOIN regions r ON r.id = u.region_id
    WHERE u.active AND u.role IN ('REGIONAL', 'EXECUTIVO')`);
  const executives = users.filter(u => u.role === 'EXECUTIVO');
  const managers = users.filter(u => u.role === 'REGIONAL');
  return {
    matchExecutive: createNameMatcher(executives),
    matchManager: createNameMatcher(managers),
    // Gerente "natural" de um executivo: o regional que cuida da regional dele.
    managerOf: exec => managers.find(m => (m.region_ids || []).includes(exec.region_id)) ?? null,
  };
}

// Respostas que já vieram na planilha: só entram se baterem com a lista fechada.
// As demais ficam em `legacy` para orientar o executivo a reclassificar.
function qualification(values) {
  const out = {};
  const legacy = {};
  for (const f of QUALIFICATION_FIELDS) {
    if (f.type === 'text') { out[f.key] = cleanText(values[f.key], f.maxLength); continue; }
    out[f.key] = matchOption(values[f.key], optionValues(f)) ?? f.aliases?.[normKey(values[f.key])] ?? null;
    const original = cleanText(values[f.key], 120);
    if (!out[f.key] && original) legacy[f.key] = original;
  }
  return { out, legacy: Object.keys(legacy).length ? JSON.stringify(legacy) : null };
}

export function registerLeadRoutes(r) {
  // ---------- Importação: 1) cria a base ----------
  r.post('/api/imports', async ({ user, json }) => {
    requireRole(user, 'NACIONAL');
    const body = await json();
    const label = cleanText(body.label, 120) || cleanText(body.fileName, 120) || 'Base sem nome';
    const row = await q.get('INSERT INTO imports (label, file_name, uploaded_by) VALUES (?, ?, ?) RETURNING id',
      label, cleanText(body.fileName, 200), user.id);
    return { importId: row.id, label };
  });

  // ---------- Importação: 2) envia um lote de linhas e roteia automaticamente ----------
  r.post('/api/imports/:id/rows', async ({ user, params, json }) => {
    requireRole(user, 'NACIONAL');
    const importId = toInt(params.id);
    const body = await json();
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows || !rows.length) fail(400, 'Lote sem linhas.');
    if (rows.length > MAX_ROWS_PER_BATCH) fail(400, `Envie no máximo ${MAX_ROWS_PER_BATCH} linhas por lote.`);
    if (!(await q.get('SELECT id FROM imports WHERE id = ?', importId))) fail(404, 'Base não encontrada.');
    const defaultRegionId = toInt(body.defaultRegionId);

    const [regions, branchRows] = await Promise.all([
      q.all('SELECT id, name FROM regions WHERE active'),
      q.all('SELECT name_key, region_id FROM branches'),
    ]);
    const regionByKey = new Map(regions.map(x => [normKey(x.name), x.id]));
    const regionName = new Map(regions.map(x => [x.id, x.name]));
    const branchByKey = new Map(branchRows.map(x => [x.name_key, x.region_id]));
    if (defaultRegionId && !regionName.has(defaultRegionId)) fail(400, 'Regional padrão inválida.');

    // Prioridade: filial cadastrada no mapa (configuração explícita, permite regionais da parceira
    // diferentes das da distribuidora) → coluna Regional → filial com nome de regional → padrão.
    const resolveRegion = (regionLabel, branch) => {
      const bk = normKey(branch);
      if (bk && branchByKey.has(bk)) return branchByKey.get(bk);
      const rk = normKey(regionLabel);
      if (rk && regionByKey.has(rk)) return regionByKey.get(rk);
      if (bk && regionByKey.has(bk)) return regionByKey.get(bk);
      return defaultRegionId || null;
    };

    const team = await loadTeam();
    const now = new Date().toISOString();
    const unmatched = { executives: {}, managers: {} };
    const byExecutive = new Map();

    let skipped = 0;
    const prepared = [];
    rows.forEach((row, index) => {
      const v = row && typeof row.values === 'object' && row.values ? row.values : {};
      const name = cleanText(v.client_name, 200);
      if (!name) { skipped += 1; return; }
      const doc = cleanText(v.client_doc, 30);
      const regionLabel = cleanText(v.region_label, 80);
      const branch = cleanText(v.branch, 120);
      const { out: qual, legacy } = qualification(v);

      // Distribuição pelas colunas de gerente e vendedor da parceira.
      const execLabel = cleanText(v.partner_executive, 120);
      const managerLabel = cleanText(v.partner_manager, 120);
      const exec = execLabel ? team.matchExecutive(execLabel) : null;
      const manager = (managerLabel ? team.matchManager(managerLabel) : null) ?? (exec ? team.managerOf(exec) : null);
      prepared.push({
        // Campos "_" só alimentam o resumo; não vão para o banco.
        _exec_name: exec?.name ?? null,
        _exec_unmatched: execLabel && !exec ? execLabel : null,
        _mgr_unmatched: managerLabel && !team.matchManager(managerLabel) ? managerLabel : null,
        dedup_key: opportunityKey({
          client_name: name, client_doc: doc, machine: v.machine, quantity: v.quantity, amount: v.amount, branch,
        }),
        executive_id: exec?.id ?? null, manager_id: manager?.id ?? null, assigned_at: exec ? now : null,
        partner_manager_label: managerLabel, partner_executive_label: execLabel,
        import_id: importId, row_number: toInt(row.row_number) ?? index + 1, client_name: name, client_doc: doc,
        client_key: clientKey(name, doc), region_label: regionLabel, branch, region_id: resolveRegion(regionLabel, branch),
        machine: cleanText(v.machine, 200), quantity: parseQuantity(v.quantity), amount: parseMoney(v.amount),
        loss_reason: cleanText(v.loss_reason, 200), origin_manager: cleanText(v.origin_manager, 120),
        origin_seller: cleanText(v.origin_seller, 120), contact_name: cleanText(v.contact_name, 120),
        phone: cleanText(v.phone, 60), email: cleanText(v.email, 160), city: cleanText(v.city, 80),
        state: cleanText(v.state, 30), opportunity_date: parseDate(v.opportunity_date),
        raw_data: JSON.stringify(row.raw ?? v), legacy_values: legacy, in_previous_base: false,
        ...qual, completed_at: isComplete(qual) ? new Date().toISOString() : null,
      });
    });
    // Duplicidade (mesma impressão digital):
    // - repetida neste lote: fica a cópia com a resposta mais avançada;
    // - já existe de outra base: a original fica (com o trabalho do vendedor) e ganha no histórico
    //   "reapareceu em nova base";
    // - já existe deste mesmo upload (lote anterior): se a cópia nova tem resposta mais avançada e
    //   ninguém mexeu ainda na original, a original recebe essas respostas.
    // As respostas das cópias descartadas vão para o histórico da que ficou — nada se perde.
    const skipDuplicates = body.skipDuplicates !== false;
    let duplicates = 0;
    const reappeared = new Map();
    const dupNotes = []; // { leadId | key, text }
    const upgrades = []; // leads deste upload que recebem respostas melhores
    if (skipDuplicates) {
      const groups = new Map();
      for (const p of prepared) {
        if (groups.has(p.dedup_key)) groups.get(p.dedup_key).push(p);
        else groups.set(p.dedup_key, [p]);
      }
      const existing = await existingByKey([...groups.keys()]);
      const kept = [];
      for (const [key, list] of groups) {
        const best = list.reduce((a, b) => (answerScore(b) > answerScore(a) ? b : a));
        const found = existing.get(key);
        if (found) {
          duplicates += list.length;
          if (found.import_id !== importId) reappeared.set(found.id, true);
          else if (!found.updated_by && answerScore(best) > answerScore(found)) upgrades.push({ id: found.id, ...pickAnswers(best) });
          for (const p of list) dupNotes.push({ leadId: found.id, text: answersText(p) });
        } else {
          kept.push(best);
          for (const p of list) if (p !== best) { duplicates += 1; dupNotes.push({ key, text: answersText(p) }); }
        }
      }
      prepared.length = 0;
      prepared.push(...kept);
    }

    for (const p of prepared) {
      if (p._exec_name) byExecutive.set(p._exec_name, (byExecutive.get(p._exec_name) || 0) + 1);
      if (p._exec_unmatched) unmatched.executives[p._exec_unmatched] = (unmatched.executives[p._exec_unmatched] || 0) + 1;
      if (p._mgr_unmatched) unmatched.managers[p._mgr_unmatched] = (unmatched.managers[p._mgr_unmatched] || 0) + 1;
    }

    // Cliente que já apareceu em outra base importada antes.
    if (prepared.length) {
      const keys = [...new Set(prepared.map(p => p.client_key))];
      const previous = new Set((await q.all(
        'SELECT DISTINCT client_key FROM leads WHERE client_key = ANY(?) AND import_id <> ?', keys, importId,
      )).map(x => x.client_key));
      for (const p of prepared) p.in_previous_base = previous.has(p.client_key);
    }

    return transaction(async tx => {
      // Um único INSERT com várias linhas: poucas idas ao banco por lote.
      let inserted = [];
      if (prepared.length) {
        const placeholders = prepared.map(() => `(${INSERT_COLUMNS.map(() => '?').join(', ')})`).join(', ');
        const values = prepared.flatMap(p => INSERT_COLUMNS.map(c => p[c]));
        inserted = await tx.all(
          `INSERT INTO leads (${INSERT_COLUMNS.join(', ')}) VALUES ${placeholders}
           RETURNING id, region_id, executive_id, partner_executive_label, dedup_key`, ...values,
        );
      }
      if (upgrades.length) {
        await tx.run(`
          UPDATE leads l SET first_base = x.first_base, origin_return = x.origin_return,
            bought_competitor = x.bought_competitor, contact_status = x.contact_status, contact_summary = x.contact_summary,
            completed_at = CASE WHEN x.complete THEN coalesce(l.completed_at, now()) ELSE NULL END
          FROM jsonb_to_recordset(?::jsonb) AS x(id int, first_base text, origin_return text, bought_competitor text,
                                                contact_status text, contact_summary text, complete boolean)
          WHERE l.id = x.id AND l.updated_by IS NULL`, JSON.stringify(upgrades));
      }
      if (dupNotes.length) {
        const idByKey = new Map(inserted.map(x => [x.dedup_key, x.id]));
        const notes = dupNotes
          .map(n => ({ lead_id: n.leadId ?? idByKey.get(n.key), text: n.text }))
          .filter(n => n.lead_id);
        await tx.run(`
          INSERT INTO lead_history (lead_id, user_id, action, field, new_value)
          SELECT x.lead_id, ?::int, 'cópia duplicada na importação', 'duplicidade', x.text
          FROM jsonb_to_recordset(?::jsonb) AS x(lead_id int, text text)`, user.id, JSON.stringify(notes));
      }
      if (!inserted.length) {
        if (reappeared.size) await markReappeared(tx, [...reappeared.keys()], user.id, importId);
        return { inserted: 0, skipped, duplicates, unrouted: 0, assigned: 0, byRegion: [], byExecutive: [], unmatched };
      }
      await tx.run(`
        INSERT INTO lead_history (lead_id, user_id, action, field, new_value)
        SELECT unnest(?::int[]), ?::int, 'importado', 'region_id', unnest(?::text[])`,
      inserted.map(x => x.id), user.id, inserted.map(x => (x.region_id ? regionName.get(x.region_id) : null)));
      const assigned = inserted.filter(x => x.executive_id);
      if (assigned.length) {
        await tx.run(`
          INSERT INTO lead_history (lead_id, user_id, action, field, new_value)
          SELECT unnest(?::int[]), ?::int, 'atribuído pela planilha', 'executive_id', unnest(?::text[])`,
        assigned.map(x => x.id), user.id, assigned.map(x => x.partner_executive_label));
      }
      await tx.run('UPDATE imports SET total_rows = total_rows + ? WHERE id = ?', inserted.length, importId);
      if (reappeared.size) await markReappeared(tx, [...reappeared.keys()], user.id, importId);

      const byRegion = new Map();
      for (const x of inserted) {
        const rn = x.region_id ? regionName.get(x.region_id) : 'Sem regional';
        byRegion.set(rn, (byRegion.get(rn) || 0) + 1);
      }
      return {
        inserted: inserted.length, skipped, duplicates,
        unrouted: inserted.filter(x => !x.region_id).length,
        assigned: assigned.length,
        byRegion: [...byRegion].map(([name, count]) => ({ name, count })),
        byExecutive: [...byExecutive].map(([name, count]) => ({ name, count })),
        unmatched,
      };
    });
  });

  // Prévia da importação: quais linhas já existem no sistema (mesma impressão digital).
  r.post('/api/imports/check-duplicates', async ({ user, json }) => {
    requireRole(user, 'NACIONAL');
    const { rows } = await json();
    if (!Array.isArray(rows) || !rows.length) fail(400, 'Sem linhas para verificar.');
    if (rows.length > 1000) fail(400, 'Verifique no máximo 1.000 linhas por vez.');
    const keys = rows.map(v => opportunityKey({
      client_name: cleanText(v?.client_name, 200), client_doc: cleanText(v?.client_doc, 30),
      machine: v?.machine, quantity: v?.quantity, amount: v?.amount, branch: cleanText(v?.branch, 120),
    }));
    const existing = await existingByKey([...new Set(keys)]);
    return {
      results: keys.map(key => {
        const e = existing.get(key);
        return { key, existing: e ? { lead_id: e.id, import_label: e.import_label, executive_name: e.executive_name, status: e.contact_status } : null };
      }),
    };
  });

  r.get('/api/imports', ({ user }) => {
    requireRole(user);
    const scope = leadScope(user);
    return q.all(`
      SELECT i.id, i.label, i.file_name, i.created_at, i.total_rows, u.name AS uploaded_by_name,
        count(l.id) AS leads,
        count(l.id) FILTER (WHERE l.region_id IS NULL) AS unrouted,
        count(l.id) FILTER (WHERE l.executive_id IS NOT NULL) AS assigned,
        count(l.id) FILTER (WHERE l.completed_at IS NOT NULL) AS completed
      FROM imports i
      LEFT JOIN users u ON u.id = i.uploaded_by
      LEFT JOIN leads l ON l.import_id = i.id AND ${scope.sql}
      GROUP BY i.id, u.name ORDER BY i.id DESC`, ...scope.params);
  });

  r.del('/api/imports/:id', async ({ user, params }) => {
    requireRole(user, 'NACIONAL');
    const id = toInt(params.id);
    if (!(await q.get('SELECT id FROM imports WHERE id = ?', id))) fail(404, 'Base não encontrada.');
    const { n: worked } = await q.get('SELECT count(*) AS n FROM leads WHERE import_id = ? AND updated_by IS NOT NULL', id);
    if (worked > 0) fail(409, `Esta base já tem ${worked} lead(s) trabalhados pelos executivos e não pode ser excluída.`);
    await q.run('DELETE FROM imports WHERE id = ?', id);
    return { ok: true };
  });

  // ---------- Carteira / listagem ----------
  r.get('/api/leads', ({ user, query }) => {
    requireRole(user);
    const f = leadFilters(user, query);
    const where = [f.sql];
    const params = [...f.params];
    const executiveId = toInt(query.get('executive_id'));
    if (executiveId) { where.push('l.executive_id = ?'); params.push(executiveId); }
    switch (query.get('status')) {
      case 'unassigned': where.push('l.executive_id IS NULL AND l.region_id IS NOT NULL'); break;
      case 'assigned': where.push('l.executive_id IS NOT NULL'); break;
      case 'pending': where.push('l.completed_at IS NULL'); break;
      case 'done': where.push('l.completed_at IS NOT NULL'); break;
      // Atribuído, mas o vendedor nunca registrou nada nele no sistema.
      case 'untouched':
        where.push('l.executive_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lead_history h WHERE h.lead_id = l.id AND h.user_id = l.executive_id)');
        break;
    }
    const text = String(query.get('q') || '').trim().slice(0, 80);
    if (text) {
      where.push(`(l.client_name ILIKE ? OR l.client_doc ILIKE ? OR l.machine ILIKE ? OR l.branch ILIKE ?)`);
      const like = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(like, like, like, like);
    }
    return q.all(`SELECT ${LIST_COLUMNS} ${LIST_FROM} WHERE ${where.join(' AND ')}
                  ORDER BY l.completed_at IS NOT NULL, l.amount DESC LIMIT 10000`, ...params);
  });

  r.get('/api/leads/:id', async ({ user, params }) => {
    requireRole(user);
    const scope = leadScope(user);
    const lead = await q.get(`SELECT ${LIST_COLUMNS}, l.raw_data, l.legacy_values ${LIST_FROM} WHERE l.id = ? AND ${scope.sql}`,
      toInt(params.id), ...scope.params);
    if (!lead) fail(404, 'Lead não encontrado.');
    lead.legacy_values ??= {};
    lead.history = await q.all(`
      SELECT h.action, h.field, h.old_value, h.new_value, h.created_at, u.name AS user_name
      FROM lead_history h LEFT JOIN users u ON u.id = h.user_id
      WHERE h.lead_id = ? ORDER BY h.id DESC LIMIT 100`, lead.id);
    return lead;
  });

  // ---------- Roteamento manual (Nacional) / devolução (Regional) ----------
  r.post('/api/leads/route', async ({ user, json }) => {
    requireRole(user, 'NACIONAL', 'REGIONAL');
    const body = await json();
    const ids = idList(body.leadIds);
    const regionId = toInt(body.regionId);
    if (user.role === 'REGIONAL' && regionId !== null) fail(403, 'O gerente regional só pode devolver leads ao Nacional.');
    const region = regionId ? await q.get('SELECT id, name FROM regions WHERE id = ?', regionId) : null;
    if (regionId && !region) fail(400, 'Regional inválida.');
    const scope = leadScope(user);

    // Ao mudar de regional a atribuição anterior perde validade.
    const res = await q.run(`
      WITH target AS (
        SELECT l.id, r.name AS old_region FROM leads l LEFT JOIN regions r ON r.id = l.region_id
        WHERE l.id = ANY(?) AND ${scope.sql} AND l.region_id IS DISTINCT FROM ?::int
        FOR UPDATE OF l
      ), upd AS (
        UPDATE leads l SET region_id = ?::int, executive_id = NULL, assigned_at = NULL, manager_id = NULL
        FROM target t WHERE l.id = t.id RETURNING l.id, t.old_region
      )
      INSERT INTO lead_history (lead_id, user_id, action, field, old_value, new_value)
      SELECT id, ?::int, ?::text, 'region_id', old_region, ?::text FROM upd`,
    ids, ...scope.params, regionId, regionId, user.id, regionId ? 'roteado' : 'devolvido ao nacional', region?.name ?? null);
    return { changed: res.rowCount };
  });

  // ---------- Atribuição ao executivo ----------
  r.post('/api/leads/assign', async ({ user, json }) => {
    requireRole(user, 'NACIONAL', 'REGIONAL');
    const body = await json();
    const ids = idList(body.leadIds);
    const executiveId = toInt(body.executiveId);
    const exec = executiveId
      ? await q.get(`SELECT id, name, region_id FROM users WHERE id = ? AND role = 'EXECUTIVO' AND active`, executiveId)
      : null;
    if (executiveId && !exec) fail(400, 'Executivo inválido ou inativo.');
    if (exec && user.role === 'REGIONAL' && !user.region_ids.includes(exec.region_id)) fail(403, 'Executivo de outra regional.');
    const scope = leadScope(user);

    // A parceira atende fora da regional da distribuidora (um gerente pode cuidar de leads de outra regional), então o
    // executivo pode receber lead de qualquer regional. O gerente do lead passa a ser quem
    // atribuiu (regional) ou o gerente do executivo (quando o Nacional atribui).
    let managerId = null;
    if (exec) {
      managerId = user.role === 'REGIONAL'
        ? user.id
        : (await loadTeam()).managerOf(exec)?.id ?? null;
    }

    const res = await q.run(`
      WITH target AS (
        SELECT l.id, u.name AS old_exec FROM leads l LEFT JOIN users u ON u.id = l.executive_id
        WHERE l.id = ANY(?) AND ${scope.sql}
          AND l.executive_id IS DISTINCT FROM ?::int
        FOR UPDATE OF l
      ), upd AS (
        UPDATE leads l SET executive_id = ?::int,
          assigned_at = CASE WHEN ?::int IS NULL THEN NULL ELSE now() END,
          manager_id = coalesce(?::int, l.manager_id)
        FROM target t WHERE l.id = t.id RETURNING l.id, t.old_exec
      )
      INSERT INTO lead_history (lead_id, user_id, action, field, old_value, new_value)
      SELECT id, ?::int, ?::text, 'executive_id', old_exec, ?::text FROM upd`,
    ids, ...scope.params, exec?.id ?? null, exec?.id ?? null, exec?.id ?? null, managerId,
    user.id, exec ? 'atribuído' : 'atribuição removida', exec?.name ?? null);
    return { changed: res.rowCount, skipped: 0 };
  });

  // ---------- Planilha preenchida pelo executivo ----------
  // Atualiza SOMENTE as 5 colunas de qualificação dos leads do próprio executivo.
  // Nunca cria leads: cada linha é localizada pelo ID (coluna gerada pelo sistema) ou, sem ID,
  // por CNPJ/CPF + equipamento quando houver um único lead assim na carteira dele.
  // Células em branco não apagam o que já está no sistema. dryRun = só mostra o que mudaria.
  r.post('/api/leads/sheet-update', async ({ user, json }) => {
    requireRole(user, 'EXECUTIVO');
    const body = await json();
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows || !rows.length) fail(400, 'A planilha não tem linhas.');
    if (rows.length > 3000) fail(400, 'Planilha grande demais (máx. 3.000 linhas).');

    const mine = await q.all(`
      SELECT id, client_name, client_doc, machine, completed_at,
             first_base, origin_return, bought_competitor, contact_status, contact_summary
      FROM leads WHERE executive_id = ?`, user.id);
    const byId = new Map(mine.map(l => [l.id, l]));
    const byDocMachine = new Map();
    for (const l of mine) {
      const k = `${digits(l.client_doc)}|${normKey(l.machine)}`;
      byDocMachine.set(k, byDocMachine.has(k) ? 'ambíguo' : l);
    }

    const report = { updated: 0, unchanged: 0, notFound: [], ambiguous: [], duplicated: [], invalid: [], changes: [] };
    const seen = new Set();
    const updates = [];

    for (const row of rows) {
      const line = toInt(row.row_number);
      const label = cleanText(row.client_name, 120) || '(sem nome)';
      let lead = null;
      const id = toInt(row.id);
      if (id) lead = byId.get(id) ?? null;
      if (!lead && !id) {
        const found = byDocMachine.get(`${digits(row.client_doc)}|${normKey(row.machine)}`);
        if (found === 'ambíguo') { report.ambiguous.push({ line, client: label }); continue; }
        lead = found ?? null;
      }
      if (!lead) { report.notFound.push({ line, client: label }); continue; }
      if (seen.has(lead.id)) { report.duplicated.push({ line, client: lead.client_name }); continue; }
      seen.add(lead.id);

      const next = {};
      const values = row.values && typeof row.values === 'object' ? row.values : {};
      for (const f of QUALIFICATION_FIELDS) {
        const raw = values[f.key];
        const text = cleanText(raw, f.type === 'text' ? f.maxLength : 200);
        if (!text) { next[f.key] = lead[f.key]; continue; } // em branco: mantém o valor atual
        if (f.type === 'text') { next[f.key] = text; continue; }
        const option = matchOption(text, optionValues(f)) ?? f.aliases?.[normKey(text)] ?? null;
        if (!option) {
          report.invalid.push({ line, client: lead.client_name, field: f.label, value: text });
          next[f.key] = lead[f.key];
        } else next[f.key] = option;
      }

      const changed = QUALIFICATION_FIELDS.filter(f => (lead[f.key] ?? null) !== (next[f.key] ?? null));
      if (!changed.length) { report.unchanged += 1; continue; }
      const complete = isComplete(next);
      updates.push({ id: lead.id, ...next, complete });
      for (const f of changed) {
        report.changes.push({ lead_id: lead.id, client: lead.client_name, field: f.label, from: lead[f.key], to: next[f.key] });
      }
    }
    report.updated = updates.length;
    if (body.dryRun || !updates.length) return { ...report, dryRun: !!body.dryRun };

    await transaction(async tx => {
      // Dois comandos para todas as linhas: atualização em lote + histórico de cada campo alterado.
      await tx.run(`
        UPDATE leads l SET
          first_base = x.first_base, origin_return = x.origin_return, bought_competitor = x.bought_competitor,
          contact_status = x.contact_status, contact_summary = x.contact_summary,
          completed_at = CASE WHEN x.complete THEN coalesce(l.completed_at, now()) ELSE NULL END,
          updated_at = now(), updated_by = ?::int
        FROM jsonb_to_recordset(?::jsonb) AS x(id int, first_base text, origin_return text, bought_competitor text,
                                              contact_status text, contact_summary text, complete boolean)
        WHERE l.id = x.id AND l.executive_id = ?::int`,
      user.id, JSON.stringify(updates), user.id);
      await tx.run(`
        INSERT INTO lead_history (lead_id, user_id, action, field, old_value, new_value)
        SELECT x.lead_id, ?::int, 'qualificação (planilha)', x.field, x.from_value, x.to_value
        FROM jsonb_to_recordset(?::jsonb) AS x(lead_id int, field text, from_value text, to_value text)`,
      user.id, JSON.stringify(report.changes.map(c => ({ lead_id: c.lead_id, field: c.field, from_value: c.from, to_value: c.to }))));
    });
    return { ...report, dryRun: false };
  });

  // ---------- Qualificação pelo executivo (Regra de Ouro) ----------
  r.put('/api/leads/:id', async ({ user, params, json }) => {
    requireRole(user, 'EXECUTIVO');
    const body = await json();
    const id = toInt(params.id);

    const allowed = new Map(QUALIFICATION_FIELDS.map(f => [f.key, f]));
    const unknown = Object.keys(body).filter(k => !allowed.has(k));
    if (unknown.length) fail(400, `Campos não editáveis: ${unknown.join(', ')}.`);

    return transaction(async tx => {
      const lead = await tx.get('SELECT * FROM leads WHERE id = ? AND executive_id = ? FOR UPDATE', id, user.id);
      if (!lead) fail(404, 'Lead não encontrado na sua carteira.');

      const next = {};
      for (const [key, field] of allowed) {
        if (!(key in body)) { next[key] = lead[key]; continue; }
        const value = body[key];
        if (value === null || value === '') { next[key] = null; continue; }
        if (field.type === 'text') {
          if (typeof value !== 'string') fail(400, `${field.label}: valor inválido.`);
          if (value.length > field.maxLength) fail(400, `${field.label}: máximo de ${field.maxLength} caracteres.`);
          next[key] = value.trim() || null;
        } else {
          // Valores fora da lista fechada são recusados, mesmo que enviados direto pela API.
          if (!optionValues(field).includes(value)) fail(400, `${field.label}: selecione uma das opções permitidas.`);
          next[key] = value;
        }
      }

      for (const [key, field] of allowed) {
        if ((lead[key] ?? null) !== (next[key] ?? null)) {
          await logHistory(tx, id, user.id, 'qualificação', field.label, lead[key], next[key]);
        }
      }
      const complete = isComplete(next);
      await tx.run(`
        UPDATE leads SET first_base = ?, origin_return = ?, bought_competitor = ?, contact_status = ?, contact_summary = ?,
          completed_at = CASE WHEN ?::boolean THEN coalesce(completed_at, now()) ELSE NULL END,
          updated_at = now(), updated_by = ?
        WHERE id = ?`,
      next.first_base, next.origin_return, next.bought_competitor, next.contact_status, next.contact_summary,
      complete, user.id, id);
      return { ok: true, complete };
    });
  });
}

function idList(value) {
  if (!Array.isArray(value) || !value.length) fail(400, 'Selecione pelo menos um lead.');
  if (value.length > 10000) fail(400, 'Seleção grande demais.');
  const ids = value.map(toInt).filter(Boolean);
  if (!ids.length) fail(400, 'Seleção inválida.');
  return ids;
}
