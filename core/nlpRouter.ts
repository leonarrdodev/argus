export function limparTexto(texto: string): string {
    return texto
        .toLowerCase()
        .replace(/[?.!;,]/g, '')
        .replace(/\b(como|o|que|é|e|um|uma|para|qual|da|de|no|na)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export const nlpRouter = { limparTexto };