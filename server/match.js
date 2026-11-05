// Encontra o usuário a partir do nome escrito na planilha ("JOAO S. SILVA", "JOA SILVA"...).
import { normKey } from './normalize.js';

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

// users: [{ id, name, aliases: [] , ... }]. Ordem de tentativa:
// 1) nome ou apelido idêntico  2) diferença de até 2 letras  3) mesmo primeiro e último nome.
// Só aceita quando há um único candidato — na dúvida, não atribui.
export function createNameMatcher(users) {
  const entries = users.map(u => ({ user: u, keys: [u.name, ...(u.aliases || [])].map(normKey).filter(Boolean) }));
  const cache = new Map();

  const unique = list => {
    const ids = [...new Set(list.map(e => e.user.id))];
    return ids.length === 1 ? list[0].user : null;
  };

  return function match(rawName) {
    const key = normKey(rawName);
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);

    let found = unique(entries.filter(e => e.keys.includes(key)));
    if (!found) found = unique(entries.filter(e => e.keys.some(k => distance(k, key) <= 2)));
    if (!found) {
      const parts = key.split(' ');
      const firstLast = `${parts[0]} ${parts[parts.length - 1]}`;
      found = parts.length > 1
        ? unique(entries.filter(e => e.keys.some(k => { const p = k.split(' '); return `${p[0]} ${p[p.length - 1]}` === firstLast; })))
        : null;
    }
    cache.set(key, found);
    return found;
  };
}
