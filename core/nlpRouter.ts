import natural from 'natural';
import RiveScript from 'rivescript';
import path from 'node:path';

export class NLPRouter {
    private classifier: natural.BayesClassifier;
    private bot: RiveScript;

    constructor() {
        // Inicializa a Camada 2 (NLP)
        this.classifier = new natural.BayesClassifier();
        this.treinarModeloNLP();

        // Inicializa a Camada 1 (RiveScript)
        this.bot = new RiveScript({ utf8: true });
        this.carregarRiveScript();
    }

    private treinarModeloNLP() {
        // --- Intenção: Dúvida Técnica Complexa (IA / Nuvem) ---
        this.classifier.addDocument('o que é arquitetura mvc', 'duvida_tecnica');
        this.classifier.addDocument('como configurar o fastify com zod', 'duvida_tecnica');
        this.classifier.addDocument('me explique como funciona o event loop do node', 'duvida_tecnica');
        this.classifier.addDocument('diferença entre sql e nosql', 'duvida_tecnica');
        this.classifier.addDocument('qual o padrao de projeto adapter', 'duvida_tecnica');
        this.classifier.addDocument('resuma este conteudo', 'duvida_tecnica');

        // --- Intenção: Bate-papo (RiveScript) ---
        this.classifier.addDocument('olá argus', 'chitchat');
        this.classifier.addDocument('bom dia', 'chitchat');
        this.classifier.addDocument('como você está', 'chitchat');
        this.classifier.addDocument('quem é você', 'chitchat');

        // --- Intenção: Comandos Locais (Debian) ---
        this.classifier.addDocument('como está a cpu', 'comando_local');
        this.classifier.addDocument('uso de memoria ram', 'comando_local');
        this.classifier.addDocument('status do servidor', 'comando_local');
        this.classifier.addDocument('qual o uptime', 'comando_local');

        this.classifier.train();
        console.log('[NLP] Modelo Naive Bayes treinado (Camada 2 pronta).');
    }

    private async carregarRiveScript() {
        try {
            await this.bot.loadFile(path.join(process.cwd(), 'brain/chat.rive'));
            this.bot.sortReplies();
            console.log('[RIVESCRIPT] Cérebro de conversa rápida carregado (Camada 1 pronta).');
        } catch (error) {
            console.error('[RIVESCRIPT] Erro ao carregar arquivo .rive:', error);
        }
    }

    public classificar(texto: string): string {
        return this.classifier.classify(texto);
    }

    public async responderChitchat(texto: string): Promise<string | null> {
        const resposta = await this.bot.reply('local-user', texto);
        if (resposta === '[fallback]') return null; // Se não souber, devolvemos para a IA
        return resposta;
    }

    public limparTexto(texto: string): string {
        return texto.toLowerCase()
            .replace(/[?.!;,]/g, '')
            .replace(/\b(como|o|que|é|e|um|uma|para|qual|da|de|no|na)\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

export const nlpRouter = new NLPRouter();