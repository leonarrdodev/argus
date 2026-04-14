import { Client, GatewayIntentBits } from 'discord.js';
import * as dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { getSystemStats } from './monitor.js';
import { askBrain } from './brainBridge.js';
import { repository } from './database.js';

dotenv.config();

const execPromise = promisify(exec);

const argus = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

argus.once('ready', () => {
    console.log(`[ARGUS] Online, com Memória SQLite ativa e pronto para aprender.`);
});

argus.on('messageCreate', async (message) => {
    // Ignora mensagens de outros bots
    if (message.author.bot) return;

    const textoOriginal = message.content.trim();
    const textoMinusculo = textoOriginal.toLowerCase();

    // ==========================================
    // ROTEADOR DE INTENÇÕES (NLP LEVE)
    // ==========================================

    // 1. INTENÇÃO: ANÁLISE DE ARQUIVOS (Basta ter um anexo)
    if (message.attachments.size > 0) {
        const anexo = message.attachments.first()!;
        const nomeArquivo = anexo.name?.toLowerCase() || '';

        if (!nomeArquivo.endsWith('.csv') && !nomeArquivo.endsWith('.pdf')) {
            await message.reply('⚠️ Consigo ler apenas planilhas CSV ou documentos PDF no momento.');
            return;
        }

        const loading = await message.reply(`🔍 **Argus:** Analisando \`${anexo.name}\`...`);
        
        // Se você mandar só o arquivo sem texto, ele usa um prompt padrão
        const pergunta = textoOriginal !== '' ? textoOriginal : "Faça um resumo analítico deste documento.";

        const payload = JSON.stringify({
            tipo: 'analisar_dados',
            url: anexo.url,
            text: pergunta
        });

        const pythonPath = path.join(os.homedir(), 'argus/venv/bin/python3');
        const scriptPath = path.join(os.homedir(), 'argus/scripts/brain.py');
        
        try {
            const { stdout } = await execPromise(`${pythonPath} ${scriptPath} '${payload}'`, { 
                env: process.env, maxBuffer: 1024 * 1024 * 10 
            });
            
            const result = JSON.parse(stdout);
            if (result.status === 'error') {
                await loading.edit(`❌ **Erro no script Python:** \n\`\`\`\n${result.message}\n\`\`\``);
                return;
            }
            
            const resposta = result.response;
            if (resposta.length > 1900) {
                const pedacos = resposta.match(/[\s\S]{1,1900}/g) || [];
                await loading.edit(pedacos[0]);
                for (let i = 1; i < pedacos.length; i++) {
                    await message.channel.send(pedacos[i]);
                }
            } else {
                await loading.edit(resposta);
            }
        } catch (error: any) {
            await loading.edit(`❌ **Crash no Sistema:** \`\`\`bash\n${error.message.substring(0, 1850)}\n\`\`\``);
        }
        return; // Encerra a execução para não cair nos outros blocos
    }

    // 2. INTENÇÃO: STATUS DO SISTEMA
    if (textoMinusculo.includes('status') || textoMinusculo.includes('saúde do servidor') || textoMinusculo.includes('como estão os sistemas')) {
        const stats = getSystemStats();
        await message.reply(`🌡️ **Temp:** ${stats.temp} | 🧠 **RAM:** ${stats.memoria} | 📊 **CPU:** ${stats.cpu}`);
        return;
    }

    // 3. INTENÇÃO: CONSOLIDAR MEMÓRIA
    if (textoMinusculo.includes('hora de aprender') || textoMinusculo.includes('consolide as memórias')) {
        const loading = await message.reply('⏳ **Argus:** Consolidando dados do dia...');
        const fatosDoDia = repository.listFatos('global'); 
        const payload = JSON.stringify({ tipo: 'consolidar', fatos: fatosDoDia });
        const command = `${path.join(os.homedir(), 'argus/venv/bin/python3')} ${path.join(os.homedir(), 'argus/scripts/brain.py')} '${payload}'`;
        try {
            const { stdout } = await execPromise(command, { env: process.env });
            const result = JSON.parse(stdout);
            await loading.edit(result.response);
        } catch (error) {
            await loading.edit('❌ Erro na consolidação.');
        }
        return;
    }

    // 4. INTENÇÃO: APRENDER (Ex: "aprenda projeto: sistema novo")
    if (textoMinusculo.match(/^(aprenda|memorize)\s+/)) {
        // Remove a palavra gatilho para pegar só a chave e o valor
        const input = textoOriginal.replace(/^(aprenda|memorize)\s+/i, '');
        const [chave, ...resto] = input.split(':');
        const valor = resto.join(':').trim();

        if (!chave || !valor) {
            await message.reply('Formato para memória: `aprenda [tópico]: [descrição]`');
            return;
        }
        repository.saveFato(chave.trim(), valor);
        await message.reply(`✅ Memorizei **${chave.trim()}**.`);
        return;
    }

    // 5. INTENÇÃO: LEMBRAR (Ex: "lembre projeto")
    if (textoMinusculo.match(/^(lembre|recorde|busque)\s+/)) {
        const chave = textoOriginal.replace(/^(lembre|recorde|busque)\s+/i, '').trim();
        const fato = repository.getFato(chave);
        if (fato) {
            await message.reply(`🔍 Sobre **${chave}**: ${fato.valor}`);
        } else {
            await message.reply(`❌ Nada encontrado sobre **${chave}**.`);
        }
        return;
    }

    // 6. INTENÇÃO: SHELL (Acesso root ainda precisa de um prefixo por segurança)
    if (textoMinusculo.startsWith('terminal:') || textoMinusculo.startsWith('shell:')) {
        if (message.author.id !== process.env.OWNER_ID) {
            await message.reply('⛔ Acesso Negado.');
            return;
        }
        const comando = textoOriginal.replace(/^(terminal:|shell:)\s*/i, '');
        const loading = await message.reply(`⚙️ Executando: \`${comando}\`...`);
        try {
            const { stdout, stderr } = await execPromise(comando, { timeout: 15000 });
            let resultado = stdout || stderr || '✅ Executado (sem saída).';
            if (resultado.length > 1900) resultado = resultado.substring(0, 1850) + '\n...';
            await loading.edit(`🖥️ **Terminal:**\n\`\`\`bash\n${resultado}\n\`\`\``);
        } catch (error: any) {
            await loading.edit(`❌ **Erro:**\n\`\`\`bash\n${error.message.substring(0, 1850)}\n\`\`\``);
        }
        return;
    }

    // 7. INTENÇÃO: CÉREBRO LIVRE (Bate-papo normal e perguntas gerais)
    // Se a mensagem não caiu em nenhuma das regras acima, o Argus assume que você está 
    // apenas conversando ou fazendo uma pergunta genérica.
    
    const loading = await message.reply('🔄 Processando...');
    const resposta = await askBrain(textoOriginal);
    
    const textoFinal = `🧠 **Argus:**\n${resposta}`;
    if (textoFinal.length > 1900) {
        const pedacos = textoFinal.match(/[\s\S]{1,1900}/g) || [];
        await loading.edit(pedacos[0]);
        for (let i = 1; i < pedacos.length; i++) await message.channel.send(pedacos[i]);
    } else {
        await loading.edit(textoFinal);
    }
});
argus.login(process.env.DISCORD_TOKEN);