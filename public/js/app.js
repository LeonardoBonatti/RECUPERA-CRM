import { h, clear, api, state, toast, installTooltips } from './lib.js';
import { renderLogin, renderChangePassword } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderImport } from './views/importar.js';
import { renderPortfolio } from './views/carteira.js';
import { renderWorkspace } from './views/executivo.js';
import { renderTeam } from './views/equipe.js';
import { renderActivity } from './views/atuacao.js';

// Menu por perfil. A primeira rota de cada lista é a tela inicial do perfil.
const NAV = {
  NACIONAL: [
    ['dashboard', 'Dashboard'], ['importar', 'Importar base'], ['carteira', 'Carteira'], ['atuacao', 'Atuação da equipe'],
    ['equipe', 'Equipe e acessos'],
  ],
  REGIONAL: [['carteira', 'Minha carteira'], ['atuacao', 'Atuação da equipe'], ['dashboard', 'Dashboard'], ['equipe', 'Meus executivos']],
  EXECUTIVO: [['clientes', 'Meus clientes'], ['dashboard', 'Meus resultados']],
  VISUALIZADOR: [['dashboard', 'Dashboard']],
};

const VIEWS = {
  dashboard: renderDashboard,
  importar: renderImport,
  carteira: renderPortfolio,
  clientes: renderWorkspace,
  equipe: renderTeam,
  atuacao: renderActivity,
};

const root = document.getElementById('app');
let cleanup = null;

async function boot() {
  installTooltips();
  window.addEventListener('session-expired', () => {
    if (state.user) { state.user = null; toast('Sua sessão expirou. Entre novamente.', 'error'); route(); }
  });
  window.addEventListener('hashchange', route);
  try {
    state.user = (await api.get('/api/auth/me')).user;
  } catch { state.user = null; }
  route();
}

export async function onLogin(user) {
  state.user = user;
  route();
}

let routeSeq = 0;

async function route() {
  const seq = ++routeSeq;
  cleanup?.();
  cleanup = null;
  if (!state.user) return renderLogin(root, onLogin);
  if (state.user.must_change_password) {
    return renderChangePassword(root, () => { state.user.must_change_password = false; route(); });
  }
  if (!state.meta) {
    try {
      [state.meta, state.regions] = await Promise.all([api.get('/api/meta'), api.get('/api/regions')]);
    } catch (err) {
      return clear(root, h('div', { class: 'boot' }, err.message));
    }
    if (seq !== routeSeq) return; // outra navegação começou enquanto carregava
  }
  const nav = NAV[state.user.role] || [];
  const requested = location.hash.replace(/^#\/?/, '').split('?')[0];
  const current = nav.find(([k]) => k === requested)?.[0] || nav[0]?.[0];
  const main = h('main', { class: 'main' });
  clear(root, layout(nav, current), main);
  try {
    const dispose = (await VIEWS[current](main)) || null;
    if (seq !== routeSeq) dispose?.();
    else cleanup = dispose;
  } catch (err) {
    console.error(err);
    clear(main, h('div', { class: 'empty' }, `Não foi possível carregar: ${err.message}`));
  }
}

function layout(nav, current) {
  const u = state.user;
  const roleLabel = state.meta.roles[u.role] + (u.region_name ? ` · ${u.region_name}` : '');
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'R'),
      h('span', {}, h('strong', {}, 'Recupera CRM'), h('small', {}, 'Recuperação de oportunidades'))),
    h('nav', { class: 'nav' }, nav.map(([key, label]) =>
      h('a', { href: `#/${key}`, class: key === current ? 'active' : '' }, label))),
    h('div', { class: 'user' },
      h('span', { class: 'user-info' }, h('strong', {}, u.name), h('small', {}, roleLabel)),
      h('button', {
        class: 'btn btn-ghost', onclick: async () => {
          await api.post('/api/auth/logout').catch(() => {});
          state.user = null; state.meta = null; route();
        },
      }, 'Sair')));
}

boot();
