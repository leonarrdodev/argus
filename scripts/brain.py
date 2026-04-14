import sys
import json
import os
import csv
import requests
import io
from PyPDF2 import PdfReader

# Requisição leve via REST API
def usar_gemini(prompt):
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key: return "Erro: API Key não configurada no ambiente."

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    payload = {"contents": [{"parts": [{"text": prompt}]}]}

    try:
        response = requests.post(url, headers={'Content-Type': 'application/json'}, json=payload)
        response.raise_for_status() 
        dados = response.json()
        return dados['candidates'][0]['content']['parts'][0]['text']
    except requests.exceptions.HTTPError as e:
        # CENSURA DE SEGURANÇA: Se der erro HTTP, mostra só o código, nunca a URL!
        return f"Acesso à Nuvem Indisponível (Erro {e.response.status_code}). Tente novamente em instantes."
    except Exception as e:
        # Erro genérico mascarado
        return "Falha no circuito neural ao contatar a IA."

def analisar_documento(dados):
    url = dados.get("url")
    pergunta = dados.get("text", "Faça um resumo executivo deste documento.")
    filename = url.split('/')[-1].split('?')[0].lower()
    
    try:
        response = requests.get(url)
        response.raise_for_status()
        
        # 1. Lógica para CSV (Nativa, Sem Pandas)
        if filename.endswith('.csv'):
            reader = csv.reader(io.StringIO(response.text))
            linhas = list(reader)
            
            if not linhas: return "O arquivo CSV parece estar vazio."
            
            colunas = linhas[0]
            amostra = linhas[1:6] # Pega as 5 primeiras linhas de dados
            
            contexto = f"Dataset CSV com colunas: {colunas}\n\nAmostra inicial dos dados:\n"
            for linha in amostra:
                contexto += f"{linha}\n"
                
            contexto += "\n(A IA deve deduzir o padrão a partir dessa amostra)."
        
        # 2. Lógica para PDF (PyPDF2 puro)
        elif filename.endswith('.pdf'):
            conteudo_arquivo = io.BytesIO(response.content)
            reader = PdfReader(conteudo_arquivo)
            texto_pdf = ""
            for page in reader.pages[:10]: # Limite de 10 páginas
                texto_pdf += page.extract_text() + "\n"
            contexto = f"Conteúdo extraído do PDF:\n{texto_pdf[:6000]}"
            
        else:
            return "Formato de arquivo não suportado pelo Argus."

        prompt = f"""
        Você é o ARGUS, operando em um Debian. Analise o seguinte conteúdo:
        
        --- INÍCIO DO CONTEÚDO ---
        {contexto}
        --- FIM DO CONTEÚDO ---
        
        Pergunta do usuário: {pergunta}
        
        Responda de forma analítica, técnica e direta.
        """
        
        return usar_gemini(prompt)

    except Exception as e:
        return f"Erro no processamento interno do arquivo: {str(e)}"

# Comandos antigos mantidos
def consolidar_aprendizado(dados):
    fatos = dados.get("fatos", [])
    if not fatos: return "Não houve novos aprendizados."
    texto_fatos = "\n".join([f"- {f['chave']}: {f['valor']}" for f in fatos])
    prompt = f"O usuário ensinou os seguintes fatos hoje:\n{texto_fatos}\nCrie um relatório de consolidação."
    return f"📚 **Consolidação:**\n\n{usar_gemini(prompt)}"

def process_command(data):
    input_text = data.get("text", "")
    prompt = f"Você é o ARGUS, assistente de terminal no Debian. Responda: {input_text}"
    return usar_gemini(prompt)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        try:
            payload = json.loads(sys.argv[1])
            tipo = payload.get("tipo")
            
            if tipo == "analisar_dados":
                resultado = analisar_documento(payload)
                print(json.dumps({"status": "success", "response": resultado}))
            elif tipo == "consolidar":
                resultado = consolidar_aprendizado(payload)
                print(json.dumps({"status": "success", "response": resultado}))
            else:
                resultado = process_command(payload)
                print(json.dumps({"status": "success", "response": resultado}))
        except Exception as e:
            print(json.dumps({"status": "error", "message": str(e)}))