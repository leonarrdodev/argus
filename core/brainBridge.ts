import { historico } from './database.js';

const BRAIN_URL = 'http://127.0.0.1:8000';

export interface BrainResult {
    status:   'success' | 'error';
    response?: string;
    message?:  string;
}

// Interage diretamente com os endpoints criados no FastAPI
export async function chamarBrainDireto(payload: any): Promise<BrainResult> {
    // Determina o endpoint baseando-se no tipo ('chat', 'extrair', 'consolidar')
    const endpoint = payload.tipo ? `/${payload.tipo}` : '/chat';
    
    try {
        const res = await fetch(`${BRAIN_URL}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            throw new Error(`O Cérebro Python rejeitou o pedido: ${res.status} ${res.statusText}`);
        }

        const data = await res.json() as BrainResult;
        return data;

    } catch (error: any) {
        console.error(`[ARGUS BrainBridge] Erro de ligação:`, error.message);
        return { status: 'error', message: error.message };
    }
}

export async function askBrainComHistorico(
    texto: string,
    sessaoId: string,
    contextoRag = '',
): Promise<string> {
    const historicoSessao = historico.getSessao(sessaoId, 20);

    const result = await chamarBrainDireto({
        tipo: 'chat',
        text: texto,
        historico: historicoSessao,
        contexto_rag: contextoRag,
    });

    if (result.status === 'error') {
        return `Erro interno do Motor de IA: ${result.message ?? 'sem detalhe'}`;
    }

    const resposta = result.response ?? '';
    
    // Salva o histórico na base de dados
    historico.add(sessaoId, 'user', texto);
    historico.add(sessaoId, 'assistant', resposta);

    return resposta;
}