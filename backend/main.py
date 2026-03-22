"""
AI Insight Architect — FastAPI Backend (v2.0)

Reuses all existing backend modules in /backend/:
  rag_service.py     → scrape_pages, retrieve_context
  pexels_service.py     → get_pexels_video (YouTube)
  wikipedia_service.py  → get_wikipedia_image
  rag.py             → local knowledge-base search
  pdf_generator.py   → topic PDF report
  teacher_service.py → _parse_groq_json helper
"""

import os
import sys
import json
import re

# ── Add backend dir to path so sibling modules import cleanly ────────────────
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _BACKEND_DIR)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.requests import Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

# Load .env from project root (one level up from backend/)
load_dotenv(os.path.join(_BACKEND_DIR, '..', '.env'))

GROQ_API_KEY  = os.getenv("GROQ_API_KEY", "")
PEXELS_API_KEY = os.getenv("PEXELS_API_KEY", "")

# ── Groq client ───────────────────────────────────────────────────────────────
from groq import Groq
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

# ── DDGS (DuckDuckGo Search) ──────────────────────────────────────────────────
DDGS = None
DDGS_AVAILABLE = False
try:
    from ddgs import DDGS
    DDGS_AVAILABLE = True
except ImportError:
    try:
        from duckduckgo_search import DDGS
        DDGS_AVAILABLE = True
    except ImportError:
        pass

# ── Playwright availability ───────────────────────────────────────────────────
PLAYWRIGHT_AVAILABLE = False
try:
    from playwright.sync_api import sync_playwright  # noqa: F401
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    pass

# ── Existing backend modules ──────────────────────────────────────────────────
# rag_service: scrape_pages(urls) → str,  retrieve_context(query, text) → str
from rag_service import scrape_pages, retrieve_context

# pexels_service: get_pexels_video(query)  → YouTube embed url|None
from pexels_service import get_pexels_video

# wikipedia_service: get_wikipedia_image(query) → url|None
from wikipedia_service import get_wikipedia_image

# rag.py: local knowledge-base (pre-loaded FAISS index)
from rag import search_knowledge

# pdf_generator (available if needed later)
from pdf_generator import generate_topic_pdf  # noqa: F401

# _parse_groq_json from teacher_service (strips markdown fences from LLM JSON)
try:
    from teacher_service import _parse_groq_json
    print("✅ teacher_service._parse_groq_json loaded.")
except Exception as _te:
    print(f"⚠  teacher_service import skipped ({_te}); using built-in parser.")
    def _parse_groq_json(raw: str) -> dict:
        raw = raw.strip()
        raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.S)
        raw = re.sub(r'\s*```$',           '', raw, flags=re.S)
        m = re.search(r'\{.*\}', raw, re.S)
        if m:
            raw = m.group(0)
        return json.loads(raw)

# ── Embedding model status ────────────────────────────────────────────────────
EMBEDDING_AVAILABLE = False
try:
    from rag_service import embedding_model
    EMBEDDING_AVAILABLE = embedding_model is not None
except Exception:
    pass

print(f"✅ Backend ready — Groq={'set' if GROQ_API_KEY else '⚠ missing'} | "
      f"DDGS={DDGS_AVAILABLE} | Playwright={PLAYWRIGHT_AVAILABLE} | "
      f"Embeddings={EMBEDDING_AVAILABLE}")


# ══════════════════════════════════════════════════════════════════════════════
#  FastAPI App
# ══════════════════════════════════════════════════════════════════════════════

app = FastAPI(
    title="AI Insight Architect",
    description=(
        "Searches the web, extracts knowledge with RAG, "
        "and generates structured AI explanations via Groq."
    ),
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ══════════════════════════════════════════════════════════════════════════════
#  Pydantic Models
# ══════════════════════════════════════════════════════════════════════════════

class ExplainRequest(BaseModel):
    query: str
    level: str = "all"
    include_code: bool = True
    max_sources: int = 5

class QuizRequest(BaseModel):
    topic: str
    level: str = "intermediate"
    context: str = ""

class SocraticRequest(BaseModel):
    topic: str
    user_answer: str = ""
    conversation_history: list = []
    level: str = "intermediate"

class TeachAIRequest(BaseModel):
    topic: str
    user_explanation: str
    level: str = "intermediate"


# ══════════════════════════════════════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════════════════════════════════════

def _search_with_meta(query: str, max_results: int = 5) -> list[dict]:
    """
    Enhanced search for both general educational content AND research papers.
    """
    if not DDGS_AVAILABLE or DDGS is None:
        return []
    
    all_results = []
    # Query 1: General Research & Explanation
    # Query 2: Academic Papers (arXiv, Google Scholar, ResearchGate)
    search_variants = [query, f"{query} research papers arxiv paperwithcode"]
    
    try:
        ddgs = DDGS()
        for q in search_variants:
            raw = ddgs.text(q, max_results=max_results)
            if not raw: continue
            for r in raw:
                url = r.get('href') or r.get('link') or r.get('url', '')
                if url:
                    all_results.append({
                        'title':   r.get('title', '') or url,
                        'url':     url,
                        'snippet': r.get('body') or r.get('snippet', ''),
                    })
    except Exception as e:
        print(f"  ⚠ Multi-source search error: {e}")
    
    # Deduplicate by URL
    seen = set()
    unique_results = []
    for r in all_results:
        if r['url'] not in seen:
            unique_results.append(r)
            seen.add(r['url'])
            
    return unique_results[:max_results + 3] # Return slightly more for better context coverage


def _build_prompt(query: str, context: str, level: str, include_code: bool) -> str:
    # ── Define Dynamic Constraints per Level ──────────────────────────────────
    # This ensures that selecting "Beginner" actually changes the content depth.
    if level == "beginner":
        persona = "You are a friendly, elite educator explaining complex topics to someone with NO technical background. Use metaphors from daily life."
        beginner_req = "Primary section. 600+ words. Deep, creative analogies. No jargon."
        mechanics_req = "Simplified overview of how it works. 200 words. Conceptual only."
        advanced_req = "High-level summary of research impact. 150 words. ABSOLUTELY NO math formulas or LaTeX equations."
    elif level == "advanced":
        persona = "You are a Research Lead at a major AI Lab (like OpenAI or DeepMind) explaining to a PhD student. High technical density required."
        beginner_req = "Condensed refresher. 150 words. Focus on precise technical definitions."
        mechanics_req = "Deep architectural dive. 400+ words. Focus on low-level system internals and data flow."
        advanced_req = "Master-class research synthesis. 800+ words. Extensive Mathematical Foundations in LaTeX. Derivations, loss functions, and research paper trade-offs."
    elif level == "intermediate":
        persona = "You are a Senior Software Architect. Focus on industry implementation and design patterns."
        beginner_req = "Professional introduction. 250 words. Use industrial analogies."
        mechanics_req = "Exhaustive Implementation & Component Logic. 600+ words. Focus on engineering trade-offs."
        advanced_req = "Core mathematical principles. 300 words. Key formulas only, explained through an engineering lens."
    else: # "all" or fallback
        persona = "You are the World's most advanced AI Insight Architect. Provide a full Master-class report covering all knowledge levels."
        beginner_req = "Intuitive Foundation. 250+ words."
        mechanics_req = "Industry Architecture. 450+ words."
        advanced_req = "Research & Mathematical Internals. 600+ words. Extensive LaTeX math."

    code_instr = (
        f"Include a clean, well-commented Python implementation showing {'simplified' if level=='beginner' else 'production-grade'} core logic."
        if include_code else "No code example requested."
    )

    math_rigor = 'Avoid math formulas entirely, use text descriptions.' if level=='beginner' else 'Use DOUBLE BACKSLASHES (\\\\theta, \\\\frac) for all LaTeX.'

    return f"""{persona}
Query: "{query}"

Real-time Scraped Research Context (Websites + Research Papers):
---
{context[:7500]}
---

YOUR MISSION: Create a high-fidelity, research-backed report tailored specifically for a {level.upper()} audience.
REQUIRED SECTIONS IN OUTPUT:
- Intuition & Foundations
- Mathematical Foundations (LaTeX requirement varies by level)
- Architectural Overview
- Research Insights
- Industrial Applications

D2 DIAGRAM RULES:
- Map the INTERNAL SYSTEM ARCHITECTURE specific to the topic.
- Use `direction: down` direction.
- Keep labels short (max 3 words).
- Example: `A -> B: Data Flow`.

Return ONLY a valid JSON object. 
MATHEMATICAL RIGOR: {math_rigor}

{{
  "title": "Professional Tech Title",
  "summary": "Academic executive summary",
  "beginner_explanation": "{beginner_req}",
  "core_mechanics": "{mechanics_req}",
  "advanced_concepts": "{advanced_req}",
  "code_example": "Python code string",
  "key_takeaways": ["point 1", "point 2", "point 3", "point 4", "point 5"],
  "real_world_applications": ["App 1", "App 2", "App 3"],
  "d2_code": "direction: down\\nModule.A -> Module.B: \\"Data Flow\\"",
  "visual_query": "Tech Stock Photo keyword",
  "video_query": "YouTube Search Query"
}}"""

def _sanitize_d2(d2: str) -> str:
    """Robustly clean AI-generated D2 diagram code before sending to Kroki."""
    if not d2:
        return ""

    # Strip markdown fences
    d2 = re.sub(r'^```(?:d2)?\s*', '', d2.strip(), flags=re.I)
    d2 = re.sub(r'\s*```\s*$', '', d2)

    # Expand collapsed single-line D2 (semicolon or space-brace separated)
    if "\n" not in d2:
        d2 = re.sub(r';\s*', '\n', d2)
        d2 = d2.replace('{ ', '{\n  ').replace(' }', '\n}')

    clean_lines = []
    for line in d2.splitlines():
        stripped = line.strip()

        # Keep blank lines, direction, and container braces as-is
        if not stripped or stripped in ('{', '}') or re.match(r'^direction\s*:', stripped):
            clean_lines.append(line)
            continue

        # Handle connection lines: anything containing ->
        if '->' in stripped:
            # Split on first colon after the arrow target
            # Pattern: <source> -> <target>: <label>
            conn_match = re.match(r'^([^:]+->\s*[^:{]+)(?::\s*(.*))?$', stripped)
            if conn_match:
                conn_part = conn_match.group(1).rstrip()
                label_part = (conn_match.group(2) or "").strip()

                # Strip surrounding quotes if already quoted
                if label_part.startswith('"') and label_part.endswith('"'):
                    label_part = label_part[1:-1]

                # Remove anything after a closing quote (trailing garbage)
                # e.g. "Transaction Data" (flows here)  =>  Transaction Data
                label_part = re.sub(r'".*?"\s*.*', lambda m: m.group(0).split('"')[1], label_part)

                # Truncate to 4 words max (D2 labels must be short)
                words = label_part.split()
                label_part = ' '.join(words[:4]) if words else ''

                # Re-quote cleanly
                label = f'"{label_part}"' if label_part else '""'
                clean_lines.append(f"{conn_part}: {label}")
            else:
                clean_lines.append(line)
            continue

        # All other lines (node definitions, container names) — keep as-is
        clean_lines.append(line)

    result = '\n'.join(clean_lines)
    if result and not result.endswith('\n'):
        result += '\n'
    return result


def _llm_explain(query: str, context: str, level: str, include_code: bool) -> dict:
    if not groq_client:
        raise HTTPException(
            status_code=500,
            detail="GROQ_API_KEY not set in .env — please add it and restart the server.",
        )
    try:
        resp = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": _build_prompt(query, context, level, include_code)}],
            temperature=0.4,
            max_tokens=4000,
            response_format={"type": "json_object"},
        )
        raw_content = resp.choices[0].message.content.strip()
        data = _parse_groq_json(raw_content)

        # ── Sanitize & Repair D2 Code ──
        d2 = (data.get("d2_code") or data.get("mermaid_code") or "").strip()
        d2 = _sanitize_d2(d2)
        data["d2_code"] = d2
        print(f"  → Final D2 Source (Fixed):\n{d2}")

        return data
    except json.JSONDecodeError as e:
        print(f"❌ JSON Decode Error: {e}")
        print(f"RAW CONTENT: {raw_content[:2000]}")
        raise HTTPException(status_code=500, detail=f"LLM returned invalid JSON: {e}")
    except Exception as e:
        import traceback
        print(f"❌ Groq LLM Error: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Groq LLM error: {e}")

def _build_quiz_prompt(topic: str, level: str, context: str) -> str:
    return f"""You are an elite AI Learning Architect. Create a PRESTIGE level interactive quiz for: "{topic}".
Audience Level: {level}
Data Context: {context[:6000]}

MISSION: Generate 5 diverse, high-difficulty questions that force deep conceptual thought.
CRITICAL: Every single question MUST be a Multiple Choice Question (MCQ) with exactly 4 options.

MIX THESE MODES:
1. "Scenario": A complex troubleshooting situation or design decision. You MUST provide 4 distinct potential solutions as options.
2. "Match": (Logic Pairing) Provide 4 pairs of concept->definition. Options should be 4 possible sets of pairings.
3. "Boolean": (True/False) Focus on a "gotcha" or subtle technical error. Options must be ["True", "False"].
4. "Code": A snippet with critical logic replaced by "_____". Options should be 4 possible code completions.

SCHEMA RULES:
- "question": The clear, challenging question or scenario text.
- "options": A list of EXACTLY 4 strings (Except for Boolean which has 2). MUST be a valid array with at least 2 items.
- "correct_answer": MUST be an integer index (0, 1, 2, or 3) pointing to the correct option in the options array. For Boolean mode, use 0 for True and 1 for False.
- "intervention": A detailed 'Why you missed it' explanation.
- "concept": The core concept being tested.

CRITICAL: Ensure correct_answer is always a valid integer index within the bounds of the options array. If options has 4 items, correct_answer must be 0, 1, 2, or 3.

Return ONLY valid JSON:
{{
  "quiz_title": "Interactive Mastery: {topic}",
  "mastery_summary": "A brief overview of why this quiz represents complete mastery of the topic.",
  "questions": [
    {{
      "id": 1,
      "mode": "Scenario|Match|Boolean|Code",
      "question": "...",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "pairs": {{"Key": "Value"}}, 
      "correct_answer": 0,
      "intervention": "Wait! You likely confused X with Y because...",
      "explanation": "Scientific justification for the correct answer.",
      "concept": "Core Concept"
    }}
  ],
  "knowledge_map": ["Concept 1", "Concept 2"]
}}"""

def _llm_quiz(topic: str, level: str, context: str) -> dict:
    if not groq_client: return {"error": "Groq not set"}
    try:
        resp = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": _build_quiz_prompt(topic, level, context)}],
            temperature=0.6,
            response_format={"type": "json_object"},
        )
        return _parse_groq_json(resp.choices[0].message.content)
    except Exception as e:
        print(f"Quiz Gen Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ══════════════════════════════════════════════════════════════════════════════
#  New Feature Helpers
# ══════════════════════════════════════════════════════════════════════════════

def _build_socratic_prompt(topic: str, user_answer: str, history: list, level: str) -> str:
    history_str = ""
    if history:
        for h in history[-3:]:  # Last 3 exchanges
            history_str += f"Q: {h.get('question', '')}\nA: {h.get('answer', '')}\n\n"
    
    if user_answer:
        return f"""You are a Socratic tutor guiding a student to understand: "{topic}".
Level: {level}

Previous conversation:
{history_str}

The student just answered: "{user_answer}"

Your task:
1. Evaluate their answer - is it correct, partially correct, incorrect, or did they say "I don't know"?
2. If they said "I don't know" or gave an incorrect/incomplete answer, provide a helpful HINT or CLUE first (not the full answer). Break down the concept into simpler parts or give a real-world analogy to help them think.
3. Then ask a simpler guiding question that they can answer based on the hint you provided.
4. If their answer was correct, acknowledge it and ask a deeper follow-up question.
5. Be encouraging but rigorous.

IMPORTANT: If they don't know, don't just ask another question - first give them a hint to help them understand, then ask a simpler question based on that hint.

Respond in JSON:
{{
  "is_correct": true/false/null,
  "feedback": "Brief feedback - if they didn't know, acknowledge their honesty and provide a helpful hint/clue first (1-2 sentences)",
  "next_question": "The next Socratic question - should be simpler if they didn't know before",
  "explanation": "Full explanation (revealed only after session completes)",
  "progress": 0-100
}}"""
    else:
        return f"""You are a Socratic tutor. The student wants to learn about: "{topic}".
Level: {level}

Ask an opening question that reveals what they already know. Make it thought-provoking but accessible.

Respond in JSON:
{{
  "is_correct": null,
  "feedback": "Welcome message",
  "next_question": "Opening Socratic question",
  "explanation": "",
  "progress": 0
}}"""

def _build_teach_ai_prompt(topic: str, user_explanation: str, level: str) -> str:
    return f"""You are an expert evaluator. A student is trying to explain "{topic}" to you (they are the teacher, you are the confused student).

Their explanation:
"{user_explanation}"

Evaluate their teaching:
1. Did they cover the core concept?
2. Is their explanation accurate?
3. Did they use clear analogies or examples?
4. What gaps or misconceptions exist?

Respond as a confused student asking clarifying questions, then reveal your evaluation.

Respond in JSON:
{{
  "student_response": "Your response as a confused student (ask 1-2 clarifying questions or express confusion)",
  "evaluation": {{
    "score": 0-100,
    "strengths": ["What they explained well"],
    "gaps": ["What they missed"],
    "misconceptions": ["Any errors in their explanation"],
    "suggestions": ["How to improve their explanation"]
  }},
  "perfect_explanation": "A model explanation they should aim for (1-2 paragraphs)",
  "is_final": false
}}"""

def _llm_socratic(topic: str, user_answer: str, history: list, level: str) -> dict:
    if not groq_client: return {"error": "Groq not set"}
    try:
        resp = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": _build_socratic_prompt(topic, user_answer, history, level)}],
            temperature=0.7,
            response_format={"type": "json_object"},
        )
        return _parse_groq_json(resp.choices[0].message.content)
    except Exception as e:
        print(f"Socratic Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def _llm_teach_ai(topic: str, user_explanation: str, level: str) -> dict:
    if not groq_client: return {"error": "Groq not set"}
    try:
        resp = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": _build_teach_ai_prompt(topic, user_explanation, level)}],
            temperature=0.6,
            response_format={"type": "json_object"},
        )
        return _parse_groq_json(resp.choices[0].message.content)
    except Exception as e:
        print(f"Teach AI Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@app.post("/quiz")
async def get_quiz(req: QuizRequest):
    """Generates an advanced interactive quiz with Wikipedia-powered visual questions."""
    print(f"🎲 Generating High-Fidelity Quiz: {req.topic}")
    try:
        data = _llm_quiz(req.topic, req.level, req.context)
        
        # Inject Wikipedia images for Visual questions
        for q in data.get("questions", []):
            if q.get("mode") == "Visual" and q.get("visual_query"):
                q["image_url"] = get_wikipedia_image(q["visual_query"])
        
        return JSONResponse(content=data)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ══════════════════════════════════════════════════════════════════════════════
#  API Routes
# ══════════════════════════════════════════════════════════════════════════════

# Root route removed to allow static frontend serving via app.mount("/", ...)


@app.get("/health")
def health():
    """Confirm all modules loaded + keys are set."""
    return {
        "status":          "ok",
        "groq_key_set":    bool(GROQ_API_KEY),
        "pexels_key_set":  bool(PEXELS_API_KEY),
        "embedding_model": "loaded" if EMBEDDING_AVAILABLE else "unavailable",
        "playwright":      PLAYWRIGHT_AVAILABLE,
        "ddgs":            DDGS_AVAILABLE,
        "modules": {
            "rag_service":       True,
            "pexels_service":    True,
            "wikipedia_service": True,
            "rag":               True,
            "pdf_generator":     True,
        },
    }


@app.post("/explain")
def explain(req: ExplainRequest):
    """
    Full RAG + LLM pipeline:
      1. DuckDuckGo search (DDGS)
      2. Playwright/requests scraping   ← rag_service.scrape_pages()
      3. FAISS vector retrieval         ← rag_service.retrieve_context()
      4. Local knowledge-base boost     ← rag.search_knowledge()
      5. LLM synthesis                  ← Groq llama-3.3-70b-versatile
      6. Wikipedia hero image           ← wikipedia_service.get_wikipedia_image()
      7. YouTube tutorial embed         ← pexels_service.get_pexels_video()
    """
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    print(f"\n{'='*60}")
    print(f"🔍  Query : {req.query!r}")
    print(f"    Level : {req.level}  |  Sources : {req.max_sources}  |  Code : {req.include_code}")
    print(f"{'='*60}")

    # ── 1. Web search ────────────────────────────────────────────────────────
    print("  [1/7] Web search…")
    search_results = _search_with_meta(req.query, max_results=req.max_sources)
    urls = [r["url"] for r in search_results if r.get("url")]
    print(f"        → {len(urls)} URLs found")

    # ── 2. Scrape pages (via rag_service) ────────────────────────────────────
    print("  [2/7] Scraping pages…")
    raw_text = scrape_pages(urls) if urls else ""

    # Fallback: use search snippets so we always have some context
    if not raw_text.strip():
        print("        → Scraping yielded nothing; using search snippets.")
        raw_text = "\n\n".join(
            f"Source: {r['url']}\nTitle: {r['title']}\n{r['snippet']}"
            for r in search_results
        )

    # ── 3. FAISS RAG retrieval (via rag_service) ─────────────────────────────
    print("  [3/7] RAG vector retrieval…")
    context = retrieve_context(req.query, raw_text, top_k=5)

    # ── 4. Local knowledge-base boost (via rag.py) ───────────────────────────
    print("  [4/7] Local KB search…")
    local_hits = search_knowledge(req.query, top_k=3)
    if local_hits:
        kb_lines = "\n".join(
            f"- {h['text']}  (Source: {h['source']})" for h in local_hits
        )
        context = (
            f"LOCAL KNOWLEDGE BASE CONTEXT:\n{kb_lines}\n\n"
            f"──────────────────────\n\nWEB RESEARCH CONTEXT:\n{context}"
        )
        print(f"        → Injected {len(local_hits)} local KB hits")

    # ── 5. LLM explanation (Groq) ────────────────────────────────────────────
    print("  [5/7] Generating explanation via Groq…")
    data = _llm_explain(req.query, context, req.level, req.include_code)

    # ── 6. Wikipedia hero image ───────────────────────────────────────────────
    visual_q = data.get("visual_query") or req.query
    print(f"  [6/7] Fetching image  : '{visual_q}'")
    data["image_url"] = get_wikipedia_image(visual_q)

    # ── 7. YouTube tutorial embed ────────────────────────────────────────────
    video_q = data.get("video_query") or f"{req.query} explained tutorial"
    print(f"  [7/7] Fetching video  : '{video_q}'")
    data["video_url"] = get_pexels_video(video_q)

    # ── Attach sources list ──────────────────────────────────────────────────
    data["sources"] = [
        {"title": r["title"], "url": r["url"]}
        for r in search_results if r.get("url")
    ]

    print("  ✅  Pipeline complete.\n")
    return JSONResponse(content=data)

@app.post("/quiz")
async def get_quiz(req: QuizRequest):
    """
    Generates an advanced interactive quiz based on the technical context.
    Uses modes like 'Why is this wrong?', 'AI-vs-Student', and 'Scenario-based'.
    """
    print(f"🎲 Generating Quiz for topic: {req.topic}")
    try:
        quiz_data = _llm_quiz(req.topic, req.level, req.context)
        return JSONResponse(content=quiz_data)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/socratic-tutor")
async def socratic_tutor(req: SocraticRequest):
    """AI Socratic Tutor - asks guiding questions instead of giving answers."""
    print(f"🤔 Socratic Tutor session: {req.topic}")
    try:
        result = _llm_socratic(req.topic, req.user_answer, req.conversation_history, req.level)
        return JSONResponse(content=result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/teach-ai")
async def teach_ai(req: TeachAIRequest):
    """User teaches the AI - role reversal with evaluation."""
    print(f"👨‍🏫 Teach AI session: {req.topic}")
    try:
        result = _llm_teach_ai(req.topic, req.user_explanation, req.level)
        return JSONResponse(content=result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate-pdf")
async def generate_pdf(request: Request):
    """Generate comprehensive PDF with topic info, diagram, and equations."""
    try:
        data = await request.json()
        print(f"📄 Generating PDF for: {data.get('title', 'Unknown')}")
        
        # Import here to avoid circular imports
        from pdf_generator import generate_topic_pdf
        
        pdf_buffer = generate_topic_pdf(data)
        
        # Create filename
        title = data.get('title', 'topic').replace(' ', '_').lower()[:30]
        filename = f"{title}_report.pdf"
        
        # Return as streaming response
        return StreamingResponse(
            pdf_buffer,
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {str(e)}")


@app.get("/suggest")
def suggest(q: str = ""):
    """Typeahead suggestions for the search bar."""
    topics = [
        "Reinforcement Learning", "Transformers in Deep Learning",
        "Gradient Descent", "Blockchain Technology", "Large Language Models",
        "Convolutional Neural Networks", "Graph Neural Networks",
        "Attention Mechanism", "Diffusion Models", "RLHF",
        "Vector Databases", "RAG – Retrieval Augmented Generation",
        "Kubernetes", "Docker Containers", "REST vs GraphQL",
        "Neural Networks", "Support Vector Machines", "Random Forest",
        "LSTM Networks", "GANs – Generative Adversarial Networks",
    ]
    filtered = [t for t in topics if q.lower() in t.lower()] if q else topics
    return {"suggestions": filtered[:8]}

# ── Serve Frontend ────────────────────────────────────────────────────────────
from fastapi.staticfiles import StaticFiles
frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
if os.path.isdir(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
