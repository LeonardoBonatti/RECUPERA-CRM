// Acesso ao PostgreSQL (Neon). Na Vercel a integração Neon cria DATABASE_URL automaticamente.
import pg from 'pg';

const { Pool, types } = pg;

// COUNT/SUM (int8) e NUMERIC chegam como texto no driver; aqui viram number.
types.setTypeParser(20, v => (v === null ? null : Number(v)));
types.setTypeParser(1700, v => (v === null ? null : Number(v)));

// A integração Neon da Vercel pode criar a variável com prefixo (ex.: STORAGE_DATABASE_URL).
// Procura a conexão "pooled" em qualquer um desses nomes, sem exigir configuração manual.
function findConnectionString() {
  const env = process.env;
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.POSTGRES_URL) return env.POSTGRES_URL;
  const key = Object.keys(env).find(k => /(^|_)(DATABASE_URL|POSTGRES_URL)$/.test(k) && env[k]);
  return key ? env[key] : null;
}

function createPool() {
  const connectionString = findConnectionString();
  if (!connectionString) {
    throw new Error('DATABASE_URL não definida. Configure a integração Neon na Vercel ou crie o arquivo .env (veja .env.example).');
  }
  return new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
}

// Em serverless a mesma instância atende várias requisições: reaproveita o pool.
function pool() {
  globalThis.__recuperaPool ??= createPool();
  return globalThis.__recuperaPool;
}

export function closePool() {
  return globalThis.__recuperaPool?.end();
}

// As consultas são escritas com "?" e convertidas para $1, $2… do Postgres.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function makeQ(client) {
  const query = (sql, params) => client.query(toPg(sql), params.map(p => (p === undefined ? null : p)));
  return {
    all: async (sql, ...params) => (await query(sql, params)).rows,
    get: async (sql, ...params) => (await query(sql, params)).rows[0],
    run: async (sql, ...params) => {
      const r = await query(sql, params);
      return { rowCount: r.rowCount, rows: r.rows };
    },
    // Vários comandos sem parâmetros (usado só para o schema).
    exec: sql => client.query(sql),
  };
}

export const q = {
  all: (...a) => makeQ(pool()).all(...a),
  get: (...a) => makeQ(pool()).get(...a),
  run: (...a) => makeQ(pool()).run(...a),
};

export async function transaction(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(makeQ(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function logHistory(tx, leadId, userId, action, field = null, oldValue = null, newValue = null) {
  return tx.run(
    'INSERT INTO lead_history (lead_id, user_id, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
    leadId, userId, action, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue),
  );
}
