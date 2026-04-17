import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import multer from 'multer';
import fs from 'node:fs';


import { snippets, cacheRespostas, repository, filaLeitura, ragDatabase } from './database.js'; 
import { nlpRouter } from './nlpRouter.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



// Puxamos a biblioteca bruta
const pdfParseRaw = require('pdf-parse');
// Garantimos que estamos pegando a função exata, onde quer que o Node a tenha escondido
const pdfParse = typeof pdfParseRaw === 'function' ? pdfParseRaw : pdfParseRaw.default;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const execPromise = util.promisify(exec);

let ultimaMensagemTimestamp = Date.now();

// --- B. Upload e Fatiamento de PDFs ---
// Mantém na memória RAM para fatiar diretamente sem precisar de guardar ficheiros temporários
const storage = multer.memoryStorage(); 
const upload = multer({ storage });

app.post('/upload', upload.single('documento'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum documento fornecido.' });
    
    try {
        const data = await pdfParse(req.file.buffer);
        const text = data.text;
        
        // Divide o texto em chunks de aproximadamente 1000 caracteres baseados em quebras de parágrafo
        const paragrafos = text.split('\n\n');
        let chunkAtual = '';
        
        for (const p of paragrafos) {
            if (chunkAtual.length + p.length > 1000) {
                filaLeitura.adicionar(req.file.originalname, chunkAtual);
                chunkAtual = p + '\n\n';
            } else {
                chunkAtual += p + '\n\n';
            }
        }
        if (chunkAtual.trim().length > 0) {
            filaLeitura.adicionar(req.file.originalname, chunkAtual);
        }
        
        res.json({ mensagem: 'PDF processado e fragmentos adicionados à fila de estudo em Standby.' });
    } catch (err) {
        console.error('[UPLOAD ERROR]', err);
        res.status(500).json({ erro: 'Falha ao ler o ficheiro PDF.' });
    }
});

// Servir a interface Web
app.use(express.static(path.join(process.cwd(), 'dashboard')));

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'dashboard/index.html')); 
});

// --- C. Monitor de Ociosidade (Worker de Standby) ---
setInterval(async () => {
    const load = os.loadavg()[0];
    const idleTime = Date.now() - ultimaMensagemTimestamp;
    
    // Processa apenas se: Sem mensagens há 2 minutos E a carga da CPU abaixo de 1.0
    if (idleTime > 120000 && load < 1.0) {
        const pendente = filaLeitura.obterPendente();
        
        if (pendente) {
            console.log(`[STANDBY WORKER] CPU a ${load.toFixed(2)}. A extrair conceitos do fragmento ID ${pendente.id}...`);
            filaLeitura.marcarStatus(pendente.id, 'processando');
            
            try {
                const pythonPath = path.join(os.homedir(), 'argus/venv/bin/python3');
                const scriptPath = path.join(os.homedir(), 'argus/scripts/brain.py');
                const payload = JSON.stringify({ tipo: 'extrair', text: pendente.conteudo });
                
                const { stdout } = await execPromise(`${pythonPath} ${scriptPath} '${payload}'`, { maxBuffer: 1024 * 1024 * 10 });
                const result = JSON.parse(stdout);
                
                if (result.status === 'success') {
                    const extraido = JSON.parse(result.response); // Fazer o parse do JSON devolvido pela IA
                    ragDatabase.salvarFragmentoExtraido(pendente.fonte, extraido.topico, extraido.resumo, extraido.tags);
                    filaLeitura.marcarStatus(pendente.id, 'concluido');
                    console.log(`[STANDBY WORKER] Conhecimento assimilado: ${extraido.topico}`);
                } else {
                    console.error('[STANDBY WORKER] Erro na resposta da IA:', result.message);
                    filaLeitura.marcarStatus(pendente.id, 'erro');
                }
            } catch (err) {
                console.error('[STANDBY WORKER] Erro na execução do Python:', err);
                filaLeitura.marcarStatus(pendente.id, 'erro');
            }
        }
    }
}, 30000); // O vigia verifica as condições a cada 30 segundos


// --- Comunicação em Tempo Real (Socket.IO) ---
io.on('connection', (socket) => {
    console.log(`[ARGUS-HQ] Terminal conectado: ${socket.id}`);

    socket.on('mensagem_web', async (dados) => {
        ultimaMensagemTimestamp = Date.now(); // Atualiza o relógio de ociosidade
        const comando = dados.texto.toLowerCase().trim();
        
        console.log(`[HQ] Recebido: "${comando}" | Alvo: [${dados.alvo.toUpperCase()}]`);

        // ==========================================
        // 🚦 1. ALVO: DEBIAN (Comandos Locais)
        // ==========================================
        if (dados.alvo === 'debian') {
            socket.emit('status_argus', { status: 'pensando' });
            let respostaLocal = '';
            
            if (comando === 'ram' || comando === 'memoria') {
                const total = (os.totalmem() / 1073741824).toFixed(2);
                const free = (os.freemem() / 1073741824).toFixed(2);
                const used = (parseFloat(total) - parseFloat(free)).toFixed(2);
                respostaLocal = `🖥️ **RAM:** \`${used} GB\` em uso de \`${total} GB\` total.`;
            } else if (comando === 'cpu' || comando === 'processador') {
                const load = os.loadavg()[0].toFixed(2);
                respostaLocal = `⚙️ **CPU Load:** Carga atual em \`${load}\`.`;
            } else {
                const uptime = (os.uptime() / 3600).toFixed(1);
                respostaLocal = `📊 **Status do Servidor Local:**\n- Uptime: \`${uptime} horas\`\n- Estado: \`Online\``;
            }
            
            setTimeout(() => socket.emit('resposta_argus', { texto: respostaLocal }), 300);
            return;
        }

        // ==========================================
        // 💾 2. ALVO: SNIPPET (Salvar Rápido)
        // ==========================================
        if (dados.alvo === 'snippet') {
            const partes = dados.texto.split(':'); 
            if (partes.length >= 2) {
                const descricao = partes[0].trim();
                const codigo = partes.slice(1).join(':').trim();
                snippets.salvar(descricao, codigo);
                socket.emit('resposta_argus', { texto: `✅ **Snippet guardado com sucesso!**\n\`${descricao}\`` });
            } else {
                socket.emit('resposta_argus', { texto: `⚠️ Formato inválido. Utiliza: \`Descrição : Código\`` });
            }
            return;
        }

        // ==========================================
        // 🧠 3. ALVO: APRENDER (Manual)
        // ==========================================
        if (dados.alvo === 'aprender') {
            const partes = dados.texto.split(':');
            if (partes.length >= 2) {
                const chave = partes[0].trim();
                const valor = partes.slice(1).join(':').trim();
                repository.saveFato(chave, valor);
                socket.emit('resposta_argus', { texto: `✅ Fato assimilado manualmente:\n**${chave}**: ${valor}` });
            } else {
                socket.emit('resposta_argus', { texto: `⚠️ Formato incorreto. Utiliza: \`Tópico : Explicação\`` });
            }
            return;
        }

        // ==========================================
        // ☁️ 4. ALVO: NUVEM (Pipeline Híbrido com RAG)
        // ==========================================
        if (dados.alvo === 'nuvem') {
            socket.emit('status_argus', { status: 'pensando' });
            
            try {
                // [CAMADA 2] - Classificação de Intenção (NLP Local)
                const intencao = nlpRouter.classificar(comando);
                console.log(`[PIPELINE] Intenção detetada: ${intencao.toUpperCase()}`);

                // [CAMADA 1] - Resposta Rápida (Chitchat)
                if (intencao === 'chitchat') {
                    const rapidAnswer = await nlpRouter.responderChitchat(comando);
                    if (rapidAnswer) return socket.emit('resposta_argus', { texto: `⚡ ${rapidAnswer}` });
                }

                if (intencao === 'comando_local') {
                    socket.emit('resposta_argus', { texto: `💡 Parece ser um comando do sistema. Muda o alvo para **DEBIAN** no painel.` });
                    return;
                }

                // [CAMADA 3] - Cache e Snippets Locais
                const termoBusca = nlpRouter.limparTexto(comando);
                if (termoBusca.length > 2) {
                    const snips = snippets.buscarPorPalavraChave(termoBusca);
                    if (snips.length > 0) {
                        let txt = `Encontrei isto nos teus Snippets:\n\n`;
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

                // --- RECUPERAÇÃO RAG (FTS5) ---
                let contextoRAG = "";
                if (termoBusca.length > 3) {
                    const encontrados = ragDatabase.buscarFTS(termoBusca);
                    if (encontrados.length > 0) {
                        contextoRAG = "\n[CONCEITOS TÉCNICOS EXTRAÍDOS DOS PDFS PARA CONTEXTO:]\n" + 
                            encontrados.map(f => `- ${f.topico} (Fonte: ${f.fonte}): ${f.resumo}`).join('\n');
                        console.log(`[RAG] ${encontrados.length} conceitos injetados no prompt.`);
                    }
                }

                // [CAMADA 4] - Cérebro Neural (Python/LLM)
                const pythonPath = path.join(os.homedir(), 'argus/venv/bin/python3');
                const scriptPath = path.join(os.homedir(), 'argus/scripts/brain.py');
                
                const payload = JSON.stringify({ 
                    tipo: 'chat', 
                    text: dados.texto, 
                    contexto_rag: contextoRAG 
                });
                
                const { stdout } = await execPromise(`${pythonPath} ${scriptPath} '${payload}'`, { maxBuffer: 1024 * 1024 * 10 });
                const result = JSON.parse(stdout);
                
                if (result.status === 'success') {
                    // Guarda a resposta para o futuro se for técnica
                    if (termoBusca.length > 2 && intencao === 'duvida_tecnica') {
                        cacheRespostas.salvar(termoBusca, result.response);
                    }
                    socket.emit('resposta_argus', { texto: result.response });
                } else {
                    socket.emit('resposta_argus', { texto: `❌ **Erro do Brain:** ${result.message}` });
                }

            } catch (error: any) {
                console.error(error);
                socket.emit('resposta_argus', { texto: `❌ **Falha:** A Nuvem Neural não respondeu a tempo.` });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`[ARGUS-HQ] Terminal desconectado: ${socket.id}`);
    });
});

export function startServer(port = 5000) {
    server.listen(port, '0.0.0.0', () => {
        console.log(`[ARGUS-WEB] HQ online no endereço http://0.0.0.0:${port}`);
    });
}