import os from 'node:os';
import fs from 'node:fs';

export interface SystemStats {
    memoria: string;
    cpu: string;
    temp: string;
    uptime: string;
}

export function getSystemStats(): SystemStats {
    const totalMem = os.totalmem() / 1024 / 1024;
    const freeMem  = os.freemem()  / 1024 / 1024;
    const usedMem  = totalMem - freeMem;

    const load = os.loadavg()[0];

    const uptimeSeconds = os.uptime();
    const hours = Math.floor(uptimeSeconds / 3600);
    const mins  = Math.floor((uptimeSeconds % 3600) / 60);

    let temperatura = 'N/A';
    try {
        const tempRaw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
        temperatura = (parseInt(tempRaw) / 1000).toFixed(1) + '°C';
    } catch {
        temperatura = 'Indisponível';
    }

    return {
        memoria: `${usedMem.toFixed(2)}MB / ${totalMem.toFixed(0)}MB`,
        cpu:     `${load.toFixed(2)} (Load Avg)`,
        temp:    temperatura,
        uptime:  `${hours}h ${mins}m`,
    };
}