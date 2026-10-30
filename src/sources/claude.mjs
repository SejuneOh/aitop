// Claude Code: ~/.claude/sessions/<pid>.json 으로 살아 있는 세션을 찾고,
// ~/.claude/projects/*/<sessionId>.jsonl 대화 기록에서 진행 내용과 토큰을 읽는다.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { JsonlTail } from '../tail.mjs';
import { isAlive } from '../procs.mjs';
import { emptyTokens, pushEvent, describeTool, isNoisePrompt } from './common.mjs';

const HOME = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const SESSIONS = join(HOME, 'sessions');
const PROJECTS = join(HOME, 'projects');
const ENDED_WINDOW_MS = 24 * 3600 * 1000;

const states = new Map();
const pathCache = new Map();

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function findTranscript(sessionId) {
  const cached = pathCache.get(sessionId);
  if (cached && (cached.path ? existsSync(cached.path) : Date.now() - cached.at < 5000)) return cached.path;
  let path = null;
  try {
    for (const dir of readdirSync(PROJECTS)) {
      const p = join(PROJECTS, dir, `${sessionId}.jsonl`);
      if (existsSync(p)) {
        path = p;
        break;
      }
    }
  } catch {}
  pathCache.set(sessionId, { path, at: Date.now() });
  return path;
}

function newState() {
  return { tail: null, usage: new Map(), tokens: emptyTokens(), subTokens: 0, context: 0, model: null, title: null, branch: null, events: [], subagents: new Map(), lastTool: null };
}

function addUsage(tokens, prev, u) {
  const sign = (x, k) => (x?.[k] ?? 0);
  const delta = {
    input: sign(u, 'input_tokens') - sign(prev, 'input_tokens'),
    output: sign(u, 'output_tokens') - sign(prev, 'output_tokens'),
    cacheRead: sign(u, 'cache_read_input_tokens') - sign(prev, 'cache_read_input_tokens'),
    cacheWrite: sign(u, 'cache_creation_input_tokens') - sign(prev, 'cache_creation_input_tokens'),
  };
  for (const k of Object.keys(delta)) tokens[k] += delta[k];
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

function applyLine(st, x) {
  if (x.type === 'ai-title' && x.aiTitle) st.title = x.aiTitle;
  if (x.gitBranch) st.branch = x.gitBranch;
  if (x.isMeta) return;

  if (x.type === 'assistant' && x.message) {
    const m = x.message;
    if (m.model && !m.model.startsWith('<')) st.model = m.model;
    if (m.usage && m.id) {
      addUsage(st.tokens, st.usage.get(m.id), m.usage);
      st.usage.set(m.id, m.usage);
      st.context = (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
    }
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c.type === 'tool_use') {
        st.lastTool = describeTool(c.name, c.input);
        pushEvent(st, x.timestamp, 'tool', st.lastTool);
      } else if (c.type === 'text' && c.text?.trim()) {
        pushEvent(st, x.timestamp, 'reply', c.text);
      }
    }
  }

  if (x.type === 'user' && x.message && !x.isSidechain) {
    const c = x.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '';
    if (text && !isNoisePrompt(text)) pushEvent(st, x.timestamp, 'prompt', text);
  }
}

function readSubagents(st, transcript) {
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta.json')) continue;
    const id = f.slice('agent-'.length, -'.meta.json'.length);
    const meta = readJson(join(dir, f)) ?? {};
    let sa = st.subagents.get(id);
    if (!sa) {
      sa = { id, tail: new JsonlTail(join(dir, `agent-${id}.jsonl`)), usage: new Map(), tokens: emptyTokens(), now: null, mtime: 0 };
      st.subagents.set(id, sa);
    }
    sa.type = meta.agentType ?? 'agent';
    sa.description = meta.description ?? '';
    sa.finished = Boolean(meta.finished);
    for (const x of sa.tail.read()) {
      const m = x.message;
      if (x.type === 'assistant' && m?.usage && m.id) {
        addUsage(sa.tokens, sa.usage.get(m.id), m.usage);
        sa.usage.set(m.id, m.usage);
      }
      for (const c of Array.isArray(m?.content) ? m.content : []) if (c.type === 'tool_use') sa.now = describeTool(c.name, c.input);
    }
    sa.mtime = sa.tail.mtimeMs;
  }
  st.subTokens = [...st.subagents.values()].reduce((s, a) => s + a.tokens.total, 0);
}

function statusOf(entry, alive, mtime) {
  if (!alive) return 'ended';
  if (entry.waitingFor) return 'waiting';
  if (entry.status === 'busy') return 'busy';
  if (entry.status === 'shell') return 'shell';
  if (entry.status === 'idle') return 'idle';
  return Date.now() - mtime < 5000 ? 'busy' : 'idle';
}

export function collectClaude({ showEnded }) {
  let files;
  try {
    files = readdirSync(SESSIONS).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const latest = new Map();
  for (const f of files) {
    const e = readJson(join(SESSIONS, f));
    if (!e?.sessionId) continue;
    e.alive = isAlive(e.pid);
    const prev = latest.get(e.sessionId);
    if (!prev || (e.alive && !prev.alive) || (e.updatedAt ?? e.startedAt) > (prev.updatedAt ?? prev.startedAt)) latest.set(e.sessionId, e);
  }

  const out = [];
  for (const e of latest.values()) {
    const touched = e.updatedAt ?? e.startedAt ?? 0;
    if (!e.alive && !(showEnded && Date.now() - touched < ENDED_WINDOW_MS)) continue;

    let st = states.get(e.sessionId);
    if (!st) states.set(e.sessionId, (st = newState()));
    const transcript = findTranscript(e.sessionId);
    if (transcript) {
      if (!st.tail || st.tail.path !== transcript) st.tail = new JsonlTail(transcript);
      for (const x of st.tail.read()) applyLine(st, x);
      readSubagents(st, transcript);
    }
    const mtime = Math.max(st.tail?.mtimeMs ?? 0, touched);
    const autoName = !e.name || e.name === e.sessionId.slice(0, 8);
    const members = [...st.subagents.values()]
      .filter((a) => !a.finished || Date.now() - a.mtime < 5 * 60_000)
      .map((a) => ({ name: a.type, task: a.description, now: a.now, status: a.finished ? 'done' : Date.now() - a.mtime < 30_000 ? 'busy' : 'idle', tokens: a.tokens.total }));

    out.push({
      tool: 'claude',
      id: e.sessionId,
      pid: e.pid,
      kind: e.kind === 'bg' ? 'background' : e.kind ?? 'interactive',
      name: (autoName ? st.title : e.name) ?? `${basename(e.cwd ?? '')} · ${e.sessionId.slice(0, 8)}`,
      cwd: e.cwd,
      project: basename(e.cwd ?? ''),
      branch: st.branch,
      model: st.model,
      live: e.alive,
      status: statusOf(e, e.alive, mtime),
      waitingFor: e.waitingFor ?? null,
      now: st.lastTool ?? st.events.at(-1)?.text ?? '',
      startedAt: e.startedAt,
      updatedAt: mtime,
      tokens: { ...st.tokens, total: st.tokens.total + st.subTokens, sub: st.subTokens },
      context: { used: st.context, window: st.context > 200_000 ? 1_000_000 : 200_000 },
      events: st.events,
      members,
    });
  }
  return out;
}
