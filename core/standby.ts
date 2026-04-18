import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { filaLeitura } from './database.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

export class StandbyMonitor {
    private isReading = false;
    private docsPath  = path.join(os.homedir(), 'argus/docs_pendentes');

    constructor() {
        if (!fs.existsSync(this.docsPath)) {
            fs.mkdirSync(this.docsPath, { recursive: true });
        }

        setInterval(() => this.verificarOciosidade(), 60_000);
        console.log(`[STANDBY] Monitor de pasta ativado em: ${this.docsPath}`);
    }

    private async verificarOciosidade() {
        if (this.isReading) return;

        const cpuLoad  = os.loadavg()[0];
        const numCores = os.cpus().length;

        if (cpuLoad < numCores * 0.5) {
            await this.enfileirarProximoDocumento();
        }
    }

    private async enfileirarProximoDocumento() {
        const files = fs.readdirSync(this.docsPath).filter(f => f.endsWith('.pdf'));
        if (files.length === 0) return;

        this.isReading = true;
        const arquivo  = files[0]!;
        const filePath = path.join(this.docsPath, arquivo);

        console.log(`[STANDBY] CPU ociosa. Enfileirando fragmentos de: ${arquivo}...`);

        try {
            const buffer = fs.readFileSync(filePath);
            const data   = await pdfParse(buffer);

            const paragrafos = data.text.split('\n\n').filter((t: string) => t.trim().length > 50);
            let chunkAtual   = '';
            let total        = 0;

            for (const p of paragrafos) {
                if (chunkAtual.length + p.length > 1000) {
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

            console.log(`[STANDBY] ${total} fragmentos de "${arquivo}" adicionados à fila de extração.`);

            fs.renameSync(filePath, path.join(this.docsPath, `${arquivo}.lido`));

        } catch (error) {
            console.error(`[STANDBY] Erro ao processar PDF:`, error);
        } finally {
            this.isReading = false;
        }
    }
}