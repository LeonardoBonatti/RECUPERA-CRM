import { toInt } from './http.js';

// Cláusula SQL que limita o que cada perfil enxerga. Sempre aplicada no servidor.
// - Executivo: só os leads atribuídos a ele.
// - Gerente regional: os leads em que ele é o gerente responsável (coluna da planilha ou atribuição)
//   e, entre os que ainda não têm gerente, os das regionais dele.
export function leadScope(user, alias = 'l') {
  switch (user.role) {
    case 'NACIONAL':
    case 'VISUALIZADOR':
      return { sql: '1 = 1', params: [] };
    case 'REGIONAL':
      return {
        sql: `(${alias}.manager_id = ? OR (${alias}.manager_id IS NULL AND ${alias}.region_id = ANY(?::int[])))`,
        params: [user.id, user.region_ids?.length ? user.region_ids : [-1]],
      };
    case 'EXECUTIVO':
      return { sql: `${alias}.executive_id = ?`, params: [user.id] };
    default:
      return { sql: '1 = 0', params: [] };
  }
}

// Filtros opcionais de query string (base e regional), somados ao escopo do perfil.
export function leadFilters(user, query, alias = 'l') {
  const scope = leadScope(user, alias);
  const where = [scope.sql];
  const params = [...scope.params];
  const importId = toInt(query.get('import_id'));
  if (importId) { where.push(`${alias}.import_id = ?`); params.push(importId); }
  const regionParam = query.get('region_id');
  if (regionParam === 'none') where.push(`${alias}.region_id IS NULL`);
  else {
    const regionId = toInt(regionParam);
    if (regionId) { where.push(`${alias}.region_id = ?`); params.push(regionId); }
  }
  return { sql: where.join(' AND '), params };
}
