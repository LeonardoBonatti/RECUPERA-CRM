// Módulo 3 — Dashboard de apresentação em tempo real.
import { h, clear, api, state, fmt, toast, select, emptyState } from '../lib.js';

const REFRESH_MS = 30_000;

export async function renderDashboard(main) {
  const role = state.user.role;
  const seesAll = role === 'NACIONAL' || role === 'VISUALIZADOR';
  // Gerentes da parceira atendem leads de várias regionais, então também filtram por regional.
  const canFilterRegion = seesAll || role === 'REGIONAL';
  const filterRegions = state.regions;
  const canExport = role !== 'EXECUTIVO';
  const imports = await api.get('/api/imports');
  const filters = { import_id: '', region_id: '' };
  let regionMetric = 'amount';
  let data = null;

  const stamp = h('span', { class: 'muted stamp' });
  const body = h('div', { class: 'dash' });

  clear(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, role === 'EXECUTIVO' ? 'Meus resultados' : 'Dashboard de recuperação'),
        h('p', { class: 'muted' }, 'Indicadores calculados em tempo real a partir do trabalho dos executivos.')),
      h('div', { class: 'head-actions no-print' },
        canExport ? h('button', { class: 'btn', onclick: exportExcel }, 'Exportar Excel') : null,
        h('button', { class: 'btn btn-ghost', onclick: () => window.print() }, 'Imprimir / PDF'))),
    h('div', { class: 'filters no-print' },
      h('label', {}, 'Base', select(imports.map(i => ({ value: i.id, label: i.label })),
        { placeholder: 'Todas as bases', onchange: e => { filters.import_id = e.target.value; load(); } })),
      canFilterRegion ? h('label', {}, 'Regional', select(filterRegions.map(r => ({ value: r.id, label: r.name })),
        { placeholder: 'Todas', onchange: e => { filters.region_id = e.target.value; load(); } })) : null,
      h('div', { class: 'grow' }),
      stamp),
    body);

  async function load() {
    try {
      data = await api.get('/api/dashboard', filters);
      render();
      stamp.textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')} · atualiza a cada 30 s`;
    } catch (err) {
      stamp.textContent = `Falha ao atualizar: ${err.message}`;
    }
  }

  function render() {
    const t = data.totals;
    if (!t.opportunities) { clear(body, emptyState('Nenhuma oportunidade no filtro selecionado.')); return; }
    const sections = [
      h('div', { class: 'kpi-row' },
        heroKpi('Clientes únicos', fmt.int(t.clients), `${fmt.int(t.opportunities)} oportunidades`),
        heroKpi('Total de máquinas', fmt.int(t.machines), `${fmt.num(t.machines / (t.clients || 1))} por cliente`),
        heroKpi('Valor em oportunidades', fmt.moneyShort(t.amount), fmt.money(t.amount)),
        heroKpi('Ticket médio por cliente', fmt.moneyShort(t.amount / (t.clients || 1)), 'valor ÷ clientes únicos')),
      h('div', { class: 'kpi-row' },
        meterKpi('Atribuídos a executivos', t.assigned, t.opportunities),
        meterKpi('Clientes contatados', t.contacted, t.opportunities),
        meterKpi('Tratativas concluídas', t.completed, t.opportunities),
        meterKpi('Consórcios fechados', t.won, t.opportunities, fmt.moneyShort(t.won_amount))),
      t.unrouted && role === 'NACIONAL'
        ? h('a', { class: 'alert', href: '#/carteira' }, `⚠ ${fmt.int(t.unrouted)} oportunidade(s) sem regional aguardando roteamento →`)
        : null,
      h('div', { class: 'grid-2' }, regionCard(), distributionCard('contact_status')),
      h('div', { class: 'grid-2' }, distributionCard('origin_return'), yesNoCard()),
      h('div', { class: 'grid-2' }, lossCard()),
      role !== 'EXECUTIVO' && data.byExecutive.length ? executiveCard() : null,
    ];
    clear(body, sections);
  }

  // ---------- Cards ----------
  function regionCard() {
    const metrics = { amount: ['Valor', fmt.moneyShort], clients: ['Clientes', fmt.int], machines: ['Máquinas', fmt.int] };
    const total = data.byRegion.reduce((s, r) => s + r[regionMetric], 0);
    const rows = [...data.byRegion].sort((a, b) => b[regionMetric] - a[regionMetric]);
    const [, format] = metrics[regionMetric];
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'Concentração da carteira por regional'),
        h('div', { class: 'segmented segmented-sm no-print', role: 'group', 'aria-label': 'Métrica' },
          Object.entries(metrics).map(([key, [label]]) => h('button', {
            class: regionMetric === key ? 'active' : '', 'aria-pressed': String(regionMetric === key),
            onclick: () => { regionMetric = key; render(); },
          }, label)))),
      barList(rows.map(r => ({
        name: r.name,
        value: r[regionMetric],
        label: `${fmt.pct(r[regionMetric], total)} · ${format(r[regionMetric])}`,
        tip: `${r.name}: ${fmt.int(r.clients)} clientes · ${fmt.int(r.machines)} máquinas · ${fmt.money(r.amount)}`,
      }))),
      h('table', { class: 'table table-compact' },
        h('thead', {}, h('tr', {}, ['Regional', 'Clientes', 'Máquinas', 'Valor', '% carteira', '% concluído']
          .map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h('tbody', {}, rows.map(r => h('tr', {},
          h('td', {}, r.name), h('td', { class: 'num' }, fmt.int(r.clients)), h('td', { class: 'num' }, fmt.int(r.machines)),
          h('td', { class: 'num' }, fmt.moneyShort(r.amount)), h('td', { class: 'num' }, fmt.pct(r.amount, data.totals.amount)),
          h('td', { class: 'num' }, fmt.pct(r.completed, r.opportunities)))))));
  }

  // Distribuição de um campo de dropdown, na ordem das opções (não por ranking).
  function distributionCard(key) {
    const field = state.meta.qualificationFields.find(f => f.key === key);
    const order = [...field.options.map(o => (typeof o === 'string' ? o : o.value)), 'Não preenchido'];
    const dist = data.qualification[key].rows;
    const total = dist.reduce((s, r) => s + r.count, 0);
    const rows = order.map(name => dist.find(r => r.name === name) || { name, count: 0, amount: 0 });
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, field.label)),
      barList(rows.map(r => ({
        name: r.name, value: r.count,
        label: `${fmt.int(r.count)} · ${fmt.pct(r.count, total)}`,
        tip: `${r.name}: ${fmt.int(r.count)} oportunidades · ${fmt.money(r.amount)}`,
      }))));
  }

  function yesNoCard() {
    const keys = state.meta.qualificationFields.filter(f => f.type === 'radio').map(f => f.key);
    const series = [['Sim', 'seg-1'], ['Não', 'seg-2'], ['Não sabe', 'seg-3'], ['Não preenchido', 'seg-empty']];
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Respostas dos executivos'),
        h('div', { class: 'legend' }, series.map(([name, cls]) => h('span', {}, h('i', { class: `swatch ${cls}` }), name)))),
      keys.map(key => {
        const q = data.qualification[key];
        const total = q.rows.reduce((s, r) => s + r.count, 0);
        return h('div', { class: 'stack-row' },
          h('div', { class: 'stack-label' }, q.label),
          h('div', { class: 'stack' }, series.map(([name, cls]) => {
            const n = q.rows.find(r => r.name === name)?.count || 0;
            if (!n) return null;
            const share = (100 * n) / (total || 1);
            return h('span', {
              class: `stack-seg ${cls}`, style: { flexGrow: String(n) },
              'data-tip': `${q.label} — ${name}: ${fmt.int(n)} (${fmt.pct(n, total)})`,
            }, share >= 12 ? fmt.pct(n, total) : '');
          })));
      }));
  }

  function lossCard() {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Motivos da perda (por valor)')),
      barList(data.lossReasons.map(r => ({
        name: r.name, value: r.amount,
        label: `${fmt.moneyShort(r.amount)} · ${fmt.int(r.count)}`,
        tip: `${r.name}: ${fmt.int(r.count)} oportunidades · ${fmt.money(r.amount)}`,
      }))));
  }

  function executiveCard() {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Desempenho por executivo')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table table-compact' },
        h('thead', {}, h('tr', {}, ['Executivo', 'Regional', 'Leads', 'Contatados', 'Concluídos', 'Valor em carteira']
          .map((x, i) => h('th', { class: i >= 2 ? 'num' : '' }, x)))),
        h('tbody', {}, data.byExecutive.map(e => h('tr', {},
          h('td', {}, e.name), h('td', {}, e.region_name || '—'), h('td', { class: 'num' }, fmt.int(e.leads)),
          h('td', { class: 'num' }, fmt.pct(e.contacted, e.leads)),
          h('td', { class: 'num' }, h('span', { class: 'inline-meter' },
            h('span', { class: 'meter' }, h('span', { style: { width: `${(100 * e.completed) / (e.leads || 1)}%` } })),
            fmt.pct(e.completed, e.leads))),
          h('td', { class: 'num' }, fmt.moneyShort(e.amount))))))));
  }

  // ---------- Exportação ----------
  async function exportExcel() {
    if (!window.XLSX) { toast('A biblioteca de Excel não carregou (veja o README).', 'error'); return; }
    try {
      const rows = await api.get('/api/export', filters);
      const XLSX = window.XLSX;
      const wb = XLSX.utils.book_new();
      const t = data.totals;
      const resumo = [
        ['Indicador', 'Valor'],
        ['Clientes únicos', t.clients], ['Oportunidades', t.opportunities], ['Total de máquinas', t.machines],
        ['Valor total em oportunidades (R$)', t.amount], ['Contatados', t.contacted], ['Concluídos', t.completed],
        ['Consórcios fechados', t.won], ['Valor dos consórcios fechados (R$)', t.won_amount],
        [], ['Regional', 'Clientes', 'Máquinas', 'Valor (R$)', '% da carteira (valor)'],
        ...data.byRegion.map(r => [r.name, r.clients, r.machines, r.amount, t.amount ? r.amount / t.amount : 0]),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumo), 'Resumo');
      const headers = {
        base: 'Base', row_number: 'Linha planilha', client_name: 'Cliente', client_doc: 'CNPJ/CPF', region: 'Regional',
        branch: 'Filial', machine: 'Equipamento', quantity: 'Qtd', amount: 'Valor total (R$)', loss_reason: 'Motivo da perda',
        origin_manager: 'Gestor da distribuidora', origin_seller: 'Vendedor da distribuidora', contact_name: 'Contato', phone: 'Telefone', email: 'E-mail', city: 'Cidade',
        state: 'UF', opportunity_date: 'Data', executive: 'Executivo', first_base: 'Estava na primeira base?',
        origin_return: 'Retorno Comercial', bought_competitor: 'Comprou Concorrente',
        contact_status: 'Status do Contato', contact_summary: 'Resumo do Contato', completed_at: 'Concluído em',
        updated_at: 'Última atualização',
      };
      const sheet = rows.map(r => Object.fromEntries(Object.entries(headers).map(([k, label]) => [label, r[k] ?? ''])));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'Base consolidada');
      XLSX.writeFile(wb, `recupera-crm-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  await load();
  const timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  return () => clearInterval(timer);
}

// ---------- Primitivas visuais ----------
function heroKpi(label, value, sub) {
  return h('div', { class: 'kpi' },
    h('span', { class: 'kpi-label' }, label),
    h('strong', { class: 'kpi-value' }, value),
    h('small', {}, sub));
}

function meterKpi(label, part, total, extra) {
  const pct = total ? (100 * part) / total : 0;
  return h('div', { class: 'kpi kpi-sm' },
    h('span', { class: 'kpi-label' }, label),
    h('strong', { class: 'kpi-value' }, fmt.pct(part, total)),
    h('span', { class: 'meter', role: 'img', 'aria-label': `${fmt.pct(part, total)}` }, h('span', { style: { width: `${pct}%` } })),
    h('small', {}, `${fmt.int(part)} de ${fmt.int(total)}${extra ? ` · ${extra}` : ''}`));
}

function barList(items) {
  const max = Math.max(...items.map(i => i.value), 0) || 1;
  return h('div', { class: 'bars' }, items.map(i => h('div', { class: 'bar-row', 'data-tip': i.tip },
    h('span', { class: 'bar-name' }, i.name),
    h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: { width: `${Math.max((100 * i.value) / max, i.value ? 1 : 0)}%` } })),
    h('span', { class: 'bar-value' }, i.label))));
}
