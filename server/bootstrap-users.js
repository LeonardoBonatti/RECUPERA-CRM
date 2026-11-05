// Acessos iniciais de uma instalação nova.
//
// Nenhum dado pessoal fica no código: a lista vem da variável de ambiente BOOTSTRAP_USERS (JSON),
// configurada só no servidor (Vercel → Settings → Environment Variables). Cada e-mail da lista é
// criado se ainda não existir; depois disso a pessoa é gerenciada pela tela "Equipe e acessos"
// (nome, perfil, regionais e apelidos), e a lista não sobrescreve o que foi alterado lá.
//
// Formato (veja .env.example):
//   [{"name":"Fulano","email":"fulano@empresa.com","role":"NACIONAL"},
//    {"name":"Beltrana","email":"beltrana@empresa.com","role":"REGIONAL","regions":["Sudeste"]},
//    {"name":"Ciclano","email":"ciclano@empresa.com","role":"EXECUTIVO","region":"Sudeste","aliases":["Ciclano S."]}]
// role: NACIONAL | REGIONAL | EXECUTIVO | VISUALIZADOR. REGIONAL usa `regions`; EXECUTIVO usa `region`.
// aliases: como o nome aparece nas colunas de gerente/vendedor das planilhas.

// Senha inicial (troca obrigatória no 1º login). Sem ADMIN_PASSWORD, cada acesso criado recebe
// uma senha aleatória, e o Gerente Nacional entrega o acesso pela tela ("Gerar acesso").
export const INITIAL_PASSWORD = process.env.ADMIN_PASSWORD || null;

function loadFromEnv() {
  const raw = process.env.BOOTSTRAP_USERS;
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(u => u && typeof u.email === 'string' && u.role) : [];
  } catch {
    console.warn('[acessos] BOOTSTRAP_USERS não é um JSON válido; ignorado.');
    return [];
  }
}

export const BOOTSTRAP_USERS = loadFromEnv();
