import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import { snippets } from './database.js'; // Importação necessária para gerir os snippets

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const execPromise = util.promisify(exec);

// Servindo a página web do HQ
app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'dashboard/index.html')); 
});

io.on('connection', (socket) => {
    console.log(`[ARGUS-HQ] Novo terminal conectado: ${socket.id}`);

    socket.on('mensagem_web', async (dados) => {
        console.log(`[HQ] Leo enviou: "${dados.texto}" | Alvo: [${dados.alvo.toUpperCase()}]`);

        socket.emit('status_argus', { status: 'pensando' });
        const comando = dados.texto.toLowerCase().trim();

        // ==========================================
        // 🚦 1. ALVO: DEBIAN (Comandos Locais)
        // ==========================================
        if (dados.alvo === 'debian') {
            let respostaLocal = '';

            if (comando === 'ram' || comando === 'memoria') {
                const total = (os.totalmem() / 1073741824).toFixed(2);
                const free = (os.freemem() / 1073741824).toFixed(2);
                const used = (parseFloat(total) - parseFloat(free)).toFixed(2);
                respostaLocal = `🖥️ **RAM:** \`${used} GB\` em uso de \`${total} GB\` total.`;
                
            } else if (comando === 'cpu' || comando === 'processador') {
                const load = os.loadavg()[0].toFixed(2);
                respostaLocal = `⚙️ **CPU Load:** Carga atual é de \`${load}\`.`;
                
            } else {
                const uptime = (os.uptime() / 3600).toFixed(1);
                respostaLocal = `📊 **Status Geral do Compaq 510:**\n- Uptime: \`${uptime} horas\`\n- Conexão: \`Ativa\``;
            }

            setTimeout(() => {
                socket.emit('resposta_argus', { texto: respostaLocal });
            }, 500);
            
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
                socket.emit('resposta_argus', { texto: `✅ **Snippet salvo!**\n\`${descricao}\`` });
            } else {
                socket.emit('resposta_argus', { texto: `⚠️ Formato incorreto. Use: \`Descrição : Código\`` });
            }
            return;
        }

        // ==========================================
        // ☁️ 3. ALVO: NUVEM (Cérebro IA Python)
        // ==========================================
        if (dados.alvo === 'nuvem') {
            try {
                const msgLower = comando.toLowerCase();
                
                // Limpa palavras comuns de conexão da sua frase para focar no "núcleo" do pedido
                const termoBusca = msgLower.replace(/qual|o|comando|para|como|fazer|um|uma|da|de|no|na/gi, '').trim();
                
                // Só pesquisa se a frase limpa tiver um tamanho razoável
                if (termoBusca.length > 2) {
                    // Faz a busca no SQLite local ANTES de qualquer coisa
                    const resultados = snippets.buscarPorPalavraChave(termoBusca);
                    
                    if (resultados.length > 0) {
                        let respostaLocal = `Encontrei isto nos meus registros locais (sem gastar API):\n\n`;
                        for (const res of resultados) {
                            respostaLocal += `**${res.descricao}**\n\`\`\`${res.linguagem}\n${res.codigo}\n\`\`\`\n`;
                        }
                        socket.emit('resposta_argus', { texto: respostaLocal });
                        return; // Encontrou localmente, encerra o processamento aqui!
                    }
                }
                // --- FIM DA BUSCA LOCAL ---
                // --- FIM DA BUSCA LOCAL ---

                // Caso não encontre localmente, segue para o script Python (Gemini/Groq)
                const pythonPath = path.join(os.homedir(), 'argus/venv/bin/python3');
                const scriptPath = path.join(os.homedir(), 'argus/scripts/brain.py');
                
                const payload = JSON.stringify({ tipo: 'chat', text: dados.texto });
                const commandExec = `${pythonPath} ${scriptPath} '${payload}'`;
                
                const { stdout } = await execPromise(commandExec, { env: process.env, maxBuffer: 1024 * 1024 * 10 });
                const result = JSON.parse(stdout);

                if (result.status === 'error') {
                    socket.emit('resposta_argus', { texto: `❌ **Erro:** ${result.message}` });
                } else {
                    socket.emit('resposta_argus', { texto: result.response });
                }

            } catch (error: any) {
                socket.emit('resposta_argus', { texto: `❌ **Crash:** Falha ao contatar a Nuvem.` });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`[ARGUS-HQ] Terminal desconectado: ${socket.id}`);
    });
});

export function startServer(port = 5000) {
    server.listen(port, '0.0.0.0', () => {
        console.log(`[ARGUS-WEB] HQ Argus online: http://0.0.0.0:${port}`);
    });
}