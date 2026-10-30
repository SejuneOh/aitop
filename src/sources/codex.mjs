// Codex CLI: 실행 중인 codex 프로세스의 작업 폴더와 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 을 짝지어 읽는다.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { JsonlTail } from '../tail.mjs';
import { findProcesses, isCodex } from '../procs.mjs';
import { emptyTokens, pushEvent, describeTool, isNoisePrompt } from './common.mjs';

const ROOT = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
const RECENT_MS = 24 * 3600 * 1000;

const states = new Map();

function dayDirs() {
  const dirs = [];
  for (let back = 0; back < 2; back++) {
    const d = new Date(Date.now() - back * 86400_000);
    const p = join(ROOT, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (existsSync(p)) dirs.push(p);
  }
  return dirs;
}

function recentFiles() {
  const out = [];
  for (const dir of dayDirs()) {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.jsonl')) continue;
      const p = join(dir, n);
      const m = statSync(p).mtimeMs;
      if (Date.now() - m < RECENT_MS) out.push({ path: p, mtime: m });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function newState(path) {
  return { tail: new JsonlTail(path), id: basename(path), cwd: null, branch: null, model: null, busy: false, tokens: emptyTokens(), context: 0, window: 0, events: [], lastTool: null, startedAt: null };
}

function applyLine(st, x) {
  const p = x.payload ?? {};
  if (x.type === 'session_meta') {
    st.id = p.id ?? st.id;
    st.cwd = p.cwd ?? st.cwd;
    st.branch = p.git?.branch ?? st.branch;
    st.startedAt = Date.parse(p.timestamp) || st.startedAt;
  } else if (x.type === 'turn_context') {
    st.model = p.model ?? st.model;
    st.cwd = p.cwd ?? st.cwd;
  } else if (x.type === 'event_msg') {
    switch (p.type) {
      case 'task_started':
        st.busy = true;
        if (p.model_context_window) st.window = p.model_context_window;
        break;
      case 'task_complete':
      case 'turn_aborted':
        st.busy = false;
        break;
      case 'token_count': {
        const t = p.info?.total_token_usage;
        if (t) {
          const cached = t.cached_input_tokens ?? 0;
          st.tokens = { input: (t.input_tokens ?? 0) - cached, output: t.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0, total: t.total_tokens ?? 0 };
        }
        if (p.info?.last_token_usage) st.context = p.info.last_token_usage.total_tokens ?? 0;
        if (p.info?.model_context_window) st.window = p.info.model_context_window;
        break;
      }
      case 'user_message':
        if (p.message && !isNoisePrompt(p.message)) pushEvent(st, x.timestamp, 'prompt', p.message);
        break;
      case 'agent_message':
        pushEvent(st, x.timestamp, 'reply', p.message);
        break;
    }
  } else if (x.type === 'response_item') {
    let what = null;
    if (p.type === 'function_call') {
      let args = {};
      try {
        args = JSON.parse(p.arguments ?? '{}');
      } catch {}
      what = describeTool(p.name, args);
    } else if (p.type === 'custom_tool_call') what = describeTool(p.name, p.input ?? '');
    else if (p.type === 'web_search_call') what = 'WebSearch';
    if (what) {
      st.lastTool = what;
      pushEvent(st, x.timestamp, 'tool', what);
    }
  }
}

export const _test = { newState, applyLine };

export function collectCodex({ showEnded }) {
  const procs = findProcesses(isCodex);
  if (!procs.length && !showEnded) return [];

  const files = recentFiles();
  for (const f of files) {
    let st = states.get(f.path);
    if (!st) states.set(f.path, (st = newState(f.path)));
    for (const x of st.tail.read()) applyLine(st, x);
  }

  // 같은 폴더에서 돌고 있는 codex 프로세스 수만큼, 가장 최근에 바뀐 세션 파일을 '실행 중'으로 본다.
  const liveByPath = new Map();
  const slots = new Map();
  for (const p of procs) slots.set(p.cwd, [...(slots.get(p.cwd) ?? []), p.pid]);
  for (const f of files) {
    const st = states.get(f.path);
    const free = slots.get(st.cwd);
    if (free?.length) liveByPath.set(f.path, free.shift());
  }

  const out = [];
  for (const f of files) {
    const st = states.get(f.path);
    const pid = liveByPath.get(f.path);
    const live = pid !== undefined;
    if (!live && !showEnded) continue;
    out.push({
      tool: 'codex',
      id: st.id,
      pid: pid ?? null,
      kind: 'interactive',
      name: basename(st.cwd ?? '') || 'codex',
      cwd: st.cwd,
      project: basename(st.cwd ?? ''),
      branch: st.branch,
      model: st.model,
      live,
      status: !live ? 'ended' : st.busy ? 'busy' : 'idle',
      waitingFor: null,
      now: st.lastTool ?? st.events.at(-1)?.text ?? '',
      startedAt: st.startedAt,
      updatedAt: f.mtime,
      tokens: { ...st.tokens, sub: 0 },
      context: { used: st.context, window: st.window || 258_400 },
      events: st.events,
      members: [],
    });
  }

  // 아직 세션 파일을 만들지 않은(첫 입력 전) codex 프로세스도 보여 준다.
  for (const [cwd, pids] of slots) {
    for (const pid of pids) {
      out.push({ tool: 'codex', id: `pid-${pid}`, pid, kind: 'interactive', name: basename(cwd ?? '') || 'codex', cwd, project: basename(cwd ?? ''), live: true, status: 'idle', now: '첫 입력 대기', updatedAt: Date.now(), tokens: emptyTokens(), context: { used: 0, window: 0 }, events: [], members: [] });
    }
  }
  return out;
}
