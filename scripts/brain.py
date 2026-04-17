import sys
import json
import os
import requests
import re
import sqlite3
from dotenv import load_dotenv

# Carrega chaves do .env
load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

MEMORY_FILE = os.path.join(os.path.dirname(__file__), '../memory.json')
GEMINI_KEY = os.getenv("GEMINI_API_KEY")
GROQ_KEY = os.getenv("GROQ_API_KEY")
DB_PATH = os.path.join(os.path.dirname(__file__), '../data/argus.sqlite')

def buscar_snippets_relevantes():
    try:
        if not os.path.exists(DB_PATH): return ""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT descricao, codigo, linguagem FROM snippets ORDER BY criado_em DESC LIMIT 10")
        resultados = cursor.fetchall()
        conn.close()
        if not resultados: return ""
        
        contexto = "\n\n[MEMÓRIA DE SNIPPETS DO LEO]\n"
        for desc, cod, lang in resultados:
            contexto += f"- {desc} ({lang}): {cod}\n"
        return contexto
    except Exception: return ""

def carregar_memoria():
    try:
        if os.path.exists(MEMORY_FILE):
            with open(MEMORY_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception: pass
    return {"fatos": {}, "contexto_estudo": "Backend", "preferencias": {}}

def salvar_memoria(memoria):
    with open(MEMORY_FILE, 'w', encoding='utf-8') as f:
        json.dump(memoria, f, indent=4, ensure_ascii=False)

def tentar_gemini(prompt, instrucao):
    url = f"https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key={GEMINI_KEY}"
    payload = {"contents": [{"parts": [{"text": f"SYSTEM: {instrucao}\nUSER: {prompt}"}]}]}
    response = requests.post(url, json=payload, timeout=15)
    response.raise_for_status()
    return response.json()['candidates'][0]['content']['parts'][0]['text']

def tentar_groq(prompt, instrucao):
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"}
    payload = {
        "model": "llama-3.1-8b-instant",
        "messages": [{"role": "system", "content": instrucao}, {"role": "user", "content": prompt}]
    }
    response = requests.post(url, headers=headers, json=payload, timeout=15)
    response.raise_for_status()
    return response.json()['choices'][0]['message']['content']

def processar_resposta(texto, memoria):
    padrao = r"SET_MEM\[(\w+)=([^\]]+)\]"
    matches = re.findall(padrao, texto)
    for chave, valor in matches:
        if chave == 'estudo': memoria['contexto_estudo'] = valor
        else: memoria['preferencias'][chave] = valor
    if matches: salvar_memoria(memoria)
    return re.sub(padrao, "", texto).strip()

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        dados = json.loads(sys.argv[1])
        tipo_acao = dados.get("tipo", "chat")
        
        if tipo_acao == "extrair":
            # MOTOR D: Extração de Conceitos em JSON (Background)
            fragmento = dados.get("text", "")
            instrucao = (
                "Você é um extrator de conhecimento. Leia o fragmento de texto abaixo e extraia o principal conceito técnico ensinado. "
                "Retorne ESTRITAMENTE um objeto JSON válido no formato: "
                '{"topico": "Nome do conceito", "resumo": "Explicação técnica direta", "tags": "tag1, tag2"}. '
                "Não inclua formatação Markdown, crases ou qualquer outro texto além do JSON."
            )
            try:
                resposta = tentar_gemini(fragmento, instrucao)
                # Limpa possível formatação markdown do JSON
                resposta = resposta.replace('```json', '').replace('```', '').strip()
                print(json.dumps({"status": "success", "response": resposta}))
            except Exception as e:
                print(json.dumps({"status": "error", "message": str(e)}))
                
        else:
            # MOTOR CHAT NORMAL
            prompt = dados.get("text", "")
            contexto_rag = dados.get("contexto_rag", "")
            memoria = carregar_memoria()
            contexto_snippets = buscar_snippets_relevantes()

            instrucao = (
                f"Você é o ARGUS, assistente do Leo. "
                f"Foco atual: {memoria.get('contexto_estudo')}. "
                f"{contexto_snippets}\n{contexto_rag}\n"
                "Use SET_MEM[chave=valor] se aprender algo pessoal do usuário."
            )

            try:
                resposta = tentar_gemini(prompt, instrucao)
            except Exception:
                resposta = "*(Redundância Groq)* " + tentar_groq(prompt, instrucao)

            texto_final = processar_resposta(resposta, memoria)
            print(json.dumps({"status": "success", "response": texto_final}))

    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))