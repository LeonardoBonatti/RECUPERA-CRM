import { h, clear, api, toast } from '../lib.js';

export function renderLogin(root, onLogin) {
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const button = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Entrar');

  const form = h('form', {
    class: 'auth-card',
    onsubmit: async e => {
      e.preventDefault();
      error.textContent = '';
      button.disabled = true;
      try {
        const { user } = await api.post('/api/auth/login', { email: email.value, password: password.value });
        onLogin(user);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    },
  },
  h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark' }, 'R'), h('div', {},
    h('h1', {}, 'Recupera CRM'), h('p', {}, 'Recuperação de oportunidades de venda perdidas'))),
  h('label', {}, 'E-mail', email),
  h('label', {}, 'Senha', password),
  error,
  button);

  clear(root, h('div', { class: 'auth-page' }, form));
  email.focus();
}

export function renderChangePassword(root, onDone) {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const form = h('form', {
    class: 'auth-card',
    onsubmit: async e => {
      e.preventDefault();
      error.textContent = '';
      if (next.value !== confirm.value) { error.textContent = 'As senhas não conferem.'; return; }
      try {
        await api.post('/api/auth/password', { current: current.value, next: next.value });
        toast('Senha alterada com sucesso.');
        onDone();
      } catch (err) {
        error.textContent = err.message;
      }
    },
  },
  h('h1', {}, 'Defina sua senha'),
  h('p', { class: 'muted' }, 'Por segurança, troque a senha temporária no primeiro acesso.'),
  h('label', {}, 'Senha temporária', current),
  h('label', {}, 'Nova senha (mín. 8 caracteres)', next),
  h('label', {}, 'Confirme a nova senha', confirm),
  error,
  h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Salvar e continuar'));

  clear(root, h('div', { class: 'auth-page' }, form));
  current.focus();
}
