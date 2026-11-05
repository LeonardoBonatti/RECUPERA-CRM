// Servidor local de desenvolvimento: serve public/ e a mesma API da Vercel.
// Em produção (Vercel) este arquivo não é usado.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson } from './http.js';
import { handleApi, SECURITY_HEADERS } from './app.js';
import { ensureReady } from './setup.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// Mesmo CSP configurado no vercel.json.
const STATIC_HEADERS = {
  ...SECURITY_HEADERS,
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

async function serveStatic(res, pathname) {
  let file = resolve(join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 403, { error: 'Proibido' });
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(PUBLIC_DIR, 'index.html');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { ...STATIC_HEADERS, 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Não encontrado' });
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Método não permitido' });
  try {
    await serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Erro interno' });
  }
});

// Cria o schema e o primeiro usuário já na subida, para a senha aparecer no terminal.
ensureReady()
  .then(() => server.listen(PORT, () => console.log(`Recupera CRM rodando em http://localhost:${PORT}`)))
  .catch(err => { console.error('Não foi possível conectar ao banco:', err.message); process.exit(1); });
