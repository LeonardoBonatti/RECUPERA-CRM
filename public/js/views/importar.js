// Módulo 1 — Upload da planilha base pelo Gerente Nacional + roteamento automático.
// A leitura do Excel acontece no navegador (SheetJS); o servidor recebe linhas já mapeadas.
import { h, clear, api, state, fmt, toast, select, normKey, emptyState, confirmDialog } from '../lib.js';

const BATCH_SIZE = 300;

export async function renderImport(main) {
  const importFields = state.meta.importFields;
  const branches = await api.get('/api/branches');
  const history = h('div', { class: 'table-wrap' });
  const work = h('div', {});

  const fileInput = h('input', { type: 'file', accept: '.xlsx,.xls,.xlsm,.csv', id: 'file', class: 'visually-hidden', onchange: onFile });
  const drop = h('label', { for: 'file', class: 'dropzone' },
    h('strong', {}, 'Selecione ou arraste a planilha base'),
    h('span', { class: 'muted' }, 'Excel (.xlsx, .xls) ou CSV — a primeira linha com cabeçalhos é detectada automaticamente'));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
  });

  clear(main,
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, 'Importar base'),
      h('p', { class: 'muted' }, 'Os clientes são distribuídos automaticamente para a regional pela coluna Regional ou pelo mapa de Filiais.'))),
    h('div', { class: 'card' }, fileInput, drop, work),
    h('h2', { class: 'section-title' }, 'Bases importadas'),
    history);

  async function loadHistory() {
    const rows = await api.get('/api/imports');
    if (!rows.length) { clear(history, emptyState('Nenhuma base importada ainda.')); return; }
    clear(history, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Base', 'Arquivo', 'Importada em', 'Por', 'Leads', 'Sem regional', 'Atribuídos', 'Concluídos', '']
        .map((t, i) => h('th', { class: i >= 4 && i <= 7 ? 'num' : '' }, t)))),
      h('tbody', {}, rows.map(r => h('tr', {},
        h('td', {}, h('strong', {}, r.label)), h('td', {}, r.file_name || '—'), h('td', {}, fmt.datetime(r.created_at)),
        h('td', {}, r.uploaded_by_name || '—'), h('td', { class: 'num' }, fmt.int(r.leads)),
        h('td', { class: 'num' }, r.unrouted ? h('span', { class: 'badge badge-warn' }, fmt.int(r.unrouted)) : '0'),
        h('td', { class: 'num' }, fmt.pct(r.assigned, r.leads)), h('td', { class: 'num' }, fmt.pct(r.completed, r.leads)),
        h('td', {}, h('button', {
          class: 'btn btn-ghost btn-sm', onclick: async () => {
            if (!(await confirmDialog(`Excluir a base "${r.label}" e seus ${r.leads} leads? Só é possível se nenhum executivo tiver trabalhado nela.`, { confirmLabel: 'Excluir', danger: true }))) return;
            try { await api.del(`/api/imports/${r.id}`); toast('Base excluída.'); loadHistory(); } catch (err) { toast(err.message, 'error'); }
          },
        }, 'Excluir')))))));
  }

  function onFile(e) { if (e.target.files[0]) readFile(e.target.files[0]); }

  async function readFile(file) {
    if (!window.XLSX) {
      toast('A biblioteca de leitura de Excel não carregou. Verifique o acesso a cdn.jsdelivr.net (veja o README).', 'error');
      return;
    }
    clear(work, emptyState('Lendo planilha…'));
    try {
      let wb;
      if (/\.csv$/i.test(file.name)) {
        // CSV do Excel pt-BR usa ";" e deve ser lido como texto para não perder acentos
        // nem zeros à esquerda (CPF, filial "0026").
        const text = await file.text();
        const firstLine = text.split(/\r?\n/, 1)[0];
        const FS = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
        wb = window.XLSX.read(text.replace(/^﻿/, ''), { type: 'string', FS, raw: true });
      } else {
        wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      }
      setupMapping(file, wb);
    } catch (err) {
      console.error(err);
      clear(work, emptyState(`Não foi possível ler o arquivo: ${err.message}`));
    }
  }

  function setupMapping(file, wb) {
    let sheetName = wb.SheetNames[0];
    let parsed = parseSheet(wb.Sheets[sheetName]);
    let mapping = autoMap(parsed.headers, importFields);

    const label = h('input', { type: 'text', value: file.name.replace(/\.[^.]+$/, ''), maxlength: 120 });
    const defaultRegion = select(state.regions.filter(r => r.active).map(r => ({ value: r.id, label: r.name })),
      { placeholder: '— nenhuma (fica "Sem regional") —' });
    const mappingBox = h('div', {});
    const preview = h('div', {});
    const importBtn = h('button', { class: 'btn btn-primary', onclick: doImport }, 'Importar e distribuir');

    const sheetSelect = wb.SheetNames.length > 1 ? select(wb.SheetNames, {
      value: sheetName, onchange: e => {
        sheetName = e.target.value;
        parsed = parseSheet(wb.Sheets[sheetName]);
        mapping = autoMap(parsed.headers, importFields);
        renderMapping(); renderPreview();
      },
    }) : null;
    const headerRowInput = h('input', {
      type: 'number', min: 1, max: 50, value: parsed.headerRow + 1, class: 'input-sm',
      onchange: e => {
        parsed = parseSheet(wb.Sheets[sheetName], Number(e.target.value) - 1);
        mapping = autoMap(parsed.headers, importFields);
        renderMapping(); renderPreview();
      },
    });

    function renderMapping() {
      headerRowInput.value = parsed.headerRow + 1;
      const sample = parsed.rows[0]?.cells || [];
      const opts = parsed.headers.map((name, i) => ({ value: i, label: name }));
      const row = f => {
        const sel = select(opts, {
          value: mapping[f.key] ?? '', placeholder: '— não importar —',
          onchange: e => { if (e.target.value === '') delete mapping[f.key]; else mapping[f.key] = Number(e.target.value); renderPreview(); },
        });
        const idx = mapping[f.key];
        return h('tr', { class: f.required && idx === undefined ? 'row-missing' : '' },
          h('td', {}, f.label, f.required ? h('span', { class: 'req' }, ' *') : null),
          h('td', {}, sel),
          h('td', { class: 'muted ellipsis' }, idx !== undefined ? display(sample[idx]) : ''));
      };
      clear(mappingBox,
        h('table', { class: 'table table-mapping' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Campo do sistema'), h('th', {}, 'Coluna da planilha'), h('th', {}, 'Exemplo (1ª linha)'))),
          h('tbody', {}, importFields.filter(f => !f.qualification).map(row))),
        h('details', { class: 'mt', open: importFields.some(f => f.qualification && mapping[f.key] !== undefined) },
          h('summary', {}, 'Respostas de rodadas anteriores (colunas já preenchidas na planilha)'),
          h('p', { class: 'muted' }, 'Só entram nos campos os valores que existem nas listas fechadas. Os demais (ex.: "Já consorciado") ficam guardados e aparecem para o executivo como referência ao reclassificar.'),
          h('table', { class: 'table table-mapping' }, h('tbody', {}, importFields.filter(f => f.qualification).map(row)))));
    }

    function renderPreview() {
      const forecast = new Map();
      let noName = 0;
      for (const r of parsed.rows) {
        const v = mapValues(r.cells, mapping);
        if (!String(v.client_name ?? '').trim()) { noName += 1; continue; }
        const region = forecastRegion(v, branches, Number(defaultRegion.value) || null);
        forecast.set(region, (forecast.get(region) || 0) + 1);
      }
      const total = [...forecast.values()].reduce((a, b) => a + b, 0);
      importBtn.disabled = mapping.client_name === undefined || !total;
      clear(preview,
        h('h3', {}, 'Prévia do roteamento'),
        mapping.client_name === undefined ? h('p', { class: 'form-error' }, 'Mapeie a coluna "Cliente" para continuar.') : null,
        h('div', { class: 'chips' }, [...forecast].sort((a, b) => b[1] - a[1]).map(([name, n]) =>
          h('span', { class: `chip ${name === 'Sem regional' ? 'chip-warn' : ''}` }, h('strong', {}, fmt.int(n)), ` ${name}`))),
        h('p', { class: 'muted' }, `${fmt.int(total)} linhas válidas`, noName ? ` · ${fmt.int(noName)} ignoradas por não ter nome de cliente` : '',
          forecast.get('Sem regional') ? ' · Leads "Sem regional" ficam na Carteira do Nacional para roteamento manual (ou cadastre a filial em Equipe e acessos → Filiais).' : ''),
        dupBox);
      scheduleDuplicateCheck();
    }

    // ---------- Duplicidade ----------
    // A mesma oportunidade = mesmo cliente (CNPJ/CPF) + equipamento + quantidade + valor total + filial.
    const dupBox = h('div', { class: 'dup-box' });
    const includeDup = h('input', { type: 'checkbox' });
    let dupTimer = null;
    let dupSeq = 0;
    let dupInfo = { duplicates: 0 };

    function scheduleDuplicateCheck() {
      clearTimeout(dupTimer);
      dupTimer = setTimeout(checkDuplicates, 500);
    }

    async function checkDuplicates() {
      const seq = ++dupSeq;
      if (mapping.client_name === undefined) { clear(dupBox); return; }
      clear(dupBox, h('p', { class: 'muted' }, 'Verificando oportunidades duplicadas…'));
      const items = parsed.rows
        .map(r => ({ r, v: mapValues(r.cells, mapping) }))
        .filter(x => String(x.v.client_name ?? '').trim());
      try {
        const results = [];
        for (let i = 0; i < items.length; i += 1000) {
          const part = await api.post('/api/imports/check-duplicates', {
            rows: items.slice(i, i + 1000).map(({ v }) => ({
              client_name: v.client_name, client_doc: v.client_doc, machine: v.machine,
              quantity: v.quantity, amount: v.amount, branch: v.branch,
            })),
          });
          results.push(...part.results);
        }
        if (seq !== dupSeq) return; // mapeamento mudou enquanto verificava

        const firstLine = new Map();
        const found = [];
        results.forEach((res, i) => {
          const { r, v } = items[i];
          const base = { line: r.excelRow, client: v.client_name, machine: v.machine, amount: v.amount };
          if (res.existing) found.push({ ...base, why: `já existe na base "${res.existing.import_label}"${res.existing.executive_name ? ` · ${res.existing.executive_name}` : ''}${res.existing.status ? ` · ${res.existing.status}` : ''}` });
          else if (firstLine.has(res.key)) found.push({ ...base, why: `repete a linha ${firstLine.get(res.key)} desta planilha` });
          else firstLine.set(res.key, r.excelRow);
        });
        dupInfo = { duplicates: found.length };
        const fresh = items.length - found.length;

        clear(dupBox,
          h('h3', {}, 'Oportunidades duplicadas'),
          h('div', { class: 'chips' },
            h('span', { class: 'chip' }, h('strong', {}, fmt.int(fresh)), ' novas serão importadas'),
            found.length ? h('span', { class: 'chip chip-warn' }, h('strong', {}, fmt.int(found.length)), ' duplicadas não entram') : null),
          found.length ? [
            h('p', { class: 'muted' }, 'Mesma oportunidade = mesmo CNPJ/CPF + equipamento + quantidade + valor total + filial (os 5 iguais). Se já existe no sistema, a original continua, com o trabalho do vendedor. Se a planilha traz cópias repetidas, entra só a cópia com a resposta mais avançada (ex.: "Cota fechada" vence "Visita agendada"). As respostas das outras cópias ficam no histórico da oportunidade.'),
            h('details', {}, h('summary', {}, `Ver as ${fmt.int(found.length)} duplicadas`),
              h('div', { class: 'dup-table' }, h('table', { class: 'table table-compact' },
                h('thead', {}, h('tr', {}, ['Linha', 'Cliente', 'Equipamento', 'Valor', 'Motivo'].map(t => h('th', {}, t)))),
                h('tbody', {}, found.slice(0, 500).map(d => h('tr', {},
                  h('td', {}, d.line), h('td', {}, d.client), h('td', {}, d.machine || '—'),
                  h('td', { class: 'num' }, d.amount ? String(d.amount) : '—'), h('td', {}, d.why))))))),
            h('label', { class: 'check-inline' }, includeDup, 'Importar as duplicadas mesmo assim (não recomendado)'),
          ] : h('p', { class: 'muted' }, 'Nenhuma oportunidade desta planilha já existe no sistema.'));
      } catch (err) {
        if (seq === dupSeq) clear(dupBox, h('p', { class: 'form-error' }, `Não foi possível verificar duplicadas: ${err.message}`));
      }
    }

    async function doImport() {
      importBtn.disabled = true;
      importBtn.textContent = 'Importando…';
      let importId = null;
      let sent = 0;
      try {
        const rows = parsed.rows.map(r => ({
          row_number: r.excelRow,
          values: mapValues(r.cells, mapping),
          raw: Object.fromEntries(parsed.headers.map((name, i) => [name, display(r.cells[i])])),
        }));
        const created = await api.post('/api/imports', { label: label.value, fileName: file.name });
        importId = created.importId;

        // Lotes pequenos: a Vercel limita cada requisição a 4,5 MB.
        const res = { label: created.label, inserted: 0, skipped: 0, unrouted: 0, assigned: 0, byRegion: [] };
        const byRegion = new Map();
        const byExecutive = new Map();
        const unmatched = new Map();
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          importBtn.textContent = `Importando ${fmt.int(Math.min(i + BATCH_SIZE, rows.length))} de ${fmt.int(rows.length)}…`;
          const part = await api.post(`/api/imports/${importId}/rows`, {
            rows: rows.slice(i, i + BATCH_SIZE), defaultRegionId: Number(defaultRegion.value) || null,
            skipDuplicates: !includeDup.checked,
          });
          sent += part.inserted;
          res.inserted += part.inserted;
          res.skipped += part.skipped;
          res.duplicates = (res.duplicates || 0) + (part.duplicates || 0);
          res.unrouted += part.unrouted;
          res.assigned += part.assigned || 0;
          for (const r of part.byRegion) byRegion.set(r.name, (byRegion.get(r.name) || 0) + r.count);
          for (const r of part.byExecutive || []) byExecutive.set(r.name, (byExecutive.get(r.name) || 0) + r.count);
          for (const group of ['executives', 'managers']) {
            for (const [name, n] of Object.entries(part.unmatched?.[group] || {})) unmatched.set(name, (unmatched.get(name) || 0) + n);
          }
        }
        res.byRegion = [...byRegion].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
        const chips = map => h('div', { class: 'chips' }, [...map].sort((a, b) => b[1] - a[1]).map(([name, n]) =>
          h('span', { class: 'chip' }, h('strong', {}, fmt.int(n)), ` ${name}`)));
        clear(work,
          h('div', { class: 'result' },
            h('h3', {}, `✓ Base "${res.label}" importada`),
            h('p', {}, `${fmt.int(res.inserted)} leads criados`,
              res.duplicates ? ` · ${fmt.int(res.duplicates)} oportunidades duplicadas não importadas (as originais foram mantidas)` : '',
              res.skipped ? ` · ${fmt.int(res.skipped)} linhas sem cliente ignoradas` : ''),
            h('div', { class: 'chips' }, res.byRegion.map(r =>
              h('span', { class: `chip ${r.name === 'Sem regional' ? 'chip-warn' : ''}` }, h('strong', {}, fmt.int(r.count)), ` ${r.name}`))),
            res.assigned ? [
              h('h3', {}, `${fmt.int(res.assigned)} leads já entregues direto ao vendedor (coluna de vendedor da planilha)`),
              chips(byExecutive),
            ] : null,
            unmatched.size ? [
              h('p', { class: 'form-error' }, 'Nomes da planilha que não correspondem a ninguém cadastrado. Esses leads ficaram sem vendedor; cadastre a pessoa em "Equipe e acessos" ou atribua pela Carteira:'),
              chips(unmatched),
            ] : null,
            h('div', { class: 'form-actions' },
              res.unrouted ? h('a', { class: 'btn', href: '#/carteira' }, `Rotear ${res.unrouted} lead(s) sem regional`) : null,
              h('a', { class: 'btn btn-primary', href: '#/dashboard' }, 'Ver dashboard'))));
        fileInput.value = '';
        toast('Base importada e distribuída para as regionais.');
        loadHistory();
      } catch (err) {
        toast(importId && sent
          ? `Falha no meio da importação (${fmt.int(sent)} linhas já gravadas): ${err.message}. Exclua a base incompleta no histórico e tente de novo.`
          : err.message, 'error');
        if (importId && !sent) await api.del(`/api/imports/${importId}`).catch(() => {}); // base criada, mas vazia
        if (importId) loadHistory();
        importBtn.disabled = false;
        importBtn.textContent = 'Importar e distribuir';
      }
    }

    defaultRegion.addEventListener('change', renderPreview);
    clear(work,
      h('div', { class: 'import-head' },
        h('div', {}, h('strong', {}, file.name), h('small', { class: 'muted block' }, `${fmt.int(parsed.rows.length)} linhas de dados`)),
        sheetSelect ? h('label', {}, 'Aba', sheetSelect) : null,
        h('label', {}, 'Linha do cabeçalho', headerRowInput)),
      h('div', { class: 'form-grid' },
        h('label', {}, 'Nome da base (ex.: Agosto/26 — Sudeste)', label),
        h('label', {}, 'Regional padrão para linhas sem regional/filial identificada', defaultRegion)),
      h('h3', {}, 'Mapeamento de colunas'),
      h('p', { class: 'muted' }, 'Sugerido automaticamente pelos nomes dos cabeçalhos. Ajuste se necessário. A linha original inteira também é guardada.'),
      mappingBox, preview,
      h('div', { class: 'form-actions' }, importBtn));
    renderMapping();
    renderPreview();
  }

  await loadHistory();
}

// ---------- Leitura e mapeamento ----------

function parseSheet(ws, forcedHeaderRow) {
  const XLSX = window.XLSX;
  const offset = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: true });
  const headerRow = forcedHeaderRow ?? detectHeaderRow(matrix);
  const seen = new Map();
  const headers = (matrix[headerRow] || []).map((c, i) => {
    let name = String(c ?? '').replace(/\s+/g, ' ').trim() || `Coluna ${i + 1}`;
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });
  const rows = [];
  matrix.slice(headerRow + 1).forEach((cells, i) => {
    if (cells.some(c => String(c ?? '').trim() !== '')) rows.push({ cells, excelRow: offset + headerRow + i + 2 });
  });
  return { headers, rows, headerRow };
}

function detectHeaderRow(matrix) {
  const synonyms = new Set(state.meta.importFields.flatMap(f => f.synonyms));
  let best = 0, bestScore = -1;
  matrix.slice(0, 25).forEach((row, i) => {
    const keys = row.map(normKey).filter(Boolean);
    const score = keys.filter(k => synonyms.has(k)).length * 3 + Math.min(keys.length, 5) * 0.1;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

function autoMap(headers, fields) {
  const keys = headers.map(normKey);
  const map = {};
  const used = new Set();
  for (const f of fields) {
    const i = keys.findIndex((k, idx) => !used.has(idx) && f.synonyms.includes(k));
    if (i >= 0) { map[f.key] = i; used.add(i); }
  }
  const candidates = [];
  for (const f of fields) {
    if (map[f.key] !== undefined) continue;
    for (const s of f.synonyms) {
      if (s.length < 4) continue;
      keys.forEach((k, idx) => { if (k.includes(s)) candidates.push({ key: f.key, idx, len: s.length }); });
    }
  }
  candidates.sort((a, b) => b.len - a.len);
  for (const c of candidates) {
    if (map[c.key] !== undefined || used.has(c.idx)) continue;
    map[c.key] = c.idx; used.add(c.idx);
  }
  return map;
}

function display(value) {
  if (value instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  return value === null || value === undefined ? '' : typeof value === 'string' ? value.trim() : value;
}

function mapValues(cells, mapping) {
  const out = {};
  for (const [key, idx] of Object.entries(mapping)) out[key] = display(cells[idx]);
  return out;
}

// Mesma regra do servidor: mapa de Filial → Regional da planilha → Filial com nome de regional → padrão.
function forecastRegion(values, branches, defaultRegionId) {
  const byName = new Map(state.regions.filter(r => r.active).map(r => [normKey(r.name), r]));
  const bk = normKey(values.branch);
  const b = bk && branches.find(x => normKey(x.name) === bk);
  if (b) return b.region_name;
  const rk = normKey(values.region_label);
  if (rk && byName.has(rk)) return byName.get(rk).name;
  if (bk && byName.has(bk)) return byName.get(bk).name;
  if (defaultRegionId) return state.regions.find(r => r.id === defaultRegionId)?.name || 'Sem regional';
  return 'Sem regional';
}
