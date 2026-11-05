// Mini-framework HTTP sobre node:http (sem dependências externas).

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (status, message) => { throw new HttpError(status, message); };

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function readJson(req, limitBytes = 4 * 1024 * 1024) {
  const type = req.headers['content-type'] || '';
  // Exigir JSON também barra formulários de outros sites (proteção CSRF junto com SameSite).
  if (!type.startsWith('application/json')) return Promise.reject(new HttpError(415, 'Envie o corpo como application/json.'));

  // Na Vercel o corpo já chega lido e parseado em req.body.
  if (process.env.VERCEL) {
    try {
      const body = req.body;
      if (body === undefined || body === null || body === '') return Promise.resolve({});
      if (typeof body === 'string' || Buffer.isBuffer(body)) return Promise.resolve(JSON.parse(String(body)));
      return Promise.resolve(body);
    } catch {
      return Promise.reject(new HttpError(400, 'JSON inválido.'));
    }
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'Arquivo grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createRouter() {
  const routes = [];
  const add = method => (pattern, handler) => {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, regex, keys, handler });
  };
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    del: add('DELETE'),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = pathname.match(r.regex);
        if (m) {
          const params = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          return { handler: r.handler, params };
        }
      }
      return null;
    },
  };
}

export function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}
