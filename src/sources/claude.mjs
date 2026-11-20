// Claude Code: ~/.claude/sessions/<pid>.json 으로 살아 있는 세션을 찾고,
// ~/.claude/projects/*/<sessionId>.jsonl 대화 기록에서 진행 단계·토큰·비용을 읽는다.
// 설정 폴더가 여럿이면(dirs.mjs) 모두 보고, 같은 세션 id 는 하나로 합친다.
import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { CACHE_ROOT, PARENTS_FILE, loadCache } from '../cache.mjs';
import { renameSync } from '../rename.mjs';
import { contextWindow } from '../pricing.mjs';
import { join, basename, dirname } from 'node:path';
import { isSessionAlive, parentPid } from '../procs.mjs';
import { ClaudeTracker, headEntrypoint, tailCustomTitle, tailStopReason } from './claude-tracker.mjs';
import { emptyTokens, isLongTool, mergeActivity, MEMBER_FADE_MS, sessionName } from './common.mjs';
import { mergeFiles } from './files.mjs';
import { debug, debugIo } from '../log.mjs';
import { claudeDirs, claudeProjectRoots, dedupeBy } from './dirs.mjs';

const ENDED_WINDOW_MS = 24 * 3600 * 1000;
// finished 표시 없이 중간에 끊긴 팀원 기록이 남기 때문에, 이 시간 넘게 기록이 없으면 실행 중으로 보지 않는다.
const MEMBER_STALE_MS = 15 * 60_000;

const trackers = new Map();
const subTrackers = new Map();
const pathCache = new Map();

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    debugIo('claude', 'session file read failed', e, p);
    return null;
  }
}

// projects/ 아래 프로젝트 폴더 이름 [[root, dirs]]. 읽지 못한 root 는 null 이다.
function projectDirs() {
  return claudeProjectRoots().map((root) => {
    try {
      return [root, readdirSync(root)];
    } catch (e) {
      debugIo('claude', 'projects read failed', e, root);
      return [root, null];
    }
  });
}

// listing: projectDirs() 결과. 여러 세션을 한 번에 찾을 때 넘기면 projects/ 를 세션마다 다시 읽지 않는다.
function findTranscript(sessionId, listing = null) {
  const cached = pathCache.get(sessionId);
  if (cached && (cached.path ? existsSync(cached.path) : Date.now() - cached.at < 5000)) return cached.path;
  // 같은 세션 기록이 두 폴더에 있으면 더 최근에 바뀐 쪽 (끝난 세션 목록과 같은 기준). 폴더 하나에서는 처음 찾은 것.
  let path = null;
  let best = -Infinity;
  for (const [root, dirs] of listing ?? projectDirs()) {
    if (!dirs) continue;
    for (const dir of dirs) {
      const p = join(root, dir, `${sessionId}.jsonl`);
      let m;
      try {
        m = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (m > best) {
        path = p;
        best = m;
      }
      break;
    }
  }
  pathCache.set(sessionId, { path, at: Date.now() });
  return path;
}

// 이번 갱신에서 쓴 tracker 경로. 갱신이 끝나면 여기 없는 tracker 는 지운다.
let seen = new Set();

function tracker(map, path, budget) {
  let t = map.get(path);
  if (!t) map.set(path, (t = new ClaudeTracker(path)));
  t.update(budget);
  seen.add(path);
  return t;
}

function prune() {
  for (const map of [trackers, subTrackers]) for (const path of map.keys()) if (!seen.has(path)) map.delete(path);
}

export function _stats() {
  return { trackers: trackers.size, subTrackers: subTrackers.size };
}

// 기록을 아직 다 읽지 못한 세션의 상태. 읽다 만 기록의 진행 단계는 틀릴 수 있어 화면에는 … 로만 보인다 (진행률은 헤더 한 줄로 모은다).
function loadingPhase(t) {
  return t?.loading != null ? { kind: 'think', msg: 'loading' } : null;
}

// 서브에이전트 전체(끝난 것 포함)의 토큰·비용 합계. 메인 세션 합계에 더해 화면에 보인다.
export function emptySub() {
  return { count: 0, tokens: emptyTokens(), cost: 0, costNoCache: 0, costUnknown: false, loading: false, files: [], activity: [] };
}

// 메인 tracker 와 서브에이전트 합계를 화면에 보일 세션 숫자로 합친다. 기록을 아직 읽지 않았으면(t 없음) 비용은 null.
export function sessionTotals(t, sub) {
  const main = t?.tokens ?? emptyTokens();
  const tokens = { main: main.total, sub: sub.tokens.total, subCount: sub.count };
  for (const k of Object.keys(main)) tokens[k] = main[k] + sub.tokens[k];
  const used = t?.context ?? 0;
  return {
    tokens,
    cost: t ? t.cost + sub.cost : null,
    costNoCache: t ? t.costNoCache + sub.costNoCache : null,
    costUnknown: Boolean(t?.costUnknown || sub.costUnknown),
    // 메인이나 서브에이전트 기록을 아직 다 읽지 못해 숫자가 덜 찬 상태. 표는 이 동안 숫자 대신 … 를 보인다.
    loading: Boolean(t?.loading != null || sub.loading),
    context: { used, window: contextWindow(t?.model, used) },
    files: t ? mergeFiles([{ agent: '메인', files: t.files }, ...sub.files]) : [],
    turns: t?.turns ?? [],
    // 시간별 토큰: 메인과 서브에이전트를 칸별로 더한다.
    activity: mergeActivity([t?.activity, ...sub.activity]),
  };
}

// track: 서브에이전트 기록 tracker 를 얻는 함수 (Cowork 는 자기 tracker 목록을 쓴다, cowork.mjs).
// meta: false 면 agent-<id>.meta.json 을 열지 않고 agent-<id>.jsonl 만 본다 (Cowork 앱 폴더의 허용 목록, #304).
// 그때는 팀원 이름이 'agent' 이고 작업 설명이 비며, 끝남 표시가 없어 기록이 MEMBER_STALE_MS 넘게 그대로면 끝난 것으로 본다.
export function readMembers(transcript, parent, budget, { track = (p, b) => tracker(subTrackers, p, b), meta: withMeta = true } = {}) {
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  const sub = emptySub();
  if (!existsSync(dir)) return { members: [], sub };
  const members = [];
  const tail = withMeta ? '.meta.json' : '.jsonl';
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('agent-') || !f.endsWith(tail)) continue;
    const id = f.slice('agent-'.length, -tail.length);
    const meta = (withMeta ? readJson(join(dir, f)) : null) ?? {};
    const t = track(join(dir, `agent-${id}.jsonl`), budget);
    sub.count++;
    for (const k of Object.keys(sub.tokens)) sub.tokens[k] += t.tokens[k];
    sub.cost += t.cost;
    sub.costNoCache += t.costNoCache;
    sub.costUnknown ||= t.costUnknown;
    sub.loading ||= t.loading != null;
    sub.activity.push(t.activity);
    if (t.files.length) sub.files.push({ agent: meta.agentType ?? 'agent', files: t.files, startedAt: t.firstAt ?? undefined });
    const age = Date.now() - t.mtimeMs;
    const awaited = Boolean(meta.toolUseId && parent?.pending.has(meta.toolUseId));
    const running = !meta.finished && !meta.stoppedByUser && (awaited || age < MEMBER_STALE_MS);
    const finished = !running;
    if (finished && age > MEMBER_FADE_MS) continue;
    // 첫 응답이 오기 전에는 모델·토큰이 없으므로 '시작 중' 으로 보인다.
    const started = Boolean(t.model || t.tokens.total > 0);
    members.push({
      id,
      name: meta.agentType ?? 'agent',
      model: t.model,
      task: meta.description ?? '',
      status: finished ? 'done' : 'busy',
      started,
      phase: finished ? { kind: 'done' } : !started ? { kind: 'idle', msg: 'starting' } : loadingPhase(t) ?? t.phase(),
      now: t.lastTool,
      tokens: t.tokens.total,
      cost: t.cost,
      costNoCache: t.costNoCache,
      costUnknown: t.costUnknown,
      loading: t.loading != null,
      // 경과 시간의 기준은 서브에이전트 기록의 첫 줄 시각, 멈춘 듯 판단은 기록 파일의 마지막 수정 시각이다.
      startedAt: t.firstAt ?? t.events[0]?.at,
      lastActivityAt: t.mtimeMs || null,
      // Bash 처럼 결과가 오기까지 오래 걸릴 수 있는 도구가 도는 중이면 멈춘 듯 기준을 길게 잡는다 (common.mjs).
      longStep: [...t.pending.values()].some((p) => isLongTool(p.name)),
    });
  }
  members.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return { members, sub };
}

function statusOf(entry, alive, mtime) {
  if (!alive) return 'ended';
  if (entry.waitingFor) return 'waiting';
  if (['busy', 'shell', 'idle'].includes(entry.status)) return entry.status;
  return Date.now() - mtime < 5000 ? 'busy' : 'idle';
}

// 응답 대기는 Claude Code 가 세션 파일에 적은 값이다. 그동안 서브에이전트가 돌고 있으면 수를 args.agents 로 함께 보내 구분되게 한다.
export function withRunningMembers(phase, status, members) {
  if (status !== 'waiting') return phase;
  const running = members.filter((m) => m.status !== 'done' && m.phase?.kind !== 'done').length;
  return running ? { ...phase, args: { ...phase.args, agents: running } } : phase;
}

export function phaseOf(status, entry, t) {
  switch (status) {
    case 'ended':
      return { kind: 'ended' };
    case 'waiting':
      return entry.waitingFor ? { kind: 'waiting', args: { what: entry.waitingFor } } : { kind: 'waiting' };
    case 'shell':
      return { kind: 'tool', msg: 'shell' };
    case 'idle':
      return stoppedPhase(t) ?? { kind: 'idle' };
    default:
      return loadingPhase(t) ?? (t ? t.phase() : { kind: 'think', msg: 'working' });
  }
}

// 대기(idle) 중인 세션의 마지막 대화 줄이 API 오류면 '멈춤' 으로 보인다 (claude-tracker.mjs stopReasonOf).
// 응답 대기·작업 중·종료는 그대로 두고, 기록을 다 읽기 전에는 판단하지 않는다.
const STOP_MSG = { auth: 'stopAuth', network: 'stopNetwork', api: 'stopApi' };
export function stoppedPhase(t) {
  const r = t?.loading == null ? t?.stopReason : null;
  return r ? { kind: 'stopped', msg: STOP_MSG[r.kind] ?? 'stopApi' } : null;
}

export function cacheOf(alive, status, t) {
  const at = t?.cacheExpiresAt;
  if (!alive || at == null || t.loading != null || (status !== 'waiting' && status !== 'idle') || (status === 'idle' && stoppedPhase(t))) return { cacheExpiresAt: null, cacheTtl: null };
  return { cacheExpiresAt: at, cacheTtl: t.cacheTtl };
}

// 도구가 돌기 시작한 시각(ms). 작업 중(busy)이고 진행 단계가 열린 도구 실행일 때만 둔다 (claude-tracker.mjs toolStartedAt).
// 허락 대기 중에는 두지 않고, 그동안 본 시각을 적어 두어 허락한 뒤에는 그때부터 잰다 (markWaiting).
// 쉘 명령(! 입력, status 'shell')은 기록에 tool_use 가 없어 빼고, 기록을 다 읽기 전에도 뺀다.
export function toolStartOf(status, phase, t) {
  if (!t) return null;
  if (status === 'waiting') {
    t.markWaiting();
    return null;
  }
  if (status !== 'busy' || phase?.kind !== 'tool' || t.loading != null) return null;
  return t.toolStartedAt();
}

// sessions/<pid>.json 은 세션이 끝나면 지워지므로, 끝난 세션은 최근에 바뀐 기록 파일로 찾는다.
// 폴더를 매번 훑지 않게 목록은 잠깐 재사용하고, 기록 앞부분에서 이름·폴더만 읽어 둔다.
const DISCOVER_TTL_MS = 10_000;
const HEAD_BYTES = 256 * 1024;
let discovered = { at: 0, list: [] };
// 테스트용: 다음 갱신에서 기록 목록을 다시 훑게 한다 (기본 보기의 하위 실행 후보 runFiles 도).
export const _resetDiscover = () => {
  discovered = { at: 0, list: [] };
  runFiles = { at: 0, key: '', list: [] };
};
const heads = new Map();

function recentTranscripts() {
  if (Date.now() - discovered.at < DISCOVER_TTL_MS) return discovered.list;
  const list = [];
  for (const root of claudeProjectRoots()) {
    let dirs = [];
    try {
      dirs = readdirSync(root);
    } catch (e) {
      debugIo('claude', 'projects read failed', e, root);
    }
    for (const dir of dirs) {
      let names;
      try {
        names = readdirSync(join(root, dir));
      } catch (e) {
        debugIo('claude', 'project folder read failed', e, dir);
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const path = join(root, dir, n);
        try {
          const mtime = statSync(path).mtimeMs;
          const sessionId = n.slice(0, -'.jsonl'.length);
          if (Date.now() - mtime < ENDED_WINDOW_MS) list.push({ key: sessionId, sessionId, path, mtime });
        } catch {}
      }
    }
  }
  // 같은 세션 기록이 두 폴더에 있으면 하나만 (더 최근 쪽).
  discovered = { at: Date.now(), list: dedupeBy(list) };
  return discovered.list;
}

// 기록이 바뀌었으면(mtime) 앞부분을 다시 읽어 뒤늦게 붙은 제목도 반영한다. /rename 이름은 끝부분에서 먼저 찾는다.
function readHead(path, mtime) {
  const cached = heads.get(path);
  if (cached && cached.mtime === mtime) return cached;
  const head = { mtime, cwd: null, title: null, customTitle: null, branch: null, startedAt: null, entrypoint: null };
  let headCustom;
  try {
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    closeSync(fd);
    const text = buf.toString('utf8', 0, n);
    for (const line of text.slice(0, text.lastIndexOf('\n')).split('\n')) {
      let x;
      try {
        x = JSON.parse(line);
      } catch (e) {
        debug('claude', 'transcript head line parse failed', e, path);
        continue;
      }
      head.cwd ??= x.cwd ?? null;
      head.branch ??= x.gitBranch ?? null;
      if (typeof x.entrypoint === 'string') head.entrypoint ??= x.entrypoint;
      if (x.timestamp) head.startedAt ??= Date.parse(x.timestamp) || null;
      if (x.type === 'ai-title' && x.aiTitle) head.title = x.aiTitle;
      if (x.type === 'custom-title') headCustom = sessionName(x.customTitle);
    }
  } catch (e) {
    debugIo('claude', 'transcript head read failed', e, path);
  }
  const tail = tailCustomTitle(path);
  head.customTitle = (tail === undefined ? headCustom : tail) ?? null;
  heads.set(path, head);
  return head;
}

// 캐시가 있는지는 기록이 바뀔 때만 다시 확인한다 (끝난 세션 수십 개를 매초 확인하지 않게).
const cacheChecked = new Map();

function hasCache(path, mtime) {
  const c = cacheChecked.get(path);
  if (c && c.mtime === mtime) return c.ok;
  const ok = Boolean(loadCache(path));
  cacheChecked.set(path, { mtime, ok });
  return ok;
}

// 끝난 세션의 기록 본문은 선택했을 때, 이미 캐시가 있을 때, 또는 --once 처럼 한도 없이 읽을 때만 읽는다.
// 한 번 읽기 시작한 세션은 선택을 옮겨도 계속 읽어서, 서브에이전트까지 포함한 합계가 흔들리지 않게 한다.
function endedFromTranscripts(known, selectedId, budget) {
  const out = [];
  const eager = budget.left === Infinity;
  const recent = recentTranscripts();
  const recentPaths = new Set(recent.map((f) => f.path));
  for (const map of [heads, cacheChecked]) for (const p of map.keys()) if (!recentPaths.has(p)) map.delete(p);
  for (const f of recent) {
    if (known.has(f.sessionId)) continue;
    const head = readHead(f.path, f.mtime);
    const want = eager || f.sessionId === selectedId || trackers.has(f.path) || hasCache(f.path, f.mtime);
    out.push(endedSession(f, head, want ? tracker(trackers, f.path, budget) : null, budget));
  }
  return out;
}

// 끝난 세션 한 줄. t 가 없으면(본문을 아직 읽지 않음) 숫자는 비우고 lazy 로 둔다.
// 기록 경로(f)는 endedSrc 에 따로 둔다: claude -p 실행을 부모에 붙일 때 그 기록을 마저 읽는 데 쓴다 (attachRuns).
const endedSrc = new WeakMap();
function endedSession(f, head, t, budget) {
  const { sub } = t ? readMembers(f.path, t, budget) : { sub: emptySub() };
  const s = {
    tool: 'claude',
    id: f.sessionId,
    pid: null,
    kind: '-',
    name: (t ? t.customTitle : head.customTitle) ?? t?.title ?? head.title ?? `${basename(head.cwd ?? '')} · ${f.sessionId.slice(0, 8)}`,
    customName: (t ? t.customTitle : head.customTitle) ?? null,
    cwd: head.cwd,
    project: basename(head.cwd ?? ''),
    branch: t?.branch ?? head.branch,
    model: t?.model ?? null,
    entrypoint: t?.entrypoint ?? head.entrypoint ?? null,
    live: false,
    lazy: !t,
    status: 'ended',
    phase: { kind: 'ended' },
    waitingFor: null,
    now: '',
    startedAt: head.startedAt,
    updatedAt: f.mtime,
    ...sessionTotals(t, sub),
    events: t?.events ?? [],
    members: [],
  };
  endedSrc.set(s, f);
  return s;
}

// sessions 폴더 목록은 폴더 수정 시각이 그대로면 재사용한다 (#135).
// 수정 시각은 틱(수 ms)이나 초 단위로 거칠어, 읽기 직전·직후의 변경이 같은 시각으로 남을 수 있다.
// 그래서 수정된 지 RACY_MS 안에 읽은 결과는 믿지 않고 다음 갱신에 다시 읽는다 (git 의 racy 검사와 같다).
const RACY_MS = 2000;
const LIST_MAX_AGE_MS = 10_000;
// 폴더(sessions 경로)마다 목록을 따로 둔다.
const listings = new Map();
// 파일별로 읽은 내용. 수정 시각·크기가 그대로면 다시 읽지 않는다.
// 한 번 죽은 것으로 본 pid 는 살아나지 않으므로(같은 pid 는 다른 프로세스), 파일이 바뀌기 전까지 다시 확인하지 않는다.
const fileCache = new Map();
let sessionReads = 0;

export function _sessionReads() {
  return sessionReads;
}

// 돌려주는 것은 파일 전체 경로다 (fileCache 열쇠도 전체 경로라 폴더끼리 섞이지 않는다).
function listSessionFiles(dir) {
  const mtime = statSync(dir).mtimeMs;
  const listing = listings.get(dir);
  if (listing && mtime === listing.mtime && listing.at - mtime > RACY_MS && Date.now() - listing.at < LIST_MAX_AGE_MS) return listing.files;
  const files = readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => join(dir, n));
  listings.set(dir, { mtime, at: Date.now(), files });
  return files;
}

function sessionFile(path) {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    debugIo('claude', 'session file stat failed', e, path);
    fileCache.delete(path);
    return null;
  }
  let c = fileCache.get(path);
  if (!c || c.mtime !== st.mtimeMs || c.size !== st.size || c.at - c.mtime <= RACY_MS) {
    sessionReads++;
    const at = Date.now();
    c = { mtime: st.mtimeMs, size: st.size, at, entry: readJson(path), dead: false };
    fileCache.set(path, c);
  }
  // 미리 띄워 둔 대기 프로세스(claude bg-spare)는 아직 세션이 아니다. 작업을 맡으면 spare 가 빠진 파일로 다시 쓰인다.
  if (!c.entry?.sessionId || c.entry.spare) return null;
  if (!c.dead && !isSessionAlive(c.entry.pid, c.entry.procStart, c.entry.updatedAt ?? c.entry.startedAt)) c.dead = true;
  return { ...c.entry, alive: !c.dead };
}

// 모든 설정 폴더의 sessions/*.json 을 세션 id 마다 하나로 (살아 있는 쪽, 그다음 최근에 바뀐 쪽). 어느 폴더도 읽지 못하면 null.
// 폴더마다 마지막으로 읽은 세션 목록 { at, files, entries }.
// 폴더나 sessions/ 가 사라지면(ENOENT) 그 폴더 세션은 바로 뺀다. 그 밖의 오류(EACCES, EIO 등)는 잠깐일 수 있어
// STALE_KEEP_MS 동안만 직전 결과를 쓰고, 그동안에도 pid 가 살아 있는지는 다시 본다. 그 뒤에는 뺀다.
const entriesByDir = new Map();
let STALE_KEEP_MS = 30_000;
export const _setStaleKeepMs = (ms) => (STALE_KEEP_MS = ms);

function sessionEntries() {
  const homes = claudeDirs();
  const all = [];
  const keep = new Set();
  let ok = false;
  for (const home of homes) {
    const dir = join(home, 'sessions');
    let files;
    try {
      files = listSessionFiles(dir);
    } catch (e) {
      debugIo('claude', 'sessions read failed', e, dir);
      const prev = entriesByDir.get(dir);
      const gone = e.code === 'ENOENT' || e.code === 'ENOTDIR';
      if (gone || !prev || Date.now() - prev.at > STALE_KEEP_MS) {
        entriesByDir.delete(dir);
        listings.delete(dir);
        continue;
      }
      ok = true;
      for (const f of prev.files) keep.add(f);
      for (const x of prev.entries) all.push(x.alive && !isSessionAlive(x.pid, x.procStart, x.updatedAt ?? x.startedAt) ? { ...x, alive: false } : x);
      continue;
    }
    ok = true;
    const entries = [];
    for (const f of files) {
      keep.add(f);
      const e = sessionFile(f);
      // home: 세션 파일이 든 설정 폴더. 이어 열기 명령이 그 폴더를 CLAUDE_CONFIG_DIR 로 집는다.
      if (e) entries.push({ ...e, home });
    }
    entriesByDir.set(dir, { at: Date.now(), files, entries });
    all.push(...entries);
  }
  // 읽은 폴더도, 잠깐 직전 결과를 쓰는 폴더도 없으면 예전처럼 null (폴더가 하나면 동작이 그대로다).
  if (!ok) return null;
  for (const n of fileCache.keys()) if (!keep.has(n)) fileCache.delete(n);
  const latest = new Map();
  for (const e of all) {
    const prev = latest.get(e.sessionId);
    if (!prev || (e.alive && !prev.alive) || (e.updatedAt ?? e.startedAt) > (prev.updatedAt ?? prev.startedAt)) latest.set(e.sessionId, e);
  }
  return latest;
}

// 세션 파일 이름이 비었거나 id 앞 8자(이름을 아직 안 붙인 자리표시)인지.
const isAutoName = (e) => !e.name || e.name === e.sessionId.slice(0, 8);
// 세션 파일 이름 가운데 사람이 정한 것: nameSource 가 user(/rename) 또는 peer(다른 세션이 이름을 붙여 띄움).
// auto(모델이 지은 이름)·derived(폴더에서 만든 이름)·없음은 화면 이름으로만 쓰고 사용자 이름(customName)으로 치지 않는다.
const GIVEN_SOURCES = new Set(['user', 'peer']);
const givenFileName = (e) => (!isAutoName(e) && GIVEN_SOURCES.has(e.nameSource) ? sessionName(String(e.name)) : null);

// 사용자가 정한 이름: 기록의 마지막 custom-title, 없으면 세션 파일의 user/peer 이름. 알림 본문에 쓴다.
// custom-title 은 /rename 할 때 기록 순서대로 남으므로 마지막 것이 맞고, 세션 파일 이름도 그때 같은 값으로 맞춰진다.
function givenName(e, custom) {
  return custom ?? givenFileName(e);
}

// 살아 있는 세션 화면 이름. 순서: 사용자 이름(givenName) > 그 밖의 세션 파일 이름(자리표시 제외, auto·derived 포함) > 대화 제목 > 폴더 · id.
function sessionLabel(e, t) {
  const fileName = isAutoName(e) ? null : sessionName(String(e.name));
  return givenName(e, t?.customTitle) ?? fileName ?? t?.title ?? `${basename(e.cwd ?? '')} · ${e.sessionId.slice(0, 8)}`;
}

// 응답 대기 중인 Claude 세션들 [{ tool, name, since }]. 세션 파일과 pid 만 보고 프로세스 목록·대화 기록 본문은 읽지 않는다 (aitop --line 용).
// 이름은 표와 같은 순서: 기록 끝부분의 /rename 이름, 세션 파일 이름, 자리표시 이름이면 작업 폴더 이름 (대화 제목은 기록을 다 읽어야 안다).
// 대기 시작은 상태가 바뀐 시각(statusUpdatedAt), 없으면 세션 파일이 바뀐 시각.
export function claudeWaiting() {
  return claudeLineCounts().waiting;
}

// --line 용: 오류로 멈춘 살아 있는 Claude 세션 수. 화면과 같이 대기(idle) 세션의 마지막 대화 줄이 API 오류인지 기록 끝만 본다.
// 세션 파일에 상태가 없는 예전 Claude Code 는 기록 수정 시각으로 상태를 짐작해야 해서 세지 않는다.
export function claudeStopped() {
  return claudeLineCounts().stopped;
}

// --line 이 쓰는 두 값(응답 대기 목록, 멈춤 수)을 세션 목록 한 번, projects/ 폴더 목록 한 번으로 모은다.
// 멈춤 수는 지시 대기 세션마다 기록 끝(최대 256KB)을 읽으므로 deadline(Date.now() 기준 ms) 안에서만 센다.
// 다 세기 전에 시간이 다 되면 stopped 는 null(모름)이고, 줄은 멈춤 칸을 뺀다 (모자라게 센 수를 보이지 않는다).
export function claudeLineCounts({ deadline = Infinity } = {}) {
  const entries = [...(sessionEntries()?.values() ?? [])].filter((e) => e.alive);
  let listing = null;
  const find = (id) => findTranscript(id, (listing ??= projectDirs()));
  const waiting = [];
  for (const e of entries) {
    if (!e.waitingFor) continue;
    const transcript = find(e.sessionId);
    // claude -p(sdk-cli) 실행은 사람이 답할 수 없으므로 응답 대기로 세지 않는다 (화면 callsYou 와 같은 규칙). 기록 앞부분만 본다.
    if ((e.entrypoint ?? (transcript ? headEntrypoint(transcript) : null)) === SDK_ENTRY) continue;
    const custom = transcript ? tailCustomTitle(transcript) : undefined;
    const since = [e.statusUpdatedAt, e.updatedAt, e.startedAt].find(Number.isFinite) ?? null;
    waiting.push({ tool: 'claude', name: givenName(e, custom) ?? (isAutoName(e) ? basename(e.cwd ?? '') : String(e.name)), since });
  }
  let stopped = 0;
  for (const e of entries) {
    if (e.waitingFor || e.status !== 'idle') continue;
    if (Date.now() >= deadline) return { waiting, stopped: null };
    const transcript = find(e.sessionId);
    if (transcript && tailStopReason(transcript)) stopped++;
  }
  return { waiting, stopped };
}

export function collectClaude({ showEnded, budget, selectedId }) {
  const latest = sessionEntries();
  if (!latest) return [];
  seen = new Set();

  // 읽기 한도가 큰 기록 하나에 다 쓰이지 않도록, 살아 있는 세션의 새 줄부터 읽는다.
  const entries = [...latest.values()].sort((a, b) => Number(b.alive) - Number(a.alive));
  const out = [];
  for (const e of entries) {
    const touched = e.updatedAt ?? e.startedAt ?? 0;
    if (!e.alive && !(showEnded && Date.now() - touched < ENDED_WINDOW_MS)) continue;

    const transcript = findTranscript(e.sessionId);
    const t = transcript ? tracker(trackers, transcript, budget) : null;
    const { members, sub } = transcript ? readMembers(transcript, t, budget) : { members: [], sub: emptySub() };
    const mtime = Math.max(t?.mtimeMs ?? 0, touched);
    const status = statusOf(e, e.alive, mtime);
    const phase = withRunningMembers(phaseOf(status, e, t), status, members);

    out.push({
      tool: 'claude',
      id: e.sessionId,
      pid: e.pid,
      kind: e.kind === 'bg' ? 'background' : e.kind ?? 'interactive',
      name: sessionLabel(e, t),
      customName: givenName(e, t?.customTitle) ?? null,
      home: e.home,
      cwd: e.cwd,
      project: basename(e.cwd ?? ''),
      branch: t?.branch,
      model: t?.model,
      // 실행 방식: 'cli'(사람이 연 것), 'sdk-cli'(다른 프로그램이 띄운 claude -p) 등. 기록에서 읽고, 모르면 null (#286).
      entrypoint: t?.entrypoint ?? e.entrypoint ?? null,
      live: e.alive,
      status,
      // Claude Code 가 상태를 남기지 않아 기록 수정 시각으로 추측한 경우
      statusGuessed: e.alive && !e.waitingFor && !['busy', 'shell', 'idle'].includes(e.status),
      phase,
      // 지금 도는 도구가 시작된 시각(ms) 또는 null. 화면은 1분이 지나야 STATUS 글 뒤에 경과 시간을 붙인다 (draw.mjs toolElapsed).
      toolStartedAt: toolStartOf(status, phase, t),
      // 멈춘 이유 (phase 가 stopped 일 때만). 끝남(done) 알림과 확인 전(●)을 이 동안 막는다 (attention.mjs).
      stopReason: status === 'idle' && stoppedPhase(t) ? t.stopReason : null,
      // 프롬프트 캐시 만료 시각(ms)과 TTL(초). 응답 대기·다음 지시 대기인 살아 있는 세션에만 둔다 (claude-tracker.mjs applyCacheUsage).
      // 오류로 멈춘 세션과 기록을 다 읽기 전의 세션은 빼고, 시간이 지나 만료돼도 그대로 둔다 (화면이 '캐시 만료' 로 보인다).
      ...cacheOf(e.alive, status, t),
      waitingFor: e.waitingFor ?? null,
      waitDetail: status === 'waiting' ? (t?.waitDetail(e.waitingFor) ?? null) : null,
      now: t?.lastTool ?? t?.events.at(-1)?.text ?? '',
      startedAt: e.startedAt,
      updatedAt: mtime,
      ...sessionTotals(t, sub),
      events: t?.events ?? [],
      members: status === 'ended' ? [] : members,
    });
  }
  // 끝난 claude -p 하위 실행은 --all 이 아니어도 읽어 부모 합계에 넣는다 (endedRuns). 부모 비용이 보기 방식과 상관없이 같게 한다.
  const extra = showEnded ? [] : endedRuns(out, budget);
  if (showEnded) out.push(...endedFromTranscripts(new Set(out.map((s) => s.id)), selectedId, budget));
  const shown = attachRuns([...out, ...extra], budget);
  prune();
  // 부모에 붙지 못한 끝난 하위 실행은 기본 보기에 내지 않는다 (예전처럼 --all 에서만 보인다).
  const hidden = new Set(extra);
  return hidden.size ? shown.filter((s) => !hidden.has(s)) : shown;
}

// ---- claude -p(sdk-cli) 실행을 부모 세션 아래로 (#286) ----
// 다른 프로그램이 claude -p 로 띄운 실행은 따로 세션 파일·기록을 만들고, 어디에도 부모 세션 id 를 적지 않는다.
// 그래서 두 가지로 짐작한다.
//   1. 살아 있으면: 그 프로세스의 부모 pid 를 PARENT_DEPTH 단계까지 따라 올라가 다른 Claude 세션 pid 를 만나면 그 세션.
//      (Claude 세션 → bash → claude -p 처럼 쉘을 거쳐 뜬다.) 부모 pid 는 procs.mjs parentPid 가 이미 얻는 정보로만 얻는다.
//   2. 그래도 못 찾았거나 끝난 실행이면: 작업 폴더가 <설정 폴더>/jobs/<id>/ 아래인 경우 id 가 <id> 로 시작하는 세션.
//      Claude Code 백그라운드 작업은 jobs/<자기 세션 id 앞 8자>/tmp 를 작업 폴더로 쓴다.
// 붙은 실행은 서브에이전트처럼 팀원 행이 되고 토큰·비용은 부모 합계에 더한다 (부모가 끝났으면 서브에이전트처럼 행 없이 합계만).
// 날짜별 장부(헤더 오늘·7일)는 기록 파일 단위로 따로 세므로 여기서 옮겨도 두 번 세지 않는다.
// 부모를 못 찾은 sdk-cli 실행(cron 등)은 최상위에 두고 auto 를 켠다. 사람이 답할 수 없는 실행이라 응답 대기로 부르지 않는다 (attention.mjs callsYou).
// sdk-cli 만 대상이다: 사람이 연 Claude Code(cli)나 그 밖의 앱은 사람이 직접 보고 답하는 세션이라 따로 둔다.
export const SDK_ENTRY = 'sdk-cli';
const PARENT_DEPTH = 8;
let ppidOf = parentPid;
export function _setParentPid(fn) {
  const prev = ppidOf;
  ppidOf = fn ?? parentPid;
  return prev;
}

// 작업 폴더가 Claude 백그라운드 작업 폴더(<설정 폴더>/jobs/<id>/…)면 <id>, 아니면 null.
// 설정 폴더 안의 jobs 와, 설정 폴더 위 홈의 .claude/jobs 를 모두 본다 (CLAUDE_CONFIG_DIR 를 바꾼 경우).
export function jobIdOf(cwd, homes = claudeDirs()) {
  if (!cwd) return null;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const c = norm(cwd);
  for (const h of homes) {
    for (const jobs of [join(h, 'jobs'), join(dirname(h), '.claude', 'jobs')]) {
      const j = norm(jobs) + '/';
      if (!c.startsWith(j)) continue;
      const id = c.slice(j.length).split('/')[0];
      // 짧은 조각은 여러 세션에 맞으므로 4자 이상만 쓴다.
      if (id && id.length >= 4) return id.toLowerCase();
    }
  }
  return null;
}

// 실행 중에 부모 pid 로 알아낸 부모 { 실행 id: { parentId, at } }. 끝나면 부모 pid 를 알 길이 없으므로 기억해 두고,
// aitop 을 다시 켜도 쓰게 캐시 폴더의 작은 파일에 남긴다. PARENTS_KEEP_MS(끝난 세션 범위와 같은 24시간)가 지나면 잊는다.
// 파일은 버전 폴더 밖(CACHE_ROOT, summary.json 과 같은 곳)에 두어 캐시 형식이 바뀌어도 남는다 (cache.mjs removeOldDirs 가 건너뛴다).
const PARENTS_KEEP_MS = ENDED_WINDOW_MS;
let parents = null;
const parentsFile = () => join(CACHE_ROOT, PARENTS_FILE);
const fresh = (v, now = Date.now()) => Boolean(v?.parentId) && Number.isFinite(v.at) && now - v.at < PARENTS_KEEP_MS;

function readParentsFile() {
  try {
    return Object.entries(JSON.parse(readFileSync(parentsFile(), 'utf8')) ?? {});
  } catch (e) {
    if (e.code !== 'ENOENT') debugIo('claude', 'sdk parents read failed', e);
    return [];
  }
}

function knownParents() {
  if (parents) return parents;
  parents = new Map(readParentsFile().filter(([, v]) => fresh(v)));
  return parents;
}

function rememberParent(id, parentId) {
  const m = knownParents();
  if (m.get(id)?.parentId === parentId) return;
  m.set(id, { parentId, at: Date.now() });
  // 실시간 화면과 --line 등 여러 aitop 이 같이 쓸 수 있으므로, 쓰기 직전에 파일을 다시 읽어 합친다 (같은 id 는 더 최근 것).
  // 24시간 지난 것만 버린다. 임시 파일 이름에 pid 를 붙여 서로의 임시 파일을 덮지 않고, rename 으로 한 번에 바꾼다.
  const now = Date.now();
  for (const [k, v] of readParentsFile()) if (fresh(v, now) && !(m.get(k)?.at >= v.at)) m.set(k, v);
  for (const [k, v] of m) if (!fresh(v, now)) m.delete(k);
  try {
    mkdirSync(CACHE_ROOT, { recursive: true, mode: 0o700 });
    const f = parentsFile();
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)), { mode: 0o600 });
    renameSync(tmp, f);
  } catch (e) {
    debugIo('claude', 'sdk parents write failed', e);
  }
}

export function _forgetParents() {
  parents = null;
}

// 기본 보기(--all 아님)에서 지금 목록에 있는 세션의 끝난 claude -p 하위 실행. 모든 기록을 훑지 않고 두 곳만 본다:
//   1. 기록 폴더 이름이 -jobs-<목록 세션 id 앞 8자> 를 담은 폴더 (작업 폴더가 jobs/<id>/… 이면 Claude Code 가 그 경로로 폴더 이름을 짓는다).
//   2. 기억된 부모(knownParents)가 목록에 있는 실행의 기록 (findTranscript, 경로는 기억된다).
// 범위는 끝난 세션 목록과 같은 24시간 안에 바뀐 기록이고, 찾은 경로는 DISCOVER_TTL_MS 동안 다시 쓴다.
// 그다음 기록 앞부분(readHead, 수정 시각별로 기억)으로 sdk-cli 인지 확인하고, 본문은 화면 읽기 한도(budget) 안에서 이어 읽어 캐시에 남긴다.
// 부모가 24시간 넘게 살아 있으면 그보다 오래 전에 끝난 하위 실행은 합계에서 빠진다 (README).
let runFiles = { at: 0, key: '', list: [] };

function runCandidates(list) {
  const key = list.map((s) => s.id).sort().join(',');
  if (runFiles.key === key && Date.now() - runFiles.at < DISCOVER_TTL_MS) return runFiles.list;
  const ids = new Set(list.map((s) => s.id));
  const prefixes = new Set(list.map((s) => s.id.slice(0, 8).toLowerCase()));
  const found = [];
  const add = (path, sessionId) => {
    if (ids.has(sessionId)) return;
    try {
      const mtime = statSync(path).mtimeMs;
      if (Date.now() - mtime < ENDED_WINDOW_MS) found.push({ key: sessionId, sessionId, path, mtime });
    } catch {}
  };
  const listing = projectDirs();
  for (const [root, dirs] of listing) {
    for (const dir of dirs ?? []) {
      const job = /-jobs-([0-9a-z]{4,})/i.exec(dir)?.[1]?.toLowerCase();
      if (!job || !prefixes.has(job.slice(0, 8))) continue;
      let names = [];
      try {
        names = readdirSync(join(root, dir));
      } catch (e) {
        debugIo('claude', 'project folder read failed', e, dir);
      }
      for (const n of names) if (n.endsWith('.jsonl')) add(join(root, dir, n), n.slice(0, -'.jsonl'.length));
    }
  }
  for (const [child, v] of knownParents()) {
    if (!ids.has(v.parentId) || found.some((f) => f.sessionId === child)) continue;
    const path = findTranscript(child, listing);
    if (path) add(path, child);
  }
  runFiles = { at: Date.now(), key, list: dedupeBy(found) };
  return runFiles.list;
}

function endedRuns(list, budget) {
  if (!list.some((s) => s.live)) return [];
  const out = [];
  for (const f of runCandidates(list)) {
    const head = readHead(f.path, f.mtime);
    if (head.entrypoint !== SDK_ENTRY) continue;
    out.push(endedSession(f, head, tracker(trackers, f.path, budget), budget));
  }
  return out;
}

function findParent(s, byPid, list) {
  const known = knownParents().get(s.id)?.parentId;
  const remembered = known ? list.find((x) => x.id === known && x !== s) : null;
  if (remembered) return remembered;
  if (s.live && Number.isInteger(s.pid)) {
    let p = ppidOf(s.pid);
    for (let i = 0; i < PARENT_DEPTH && Number.isInteger(p) && p > 1; i++) {
      const hit = byPid.get(p);
      if (hit && hit !== s) {
        rememberParent(s.id, hit.id);
        return hit;
      }
      p = ppidOf(p);
    }
  }
  const job = jobIdOf(s.cwd);
  if (!job) return null;
  const cands = list.filter((x) => x !== s && x.id.toLowerCase().startsWith(job));
  // 살아 있는 쪽, 그다음 최근에 바뀐 쪽.
  cands.sort((a, b) => Number(b.live) - Number(a.live) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return cands[0] ?? null;
}

const TOKEN_KEYS = Object.keys(emptyTokens());

// 붙은 실행의 합계를 부모에 더한다 (sessionTotals 가 서브에이전트를 더하는 것과 같은 칸). 부모 숫자를 아직 모르면(null) 그대로 둔다.
function absorb(root, c) {
  const tk = (root.tokens = { ...root.tokens });
  for (const k of TOKEN_KEYS) tk[k] = (tk[k] ?? 0) + (c.tokens?.[k] ?? 0);
  tk.sub = (tk.sub ?? 0) + (c.tokens?.total ?? 0);
  // 그 실행이 띄운 서브에이전트도 함께 센다 (토큰은 이미 c.tokens 에 들어 있다).
  tk.subCount = (tk.subCount ?? 0) + 1 + (c.tokens?.subCount ?? 0);
  if (root.cost != null && c.cost != null) root.cost += c.cost;
  if (root.costNoCache != null && c.costNoCache != null) root.costNoCache += c.costNoCache;
  root.costUnknown ||= Boolean(c.costUnknown);
  root.loading ||= Boolean(c.loading);
  root.activity = mergeActivity([root.activity, c.activity]);
}

// 팀원 행 모양 (readMembers 와 같은 칸). sdk: true 면 화면이 이름 앞에 -p 를 붙인다.
function runMember(c, parentId) {
  const done = !c.live;
  const started = Boolean(c.model || c.tokens?.total > 0);
  return {
    id: c.id,
    sdk: true,
    entrypoint: c.entrypoint,
    parentId,
    name: 'claude -p',
    model: c.model ?? null,
    task: c.name ?? '',
    status: done ? 'done' : 'busy',
    started,
    phase: done ? { kind: 'done' } : !started ? { kind: 'idle', msg: 'starting' } : c.phase,
    now: c.now,
    tokens: c.tokens?.total ?? 0,
    cost: c.cost,
    costNoCache: c.costNoCache,
    costUnknown: c.costUnknown,
    loading: Boolean(c.loading),
    startedAt: c.startedAt,
    lastActivityAt: c.updatedAt ?? null,
    longStep: false,
  };
}

function attachRuns(list, budget) {
  if (!list.some((s) => s.entrypoint === SDK_ENTRY)) return list;
  const byPid = new Map(list.filter((s) => s.live && Number.isInteger(s.pid)).map((s) => [s.pid, s]));
  const parent = new Map();
  for (const s of list) {
    if (s.entrypoint !== SDK_ENTRY) continue;
    const p = findParent(s, byPid, list);
    if (p) parent.set(s, p);
  }
  // 부모도 붙은 실행이면 맨 위 세션까지 올라간다 (고리는 끊는다).
  const rootOf = (s) => {
    const path = new Set([s]);
    let r = parent.get(s);
    while (r && parent.has(r) && !path.has(r)) {
      path.add(r);
      r = parent.get(r);
    }
    return r && !path.has(r) ? r : null;
  };
  const gone = new Set();
  const now = Date.now();
  for (const s of list) {
    if (!parent.has(s)) continue;
    const root = rootOf(s);
    // 살아 있는 실행은 끝난 부모 아래로 숨기지 않는다.
    if (!root || (s.live && !root.live)) continue;
    let c = s;
    // 부모 숫자는 읽었는데 끝난 실행은 아직 안 읽었으면 마저 읽어 합계가 덜 차지 않게 한다 (선택해서 읽을 길이 없어진다).
    const src = endedSrc.get(s);
    if (s.lazy && !root.lazy && src) c = endedSession(src, heads.get(src.path) ?? readHead(src.path, src.mtime), tracker(trackers, src.path, budget), budget);
    absorb(root, c);
    gone.add(s);
    const m = runMember(c, root.id);
    if (root.status !== 'ended' && !(m.status === 'done' && now - (c.updatedAt ?? 0) > MEMBER_FADE_MS)) {
      root.members = [...root.members, m].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    }
  }
  for (const s of list) if (s.entrypoint === SDK_ENTRY && !gone.has(s)) s.auto = true;
  return gone.size ? list.filter((s) => !gone.has(s)) : list;
}
