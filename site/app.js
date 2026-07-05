'use strict';

/* ============================== состояние ============================== */

let CFG = null;                 // {api_key, api_url} — расшифрованный конфиг
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $logout = document.getElementById('logout');
const projectCache = new Map(); // id -> {id, name}

/* ============================== утилиты ============================== */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

function oneLine(s, n = 90) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  return d.toLocaleString('ru-RU', {day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'});
}

function jstr(v) { return JSON.stringify(v, null, 2); }

/* ------- лёгкий markdown → безопасный HTML ------- */

function mdInline(text) {
  let s = esc(text);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return s.split('\n').map(line => {
    if (/^#{1,4}\s+/.test(line)) return '<strong>' + line.replace(/^#{1,4}\s+/, '') + '</strong>';
    if (/^\s*[-*]\s+/.test(line)) return line.replace(/^\s*[-*]\s+/, '•&nbsp;');
    return line;
  }).join('<br>');
}

function md(text) {
  const re = /```[\w+-]*[ \t]*\n?([\s\S]*?)```/g;
  let out = '', pos = 0, m;
  while ((m = re.exec(text)) !== null) {
    out += mdInline(text.slice(pos, m.index));
    out += '<pre class="codeblock">' + esc(m[1].replace(/^\n+|\n+$/g, '')) + '</pre>';
    pos = m.index + m[0].length;
  }
  out += mdInline(text.slice(pos));
  return out;
}

/* ============================== крипто ============================== */

const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function unlock(password) {
  const res = await fetch('config.enc.json', {cache: 'no-store'});
  if (!res.ok) throw new Error('config.enc.json не найден — сайт ещё не задеплоен с секретами');
  const enc = await res.json();
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {name: 'PBKDF2', salt: b64d(enc.salt), iterations: enc.iterations, hash: 'SHA-256'},
    km, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: b64d(enc.iv)}, key, b64d(enc.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ============================== LangSmith API ============================== */

async function api(path, opts = {}) {
  const res = await fetch(CFG.api_url + path, {
    ...opts,
    headers: {'x-api-key': CFG.api_key, 'content-type': 'application/json', ...(opts.headers || {})},
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${oneLine(await res.text(), 300)}`);
  return res.json();
}

async function listProjects() {
  const items = await api('/api/v1/sessions?limit=100');
  items.sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''));
  items.forEach(p => projectCache.set(p.id, p));
  return items;
}

async function listRuns(projectId, days, limit) {
  const start = new Date(Date.now() - days * 864e5).toISOString();
  const body = {
    session: [projectId], is_root: true, start_time: start, limit,
    select: ['id', 'name', 'status', 'error', 'start_time', 'inputs', 'extra'],
  };
  const data = await api('/api/v1/runs/query', {method: 'POST', body: JSON.stringify(body)});
  return data.runs || [];
}

async function readRun(runId) {
  return api('/api/v1/runs/' + runId);
}

async function listThreadRuns(projectId, metaKey, value, days) {
  const start = new Date(Date.now() - days * 864e5).toISOString();
  const body = {
    session: [projectId], is_root: true, start_time: start, limit: 100,
    filter: `and(eq(metadata_key, "${metaKey}"), eq(metadata_value, "${value.replace(/"/g, '')}"))`,
    select: ['id', 'name', 'status', 'error', 'start_time', 'inputs', 'outputs', 'extra'],
  };
  const data = await api('/api/v1/runs/query', {method: 'POST', body: JSON.stringify(body)});
  const runs = data.runs || [];
  runs.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  return runs;
}

/* тред = группа ранов с одинаковым thread_id/session_id/conversation_id в metadata */
function threadKeyOf(run) {
  const meta = (run.extra || {}).metadata || {};
  for (const k of ['thread_id', 'session_id', 'conversation_id']) {
    if (meta[k]) return {key: k, value: String(meta[k])};
  }
  return null;
}

/* ==================== нормализация сообщений (порт из app.py) ==================== */

const ROLE_MAP = {
  human: 'user', user: 'user', HumanMessage: 'user', HumanMessageChunk: 'user',
  ai: 'assistant', assistant: 'assistant', AIMessage: 'assistant', AIMessageChunk: 'assistant',
  system: 'system', SystemMessage: 'system',
  tool: 'tool', ToolMessage: 'tool', function: 'tool', FunctionMessage: 'tool',
};

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object') {
        if (block.type === 'text' && 'text' in block) parts.push(block.text);
        else if ('text' in block) parts.push(String(block.text));
        else if (block.type === 'image_url') parts.push('[изображение]');
        else if (block.type === 'tool_use') continue; // отдельными чипами
        else parts.push(jstr(block));
      } else parts.push(String(block));
    }
    return parts.filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return jstr(content);
  return String(content);
}

function fmtArgs(args) {
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return args; }
  }
  return jstr(args);
}

function toolCallsOf(d, content) {
  const calls = d.tool_calls || (d.additional_kwargs || {}).tool_calls || [];
  const result = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue;
    const name = c.name || (c.function || {}).name || '?';
    const args = fmtArgs(c.args ?? (c.function || {}).arguments ?? '');
    result.push({name, args, preview: oneLine(args)});
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'tool_use') {
        const args = fmtArgs(block.input || {});
        result.push({name: block.name || '?', args, preview: oneLine(args)});
      }
    }
  }
  return result;
}

function parseOneMessage(m) {
  const out = (role, text, tools, name) =>
    ({role, text: text || '', tools: tools || [], name: name || null});

  if (!m || typeof m !== 'object' || Array.isArray(m)) return out('other', contentToText(m));

  // LangChain serialized: {lc:1, id:[..., "HumanMessage"], kwargs:{...}}
  if (m.lc === 1 && m.id && m.kwargs) {
    const cls = Array.isArray(m.id) && m.id.length ? m.id[m.id.length - 1] : '';
    const kw = m.kwargs || {};
    return out(ROLE_MAP[cls] || 'other', contentToText(kw.content),
      toolCallsOf(kw, kw.content), kw.name);
  }
  // LangChain dict: {type: "human", data: {content: ...}}
  if ('type' in m && m.data && typeof m.data === 'object') {
    const d = m.data;
    return out(ROLE_MAP[m.type] || 'other', contentToText(d.content),
      toolCallsOf(d, d.content), d.name);
  }
  // OpenAI / generic: {role, content}
  if ('role' in m) {
    return out(ROLE_MAP[m.role] || m.role, contentToText(m.content),
      toolCallsOf(m, m.content), m.name);
  }
  // короткий LangChain: {type, content}
  if ('type' in m && 'content' in m) {
    return out(ROLE_MAP[m.type] || 'other', contentToText(m.content),
      toolCallsOf(m, m.content), m.name);
  }
  return out('other', jstr(m));
}

function extractMessageList(value) {
  if (Array.isArray(value)) {
    if (value.length && Array.isArray(value[0])) value = value[0]; // батч
    if (value.length && value.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      const probe = value[0];
      if ('role' in probe || 'type' in probe || 'lc' in probe) return value;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const key of ['messages', 'chat_history', 'history', 'input_messages']) {
      if (key in value) {
        const found = extractMessageList(value[key]);
        if (found) return found;
      }
    }
  }
  return null;
}

function runToMessages(inputs, outputs) {
  const messages = [];
  const push = p => { if (p && (p.text || p.tools.length)) messages.push(p); };

  const rawIn = extractMessageList(inputs);
  if (rawIn) {
    rawIn.forEach(m => push(parseOneMessage(m)));
  } else if (inputs && typeof inputs === 'object' && Object.keys(inputs).length) {
    let done = false;
    for (const key of ['input', 'question', 'query', 'text', 'prompt']) {
      if (typeof inputs[key] === 'string') {
        push({role: 'user', text: inputs[key], tools: [], name: null});
        done = true; break;
      }
    }
    if (!done) push({role: 'user', text: jstr(inputs), tools: [], name: null});
  }

  if (outputs && (typeof outputs !== 'object' || Object.keys(outputs).length)) {
    const rawOut = extractMessageList(outputs);
    if (rawOut) {
      rawOut.forEach(m => push(parseOneMessage(m)));
    } else if (outputs && typeof outputs === 'object') {
      let handled = false;
      const gens = outputs.generations;
      if (Array.isArray(gens) && gens.length) {
        const flat = Array.isArray(gens[0]) ? gens[0] : gens;
        for (const g of flat) {
          if (g && typeof g === 'object') {
            if (g.message) {
              const parsed = parseOneMessage(g.message);
              parsed.role = 'assistant';
              push(parsed); handled = true;
            } else if ('text' in g) {
              push({role: 'assistant', text: String(g.text), tools: [], name: null});
              handled = true;
            }
          }
        }
      }
      if (!handled) {
        for (const key of ['output', 'answer', 'result', 'text', 'content', 'response']) {
          if (key in outputs) {
            const val = outputs[key];
            if (val && typeof val === 'object' && !Array.isArray(val) &&
                ('role' in val || 'lc' in val || 'type' in val)) {
              push(parseOneMessage(val));
            } else {
              push({role: 'assistant', text: contentToText(val), tools: [], name: null});
            }
            handled = true; break;
          }
        }
      }
      if (!handled) push({role: 'assistant', text: jstr(outputs), tools: [], name: null});
    }
  }

  // дедуп: история часто повторяется в inputs каждого рана
  const seen = new Set(), deduped = [];
  for (const m of messages) {
    const key = m.role + '\x00' + m.text + '\x00' + JSON.stringify(m.tools) + '\x00' + m.name;
    if (!seen.has(key)) { seen.add(key); deduped.push(m); }
  }
  return deduped;
}

function previewText(run) {
  const msgs = runToMessages(run.inputs || {}, null);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && msgs[i].text) return oneLine(msgs[i].text, 140);
  }
  return run.inputs ? oneLine(JSON.stringify(run.inputs), 140) : '';
}

/* ============================== рендер ============================== */

function setNav(html) { $nav.innerHTML = html; }

function renderError(e) {
  $app.innerHTML = `<div class="err">${esc(e.message || e)}</div>`;
}

function renderLoading(text) {
  $app.innerHTML = `<div class="loading">${esc(text)}…</div>`;
}

function renderLock(errMsg) {
  setNav('');
  $logout.hidden = true;
  $app.innerHTML = `
    <div class="lock">
      <div class="icon">🔐</div>
      <h2>LangSmith Viewer</h2>
      <p class="muted">Введите пароль для доступа к чатам</p>
      <form id="lockform">
        <input type="password" id="pw" placeholder="Пароль" autofocus autocomplete="current-password">
        <button class="btn primary" type="submit">Войти</button>
      </form>
      ${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ''}
    </div>`;
  document.getElementById('lockform').addEventListener('submit', async e => {
    e.preventDefault();
    const pw = document.getElementById('pw').value;
    if (!pw) return;
    renderLoading('Расшифровка');
    try {
      CFG = await unlock(pw);
      sessionStorage.setItem('lsv_cfg', JSON.stringify(CFG));
      $logout.hidden = false;
      route();
    } catch (err) {
      renderLock(err.name === 'OperationError' ? 'Неверный пароль' : String(err.message || err));
    }
  });
}

async function renderProjects() {
  setNav('');
  renderLoading('Загрузка проектов');
  let projects;
  try { projects = await listProjects(); } catch (e) { return renderError(e); }
  $app.innerHTML = `
    <h2 style="margin:6px 0 16px">Проекты</h2>
    ${projects.map(p => `
      <a class="card run-row" href="#/runs/${p.id}">
        <div class="title">${esc(p.name)}</div>
        <div class="muted">создан: ${fmtTime(p.start_time)}</div>
      </a>`).join('') || '<p class="muted">Проектов не найдено.</p>'}`;
}

async function renderRuns(projectId, params) {
  const limit = parseInt(params.get('limit') || '50', 10);
  const days = parseInt(params.get('days') || '7', 10);
  const pname = projectCache.get(projectId)?.name || '';
  setNav(`
    <span class="badge">${esc(pname) || 'проект'}</span>
    <select id="limit">${[20, 50, 100].map(n =>
      `<option value="${n}" ${n === limit ? 'selected' : ''}>${n} чатов</option>`).join('')}</select>
    <select id="days">${[[1, 'за сутки'], [7, 'за неделю'], [30, 'за месяц'], [365, 'за год']].map(([d, l]) =>
      `<option value="${d}" ${d === days ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button class="btn" id="refresh">⟳</button>`);
  const nav = () => {
    const l = document.getElementById('limit').value, d = document.getElementById('days').value;
    window.location.hash = `#/runs/${projectId}?limit=${l}&days=${d}&t=${Date.now()}`;
  };
  document.getElementById('limit').addEventListener('change', nav);
  document.getElementById('days').addEventListener('change', nav);
  document.getElementById('refresh').addEventListener('click', nav);

  renderLoading('Загрузка чатов');
  let runs;
  try {
    if (!projectCache.size) await listProjects(); // прогреваем имена проектов
    runs = await listRuns(projectId, days, limit);
  } catch (e) { return renderError(e); }

  // группируем раны одного диалога (по thread_id в metadata) в одну карточку
  runs.sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''));
  const cards = [];
  const groups = new Map();
  for (const r of runs) {
    const t = threadKeyOf(r);
    if (!t) { cards.push({single: r, time: r.start_time}); continue; }
    let g = groups.get(t.value);
    if (!g) {
      g = {thread: t, runs: [], time: r.start_time};
      groups.set(t.value, g);
      cards.push(g);
    }
    g.runs.push(r); // runs идут по убыванию времени: g.runs[0] — самый свежий
  }

  $app.innerHTML = cards.map(c => {
    if (c.single) {
      const r = c.single;
      return `
        <a class="card run-row" href="#/run/${r.id}?project=${projectId}">
          <div class="title">
            ${esc(r.name)}
            ${r.error ? '<span class="badge error">ошибка</span>' : '<span class="badge ok">ok</span>'}
            <span class="muted" style="font-weight:400">${fmtTime(r.start_time)}</span>
          </div>
          <div class="preview">${esc(previewText(r))}</div>
        </a>`;
    }
    const newest = c.runs[0], oldest = c.runs[c.runs.length - 1];
    const hasError = c.runs.some(r => r.error);
    return `
      <a class="card run-row" href="#/thread/${projectId}/${encodeURIComponent(c.thread.key)}/${encodeURIComponent(c.thread.value)}?days=${days}">
        <div class="title">
          🧵 ${esc(newest.name)}
          <span class="badge">${c.runs.length} сообщ.</span>
          ${hasError ? '<span class="badge error">ошибка</span>' : '<span class="badge ok">ok</span>'}
          <span class="muted" style="font-weight:400">${fmtTime(oldest.start_time)} → ${fmtTime(newest.start_time)}</span>
        </div>
        <div class="preview">${esc(previewText(oldest))}</div>
      </a>`;
  }).join('') || '<p class="muted">Ранов не найдено за выбранный период.</p>';
}

function messagesHtml(messages) {
  return messages.map(m => {
    if (m.role === 'system') {
      return `
        <details class="fold syst">
          <summary><span class="chev">▶</span> 📋 системный промпт
            <span class="fprev">${esc(m.text.slice(0, 110))}</span></summary>
          <div class="fold-body">${md(m.text)}</div>
        </details>`;
    }
    if (m.role === 'tool') {
      return `
        <details class="fold toolres">
          <summary><span class="chev">▶</span> ✅ результат${m.name ? `: <span class="fname">${esc(m.name)}</span>` : ''}
            <span class="fprev">${esc(m.text.slice(0, 110))}</span></summary>
          <div class="fold-body"><pre>${esc(m.text)}</pre></div>
        </details>`;
    }
    let html = '';
    if (m.text) {
      html += `
        <div class="msg ${esc(m.role)}">
          <div class="bubble">
            <div class="role">${esc(m.role)}</div>
            ${md(m.text)}
          </div>
        </div>`;
    }
    for (const t of m.tools) {
      html += `
        <details class="fold toolcall">
          <summary><span class="chev">▶</span> <span class="ticon">🔧</span>
            <span class="fname">${esc(t.name)}</span>
            <span class="fprev">${esc(t.preview)}</span></summary>
          <div class="fold-body"><pre>${esc(t.args)}</pre></div>
        </details>`;
    }
    return html;
  }).join('');
}

function renderChat(run, messages, backHash) {
  setNav(`
    <a class="btn" href="${backHash}">← Назад</a>
    <span class="badge">${esc(run.name)}</span>
    <span class="muted">${fmtTime(run.start_time)}</span>
    ${run.error ? '<span class="badge error">ошибка</span>' : ''}`);
  const rawJson = jstr({inputs: run.inputs, outputs: run.outputs,
    metadata: (run.extra || {}).metadata});
  $app.innerHTML = `
    <div class="chat">
      ${messagesHtml(messages)}
      ${run.error ? `<div class="err" style="margin-top:20px">${esc(run.error)}</div>` : ''}
      <details class="raw">
        <summary class="muted" style="cursor:pointer">Показать сырой JSON</summary>
        <pre>${esc(rawJson)}</pre>
      </details>
    </div>`;
}

async function renderRunDetail(runId, params) {
  renderLoading('Загрузка чата');
  let run;
  try { run = await readRun(runId); } catch (e) { return renderError(e); }
  const back = params.get('project') ? `#/runs/${params.get('project')}` : '#/';
  renderChat(run, runToMessages(run.inputs || {}, run.outputs || {}), back);
}

async function renderThread(projectId, metaKey, value, params) {
  renderLoading('Загрузка диалога');
  const days = parseInt(params.get('days') || '7', 10);
  let runs;
  try {
    runs = await listThreadRuns(projectId, metaKey, value, days);
  } catch (e) { return renderError(e); }
  if (!runs.length) return renderError(new Error('Раны треда не найдены'));

  // склеиваем сообщения всех ранов диалога; дедуп убирает повторы истории
  const all = [];
  for (const r of runs) all.push(...runToMessages(r.inputs || {}, r.outputs || {}));
  const seen = new Set(), messages = [];
  for (const m of all) {
    const key = m.role + '\x00' + m.text + '\x00' + JSON.stringify(m.tools) + '\x00' + m.name;
    if (!seen.has(key)) { seen.add(key); messages.push(m); }
  }

  const last = runs[runs.length - 1];
  const headerRun = {
    name: `${last.name} · ${runs.length} сообщ.`,
    error: runs.find(r => r.error)?.error || null,
    start_time: last.start_time,
    inputs: last.inputs, outputs: last.outputs, extra: last.extra,
  };
  renderChat(headerRun, messages, `#/runs/${projectId}`);
}

/* ------- демо без API (проверка вёрстки): #demo ------- */

function renderDemo() {
  const inputs = {messages: [
    {role: 'system', content: 'Ты — юридический ассистент. Отвечай строго по судебной практике РФ.'},
    {role: 'user', content: '18 подсудимых осуждены по ст.322.1 УК РФ и ст.210 УК РФ. Подбери аналогичные приговоры из судебной практики.'},
    {role: 'assistant', content: '', tool_calls: [{function: {name: 'search_court_practice',
      arguments: JSON.stringify({queries: ['организация незаконной миграции преступное сообщество ст.322.1 ст.210 УК РФ'], case_types: ['criminal']})}}]},
    {role: 'tool', name: 'search_court_practice', content: JSON.stringify(
      {results: [{case: 'Дело № 1-15/2023', court: 'Мосгорсуд', summary: 'ст.322.1 ч.2, ст.210 прекращена'}]}, null, 2)},
  ]};
  const outputs = {messages: [{role: 'assistant', content:
    'Нашёл **аналогичную практику**:\n\n- **Дело № 1-15/2023** (Мосгорсуд) — ст.210 УК РФ прекращена.\n- **Дело № 1-88/2022** (СПб) — осуждение по обеим статьям.\n\n```\nОтсутствие структурированности группы (п. 3 ППВС № 12)\n```\nПодробнее: https://sudact.ru/regular/doc/example'}]};
  const run = {name: 'demo-chat', error: null, start_time: new Date().toISOString(),
    inputs, outputs, extra: {}};
  renderChat(run, runToMessages(inputs, outputs), '#/');
}

/* ============================== роутер ============================== */

function route() {
  const hash = window.location.hash || '#/';
  if (hash === '#demo') return renderDemo();
  if (!CFG) return renderLock();
  const [path, query] = hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'runs' && parts[1]) return renderRuns(parts[1], params);
  if (parts[0] === 'run' && parts[1]) return renderRunDetail(parts[1], params);
  if (parts[0] === 'thread' && parts[3]) {
    return renderThread(parts[1], decodeURIComponent(parts[2]), decodeURIComponent(parts[3]), params);
  }
  return renderProjects();
}

$logout.addEventListener('click', () => {
  CFG = null;
  sessionStorage.removeItem('lsv_cfg');
  window.location.hash = '#/';
  renderLock();
});

window.addEventListener('hashchange', route);

(function init() {
  const saved = sessionStorage.getItem('lsv_cfg');
  if (saved) {
    try { CFG = JSON.parse(saved); $logout.hidden = false; } catch { /* ignore */ }
  }
  route();
})();
