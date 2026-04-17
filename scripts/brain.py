import sys
import json
import os
import requests
import sqlite3
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

GEMINI_KEY = os.getenv("GEMINI_API_KEY")
GROQ_KEY   = os.getenv("GROQ_API_KEY")
DB_PATH    = os.path.join(os.path.dirname(__file__), '../data/argus.sqlite')

# ─── Memória (SQLite como fonte única) ────────────────────────────────────────

def buscar_contexto_perfil() -> str:
    try:
        if not os.path.exists(DB_PATH):
            return ""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()

        partes = []

        cursor.execute("SELECT area, nivel, confianca FROM habilidades ORDER BY confianca DESC LIMIT 10")
        habs = cursor.fetchall()
        if habs:
            partes.append("[HABILIDADES DO LEO]\n" + "\n".join(
                f"- {area}: nível {nivel}, confiança {confianca}%" for area, nivel, confianca in habs
            ))

        cursor.execute("SELECT conceito, area FROM gaps WHERE status != 'resolvido' ORDER BY criado_em DESC LIMIT 5")
        gaps = cursor.fetchall()
        if gaps:
            partes.append("[GAPS CONHECIDOS]\n" + "\n".join(
                f"- {conceito} ({area or 'geral'})" for conceito, area in gaps
            ))

        cursor.execute("SELECT categoria, chave, valor FROM preferencias ORDER BY categoria LIMIT 20")
        prefs = cursor.fetchall()
        if prefs:
            partes.append("[PREFERÊNCIAS]\n" + "\n".join(
                f"- {categoria}/{chave}: {valor}" for categoria, chave, valor in prefs
            ))

        cursor.execute("SELECT descricao, codigo, linguagem FROM snippets ORDER BY criado_em DESC LIMIT 10")
        snips = cursor.fetchall()
        if snips:
            partes.append("[SNIPPETS DO LEO]\n" + "\n".join(
                f"- {desc} ({lang}): {cod}" for desc, cod, lang in snips
            ))

        conn.close()
        return "\n\n".join(partes)
    except Exception as e:
        return f"[Erro ao carregar perfil: {e}]"

# ─── LLM ──────────────────────────────────────────────────────────────────────

def tentar_gemini(mensagens: list, instrucao: str) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_KEY}"

    contents = []
    for msg in mensagens:
        role = "user" if msg["papel"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": msg["conteudo"]}]})

    payload = {
        "system_instruction": {"parts": [{"text": instrucao}]},
        "contents": contents
    }

    response = requests.post(url, json=payload, timeout=20)
    response.raise_for_status()
    return response.json()['candidates'][0]['content']['parts'][0]['text']

def tentar_groq(mensagens: list, instrucao: str) -> str:
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"}

    messages = [{"role": "system", "content": instrucao}]
    for msg in mensagens:
        messages.append({"role": msg["papel"], "content": msg["conteudo"]})

    payload = {
        "model": "llama-3.1-8b-instant",
        "messages": messages
    }

    response = requests.post(url, headers=headers, json=payload, timeout=20)
    response.raise_for_status()
    return response.json()['choices'][0]['message']['content']

# ─── Ações ────────────────────────────────────────────────────────────────────

def acao_chat(dados: dict) -> dict:
    texto        = dados.get("text", "")
    historico    = dados.get("historico", [])
    contexto_rag = dados.get("contexto_rag", "")

    perfil = buscar_contexto_perfil()

    instrucao = (
        "Você é o ARGUS, assistente pessoal do Leo — estudante de ADS, suporte remoto em telecom, "
        "em transição para NOC e depois DevOps/SRE.\n"
        "Seja direto, técnico e sem enrolação. Não repita o que o usuário disse.\n\n"
        f"{perfil}\n"
        f"{contexto_rag}"
    ).strip()

    # Monta histórico + mensagem atual
    mensagens = list(historico) + [{"papel": "user", "conteudo": texto}]

    try:
        resposta = tentar_gemini(mensagens, instrucao)
    except Exception:
        resposta = "(Redundância Groq) " + tentar_groq(mensagens, instrucao)

    return {"status": "success", "response": resposta}

def acao_extrair(dados: dict) -> dict:
    fragmento = dados.get("text", "")

    instrucao = (
        "Você é um extrator de conhecimento. Leia o fragmento abaixo e extraia o principal conceito técnico. "
        "Retorne ESTRITAMENTE um objeto JSON válido no formato: "
        '{"topico": "Nome do conceito", "resumo": "Explicação técnica direta", "tags": "tag1, tag2"}. '
        "Sem Markdown, sem crases, sem texto além do JSON."
    )

    mensagens = [{"papel": "user", "conteudo": fragmento}]

    try:
        resposta = tentar_gemini(mensagens, instrucao)
        resposta = resposta.replace('```json', '').replace('```', '').strip()
        return {"status": "success", "response": resposta}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def acao_consolidar(dados: dict) -> dict:
    fatos = dados.get("fatos", [])

    instrucao = (
        "Você é o ARGUS. Consolide os fatos abaixo em um resumo técnico conciso "
        "do que o Leo aprendeu ou registrou hoje."
    )

    conteudo = "\n".join(f"- {f['chave']}: {f['valor']}" for f in fatos) or "Nenhum fato registrado."
    mensagens = [{"papel": "user", "conteudo": conteudo}]

    try:
        resposta = tentar_gemini(mensagens, instrucao)
        return {"status": "success", "response": resposta}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def acao_analisar_dados(dados: dict) -> dict:
    url_arquivo = dados.get("url", "")
    pergunta    = dados.get("text", "Faça um resumo analítico deste documento.")

    instrucao = "Você é o ARGUS. Analise o conteúdo fornecido e responda à pergunta do Leo de forma técnica e direta."

    try:
        response = requests.get(url_arquivo, timeout=30)
        response.raise_for_status()
        conteudo_bruto = response.text[:8000]
    except Exception as e:
        return {"status": "error", "message": f"Falha ao baixar arquivo: {e}"}

    mensagens = [{"papel": "user", "conteudo": f"{pergunta}\n\n[CONTEÚDO]\n{conteudo_bruto}"}]

    try:
        resposta = tentar_gemini(mensagens, instrucao)
        return {"status": "success", "response": resposta}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        dados = json.loads(sys.stdin.read())
        tipo  = dados.get("tipo", "chat")

        if tipo == "extrair":
            resultado = acao_extrair(dados)
        elif tipo == "consolidar":
            resultado = acao_consolidar(dados)
        elif tipo == "analisar_dados":
            resultado = acao_analisar_dados(dados)
        else:
            resultado = acao_chat(dados)

        print(json.dumps(resultado))

    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))