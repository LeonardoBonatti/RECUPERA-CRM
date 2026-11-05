// npm run db:setup — cria as tabelas no Neon e o primeiro Gerente Nacional.
// Use uma vez, com DATABASE_URL no .env, antes do primeiro acesso em produção.
import { ensureReady } from '../server/setup.js';
import { closePool } from '../server/db.js';

try {
  await ensureReady();
  console.log('Banco pronto.');
} catch (err) {
  console.error('Falha ao preparar o banco:', err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
