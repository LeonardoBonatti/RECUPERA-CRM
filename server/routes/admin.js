// Autenticação, metadados, usuários, regionais e mapa de filiais.
import { q, transaction } from '../db.js';
import { fail, toInt } from '../http.js';
import {
  verifyPassword, hashPassword, generatePassword, validatePasswordStrength,
  createSession, destroySession, sessionCookie, requireRole, checkLoginThrottle, clientIp, USER_REGION_COLUMNS,
} from '../auth.js';
import { QUALIFICATION_FIELDS, IMPORT_FIELDS, ROLES, SUMMARY_MIN_LENGTH, STAGES } from '../fields.js';
import { normKey, cleanText } from '../normalize.js';

const publicUser = u => u && ({
  id: u.id, name: u.name, email: u.email, role: u.role, region_id: u.region_id,
  region_ids: u.region_ids ?? (u.region_id ? [u.region_id] : []),
  region_name: u.region_name ?? null, must_change_password: !!u.must_change_password,
  active: u.active === undefined ? true : !!u.active,
  aliases: u.aliases ?? [],
});

// Apelidos: como o nome aparece nas colunas de gerente/vendedor das planilhas.
// Aceita lista ou texto separado por vírgula/ponto e vírgula.
function parseAliases(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[;,\n]/);
  return [...new Set(list.map(a => cleanText(a, 120)).filter(Boolean))].slice(0, 10);
}

// Valida a lista de regionais recebida e devolve ids únicos existentes.
async function validRegionIds(value) {
  const ids = [...new Set((Array.isArray(value) ? value : [value]).map(toInt).filter(Boolean))];
  if (!ids.length) return [];
  const found = await q.all('SELECT id FROM regions WHERE id = ANY(?::int[])', ids);
  if (found.length !== ids.length) fail(400, 'Regional inválida.');
  return ids;
}

// Gerente regional: todas as regionais em user_regions e a primeira em users.region_id.
// Demais perfis: só users.region_id (executivo) ou nenhuma.
async function saveUserRegions(tx, userId, role, regionIds) {
  await tx.run('DELETE FROM user_regions WHERE user_id = ?', userId);
  if (role === 'REGIONAL') {
    for (const id of regionIds) await tx.run('INSERT INTO user_regions (user_id, region_id) VALUES (?, ?)', userId, id);
  }
  const primary = ['REGIONAL', 'EXECUTIVO'].includes(role) ? (regionIds[0] ?? null) : null;
  await tx.run('UPDATE users SET region_id = ? WHERE id = ?', primary, userId);
}

export function registerAdminRoutes(r) {
  // ---------- Autenticação ----------
  r.post('/api/auth/login', async ({ req, res, json }) => {
    const { email, password } = await json();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const throttle = await checkLoginThrottle(`${clientIp(req)}|${normalizedEmail}`);
    const user = await q.get(`
      SELECT u.*, ${USER_REGION_COLUMNS} FROM users u LEFT JOIN regions r ON r.id = u.region_id
      WHERE u.email = ? AND u.active`, normalizedEmail);
    if (!user || !verifyPassword(password || '', user.password_hash)) {
      await throttle.failed();
      fail(401, 'E-mail ou senha inválidos.');
    }
    await throttle.ok();
    await q.run('UPDATE users SET last_login_at = now() WHERE id = ?', user.id);
    res.setHeader('Set-Cookie', sessionCookie(await createSession(user.id)));
    return { user: publicUser(user) };
  });

  r.post('/api/auth/logout', async ({ req, res }) => {
    await destroySession(req);
    res.setHeader('Set-Cookie', sessionCookie(null));
    return { ok: true };
  });

  r.get('/api/auth/me', ({ user }) => ({ user: publicUser(user) }));

  r.post('/api/auth/password', async ({ user, json }) => {
    requireRole(user);
    const { current, next } = await json();
    const row = await q.get('SELECT password_hash FROM users WHERE id = ?', user.id);
    if (!verifyPassword(current || '', row.password_hash)) fail(400, 'Senha atual incorreta.');
    validatePasswordStrength(next);
    if (next === current) fail(400, 'A nova senha deve ser diferente da atual.');
    await q.run('UPDATE users SET password_hash = ?, must_change_password = false WHERE id = ?', hashPassword(next), user.id);
    return { ok: true };
  });

  // ---------- Metadados (campos travados e mapeamento de importação) ----------
  r.get('/api/meta', ({ user }) => {
    requireRole(user);
    return {
      qualificationFields: QUALIFICATION_FIELDS,
      importFields: IMPORT_FIELDS,
      roles: ROLES,
      summaryMinLength: SUMMARY_MIN_LENGTH,
      stages: STAGES,
    };
  });

  // ---------- Regionais ----------
  r.get('/api/regions', ({ user }) => {
    requireRole(user);
    return q.all(`
      SELECT r.id, r.name, r.active,
        (SELECT string_agg(DISTINCT u.name, ', ') FROM users u
         LEFT JOIN user_regions ur ON ur.user_id = u.id
         WHERE u.role = 'REGIONAL' AND u.active AND (ur.region_id = r.id OR (ur.region_id IS NULL AND u.region_id = r.id))
        ) AS manager_name
      FROM regions r ORDER BY r.name`);
  });

  r.post('/api/regions', async ({ user, json }) => {
    requireRole(user, 'NACIONAL');
    const name = cleanText((await json()).name, 80);
    if (!name) fail(400, 'Informe o nome da regional.');
    if (await q.get('SELECT id FROM regions WHERE lower(name) = lower(?)', name)) fail(409, 'Regional já cadastrada.');
    const row = await q.get('INSERT INTO regions (name) VALUES (?) RETURNING id', name);
    return { id: row.id, name };
  });

  r.put('/api/regions/:id', async ({ user, params, json }) => {
    requireRole(user, 'NACIONAL');
    const body = await json();
    const id = toInt(params.id);
    if (!(await q.get('SELECT id FROM regions WHERE id = ?', id))) fail(404, 'Regional não encontrada.');
    const name = cleanText(body.name, 80);
    if (name) {
      if (await q.get('SELECT id FROM regions WHERE lower(name) = lower(?) AND id <> ?', name, id)) fail(409, 'Já existe uma regional com esse nome.');
      await q.run('UPDATE regions SET name = ? WHERE id = ?', name, id);
    }
    if (body.active !== undefined) await q.run('UPDATE regions SET active = ? WHERE id = ?', !!body.active, id);
    return { ok: true };
  });

  // ---------- Mapa Filial → Regional ----------
  r.get('/api/branches', ({ user }) => {
    requireRole(user, 'NACIONAL');
    return q.all(`SELECT b.id, b.name, b.region_id, r.name AS region_name
                  FROM branches b JOIN regions r ON r.id = b.region_id ORDER BY b.name`);
  });

  r.post('/api/branches', async ({ user, json }) => {
    requireRole(user, 'NACIONAL');
    const body = await json();
    const name = cleanText(body.name, 120);
    const regionId = toInt(body.region_id);
    if (!name) fail(400, 'Informe o nome da filial.');
    if (!(await q.get('SELECT id FROM regions WHERE id = ?', regionId))) fail(400, 'Regional inválida.');
    await q.run(`INSERT INTO branches (name, name_key, region_id) VALUES (?, ?, ?)
                 ON CONFLICT (name_key) DO UPDATE SET name = excluded.name, region_id = excluded.region_id`,
      name, normKey(name), regionId);
    return { ok: true };
  });

  r.del('/api/branches/:id', async ({ user, params }) => {
    requireRole(user, 'NACIONAL');
    await q.run('DELETE FROM branches WHERE id = ?', toInt(params.id));
    return { ok: true };
  });

  // ---------- Usuários ----------
  r.get('/api/users', async ({ user }) => {
    requireRole(user, 'NACIONAL', 'REGIONAL');
    const base = `
      SELECT u.id, u.name, u.email, u.role, u.region_id, u.active, u.must_change_password, u.aliases, ${USER_REGION_COLUMNS},
        (SELECT count(*) FROM leads l WHERE l.executive_id = u.id) AS lead_count
      FROM users u LEFT JOIN regions r ON r.id = u.region_id`;
    const rows = user.role === 'NACIONAL'
      ? await q.all(`${base} ORDER BY u.role, u.name`)
      : await q.all(`${base} WHERE u.region_id = ANY(?::int[]) AND u.role = 'EXECUTIVO' ORDER BY u.name`, user.region_ids);
    return rows.map(row => ({ ...publicUser(row), lead_count: row.lead_count }));
  });

  // Corpo: { name, email, role, region_ids: [..] }. Gerente regional pode ter várias; executivo, uma.
  r.post('/api/users', async ({ user, json }) => {
    requireRole(user, 'NACIONAL', 'REGIONAL');
    const body = await json();
    const name = cleanText(body.name, 120);
    const email = cleanText(body.email, 160)?.toLowerCase();
    let role = body.role;
    let regionIds = await validRegionIds(body.region_ids ?? body.region_id);
    if (user.role === 'REGIONAL') {
      // Gerente regional só cria executivos, numa das regionais que ele gerencia.
      role = 'EXECUTIVO';
      regionIds = [regionIds.find(id => user.region_ids.includes(id)) ?? user.region_ids[0]];
    }
    if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Informe nome e e-mail válidos.');
    if (!ROLES[role]) fail(400, 'Perfil inválido.');
    if (role === 'EXECUTIVO') regionIds = regionIds.slice(0, 1);
    if (['REGIONAL', 'EXECUTIVO'].includes(role) && !regionIds.length) fail(400, 'Selecione a regional deste usuário.');
    if (await q.get('SELECT id FROM users WHERE email = ?', email)) fail(409, 'Já existe um usuário com este e-mail.');

    const tempPassword = generatePassword();
    const aliases = user.role === 'NACIONAL' ? parseAliases(body.aliases) : [];
    const id = await transaction(async tx => {
      const row = await tx.get('INSERT INTO users (name, email, password_hash, role, aliases) VALUES (?, ?, ?, ?, ?::text[]) RETURNING id',
        name, email, hashPassword(tempPassword), role, aliases);
      await saveUserRegions(tx, row.id, role, regionIds);
      return row.id;
    });
    // A senha temporária é exibida uma única vez para quem criou; o usuário troca no 1º acesso.
    return { id, tempPassword };
  });

  // Define uma senha inicial comum para todos que ainda não fizeram o 1º acesso.
  // Continuam obrigados a trocar no login, então a senha comum só vale até cada um entrar.
  r.post('/api/users/initial-password', async ({ user, json }) => {
    requireRole(user, 'NACIONAL');
    const { password } = await json();
    validatePasswordStrength(password);
    const pending = await q.all('SELECT id FROM users WHERE must_change_password AND active AND id <> ?', user.id);
    await transaction(async tx => {
      for (const { id } of pending) {
        await tx.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id);
        await tx.run('DELETE FROM sessions WHERE user_id = ?', id);
      }
    });
    return { updated: pending.length };
  });

  r.put('/api/users/:id', async ({ user, params, json }) => {
    requireRole(user, 'NACIONAL', 'REGIONAL');
    const body = await json();
    const id = toInt(params.id);
    const target = await q.get('SELECT * FROM users WHERE id = ?', id);
    if (!target) fail(404, 'Usuário não encontrado.');
    if (user.role === 'REGIONAL' && (target.role !== 'EXECUTIVO' || !user.region_ids.includes(target.region_id))) {
      fail(403, 'Você só pode gerenciar executivos das suas regionais.');
    }
    if (target.id === user.id && body.active === false) fail(400, 'Você não pode desativar o próprio usuário.');
    const newRole = user.role === 'NACIONAL' && body.role !== undefined ? body.role : target.role;
    if (!ROLES[newRole]) fail(400, 'Perfil inválido.');
    const regionIds = user.role === 'NACIONAL' && (body.region_ids !== undefined || body.region_id !== undefined)
      ? await validRegionIds(body.region_ids ?? body.region_id)
      : null;

    let tempPassword = null;
    await transaction(async tx => {
      const name = cleanText(body.name, 120);
      if (name) await tx.run('UPDATE users SET name = ? WHERE id = ?', name, id);
      if (user.role === 'NACIONAL' && body.aliases !== undefined) {
        await tx.run('UPDATE users SET aliases = ?::text[] WHERE id = ?', parseAliases(body.aliases), id);
      }
      if (newRole !== target.role) await tx.run('UPDATE users SET role = ? WHERE id = ?', newRole, id);
      if (regionIds || newRole !== target.role) {
        const current = regionIds ?? (await tx.all(
          'SELECT region_id FROM user_regions WHERE user_id = ? UNION SELECT region_id FROM users WHERE id = ? AND region_id IS NOT NULL',
          id, id)).map(x => x.region_id);
        const ids = newRole === 'EXECUTIVO' ? current.slice(0, 1) : current;
        if (['REGIONAL', 'EXECUTIVO'].includes(newRole) && !ids.length) {
          fail(400, 'Gerentes regionais e executivos precisam de uma regional.');
        }
        await saveUserRegions(tx, id, newRole, ids);
      }
      if (body.active !== undefined) {
        await tx.run('UPDATE users SET active = ? WHERE id = ?', !!body.active, id);
        if (!body.active) await tx.run('DELETE FROM sessions WHERE user_id = ?', id);
      }
      if (body.resetPassword) {
        tempPassword = generatePassword();
        await tx.run('UPDATE users SET password_hash = ?, must_change_password = true WHERE id = ?', hashPassword(tempPassword), id);
        await tx.run('DELETE FROM sessions WHERE user_id = ?', id);
      }
    });
    return { ok: true, tempPassword };
  });
}
