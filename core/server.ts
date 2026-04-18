import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import multer from 'multer';
import os from 'node:os';

import { snippets, cacheRespostas, repository, filaLeitura, ragDatabase } from './database.js';
import { nlpRouter } from './nlpRouter.js';
import { chamarBrainDireto } from './brainBridge.js';

const require    = createRequire(import.meta.url);
const pdfParse   = require('pdf-parse');
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

let ultimaMensagemTimestamp = Date.now();

// ─── Upload de PDF ────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload', upload.single('documento'), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ erro: 'Nenhum documento fornecido.' });
        return;
    }

    try {
        const data      = await pdfParse(req.file.buffer);
        const paragrafos = data.text.split('\n\n');
        let chunkAtual  = '';

        for (const p of paragrafos) {
            if (chunkAtual.length + p.length > 1000) {
                filaLeitura.adicionar(req.file.originalname, chunkAtual.trim());
                chunkAtual = p + '\n\n';
            } else {
                chunkAtual += p + '\n\n';
            }
        }
        if (chunkAtual.trim().length > 0) {
            filaLeitura.adicionar(req.file.originalname, chunkAtual.trim());
        }

        res.json({ mensagem: 'PDF processado e fragmentos adicionados à fila de estudo.' });
    } catch (err) {
        console.error('[UPLOAD ERROR]', err);
        res.status(500).json({ erro: 'Falha ao ler o ficheiro PDF.' });
    }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.use(express.static(path.join(process.cwd(), 'dashboard')));

app.get('/', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'dashboard/index.html'));
});

// ─── Standby Worker ───────────────────────────────────────────────────────────

setInterval(async () => {
    const load     = os.loadavg()[0];
    const idleTime = Date.now() - ultimaMensagemTimestamp;

    if (idleTime > 120_000 && load < 1.0) {
        const pendente = filaLeitura.obterPendente();
        if (!pendente) return;

        console.log(`[STANDBY WORKER] CPU ${load.toFixed(2)}. Extraindo conceitos do fragmento ID ${pendente.id}...`);
        filaLeitura.marcarStatus(pendente.id, 'processando');

        try {
            const result = await chamarBrainDireto({
                tipo: 'extrair',
                text: pendente.conteudo,
            });

            if (result.status === 'success') {
                const extraido = JSON.parse(result.response);
                ragDatabase.salvarFragmentoExtraido(pendente.fonte, extraido.topico, extraido.resumo, extraido.tags);
                filaLeitura.marcarStatus(pendente.id, 'concluido');
                console.log(`[STANDBY WORKER] Conhecimento assimilado: ${extraido.topico}`);
            } else {
                console.error('[STANDBY WORKER] Erro na resposta da IA:', result.message);
                filaLeitura.marcarStatus(pendente.id, 'erro');
            }
        } catch (err) {
            console.error('[STANDBY WORKER] Erro:', err);
            filaLeitura.marcarStatus(pendente.id, 'erro');
        }
    }
}, 30_000);

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log(`[ARGUS-HQ] Terminal conectado: ${socket.id}`);

    socket.on('mensagem_web', async (dados) => {
        ultimaMensagemTimestamp = Date.now();
        const comando = dados.texto.toLowerCase().trim();

        console.log(`[HQ] Recebido: "${comando}" | Alvo: [${dados.alvo.toUpperCase()}]`);

        // ── DEBIAN ────────────────────────────────────────────────────────────
        if (dados.alvo === 'debian') {
            socket.emit('status_argus', { status: 'pensando' });

            let respostaLocal = '';
            if (comando === 'ram' || comando === 'memoria') {
                const total = (os.totalmem() / 1_073_741_824).toFixed(2);
                const free  = (os.freemem()  / 1_073_741_824).toFixed(2);
                const used  = (parseFloat(total) - parseFloat(free)).toFixed(2);
                respostaLocal = `🖥️ **RAM:** \`${used} GB\` em uso de \`${total} GB\` total.`;
            } else if (comando === 'cpu' || comando === 'processador') {
                const load = os.loadavg()[0].toFixed(2);
                respostaLocal = `⚙️ **CPU Load:** Carga atual em \`${load}\`.`;
            } else {
                const uptime = (os.uptime() / 3600).toFixed(1);
                respostaLocal = `📊 **Status Local:**\n- Uptime: \`${uptime} horas\`\n- Estado: \`Online\``;
            }

            setTimeout(() => socket.emit('resposta_argus', { texto: respostaLocal }), 300);
            return;
        }

        // ── SNIPPET ───────────────────────────────────────────────────────────
        if (dados.alvo === 'snippet') {
            const partes = dados.texto.split(':');
            if (partes.length >= 2) {
                const descricao = partes[0]!.trim();
                const codigo    = partes.slice(1).join(':').trim();
                snippets.salvar(descricao, codigo);
                socket.emit('resposta_argus', { texto: `✅ **Snippet guardado!**\n\`${descricao}\`` });
            } else {
                socket.emit('resposta_argus', { texto: `⚠️ Formato inválido. Use: \`Descrição : Código\`` });
            }
            return;
        }

        // ── APRENDER ──────────────────────────────────────────────────────────
        if (dados.alvo === 'aprender') {
            const partes = dados.texto.split(':');
            if (partes.length >= 2) {
                const chave = partes[0]!.trim();
                const valor = partes.slice(1).join(':').trim();
                repository.saveFato(chave, valor);
                socket.emit('resposta_argus', { texto: `✅ Fato assimilado:\n**${chave}**: ${valor}` });
            } else {
                socket.emit('resposta_argus', { texto: `⚠️ Formato incorreto. Use: \`Tópico : Explicação\`` });
            }
            return;
        }

        // ── NUVEM (pipeline híbrido) ───────────────────────────────────────────
        if (dados.alvo === 'nuvem') {
            socket.emit('status_argus', { status: 'pensando' });

            try {
                const intencao = nlpRouter.classificar(comando);
                console.log(`[PIPELINE] Intenção: ${intencao.toUpperCase()}`);

                if (intencao === 'chitchat') {
                    const rapidAnswer = await nlpRouter.responderChitchat(comando);
                    if (rapidAnswer) {
                        socket.emit('resposta_argus', { texto: `⚡ ${rapidAnswer}` });
                        return;
                    }
                }

                if (intencao === 'comando_local') {
                    socket.emit('resposta_argus', { texto: `💡 Parece um comando do sistema. Muda o alvo para **DEBIAN**.` });
                    return;
                }

                const termoBusca = nlpRouter.limparTexto(comando);

                if (termoBusca.length > 2) {
                    const snips = snippets.buscarPorPalavraChave(termoBusca);
                    if (snips.length > 0) {
                        let txt = `Encontrei nos Snippets:\n\n`;
                        snips.forEach(s => txt += `**${s.descricao}**\n\`\`\`${s.linguagem}\n${s.codigo}\n\`\`\`\n`);
                        socket.emit('resposta_argus', { texto: txt });
                        return;
                    }

                    const cached = cacheRespostas.buscar(termoBusca);
                    if (cached) {
                        socket.emit('resposta_argus', { texto: `🗄️ *(Cache)*\n\n${cached}` });
                        return;
                    }
                }

                let contextoRAG = '';
                if (termoBusca.length > 3) {
                    const encontrados = ragDatabase.buscarFTS(termoBusca);
                    if (encontrados.length > 0) {
                        contextoRAG = '\n[CONCEITOS DOS PDFS]\n' +
                            encontrados.map((f: any) => `- ${f.topico} (${f.fonte}): ${f.resumo}`).join('\n');
                        console.log(`[RAG] ${encontrados.length} conceitos injetados.`);
                    }
                }

                const result = await chamarBrainDireto({
                    tipo:         'chat',
                    text:         dados.texto,
                    contexto_rag: contextoRAG,
                });

                if (result.status === 'success') {
                    if (termoBusca.length > 2 && intencao === 'duvida_tecnica') {
                        cacheRespostas.salvar(termoBusca, result.response);
                    }
                    socket.emit('resposta_argus', { texto: result.response });
                } else {
                    socket.emit('resposta_argus', { texto: `❌ **Erro:** ${result.message}` });
                }

            } catch (error: any) {
                console.error(error);
                socket.emit('resposta_argus', { texto: `❌ **Falha:** A Nuvem Neural não respondeu.` });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`[ARGUS-HQ] Terminal desconectado: ${socket.id}`);
    });
});

// ─── Export ───────────────────────────────────────────────────────────────────

export function startServer(port = 5000) {
    server.listen(port, '0.0.0.0', () => {
        console.log(`[ARGUS-WEB] HQ online em http://0.0.0.0:${port}`);
    });
}