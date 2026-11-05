// Módulo 2 — Área de trabalho do Executivo de Vendas.
// Regra de Ouro: só existem controles fechados (rádio/dropdown) e um único campo de texto livre.
import { h, clear, api, state, fmt, toast, statusBadge, emptyState, confirmDialog, modal } from '../lib.js';
import { downloadExecutiveSheet, readFilledSheet, describeChange } from '../sheet.js';

export async function renderWorkspace(main) {
  const fields = state.meta.qualificationFields;
  const minSummary = state.meta.summaryMinLength;
  let leads = await api.get('/api/leads');
  let filter = 'pending';
  let search = '';
  let selectedId = null;
  let dirty = false;

  const progress = h('div', { class: 'progress-card' });
  const list = h('div', { class: 'lead-list', role: 'list' });
  const detail = h('section', { class: 'lead-detail', 'aria-live': 'polite' });

  const tabs = [['pending', 'Pendentes'], ['done', 'Concluídos'], ['all', 'Todos']];
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const searchInput = h('input', {
    type: 'search', placeholder: 'Buscar cliente, CNPJ, máquina…', class: 'search',
    oninput: e => { search = e.target.value.toLowerCase(); renderList(); },
  });

  // Planilha: baixar a própria carteira e enviar de volta preenchida.
  const uploadInput = h('input', {
    type: 'file', accept: '.xlsx,.xls,.ods,.csv', class: 'visually-hidden', id: 'sheet-upload',
    onchange: e => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadSheet(f); },
  });
  const sheetActions = h('div', { class: 'head-actions' },
    h('button', {
      class: 'btn', onclick: () => {
        try { downloadExecutiveSheet(state.user.name, leads); } catch (err) { toast(err.message, 'error'); }
      },
    }, 'Baixar minha planilha'),
    h('label', { class: 'btn btn-primary', for: 'sheet-upload' }, 'Enviar planilha preenchida'),
    uploadInput);

  clear(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Meus clientes'),
        h('p', { class: 'muted' }, 'Registre cada contato aqui ou pela planilha. Os campos são fechados para garantir a qualidade da informação.'),
        sheetActions),
      progress),
    h('div', { class: 'workspace' },
      h('aside', { class: 'workspace-list' }, h('div', { class: 'list-tools' }, tabBar, searchInput), list),
      detail));

  const beforeUnload = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  // Lê a planilha, pede ao servidor uma prévia (dryRun) e só grava depois da confirmação.
  async function uploadSheet(file) {
    let parsed;
    try {
      parsed = await readFilledSheet(file);
    } catch (err) { toast(err.message, 'error'); return; }
    let preview;
    try {
      preview = await api.post('/api/leads/sheet-update', { rows: parsed.rows, dryRun: true });
    } catch (err) { toast(err.message, 'error'); return; }

    const issues = [
      ...preview.invalid.map(x => `Linha ${x.line} — ${x.client}: "${x.value}" não é uma opção válida de ${x.field} (mantido o valor atual).`),
      ...preview.ambiguous.map(x => `Linha ${x.line} — ${x.client}: mais de um cliente com o mesmo CNPJ e equipamento; use a planilha baixada do sistema (com ID).`),
      ...preview.duplicated.map(x => `Linha ${x.line} — ${x.client}: cliente repetido na planilha; só a primeira linha vale.`),
    ];
    const list = (items, limit = 60) => h('ul', { class: 'change-list' },
      items.slice(0, limit).map(t => h('li', {}, t)),
      items.length > limit ? h('li', { class: 'muted' }, `… e mais ${items.length - limit}`) : null);

    modal({
      title: 'Conferir antes de gravar',
      wide: true,
      body: h('div', { class: 'form-stack' },
        h('div', { class: 'chips' },
          h('span', { class: 'chip' }, h('strong', {}, fmt.int(preview.updated)), ' clientes serão atualizados'),
          h('span', { class: 'chip' }, h('strong', {}, fmt.int(preview.unchanged)), ' sem mudança'),
          preview.notFound.length ? h('span', { class: 'chip chip-warn' }, h('strong', {}, fmt.int(preview.notFound.length)), ' linhas não são da sua carteira (ignoradas)') : null,
          issues.length ? h('span', { class: 'chip chip-warn' }, h('strong', {}, fmt.int(issues.length)), ' avisos') : null),
        parsed.hasId ? null : h('p', { class: 'hint' }, 'Esta planilha não tem a coluna ID. Os clientes foram localizados por CNPJ/CPF + equipamento. Para evitar erros, prefira a planilha baixada pelo sistema.'),
        preview.changes.length ? [h('h3', {}, 'O que vai mudar'), list(preview.changes.map(describeChange))] : h('p', {}, 'Nenhuma alteração encontrada em relação ao que já está no sistema.'),
        issues.length ? [h('h3', {}, 'Avisos'), list(issues)] : null),
      actions: [
        { label: 'Cancelar' },
        preview.updated ? {
          label: `Gravar ${fmt.int(preview.updated)} atualizações`, primary: true, onClick: async () => {
            try {
              const res = await api.post('/api/leads/sheet-update', { rows: parsed.rows });
              toast(`${fmt.int(res.updated)} clientes atualizados pela planilha.`);
              leads = await api.get('/api/leads');
              renderProgress(); renderTabs(); renderList();
              if (selectedId) open(selectedId);
            } catch (err) { toast(err.message, 'error'); return false; }
          },
        } : null,
      ].filter(Boolean),
    });
  }

  function renderProgress() {
    const done = leads.filter(l => l.completed_at).length;
    const pct = leads.length ? Math.round((100 * done) / leads.length) : 0;
    clear(progress,
      h('div', { class: 'progress-label' }, h('strong', {}, `${done} de ${leads.length}`), ' concluídos'),
      h('div', { class: 'progress-bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('span', { style: { width: `${pct}%` } })),
      h('small', { class: 'muted' }, `${fmt.int(leads.length - done)} pendentes · ${fmt.moneyShort(leads.reduce((s, l) => s + l.amount, 0))} em carteira`));
  }

  function renderTabs() {
    clear(tabBar, tabs.map(([key, label]) => {
      const count = key === 'pending' ? leads.filter(l => !l.completed_at).length
        : key === 'done' ? leads.filter(l => l.completed_at).length : leads.length;
      return h('button', {
        class: `tab ${filter === key ? 'active' : ''}`, role: 'tab', 'aria-selected': String(filter === key),
        onclick: () => { filter = key; renderTabs(); renderList(); },
      }, label, h('span', { class: 'tab-count' }, count));
    }));
  }

  function visible() {
    return leads.filter(l => {
      if (filter === 'pending' && l.completed_at) return false;
      if (filter === 'done' && !l.completed_at) return false;
      if (!search) return true;
      return [l.client_name, l.client_doc, l.machine, l.city].some(v => String(v || '').toLowerCase().includes(search));
    });
  }

  function renderList() {
    const rows = visible();
    if (!rows.length) {
      clear(list, emptyState(leads.length ? 'Nenhum cliente neste filtro.' : 'Nenhum cliente atribuído a você ainda.'));
      return;
    }
    clear(list, rows.map(l => h('button', {
      class: `lead-item ${l.id === selectedId ? 'selected' : ''}`, role: 'listitem',
      onclick: () => open(l.id),
    },
    h('div', { class: 'lead-item-top' }, h('strong', {}, l.client_name), statusBadge(l)),
    h('div', { class: 'lead-item-sub' },
      h('span', {}, [l.machine, l.quantity > 1 ? `${fmt.num(l.quantity)} un.` : null].filter(Boolean).join(' · ') || 'Máquina não informada'),
      h('span', { class: 'num' }, fmt.moneyShort(l.amount))))));
  }

  async function open(id) {
    if (dirty && id !== selectedId) {
      const discard = await confirmDialog('Há alterações não salvas neste cliente. Descartar?', { confirmLabel: 'Descartar', danger: true });
      if (!discard) return;
    }
    selectedId = id;
    dirty = false;
    renderList();
    clear(detail, h('div', { class: 'empty' }, 'Carregando…'));
    const lead = await api.get(`/api/leads/${id}`);
    renderDetail(lead);
  }

  function renderDetail(lead) {
    const values = Object.fromEntries(fields.map(f => [f.key, lead[f.key] ?? null]));
    const checklist = h('ul', { class: 'checklist' });
    const saveBtn = h('button', { class: 'btn btn-primary', disabled: true, onclick: () => save(false) }, 'Salvar');
    const saveNextBtn = h('button', { class: 'btn', disabled: true, onclick: () => save(true) }, 'Salvar e ir para o próximo');

    const markDirty = () => { dirty = true; saveBtn.disabled = false; saveNextBtn.disabled = false; renderChecklist(); };

    function renderChecklist() {
      const items = fields.filter(f => f.type !== 'text').map(f => [f.label, !!values[f.key]]);
      const statusOpt = fields.find(f => f.key === 'contact_status').options.find(o => o.value === values.contact_status);
      const finals = fields.find(f => f.key === 'contact_status').options
        .filter(o => state.meta.stages[o.stage]?.final).map(o => o.value);
      items.push([`Status final (${finals.join(', ')})`, !!statusOpt && !!state.meta.stages[statusOpt.stage]?.final]);
      items.push([`Resumo com pelo menos ${minSummary} caracteres`, (values.contact_summary || '').trim().length >= minSummary]);
      clear(checklist, items.map(([label, ok]) => h('li', { class: ok ? 'ok' : '' }, h('span', { 'aria-hidden': 'true' }, ok ? '✓' : '○'), label)));
    }

    // Resposta antiga da planilha que não existe na lista fechada: aparece só como referência.
    const legacyHint = key => (!values[key] && lead.legacy_values?.[key]
      ? h('small', { class: 'legacy' }, `Planilha anterior: "${lead.legacy_values[key]}" — escolha a opção equivalente.`)
      : null);

    const controls = fields.map(f => {
      const id = `f-${f.key}`;
      if (f.type === 'radio') {
        return h('fieldset', { class: 'field' },
          h('legend', {}, f.label),
          h('div', { class: 'segmented' }, f.options.map(opt => {
            const optId = `${id}-${opt}`;
            return [
              h('input', {
                type: 'radio', name: id, id: optId, value: opt, checked: values[f.key] === opt,
                onchange: () => { values[f.key] = opt; markDirty(); },
              }),
              h('label', { for: optId }, opt),
            ];
          })),
          legacyHint(f.key));
      }
      if (f.type === 'select') {
        const sel = h('select', {
          id, onchange: e => { values[f.key] = e.target.value || null; markDirty(); },
        },
        h('option', { value: '', disabled: true, selected: !values[f.key] }, 'Selecione uma opção…'),
        f.options.map(o => {
          const v = typeof o === 'string' ? o : o.value;
          return h('option', { value: v, selected: values[f.key] === v }, v);
        }));
        return h('div', { class: 'field' }, h('label', { for: id }, f.label), sel, legacyHint(f.key));
      }
      // Único campo de texto livre do sistema.
      const counter = h('small', { class: 'muted counter' });
      const updateCounter = () => { counter.textContent = `${(values[f.key] || '').length} / ${f.maxLength}`; };
      const area = h('textarea', {
        id, rows: 5, maxlength: f.maxLength, placeholder: 'Descreva o contato: com quem falou, o que foi oferecido, próximos passos…',
        oninput: e => { values[f.key] = e.target.value; updateCounter(); markDirty(); },
      });
      area.value = values[f.key] || '';
      updateCounter();
      return h('div', { class: 'field field-wide' }, h('label', { for: id }, f.label, h('span', { class: 'tag-free' }, 'texto livre')), area, counter);
    });

    async function save(goNext) {
      saveBtn.disabled = true; saveNextBtn.disabled = true;
      try {
        const res = await api.put(`/api/leads/${lead.id}`, values);
        dirty = false;
        const idx = leads.findIndex(l => l.id === lead.id);
        leads[idx] = { ...leads[idx], ...values, completed_at: res.complete ? (leads[idx].completed_at || new Date().toISOString()) : null };
        toast(res.complete ? 'Cliente concluído.' : 'Rascunho salvo. Ainda há itens pendentes.', res.complete ? 'ok' : 'warn');
        renderProgress(); renderTabs(); renderList();
        if (goNext) {
          const next = leads.find(l => !l.completed_at && l.id !== lead.id);
          if (next) return open(next.id);
          toast('Todos os seus clientes estão concluídos!');
        }
        const fresh = await api.get(`/api/leads/${lead.id}`);
        renderDetail(fresh);
      } catch (err) {
        toast(err.message, 'error');
        saveBtn.disabled = false; saveNextBtn.disabled = false;
      }
    }

    renderChecklist();
    const info = [
      ['CNPJ/CPF', lead.client_doc], ['Filial', lead.branch], ['Regional', lead.region_name],
      ['Máquina', lead.machine], ['Quantidade', fmt.num(lead.quantity)], ['Valor', fmt.money(lead.amount)],
      ['Motivo da perda', lead.loss_reason], ['Gestor da distribuidora', lead.origin_manager], ['Vendedor da distribuidora', lead.origin_seller],
      ['Contato', lead.contact_name], ['Telefone', lead.phone], ['E-mail', lead.email],
      ['Cidade/UF', [lead.city, lead.state].filter(Boolean).join(' / ')], ['Data', lead.opportunity_date ? fmt.date(lead.opportunity_date) : null],
      ['Base', lead.import_label],
    ].filter(([, v]) => v);

    clear(detail,
      h('div', { class: 'detail-head' },
        h('div', {}, h('h2', {}, lead.client_name), statusBadge(lead)),
        h('div', { class: 'detail-amount' }, fmt.money(lead.amount))),
      lead.in_previous_base ? h('p', { class: 'hint' }, 'ℹ O sistema encontrou este cliente em uma base importada anteriormente.') : null,
      h('dl', { class: 'info-grid' }, info.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
      h('div', { class: 'form-card' },
        h('h3', {}, 'Retorno do contato'),
        controls,
        h('div', { class: 'form-footer' },
          h('div', {}, h('small', { class: 'muted' }, 'Para concluir:'), checklist),
          h('div', { class: 'form-actions' }, saveNextBtn, saveBtn))),
      lead.history?.length ? h('details', { class: 'history' },
        h('summary', {}, `Histórico (${lead.history.length})`),
        h('ul', {}, lead.history.map(x => h('li', {},
          h('small', { class: 'muted' }, `${fmt.datetime(x.created_at)} · ${x.user_name || 'sistema'}`),
          h('div', {}, `${x.action}${x.field && x.field !== 'region_id' && x.field !== 'executive_id' ? ` — ${x.field}` : ''}: `,
            h('span', { class: 'muted' }, x.old_value ?? '∅'), ' → ', h('strong', {}, x.new_value ?? '∅')))))) : null);
  }

  renderProgress();
  renderTabs();
  renderList();
  const first = visible()[0];
  if (first) open(first.id);
  else clear(detail, emptyState('Selecione um cliente na lista.'));

  return () => window.removeEventListener('beforeunload', beforeUnload);
}
