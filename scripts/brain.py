import sys
import json
import os
import requests
import re
from dotenv import load_dotenv

# Carrega as chaves do .env
load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

MEMORY_FILE = os.path.join(os.path.dirname(__file__), '../memory.json')
GEMINI_KEY = os.getenv("GEMINI_API_KEY")
GROQ_KEY = os.getenv("GROQ_API_KEY")

def carregar_memoria():
    try:
        if os.path.exists(MEMORY_FILE):
            with open(MEMORY_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # Garante que as chaves básicas sempre existam (Sanitização)
                if "fatos" not in data: data["fatos"] = {}
                if "preferencias" not in data: data["preferencias"] = {}
                if "contexto_estudo" not in data: data["contexto_estudo"] = ""
                return data
    except Exception:
        pass
    return {"fatos": {}, "contexto_estudo": "", "preferencias": {}}

def salvar_memoria(memoria):
    with open(MEMORY_FILE, 'w', encoding='utf-8') as f:
        json.dump(memoria, f, indent=4, ensure_ascii=False)

def tentar_gemini(prompt, instrucao):
    # Mudança crucial: gemini-1.5-flash-latest na v1beta
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key={GEMINI_KEY}"
    payload = {
        "contents": [{"parts": [{"text": f"SYSTEM: {instrucao}\nUSER: {prompt}"}]}]
    }
    response = requests.post(url, json=payload, timeout=10)
    if response.status_code != 200:
        print(f"DEBUG GEMINI ERRO: {response.text}")
        response.raise_for_status()
    return response.json()['candidates'][0]['content']['parts'][0]['text']

def tentar_groq(prompt, instrucao):
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"}
    payload = {
        "model": "llama-3.1-8b-instant",
        "messages": [
            {"role": "system", "content": instrucao},
            {"role": "user", "content": prompt}
        ]
    }
    response = requests.post(url, headers=headers, json=payload, timeout=10)
    response.raise_for_status()
    return response.json()['choices'][0]['message']['content']

def processar_resposta(texto_completo, memoria):
    padrao = r"SET_MEM\[(\w+)=([^\]]+)\]"
    matches = re.findall(padrao, texto_completo)
    for chave, valor in matches:
        if chave == 'nome': memoria['fatos']['nome'] = valor
        elif chave == 'estudo': memoria['contexto_estudo'] = valor
        else: 
            # Proteção contra KeyError
            if 'preferencias' not in memoria: memoria['preferencias'] = {}
            memoria['preferencias'][chave] = valor
    if matches: salvar_memoria(memoria)
    return re.sub(padrao, "", texto_completo).strip()

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        dados = json.loads(sys.argv[1])
        prompt = dados.get("text", "")
        memoria = carregar_memoria()
        
        instrucao = (
            f"Você é o ARGUS. Usuário: {memoria['fatos'].get('nome', 'Leo')}. "
            f"Foco: {memoria.get('contexto_estudo', 'Backend')}. "
            "Se aprender algo, use SET_MEM[chave=valor]."
        )

        status = "success"
        try:
            resposta = tentar_gemini(prompt, instrucao)
        except Exception as e:
            print(f"DEBUG GEMINI: {e}")
            try:
                resposta = tentar_groq(prompt, instrucao)
                resposta = "*(Redundância Ativada)* " + resposta
            except Exception as e2:
                print(f"DEBUG GROQ: {e2}")
                resposta = "Falha crítica nos motores neurais."
                status = "error"

        texto_final = processar_resposta(resposta, memoria)
        print(json.dumps({"status": status, "response": texto_final}))

    except Exception as e:
        print(json.dumps({"status": "error", "message": f"Erro fatal: {str(e)}"}))