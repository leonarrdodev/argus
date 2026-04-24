import sys
import json
import os
import sqlite3
import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

GEMINI_KEY = os.getenv("GEMINI_API_KEY")
GROQ_KEY   = os.getenv("GROQ_API_KEY")
DB_PATH    = os.path.join(os.path.dirname(__file__), '../data/argus.sqlite')

# ─── Contexto de perfil ───────────────────────────────────────────────────────

def buscar_contexto_perfil() -> str:
    if not os.path.exists(DB_PATH):
        return ""

    try:
        conn   = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        partes = []

        cursor.execute(
            "SELECT area, nivel, confianca FROM habilidades ORDER BY confianca DESC LIMIT 10"
        )
        habs = cursor.fetchall()
        if habs:
            partes.append("[HABILIDADES DO LEO]\n" + "\n".join(
                f"- {area}: nível {nivel}, confiança {confianca}%"
                for area, nivel, confianca in habs
            ))

        cursor.execute(
            "SELECT conceito, area FROM gaps WHERE status != 'resolvido' ORDER BY criado_em DESC LIMIT 5"
        )
        gaps = cursor.fetchall()
        if gaps:
            partes.append("[GAPS CONHECIDOS]\n" + "\n".join(
                f"- {conceito} ({area or 'geral'})" for conceito, area in gaps
            ))

        cursor.execute(
            "SELECT categoria, chave, valor FROM preferencias ORDER BY categoria LIMIT 20"
        )
        prefs = cursor.fetchall()
        if prefs:
            partes.append("[PREFERÊNCIAS]\n" + "\n".join(
                f"- {categoria}/{chave}: {valor}" for categoria, chave, valor in prefs
            ))

        cursor.execute(
            "SELECT descricao, codigo, linguagem FROM snippets ORDER BY criado_em DESC LIMIT 10"
        )
        snips = cursor.fetchall()
        if snips:
            partes.append("[SNIPPETS DO LEO]\n" + "\n".join(
                f"- {desc} ({lang}): {cod}" for desc, cod, lang in snips
            ))

        conn.close()
        return "\n\n".join(partes)

    except Exception as e:
        return f"[Erro ao carregar perfil: {e}]"

# ─── LLMs ─────────────────────────────────────────────────────────────────────

def tentar_gemini(mensagens: list, instrucao: str) -> str:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta"
        f"/models/gemini-2.0-flash:generateContent?key={GEMINI_KEY}"
    )

    contents = []
    for msg in mensagens:
        role = "user" if msg["papel"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": msg["conteudo"]}]})

    payload = {
        "system_instruction": {"parts": [{"text": instrucao}]},
        "contents": contents,
    }

    response = requests.post(url, json=payload, timeout=20)
    response.raise_for_status()
    return response.json()["candidates"][0]["content"]["parts"][0]["text"]


def tentar_groq(mensagens: list, instrucao: str, json_mode: bool = False) -> str:
    url     = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"}

    messages = [{"role": "system", "content": instrucao}]
    for msg in mensagens:
        # historico salva "assistant", Groq espera "assistant" — compatível
        messages.append({"role": msg["papel"], "content": msg["conteudo"]})

    payload: dict = {"model": "llama-3.1-8b-instant", "messages": messages}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    response = requests.post(url, headers=headers, json=payload, timeout=20)
    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"]


def chamar_llm(mensagens: list, instrucao: str, json_mode: bool = False) -> str:
    """Tenta Gemini primeiro, cai no Groq se falhar."""
    try:
        return tentar_gemini(mensagens, instrucao)
    except Exception as e:
        print(f"[Aviso] Gemini falhou: {e}. Tentando Groq...", file=sys.stderr)
        return tentar_groq(mensagens, instrucao, json_mode=json_mode)

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

    mensagens = list(historico) + [{"papel": "user", "conteudo": texto}]

    resposta = chamar_llm(mensagens, instrucao)
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
        resposta = chamar_llm(mensagens, instrucao, json_mode=True)
        resposta = resposta.replace("```json", "").replace("```", "").strip()
        # Valida se é JSON antes de retornar
        json.loads(resposta)
        return {"status": "success", "response": resposta}
    except json.JSONDecodeError as e:
        return {"status": "error", "message": f"Resposta do LLM não é JSON válido: {e}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


def acao_consolidar(dados: dict) -> dict:
    fatos = dados.get("fatos", [])

    instrucao = (
        "Você é o ARGUS. Consolide os fatos abaixo em um resumo técnico conciso "
        "do que o Leo aprendeu ou registrou."
    )

    conteudo  = "\n".join(f"- {f['chave']}: {f['valor']}" for f in fatos) or "Nenhum fato registrado."
    mensagens = [{"papel": "user", "conteudo": conteudo}]

    try:
        resposta = chamar_llm(mensagens, instrucao)
        return {"status": "success", "response": resposta}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        dados     = json.loads(sys.stdin.read())
        tipo      = dados.get("tipo", "chat")

        if tipo == "extrair":
            resultado = acao_extrair(dados)
        elif tipo == "consolidar":
            resultado = acao_consolidar(dados)
        else:
            resultado = acao_chat(dados)

        print(json.dumps(resultado))

    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))