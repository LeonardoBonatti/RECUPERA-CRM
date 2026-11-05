// Normalização de dados vindos de planilhas preenchidas à mão.

export function normKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function cleanText(value, max = 500) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

export function digits(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

// Aceita número nativo do Excel ou textos como "R$ 1.234.567,89", "1234567.89", "1,5".
export function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = String(value ?? '').replace(/[^\d,.\-]/g, '');
  if (!s) return 0;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // O separador que aparece por último é o decimal.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasDot && /^\-?\d{1,3}(\.\d{3})+$/.test(s)) {
    // "1.234.567" sem decimais = separador de milhar pt-BR.
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function parseQuantity(value) {
  if (value === null || value === undefined || String(value).trim() === '') return 1;
  const n = parseMoney(value);
  return n > 0 ? n : 1;
}

// Excel serial (dias desde 1899-12-30) ou texto dd/mm/aaaa ou ISO → 'AAAA-MM-DD'.
export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return cleanText(s, 30);
}

// Converte um valor livre para uma das opções permitidas (comparação sem acento/caixa).
// Retorna null se não houver correspondência — nunca grava valor fora da lista.
export function matchOption(value, options) {
  const k = normKey(value);
  if (!k) return null;
  if (k === 's') return options.includes('Sim') ? 'Sim' : null;
  if (k === 'n' || k === 'nao') return options.includes('Não') ? 'Não' : null;
  return options.find(o => normKey(o) === k) ?? null;
}

// "Impressão digital" de uma oportunidade, para detectar duplicidade na importação.
// Só considera duplicada quando TODOS batem: cliente (CNPJ/CPF, ou nome se não houver documento
// válido) + equipamento + quantidade + valor total + filial. Formatação não importa
// ("R$ 570.000,00" = 570000; "50.121.595/0002-92" = "50121595000292"; maiúsculas/acentos).
export function opportunityKey({ client_name, client_doc, machine, quantity, amount, branch }) {
  const d = digits(client_doc);
  const client = d.length === 11 || d.length === 14 ? d : `nome:${normKey(client_name)}`;
  return [
    client,
    normKey(machine),
    parseQuantity(quantity).toFixed(2),
    parseMoney(amount).toFixed(2),
    normKey(branch),
  ].join('|');
}

// Chave que identifica um cliente único: documento (CNPJ/CPF) ou nome normalizado.
export function clientKey(name, doc) {
  const d = digits(doc);
  if (d.length === 11 || d.length === 14) return `doc:${d}`;
  return `nome:${normKey(name)}`;
}
