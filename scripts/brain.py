import sys
import json
import os
import requests

def usar_gemini(prompt):
    # Puxa a chave secreta do ambiente local
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return json.dumps({"status": "error", "message": "API Key não configurada no ambiente."})

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    
    # A MÁGICA: O Protocolo de Comportamento (System Instruction)
    payload = {
        "systemInstruction": {
            "parts": [{
                "text": "Você é o ARGUS, um assistente técnico de infraestrutura, backend e monitoramento que roda no servidor Debian (Compaq 510) do Leo. REGRA DE OURO: NUNCA se apresente. NUNCA diga 'Olá' ou 'Sou o Argus'. Vá direto ao ponto, seja conciso, letal e pragmático nas respostas. Responda em Markdown estruturado para facilitar a leitura no dashboard."
            }]
        },
        "contents": [{"parts": [{"text": prompt}]}]
    }

    try:
        # Dispara para a nuvem
        response = requests.post(url, headers={'Content-Type': 'application/json'}, json=payload)
        response.raise_for_status() 
        
        dados = response.json()
        texto_resposta = dados['candidates'][0]['content']['parts'][0]['text']
        
        # Devolve sucesso para o Node.js
        return json.dumps({"status": "success", "response": texto_resposta})
        
    except requests.exceptions.HTTPError as e:
        # Oculta a URL/Key no erro, mostrando só o código
        return json.dumps({"status": "error", "message": f"Acesso à Nuvem Indisponível (Erro {e.response.status_code}). Tente novamente em instantes."})
    except Exception as e:
        return json.dumps({"status": "error", "message": "Falha crítica no circuito neural ao contatar a IA."})

if __name__ == "__main__":
    # Garante que os acentos do português não quebrem a comunicação com o Node.js
    sys.stdout.reconfigure(encoding='utf-8')
    
    try:
        # Recebe o pacote de dados enviado pelo server.ts
        raw_input = sys.argv[1]
        dados = json.loads(raw_input)
        
        tipo = dados.get("tipo", "chat")
        texto = dados.get("text", "")
        
        if tipo == "chat":
            resultado = usar_gemini(texto)
            print(resultado)
        else:
            print(json.dumps({"status": "error", "message": "Comando desconhecido pelo Cérebro."}))
            
    except IndexError:
        print(json.dumps({"status": "error", "message": "Nenhum dado neural recebido do sistema central."}))
    except json.JSONDecodeError:
        print(json.dumps({"status": "error", "message": "Falha ao decodificar os dados neurais (JSON inválido)."}))