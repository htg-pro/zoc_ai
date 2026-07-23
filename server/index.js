#!/usr/bin/env node
/**
 * Zoc AI Backend Server
 *
 * Provides the full API layer for the web (non-Tauri) mode of Zoc AI:
 *   - File system read/write API  (/api/fs/*)
 *   - Session management          (/v1/sessions/*)
 *   - AI agent run + SSE events   (/v1/agent/run, /v1/agent/events)
 *   - Misc supporting endpoints
 *
 * Requires Node 20+ (for built-in fetch).
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execSync }     = require('child_process');

// ── Config ─────────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.ZOC_SERVER_PORT  || '3001', 10);
const WORKSPACE_ROOT = process.env.ZOC_WORKSPACE_ROOT        || process.cwd();
const OPENAI_KEY     = process.env.OPENAI_API_KEY            || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY         || '';

// ── In-memory state ────────────────────────────────────────────────────────
const sessions = new Map();  // id → session object
const agentBus = new EventEmitter();
agentBus.setMaxListeners(200);

let _seq = 0;
const nextSeq = () => ++_seq;

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
const isoNow = () => new Date().toISOString();

// ── HTTP helpers ────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(body);
}

function sendError(res, status, msg) {
  sendJson(res, status, { detail: msg });
}

// ── File system helpers ─────────────────────────────────────────────────────
const SKIP_DIRS  = new Set(['node_modules', '__pycache__', '.git', 'dist', '.cache',
                             'target', '.pytest_cache', 'build', '.next', '.turbo',
                             'coverage', '.parcel-cache', 'out', '.output', 'gen', 'binaries']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function safePath(p) {
  if (!p || p === '/') return WORKSPACE_ROOT;
  let full;
  if (path.isAbsolute(p)) {
    full = path.normalize(p);
  } else {
    full = path.resolve(WORKSPACE_ROOT, p.replace(/^\/+/, ''));
  }
  if (!full.startsWith(WORKSPACE_ROOT)) throw new Error(`Path outside workspace: ${p}`);
  return full;
}

function buildTree(dir, depth = 0, maxDepth = 4) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }

  const nodes = [];
  for (const entry of entries) {
    if (SKIP_FILES.has(entry.name)) continue;
    if (entry.name.startsWith('.') &&
        !['gitignore', 'env.example', 'eslintrc.cjs', 'eslintrc.js'].includes(entry.name.slice(1))) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

    const absPath = path.join(dir, entry.name);
    const node = {
      name:     entry.name,
      path:     absPath,
      kind:     entry.isDirectory() ? 'dir' : 'file',
      children: null,
    };
    if (entry.isDirectory() && depth < maxDepth) {
      node.children = buildTree(absPath, depth + 1, maxDepth);
    }
    nodes.push(node);
  }

  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ── Session helpers ─────────────────────────────────────────────────────────
function makeSession(overrides = {}) {
  const id  = uuid();
  const now = isoNow();
  return {
    id,
    title:           'New Session',
    workspace_root:  WORKSPACE_ROOT,
    created_at:      now,
    updated_at:      now,
    messages:        [],
    plan:            null,
    ...overrides,
    // Always force workspace_root to server root (ignore client value)
    workspace_root:  WORKSPACE_ROOT,
  };
}

function toApiSession(s) {
  return {
    id:             s.id,
    title:          s.title,
    workspace_root: s.workspace_root,
    created_at:     s.created_at,
    updated_at:     s.updated_at,
    plan:           s.plan,
  };
}

// ── Agent tools ─────────────────────────────────────────────────────────────
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the complete contents of a file from the workspace',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root (e.g. src/App.tsx)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a file with new content. Always provide the COMPLETE file contents.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to workspace root' },
          content: { type: 'string', description: 'Complete new file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and subdirectories in a workspace directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace root (empty = root)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a read-only shell command (ls, cat, grep, git status, etc.)',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
];

function execTool(name, args) {
  switch (name) {
    case 'read_file': {
      try {
        const full = safePath(args.path);
        return { content: fs.readFileSync(full, 'utf-8') };
      } catch (e) { return { error: e.message }; }
    }
    case 'write_file': {
      try {
        const full = safePath(args.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, args.content, 'utf-8');
        return { success: true, path: args.path, bytes: Buffer.byteLength(args.content) };
      } catch (e) { return { error: e.message }; }
    }
    case 'list_directory': {
      try {
        const dir = args.path ? safePath(args.path) : WORKSPACE_ROOT;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return {
          entries: entries
            .filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
            .map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }))
            .sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name))),
        };
      } catch (e) { return { error: e.message }; }
    }
    case 'run_command': {
      const cmd = (args.command || '').trim();
      const SAFE = ['ls ', 'ls\n', 'ls$', 'cat ', 'grep ', 'find ', 'echo ', 'pwd', 'git log', 'git status', 'git diff', 'wc '];
      const safe = SAFE.some(s => cmd === s.trimEnd() || cmd.startsWith(s));
      if (!safe) return { error: 'Command not permitted for safety. Use ls, cat, grep, find, echo, pwd, git log/status/diff.' };
      try {
        const out = execSync(cmd, { cwd: WORKSPACE_ROOT, timeout: 8000, maxBuffer: 256 * 1024 }).toString();
        return { output: out };
      } catch (e) { return { error: e.message, output: e.stdout?.toString() || '' }; }
    }
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ── OpenAI call helper ──────────────────────────────────────────────────────
async function callOpenAI({ messages, tools, stream, apiKey, model, baseUrl }) {
  const key = apiKey || OPENAI_KEY;
  if (!key) throw Object.assign(new Error('NO_API_KEY'), { code: 'NO_API_KEY' });

  const url  = (baseUrl || 'https://api.openai.com') + '/v1/chat/completions';
  const body = { model: model || 'gpt-4o', messages, stream: !!stream, temperature: 0.2 };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const resp = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`OpenAI API ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return resp;
}

// ── No-key helper ───────────────────────────────────────────────────────────
function noKeyMessage(runId, broadcast) {
  broadcast({
    type: 'token', seq: nextSeq(), runId, ts: isoNow(),
    text: [
      '## ⚠️ No API Key Configured',
      '',
      'To use Zoc AI Agent, set your OpenAI API key:',
      '',
      '1. Open **Settings** (gear icon in status bar)',
      '2. Choose **OpenAI** as your provider',
      '3. Paste your API key',
      '',
      'Or set the `OPENAI_API_KEY` secret in Replit → Secrets tab.',
      '',
      'Get a key at: https://platform.openai.com/api-keys',
    ].join('\n'),
    done: true,
  });
  broadcast({ type: 'done', seq: nextSeq(), runId, ts: isoNow(), ok: false });
}

// ── Ask mode (streaming chat) ───────────────────────────────────────────────
async function runAskMode({ runId, input, history, apiKey, model, baseUrl, broadcast }) {
  const msgs = [
    {
      role: 'system',
      content: 'You are Zoc AI, a helpful coding assistant built into an IDE. ' +
               'Answer questions concisely and accurately. Format code using Markdown code blocks.',
    },
    ...history.slice(-12),
    { role: 'user', content: input },
  ];

  let resp;
  try {
    resp = await callOpenAI({ messages: msgs, stream: true, apiKey, model, baseUrl });
  } catch (e) {
    if (e.code === 'NO_API_KEY') { noKeyMessage(runId, broadcast); return; }
    broadcast({ type: 'token', seq: nextSeq(), runId, ts: isoNow(), text: `❌ ${e.message}`, done: true });
    broadcast({ type: 'done',  seq: nextSeq(), runId, ts: isoNow(), ok: false });
    return;
  }

  // Parse OpenAI SSE stream
  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = '';
  let   tokSeq  = nextSeq();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const json   = JSON.parse(raw);
          const delta  = json.choices?.[0]?.delta?.content;
          const finish = json.choices?.[0]?.finish_reason;
          if (delta) {
            broadcast({ type: 'token', seq: tokSeq++, runId, ts: isoNow(), text: delta });
          }
          if (finish === 'stop') {
            broadcast({ type: 'token', seq: tokSeq++, runId, ts: isoNow(), text: '', done: true });
          }
        } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  broadcast({ type: 'done', seq: nextSeq(), runId, ts: isoNow(), ok: true });
}

// ── Agent mode (agentic loop with tools) ────────────────────────────────────
async function runAgentMode({ runId, input, workspaceRoot: wsRoot, apiKey, model, baseUrl, broadcast }) {
  const root = wsRoot || WORKSPACE_ROOT;

  // Intent event
  broadcast({
    type: 'intent', seq: nextSeq(), runId, ts: isoNow(),
    text: input, modelTier: 'cloud', contextWindowTokens: 128000,
  });

  const systemPrompt = [
    'You are Zoc AI, an autonomous coding agent embedded in a professional IDE (like GitHub Copilot or OpenAI Codex).',
    '',
    `Workspace root: ${root}`,
    '',
    'Your workflow for coding tasks:',
    '1. Explore the relevant files/directory structure first (list_directory, read_file)',
    '2. Understand the existing code before making changes',
    '3. Make ALL necessary changes to implement the request completely',
    '4. Write COMPLETE file contents — never partial snippets',
    '5. Summarize what you changed and why',
    '',
    'Rules:',
    '- Always read files before editing them',
    '- Write complete, production-quality code',
    '- Implement features end-to-end — no placeholders',
    '- If you need more context, read more files',
  ].join('\n');

  const msgs = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: input },
  ];

  const MAX_ITER = 30;
  let   iter     = 0;

  try {
    while (iter < MAX_ITER) {
      iter++;

      if (iter > 1) {
        broadcast({
          type: 'thinking', seq: nextSeq(), runId, ts: isoNow(),
          text: `Iteration ${iter}…`, collapsible: true, truncated: false,
        });
      }

      let resp;
      try {
        resp = await callOpenAI({ messages: msgs, tools: AGENT_TOOLS, stream: false, apiKey, model, baseUrl });
      } catch (e) {
        if (e.code === 'NO_API_KEY') { noKeyMessage(runId, broadcast); return; }
        broadcast({ type: 'token', seq: nextSeq(), runId, ts: isoNow(), text: `❌ ${e.message}`, done: true });
        break;
      }

      const completion = await resp.json();
      const choice     = completion.choices?.[0];
      if (!choice) break;

      const message = choice.message;
      msgs.push(message);

      // ── Tool calls ──────────────────────────────────────────────────
      if (message.tool_calls?.length) {
        const reads  = [];
        const writes = [];

        for (const tc of message.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /**/ }

          if (tc.function.name === 'read_file')    reads.push(args.path);
          if (tc.function.name === 'write_file')   writes.push(args.path);

          const result = execTool(tc.function.name, args);
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }

        if (reads.length) {
          broadcast({
            type: 'read-files', seq: nextSeq(), runId, ts: isoNow(),
            files: reads.filter(Boolean).map(p => ({ path: p })),
          });
        }
        for (const p of writes.filter(Boolean)) {
          broadcast({
            type: 'edit-file', seq: nextSeq(), runId, ts: isoNow(),
            path: p, diff: '', adds: 0, dels: 0, status: 'done',
          });
        }

        continue; // Loop to get next response
      }

      // ── Final text response ─────────────────────────────────────────
      const text = message.content || '';
      if (text) {
        // Stream in small chunks for a live-typing effect
        const CHUNK = 6;
        const words = text.split(' ');
        let   tokSeq = nextSeq();
        let   chunk  = '';

        for (let i = 0; i < words.length; i++) {
          chunk += (i > 0 ? ' ' : '') + words[i];
          if ((i + 1) % CHUNK === 0 || i === words.length - 1) {
            broadcast({
              type: 'token', seq: tokSeq++, runId, ts: isoNow(),
              text: chunk, done: i === words.length - 1,
            });
            chunk = '';
            await new Promise(r => setTimeout(r, 15));
          }
        }
      }
      break;
    }
  } catch (e) {
    console.error('[agent] error:', e);
    broadcast({ type: 'token', seq: nextSeq(), runId, ts: isoNow(), text: `\n\n❌ Agent error: ${e.message}`, done: true });
  }

  broadcast({ type: 'done', seq: nextSeq(), runId, ts: isoNow(), ok: true });
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url      = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method   = req.method;

  // Strip trailing slash except root
  const p = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;

  console.log(`[${new Date().toISOString().slice(11,19)}] ${method} ${p}`);

  try {
    // ─── Health ────────────────────────────────────────────────────────
    if (p === '/health' && method === 'GET') {
      sendJson(res, 200, { status: 'ok', version: '2.0.0', workspace: WORKSPACE_ROOT, hasKey: !!OPENAI_KEY });
      return;
    }

    // ─── Workspace info ────────────────────────────────────────────────
    if (p === '/api/workspace' && method === 'GET') {
      sendJson(res, 200, { root: WORKSPACE_ROOT });
      return;
    }

    // ─── FS: list directory ────────────────────────────────────────────
    if (p === '/api/fs/list' && method === 'GET') {
      const reqPath = url.searchParams.get('path') || '/';
      const depth   = Math.min(parseInt(url.searchParams.get('depth') || '4', 10), 6);
      try {
        const dir  = safePath(reqPath);
        const tree = buildTree(dir, 0, depth);
        sendJson(res, 200, tree);
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }

    // ─── FS: read file ─────────────────────────────────────────────────
    if (p === '/api/fs/read' && method === 'GET') {
      const reqPath = url.searchParams.get('path');
      if (!reqPath) { sendError(res, 400, 'path required'); return; }
      try {
        const full    = safePath(reqPath);
        const content = fs.readFileSync(full, 'utf-8');
        sendJson(res, 200, { content });
      } catch (e) { sendError(res, 404, e.message); }
      return;
    }

    // ─── FS: write file ────────────────────────────────────────────────
    if (p === '/api/fs/write' && method === 'POST') {
      const body    = await readBody(req);
      const reqPath = body.path;
      if (!reqPath) { sendError(res, 400, 'path required'); return; }
      try {
        const full = safePath(reqPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body.content ?? '', 'utf-8');
        sendJson(res, 200, { ok: true, path: reqPath });
      } catch (e) { sendError(res, 500, e.message); }
      return;
    }

    // ─── FS: create file ───────────────────────────────────────────────
    if (p === '/api/fs/create' && method === 'POST') {
      const body    = await readBody(req);
      const reqPath = body.path;
      if (!reqPath) { sendError(res, 400, 'path required'); return; }
      try {
        const full = safePath(reqPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (!fs.existsSync(full)) fs.writeFileSync(full, '', 'utf-8');
        sendJson(res, 200, { ok: true, path: full });
      } catch (e) { sendError(res, 500, e.message); }
      return;
    }

    // ─── FS: create directory ──────────────────────────────────────────
    if (p === '/api/fs/mkdir' && method === 'POST') {
      const body    = await readBody(req);
      const reqPath = body.path;
      if (!reqPath) { sendError(res, 400, 'path required'); return; }
      try {
        const full = safePath(reqPath);
        fs.mkdirSync(full, { recursive: true });
        sendJson(res, 200, { ok: true, path: full });
      } catch (e) { sendError(res, 500, e.message); }
      return;
    }

    // ─── FS: delete ────────────────────────────────────────────────────
    if (p === '/api/fs/delete' && method === 'DELETE') {
      const reqPath = url.searchParams.get('path');
      if (!reqPath) { sendError(res, 400, 'path required'); return; }
      try {
        const full = safePath(reqPath);
        fs.rmSync(full, { recursive: true, force: true });
        sendJson(res, 200, { ok: true });
      } catch (e) { sendError(res, 500, e.message); }
      return;
    }

    // ─── FS: rename / move ─────────────────────────────────────────────
    if ((p === '/api/fs/rename' || p === '/api/fs/move') && method === 'POST') {
      const body = await readBody(req);
      const from = body.from, to = body.to;
      if (!from || !to) { sendError(res, 400, 'from and to required'); return; }
      try {
        const fromFull = safePath(from);
        const toFull   = safePath(to);
        fs.mkdirSync(path.dirname(toFull), { recursive: true });
        fs.renameSync(fromFull, toFull);
        sendJson(res, 200, { ok: true, path: toFull });
      } catch (e) { sendError(res, 500, e.message); }
      return;
    }

    // ─── FS: stat ──────────────────────────────────────────────────────
    if (p === '/api/fs/stat' && method === 'GET') {
      const reqPath = url.searchParams.get('path');
      if (!reqPath) { sendError(res, 400, 'path required'); return; }
      try {
        const full = safePath(reqPath);
        const stat = fs.statSync(full);
        sendJson(res, 200, { exists: true, is_dir: stat.isDirectory(), is_file: stat.isFile(), size: stat.size, modified_ms: stat.mtimeMs });
      } catch {
        sendJson(res, 200, { exists: false, is_dir: false, is_file: false, size: 0, modified_ms: null });
      }
      return;
    }

    // ─── FS: duplicate ─────────────────────────────────────────────────
    if (p === '/api/fs/duplicate' && method === 'POST') {
      const body    = await readBody(req);
      const reqPath = body.path;
      if (!reqPath) { sendError(res, 400, 'path required'); return; }
      try {
        const full  = safePath(reqPath);
        const ext   = path.extname(full);
        const base  = full.slice(0, full.length - ext.length);
        let copy = `${base} copy${ext}`;
        let n = 2;
        while (fs.existsSync(copy)) { copy = `${base} copy ${n++}${ext}`; }
        fs.cpSync(full, copy, { recursive: true });
        sendJson(res, 200, { ok: true, path: copy });
      } catch (e) { sendError(res, 500, e.message); }
      return;
    }

    // ─── Sessions: list ────────────────────────────────────────────────
    if (p === '/v1/sessions' && method === 'GET') {
      sendJson(res, 200, [...sessions.values()].map(toApiSession));
      return;
    }

    // ─── Sessions: create ──────────────────────────────────────────────
    if (p === '/v1/sessions' && method === 'POST') {
      const body    = await readBody(req);
      const session = makeSession({ title: body.title });
      sessions.set(session.id, session);
      sendJson(res, 201, toApiSession(session));
      return;
    }

    // ─── Sessions: single ──────────────────────────────────────────────
    const sessM = p.match(/^\/v1\/sessions\/([^/]+)$/);
    if (sessM) {
      const id = sessM[1];
      if (method === 'GET') {
        const s = sessions.get(id);
        s ? sendJson(res, 200, toApiSession(s)) : sendError(res, 404, 'Session not found');
        return;
      }
      if (method === 'PATCH' || method === 'PUT') {
        const s    = sessions.get(id);
        if (!s) { sendError(res, 404, 'Session not found'); return; }
        const body = await readBody(req);
        Object.assign(s, body, { updated_at: isoNow(), workspace_root: WORKSPACE_ROOT });
        sendJson(res, 200, toApiSession(s));
        return;
      }
      if (method === 'DELETE') {
        sessions.delete(id);
        res.writeHead(204, CORS);
        res.end();
        return;
      }
    }

    // ─── Sessions: messages ────────────────────────────────────────────
    const msgM = p.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (msgM) {
      const id = msgM[1];
      const s  = sessions.get(id);
      if (!s) { sendError(res, 404, 'Session not found'); return; }
      if (method === 'GET')  { sendJson(res, 200, s.messages || []); return; }
      if (method === 'POST') {
        const body = await readBody(req);
        const msg  = { id: uuid(), session_id: id, role: body.role || 'user', content: body.content || '', created_at: isoNow() };
        s.messages = [...(s.messages || []), msg];
        s.updated_at = isoNow();
        sendJson(res, 201, msg);
        return;
      }
    }

    // ─── Sessions: context-status ──────────────────────────────────────
    if (p.match(/^\/v1\/sessions\/[^/]+\/context-status$/) && method === 'GET') {
      sendJson(res, 200, { total_tokens: 0, max_tokens: 128000, pct: 0, files: [] });
      return;
    }

    // ─── Sessions: memory ─────────────────────────────────────────────
    if (p.match(/^\/v1\/sessions\/[^/]+\/memory\/(stats|compact|forget)$/) && (method === 'GET' || method === 'POST')) {
      sendJson(res, 200, { total: 0, kept: 0, dropped: 0 });
      return;
    }

    // ─── Sessions: index-status ────────────────────────────────────────
    if (p.match(/^\/v1\/sessions\/[^/]+\/index-status$/) && method === 'GET') {
      sendJson(res, 200, { indexed: 0, total: 0, status: 'idle' });
      return;
    }

    // ─── Sessions: project-rules ───────────────────────────────────────
    if (p.match(/^\/v1\/sessions\/[^/]+\/project-rules$/) && method === 'GET') {
      sendJson(res, 200, { rules: null });
      return;
    }

    // ─── Sessions: apply-run / restore-run ────────────────────────────
    if (p.match(/^\/v1\/sessions\/[^/]+\/(apply|restore)-run$/) && method === 'POST') {
      sendJson(res, 200, { status: 'ok', applied_files: [] });
      return;
    }

    // ─── Agent: start run ──────────────────────────────────────────────
    if (p === '/v1/agent/run' && method === 'POST') {
      const body   = await readBody(req);
      const input  = (body.input || '').trim();
      if (!input) { sendError(res, 400, 'input required'); return; }

      const runId    = uuid();
      const mode     = body.mode || 'ask';
      const apiKey   = body.api_key  || body.apiKey  || OPENAI_KEY;
      const baseUrl  = body.base_url || body.baseUrl  || null;
      const model    = body.model    || 'gpt-4o';
      const wsRoot   = body.workspace_root || WORKSPACE_ROOT;

      const broadcast = event => agentBus.emit('event', event);

      // Active session history for context
      const activeSess = [...sessions.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      const history    = (activeSess?.messages || [])
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));

      if (mode === 'ask') {
        runAskMode({ runId, input, history, apiKey, model, baseUrl, broadcast });
      } else {
        runAgentMode({ runId, input, workspaceRoot: wsRoot, apiKey, model, baseUrl, broadcast });
      }

      sendJson(res, 202, { runId, run_id: runId });
      return;
    }

    // ─── Agent: SSE events stream ──────────────────────────────────────
    if (p === '/v1/agent/events' && method === 'GET') {
      res.writeHead(200, {
        ...CORS,
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');

      const onEvent = event => {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
        catch { /* disconnected */ }
      };

      agentBus.on('event', onEvent);

      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); }
        catch { clearInterval(ping); }
      }, 20000);

      req.on('close', () => {
        agentBus.off('event', onEvent);
        clearInterval(ping);
      });
      return;
    }

    // ─── Agent: decision ───────────────────────────────────────────────
    if (p === '/v1/agent/decision' && method === 'POST') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // ─── Agent: diary (recovery) ───────────────────────────────────────
    if (p === '/v1/agent/diary' && method === 'GET') {
      sendJson(res, 200, []);
      return;
    }

    // ─── Providers ─────────────────────────────────────────────────────
    if (p === '/v1/providers' && method === 'GET') {
      sendJson(res, 200, [
        { id: 'openai',    name: 'OpenAI',    requiresKey: true,  baseUrl: 'https://api.openai.com' },
        { id: 'anthropic', name: 'Anthropic', requiresKey: true,  baseUrl: 'https://api.anthropic.com' },
        { id: 'ollama',    name: 'Ollama',    requiresKey: false, baseUrl: 'http://localhost:11434' },
      ]);
      return;
    }

    // ─── Slash commands ────────────────────────────────────────────────
    if (p === '/v1/slash-commands' && method === 'GET') {
      sendJson(res, 200, [
        { name: 'review',  description: 'Review recent code changes' },
        { name: 'test',    description: 'Run the test suite'          },
        { name: 'explain', description: 'Explain selected code'       },
        { name: 'fix',     description: 'Fix errors in active file'   },
      ]);
      return;
    }

    // ─── Settings ──────────────────────────────────────────────────────
    if (p === '/v1/settings') {
      sendJson(res, 200, { theme: 'dark', font_size: 14, tab_size: 2, telemetry: false });
      return;
    }

    // ─── Tools ─────────────────────────────────────────────────────────
    if (p === '/v1/tools' && method === 'GET') {
      sendJson(res, 200, []);
      return;
    }

    // ─── Permissions ───────────────────────────────────────────────────
    if (p.startsWith('/v1/permissions')) {
      sendJson(res, 200, []);
      return;
    }

    // ─── Not found ─────────────────────────────────────────────────────
    sendError(res, 404, `Not found: ${p}`);

  } catch (err) {
    console.error('[server] error:', err);
    try { sendError(res, 500, err.message); } catch { /**/ }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ Zoc AI backend  →  http://0.0.0.0:${PORT}`);
  console.log(`  Workspace root   :  ${WORKSPACE_ROOT}`);
  console.log(`  OpenAI key       :  ${OPENAI_KEY ? '✓ set' : '✗ not set (add OPENAI_API_KEY secret)'}`);
  console.log(`  Anthropic key    :  ${ANTHROPIC_KEY ? '✓ set' : '✗ not set'}\n`);
});
