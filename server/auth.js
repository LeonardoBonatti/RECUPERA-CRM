import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { q } from './db.js';
import { fail, parseCookies } from './http.js';

const SESSION_HOURS = 12;
const COOKIE = 'recupera_sid';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function generatePassword() {
  return randomBytes(9).toString('base64url');
}

export function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) fail(400, 'A senha deve ter pelo menos 8 caracteres.');
}

const sha256 = s => createHash('sha256').update(s).digest('hex');

export async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  await q.run('DELETE FROM sessions WHERE expires_at < now()');
  await q.run(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, now() + interval '${SESSION_HOURS} hours')`,
    sha256(token), userId);
  return token;
}

export async function destroySession(req) {
  const token = parseCookies(req)[COOKIE];
  if (token) await q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function sessionCookie(token) {
  // Na Vercel o site é sempre HTTPS.
  const secure = process.env.COOKIE_SECURE === '1' || process.env.VERCEL ? '; Secure' : '';
  if (!token) return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`;
}

// Regionais do usuário: as de user_regions (gerente com várias) ou a única de users.region_id.
// Exige "users u" e "LEFT JOIN regions r ON r.id = u.region_id" na consulta.
export const USER_REGION_COLUMNS = `
  coalesce(
    (SELECT array_agg(ur.region_id ORDER BY rr.name) FROM user_regions ur JOIN regions rr ON rr.id = ur.region_id WHERE ur.user_id = u.id),
    CASE WHEN u.region_id IS NULL THEN ARRAY[]::int[] ELSE ARRAY[u.region_id] END
  ) AS region_ids,
  coalesce(
    (SELECT string_agg(rr.name, ' / ' ORDER BY rr.name) FROM user_regions ur JOIN regions rr ON rr.id = ur.region_id WHERE ur.user_id = u.id),
    r.name
  ) AS region_name`;

export async function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  return (await q.get(`
    SELECT u.id, u.name, u.email, u.role, u.region_id, u.must_change_password, ${USER_REGION_COLUMNS}
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN regions r ON r.id = u.region_id
    WHERE s.token_hash = ? AND s.expires_at > now() AND u.active
  `, sha256(token))) || null;
}

export function requireRole(user, ...roles) {
  if (!user) fail(401, 'Sessão expirada. Entre novamente.');
  if (roles.length && !roles.includes(user.role)) fail(403, 'Você não tem permissão para esta ação.');
  return user;
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
}

// Limite de tentativas de login guardado no banco (5 erros → 5 minutos de bloqueio).
export async function checkLoginThrottle(key) {
  if (await q.get('SELECT 1 FROM login_attempts WHERE key = ? AND locked_until > now()', key)) {
    fail(429, 'Muitas tentativas. Aguarde alguns minutos.');
  }
  return {
    failed: () => q.run(`
      INSERT INTO login_attempts (key, failures) VALUES (?, 1)
      ON CONFLICT (key) DO UPDATE SET
        failures = CASE WHEN login_attempts.failures + 1 >= 5 THEN 0 ELSE login_attempts.failures + 1 END,
        locked_until = CASE WHEN login_attempts.failures + 1 >= 5 THEN now() + interval '5 minutes'
                            ELSE login_attempts.locked_until END`, key),
    ok: () => q.run('DELETE FROM login_attempts WHERE key = ?', key),
  };
}
