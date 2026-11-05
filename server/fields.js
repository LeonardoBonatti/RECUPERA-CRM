// Fonte única da verdade para os campos do sistema.
// O frontend recebe estas definições via /api/meta e o backend valida contra elas,
// então nenhum valor fora das listas fechadas chega ao banco — nem via UI, nem via API.
//
// Domínio: uma distribuidora perde oportunidades de venda (crédito negado, condições etc.) e uma
// empresa parceira tenta recuperá-las oferecendo consórcio. Ajuste rótulos e opções aqui.

export const YES_NO = ['Sim', 'Não'];

// Etapas do Status do Contato. As finais encerram a tratativa (lead "Concluído").
export const STAGES = {
  tentativa: { label: 'Tentando contato', final: false, contacted: false },
  andamento: { label: 'Em andamento', final: false, contacted: true },
  ganho: { label: 'Cota fechada', final: true, contacted: true },
  perdido: { label: 'Sem interesse', final: true, contacted: true },
  encerrado: { label: 'Já é cliente', final: true, contacted: true },
};

// Campos preenchidos pelo Executivo de Vendas (Regra de Ouro).
// type: 'radio' | 'select' | 'text'. Somente 'contact_summary' aceita texto livre.
// aliases: grafias encontradas em planilhas antigas (chave normalizada → opção oficial),
// usadas só na importação.
export const QUALIFICATION_FIELDS = [
  {
    key: 'first_base',
    label: 'Estava na primeira base?',
    type: 'radio',
    options: YES_NO,
  },
  {
    key: 'origin_return',
    label: 'Retorno Comercial',
    type: 'select',
    options: [
      'Não tem interesse no consórcio',
      'Não ofertei consórcio',
      'Tem interesse consórcio',
      'Possui consórcio da parceira',
      'Possui consórcio no mercado',
    ],
    aliases: {
      'sem interesse': 'Não tem interesse no consórcio',
    },
  },
  {
    key: 'bought_competitor',
    label: 'Comprou Concorrente',
    type: 'radio',
    options: ['Sim', 'Não', 'Não sabe'],
  },
  {
    key: 'contact_status',
    label: 'Status do Contato',
    type: 'select',
    options: [
      { value: 'Tentando contato', stage: 'tentativa' },
      { value: 'Visita agendada', stage: 'andamento' },
      { value: 'Em negociação', stage: 'andamento' },
      { value: 'Cota fechada', stage: 'ganho' },
      { value: 'Sem interesse', stage: 'perdido' },
      { value: 'Já consorciado na parceira', stage: 'encerrado' },
      { value: 'Já consorciado no mercado', stage: 'encerrado' },
      { value: 'Cota com parcela pendente', stage: 'encerrado' },
    ],
    aliases: {
      'consorcio fechado': 'Cota fechada',
      'tentativas realizadas sem sucesso': 'Tentando contato',
    },
  },
  {
    key: 'contact_summary',
    label: 'Resumo do Contato',
    type: 'text',
    maxLength: 2000,
  },
];

export const SUMMARY_MIN_LENGTH = 10;

// Colunas da planilha base que o importador reconhece.
// synonyms são comparados após normalização (minúsculas, sem acento, só letras/números).
// Sinônimos exatos têm prioridade; depois vale "o cabeçalho contém o sinônimo".
export const IMPORT_FIELDS = [
  { key: 'client_name', label: 'Cliente (nome / razão social)', required: true,
    synonyms: ['cliente', 'nome cliente', 'nome do cliente', 'razao social', 'empresa', 'nome razao social'] },
  { key: 'client_doc', label: 'CNPJ / CPF',
    synonyms: ['cnpj cpf', 'cpf cnpj', 'cnpj', 'cpf', 'documento', 'cnpj do cliente'] },
  { key: 'region_label', label: 'Regional',
    synonyms: ['regional', 'regiao', 'gerencia regional'] },
  { key: 'branch', label: 'Filial',
    synonyms: ['filial', 'unidade', 'loja'] },
  { key: 'machine', label: 'Equipamento / Modelo',
    synonyms: ['equipamento', 'maquina', 'modelo', 'produto', 'descricao maquina'] },
  { key: 'quantity', label: 'Quantidade de máquinas',
    synonyms: ['quantidade', 'qtd', 'qtde', 'qtd maquinas', 'quantidade de maquinas'] },
  { key: 'amount', label: 'Valor total da oportunidade (R$)',
    synonyms: ['preco total', 'valor total', 'valor', 'valor oportunidade', 'valor da oportunidade', 'total'] },
  { key: 'loss_reason', label: 'Motivo da perda',
    synonyms: ['motivo', 'motivo perda', 'motivo da perda', 'motivo de perda'] },
  // Quem trabalha o lead na empresa parceira: definem a distribuição automática na importação.
  { key: 'partner_manager', label: 'Gerente parceiro (distribui automaticamente)',
    synonyms: ['gerente parceiro', 'gerente parceira', 'gerente responsavel', 'gerente consorcio'] },
  { key: 'partner_executive', label: 'Vendedor parceiro (atribui automaticamente)',
    synonyms: ['vendedor parceiro', 'vendedor parceira', 'executivo', 'executivo comercial', 'vendedor responsavel'] },
  { key: 'origin_manager', label: 'Gestor da distribuidora',
    synonyms: ['nome gestor', 'gestor', 'gestor distribuidora', 'gerente distribuidora'] },
  { key: 'origin_seller', label: 'Vendedor da distribuidora',
    synonyms: ['nome vendedor', 'vendedor', 'vendedor distribuidora', 'consultor'] },
  { key: 'phone', label: 'Telefone de contato',
    synonyms: ['contato', 'telefone', 'celular', 'fone', 'whatsapp', 'telefone contato'] },
  { key: 'contact_name', label: 'Nome do contato no cliente',
    synonyms: ['nome contato', 'nome do contato', 'responsavel'] },
  { key: 'email', label: 'E-mail', synonyms: ['email', 'e mail'] },
  { key: 'city', label: 'Cidade', synonyms: ['cidade', 'municipio'] },
  { key: 'state', label: 'UF', synonyms: ['uf', 'estado'] },
  { key: 'opportunity_date', label: 'Data da oportunidade',
    synonyms: ['data', 'data oportunidade', 'data da oportunidade', 'data perda'] },
  // Opcionais: a base costuma voltar parcialmente preenchida de rodadas anteriores.
  { key: 'first_base', label: 'Estava na primeira base?', qualification: true,
    synonyms: ['estava na primeira base', 'primeira base'] },
  { key: 'origin_return', label: 'Retorno Comercial', qualification: true,
    synonyms: ['retorno comercial', 'retorno distribuidora', 'retorno'] },
  { key: 'bought_competitor', label: 'Comprou Concorrente', qualification: true,
    synonyms: ['comprou concorrente', 'comprou do concorrente'] },
  { key: 'contact_status', label: 'Status do Contato', qualification: true,
    synonyms: ['status do contato', 'status contato'] },
  { key: 'contact_summary', label: 'Resumo do Contato', qualification: true,
    synonyms: ['resumo do contato', 'resumo contato', 'resumo', 'observacao', 'observacoes'] },
];

export const ROLES = {
  NACIONAL: 'Gerente Nacional',
  REGIONAL: 'Gerente Regional',
  EXECUTIVO: 'Executivo de Vendas',
  VISUALIZADOR: 'Visualizador',
};

export function optionValues(field) {
  return (field.options || []).map(o => (typeof o === 'string' ? o : o.value));
}

const statusField = QUALIFICATION_FIELDS.find(x => x.key === 'contact_status');

export function statusStage(value) {
  return statusField.options.find(o => o.value === value)?.stage ?? null;
}

// Listas de status por característica, usadas nas consultas do dashboard.
export function statusesWhere(predicate) {
  return statusField.options.filter(o => predicate(STAGES[o.stage], o.stage)).map(o => o.value);
}

// Um lead está "Concluído" quando todos os campos fechados foram respondidos,
// o status é final (fechou, sem interesse ou já é cliente) e existe um resumo.
export function isComplete(lead) {
  const closed = QUALIFICATION_FIELDS.filter(f => f.type !== 'text');
  if (closed.some(f => !lead[f.key])) return false;
  if (!STAGES[statusStage(lead.contact_status)]?.final) return false;
  return (lead.contact_summary || '').trim().length >= SUMMARY_MIN_LENGTH;
}
