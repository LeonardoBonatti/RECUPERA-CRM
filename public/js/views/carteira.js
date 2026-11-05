// Módulo 1 (parte 2) — Carteira: roteamento manual (Nacional) e atribuição aos executivos (Regional).
import { h, clear, api, state, fmt, toast, select, statusBadge, emptyState, modal, confirmDialog } from '../lib.js';
import { downloadExecutiveSheet } from '../sheet.js';

export async function renderPortfolio(main) {
  const isNational = state.user.role === 'NACIONAL';
  const [imports, users] = await Promise.all([api.get('/api/imports'), api.get('/api/users')]);
  const executives = users.filter(u => u.role === 'EXECUTIVO' && u.active);
  const filters = { import_id: imports[0]?.id ?? '', region_id: '', status: '', executive_id: '', q: '' };
  let leads = [];
  let sortBy = 'amount';
  const selected = new Set();

  const summary = h('div', { class: 'kpi-row kpi-row-compact' });
  const actionBar = h('div', { class: 'bulk-bar' });
  const tableWrap = h('div', { class: 'table-wrap' });

  const filterBar = h('div', { class: 'filters' },
    h('label', {}, 'Base', select(imports.map(i => ({ value: i.id, label: `${i.label} (${fmt.date(i.created_at)})` })),
      { value: filters.import_id, placeholder: 'Todas as bases', onchange: e => setFilter('import_id', e.target.value) })),
    // Os gerentes atendem leads de várias regionais, então todos filtram por regional.
    h('label', {}, 'Regional', select(
      [
        ...state.regions.map(r => ({ value: r.id, label: r.name })),
        ...(isNational ? [{ value: 'none', label: '⚠ Sem regional' }] : []),
      ],
      { placeholder: 'Todas', onchange: e => setFilter('region_id', e.target.value) })),
    h('label', {}, 'Situação', select([
      { value: 'unassigned', label: 'Não atribuídos' }, { value: 'assigned', label: 'Atribuídos' },
      { value: 'pending', label: 'Pendentes' }, { value: 'done', label: 'Concluídos' },
      { value: 'untouched', label: 'Sem atuação do vendedor' },
    ], { placeholder: 'Todas', onchange: e => setFilter('status', e.target.value) })),
    h('label', {}, 'Executivo', select(executives.map(u => ({ value: u.id, label: u.name })),
      { placeholder: 'Todos', onchange: e => setFilter('executive_id', e.target.value) })),
    h('label', {}, 'Ordenar', select([
      { value: 'amount', label: 'Maior valor' }, { value: 'updated', label: 'Atualizados recentemente' },
    ], { value: 'amount', onchange: e => { sortBy = e.target.value; renderTable(); } })),
    h('label', { class: 'grow' }, 'Busca', h('input', {
      type: 'search', placeholder: 'Cliente, CNPJ, máquina, filial…',
      oninput: debounce(e => setFilter('q', e.target.value), 300),
    })));

  clear(main,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, isNational ? 'Carteira nacional' : `Carteira — ${state.user.name}`),
        h('p', { class: 'muted' }, 'Acompanhe o andamento de cada cliente: as respostas dos vendedores aparecem aqui assim que são gravadas. Clique numa linha para ver o histórico completo.')),
      h('div', { class: 'head-actions' },
        h('button', { class: 'btn', onclick: sheetsByExecutive }, 'Planilhas por vendedor'))),
    summary, filterBar, actionBar, tableWrap);

  // Gera uma planilha .xlsx por vendedor, com os clientes dele (respeitando o filtro de base).
  async function sheetsByExecutive() {
    const counts = new Map();
    for (const l of leads) if (l.executive_id) counts.set(l.executive_id, (counts.get(l.executive_id) || 0) + 1);
    const people = executives.filter(u => counts.has(u.id)).sort((a, b) => a.name.localeCompare(b.name));
    const download = async u => {
      const rows = await api.get('/api/leads', { executive_id: u.id, import_id: filters.import_id });
      downloadExecutiveSheet(u.name, rows);
    };
    modal({
      title: 'Planilhas por vendedor',
      body: h('div', { class: 'form-stack' },
        h('p', { class: 'muted' }, 'Cada planilha traz os clientes do vendedor, uma coluna ID (que evita duplicação) e as 5 colunas de retorno para preencher. O vendedor envia de volta em "Meus clientes" → "Enviar planilha preenchida".'),
        people.length ? h('table', { class: 'table table-compact' },
          h('tbody', {}, people.map(u => h('tr', {},
            h('td', {}, h('strong', {}, u.name), h('small', { class: 'muted block' }, u.region_name || '')),
            h('td', { class: 'num' }, `${fmt.int(counts.get(u.id))} clientes`),
            h('td', { class: 'row-actions' }, h('button', {
              class: 'btn btn-sm', onclick: () => download(u).catch(err => toast(err.message, 'error')),
            }, 'Baixar')))))) : emptyState('Nenhum cliente atribuído a vendedores neste filtro.')),
      actions: people.length > 1 ? [
        { label: 'Fechar' },
        {
          label: `Baixar todas (${people.length})`, primary: true, onClick: async () => {
            try {
              for (const u of people) { await download(u); await new Promise(r => setTimeout(r, 400)); }
              toast(`${people.length} planilhas geradas.`);
            } catch (err) { toast(err.message, 'error'); }
            return false;
          },
        },
      ] : [{ label: 'Fechar' }],
    });
  }

  function setFilter(key, value) { filters[key] = value; load(); }

  async function load() {
    clear(tableWrap, emptyState('Carregando…'));
    leads = await api.get('/api/leads', filters);
    selected.clear();
    renderSummary(); renderActions(); renderTable();
  }

  function renderSummary() {
    const total = leads.length;
    const unassigned = leads.filter(l => l.region_id && !l.executive_id).length;
    const unrouted = leads.filter(l => !l.region_id).length;
    const done = leads.filter(l => l.completed_at).length;
    const card = (label, value, sub, kind = '') => h('div', { class: `kpi kpi-sm ${kind}` },
      h('span', { class: 'kpi-label' }, label), h('strong', { class: 'kpi-value' }, value), sub ? h('small', {}, sub) : null);
    clear(summary,
      card('Leads no filtro', fmt.int(total), fmt.moneyShort(leads.reduce((s, l) => s + l.amount, 0))),
      card('Não atribuídos', fmt.int(unassigned), fmt.pct(unassigned, total), unassigned ? 'kpi-attention' : ''),
      isNational ? card('Sem regional', fmt.int(unrouted), unrouted ? 'Precisam de roteamento' : 'Tudo roteado', unrouted ? 'kpi-attention' : '') : null,
      card('Concluídos', fmt.int(done), fmt.pct(done, total)));
  }

  function renderActions() {
    if (!selected.size) {
      clear(actionBar, h('span', { class: 'muted' }, 'Marque leads na tabela para atribuir ou rotear.'));
      return;
    }
    // Qualquer executivo do gerente pode receber lead de qualquer regional.
    const execOptions = executives
      .map(u => ({ value: u.id, label: isNational || state.user.region_ids.length > 1 ? `${u.name} (${u.region_name})` : u.name }));
    const execSelect = select(execOptions, { placeholder: 'Escolha o executivo…' });
    const regionSelect = select(state.regions.filter(r => r.active).map(r => ({ value: r.id, label: r.name })), { placeholder: 'Escolha a regional…' });

    clear(actionBar,
      h('strong', {}, `${selected.size} selecionado(s)`),
      h('div', { class: 'bulk-group' },
        execSelect,
        h('button', {
          class: 'btn btn-primary',
          onclick: () => (execSelect.value ? assign(execSelect.value) : toast('Escolha o executivo.', 'warn')),
        }, 'Atribuir'),
        h('button', { class: 'btn btn-ghost', onclick: () => assign(null) }, 'Remover atribuição')),
      isNational
        ? h('div', { class: 'bulk-group' }, regionSelect,
          h('button', { class: 'btn', onclick: () => route(regionSelect.value || null) }, 'Mover para regional'))
        : h('button', { class: 'btn btn-ghost', onclick: () => route(null) }, 'Devolver ao Nacional (não é da regional)'));
  }

  async function assign(executiveId) {
    if (executiveId === null && !(await confirmDialog('Remover a atribuição dos leads selecionados?'))) return;
    try {
      const res = await api.post('/api/leads/assign', { leadIds: [...selected], executiveId: executiveId ? Number(executiveId) : null });
      toast(`${res.changed} lead(s) atualizados.`);
      if (res.skipped) toast(`${res.skipped} lead(s) ignorados: o executivo é de outra regional.`, 'warn');
      load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function route(regionId) {
    if (isNational && !regionId) { toast('Escolha a regional de destino.', 'warn'); return; }
    if (!isNational && !(await confirmDialog('Devolver os leads selecionados ao Gerente Nacional para novo roteamento?'))) return;
    try {
      const res = await api.post('/api/leads/route', { leadIds: [...selected], regionId: regionId ? Number(regionId) : null });
      toast(`${res.changed} lead(s) roteados.`);
      load();
    } catch (err) { toast(err.message, 'error'); }
  }

  function renderTable() {
    if (!leads.length) { clear(tableWrap, emptyState('Nenhum lead encontrado para os filtros escolhidos.')); return; }
    const allBox = h('input', {
      type: 'checkbox', 'aria-label': 'Selecionar todos',
      onchange: e => { leads.forEach(l => (e.target.checked ? selected.add(l.id) : selected.delete(l.id))); renderActions(); renderTable(); },
    });
    allBox.checked = selected.size === leads.length;
    const sorted = sortBy === 'updated'
      ? [...leads].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      : leads;
    const shown = sorted.slice(0, 1000);
    const dash = () => h('span', { class: 'muted' }, '—');
    // Respostas do vendedor (as mesmas 5 colunas da planilha), visíveis para o gerente.
    const qual = state.meta.qualificationFields;
    clear(tableWrap, h('table', { class: 'table table-wide' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'col-check' }, allBox), h('th', {}, 'Cliente'), h('th', {}, 'Equipamento'),
        h('th', { class: 'num' }, 'Valor'), h('th', {}, 'Regional'), h('th', {}, 'Gerente / Vendedor'),
        qual.map(f => h('th', { class: f.type === 'text' ? 'col-summary' : '' }, f.label)),
        h('th', {}, 'Atualizado'), h('th', {}, 'Situação'))),
      h('tbody', {}, shown.map(l => {
        const box = h('input', {
          type: 'checkbox', 'aria-label': `Selecionar ${l.client_name}`, checked: selected.has(l.id),
          onclick: e => e.stopPropagation(),
          onchange: e => { e.target.checked ? selected.add(l.id) : selected.delete(l.id); renderActions(); },
        });
        return h('tr', { class: 'clickable', onclick: () => showLead(l.id) },
          h('td', { class: 'col-check' }, box),
          h('td', {}, h('strong', {}, l.client_name), l.client_doc ? h('small', { class: 'muted block' }, l.client_doc) : null),
          h('td', {}, l.machine || '—', h('small', { class: 'muted block' }, [l.branch, l.quantity > 1 ? `${fmt.num(l.quantity)} un.` : null].filter(Boolean).join(' · '))),
          h('td', { class: 'num' }, fmt.money(l.amount)),
          h('td', {}, l.region_name || h('span', { class: 'badge badge-warn' }, 'Sem regional')),
          h('td', {},
            l.executive_name ? [l.executive_name, l.executive_active ? null : h('small', { class: 'muted' }, ' (inativo)')] : h('span', { class: 'badge badge-warn' }, 'Sem vendedor'),
            l.manager_name ? h('small', { class: 'muted block' }, l.manager_name) : null),
          qual.map(f => f.type === 'text'
            ? h('td', { class: 'col-summary', title: l[f.key] || '' }, l[f.key] || dash())
            : h('td', {}, l[f.key] || dash())),
          h('td', {}, l.updated_at
            ? [fmt.datetime(l.updated_at), l.updated_by_name ? h('small', { class: 'muted block' }, l.updated_by_name) : null]
            : dash()),
          h('td', {}, statusBadge(l)));
      }))),
    leads.length > shown.length ? h('p', { class: 'muted table-note' }, `Mostrando 1.000 de ${fmt.int(leads.length)}. Use os filtros para refinar. "Selecionar todos" inclui todos os ${fmt.int(leads.length)}.`) : null);
  }

  await load();
}

export async function showLead(id) {
  const lead = await api.get(`/api/leads/${id}`);
  const qual = state.meta.qualificationFields;
  const raw = Object.entries(lead.raw_data || {});
  modal({
    title: lead.client_name,
    wide: true,
    body: [
      h('div', { class: 'detail-head' }, statusBadge(lead), h('div', { class: 'detail-amount' }, fmt.money(lead.amount))),
      h('h3', {}, 'Retorno do executivo', lead.executive_name ? h('small', { class: 'muted' }, ` — ${lead.executive_name}`) : null),
      h('dl', { class: 'info-grid' }, qual.map(f => h('div', { class: f.type === 'text' ? 'span-all' : '' },
        h('dt', {}, f.label), h('dd', {}, lead[f.key] || h('span', { class: 'muted' }, 'Não preenchido'))))),
      h('details', {}, h('summary', {}, 'Linha original da planilha'),
        h('dl', { class: 'info-grid' }, raw.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, String(v ?? '')))))),
      lead.history.length ? h('details', { class: 'history' }, h('summary', {}, `Histórico (${lead.history.length})`),
        h('ul', {}, lead.history.map(x => h('li', {},
          h('small', { class: 'muted' }, `${fmt.datetime(x.created_at)} · ${x.user_name || 'sistema'}`),
          h('div', {}, `${x.action}: `, h('span', { class: 'muted' }, x.old_value ?? '∅'), ' → ', h('strong', {}, x.new_value ?? '∅')))))) : null,
    ],
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
