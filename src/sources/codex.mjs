// Codex CLI: 실행 중인 codex 프로세스의 작업 폴더와 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 을 짝지어 읽는다.
import { readdirSync, statSync, existsSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { findProcesses, isCodex, openFiles, processStart } from '../procs.mjs';
import { emptyTokens, pushEvent, describeTool, isNoisePrompt } from './common.mjs';
import { addChange, mergeFiles } from './files.mjs';
import { codexCost } from '../pricing.mjs';
import { parsePatch, extractPatch, patchSucceeded } from './patch.mjs';

// 지시 탭에 쓰는 지시 목록은 최근 것만 남긴다.
const MAX_TURNS = 50;

const ROOT = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
const RECENT_MS = 24 * 3600 * 1000;

const states = new Map();

function dayDirs(days = 7) {
  const dirs = [];
  // 며칠 동안 켜 둔 세션도 시작한 날짜 폴더에 기록하므로 일주일치 폴더를 본다.
  for (let back = 0; back < days; back++) {
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

// 하루 넘게 쉰 세션은 최근 파일 목록에 없다. 짝을 못 찾은 codex 프로세스에만 같은 작업 폴더에서 가장 최근에
// 바뀐 파일을 30일치 폴더에서 찾되, 프로세스가 시작한 뒤에 쓰인 파일만 받는다. 그래야 첫 입력 전인 새 codex 에
// 지난 세션이 붙지 않는다. 시작 시각을 모르면 찾지 않는다.
// 찾은 파일은 pid 별로 기억한다. 못 찾았으면 날짜 폴더가 바뀔 때(새 파일·새 폴더)까지만 다시 찾지 않는다.
const OLD_DAYS = 30;
const HEAD_BYTES = 256 * 1024;
const cwdByPath = new Map();
const foundByPid = new Map();
let headBuf = null;

// session_meta 첫 줄은 지침 글 때문에 길 수 있어 JSON 전체 대신 앞부분의 cwd 만 찾는다.
function headCwd(path) {
  if (cwdByPath.has(path)) return cwdByPath.get(path);
  let cwd = null;
  try {
    const fd = openSync(path, 'r');
    try {
      headBuf ??= Buffer.alloc(HEAD_BYTES);
      const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(headBuf.toString('utf8', 0, readSync(fd, headBuf, 0, HEAD_BYTES, 0)));
      if (m) cwd = JSON.parse(m[1]);
    } finally {
      closeSync(fd);
    }
  } catch {}
  cwdByPath.set(path, cwd);
  return cwd;
}

let realRoot = null;

function isRollout(p) {
  if (realRoot === null) {
    try {
      realRoot = realpathSync(ROOT);
    } catch {}
  }
  return (p.startsWith(ROOT + '/') || (realRoot !== null && p.startsWith(realRoot + '/'))) && /\/rollout-[^/]*\.jsonl$/.test(p);
}

// 날짜 폴더에 파일이 생기면 그 폴더의 수정 시각이 바뀐다.
function foldersSignature(dirs) {
  return dirs
    .map((d) => {
      try {
        return d + ':' + statSync(d).mtimeMs;
      } catch {
        return d;
      }
    })
    .join('|');
}

function latestFor(dirs, cwd, since, taken) {
  let best = null;
  const listed = new Set();
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (!n.endsWith('.jsonl')) continue;
      listed.add(p);
      if (taken.has(p)) continue;
      let m;
      try {
        m = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (m >= since && (!best || m > best.mtime) && headCwd(p) === cwd) best = { path: p, mtime: m };
    }
  }
  for (const p of cwdByPath.keys()) if (!listed.has(p)) cwdByPath.delete(p);
  return best?.path ?? null;
}

function searchByCwd(pid, cwd, taken, startOf) {
  const memo = foundByPid.get(pid);
  if (memo?.path) return taken.has(memo.path) ? null : memo.path;
  const dirs = dayDirs(OLD_DAYS);
  const sig = foldersSignature(dirs);
  if (memo && memo.sig === sig) return null;
  const since = startOf(pid);
  if (since === null) return null;
  const path = latestFor(dirs, cwd, since, taken);
  foundByPid.set(pid, { path, sig });
  return path;
}

const SAVED = ['id', 'cwd', 'branch', 'model', 'busy', 'tokens', 'context', 'window', 'events', 'lastTool', 'startedAt', 'lastKind', 'files', 'turns', 'turnCount'];

function newState(path) {
  const st = { tail: new JsonlTail(path), id: basename(path), cwd: null, branch: null, model: null, busy: false, tokens: emptyTokens(), context: 0, window: 0, events: [], lastTool: null, startedAt: null, pending: new Map(), lastKind: null, files: [], turns: [], turnCount: 0, patches: {} };
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
        st.patches = {};
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
        if (p.message && !isNoisePrompt(p.message)) {
          const e = pushEvent(st, x.timestamp, 'prompt', p.message);
          if (e) {
            st.turns.push({ n: ++st.turnCount, at: e.at, text: e.text.slice(0, 120) });
            if (st.turns.length > MAX_TURNS) st.turns.shift();
          }
        }
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
      // 예전 Codex 는 apply_patch 를 shell 명령 인자로 보냈다 (["apply_patch", "*** Begin Patch…"] 또는 bash -lc 안의 글).
      const cmd = Array.isArray(args.command) ? args.command.join('\n') : String(args.command ?? '');
      const text = /\bapply_patch\b/.test(cmd) ? extractPatch(cmd) : null;
      if (p.call_id && text) st.patches[p.call_id] = { at: x.timestamp, text };
    } else if (p.type === 'custom_tool_call') {
      what = describeTool(p.name, p.input ?? '');
      if (p.call_id && p.name === 'apply_patch') st.patches[p.call_id] = { at: x.timestamp, text: String(p.input ?? '') };
    } else if (p.type === 'web_search_call') what = 'WebSearch';
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      // 성공한 패치만 변경 파일에 넣는다.
      const patch = st.patches[p.call_id];
      if (patch) {
        delete st.patches[p.call_id];
        if (patchSucceeded(p.output)) for (const r of parsePatch(patch.text, st.cwd)) addChange(st.files, r, patch.at);
      }
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

export const _test = { newState, applyLine, phaseOf, snapshot };

export function collectCodex({ showEnded, budget, filesOf = openFiles, startOf = processStart }) {
  const procs = findProcesses(isCodex);
  if (!procs.length && !showEnded) return [];

  const files = recentFiles();
  const read = (path) => {
    let st = states.get(path);
    if (!st) states.set(path, (st = newState(path)));
    if (st.tail.read((x) => applyLine(st, x), budget)) markDirty(path, () => snapshot(st));
  };
  for (const f of files) read(f.path);

  const liveByPath = new Map();
  const claim = (path, pid) => {
    if (!files.some((f) => f.path === path)) {
      try {
        files.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        return false;
      }
    }
    read(path);
    liveByPath.set(path, pid);
    return true;
  };

  // 프로세스가 열어 둔 rollout 파일(Linux)이 가장 정확하므로 먼저 짝짓는다.
  const rest = [];
  for (const p of procs) {
    const opened = filesOf(p.pid)?.find((f) => isRollout(f) && !liveByPath.has(f));
    if (!opened || !claim(opened, p.pid)) rest.push(p);
  }

  // 남은 프로세스는 같은 폴더에서 돌고 있는 수만큼, 가장 최근에 바뀐 세션 파일을 '실행 중'으로 본다.
  // 시작 시각을 아는 프로세스에는 시작한 뒤에 쓰인 파일만 준다. 새 codex 에 방금 끝난 세션이 붙지 않게 한다.
  const slots = new Map();
  for (const p of rest) slots.set(p.cwd, [...(slots.get(p.cwd) ?? []), p.pid]);
  for (const f of files) {
    if (liveByPath.has(f.path)) continue;
    const free = slots.get(states.get(f.path).cwd);
    const i = free?.findIndex((pid) => {
      const since = startOf(pid);
      return since === null || f.mtime >= since;
    }) ?? -1;
    if (i >= 0) liveByPath.set(f.path, free.splice(i, 1)[0]);
  }

  const alive = new Set(procs.map((p) => p.pid));
  for (const pid of foundByPid.keys()) if (!alive.has(pid)) foundByPid.delete(pid);
  for (const [cwd, pids] of slots) {
    for (const pid of [...pids]) {
      const path = searchByCwd(pid, cwd, liveByPath, startOf);
      if (path && claim(path, pid)) pids.splice(pids.indexOf(pid), 1);
    }
  }

  const seen = new Set(files.map((f) => f.path));
  for (const path of states.keys()) if (!seen.has(path)) states.delete(path);

  const out = [];
  for (const f of files) {
    const st = states.get(f.path);
    const pid = liveByPath.get(f.path);
    const live = pid !== undefined;
    if (!live && !showEnded) continue;
    // 가격표에 없는 모델은 비용을 ? 로 보인다.
    const cost = codexCost(st.model, st.tokens);
    const used = st.tokens.total > 0;
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
      cost: cost?.total ?? (used ? 0 : null),
      costNoCache: cost?.noCache ?? null,
      costUnknown: used && !cost,
      waitingFor: null,
      now: st.lastTool ?? st.events.at(-1)?.text ?? '',
      startedAt: st.startedAt,
      updatedAt: f.mtime,
      tokens: { ...st.tokens, sub: 0 },
      context: { used: st.context, window: st.window || 258_400 },
      events: st.events,
      files: mergeFiles([{ agent: '메인', files: st.files }]),
      turns: st.turns,
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
