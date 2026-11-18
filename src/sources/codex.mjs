// Codex CLI: 실행 중인 codex 프로세스의 작업 폴더와 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 을 짝지어 읽는다.
// Codex 홈이 여럿이면(dirs.mjs) 모두 보고, 같은 rollout 파일 이름은 하나로 센다.
import { readdirSync, statSync, existsSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { canListProcesses, findProcesses, isCodex, openFiles, processStart } from '../procs.mjs';
import { addActivity, emptyTokens, parseTs, pushEvent, describeTool, isNoisePrompt, sessionName } from './common.mjs';
import { addChange, mergeFiles } from './files.mjs';
import { codexCost } from '../pricing.mjs';
import { parsePatch, extractPatch, patchSucceeded } from './patch.mjs';
import { debug, debugIo } from '../log.mjs';
import { lastName } from '../paths.mjs';
import { codexHomes, codexSessionRoots, dedupeBy, homeOf } from './dirs.mjs';

// 지시 탭에 쓰는 지시 목록은 최근 것만 남긴다.
const MAX_TURNS = 50;

const RECENT_MS = 24 * 3600 * 1000;
// 프로세스 목록을 못 얻을 때(Windows 에서 PowerShell CIM 이 실패할 때 등)는 이 시간 안에 바뀐 기록을 실행 중으로 본다.
// codex 는 답할 때마다 기록에 쓰므로, 답을 읽고 다음 지시를 쓰는 동안(대개 몇 분)은 남고 닫은 세션은 곧 빠진다.
// Claude 팀원의 MEMBER_STALE_MS(15분)보다 짧게 둔다. 실제 프로세스가 없으니 끝난 세션이 오래 남는 쪽이 더 헷갈린다.
export const NO_PROC_LIVE_MS = 10 * 60_000;

const states = new Map();

export function dayDirs(days = 7) {
  const dirs = [];
  // 며칠 동안 켜 둔 세션도 시작한 날짜 폴더에 기록하므로 일주일치 폴더를 본다.
  const roots = codexSessionRoots();
  for (let back = 0; back < days; back++) {
    const d = new Date(Date.now() - back * 86400_000);
    const ymd = [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')];
    for (const root of roots) {
      const p = join(root, ...ymd);
      if (existsSync(p)) dirs.push(p);
    }
  }
  return dirs;
}

// 남아 있는 날짜 폴더 전부 (sessions/YYYY/MM/DD). 장부는 시작한 날과 상관없이 최근에 바뀐 기록을 모두 봐야 해서 이것을 쓴다.
export function allDayDirs() {
  const dirs = [];
  const sub = (p) => {
    try {
      return readdirSync(p).filter((n) => /^\d+$/.test(n)).map((n) => join(p, n));
    } catch {
      return [];
    }
  };
  for (const root of codexSessionRoots()) for (const y of sub(root)) for (const m of sub(y)) dirs.push(...sub(m));
  return dirs;
}

// 날짜 폴더를 매초 다시 훑지 않도록 파일 이름 목록만 잠깐 재사용한다. 수정 시각은 매번 확인한다.
const LIST_TTL_MS = 5000;
let listed = { at: 0, paths: [] };

function recentFiles() {
  if (Date.now() - listed.at >= LIST_TTL_MS) {
    const paths = [];
    for (const dir of dayDirs()) {
      try {
        for (const n of readdirSync(dir)) if (n.endsWith('.jsonl')) paths.push(join(dir, n));
      } catch (e) {
        debugIo('codex', 'day folder read failed', e, dir);
      }
    }
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
    if (Date.now() - m < RECENT_MS) out.push({ key: basename(p), path: p, mtime: m });
  }
  // 같은 rollout 이 두 홈에 있으면 더 최근 쪽 하나만.
  return dedupeBy(out).sort((a, b) => b.mtime - a.mtime);
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
  } catch (e) {
    debugIo('codex', 'rollout head read failed', e, path);
  }
  cwdByPath.set(path, cwd);
  return cwd;
}

// 홈마다 sessions 경로와 그 실제 경로(realpath). 처음 쓸 때 한 번 만든다.
let prefixes = null;

function isRollout(p) {
  if (prefixes === null) {
    prefixes = [];
    for (const root of codexSessionRoots()) {
      prefixes.push(root + '/');
      try {
        prefixes.push(realpathSync(root) + '/');
      } catch (e) {
        debugIo('codex', 'sessions realpath failed', e, root);
      }
    }
  }
  return prefixes.some((x) => p.startsWith(x)) && /\/rollout-[^/]*\.jsonl$/.test(p);
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
    } catch (e) {
      debugIo('codex', 'day folder read failed', e, dir);
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

// Codex 홈마다 session_index.jsonl(한 줄에 { id, thread_name, updated_at })을 따라 읽어 id → 이름.
// 이름을 바꿀 때마다 뒤에 붙으므로 같은 id 는 마지막 줄이 이긴다. 새로 붙은 줄만 읽는다.
// indexes: 홈 → { tail, names }. 홈끼리 이름을 섞지 않는다.
const indexes = new Map();

function readIndex(budget) {
  for (const home of codexHomes()) {
    let ix = indexes.get(home);
    if (!ix) {
      const names = new Map();
      ix = { tail: new JsonlTail(join(home, 'session_index.jsonl')), names };
      ix.tail.onReset = () => names.clear();
      indexes.set(home, ix);
    }
    ix.tail.read((x) => {
      if (typeof x?.id !== 'string') return;
      const name = sessionName(x.thread_name);
      if (name) ix.names.set(x.id, name);
      else ix.names.delete(x.id);
    }, budget);
  }
}

// rollout 이 든 홈의 이름을 먼저, 없으면 다른 홈의 이름 (같은 세션을 다른 홈으로 옮긴 경우).
function indexName(path, id) {
  const homes = codexHomes();
  const own = homeOf(path, homes);
  const first = own ? indexes.get(own)?.names.get(id) : undefined;
  if (first) return first;
  for (const h of homes) {
    const n = indexes.get(h)?.names.get(id);
    if (n) return n;
  }
  return null;
}

const SAVED = ['id', 'threadName', 'cwd', 'branch', 'model', 'busy', 'tokens', 'context', 'window', 'events', 'lastTool', 'startedAt', 'lastKind', 'files', 'turns', 'turnCount', 'activity', 'pendingAt'];

function newState(path) {
  const st = { tail: new JsonlTail(path), id: basename(path), threadName: null, cwd: null, branch: null, model: null, busy: false, tokens: emptyTokens(), context: 0, window: 0, events: [], lastTool: null, startedAt: null, pending: new Map(), lastKind: null, files: [], turns: [], turnCount: 0, patches: {}, activity: {}, pendingAt: {} };
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
  if (!live) return { kind: 'ended' };
  if (!st.busy) return { kind: 'idle' };
  const open = [...st.pending.values()];
  if (open.length) return { kind: 'tool', args: { what: open.at(-1) } };
  return st.lastKind === 'reply' ? { kind: 'write' } : { kind: 'think' };
}

// phaseOf 가 보이는 도구(열린 호출 가운데 마지막 것)가 시작된 시각(ms). function_call·custom_tool_call 줄의 시각이다.
// pendingAt 이 생기기 전 캐시에서 이어 읽는 호출은 시각을 몰라 null. Codex 기록에는 허락 대기 상태가 없어 따로 빼지 않는다.
function toolStartOf(st, phase) {
  if (phase.kind !== 'tool') return null;
  const at = st.pendingAt?.[[...st.pending.keys()].at(-1)];
  return Number.isFinite(at) ? at : null;
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
        st.pendingAt = {};
        st.patches = {};
        break;
      case 'token_count': {
        const t = p.info?.total_token_usage;
        if (t) {
          const cached = t.cached_input_tokens ?? 0;
          // 누적값이라 직전 합계와의 차이를 그 줄의 시각 칸에 더한다.
          addActivity(st.activity, parseTs(x.timestamp), (t.total_tokens ?? 0) - st.tokens.total);
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
      // 이름 바꾸기 이벤트 (Codex /rename 등). 빈 이름이면 지운다.
      case 'thread_name_updated':
        st.threadName = sessionName(p.thread_name);
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
      } catch (e) {
        debug('codex', 'function_call arguments parse failed', e);
      }
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
      if (st.pendingAt) delete st.pendingAt[p.call_id];
      st.lastKind = 'result';
    }
    if (what) {
      st.lastTool = what;
      if (p.call_id && p.type !== 'web_search_call') {
        st.pending.set(p.call_id, p.name);
        (st.pendingAt ??= {})[p.call_id] = parseTs(x.timestamp);
      }
      pushEvent(st, x.timestamp, 'tool', what);
      st.lastKind = 'tool';
    }
  }
}

// 세션 리포트용: rollout(path)·세션 id 의 session_index.jsonl 이름 (없으면 null). 색인은 새로 붙은 줄만 읽는다.
export function codexIndexName(path, id) {
  if (!id) return null;
  readIndex(undefined);
  return indexName(path, id);
}

export const _test = { newState, applyLine, phaseOf, toolStartOf, snapshot, readIndex, indexName };

// 작업 폴더를 모르는 프로세스(Windows, cwdUnknown)와 rollout 을 시작 시각으로 짝짓는다. 돌려주는 값은 경로 → pid.
// files 는 최근에 바뀐 순서, sessionStartOf(path) 는 세션이 시작한 시각(ms), startOf(pid) 는 프로세스가 뜬 시각.
// 1) 프로세스 기준: 늦게 뜬 프로세스부터, 그 프로세스가 뜬 뒤 시작한 세션 중 가장 최근에 기록된 것을 준다.
//    codex 안에서 /new 로 새 세션을 열면 예전 세션은 조용해지고 새 세션이 기록되므로, 지금 쓰는 세션이 숨지 않는다.
//    알려진 한계: 시각만으로는 다른 터미널에서 방금 끝난 세션과 구별할 수 없어, 오래 쉬는 세션 대신 그 세션이 잠시
//    실행 중으로 보일 수 있다. 쉬던 세션이 다시 기록하면 바로잡힌다 (지금 쓰는 세션이 숨는 쪽이 더 나빠서 이렇게 고른다).
// 2) 남은 프로세스(이어 연 세션)에는 최근에 바뀐 파일부터, 파일이 쓰이기 전에 뜬 프로세스 중 가장 늦게 뜬 것을 준다.
// 어느 쪽이든 프로세스가 뜨기 전에 마지막으로 쓰인 파일은 받지 않는다.
export function pairByStart(pids, files, sessionStartOf, startOf) {
  const out = new Map();
  const left = pids.map((pid) => ({ pid, since: startOf(pid) }));
  const order = left.filter((p) => p.since !== null).sort((a, b) => b.since - a.since);
  for (const p of order) {
    // files 는 최근에 바뀐 순서라 처음 맞는 것이 가장 최근에 기록된 세션이다.
    const best = files.find((f) => {
      if (out.has(f.path) || f.mtime < p.since) return false;
      const s = sessionStartOf(f.path);
      return Number.isFinite(s) && s >= p.since;
    });
    if (best) {
      out.set(best.path, p.pid);
      left.splice(left.indexOf(p), 1);
    }
  }
  for (const f of files) {
    if (!left.length) break;
    if (out.has(f.path)) continue;
    let j = -1;
    for (let i = 0; i < left.length; i++) {
      const since = left[i].since;
      if (since !== null && f.mtime < since) continue;
      if (j < 0 || (since ?? -Infinity) > (left[j].since ?? -Infinity)) j = i;
    }
    if (j >= 0) out.set(f.path, left.splice(j, 1)[0].pid);
  }
  return out;
}

export function collectCodex({ showEnded, budget, filesOf = openFiles, startOf = processStart, canList = canListProcesses, procsOf = () => findProcesses(isCodex) }) {
  // 프로세스를 못 세면 숨기지 않고 최근에 바뀐 기록으로 판정한다 (pid 는 null).
  const blind = !canList();
  const procs = blind ? [] : procsOf();
  if (!procs.length && !showEnded && !blind) return [];

  const fresh = (f) => Date.now() - f.mtime <= NO_PROC_LIVE_MS;
  const files = blind && !showEnded ? recentFiles().filter(fresh) : recentFiles();
  const read = (path) => {
    let st = states.get(path);
    if (!st) states.set(path, (st = newState(path)));
    if (st.tail.read((x) => applyLine(st, x), budget)) markDirty(path, () => snapshot(st));
  };
  for (const f of files) read(f.path);
  readIndex(budget);

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
  const anyCwd = [];
  for (const p of rest) {
    if (p.cwdUnknown) anyCwd.push(p.pid);
    else slots.set(p.cwd, [...(slots.get(p.cwd) ?? []), p.pid]);
  }
  for (const f of files) {
    if (liveByPath.has(f.path)) continue;
    const free = slots.get(states.get(f.path).cwd);
    const i = free?.findIndex((pid) => {
      const since = startOf(pid);
      return since === null || f.mtime >= since;
    }) ?? -1;
    if (i >= 0) liveByPath.set(f.path, free.splice(i, 1)[0]);
  }
  // 작업 폴더를 모르는 프로세스(Windows)는 폴더와 상관없이 시작 시각으로만 짝짓는다 (pairByStart).
  if (anyCwd.length) {
    const free = files.filter((f) => !liveByPath.has(f.path));
    for (const [path, pid] of pairByStart(anyCwd, free, (p) => states.get(p)?.startedAt, startOf)) liveByPath.set(path, pid);
  }

  const alive = new Set(procs.map((p) => p.pid));
  for (const pid of foundByPid.keys()) if (!alive.has(pid)) foundByPid.delete(pid);
  for (const [cwd, pids] of slots) {
    for (const pid of [...pids]) {
      const path = searchByCwd(pid, cwd, liveByPath, startOf);
      if (path && claim(path, pid)) pids.splice(pids.indexOf(pid), 1);
    }
  }

  if (blind) for (const f of files) if (fresh(f)) liveByPath.set(f.path, null);

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
    // 기록 안의 이름 바꾸기 이벤트가 먼저, 없으면 session_index.jsonl 의 thread_name.
    const customName = st.threadName ?? indexName(f.path, st.id);
    const phase = phaseOf(st, live);
    out.push({
      tool: 'codex',
      id: st.id,
      pid: pid ?? null,
      kind: 'interactive',
      name: customName ?? (lastName(st.cwd) || 'codex'),
      customName,
      // rollout 이 든 Codex 홈. 기본 홈이 아니면 이어 열기 명령에 CODEX_HOME 을 붙인다.
      home: homeOf(f.path, codexHomes()),
      cwd: st.cwd,
      project: lastName(st.cwd),
      branch: st.branch,
      model: st.model,
      live,
      status: !live ? 'ended' : st.busy ? 'busy' : 'idle',
      phase,
      // 지금 도는 도구가 시작된 시각(ms) 또는 null (toolStartOf).
      toolStartedAt: toolStartOf(st, phase),
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
      activity: st.activity,
      members: [],
    });
  }

  // 아직 세션 파일을 만들지 않은(첫 입력 전) codex 프로세스도 보여 준다.
  for (const [cwd, pids] of slots) {
    for (const pid of pids) {
      out.push({ tool: 'codex', id: `pid-${pid}`, pid, kind: 'interactive', name: lastName(cwd) || 'codex', cwd, project: lastName(cwd), live: true, status: 'idle', phase: { kind: 'idle', msg: 'firstInput' }, cost: null, now: '', updatedAt: Date.now(), tokens: emptyTokens(), context: { used: 0, window: 0 }, events: [], members: [] });
    }
  }
  return out;
}
