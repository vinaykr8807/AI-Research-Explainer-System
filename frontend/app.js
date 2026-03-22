/* ═══════════════════════════════════════════════════════════════════════════
   AI Insight Architect — Frontend Logic
   Kroki.io D2 rendering + Wikipedia image + YouTube embed + RAG explanation
   ═══════════════════════════════════════════════════════════════════════════ */

const API_BASE   = window.location.origin;
const KROKI_BASE = 'https://kroki.io';

let currentData    = null;
let pipelineTimer  = null;
let currentQuiz    = null; // Holds the 5-question quiz data
let quizIdx        = 0;
let quizScore      = 0;
let quizWrongIds   = [];   // To track weak areas

// ─── Init ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // YouTube blocks <iframe> embeds on file:/// URLs (throws Error 153).
  // Redirect the user to the FastAPI-hosted localhost server to fix this.
  if (window.location.protocol === 'file:') {
    window.location.href = `${window.location.origin}/`;
    return;
  }
  
  checkApiHealth();
  loadSuggestions();
  setupSearchListener();
});

// ─── Health Check ─────────────────────────────────────────────────────────
async function checkApiHealth() {
  const dot  = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  try {
    const res  = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    if (data.status === 'ok') {
      dot.classList.add('online');
      const warns = [];
      if (!data.groq_key_set)   warns.push('⚠ No Groq key');
      text.textContent = warns.length ? warns.join(' · ') : 'API connected';
    } else {
      dot.classList.add('offline');
      text.textContent = 'API error';
    }
  } catch {
    dot.classList.add('offline');
    text.textContent = 'API offline';
  }
}

// ─── Suggestions ──────────────────────────────────────────────────────────
async function loadSuggestions(q = '') {
  try {
    const res  = await fetch(`${API_BASE}/suggest?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderSuggestions(data.suggestions || []);
  } catch { renderSuggestions([]); }
}

function renderSuggestions(items) {
  const row = document.getElementById('suggestions-row');
  row.innerHTML = '';
  items.forEach(s => {
    const btn = document.createElement('button');
    btn.className   = 'sugg-chip';
    btn.textContent = s;
    btn.onclick     = () => quickSearch(s);
    row.appendChild(btn);
  });
}

function setupSearchListener() {
  const input = document.getElementById('query-input');
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const val = input.value.trim();
    document.getElementById('clear-btn').style.visibility = val ? 'visible' : 'hidden';
    debounce = setTimeout(() => loadSuggestions(val), 300);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') runExplain(); });
  document.getElementById('clear-btn').style.visibility = 'hidden';
}

// ─── Quick actions ────────────────────────────────────────────────────────
function quickSearch(topic) {
  document.getElementById('query-input').value = topic;
  document.getElementById('clear-btn').style.visibility = 'visible';
  runExplain();
}

function clearSearch() {
  document.getElementById('query-input').value = '';
  document.getElementById('clear-btn').style.visibility = 'hidden';
  document.getElementById('query-input').focus();
  loadSuggestions();
}

// ─── Section / Tab switching ──────────────────────────────────────────────
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(`section-${name}`).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`nav-${name}`).classList.add('active');
}

function showTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b   => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.getElementById(`panel-${name}`).classList.add('active');

  // Lazy-render diagram when its tab is first opened
  if (name === 'diagram' && currentData?.d2_code && !document.getElementById('diagram-svg-wrap').hasChildNodes()) {
    renderKrokiDiagram(currentData.d2_code);
  }

  // Re-trigger MathJax for the newly visible content
  if (window.MathJax && MathJax.typesetPromise) {
    MathJax.typesetPromise();
  }
}

// ─── Pipeline Tracker ─────────────────────────────────────────────────────
const STEPS = ['search', 'scrape', 'rag', 'llm'];

function startPipeline() {
  document.getElementById('pipeline-tracker').classList.remove('hidden');
  STEPS.forEach(s => {
    const el = document.getElementById(`step-${s}`);
    el.classList.remove('active', 'done');
    el.querySelector('.p-step-fill').style.width = '0%';
  });
  let i = 0;
  pipelineTimer = setInterval(() => {
    if (i > 0) {
      const prev = document.getElementById(`step-${STEPS[i-1]}`);
      prev.classList.remove('active');
      prev.classList.add('done');
    }
    if (i < STEPS.length) {
      document.getElementById(`step-${STEPS[i]}`).classList.add('active');
      i++;
    } else {
      clearInterval(pipelineTimer);
    }
  }, 2200);
}

function completePipeline() {
  clearInterval(pipelineTimer);
  STEPS.forEach(s => {
    const el = document.getElementById(`step-${s}`);
    el.classList.remove('active');
    el.classList.add('done');
  });
  setTimeout(() => document.getElementById('pipeline-tracker').classList.add('hidden'), 800);
}

// ─── Error banner ─────────────────────────────────────────────────────────
function showError(msg) {
  document.getElementById('error-text').textContent = msg;
  document.getElementById('error-banner').classList.remove('hidden');
}
function dismissError() {
  document.getElementById('error-banner').classList.add('hidden');
}

// ─── Kroki.io D2 → SVG ───────────────────────────────────────────────────
let isDiagramRendering = false;

async function renderKrokiDiagram(d2Code) {
  // Prevent duplicate rendering
  if (isDiagramRendering) {
    console.log('Diagram already rendering, skipping...');
    return;
  }
  
  isDiagramRendering = true;
  
  const loading  = document.getElementById('diagram-loading');
  const svgWrap  = document.getElementById('diagram-svg-wrap');
  const errEl    = document.getElementById('diagram-error');
  const errText  = document.getElementById('diagram-error-text');
  const srcEl    = document.getElementById('d2-source-code'); 
  const details  = document.getElementById('d2-source-details');

  srcEl.textContent = d2Code;
  // details.style.display = 'block'; // Uncomment if you want to show source

  if (!d2Code?.trim()) {
    loading.classList.add('hidden');
    errEl.classList.remove('hidden');
    errText.textContent = 'No D2 diagram code was returned by the LLM.';
    isDiagramRendering = false;
    return;
  }

  loading.classList.remove('hidden');
  svgWrap.innerHTML = '';
  errEl.classList.add('hidden');

  try {
    console.log('Sending D2 code to Kroki (POST):', d2Code.substring(0, 50) + '...');

    const res = await fetch(`${KROKI_BASE}/d2/svg`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: d2Code,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown error');
      console.error('Kroki error response:', body);
      throw new Error(`Kroki ${res.status}: ${body.slice(0, 200)}`);
    }

    const svgText = await res.text();
    loading.classList.add('hidden');

    if (!svgText || !svgText.includes('<svg')) {
      throw new Error('Invalid SVG response from Kroki');
    }

    const wrapper = document.createElement('div');
    wrapper.className  = 'kroki-svg-container';
    wrapper.innerHTML  = svgText;

    // Make SVG responsive
    const svg = wrapper.querySelector('svg');
    if (svg) {
      svg.style.width  = '100%';
      svg.style.height = 'auto';
      svg.style.maxWidth = '100%';
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    }

    svgWrap.innerHTML = '';
    svgWrap.appendChild(wrapper);
    console.log('Diagram rendered successfully');
  } catch (err) {
    console.error('Diagram render error:', err);
    loading.classList.add('hidden');
    errEl.classList.remove('hidden');
    errText.textContent = `Diagram render failed: ${err.message}`;
  } finally {
    isDiagramRendering = false;
  }
}

// ─── Lightweight Markdown → HTML with MathJax Protection ─────────────────
function renderMarkdown(md) {
  if (!md) return '';
  
  const mathBlocks = [];
  // 1. Extract and protect math blocks (including environments like \begin{...})
  let processed = md
    // Protect $$ ... $$ (display math)
    .replace(/\$\$([\s\S]*?)\$\$/g, (match, content) => {
      const id = `%%MATH_BLOCK_${mathBlocks.length}%%`;
      mathBlocks.push(`$$${content}$$`);
      return id;
    })
    // Protect \begin{env} ... \end{env} (display math environments)
    .replace(/\\begin\{(\w+\*?)\}([\s\S]*?)\\end\{\1\}/g, (match, env, content) => {
      const id = `%%MATH_BLOCK_${mathBlocks.length}%%`;
      mathBlocks.push(`\\begin{${env}}${content}\\end{${env}}`);
      return id;
    })
    // Protect $ ... $ (inline math) - be more careful to not match single $ within text
    .replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (match, content) => {
      const id = `%%MATH_BLOCK_${mathBlocks.length}%%`;
      mathBlocks.push(`$${content}$`);
      return id;
    });

  // 2. Standard Markdown processing
  processed = processed
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="lang-${lang||''}">${escHtml(code.trim())}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>')
    .replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#{4,}\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g,     '<em>$1</em>')
    .replace(/^>\s+(.+)$/gm,     '<blockquote>$1</blockquote>')
    .replace(/^\s*[-*•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\.\s+(.+)$/gm,    '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g,  '<ul>$&</ul>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // 3. Restore protected math blocks
  mathBlocks.forEach((math, i) => {
    processed = processed.replace(`%%MATH_BLOCK_${i}%%`, math);
  });

  return `<p>${processed}</p>`;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Copy code ────────────────────────────────────────────────────────────
async function copyCode() {
  const code = document.getElementById('res-code-inner').textContent;
  try {
    await navigator.clipboard.writeText(code);
    const btn = document.getElementById('copy-code-btn');
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = '📋 Copy', 2000);
  } catch {}
}

// ─── Render results ───────────────────────────────────────────────────────
function renderResults(data) {
  currentData = data;

  // ── Teacher header ──────────────────────────────────────────────────────
  document.getElementById('res-title').textContent   = data.title   || '';
  document.getElementById('res-summary').textContent = data.summary || '';
  
  // Show PDF download button
  document.getElementById('download-pdf-btn').style.display = 'inline-flex';

  // Wikipedia image
  const img     = document.getElementById('res-img');
  const imgWrap = document.getElementById('media-img-wrap');
  if (data.image_url) {
    img.src              = data.image_url;
    img.alt              = data.title || 'Technical Reference';
    imgWrap.style.display = '';
  } else {
    imgWrap.style.display = 'none';
  }

  // YouTube video (mirrors screenshot 2)
  const vidEl   = document.getElementById('res-video');
  const vidWrap = document.getElementById('media-vid-wrap');
  if (data.video_url) {
    // Force origin parameter to fix 'Error 153: Player configuration error'
    const originUrl = window.location.origin;
    const finalUrl = data.video_url + (data.video_url.includes('?') ? '&' : '?') + 
                    `origin=${encodeURIComponent(originUrl)}&enablejsapi=1`;
    vidEl.src             = finalUrl;
    vidWrap.style.display = '';
  } else {
    vidWrap.style.display = 'none';
  }

  // ── Beginner tab ────────────────────────────────────────────────────────
  document.getElementById('res-beginner').innerHTML =
    renderMarkdown(data.beginner_explanation || '*No beginner explanation provided.*');

  const taList = document.getElementById('res-takeaways');
  taList.innerHTML = '';
  (data.key_takeaways || []).forEach(t => {
    const li = document.createElement('li');
    li.textContent = t;
    taList.appendChild(li);
  });

  // ── Mechanics tab ────────────────────────────────────────────────────────
  document.getElementById('res-mechanics').innerHTML =
    renderMarkdown(data.core_mechanics || '*No mechanics data provided.*');

  // ── Advanced tab ─────────────────────────────────────────────────────────
  document.getElementById('res-advanced').innerHTML =
    renderMarkdown(data.advanced_concepts || '*No advanced data provided.*');

  const appsGrid = document.getElementById('res-apps');
  appsGrid.innerHTML = '';
  const emojis = ['🏭','🏥','🚗','🎓','💳','🛒','🔬','🌐','📊','🤖'];
  (data.real_world_applications || []).forEach((app, i) => {
    const div = document.createElement('div');
    div.className = 'app-card';
    div.innerHTML = `<span>${emojis[i % emojis.length]}</span> ${app}`;
    appsGrid.appendChild(div);
  });

  // ── Diagram tab — reset (will lazy-render on tab click) ──────────────────
  document.getElementById('diagram-svg-wrap').innerHTML = '';
  document.getElementById('diagram-loading').classList.add('hidden');
  document.getElementById('diagram-error').classList.add('hidden');
  document.getElementById('d2-source-code').textContent = '';
  document.getElementById('d2-source-details').style.display = 'none';

  // Show a hint badge if d2_code is present
  const diagTab = document.getElementById('tab-diagram');
  if (data.d2_code?.trim()) {
    diagTab.innerHTML = '📊 Diagram <span class="tab-dot"></span>';
  } else {
    diagTab.textContent = '📊 Diagram';
  }

  // ── Code tab ─────────────────────────────────────────────────────────────
  const codeEl  = document.getElementById('res-code-inner');
  const noCode  = document.getElementById('no-code-msg');
  const codeBlk = document.getElementById('res-code');
  if (data.code_example?.trim()) {
    codeEl.textContent = data.code_example;
    codeBlk.classList.remove('hidden');
    noCode.classList.add('hidden');
  } else {
    codeBlk.classList.add('hidden');
    noCode.classList.remove('hidden');
  }

  // ── Sources tab ───────────────────────────────────────────────────────────
  const srcList = document.getElementById('res-sources');
  srcList.innerHTML = '';
  (data.sources || []).forEach((src, i) => {
    if (!src.url) return;
    const li = document.createElement('li');
    const a  = document.createElement('a');
    a.href   = src.url;
    a.target = '_blank';
    a.rel    = 'noopener noreferrer';
    const domain = (() => { try { return new URL(src.url).hostname; } catch { return src.url; } })();
    a.innerHTML = `
      <span class="src-num">${i+1}</span>
      <div class="src-info">
        <div class="src-title">${src.title || domain}</div>
        <div class="src-url">${domain}</div>
      </div>
      <span style="color:var(--green-400);margin-left:auto">↗</span>`;
    li.appendChild(a);
    srcList.appendChild(li);
  });

  // ── Quiz Tab — reset ──────────────────────────────────────────────────────
  currentQuiz = null;
  quizIdx = 0;
  quizScore = 0;
  quizWrongIds = [];
  document.getElementById('quiz-intro').classList.remove('hidden');
  document.getElementById('quiz-question-view').classList.add('hidden');
  document.getElementById('quiz-results-view').classList.add('hidden');
  document.getElementById('quiz-progress-fill').style.width = '0%';


  // ── Show results + default tab ────────────────────────────────────────────
  document.getElementById('results-section').classList.remove('hidden');
  showTab('beginner');
  document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Trigger MathJax to render equations
  if (window.MathJax && MathJax.typesetPromise) {
    MathJax.typesetPromise().catch((err) => console.log('MathJax error: ', err));
  }
}

// ─── Main explain flow ────────────────────────────────────────────────────
async function runExplain() {
  const query = document.getElementById('query-input').value.trim();
  if (!query) {
    document.getElementById('query-input').focus();
    return;
  }

  const btn     = document.getElementById('explain-btn');
  const btnText = document.getElementById('btn-text');
  const loader  = document.getElementById('btn-loader');
  btn.disabled  = true;
  btnText.classList.add('hidden');
  loader.classList.remove('hidden');

  dismissError();
  document.getElementById('results-section').classList.add('hidden');
  startPipeline();

  const level       = document.getElementById('level-select').value;
  const maxSources  = parseInt(document.getElementById('sources-select').value, 10);
  const includeCode = document.getElementById('code-toggle').checked;

  try {
    const res = await fetch(`${API_BASE}/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, level, include_code: includeCode, max_sources: maxSources }),
    });

    completePipeline();

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown server error' }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    renderResults(data);

  } catch (err) {
    completePipeline();
    showError(`Error: ${err.message}`);
    console.error(err);
  } finally {
    btn.disabled = false;
    btnText.classList.remove('hidden');
    loader.classList.add('hidden');
  }
}

// ─── 🧠 Brain Mastery Quiz Logic ───────────────────────────────────────────
async function startTechnicalQuiz() {
  if (!currentData) return;
  const intro = document.getElementById('quiz-intro');
  const qView = document.getElementById('quiz-question-view');
  const rView = document.getElementById('quiz-results-view');
  
  intro.innerHTML = '<h3>Brain Mastery Challenge</h3><div class="diag-spinner" style="margin:2rem auto"></div><p style="text-align:center">AI is architecting your mastery challenge...</p>';
  
  try {
    const res = await fetch(`${API_BASE}/quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        topic: currentData.title || document.getElementById('query-input').value,
        level: document.getElementById('level-select').value,
        context: currentData.summary + " " + currentData.advanced_concepts
      })
    });
    
    if (!res.ok) throw new Error("Could not fetch quiz");
    currentQuiz = await res.json();
    
    // Validate quiz data structure
    if (!currentQuiz || !Array.isArray(currentQuiz.questions) || currentQuiz.questions.length === 0) {
      throw new Error("Invalid quiz data: missing or empty questions array");
    }
    
    // Validate each question has required fields
    for (let i = 0; i < currentQuiz.questions.length; i++) {
      const q = currentQuiz.questions[i];
      if (typeof q.correct_answer !== 'number') {
        console.warn(`Question ${i} has invalid correct_answer, setting to 0`);
        q.correct_answer = 0;
      }
      if (!q.options) {
        q.options = [];
      }
    }
    
    quizIdx = 0;
    quizScore = 0;
    quizWrongIds = [];
    
    intro.classList.add('hidden');
    rView.classList.add('hidden');
    qView.classList.remove('hidden');
    renderQuestion();
    
  } catch (err) {
    intro.innerHTML = `<p style="color:#ef4444">Failed to load quiz: ${err.message}</p><button onclick="startTechnicalQuiz()" class="start-quiz-btn">Retry</button>`;
  }
}

function renderQuestion() {
  const q = currentQuiz.questions[quizIdx];
  document.getElementById('q-count').textContent = `Question ${quizIdx + 1} of ${currentQuiz.questions.length}`;
  document.getElementById('q-mode-badge').textContent = q.mode || 'Adaptive';
  document.getElementById('q-text').textContent = q.question;
  
  const contextInfo = document.getElementById('q-context-info');
  contextInfo.innerHTML = '';
  contextInfo.classList.add('hidden');

  const optionsGrid = document.getElementById('q-options');
  optionsGrid.innerHTML = '';
  
  // --- Specialized Layouts ---
  
  // Handle MATCH Mode Presentation
  if (q.mode === 'Match' && q.pairs) {
    contextInfo.classList.remove('hidden');
    const matchBox = document.createElement('div');
    matchBox.className = 'q-match-container';
    Object.entries(q.pairs).forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'q-match-item';
      row.innerHTML = `<span>${k}</span> <span class="q-match-link">⇄</span> <span>${v}</span>`;
      matchBox.appendChild(row);
    });
    contextInfo.appendChild(matchBox);
  }

  // Handle BOOLEAN Mode Options (Forced Fallback if missing)
  if (q.mode === 'Boolean') {
    optionsGrid.style.gridTemplateColumns = '1fr 1fr';
    const boolOpts = (q.options && q.options.length > 0) ? q.options : ["True", "False"];
    boolOpts.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = `q-opt boolean-${opt.toLowerCase()}`;
      btn.innerHTML = `<span>${opt === 'True' || opt === 'true' ? '✓' : '✗'}</span> ${opt}`;
      btn.onclick = () => checkAnswer(i, btn);
      optionsGrid.appendChild(btn);
    });
  } else {
    // Normal / Scenario / Code / Match options
    optionsGrid.style.gridTemplateColumns = '';
    const normOpts = q.options || [];
    
    if (normOpts.length === 0) {
      optionsGrid.innerHTML = `<div class="p-3 text-muted">Technical options data unavailable for this scenario. Please click 'Next' to proceed.</div>`;
      document.getElementById('next-q-btn').classList.remove('hidden');
    }

    normOpts.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'q-opt';
      btn.innerHTML = `<span>${String.fromCharCode(65 + i)}</span> ${opt}`;
      btn.onclick = () => checkAnswer(i, btn);
      optionsGrid.appendChild(btn);
    });
  }
  
  document.getElementById('q-intervention').classList.add('hidden');
  
  // Only show next button if we are NOT in missing-options mode
  const nextBtn = document.getElementById('next-q-btn');
  if (q.mode === 'Boolean' || (q.options && q.options.length > 0)) {
    nextBtn.classList.add('hidden');
  }
  updateQuizProgress();
}

function checkAnswer(idx, btn) {
  const q = currentQuiz.questions[quizIdx];
  const allBtns = document.getElementById('q-options').querySelectorAll('.q-opt');
  
  // Lock all buttons
  allBtns.forEach(b => b.classList.add('locked'));
  
  // Validate correct_answer exists and is within bounds
  const correctIdx = q.correct_answer;
  const isValidCorrectIdx = typeof correctIdx === 'number' && correctIdx >= 0 && correctIdx < allBtns.length;
  
  if (idx === correctIdx) {
    btn.classList.add('correct');
    quizScore++;
  } else {
    btn.classList.add('wrong');
    if (isValidCorrectIdx) {
      allBtns[correctIdx].classList.add('correct');
    }
    quizWrongIds.push(quizIdx);
    
    // Trigger AI Intervention
    if (q.intervention) {
      const intDiv = document.getElementById('q-intervention');
      document.getElementById('int-text').textContent = q.intervention;
      intDiv.classList.remove('hidden');
    }
  }
  
  document.getElementById('next-q-btn').classList.remove('hidden');
}

function nextQuestion() {
  quizIdx++;
  if (quizIdx < currentQuiz.questions.length) {
    renderQuestion();
  } else {
    finishQuiz();
  }
}

function updateQuizProgress() {
  const progress = ((quizIdx) / currentQuiz.questions.length) * 100;
  document.getElementById('quiz-progress-fill').style.width = `${progress}%`;
}

function finishQuiz() {
  document.getElementById('quiz-question-view').classList.add('hidden');
  document.getElementById('quiz-results-view').classList.remove('hidden');
  document.getElementById('quiz-progress-fill').style.width = '100%';
  
  document.getElementById('score-circle').textContent = `${quizScore}/${currentQuiz.questions.length}`;
  
  // 🎓 Mastery Summary
  const summaryBox = document.getElementById('mastery-summary-box');
  if (currentQuiz.mastery_summary) {
    summaryBox.textContent = currentQuiz.mastery_summary;
    summaryBox.classList.remove('hidden');
  } else {
    summaryBox.classList.add('hidden');
  }

  // 🚩 Detailed Concept Gaps
  const gapsView = document.getElementById('quiz-gaps-view');
  const gapsList = document.getElementById('gaps-list');
  gapsList.innerHTML = '';
  
  if (quizWrongIds.length > 0) {
    gapsView.classList.remove('hidden');
    quizWrongIds.forEach(idx => {
      const q = currentQuiz.questions[idx];
      const div = document.createElement('div');
      div.className = 'gap-item';
      div.innerHTML = `
        <div class="gap-q">Missed Question: "${q.question}"</div>
        <div class="gap-exp">
           <strong>Correction:</strong> ${q.explanation}<br><br>
           <strong>AI Feedback:</strong> ${q.intervention}
        </div>
      `;
      gapsList.appendChild(div);
    });
  } else {
    gapsView.classList.add('hidden');
  }

  // Knowledge Map
  const mapTags = document.getElementById('k-map-tags');
  mapTags.innerHTML = '';
  (currentQuiz.knowledge_map || ["Logic", "Architecture", "Math"]).forEach((c, i) => {
    const tag = document.createElement('span');
    tag.className = 'k-tag';
    // Simplified: if user got < 100%, mark some concepts as weak for demonstration
    const isWeak = quizWrongIds.length > 0 && i % 2 === 1;
    tag.classList.add(isWeak ? 'weak' : 'mastered');
    tag.textContent = (isWeak ? '❌ ' : '✓ ') + c;
    mapTags.appendChild(tag);
  });
  
  // Learning Path
  const pathList = document.getElementById('path-list');
  pathList.innerHTML = '';
  const recommendations = quizScore === currentQuiz.questions.length 
    ? ["Explore Advanced Research Papers", "Practical System Implementation", "Advanced Math Derivations"]
    : ["Review Foundational Analogies", "Watch Conceptual Video Guide", "Re-read Step-by-Step Breakdown"];
    
  recommendations.forEach(rec => {
    const li = document.createElement('li');
    li.textContent = rec;
    pathList.appendChild(li);
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// 🤔 Socratic Tutor Feature
// ═══════════════════════════════════════════════════════════════════════════

let socraticHistory = [];
let socraticProgress = 0;
let currentSocraticQuestion = '';
let socraticQuestionCount = 0;
const MAX_SOCRATIC_QUESTIONS = 6;

async function startSocraticTutor() {
  if (!currentData) return;
  
  // Reset state
  socraticHistory = [];
  socraticProgress = 0;
  socraticQuestionCount = 0;
  currentSocraticQuestion = '';
  
  // Show chat, hide others
  document.getElementById('socratic-intro').classList.add('hidden');
  document.getElementById('socratic-summary').classList.add('hidden');
  document.getElementById('socratic-chat').classList.remove('hidden');
  document.getElementById('socratic-messages').innerHTML = '';
  document.getElementById('socratic-progress-fill').style.width = '0%';
  
  // Get first question from AI
  await fetchSocraticResponse('');
}

async function fetchSocraticResponse(userAnswer) {
  const messagesDiv = document.getElementById('socratic-messages');
  
  // Increment question count when user answers
  if (userAnswer) {
    socraticQuestionCount++;
  }
  
  // Check if we've reached max questions - force end
  const forceEnd = socraticQuestionCount >= MAX_SOCRATIC_QUESTIONS;
  
  try {
    const res = await fetch(`${API_BASE}/socratic-tutor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: currentData.title || document.getElementById('query-input').value,
        user_answer: userAnswer,
        conversation_history: socraticHistory,
        level: document.getElementById('level-select').value,
        force_end: forceEnd
      })
    });
    
    if (!res.ok) throw new Error('Failed to get tutor response');
    const data = await res.json();
    
    // Update progress (max 100)
    socraticProgress = Math.min(data.progress || 0, 100);
    document.getElementById('socratic-progress-fill').style.width = `${socraticProgress}%`;
    
    // Store current question
    currentSocraticQuestion = data.next_question;
    
    // Add to history
    if (userAnswer) {
      socraticHistory.push({ question: currentSocraticQuestion, answer: userAnswer });
    }
    
    // Display AI message
    const aiMsg = document.createElement('div');
    aiMsg.className = 'socratic-msg ai-msg';
    aiMsg.innerHTML = `
      <span class="msg-avatar">🎓</span>
      <div class="msg-content">
        ${data.feedback ? `<div class="msg-feedback">${data.feedback}</div>` : ''}
        <div class="msg-question">${data.next_question}</div>
      </div>
    `;
    messagesDiv.appendChild(aiMsg);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // Check if session complete - either progress >= 100 or max questions reached
    if ((socraticProgress >= 100 || forceEnd) && data.explanation) {
      showSocraticSummary(data.explanation);
    } else if (forceEnd) {
      // If forced end but no explanation, generate one locally
      showSocraticSummary(generateLocalSocraticSummary());
    }
    
  } catch (err) {
    messagesDiv.innerHTML += `<div class="socratic-error">Error: ${err.message}</div>`;
  }
}

function submitSocraticAnswer() {
  const input = document.getElementById('socratic-input');
  const answer = input.value.trim();
  if (!answer) return;
  
  // Display user message
  const messagesDiv = document.getElementById('socratic-messages');
  const userMsg = document.createElement('div');
  userMsg.className = 'socratic-msg user-msg';
  userMsg.innerHTML = `
    <span class="msg-avatar">👤</span>
    <div class="msg-content">${answer}</div>
  `;
  messagesDiv.appendChild(userMsg);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  
  // Clear input and fetch next question
  input.value = '';
  fetchSocraticResponse(answer);
}

function showSocraticSummary(explanation) {
  document.getElementById('socratic-chat').classList.add('hidden');
  document.getElementById('socratic-summary').classList.remove('hidden');
  document.getElementById('socratic-explanation').innerHTML = explanation;
}

function generateLocalSocraticSummary() {
  const topic = currentData?.title || 'this topic';
  const questionsAsked = socraticHistory.length;
  
  return `
    <h4>🎉 Socratic Session Complete!</h4>
    <p>Great job! You answered <strong>${questionsAsked} guided questions</strong> about <strong>${topic}</strong>.</p>
    <p>Through this Socratic dialogue, you've explored:</p>
    <ul>
      ${socraticHistory.map(h => `<li><strong>Q:</strong> ${h.question}<br><strong>Your answer:</strong> ${h.answer}</li>`).join('')}
    </ul>
    <p><strong>Key Takeaway:</strong> By working through these questions, you've developed a deeper understanding of ${topic} through guided discovery. The Socratic method helps you build knowledge by connecting concepts yourself rather than just receiving information.</p>
  `;
}


// ═══════════════════════════════════════════════════════════════════════════
// ‍🏫 Teach AI Feature
// ═══════════════════════════════════════════════════════════════════════════

async function startTeachAI() {
  if (!currentData) return;
  
  // Reset UI
  document.getElementById('teach-intro').classList.add('hidden');
  document.getElementById('teach-evaluation').classList.add('hidden');
  document.getElementById('teach-session').classList.remove('hidden');
  document.getElementById('teach-conversation').innerHTML = `
    <div class="teach-ai-message">
      <span class="teach-avatar">🤔</span>
      <div class="teach-message-content">
        Hi! I'm confused about "${currentData.title || 'this topic'}". Can you explain it to me like I'm a beginner?
      </div>
    </div>
  `;
  document.getElementById('teach-input').value = '';
  document.getElementById('teach-topic-name').textContent = currentData.title || 'this topic';
}

async function submitTeaching() {
  const input = document.getElementById('teach-input');
  const explanation = input.value.trim();
  if (!explanation) return;
  
  // Show loading
  const conversation = document.getElementById('teach-conversation');
  conversation.innerHTML += `
    <div class="teach-user-message">
      <span class="teach-avatar">👨‍🏫</span>
      <div class="teach-message-content">${explanation.substring(0, 200)}${explanation.length > 200 ? '...' : ''}</div>
    </div>
    <div class="teach-ai-message teach-loading">
      <span class="teach-avatar">🤔</span>
      <div class="teach-message-content">Thinking...</div>
    </div>
  `;
  conversation.scrollTop = conversation.scrollHeight;
  
  try {
    const res = await fetch(`${API_BASE}/teach-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: currentData.title || document.getElementById('query-input').value,
        user_explanation: explanation,
        level: document.getElementById('level-select').value
      })
    });
    
    if (!res.ok) throw new Error('Failed to evaluate teaching');
    const data = await res.json();
    
    showTeachEvaluation(data, explanation);
    
  } catch (err) {
    conversation.innerHTML += `<div class="teach-error">Error: ${err.message}</div>`;
  }
}

function showTeachEvaluation(data, userExplanation) {
  document.getElementById('teach-session').classList.add('hidden');
  document.getElementById('teach-evaluation').classList.remove('hidden');
  
  // Score
  const score = data.evaluation?.score || 0;
  const scoreEl = document.getElementById('teach-score');
  scoreEl.textContent = score;
  scoreEl.className = 'teach-score-circle ' + (score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low');
  
  // Feedback
  document.getElementById('teach-feedback').textContent = data.student_response || '';
  
  // Strengths
  const strengthsList = document.getElementById('teach-strengths-list');
  strengthsList.innerHTML = '';
  (data.evaluation?.strengths || ['No specific strengths identified']).forEach(s => {
    const li = document.createElement('li');
    li.textContent = s;
    strengthsList.appendChild(li);
  });
  
  // Gaps
  const gapsList = document.getElementById('teach-gaps-list');
  gapsList.innerHTML = '';
  (data.evaluation?.gaps || ['No specific gaps identified']).forEach(g => {
    const li = document.createElement('li');
    li.textContent = g;
    gapsList.appendChild(li);
  });
  
  // Model explanation
  document.getElementById('teach-model-exp').innerHTML = data.perfect_explanation || 'No model explanation available.';
}


// ═══════════════════════════════════════════════════════════════════════════
// Lazy-load features when tabs are opened
// ═══════════════════════════════════════════════════════════════════════════

const originalShowTab = showTab;
showTab = function(name) {
  originalShowTab(name);
  
  // Lazy-load diagram when diagram tab is clicked (only if not already rendered)
  if (name === 'diagram' && currentData?.d2_code?.trim()) {
    const svgWrap = document.getElementById('diagram-svg-wrap');
    // Only render if container is empty
    if (svgWrap && svgWrap.innerHTML.trim() === '') {
      renderKrokiDiagram(currentData.d2_code);
    }
  }
  
  // Re-render MathJax for the active tab to ensure equations are displayed
  if (window.MathJax && MathJax.typesetPromise) {
    const activePanel = document.getElementById(`panel-${name}`);
    if (activePanel) {
      MathJax.typesetPromise([activePanel]).catch((err) => console.log('MathJax error: ', err));
    }
  }
};


// ═══════════════════════════════════════════════════════════════════════════
// 📄 PDF Download Feature
// ═══════════════════════════════════════════════════════════════════════════

async function downloadTopicPDF() {
  if (!currentData) {
    alert('Please search for a topic first!');
    return;
  }
  
  const btn = document.getElementById('download-pdf-btn');
  const originalText = btn.textContent;
  btn.textContent = '⏳ Generating PDF...';
  btn.disabled = true;
  
  try {
    const res = await fetch(`${API_BASE}/generate-pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentData)
    });
    
    if (!res.ok) throw new Error('Failed to generate PDF');
    
    // Get the blob from response
    const blob = await res.blob();
    
    // Create download link
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    // Get filename from Content-Disposition header or create default
    const disposition = res.headers.get('Content-Disposition');
    let filename = 'topic_report.pdf';
    if (disposition && disposition.includes('filename=')) {
      filename = disposition.split('filename=')[1].replace(/["']/g, '');
    } else {
      const title = (currentData.title || 'topic').replace(/\s+/g, '_').toLowerCase().substring(0, 30);
      filename = `${title}_report.pdf`;
    }
    
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    btn.textContent = '✅ Downloaded!';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
    
  } catch (err) {
    console.error('PDF download error:', err);
    alert('Failed to generate PDF: ' + err.message);
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

