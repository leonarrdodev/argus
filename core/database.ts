import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Garante que a pasta 'data' exista na raiz do projeto
const homeDir = os.homedir();
const dataDir = path.join(homeDir, 'argus/data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'argus.sqlite');
const db = new Database(dbPath);

// Criar a tabela de memória global (Onde o Argus Principal guarda fatos)
db.exec(`
    CREATE TABLE IF NOT EXISTS fatos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chave TEXT UNIQUE,
        valor TEXT,
        projeto TEXT DEFAULT 'global',
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

export const repository = {
    saveFato: (chave: string, valor: string, projeto = 'global') => {
        const stmt = db.prepare('INSERT OR REPLACE INTO fatos (chave, valor, projeto) VALUES (?, ?, ?)');
        return stmt.run(chave, valor, projeto);
    },

    getFato: (chave: string) => {
        const stmt = db.prepare('SELECT valor FROM fatos WHERE chave = ?');
        return stmt.get(chave) as { valor: string } | undefined;
    },

    listFatos: (projeto = 'global') => {
        const stmt = db.prepare('SELECT chave, valor FROM fatos WHERE projeto = ?');
        return stmt.all(projeto);
    }
};

export default db;