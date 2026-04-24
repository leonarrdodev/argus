import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { filaLeitura } from './database.js';

const require    = createRequire(import.meta.url);
const pdfParse   = require('pdf-parse');

const DOCS_PATH  = path.join(os.homedir(), 'argus/docs_pendentes');

async function enfileirarPdf(arquivo: string, onEnfileirado: () => void) {
    const filePath = path.join(DOCS_PATH, arquivo);

    console.log(`[WATCHER] Novo PDF detectado: ${arquivo}`);

    try {
        const buffer    = fs.readFileSync(filePath);
        const data      = await pdfParse(buffer);
        const paragrafos = data.text
            .split('\n\n')
            .filter((t: string) => t.trim().length > 50);

        let chunkAtual = '';
        let total      = 0;

        for (const p of paragrafos) {
            if (chunkAtual.length + p.length > 1_000) {
                filaLeitura.adicionar(arquivo, chunkAtual.trim());
                total++;
                chunkAtual = p + '\n\n';
            } else {
                chunkAtual += p + '\n\n';
            }
        }

        if (chunkAtual.trim().length > 0) {
            filaLeitura.adicionar(arquivo, chunkAtual.trim());
            total++;
        }

        fs.renameSync(filePath, path.join(DOCS_PATH, `${arquivo}.lido`));
        console.log(`[WATCHER] ${total} fragmentos de "${arquivo}" enfileirados.`);

        onEnfileirado();
    } catch (error) {
        console.error(`[WATCHER] Erro ao processar "${arquivo}":`, error);
    }
}

export function iniciarWatcher(onEnfileirado: () => void) {
    if (!fs.existsSync(DOCS_PATH)) {
        fs.mkdirSync(DOCS_PATH, { recursive: true });
    }

    fs.watch(DOCS_PATH, (_evento, nomeArquivo) => {
        if (!nomeArquivo || !nomeArquivo.endsWith('.pdf')) return;

        const filePath = path.join(DOCS_PATH, nomeArquivo);

        // Pequeno delay para garantir que o arquivo terminou de ser copiado
        setTimeout(() => {
            if (fs.existsSync(filePath)) {
                enfileirarPdf(nomeArquivo, onEnfileirado);
            }
        }, 500);
    });

    console.log(`[WATCHER] Monitorando pasta: ${DOCS_PATH}`);
}