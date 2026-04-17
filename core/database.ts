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
  CREATE TABLE IF NOT EXISTS projetos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT    NOT NULL UNIQUE,
    caminho     TEXT    NOT NULL,
    descricao   TEXT,
    stack       TEXT,
    ativo       INTEGER NOT NULL DEFAULT 1,
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP,
    analisado_em DATETIME
  );

  -- Habilidades mapeadas do Leo.
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

  -- Preferências do Leo
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
  CREATE TABLE IF NOT EXISTS observacoes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    projeto_id  INTEGER REFERENCES projetos(id) ON DELETE SET NULL,
    tipo        TEXT    NOT NULL,
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
    perguntas     TEXT    NOT NULL DEFAULT '[]',
    gaps_abertos  TEXT    NOT NULL DEFAULT '[]',
    gaps_fechados TEXT    NOT NULL DEFAULT '[]',
    resumo        TEXT,
    criado_em     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Histórico de conversa por sessão.
  CREATE TABLE IF NOT EXISTS historico_chat (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sessao_id   TEXT    NOT NULL,
    papel       TEXT    NOT NULL,
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

  -- Snippets Salvos Rapidamente
  CREATE TABLE IF NOT EXISTS snippets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    descricao   TEXT    NOT NULL,
    codigo      TEXT    NOT NULL,
    linguagem   TEXT    DEFAULT 'bash',
    tags        TEXT    DEFAULT '[]',
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- [NOVO] Cache de Conhecimento (Camada 3)
  CREATE TABLE IF NOT EXISTS cache_respostas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pergunta_limpa  TEXT    NOT NULL UNIQUE,
    resposta        TEXT    NOT NULL,
    acessos         INTEGER NOT NULL DEFAULT 1,
    criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
    ultimo_uso      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- [NOVO] Tabela Temporária de Fila de Leitura
  CREATE TABLE IF NOT EXISTS fila_leitura (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fonte       TEXT    NOT NULL,
    conteudo    TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pendente', -- 'pendente', 'processando', 'concluido', 'erro'
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- [NOVO] Base de Conhecimento RAG usando FTS5 para busca hiper-rápida
  CREATE VIRTUAL TABLE IF NOT EXISTS base_conhecimento USING fts5(
    fonte,
    topico,
    resumo,
    tags,
    tokenize='porter'
  );
`);

// ─── Repositórios Antigos ────────────────────────────────────────────────────

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
    return db.prepare(`SELECT * FROM projetos WHERE ativo = 1 ORDER BY analisado_em ASC NULLS FIRST`).all();
  },
  getByNome: (nome: string) => {
    return db.prepare(`SELECT * FROM projetos WHERE nome = ?`).get(nome);
  },
};

export const habilidades = {
  upsert: (area: string, nivel: number, origem: 'inferido' | 'confirmado' | 'declarado', evidencia?: string, confiancaDelta = 0) => {
    const existente = db.prepare(`SELECT * FROM habilidades WHERE area = ?`).get(area) as any;
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
  getAll: () => db.prepare(`SELECT * FROM habilidades ORDER BY area`).all(),
  getByArea: (area: string) => db.prepare(`SELECT * FROM habilidades WHERE area = ?`).get(area),
};

export const gaps = {
  abrir: (conceito: string, evidencia: string, area?: string, origem?: string) => {
    const existente = db.prepare(`SELECT id FROM gaps WHERE conceito = ? AND status != 'resolvido'`).get(conceito);
    if (existente) return existente;
    return db.prepare(`INSERT INTO gaps (conceito, evidencia, area, origem) VALUES (?, ?, ?, ?)`)
      .run(conceito, evidencia, area ?? null, origem ?? null);
  },
  confirmar: (id: number) => db.prepare(`UPDATE gaps SET status = 'confirmado', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).run(id),
  resolver: (id: number) => db.prepare(`UPDATE gaps SET status = 'resolvido', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`).run(id),
  listAtivos: () => db.prepare(`SELECT * FROM gaps WHERE status != 'resolvido' ORDER BY criado_em DESC`).all(),
  listPorArea: (area: string) => db.prepare(`SELECT * FROM gaps WHERE area = ? AND status != 'resolvido'`).all(area),
};

export const preferencias = {
  set: (categoria: string, chave: string, valor: string, origem: 'declarado' | 'inferido' = 'inferido') => {
    db.prepare(`
      INSERT INTO preferencias (categoria, chave, valor, origem)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(categoria, chave) DO UPDATE SET valor = excluded.valor, origem = excluded.origem
    `).run(categoria, chave, valor, origem);
  },
  getAll: () => db.prepare(`SELECT * FROM preferencias ORDER BY categoria, chave`).all(),
  getByCategoria: (cat: string) => db.prepare(`SELECT * FROM preferencias WHERE categoria = ?`).all(cat),
};

export const observacoes = {
  registrar: (tipo: string, conteudo: string, tags: string[], projetoId?: number, relevancia = 50) => {
    db.prepare(`INSERT INTO observacoes (projeto_id, tipo, conteudo, tags, relevancia) VALUES (?, ?, ?, ?, ?)`)
      .run(projetoId ?? null, tipo, conteudo, JSON.stringify(tags), relevancia);
  },
  getByTags: (tags: string[], limite = 10) => {
    const cond = tags.map(() => `tags LIKE ?`).join(' OR ');
    const params = tags.map(t => `%"${t}"%`);
    return db.prepare(`SELECT * FROM observacoes WHERE (${cond}) ORDER BY relevancia DESC, criado_em DESC LIMIT ?`).all(...params, limite);
  },
  getRecentes: (limite = 20) => db.prepare(`SELECT * FROM observacoes ORDER BY criado_em DESC LIMIT ?`).all(limite),
  marcarLida: (id: number) => db.prepare(`UPDATE observacoes SET lida = 1 WHERE id = ?`).run(id),
};

export const sessoesAvaliacao = {
  criar: (contexto: string) => db.prepare(`INSERT INTO sessoes_avaliacao (contexto) VALUES (?)`).run(contexto).lastInsertRowid,
  addPergunta: (id: number, pergunta: string, resposta: string) => {
    const sessao = db.prepare(`SELECT perguntas FROM sessoes_avaliacao WHERE id = ?`).get(id) as any;
    if (!sessao) return;
    const perguntas = JSON.parse(sessao.perguntas);
    perguntas.push({ pergunta, resposta });
    db.prepare(`UPDATE sessoes_avaliacao SET perguntas = ? WHERE id = ?`).run(JSON.stringify(perguntas), id);
  },
  fechar: (id: number, resumo: string, gapsAbertos: number[], gapsFechados: number[]) => {
    db.prepare(`UPDATE sessoes_avaliacao SET resumo = ?, gaps_abertos = ?, gaps_fechados = ? WHERE id = ?`)
      .run(resumo, JSON.stringify(gapsAbertos), JSON.stringify(gapsFechados), id);
  },
  getUltimas: (n = 5) => db.prepare(`SELECT * FROM sessoes_avaliacao ORDER BY criado_em DESC LIMIT ?`).all(n),
};

export const historico = {
  add: (sessaoId: string, papel: string, conteudo: string) => {
    db.prepare(`INSERT INTO historico_chat (sessao_id, papel, conteudo) VALUES (?, ?, ?)`).run(sessaoId, papel, conteudo);
  },
  getSessao: (sessaoId: string, limite = 20) => {
    return db.prepare(`SELECT papel, conteudo FROM historico_chat WHERE sessao_id = ? ORDER BY criado_em ASC LIMIT ?`).all(sessaoId, limite);
  },
  limpar: (sessaoId: string) => db.prepare(`DELETE FROM historico_chat WHERE sessao_id = ?`).run(sessaoId),
};

export const repository = {
  saveFato: (chave: string, valor: string) => {
    db.prepare(`INSERT INTO fatos (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(chave, valor);
  },
  getFato: (chave: string) => db.prepare(`SELECT valor FROM fatos WHERE chave = ?`).get(chave) as { valor: string } | undefined,
  listFatos: () => db.prepare(`SELECT chave, valor FROM fatos`).all() as { chave: string; valor: string }[],
};

export const snippets = {
  salvar: (descricao: string, codigo: string, linguagem = 'bash') => {
    db.prepare(`INSERT INTO snippets (descricao, codigo, linguagem) VALUES (?, ?, ?)`).run(descricao, codigo, linguagem);
  },
  buscarTodos: () => db.prepare(`SELECT * FROM snippets ORDER BY criado_em DESC`).all(),
  buscarPorPalavraChave: (palavra: string) => {
      return db.prepare(`SELECT * FROM snippets WHERE descricao LIKE ? ORDER BY criado_em DESC LIMIT 3`).all(`%${palavra}%`) as any[];
  }
};

// ─── Novos Repositórios (RAG, NLP e Cache) ───────────────────────────────────

export const cacheRespostas = {
  salvar: (pergunta: string, resposta: string) => {
      const sql = `
          INSERT INTO cache_respostas (pergunta_limpa, resposta) 
          VALUES (?, ?) 
          ON CONFLICT(pergunta_limpa) DO UPDATE SET 
          acessos = acessos + 1, 
          ultimo_uso = CURRENT_TIMESTAMP
      `;
      db.prepare(sql).run(pergunta, resposta);
  },
  buscar: (pergunta: string) => {
      const row = db.prepare(`SELECT resposta FROM cache_respostas WHERE pergunta_limpa = ?`).get(pergunta) as any;
      if (row) {
          db.prepare(`UPDATE cache_respostas SET acessos = acessos + 1, ultimo_uso = CURRENT_TIMESTAMP WHERE pergunta_limpa = ?`).run(pergunta);
          return row.resposta;
      }
      return null;
  }
};

export const filaLeitura = {
  adicionar: (fonte: string, conteudo: string) => {
      db.prepare(`INSERT INTO fila_leitura (fonte, conteudo) VALUES (?, ?)`).run(fonte, conteudo);
  },
  obterPendente: () => {
      return db.prepare(`SELECT * FROM fila_leitura WHERE status = 'pendente' ORDER BY id ASC LIMIT 1`).get() as any;
  },
  marcarStatus: (id: number, status: string) => {
      db.prepare(`UPDATE fila_leitura SET status = ? WHERE id = ?`).run(status, id);
  }
};

export const ragDatabase = {
  salvarFragmentoExtraido: (fonte: string, topico: string, resumo: string, tags: string) => {
      db.prepare(`INSERT INTO base_conhecimento (fonte, topico, resumo, tags) VALUES (?, ?, ?, ?)`).run(fonte, topico, resumo, tags);
  },
  buscarFTS: (termo: string) => {
      if (!termo || termo.length < 3) return [];
      const termoLimpo = termo.replace(/[^\w\s]/gi, '').trim().split(' ').join(' OR ');
      const sql = `SELECT * FROM base_conhecimento WHERE base_conhecimento MATCH ? ORDER BY rank LIMIT 3`;
      return db.prepare(sql).all(termoLimpo) as any[];
  }
};

export default db;