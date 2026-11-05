// Planilha do vendedor: gerada pelo sistema (com ID por linha) e lida de volta na atualização.
import { state, normKey } from './lib.js';

const ID_HEADER = 'ID (não alterar)';

// Colunas informativas (o sistema ignora alterações nelas ao ler a planilha de volta).
const INFO_COLUMNS = [
  ['ID', l => l.id],
  ['Regional', l => l.region_name || ''],
  ['Filial', l => l.branch || ''],
  ['Cliente', l => l.client_name],
  ['Cnpj/ Cpf', l => l.client_doc || ''],
  ['Contato', l => [l.contact_name, l.phone].filter(Boolean).join(' · ')],
  ['Equipamento', l => l.machine || ''],
  ['Quantidade', l => Number(l.quantity) || 0],
  ['Preço Total', l => Number(l.amount) || 0],
  ['Motivo', l => l.loss_reason || ''],
  ['Nome Gestor', l => l.origin_manager || ''],
  ['Nome Vendedor', l => l.origin_seller || ''],
];

function editableFields() {
  return state.meta.qualificationFields;
}

function optionList(field) {
  return (field.options || []).map(o => (typeof o === 'string' ? o : o.value));
}

// Uma planilha com os clientes de um vendedor + aba "Lista" com as opções permitidas.
export function downloadExecutiveSheet(executiveName, leads) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('A biblioteca de Excel não carregou. Recarregue a página.');
  const fields = editableFields();
  const header = [...INFO_COLUMNS.map(([h]) => (h === 'ID' ? ID_HEADER : h)), ...fields.map(f => f.label)];
  const rows = leads.map(l => [...INFO_COLUMNS.map(([, get]) => get(l)), ...fields.map(f => l[f.key] ?? '')]);

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = header.map(h => ({ wch: /Resumo/.test(h) ? 60 : /Cliente/.test(h) ? 40 : Math.max(12, h.length + 2) }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };

  const closed = fields.filter(f => f.type !== 'text');
  const maxOptions = Math.max(...closed.map(f => optionList(f).length));
  const lista = [closed.map(f => f.label)];
  for (let i = 0; i < maxOptions; i++) lista.push(closed.map(f => optionList(f)[i] ?? ''));

  const instrucoes = [
    ['Como preencher'],
    [`Preencha somente as colunas: ${fields.map(f => f.label).join(', ')}.`],
    ['Use exatamente as opções da aba "Lista". Valores diferentes são recusados e o sistema avisa em qual linha.'],
    ['Não altere nem apague a coluna ID: é ela que liga cada linha ao cliente no sistema (evita duplicação).'],
    ['Célula em branco não apaga nada: o sistema mantém o que já estava registrado.'],
    ['Alterações nas outras colunas (cliente, valores, etc.) são ignoradas.'],
    ['Depois de preencher, envie em "Meus clientes" → "Enviar planilha preenchida".'],
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Clientes');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lista), 'Lista');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instrucoes), 'Instruções');
  const safe = executiveName.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w ]+/g, '').trim();
  XLSX.writeFile(wb, `Recupera CRM - ${safe} - ${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// Lê a planilha preenchida: aceita a gerada pelo sistema (com ID) e também a planilha
// antiga, sem ID (aí o servidor localiza por CNPJ/CPF + equipamento).
export async function readFilledSheet(file) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('A biblioteca de Excel não carregou. Recarregue a página.');
  const wb = /\.csv$/i.test(file.name)
    ? XLSX.read((await file.text()).replace(/^﻿/, ''), { type: 'string', raw: true })
    : XLSX.read(await file.arrayBuffer(), { type: 'array' });

  // Cabeçalho → campo, pelos rótulos do site e pelos sinônimos já usados na importação.
  const keyByHeader = new Map([['id', 'id'], ['id nao alterar', 'id']]);
  for (const f of state.meta.qualificationFields) keyByHeader.set(normKey(f.label), f.key);
  for (const f of state.meta.importFields) {
    if (['client_name', 'client_doc', 'machine'].includes(f.key) || f.qualification) {
      for (const s of f.synonyms) if (!keyByHeader.has(s)) keyByHeader.set(s, f.key);
    }
  }

  // Procura a aba e a linha de cabeçalho com mais colunas reconhecidas.
  let best = null;
  for (const name of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false, blankrows: true });
    matrix.slice(0, 25).forEach((row, r) => {
      const cols = {};
      row.forEach((cell, c) => { const k = keyByHeader.get(normKey(cell)); if (k && cols[k] === undefined) cols[k] = c; });
      const score = Object.keys(cols).length;
      if (!best || score > best.score) best = { score, cols, matrix, headerRow: r, sheet: name };
    });
  }
  const qualKeys = state.meta.qualificationFields.map(f => f.key);
  if (!best || !qualKeys.some(k => best.cols[k] !== undefined)) {
    throw new Error('Não encontrei as colunas de retorno (Status do Contato, Resumo…) nesta planilha.');
  }

  const { cols, matrix, headerRow } = best;
  const get = (row, key) => (cols[key] === undefined ? '' : String(row[cols[key]] ?? '').trim());
  const rows = [];
  matrix.slice(headerRow + 1).forEach((row, i) => {
    if (!row.some(c => String(c ?? '').trim())) return;
    rows.push({
      row_number: headerRow + i + 2,
      id: get(row, 'id'),
      client_name: get(row, 'client_name'),
      client_doc: get(row, 'client_doc'),
      machine: get(row, 'machine'),
      values: Object.fromEntries(qualKeys.map(k => [k, get(row, k)])),
    });
  });
  return { rows, sheet: best.sheet, hasId: cols.id !== undefined, recognized: Object.keys(cols).length };
}

export function describeChange(c) {
  return `${c.client} — ${c.field}: ${c.from ?? '∅'} → ${c.to ?? '∅'}`;
}
