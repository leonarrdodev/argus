# scripts/ler_pdf.py
import sys
import PyPDF2

def extrair_texto(caminho_pdf):
    try:
        texto_completo = ""
        with open(caminho_pdf, 'rb') as arquivo:
            leitor = PyPDF2.PdfReader(arquivo)
            for pagina in leitor.pages:
                texto_completo += pagina.extract_text() + "\n\n"
        
        # Imprime o texto no stdout para o Node capturar
        print(texto_completo)
    except Exception as e:
        print(f"ERRO_PYTHON: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        extrair_texto(sys.argv[1])
    else:
        print("ERRO_PYTHON: Nenhum arquivo fornecido.", file=sys.stderr)
        sys.exit(1)