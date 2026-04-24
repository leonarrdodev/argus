import express from 'express';
import http from 'http';
import { Server } from 'socket.io'
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import multer from 'multer';

import { filaLeitura, ragDatabase, historico } from './database.js';
import { nlpRouter } from './nlpRouter.js';
import { chamarBrainDireto, askBrainComHistorico } from './brainBridge.js';

const execAsync = promisify(exec);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// ─── Caminhos (base única: ~/argus) ──────────────────────────────────────────

const BASE_DIR   = path.join(os.homedir(), 'argus');
const UPLOAD_DIR = path.join(BASE_DIR, 'docs_pendentes');
const PYTHON     = path.join(BASE_DIR, 'venv/bin/python3');
const LER_PDF    = path.join(BASE_DIR, 'scripts/ler_pdf.py');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Estado do worker de aprendizado ─────────────────────────────────────────

type WorkerStatus = 'ocioso' | 'rodando' | 'pausado';

let workerStatus: WorkerStatus = 'ocioso';
let workerTimer:  ReturnType<typeof setTimeout> | null = null;

function emitirStatusAprendizado() {
    const stats = filaLeitura.estatisticas();
    io.emit('status_aprendizado', { ...stats, worker: workerStatus });
}

async function processarProximoFragmento() {
    if (workerStatus !== 'rodando') return;

    const pendente = filaLeitura.obterPendente();

    if (!pendente) {
        // Fila vazia — encerra o worker automaticamente
        workerStatus = 'ocioso';
        emitirStatusAprendizado();
        console.log('[APRENDER] Fila concluída. Worker encerrado.');
        return;
    }

    console.log(`[APRENDER] Processando fragmento ID ${pendente.id}...`);
    filaLeitura.marcarStatus(pendente.id, 'processando');
    emitirStatusAprendizado();

    try {
        const result = await chamarBrainDireto({
            tipo: 'extrair',
            text: pendente.conteudo,
        });

        if (result.status === 'error') {
            throw new Error(result.message ?? 'Erro desconhecido na extração');
        }

        const extraido = JSON.parse(result.response ?? '{}');
        ragDatabase.salvarFragmentoExtraido(
            pendente.fonte,
            extraido.topico  ?? 'sem tópico',
            extraido.resumo  ?? '',
            extraido.tags    ?? '',
        );
        filaLeitura.marcarStatus(pendente.id, 'concluido');
        console.log(`[APRENDER] Assimilado: ${extraido.topico}`);
    } catch (err) {
        console.error('[APRENDER] Falha:', err);
        filaLeitura.marcarStatus(pendente.id, 'erro');
    }

    emitirStatusAprendizado();

    // Agenda o próximo fragmento com intervalo de 5s (respeita cota de API)
    if (workerStatus === 'rodando') {
        workerTimer = setTimeout(processarProximoFragmento, 5_000);
    }
}

// ─── Endpoints de controle do aprendizado ────────────────────────────────────

app.post('/aprender/iniciar', (_req, res) => {
    if (workerStatus === 'rodando') {
        res.json({ ok: false, mensagem: 'Worker já está rodando.' });
        return;
    }

    const stats = filaLeitura.estatisticas();
    if (stats.pendentes === 0) {
        res.json({ ok: false, mensagem: 'Nenhum fragmento pendente na fila.' });
        return;
    }

    workerStatus = 'rodando';
    emitirStatusAprendizado();
    processarProximoFragmento();
    res.json({ ok: true, mensagem: 'Aprendizado iniciado.' });
});

app.post('/aprender/pausar', (_req, res) => {
    if (workerStatus !== 'rodando') {
        res.json({ ok: false, mensagem: 'Worker não está rodando.' });
        return;
    }

    workerStatus = 'pausado';
    if (workerTimer) { clearTimeout(workerTimer); workerTimer = null; }
    emitirStatusAprendizado();
    res.json({ ok: true, mensagem: 'Aprendizado pausado.' });
});

app.post('/aprender/cancelar', (_req, res) => {
    if (workerStatus === 'ocioso') {
        res.json({ ok: false, mensagem: 'Worker já está ocioso.' });
        return;
    }

    workerStatus = 'ocioso';
    if (workerTimer) { clearTimeout(workerTimer); workerTimer = null; }
    emitirStatusAprendizado();
    res.json({ ok: true, mensagem: 'Aprendizado cancelado.' });
});

app.get('/aprender/status', (_req, res) => {
    res.json({ ...filaLeitura.estatisticas(), worker: workerStatus });
});

// ─── Upload de PDF ────────────────────────────────────────────────────────────

const upload = multer({ dest: UPLOAD_DIR });

app.post('/upload', upload.single('documento'), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ erro: 'Nenhum documento fornecido.' });
        return;
    }

    const caminhoArquivo = path.resolve(req.file.path);

    try {
        const { stdout, stderr } = await execAsync(
            `"${PYTHON}" "${LER_PDF}" "${caminhoArquivo}"`
        );

        if (stderr && stderr.includes('ERRO_PYTHON')) {
            throw new Error(stderr);
        }

        const paragrafos = stdout.split('\n\n');
        let chunkAtual   = '';
        let total        = 0;

        for (const p of paragrafos) {
            const limpo = p.trim();
            if (!limpo) continue;

            if (chunkAtual.length + limpo.length > 1_000) {
                filaLeitura.adicionar(req.file.originalname, chunkAtual.trim());
                total++;
                chunkAtual = limpo + '\n\n';
            } else {
                chunkAtual += limpo + '\n\n';
            }
        }

        if (chunkAtual.trim().length > 0) {
            filaLeitura.adicionar(req.file.originalname, chunkAtual.trim());
            total++;
        }

        await fsp.unlink(caminhoArquivo);
        emitirStatusAprendizado();

        res.json({ mensagem: `${total} fragmentos enfileirados. Clique em Iniciar para aprender.` });
    } catch (err) {
        console.error('[UPLOAD ERROR]', err);
        if (fs.existsSync(caminhoArquivo)) await fsp.unlink(caminhoArquivo).catch(() => {});
        res.status(500).json({ erro: 'Falha ao processar PDF.' });
    }
});

// ─── Chat ─────────────────────────────────────────────────────────────────────

app.post('/chat', async (req, res) => {
    const { texto, sessaoId = 'web' } = req.body as { texto?: string; sessaoId?: string };

    if (!texto || texto.trim() === '') {
        res.status(400).json({ erro: 'Campo texto é obrigatório.' });
        return;
    }

    const termoBusca  = nlpRouter.limparTexto(texto);
    let contextoRag   = '';

    if (termoBusca.length > 3) {
        const encontrados = ragDatabase.buscarFTS(termoBusca);
        if (encontrados.length > 0) {
            contextoRag = '\n[CONHECIMENTO EXTRAÍDO]\n' +
                encontrados.map((f: any) => `- ${f.topico}: ${f.resumo}`).join('\n');
        }
    }

    const resposta = await askBrainComHistorico(texto, sessaoId, contextoRag);
    res.json({ resposta });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.use(express.static(path.join(BASE_DIR, 'dashboard')));

app.get('/', (_req, res) => {
    res.sendFile(path.join(BASE_DIR, 'dashboard/index.html'));
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log(`[HQ] Dashboard conectado: ${socket.id}`);
    // Envia o estado atual ao conectar
    socket.emit('status_aprendizado', { ...filaLeitura.estatisticas(), worker: workerStatus });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

export function startServer(port = 5000) {
    server.listen(port, '0.0.0.0', () => {
        console.log(`[ARGUS] HQ online em http://0.0.0.0:${port}`);
    });
}