// Claude Code: ~/.claude/sessions/<pid>.json 으로 살아 있는 세션을 찾고,
// ~/.claude/projects/*/<sessionId>.jsonl 대화 기록에서 진행 단계·토큰·비용을 읽는다.
import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { loadCache } from '../cache.mjs';
import { contextWindow } from '../pricing.mjs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { isAlive } from '../procs.mjs';
import { ClaudeTracker } from './claude-tracker.mjs';
import { emptyTokens, mergeActivity, MEMBER_FADE_MS } from './common.mjs';
import { mergeFiles } from './files.mjs';
import { debug, debugIo } from '../log.mjs';

const HOME = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const SESSIONS = join(HOME, 'sessions');
const PROJECTS = join(HOME, 'projects');
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
  } catch (e) {
    debugIo('claude', 'projects read failed', e);
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
function emptySub() {
  return { count: 0, tokens: emptyTokens(), cost: 0, costNoCache: 0, costUnknown: false, loading: false, files: [], activity: [] };
}

// 메인 tracker 와 서브에이전트 합계를 화면에 보일 세션 숫자로 합친다. 기록을 아직 읽지 않았으면(t 없음) 비용은 null.
function sessionTotals(t, sub) {
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

function readMembers(transcript, parent, budget) {
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  const sub = emptySub();
  if (!existsSync(dir)) return { members: [], sub };
  const members = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta.json')) continue;
    const id = f.slice('agent-'.length, -'.meta.json'.length);
    const meta = readJson(join(dir, f)) ?? {};
    const t = tracker(subTrackers, join(dir, `agent-${id}.jsonl`), budget);
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
      startedAt: t.events[0]?.at,
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
function withRunningMembers(phase, status, members) {
  if (status !== 'waiting') return phase;
  const running = members.filter((m) => m.status !== 'done' && m.phase?.kind !== 'done').length;
  return running ? { ...phase, args: { ...phase.args, agents: running } } : phase;
}

function phaseOf(status, entry, t) {
  switch (status) {
    case 'ended':
      return { kind: 'ended' };
    case 'waiting':
      return entry.waitingFor ? { kind: 'waiting', args: { what: entry.waitingFor } } : { kind: 'waiting' };
    case 'shell':
      return { kind: 'tool', msg: 'shell' };
    case 'idle':
      return { kind: 'idle' };
    default:
      return loadingPhase(t) ?? (t ? t.phase() : { kind: 'think', msg: 'working' });
  }
}

// sessions/<pid>.json 은 세션이 끝나면 지워지므로, 끝난 세션은 최근에 바뀐 기록 파일로 찾는다.
// 폴더를 매번 훑지 않게 목록은 잠깐 재사용하고, 기록 앞부분에서 이름·폴더만 읽어 둔다.
const DISCOVER_TTL_MS = 10_000;
const HEAD_BYTES = 256 * 1024;
let discovered = { at: 0, list: [] };
const heads = new Map();

function recentTranscripts() {
  if (Date.now() - discovered.at < DISCOVER_TTL_MS) return discovered.list;
  const list = [];
  let dirs = [];
  try {
    dirs = readdirSync(PROJECTS);
  } catch (e) {
    debugIo('claude', 'projects read failed', e);
  }
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(join(PROJECTS, dir));
    } catch (e) {
      debugIo('claude', 'project folder read failed', e, dir);
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const path = join(PROJECTS, dir, n);
      try {
        const mtime = statSync(path).mtimeMs;
        if (Date.now() - mtime < ENDED_WINDOW_MS) list.push({ sessionId: n.slice(0, -'.jsonl'.length), path, mtime });
      } catch {}
    }
  }
  discovered = { at: Date.now(), list };
  return list;
}

// 기록이 바뀌었으면(mtime) 앞부분을 다시 읽어 뒤늦게 붙은 제목도 반영한다.
function readHead(path, mtime) {
  const cached = heads.get(path);
  if (cached && cached.mtime === mtime) return cached;
  const head = { mtime, cwd: null, title: null, branch: null, startedAt: null };
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
      if (x.timestamp) head.startedAt ??= Date.parse(x.timestamp) || null;
      if (x.type === 'ai-title' && x.aiTitle) head.title = x.aiTitle;
    }
  } catch (e) {
    debugIo('claude', 'transcript head read failed', e, path);
  }
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
    const t = want ? tracker(trackers, f.path, budget) : null;
    const { sub } = t ? readMembers(f.path, t, budget) : { sub: emptySub() };
    out.push({
      tool: 'claude',
      id: f.sessionId,
      pid: null,
      kind: '-',
      name: t?.title ?? head.title ?? `${basename(head.cwd ?? '')} · ${f.sessionId.slice(0, 8)}`,
      cwd: head.cwd,
      project: basename(head.cwd ?? ''),
      branch: t?.branch ?? head.branch,
      model: t?.model ?? null,
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
    });
  }
  return out;
}

// ~/.claude/sessions/*.json 을 세션 id 마다 하나로 (살아 있는 쪽, 그다음 최근에 바뀐 쪽). 폴더를 읽지 못하면 null.
function sessionEntries() {
  let files;
  try {
    files = readdirSync(SESSIONS).filter((n) => n.endsWith('.json'));
  } catch (e) {
    debugIo('claude', 'sessions read failed', e);
    return null;
  }
  const latest = new Map();
  for (const f of files) {
    const e = readJson(join(SESSIONS, f));
    if (!e?.sessionId) continue;
    e.alive = isAlive(e.pid);
    const prev = latest.get(e.sessionId);
    if (!prev || (e.alive && !prev.alive) || (e.updatedAt ?? e.startedAt) > (prev.updatedAt ?? prev.startedAt)) latest.set(e.sessionId, e);
  }
  return latest;
}

// 응답 대기 중인 Claude 세션 수. 세션 파일과 pid 만 보므로 대화 기록·프로세스 목록을 읽지 않는다 (aitop --line 용).
export function claudeWaitingCount() {
  let n = 0;
  for (const e of sessionEntries()?.values() ?? []) if (e.alive && e.waitingFor) n++;
  return n;
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
    const autoName = !e.name || e.name === e.sessionId.slice(0, 8);

    out.push({
      tool: 'claude',
      id: e.sessionId,
      pid: e.pid,
      kind: e.kind === 'bg' ? 'background' : e.kind ?? 'interactive',
      name: (autoName ? t?.title : e.name) ?? `${basename(e.cwd ?? '')} · ${e.sessionId.slice(0, 8)}`,
      cwd: e.cwd,
      project: basename(e.cwd ?? ''),
      branch: t?.branch,
      model: t?.model,
      live: e.alive,
      status,
      // Claude Code 가 상태를 남기지 않아 기록 수정 시각으로 추측한 경우
      statusGuessed: e.alive && !e.waitingFor && !['busy', 'shell', 'idle'].includes(e.status),
      phase: withRunningMembers(phaseOf(status, e, t), status, members),
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
  if (showEnded) out.push(...endedFromTranscripts(new Set(out.map((s) => s.id)), selectedId, budget));
  prune();
  return out;
}
