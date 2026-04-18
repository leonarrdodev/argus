import * as dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, GatewayIntentBits } from 'discord.js';

import { startServer } from './server.js';
import { getSystemStats } from './monitor.js';
import { askBrain, chamarBrainDireto } from './brainBridge.js';
import { repository } from './database.js';
import { StandbyMonitor } from './standby.js';

dotenv.config();

const execPromise = promisify(exec);

// ─── Discord ──────────────────────────────────────────────────────────────────

const argus = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

argus.once('ready', () => {
    console.log(`[ARGUS] Online com memória SQLite ativa.`);
});

argus.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const textoOriginal  = message.content.trim();
    const textoMinusculo = textoOriginal.toLowerCase();

    // Cada canal Discord funciona como uma sessão independente de histórico
    const sessaoId = message.channelId;

    // ── 1. ANEXO ──────────────────────────────────────────────────────────────
    if (message.attachments.size > 0) {
        const anexo       = message.attachments.first()!;
        const nomeArquivo = anexo.name?.toLowerCase() ?? '';

        if (!nomeArquivo.endsWith('.csv') && !nomeArquivo.endsWith('.pdf')) {
            await message.reply('⚠️ Consigo ler apenas planilhas CSV ou documentos PDF no momento.');
            return;
        }

        const loading  = await message.reply(`🔍 **Argus:** Analisando \`${anexo.name}\`...`);
        const pergunta = textoOriginal !== '' ? textoOriginal : 'Faça um resumo analítico deste documento.';

        try {
            const result = await chamarBrainDireto({
                tipo: 'analisar_dados',
                url:  anexo.url,
                text: pergunta,
            });

            if (result.status === 'error') {
                await loading.edit(`❌ **Erro:** ${result.message}`);
                return;
            }

            const resposta = result.response as string;
            if (resposta.length > 1900) {
                const pedacos = resposta.match(/[\s\S]{1,1900}/g) ?? [];
                await loading.edit(pedacos[0]!);
                for (let i = 1; i < pedacos.length; i++) {
                    await message.channel.send(pedacos[i]!);
                }
            } else {
                await loading.edit(resposta);
            }
        } catch (error: any) {
            await loading.edit(`❌ **Crash:** \`${error.message.substring(0, 1850)}\``);
        }
        return;
    }

    // ── 2. STATUS ─────────────────────────────────────────────────────────────
    if (textoMinusculo.includes('status') ||
        textoMinusculo.includes('saúde do servidor') ||
        textoMinusculo.includes('como estão os sistemas')) {
        const stats = getSystemStats();
        await message.reply(`🌡️ **Temp:** ${stats.temp} | 🧠 **RAM:** ${stats.memoria} | 📊 **CPU:** ${stats.cpu}`);
        return;
    }

    // ── 3. CONSOLIDAR ─────────────────────────────────────────────────────────
    if (textoMinusculo.includes('hora de aprender') ||
        textoMinusculo.includes('consolide as memórias')) {
        const loading    = await message.reply('⏳ **Argus:** Consolidando dados do dia...');
        const fatosDoDia = repository.listFatos();

        try {
            const result = await chamarBrainDireto({ tipo: 'consolidar', fatos: fatosDoDia });
            await loading.edit(result.response);
        } catch {
            await loading.edit('❌ Erro na consolidação.');
        }
        return;
    }

    // ── 4. APRENDER ───────────────────────────────────────────────────────────
    if (textoMinusculo.match(/^(aprenda|memorize)\s+/)) {
        const input         = textoOriginal.replace(/^(aprenda|memorize)\s+/i, '');
        const [chave, ...resto] = input.split(':');
        const valor         = resto.join(':').trim();

        if (!chave || !valor) {
            await message.reply('Formato: `aprenda [tópico]: [descrição]`');
            return;
        }
        repository.saveFato(chave.trim(), valor);
        await message.reply(`✅ Memorizei **${chave.trim()}**.`);
        return;
    }

    // ── 5. LEMBRAR ────────────────────────────────────────────────────────────
    if (textoMinusculo.match(/^(lembre|recorde|busque)\s+/)) {
        const chave = textoOriginal.replace(/^(lembre|recorde|busque)\s+/i, '').trim();
        const fato  = repository.getFato(chave);
        if (fato) {
            await message.reply(`🔍 Sobre **${chave}**: ${fato.valor}`);
        } else {
            await message.reply(`❌ Nada encontrado sobre **${chave}**.`);
        }
        return;
    }

    // ── 6. SHELL ──────────────────────────────────────────────────────────────
    if (textoMinusculo.startsWith('terminal:') || textoMinusculo.startsWith('shell:')) {
        if (message.author.id !== process.env['OWNER_ID']) {
            await message.reply('⛔ Acesso Negado.');
            return;
        }
        const comando = textoOriginal.replace(/^(terminal:|shell:)\s*/i, '');
        const loading = await message.reply(`⚙️ Executando: \`${comando}\`...`);
        try {
            const { stdout, stderr } = await execPromise(comando, { timeout: 15_000 });
            let resultado = stdout || stderr || '✅ Executado (sem saída).';
            if (resultado.length > 1900) resultado = resultado.substring(0, 1850) + '\n...';
            await loading.edit(`🖥️ **Terminal:**\n\`\`\`bash\n${resultado}\n\`\`\``);
        } catch (error: any) {
            await loading.edit(`❌ **Erro:**\n\`\`\`bash\n${error.message.substring(0, 1850)}\n\`\`\``);
        }
        return;
    }

    // ── 7. CÉREBRO LIVRE ──────────────────────────────────────────────────────
    const loading   = await message.reply('🔄 Processando...');
    const resposta  = await askBrain(textoOriginal, sessaoId);
    const textoFinal = `🧠 **Argus:**\n${resposta}`;

    if (textoFinal.length > 1900) {
        const pedacos = textoFinal.match(/[\s\S]{1,1900}/g) ?? [];
        await loading.edit(pedacos[0]!);
        for (let i = 1; i < pedacos.length; i++) await message.channel.send(pedacos[i]!);
    } else {
        await loading.edit(textoFinal);
    }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

argus.login(process.env['DISCORD_TOKEN']);
startServer(5000);
new StandbyMonitor();