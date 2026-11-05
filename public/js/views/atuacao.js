// Atuação da equipe: o gerente vê se cada executivo está trabalhando a carteira.
import { h, clear, api, fmt, modal, emptyState, badge } from '../lib.js';

const DAY = 86400000;

function daysSince(iso) {
  return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null;
}

// Semáforo da atuação: baseado na última resposta registrada pelo executivo.
function activityBadge(e) {
  if (!e.leads) return badge('Sem clientes', 'muted');
  const d = daysSince(e.last_action);
  if (d === null) return badge('Nunca atuou no sistema', 'bad');
  if (d <= 3) return badge('Ativo', 'good');
  if (d <= 7) return badge(`Parado há ${d} dias`, 'warn');
  return badge(`Parado há ${d} dias`, 'bad');
}

export async function renderActivity(main) {
  const body = h('div', {});
  clear(main,
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, 'Atuação da equipe'),
      h('p', { class: 'muted' }, 'Veja se cada executivo está trabalhando a carteira. "Atuou" = o próprio executivo registrou resposta no sistema (pelo site ou enviando a planilha). Clique no nome para ver tudo o que ele fez.'))),
    body);

  const rows = await api.get('/api/activity');
  if (!rows.length) { clear(body, emptyState('Nenhum executivo na sua equipe.')); return; }

  const total = rows.reduce((a, e) => ({
    leads: a.leads + e.leads, touched: a.touched + e.touched, untouched: a.untouched + e.untouched,
    stale: a.stale + (e.leads && (daysSince(e.last_action) ?? 999) > 7 ? 1 : 0),
  }), { leads: 0, touched: 0, untouched: 0, stale: 0 });

  const kpi = (label, value, sub, kind = '') => h('div', { class: `kpi kpi-sm ${kind}` },
    h('span', { class: 'kpi-label' }, label), h('strong', { class: 'kpi-value' }, value), sub ? h('small', {}, sub) : null);

  clear(body,
    h('div', { class: 'kpi-row kpi-row-compact' },
      kpi('Clientes atribuídos', fmt.int(total.leads), `${rows.length} executivos`),
      kpi('Clientes já trabalhados', fmt.pct(total.touched, total.leads), `${fmt.int(total.touched)} clientes`),
      kpi('Clientes nunca tocados', fmt.int(total.untouched), fmt.pct(total.untouched, total.leads), total.untouched ? 'kpi-attention' : ''),
      kpi('Executivos parados há +7 dias', fmt.int(total.stale), 'sem registrar nada', total.stale ? 'kpi-attention' : '')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        ['Executivo', 'Situação', 'Clientes', 'Trabalhados', 'Nunca tocados', 'Concluídos', 'Atualizações 7 dias', 'Atualizações 30 dias', 'Última atuação', 'Último acesso']
          .map((t, i) => h('th', { class: i >= 2 && i <= 7 ? 'num' : '' }, t)))),
      h('tbody', {}, rows.map(e => h('tr', { class: 'clickable', onclick: () => showTimeline(e) },
        h('td', {}, h('strong', {}, e.name), h('small', { class: 'muted block' }, e.region_name || ''), e.active ? null : badge('Inativo', 'muted')),
        h('td', {}, activityBadge(e)),
        h('td', { class: 'num' }, fmt.int(e.leads)),
        h('td', { class: 'num' }, h('span', { class: 'inline-meter' },
          h('span', { class: 'meter' }, h('span', { style: { width: `${e.leads ? (100 * e.touched) / e.leads : 0}%` } })),
          fmt.pct(e.touched, e.leads))),
        h('td', { class: 'num' }, e.untouched ? h('strong', {}, fmt.int(e.untouched)) : '0'),
        h('td', { class: 'num' }, fmt.pct(e.completed, e.leads)),
        h('td', { class: 'num' }, `${fmt.int(e.changes_7d)}`, e.leads_7d ? h('small', { class: 'muted block' }, `${fmt.int(e.leads_7d)} clientes`) : null),
        h('td', { class: 'num' }, fmt.int(e.changes_30d)),
        h('td', {}, e.last_action ? fmt.datetime(e.last_action) : h('span', { class: 'muted' }, 'nunca')),
        h('td', {}, e.last_login_at ? fmt.datetime(e.last_login_at)
          : h('span', { class: 'muted' }, e.must_change_password ? 'nunca entrou' : '—'))))))),
    h('p', { class: 'muted table-note' }, 'Dica: na Carteira, o filtro Situação → "Sem atuação do vendedor" lista os clientes que o executivo ainda não tocou.'));

  async function showTimeline(e) {
    const content = h('div', {}, emptyState('Carregando…'));
    modal({ title: `O que ${e.name} fez`, wide: true, body: content });
    try {
      const { events } = await api.get(`/api/activity/${e.id}`);
      if (!events.length) { clear(content, emptyState('Nenhum registro deste executivo no sistema ainda.')); return; }
      // Agrupa por dia para ficar fácil de ler.
      const byDay = new Map();
      for (const ev of events) {
        const day = fmt.date(ev.created_at);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(ev);
      }
      clear(content,
        h('p', { class: 'muted' }, `Últimos ${events.length} registros.`),
        [...byDay].map(([day, list]) => h('div', { class: 'timeline-day' },
          h('h3', {}, day, h('small', { class: 'muted' }, ` · ${list.length} registro(s)`)),
          h('ul', { class: 'timeline' }, list.map(ev => h('li', {},
            h('small', { class: 'muted' }, new Date(ev.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })),
            h('div', {}, h('strong', {}, ev.client_name), ev.machine ? h('span', { class: 'muted' }, ` · ${ev.machine}`) : null),
            h('div', {}, `${ev.action}${ev.field && !['region_id', 'executive_id', 'import_id'].includes(ev.field) ? ` — ${ev.field}` : ''}: `,
              h('span', { class: 'muted' }, ev.old_value ?? '∅'), ' → ', h('strong', {}, ev.new_value ?? '∅'))))))));
    } catch (err) {
      clear(content, emptyState(err.message));
    }
  }
}
