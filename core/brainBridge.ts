import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import os from 'node:os';

const execPromise = promisify(exec);

export async function askBrain(text: string): Promise<string> {
    const homeDir = os.homedir();
    const pythonPath = path.join(homeDir, 'argus/venv/bin/python3');
    const scriptPath = path.join(homeDir, 'argus/scripts/brain.py');

    const payload = JSON.stringify({ text });
    const escapedPayload = payload.replace(/'/g, `'\\''`);
    const command = `${pythonPath} ${scriptPath} '${escapedPayload}'`;

    try {
        const { stdout, stderr } = await execPromise(command, { env: process.env });

        if (stderr) console.error(`[ARGUS Brain] ${stderr.trim()}`);

        const result = JSON.parse(stdout);

        if (result.status === 'success') {
            return result.response;
        } else {
            return `Erro no Cérebro: ${result.message}`;
        }
    } catch (error: any) {
        console.error(`[ARGUS BrainBridge] Comando falhou: ${command}`);
        return `Erro de conexão interna: ${error.message}`;
    }
}