# AI Research Explainer Engine

<div align="center">

**🤖 AI-Powered Research Intelligence & Multi-Level Explanation System**

[![Python 3.9+](https://img.shields.io/badge/Python-3.9%2B-blue)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110%2B-green)](https://fastapi.tiangolo.com/)
[![Groq](https://img.shields.io/badge/Groq-LLaMA%203.3--70B-orange)](https://www.groq.com/)
[![License](https://img.shields.io/badge/License-MIT-purple)](LICENSE)

Transform complex research topics into structured, multi-level explanations powered by RAG + LLM.

[Quick Start](#quick-start) • [Installation](#installation) • [API](#api-endpoints) • [Stack](#tech-stack)

</div>

---

## Overview

AI Research Explainer Engine transforms complex technical topics into **structured, multi-level explanations** by combining:

- 🔍 **Web Search** — DuckDuckGo multi-query search + academic paper targeting
- 📊 **Vector Retrieval** — FAISS semantic search with Sentence-Transformers embeddings
- 🧠 **LLM Synthesis** — Groq LLaMA 3.3-70B generates Beginner/Intermediate/Advanced explanations
- 🎨 **Visualizations** — Interactive D2 diagrams via Kroki.io
- 📚 **Rich Media** — Wikipedia images + YouTube tutorials
- 🎓 **Interactive Learning** — Quiz mode, Socratic tutor, Teach-AI evaluation

Perfect for students, researchers, and educators who need quick, evidence-backed explanations.

---

## Quick Start

```bash
# 1. Clone & Setup
git clone https://github.com/vinaykr8807/AI-Research-Explainer-System.git
cd AI-Research-Explainer-System
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt
playwright install chromium

# 3. Configure environment
echo "GROQ_API_KEY=your_key_here" > .env

# 4. Run backend
cd backend
python main.py

# 5. Open browser
# Navigate to http://localhost:8000
```

---

## Installation

### Prerequisites
- Python 3.9+
- Git
- [Groq API Key](https://console.groq.com/)

### Setup Steps

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Setup Playwright for web scraping
playwright install chromium

# Configure .env with API keys
GROQ_API_KEY=your_groq_api_key
PEXELS_API_KEY=your_pexels_api_key (optional)
```

---

## Usage

### Web Interface
1. Start backend: `python backend/main.py`
2. Open http://localhost:8000 in browser
3. Enter a query and select knowledge level
4. Explore results in tabs: Beginner → Code → Diagram → Quiz → Socratic

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/explain` | POST | Generate multi-level explanation |
| `/quiz` | POST | Create adaptive quiz |
| `/socratic-tutor` | POST | Interactive tutoring |
| `/generate-pdf` | POST | Export as PDF report |
| `/health` | GET | System health check |

**Example:**
```bash
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{
    "query": "How do Transformers work?",
    "knowledge_level": "intermediate"
  }'
```

---

## Project Structure

```
AI-Research-Explainer-System/
├── backend/
│   ├── main.py              # FastAPI backend
│   ├── rag_service.py       # Web scraping + FAISS retrieval
│   ├── rag.py               # Local knowledge base
│   ├── teacher_service.py   # LLM orchestration
│   ├── pdf_generator.py     # PDF export
│   ├── wikipedia_service.py # Image fetching
│   └── pexels_service.py    # Video recommendations
├── frontend/
│   ├── index.html           # Web interface
│   ├── app.js               # Frontend logic
│   └── style.css            # Styling
├── requirements.txt
├── README.md
└── .gitignore
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | FastAPI, Uvicorn |
| **LLM** | Groq (LLaMA 3.3-70B) |
| **Vector DB** | FAISS + Sentence-Transformers |
| **Web Scraping** | Playwright + Trafilatura |
| **Search** | DuckDuckGo DDGS |
| **Visualization** | D2 + Kroki.io |
| **Frontend** | HTML5, CSS3, Vanilla JS |
| **PDF Export** | ReportLab |

---

## Features

✅ Multi-level explanations (Beginner → Advanced with LaTeX)
✅ Real-time web scraping from 5+ sources
✅ Vector-based semantic search
✅ Interactive D2 architecture diagrams
✅ Automatic media enrichment (images + videos)
✅ Adaptive quiz generation
✅ Socratic tutoring mode
✅ "Teach the AI" role-reversal evaluation
✅ Professional PDF report export
✅ Local knowledge base with FAISS indexing

---

## Environment Variables

```env
GROQ_API_KEY=your_groq_api_key          # Required for LLM synthesis
PEXELS_API_KEY=your_pexels_api_key      # Optional for image fallback
PORT=8000                               # Backend port
RAG_CHUNK_SIZE=500                      # Text chunk size
```

---

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

MIT License — See LICENSE file for details. Free for commercial and personal use.

- **Persistent Advisory History & Export Architecture**
  One-click PDF report generation via ReportLab with embedded diagrams, equations, code examples, and cited sources for longitudinal record-keeping.

---

## Setup with .env.example

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
# Edit .env and add your API keys
```

---

## Support

📧 **Email:** vinay.kr03@example.com  
🐦 **Twitter:** [@vinaykr8807](https://twitter.com/vinaykr8807)  
💬 **Issues:** [GitHub Issues](https://github.com/vinaykr8807/AI-Research-Explainer-System/issues)

---

<div align="center">

Made with ❤️ by [Vinay Kumar](https://github.com/vinaykr8807)

⭐ Star this repo if it helps you!

</div>
