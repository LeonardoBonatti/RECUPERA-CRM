// Utilitários do frontend: criação de DOM, API, formatação e componentes simples.

export const state = { user: null, meta: null, regions: [] };

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------- API ----------
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `Erro ${res.status}`);
    err.status = res.status;
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('session-expired'));
    throw err;
  }
  return data;
}

export const api = {
  get: (url, params) => {
    const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString() : '';
    return request('GET', qs ? `${url}?${qs}` : url);
  },
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  del: url => request('DELETE', url),
};

// ---------- Formatação pt-BR ----------
const nf = (opts) => new Intl.NumberFormat('pt-BR', opts);
const intFmt = nf({ maximumFractionDigits: 0 });
const moneyFmt = nf({ style: 'currency', currency: 'BRL' });
const dec1 = nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const fmt = {
  int: n => intFmt.format(Number(n) || 0),
  num: n => nf({ maximumFractionDigits: 2 }).format(Number(n) || 0),
  money: n => moneyFmt.format(Number(n) || 0),
  // R$ 294,6 mi — o formato usado na apresentação mensal.
  moneyShort: n => {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e9) return `R$ ${dec1.format(v / 1e9)} bi`;
    if (Math.abs(v) >= 1e6) return `R$ ${dec1.format(v / 1e6)} mi`;
    if (Math.abs(v) >= 1e3) return `R$ ${dec1.format(v / 1e3)} mil`;
    return moneyFmt.format(v);
  },
  pct: (part, total) => (total ? `${dec1.format((100 * part) / total)}%` : '0,0%'),
  date: s => (s ? new Date(s.length === 10 ? `${s}T12:00:00` : s).toLocaleDateString('pt-BR') : '—'),
  datetime: s => {
    if (!s) return '—';
    // SQLite grava datetime('now') em UTC sem fuso.
    const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  },
};

export function normKey(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------- Componentes ----------
export function toast(message, type = 'ok') {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(host); }
  const el = h('div', { class: `toast toast-${type}` }, message);
  host.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const backdrop = h('div', { class: 'modal-backdrop', onclick: e => { if (e.target === backdrop) close(); } },
    h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' },
        h('h2', {}, title),
        h('button', { class: 'btn-icon', 'aria-label': 'Fechar', onclick: close }, '×')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-actions' }, actions.map(a =>
        h('button', { class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`,
          onclick: async () => { if ((await a.onClick?.()) !== false) close(); } }, a.label))) : null));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  backdrop.querySelector('.modal-body input, .modal-body select, .modal-body button')?.focus();
  return { close };
}

export function confirmDialog(message, { confirmLabel = 'Confirmar', danger = false } = {}) {
  // Uma Promise só resolve uma vez: fechar pelo X/Esc depois de responder não muda nada.
  return new Promise(resolve => {
    modal({
      title: 'Confirmação',
      body: h('p', {}, message),
      onClose: () => resolve(false),
      actions: [
        { label: 'Cancelar', onClick: () => resolve(false) },
        { label: confirmLabel, primary: !danger, danger, onClick: () => resolve(true) },
      ],
    });
  });
}

export function select(options, { value = '', placeholder, ...attrs } = {}) {
  const el = h('select', attrs,
    placeholder !== undefined ? h('option', { value: '' }, placeholder) : null,
    options.map(o => {
      const v = typeof o === 'object' ? o.value : o;
      const label = typeof o === 'object' ? o.label : o;
      return h('option', { value: v, selected: String(v) === String(value) }, label);
    }));
  el.value = String(value ?? '');
  if (el.selectedIndex < 0 && el.options.length) el.selectedIndex = 0;
  return el;
}

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind ? `badge-${kind}` : ''}` }, text);
}

export function statusBadge(lead) {
  if (lead.completed_at) return badge('Concluído', 'good');
  if (lead.contact_status) return badge('Em andamento', 'warn');
  return badge('Pendente', 'muted');
}

// Tooltip único para qualquer elemento com data-tip.
export function installTooltips() {
  const tip = h('div', { class: 'tooltip', role: 'tooltip' });
  document.body.append(tip);
  document.addEventListener('mouseover', e => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) { tip.style.opacity = '0'; return; }
    tip.textContent = t.dataset.tip;
    tip.style.opacity = '1';
  });
  document.addEventListener('mousemove', e => {
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.transform = `translate(${x}px, ${e.clientY + 16}px)`;
  });
}

export function emptyState(text) {
  return h('div', { class: 'empty' }, text);
}
