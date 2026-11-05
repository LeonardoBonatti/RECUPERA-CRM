// Cadastros: usuários (todos os perfis), regionais e mapa Filial → Regional.
import { h, clear, api, state, toast, select, modal, emptyState, badge } from '../lib.js';

export async function renderTeam(main) {
  const isNational = state.user.role === 'NACIONAL';
  let tab = 'users';
  const content = h('div', {});
  const tabBar = h('div', { class: 'tabs' });

  clear(main,
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, isNational ? 'Equipe e acessos' : 'Meus executivos'),
      h('p', { class: 'muted' }, isNational
        ? 'Cadastre gerentes, executivos e o mapa de filiais usado no roteamento automático.'
        : 'Cadastre e gerencie os executivos da sua regional.'))),
    isNational ? tabBar : null,
    content);

  function renderTabs() {
    clear(tabBar, [['users', 'Usuários'], ['regions', 'Regionais'], ['branches', 'Filiais → Regional']].map(([k, label]) =>
      h('button', { class: `tab ${tab === k ? 'active' : ''}`, onclick: () => { tab = k; renderTabs(); show(); } }, label)));
  }

  async function show() {
    clear(content, emptyState('Carregando…'));
    if (tab === 'users') await showUsers();
    if (tab === 'regions') await showRegions();
    if (tab === 'branches') await showBranches();
  }

  async function refreshRegions() {
    state.regions = await api.get('/api/regions');
  }

  // ---------- Usuários ----------
  async function showUsers() {
    const users = await api.get('/api/users');
    clear(content,
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', onclick: () => userForm() },
          isNational ? '+ Criar login (nova contratação)' : '+ Criar login de executivo'),
        isNational ? h('button', { class: 'btn', onclick: initialPasswordForm }, 'Senha inicial para quem não acessou') : null,
        h('span', { class: 'muted' }, 'O acesso é pelo e-mail. No 1º login cada pessoa cria a própria senha.')),
      users.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Nome', 'E-mail', 'Perfil', 'Regional', 'Leads', 'Situação', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, users.map(u => h('tr', {},
          h('td', {}, h('strong', {}, u.name)), h('td', {}, u.email), h('td', {}, state.meta.roles[u.role]),
          h('td', {}, u.region_name || '—'), h('td', { class: 'num' }, u.lead_count),
          h('td', {}, u.active ? (u.must_change_password ? badge('Aguardando 1º acesso', 'warn') : badge('Ativo', 'good')) : badge('Inativo', 'muted')),
          h('td', { class: 'row-actions' },
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => userForm(u) }, 'Editar'),
            h('button', {
              class: `btn btn-sm ${u.must_change_password ? 'btn-primary' : 'btn-ghost'}`, onclick: () => resetPassword(u),
              title: 'Gera uma senha temporária e a mensagem pronta para enviar',
            }, u.must_change_password ? 'Gerar acesso' : 'Nova senha'),
            u.id !== state.user.id ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => toggleActive(u) }, u.active ? 'Desativar' : 'Reativar') : null))))))
        : emptyState('Nenhum usuário cadastrado.'));
  }

  function userForm(u = null) {
    const name = h('input', { type: 'text', value: u?.name || '', maxlength: 120, required: true });
    const email = h('input', { type: 'email', value: u?.email || '', disabled: !!u, required: true });
    // Como o nome aparece nas planilhas (colunas de gerente/vendedor), se for diferente.
    const aliases = h('input', {
      type: 'text', value: (u?.aliases || []).join(', '), maxlength: 600,
      placeholder: 'ex.: JOAO S. SILVA, JOAO SILVA (separe por vírgula)',
    });
    const role = select(Object.entries(state.meta.roles).map(([value, label]) => ({ value, label })), { value: u?.role || 'EXECUTIVO' });
    // Regionais que quem está cadastrando pode atribuir.
    const allowedRegions = state.regions.filter(r => r.active && (isNational || state.user.region_ids.includes(r.id)));
    const currentIds = u?.region_ids ?? [];

    // Executivo: uma regional (lista). Gerente regional: uma ou mais (caixas de seleção).
    const region = select(allowedRegions.map(r => ({ value: r.id, label: r.name })),
      { value: currentIds[0] ?? (allowedRegions.length === 1 ? allowedRegions[0].id : ''), placeholder: '— selecione —' });
    const checks = allowedRegions.map(r => {
      const box = h('input', { type: 'checkbox', value: r.id, checked: currentIds.includes(r.id) });
      return h('label', { class: 'check' }, box, r.name);
    });
    const singleField = h('label', {}, 'Regional', region);
    const multiField = h('fieldset', { class: 'check-group' }, h('legend', {}, 'Regionais que gerencia'), checks);
    const syncRegion = () => {
      const r = isNational ? role.value : 'EXECUTIVO';
      singleField.hidden = r !== 'EXECUTIVO';
      multiField.hidden = r !== 'REGIONAL';
    };
    role.addEventListener('change', syncRegion);
    syncRegion();
    const selectedRegionIds = () => ((isNational ? role.value : 'EXECUTIVO') === 'REGIONAL'
      ? checks.map(c => c.querySelector('input')).filter(b => b.checked).map(b => Number(b.value))
      : (region.value ? [Number(region.value)] : []));

    modal({
      title: u ? `Editar ${u.name}` : 'Criar login',
      body: h('div', { class: 'form-stack' },
        h('label', {}, 'Nome', name),
        h('label', {}, 'E-mail (é o login)', email),
        isNational ? h('label', {}, 'Perfil (define quais telas a pessoa vê)', role) : null,
        isNational ? h('label', {}, 'Nome como aparece na planilha (opcional)', aliases,
          h('small', { class: 'muted' }, 'Usado para distribuir os clientes na importação quando a planilha escreve o nome de outro jeito.')) : null,
        // Gerente regional com uma só regional não precisa escolher.
        isNational || allowedRegions.length > 1 ? [singleField, multiField] : h('p', { class: 'muted' }, `Regional: ${state.user.region_name}`)),
      actions: [
        { label: 'Cancelar' },
        {
          label: 'Salvar', primary: true, onClick: async () => {
            try {
              const payload = { name: name.value, region_ids: selectedRegionIds() };
              if (isNational) { payload.role = role.value; payload.aliases = aliases.value; }
              if (!isNational && !payload.region_ids.length) payload.region_ids = [allowedRegions[0]?.id].filter(Boolean);
              if (u) {
                await api.put(`/api/users/${u.id}`, payload);
                toast('Usuário atualizado.');
              } else {
                const res = await api.post('/api/users', { ...payload, email: email.value });
                showTempPassword(name.value, email.value, res.tempPassword);
              }
              show();
            } catch (err) { toast(err.message, 'error'); return false; }
          },
        },
      ],
    });
  }

  // Uma senha comum para todos que ainda estão "Aguardando 1º acesso".
  function initialPasswordForm() {
    const input = h('input', { type: 'text', minlength: 8, autocomplete: 'off', placeholder: 'mín. 8 caracteres' });
    modal({
      title: 'Senha inicial',
      body: h('div', { class: 'form-stack' },
        h('p', {}, 'Vale para todos que ainda não fizeram o 1º acesso (exceto você). No primeiro login cada pessoa é obrigada a criar a própria senha.'),
        h('label', {}, 'Senha inicial', input)),
      actions: [
        { label: 'Cancelar' },
        {
          label: 'Aplicar', primary: true, onClick: async () => {
            try {
              const res = await api.post('/api/users/initial-password', { password: input.value });
              toast(`Senha inicial definida para ${res.updated} pessoa(s).`);
              show();
            } catch (err) { toast(err.message, 'error'); return false; }
          },
        },
      ],
    });
  }

  async function resetPassword(u) {
    try {
      const res = await api.put(`/api/users/${u.id}`, { resetPassword: true });
      showTempPassword(u.name, u.email, res.tempPassword);
      show();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function toggleActive(u) {
    try {
      await api.put(`/api/users/${u.id}`, { active: !u.active });
      toast(u.active ? 'Usuário desativado. Reatribua os leads dele na Carteira.' : 'Usuário reativado.');
      show();
    } catch (err) { toast(err.message, 'error'); }
  }

  function showTempPassword(name, email, password) {
    const message = `Olá, ${name}! Seu acesso ao Recupera CRM está pronto.\n` +
      `Endereço: ${location.origin}\nE-mail: ${email}\nSenha temporária: ${password}\n` +
      'No primeiro acesso o sistema vai pedir para você criar sua própria senha.';
    const copy = async (text, what) => {
      try { await navigator.clipboard.writeText(text); toast(`${what} copiada.`); } catch { toast('Não foi possível copiar; selecione e copie manualmente.', 'warn'); }
      return false;
    };
    modal({
      title: 'Login criado',
      body: h('div', { class: 'form-stack' },
        h('p', {}, `Envie para ${name} (${email}) pelo canal interno. A senha só aparece agora; no primeiro acesso a troca é obrigatória.`),
        h('code', { class: 'temp-password' }, password),
        h('label', {}, 'Mensagem pronta para enviar',
          h('textarea', { rows: 5, readonly: true, value: message })),
      ),
      actions: [
        { label: 'Copiar senha', onClick: () => copy(password, 'Senha') },
        { label: 'Copiar mensagem', onClick: () => copy(message, 'Mensagem') },
        { label: 'Fechar', primary: true },
      ],
    });
  }

  // ---------- Regionais ----------
  async function showRegions() {
    await refreshRegions();
    const input = h('input', { type: 'text', placeholder: 'Nome da nova regional', maxlength: 80 });
    clear(content,
      h('form', {
        class: 'toolbar', onsubmit: async e => {
          e.preventDefault();
          try { await api.post('/api/regions', { name: input.value }); toast('Regional criada.'); show(); } catch (err) { toast(err.message, 'error'); }
        },
      }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Adicionar')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Regional', 'Gerente regional', 'Situação', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, state.regions.map(r => h('tr', {},
          h('td', {}, h('strong', {}, r.name)), h('td', {}, r.manager_name || h('span', { class: 'muted' }, 'Sem gerente')),
          h('td', {}, r.active ? badge('Ativa', 'good') : badge('Inativa', 'muted')),
          h('td', { class: 'row-actions' },
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => renameRegion(r) }, 'Renomear'),
            h('button', {
              class: 'btn btn-ghost btn-sm', onclick: async () => {
                try { await api.put(`/api/regions/${r.id}`, { active: !r.active }); show(); } catch (err) { toast(err.message, 'error'); }
              },
            }, r.active ? 'Desativar' : 'Reativar'))))))));
  }

  function renameRegion(r) {
    const input = h('input', { type: 'text', value: r.name, maxlength: 80 });
    modal({
      title: 'Renomear regional',
      body: h('label', {}, 'Nome', input),
      actions: [{ label: 'Cancelar' }, {
        label: 'Salvar', primary: true, onClick: async () => {
          try { await api.put(`/api/regions/${r.id}`, { name: input.value }); show(); } catch (err) { toast(err.message, 'error'); return false; }
        },
      }],
    });
  }

  // ---------- Filiais ----------
  async function showBranches() {
    const branches = await api.get('/api/branches');
    const name = h('input', { type: 'text', placeholder: 'Nome da filial como aparece na planilha', maxlength: 120 });
    const region = select(state.regions.filter(r => r.active).map(r => ({ value: r.id, label: r.name })), { placeholder: 'Regional…' });
    clear(content,
      h('p', { class: 'muted' }, 'Quando a planilha não traz a coluna Regional, o sistema usa a Filial para decidir a regional. A comparação ignora acentos e maiúsculas.'),
      h('form', {
        class: 'toolbar', onsubmit: async e => {
          e.preventDefault();
          try {
            await api.post('/api/branches', { name: name.value, region_id: Number(region.value) || null });
            toast('Filial mapeada.'); show();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, name, region, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Salvar')),
      branches.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Filial', 'Regional', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, branches.map(b => h('tr', {},
          h('td', {}, b.name), h('td', {}, b.region_name),
          h('td', { class: 'row-actions' }, h('button', {
            class: 'btn btn-ghost btn-sm', onclick: async () => { await api.del(`/api/branches/${b.id}`); show(); },
          }, 'Remover')))))))
        : emptyState('Nenhuma filial mapeada ainda.'));
  }

  if (isNational) renderTabs();
  await show();
}
