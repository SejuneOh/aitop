// Codex CLI: 실행 중인 codex 프로세스의 작업 폴더와 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 을 짝지어 읽는다.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { findProcesses, isCodex } from '../procs.mjs';
import { emptyTokens, pushEvent, describeTool, isNoisePrompt } from './common.mjs';

const ROOT = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
const RECENT_MS = 24 * 3600 * 1000;

const states = new Map();

function dayDirs() {
  const dirs = [];
  // 며칠 동안 켜 둔 세션도 시작한 날짜 폴더에 기록하므로 일주일치 폴더를 본다.
  for (let back = 0; back < 7; back++) {
    const d = new Date(Date.now() - back * 86400_000);
    const p = join(ROOT, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (existsSync(p)) dirs.push(p);
  }
  return dirs;
}

// 날짜 폴더를 매초 다시 훑지 않도록 파일 이름 목록만 잠깐 재사용한다. 수정 시각은 매번 확인한다.
const LIST_TTL_MS = 5000;
let listed = { at: 0, paths: [] };

function recentFiles() {
  if (Date.now() - listed.at >= LIST_TTL_MS) {
    const paths = [];
    for (const dir of dayDirs()) for (const n of readdirSync(dir)) if (n.endsWith('.jsonl')) paths.push(join(dir, n));
    listed = { at: Date.now(), paths };
  }
  const out = [];
  for (const p of listed.paths) {
    let m;
    try {
      m = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (Date.now() - m < RECENT_MS) out.push({ path: p, mtime: m });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const SAVED = ['id', 'cwd', 'branch', 'model', 'busy', 'tokens', 'context', 'window', 'events', 'lastTool', 'startedAt', 'lastKind'];

function newState(path) {
  const st = { tail: new JsonlTail(path), id: basename(path), cwd: null, branch: null, model: null, busy: false, tokens: emptyTokens(), context: 0, window: 0, events: [], lastTool: null, startedAt: null, pending: new Map(), lastKind: null };
  const c = loadCache(path);
  if (c) {
    st.tail.offset = c.offset;
    for (const k of SAVED) if (k in c) st[k] = c[k];
    st.pending = new Map(c.pending ?? []);
  }
  return st;
}

function snapshot(st) {
  const out = { offset: st.tail.lineOffset, pending: [...st.pending] };
  for (const k of SAVED) out[k] = st[k];
  return out;
}

function phaseOf(st, live) {
  if (!live) return { kind: 'ended', text: '종료' };
  if (!st.busy) return { kind: 'idle', text: '다음 지시 대기' };
  const open = [...st.pending.values()];
  if (open.length) return { kind: 'tool', text: `도구 실행 · ${open.at(-1)}` };
  return st.lastKind === 'reply' ? { kind: 'write', text: '답변 작성 중' } : { kind: 'think', text: '생각 중' };
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
        st.pending.clear();
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
        st.lastKind = 'prompt';
        break;
      case 'agent_message':
        pushEvent(st, x.timestamp, 'reply', p.message);
        st.lastKind = 'reply';
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
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      st.pending.delete(p.call_id);
      st.lastKind = 'result';
    }
    if (what) {
      st.lastTool = what;
      if (p.call_id && p.type !== 'web_search_call') st.pending.set(p.call_id, p.name);
      pushEvent(st, x.timestamp, 'tool', what);
      st.lastKind = 'tool';
    }
  }
}

export const _test = { newState, applyLine, phaseOf };

export function collectCodex({ showEnded, budget }) {
  const procs = findProcesses(isCodex);
  if (!procs.length && !showEnded) return [];

  const files = recentFiles();
  const seen = new Set(files.map((f) => f.path));
  for (const path of states.keys()) if (!seen.has(path)) states.delete(path);
  for (const f of files) {
    let st = states.get(f.path);
    if (!st) states.set(f.path, (st = newState(f.path)));
    if (st.tail.read((x) => applyLine(st, x), budget)) markDirty(f.path, () => snapshot(st));
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
      phase: phaseOf(st, live),
      cost: null,
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
      out.push({ tool: 'codex', id: `pid-${pid}`, pid, kind: 'interactive', name: basename(cwd ?? '') || 'codex', cwd, project: basename(cwd ?? ''), live: true, status: 'idle', phase: { kind: 'idle', text: '첫 입력 대기' }, cost: null, now: '', updatedAt: Date.now(), tokens: emptyTokens(), context: { used: 0, window: 0 }, events: [], members: [] });
    }
  }
  return out;
}
