import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { historico } from './database.js';

const PYTHON = path.join(os.homedir(), 'argus/venv/bin/python3');
const SCRIPT = path.join(os.homedir(), 'argus/scripts/brain.py');

export interface BrainResult {
    status:   'success' | 'error';
    response?: string;
    message?:  string;
}

function chamarPython(payload: object): Promise<BrainResult> {
    return new Promise((resolve, reject) => {
        const processo = spawn(PYTHON, [SCRIPT], { env: process.env });

        let stdout = '';
        let stderr = '';

        processo.stdin.write(JSON.stringify(payload));
        processo.stdin.end();

        processo.stdout.on('data', (chunk) => { stdout += chunk; });
        processo.stderr.on('data', (chunk) => { stderr += chunk; });

        processo.on('close', (code) => {
            if (stderr) console.error(`[ARGUS Brain] ${stderr.trim()}`);
            if (code !== 0) {
                return reject(new Error(`Processo Python encerrou com código ${code}`));
            }
            try {
                const result = JSON.parse(stdout) as BrainResult;
                resolve(result);
            } catch {
                reject(new Error(`Falha ao parsear resposta do Python: ${stdout}`));
            }
        });

        processo.on('error', reject);
    });
}

export async function chamarBrainDireto(payload: object): Promise<BrainResult> {
    return chamarPython(payload);
}

export async function askBrainComHistorico(
    texto: string,
    sessaoId: string,
    contextoRag = '',
): Promise<string> {
    const historicoSessao = historico.getSessao(sessaoId, 20);

    try {
        const result = await chamarPython({
            tipo:        'chat',
            text:        texto,
            historico:   historicoSessao,
            contexto_rag: contextoRag,
        });

        if (result.status === 'error') {
            return `Erro interno: ${result.message ?? 'sem detalhe'}`;
        }

        const resposta = result.response ?? '';
        historico.add(sessaoId, 'user',      texto);
        historico.add(sessaoId, 'assistant', resposta);

        return resposta;
    } catch (error: any) {
        console.error(`[ARGUS BrainBridge] Falha:`, error.message);
        return `Erro de conexão interna: ${error.message}`;
    }
}