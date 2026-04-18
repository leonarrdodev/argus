import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { snippets, cacheRespostas, repository, filaLeitura, ragDatabase } from './database.js';
import { nlpRouter } from './nlpRouter.js';
import { chamarBrainDireto } from './brainBridge.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

let ultimaMensagemTimestamp = Date.now();

// ─── Configuração de Upload (Motor Híbrido) ──────────────────────────────────

const uploadDir = path.join(process.cwd(), 'docs_pendentes');

// Garante que a pasta de documentos pendentes exista
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

app.post('/upload', upload.single('documento'), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ erro: 'Nenhum documento fornecido.' });
        return;
    }

    const caminhoArquivo = path.resolve(req.file.path);

    try {
        // Usa o Python do venv para ler o PDF
        const scriptPath = path.join(process.cwd(), 'scripts/ler_pdf.py');
        const pythonPath = path.join(process.cwd(), 'venv/bin/python3');
        
        const { stdout, stderr } = await execAsync(`"${pythonPath}" "${scriptPath}" "${caminhoArquivo}"`);

        if (stderr && stderr.includes('ERRO_PYTHON')) {
            throw new Error(stderr);
        }

        const paragrafos = stdout.split('\n\n');
        let chunkAtual  = '';

        for (const p of paragrafos) {
            const limpo = p.trim();
            if (!limpo) continue;

            if (chunkAtual.length + limpo.length > 1000) {
                filaLeitura.adicionar(req.file.originalname, chunkAtual.trim());
                chunkAtual = limpo + '\n\n';
            } else {
                chunkAtual += limpo + '\n\n';
            }
        }

        if (chunkAtual.trim().length > 0) {
            filaLeitura.adicionar(req.file.originalname, chunkAtual.trim());
        }

        // Remove o arquivo temporário
        await fsp.unlink(caminhoArquivo);

        res.json({ mensagem: 'PDF processado e enviado para a fila de estudo.' });
    } catch (err) {
        console.error('[UPLOAD ERROR]', err);
        if (fs.existsSync(caminhoArquivo)) await fsp.unlink(caminhoArquivo).catch(() => {});
        res.status(500).json({ erro: 'Falha ao processar PDF via Python.' });
    }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.use(express.static(path.join(process.cwd(), 'dashboard')));

app.get('/', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'dashboard/index.html'));
});

// ─── Standby Worker (Estudo em Background) ────────────────────────────────────

setInterval(async () => {
    const load     = os.loadavg()[0];
    const idleTime = Date.now() - ultimaMensagemTimestamp;

    // Aumentamos para 60s para respeitar a cota da API (Erro 429)
    if (idleTime > 120_000 && load < 1.0) {
        const pendente = filaLeitura.obterPendente();
        if (!pendente) return;

        console.log(`[STANDBY] CPU ${load.toFixed(2)}. Processando fragmento ID ${pendente.id}...`);
        filaLeitura.marcarStatus(pendente.id, 'processando');

       try {
            const result = await chamarBrainDireto({
                tipo: 'extrair',
                text: pendente.conteudo,
            });

            const extraido = JSON.parse(result);
            ragDatabase.salvarFragmentoExtraido(pendente.fonte, extraido.topico, extraido.resumo, extraido.tags);
            filaLeitura.marcarStatus(pendente.id, 'concluido');
            
            // 👇 Dispara a atualização de sucesso para o Front-end
            io.emit('status_aprendizado', filaLeitura.estatisticas());
            console.log(`[STANDBY] Conhecimento assimilado: ${extraido.topico}`);
        } catch (err) {
            console.error('[STANDBY] Falha no processamento:', err);
            filaLeitura.marcarStatus(pendente.id, 'erro');
            
            // 👇 Dispara a atualização de erro para o Front-end
            io.emit('status_aprendizado', filaLeitura.estatisticas());
        }
    }
}, 60_000);

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log(`[ARGUS-HQ] Terminal conectado: ${socket.id}`);
    socket.emit('status_aprendizado', filaLeitura.estatisticas());
    socket.on('mensagem_web', async (dados) => {
        ultimaMensagemTimestamp = Date.now();
        const comando = dados.texto.toLowerCase().trim();

        // DEBIAN (Monitoramento Local)
        if (dados.alvo === 'debian') {
            socket.emit('status_argus', { status: 'pensando' });
            let resposta = `📊 **Status do Sistema:**\n- CPU: \`${os.loadavg()[0].toFixed(2)}\`\n- RAM: \`${((os.totalmem() - os.freemem()) / 1073741824).toFixed(2)}GB\``;
            setTimeout(() => socket.emit('resposta_argus', { texto: resposta }), 300);
            return;
        }

        // NUVEM (Inteligência Central + RAG)
        if (dados.alvo === 'nuvem') {
            socket.emit('status_argus', { status: 'pensando' });
            try {
                const termoBusca = nlpRouter.limparTexto(comando);
                let contextoRAG = '';
                
                if (termoBusca.length > 3) {
                    const encontrados = ragDatabase.buscarFTS(termoBusca);
                    if (encontrados.length > 0) {
                        contextoRAG = '\n[CONHECIMENTO EXTRAÍDO]\n' + 
                            encontrados.map(f => `- ${f.topico}: ${f.resumo}`).join('\n');
                    }
                }

                const resposta = await chamarBrainDireto({
                    tipo: 'chat',
                    text: dados.texto,
                    contexto_rag: contextoRAG
                });

                socket.emit('resposta_argus', { texto: resposta });
            } catch (error) {
                socket.emit('resposta_argus', { texto: `❌ Erro na Nuvem Neural.` });
            }
        }
    });
});

export function startServer(port = 5000) {
    server.listen(port, '0.0.0.0', () => {
        console.log(`[ARGUS] HQ online em http://0.0.0.0:${port}`);
    });
}