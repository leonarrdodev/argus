import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import pdfParse from 'pdf-parse';
import { baseConhecimento } from './database.js';

export class StandbyMonitor {
    private isReading = false;
    private docsPath = path.join(process.cwd(), 'docs_pendentes');

    constructor() {
        // Cria a pasta para onde deves atirar os PDFs
        if (!fs.existsSync(this.docsPath)) {
            fs.mkdirSync(this.docsPath, { recursive: true });
        }
        
        // Inicia o ciclo de verificação (corre a cada 1 minuto)
        setInterval(() => this.verificarOciosidade(), 60000);
        console.log('[STANDBY] Monitor de CPU ativado. A aguardar ociosidade...');
    }

    private async verificarOciosidade() {
        if (this.isReading) return;

        // Verifica a carga da CPU no último 1 minuto
        const cpuLoad = os.loadavg()[0];
        const numCores = os.cpus().length;
        
        // Se a carga for menor que 50% dos núcleos, o servidor está "tranquilo"
        if (cpuLoad < (numCores * 0.5)) {
            await this.estudarProximoDocumento();
        }
    }

    private async estudarProximoDocumento() {
        const files = fs.readdirSync(this.docsPath).filter(f => f.endsWith('.pdf'));
        if (files.length === 0) return;

        this.isReading = true;
        const arquivo = files[0];
        const filePath = path.join(this.docsPath, arquivo);

        console.log(`[STANDBY] CPU ociosa. A extrair conhecimentos de: ${arquivo}...`);

        try {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdfParse(dataBuffer);
            
            // Divide o texto extraído em parágrafos/fragmentos
            const fragmentos = data.text.split('\n\n').filter(t => t.trim().length > 50);

            // Grava os fragmentos na base de dados
            let salvos = 0;
            for (const frag of fragmentos) {
                baseConhecimento.salvarFragmento(arquivo, 1, frag.trim());
                salvos++;
            }

            console.log(`[STANDBY] Memorizou ${salvos} fragmentos de ${arquivo}.`);
            
            // Move o ficheiro para não o ler novamente
            fs.renameSync(filePath, path.join(this.docsPath, `${arquivo}.lido`));

        } catch (error) {
            console.error(`[STANDBY] Erro ao ler PDF:`, error);
        } finally {
            this.isReading = false;
        }
    }
}