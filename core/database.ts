import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ─── Setup ────────────────────────────────────────────────────────────────────

const homeDir = os.homedir();
const dataDir = path.join(homeDir, 'argus/data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'argus.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`

  -- Projetos que o ARGUS conhece.
  -- O standby lê essa tabela pra saber onde olhar.
  CREATE TABLE IF NOT EXISTS projetos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT    NOT NULL UNIQUE,
    caminho     TEXT    NOT NULL,
    descricao   TEXT,
    stack       TEXT,                      -- JSON array: ["typescript","sqlite"]
    ativo       INTEGER NOT NULL DEFAULT 1,
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP,
    analisado_em DATETIME                  -- última vez que o standby analisou
  );

  -- Habilidades mapeadas do Leo.
  -- nivel: 1-5. confianca: 0-100 (ajustado conforme confirmações).
  -- origem: 'inferido' | 'confirmado' | 'declarado'
  CREATE TABLE IF NOT EXISTS habilidades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    area        TEXT    NOT NULL UNIQUE,
    nivel       INTEGER NOT NULL DEFAULT 1 CHECK(nivel BETWEEN 1 AND 5),
    confianca   INTEGER NOT NULL DEFAULT 30 CHECK(confianca BETWEEN 0 AND 100),
    origem      TEXT    NOT NULL DEFAULT 'inferido',
    evidencia   TEXT,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Gaps: pontos cegos ou fracos identificados.
  -- status: 'suspeito' | 'confirmado' | 'resolvido'
  CREATE TABLE IF NOT EXISTS gaps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    conceito    TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'suspeito',
    evidencia   TEXT    NOT NULL,
    area        TEXT,
    origem      TEXT,
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Preferências do Leo: estilo, hábitos, padrões de comportamento.
  -- categoria: 'codigo' | 'habito' | 'aprendizado' | 'comportamento'
  CREATE TABLE IF NOT EXISTS preferencias (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria   TEXT    NOT NULL,
    chave       TEXT    NOT NULL,
    valor       TEXT    NOT NULL,
    origem      TEXT    NOT NULL DEFAULT 'inferido',
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(categoria, chave)
  );

  -- Observações geradas pelo standby.
  -- tags em JSON array para filtragem por intenção.
  CREATE TABLE IF NOT EXISTS observacoes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    projeto_id  INTEGER REFERENCES projetos(id) ON DELETE SET NULL,
    tipo        TEXT    NOT NULL,          -- 'analise_codigo' | 'padrao' | 'anomalia' | 'progresso'
    conteudo    TEXT    NOT NULL,
    tags        TEXT    NOT NULL DEFAULT '[]',
    relevancia  INTEGER NOT NULL DEFAULT 50 CHECK(relevancia BETWEEN 0 AND 100),
    lida        INTEGER NOT NULL DEFAULT 0,
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Sessões de interrogatório (avaliação de perfil).
  CREATE TABLE IF NOT EXISTS sessoes_avaliacao (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contexto      TEXT,
    perguntas     TEXT    NOT NULL DEFAULT '[]', -- JSON: [{pergunta, resposta}]
    gaps_abertos  TEXT    NOT NULL DEFAULT '[]', -- JSON: [gap_id]
    gaps_fechados TEXT    NOT NULL DEFAULT '[]',
    resumo        TEXT,
    criado_em     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Histórico de conversa por sessão.
  -- Necessário para o LLM ter memória de curto prazo.
  CREATE TABLE IF NOT EXISTS historico_chat (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sessao_id   TEXT    NOT NULL,
    papel       TEXT    NOT NULL,          -- 'user' | 'assistant'
    conteudo    TEXT    NOT NULL,
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Fatos gerais (mantido para compatibilidade).
  CREATE TABLE IF NOT EXISTS fatos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chave       TEXT    NOT NULL UNIQUE,
    valor       TEXT    NOT NULL,
    projeto_id  INTEGER REFERENCES projetos(id) ON DELETE SET NULL,
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

`);

// ─── Repositórios ─────────────────────────────────────────────────────────────

export const projetos = {
  save: (nome: string, caminho: string, descricao?: string, stack?: string[]) => {
    return db.prepare(`
      INSERT INTO projetos (nome, caminho, descricao, stack)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(nome) DO UPDATE SET
        caminho   = excluded.caminho,
        descricao = excluded.descricao,
        stack     = excluded.stack
    `).run(nome, caminho, descricao ?? null, stack ? JSON.stringify(stack) : null);
  },

  marcarAnalisado: (id: number) => {
    db.prepare(`UPDATE projetos SET analisado_em = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  },

  listAtivos: () => {
    return db.prepare(`SELECT * FROM projetos WHERE ativo = 1 ORDER BY analisado_em ASC NULLS FIRST`).all() as ProjetoDB[];
  },

  getByNome: (nome: string) => {
    return db.prepare(`SELECT * FROM projetos WHERE nome = ?`).get(nome) as ProjetoDB | undefined;
  },
};

export const habilidades = {
  upsert: (area: string, nivel: number, origem: 'inferido' | 'confirmado' | 'declarado', evidencia?: string, confiancaDelta = 0) => {
    const existente = db.prepare(`SELECT * FROM habilidades WHERE area = ?`).get(area) as HabilidadeDB | undefined;

    if (existente) {
      const novaConfianca = Math.min(100, Math.max(0, existente.confianca + confiancaDelta));
      db.prepare(`
        UPDATE habilidades
        SET nivel = ?, confianca = ?, origem = ?, evidencia = ?, atualizado_em = CURRENT_TIMESTAMP
        WHERE area = ?
      `).run(nivel, novaConfianca, origem, evidencia ?? existente.evidencia, area);
    } else {
      const confiancaInicial = origem === 'confirmado' ? 80 : origem === 'declarado' ? 70 : 30;
      db.prepare(`
        INSERT INTO habilidades (area, nivel, confianca, origem, evidencia)
        VALUES (?, ?, ?, ?, ?)
      `).run(area, nivel, confiancaInicial, origem, evidencia ?? null);
    }
  },

  getAll: () => db.prepare(`SELECT * FROM habilidades ORDER BY area`).all() as HabilidadeDB[],
  getByArea: (area: string) => db.prepare(`SELECT * FROM habilidades WHERE area = ?`).get(area) as HabilidadeDB | undefined,
};

export const gaps = {
  abrir: (conceito: string, evidencia: string, area?: string, origem?: string) => {
    const existente = db.prepare(`SELECT id FROM gaps WHERE conceito = ? AND status != 'resolvido'`).get(conceito);
    if (existente) return existente;
    return db.prepare(`INSERT INTO gaps (conceito, evidencia, area, origem) VALUES (?, ?, ?, ?)`)
      .run(conceito, evidencia, area ?? null, origem ?? null);
  },

  confirmar: (id: number) => {
    db.prepare(`UPDATE gaps SET status = 'confirmado', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  },

  resolver: (id: number) => {
    db.prepare(`UPDATE gaps SET status = 'resolvido', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  },

  listAtivos: () => db.prepare(`SELECT * FROM gaps WHERE status != 'resolvido' ORDER BY criado_em DESC`).all() as GapDB[],
  listPorArea: (area: string) => db.prepare(`SELECT * FROM gaps WHERE area = ? AND status != 'resolvido'`).all(area) as GapDB[],
};

export const preferencias = {
  set: (categoria: string, chave: string, valor: string, origem: 'declarado' | 'inferido' = 'inferido') => {
    db.prepare(`
      INSERT INTO preferencias (categoria, chave, valor, origem)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(categoria, chave) DO UPDATE SET valor = excluded.valor, origem = excluded.origem
    `).run(categoria, chave, valor, origem);
  },

  getAll: () => db.prepare(`SELECT * FROM preferencias ORDER BY categoria, chave`).all() as PreferenciaDB[],
  getByCategoria: (cat: string) => db.prepare(`SELECT * FROM preferencias WHERE categoria = ?`).all(cat) as PreferenciaDB[],
};

export const observacoes = {
  registrar: (tipo: ObservacaoTipo, conteudo: string, tags: string[], projetoId?: number, relevancia = 50) => {
    db.prepare(`INSERT INTO observacoes (projeto_id, tipo, conteudo, tags, relevancia) VALUES (?, ?, ?, ?, ?)`)
      .run(projetoId ?? null, tipo, conteudo, JSON.stringify(tags), relevancia);
  },

  // Busca por tags para o LLM sintetizar — filtragem via LIKE no JSON
  getByTags: (tags: string[], limite = 10) => {
    const cond = tags.map(() => `tags LIKE ?`).join(' OR ');
    const params = tags.map(t => `%"${t}"%`);
    return db.prepare(`
      SELECT * FROM observacoes WHERE (${cond})
      ORDER BY relevancia DESC, criado_em DESC LIMIT ?
    `).all(...params, limite) as ObservacaoDB[];
  },

  getRecentes: (limite = 20) => db.prepare(`SELECT * FROM observacoes ORDER BY criado_em DESC LIMIT ?`).all(limite) as ObservacaoDB[],
  marcarLida: (id: number) => db.prepare(`UPDATE observacoes SET lida = 1 WHERE id = ?`).run(id),
};

export const sessoesAvaliacao = {
  criar: (contexto: string) => {
    return db.prepare(`INSERT INTO sessoes_avaliacao (contexto) VALUES (?)`).run(contexto).lastInsertRowid as number;
  },

  addPergunta: (id: number, pergunta: string, resposta: string) => {
    const sessao = db.prepare(`SELECT perguntas FROM sessoes_avaliacao WHERE id = ?`).get(id) as { perguntas: string } | undefined;
    if (!sessao) return;
    const perguntas = JSON.parse(sessao.perguntas);
    perguntas.push({ pergunta, resposta });
    db.prepare(`UPDATE sessoes_avaliacao SET perguntas = ? WHERE id = ?`).run(JSON.stringify(perguntas), id);
  },

  fechar: (id: number, resumo: string, gapsAbertos: number[], gapsFechados: number[]) => {
    db.prepare(`UPDATE sessoes_avaliacao SET resumo = ?, gaps_abertos = ?, gaps_fechados = ? WHERE id = ?`)
      .run(resumo, JSON.stringify(gapsAbertos), JSON.stringify(gapsFechados), id);
  },

  getUltimas: (n = 5) => db.prepare(`SELECT * FROM sessoes_avaliacao ORDER BY criado_em DESC LIMIT ?`).all(n) as SessaoAvaliacaoDB[],
};

export const historico = {
  add: (sessaoId: string, papel: 'user' | 'assistant', conteudo: string) => {
    db.prepare(`INSERT INTO historico_chat (sessao_id, papel, conteudo) VALUES (?, ?, ?)`).run(sessaoId, papel, conteudo);
  },

  getSessao: (sessaoId: string, limite = 20) => {
    return db.prepare(`
      SELECT papel, conteudo FROM historico_chat
      WHERE sessao_id = ? ORDER BY criado_em ASC LIMIT ?
    `).all(sessaoId, limite) as { papel: string; conteudo: string }[];
  },

  limpar: (sessaoId: string) => {
    db.prepare(`DELETE FROM historico_chat WHERE sessao_id = ?`).run(sessaoId);
  },
};

// Compatibilidade com código antigo
export const repository = {
  saveFato: (chave: string, valor: string) => {
    db.prepare(`INSERT INTO fatos (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(chave, valor);
  },
  getFato: (chave: string) => db.prepare(`SELECT valor FROM fatos WHERE chave = ?`).get(chave) as { valor: string } | undefined,
  listFatos: () => db.prepare(`SELECT chave, valor FROM fatos`).all() as { chave: string; valor: string }[],
};

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ObservacaoTipo = 'analise_codigo' | 'padrao' | 'anomalia' | 'progresso';

interface ProjetoDB {
  id: number; nome: string; caminho: string;
  descricao: string | null; stack: string | null;
  ativo: number; criado_em: string; analisado_em: string | null;
}

interface HabilidadeDB {
  id: number; area: string; nivel: number;
  confianca: number; origem: string;
  evidencia: string | null; atualizado_em: string;
}

interface GapDB {
  id: number; conceito: string; status: string;
  evidencia: string; area: string | null;
  origem: string | null; criado_em: string; atualizado_em: string;
}

interface PreferenciaDB {
  id: number; categoria: string; chave: string;
  valor: string; origem: string; criado_em: string;
}

interface ObservacaoDB {
  id: number; projeto_id: number | null; tipo: string;
  conteudo: string; tags: string; relevancia: number;
  lida: number; criado_em: string;
}

interface SessaoAvaliacaoDB {
  id: number; contexto: string | null; perguntas: string;
  gaps_abertos: string; gaps_fechados: string;
  resumo: string | null; criado_em: string;
}

export default db;