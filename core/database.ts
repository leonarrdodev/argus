import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const homeDir = os.homedir();
const dataDir = path.join(homeDir, 'argus/data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'argus.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Esquema do Banco de Dados
db.exec(`
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

  CREATE TABLE IF NOT EXISTS habilidades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    area        TEXT    NOT NULL UNIQUE,
    nivel       INTEGER NOT NULL DEFAULT 1 CHECK(nivel BETWEEN 1 AND 5),
    confianca   INTEGER NOT NULL DEFAULT 30 CHECK(confianca BETWEEN 0 AND 100),
    origem      TEXT    NOT NULL DEFAULT 'inferido',
    evidencia   TEXT,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

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

  CREATE TABLE IF NOT EXISTS preferencias (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria   TEXT    NOT NULL,
    chave       TEXT    NOT NULL,
    valor       TEXT    NOT NULL,
    origem      TEXT    NOT NULL DEFAULT 'inferido',
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(categoria, chave)
  );

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

  CREATE TABLE IF NOT EXISTS historico_chat (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sessao_id   TEXT    NOT NULL,
    papel       TEXT    NOT NULL,
    conteudo    TEXT    NOT NULL,
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS fatos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chave       TEXT    NOT NULL UNIQUE,
    valor       TEXT    NOT NULL,
    projeto_id  INTEGER REFERENCES projetos(id) ON DELETE SET NULL,
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS snippets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    descricao   TEXT    NOT NULL,
    codigo      TEXT    NOT NULL,
    linguagem   TEXT    DEFAULT 'bash',
    tags        TEXT    DEFAULT '[]',
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cache_respostas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pergunta_limpa  TEXT    NOT NULL UNIQUE,
    resposta        TEXT    NOT NULL,
    acessos         INTEGER NOT NULL DEFAULT 1,
    criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
    ultimo_uso      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS fila_leitura (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fonte       TEXT    NOT NULL,
    conteudo    TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pendente',
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS fila_leitura (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fonte       TEXT    NOT NULL,
    conteudo    TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pendente',
    criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`DROP TABLE IF EXISTS base_conhecimento;`);

db.exec(`
  CREATE VIRTUAL TABLE base_conhecimento USING fts5(
    fonte,
    topico,
    resumo,
    tags,
    tokenize='porter'
  );
`);

// Exportação dos módulos de acesso
export const snippets = {
  salvar: (descricao: string, codigo: string, linguagem = 'bash') => {
    db.prepare(`INSERT INTO snippets (descricao, codigo, linguagem) VALUES (?, ?, ?)`).run(descricao, codigo, linguagem);
  },
  buscarPorPalavraChave: (palavra: string) => {
    return db.prepare(`SELECT * FROM snippets WHERE descricao LIKE ? ORDER BY criado_em DESC LIMIT 3`).all(`%${palavra}%`) as any[];
  },
};

export const repository = {
  saveFato: (chave: string, valor: string) => {
    db.prepare(`INSERT INTO fatos (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(chave, valor);
  },
};

export const historico = {
  add: (sessaoId: string, papel: string, conteudo: string) => {
    db.prepare(`INSERT INTO historico_chat (sessao_id, papel, conteudo) VALUES (?, ?, ?)`).run(sessaoId, papel, conteudo);
  },
  getSessao: (sessaoId: string, limite = 20) => {
    return db.prepare(`SELECT papel, conteudo FROM historico_chat WHERE sessao_id = ? ORDER BY criado_em ASC LIMIT ?`).all(sessaoId, limite) as any[];
  },
};

export const cacheRespostas = {
  salvar: (pergunta: string, resposta: string) => {
    db.prepare(`INSERT INTO cache_respostas (pergunta_limpa, resposta) VALUES (?, ?) ON CONFLICT(pergunta_limpa) DO UPDATE SET acessos = acessos + 1, ultimo_uso = CURRENT_TIMESTAMP`).run(pergunta, resposta);
  },
  buscar: (pergunta: string) => {
    const row = db.prepare(`SELECT resposta FROM cache_respostas WHERE pergunta_limpa = ?`).get(pergunta) as any;
    if (row) {
      db.prepare(`UPDATE cache_respostas SET acessos = acessos + 1, ultimo_uso = CURRENT_TIMESTAMP WHERE pergunta_limpa = ?`).run(pergunta);
      return row.resposta;
    }
    return null;
  },
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
  },
  // 👇 NOVA FUNÇÃO ADICIONADA:
  estatisticas: () => {
    const total = (db.prepare(`SELECT COUNT(*) as c FROM fila_leitura`).get() as any).c;
    const pendentes = (db.prepare(`SELECT COUNT(*) as c FROM fila_leitura WHERE status = 'pendente'`).get() as any).c;
    const processando = (db.prepare(`SELECT COUNT(*) as c FROM fila_leitura WHERE status = 'processando'`).get() as any).c;
    const concluidos = (db.prepare(`SELECT COUNT(*) as c FROM fila_leitura WHERE status = 'concluido'`).get() as any).c;
    const erros = (db.prepare(`SELECT COUNT(*) as c FROM fila_leitura WHERE status = 'erro'`).get() as any).c;
    return { total, pendentes, processando, concluidos, erros };
  }
};

export const ragDatabase = {
  salvarFragmentoExtraido: (fonte: string, topico: string, resumo: string, tags: string) => {
    db.prepare(`INSERT INTO base_conhecimento (fonte, topico, resumo, tags) VALUES (?, ?, ?, ?)`).run(fonte, topico, resumo, tags);
  },
  buscarFTS: (termo: string) => {
    if (!termo || termo.length < 3) return [];
    try {
        // Query FTS5 corrigida: o MATCH deve referenciar a tabela virtual de forma correta
        return db.prepare(`SELECT * FROM base_conhecimento WHERE base_conhecimento MATCH ? ORDER BY rank LIMIT 3`).all(termo) as any[];
    } catch (e) {
        console.warn("[DB] Erro FTS5, usando busca LIKE como fallback.");
        return db.prepare(`SELECT * FROM base_conhecimento WHERE topico LIKE ? OR resumo LIKE ? LIMIT 3`).all(`%${termo}%`, `%${termo}%`) as any[];
    }
  },
};

export default db;