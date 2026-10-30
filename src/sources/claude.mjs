// Claude Code: ~/.claude/sessions/<pid>.json 으로 살아 있는 세션을 찾고,
// ~/.claude/projects/*/<sessionId>.jsonl 대화 기록에서 진행 단계·토큰·비용을 읽는다.
import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { loadCache } from '../cache.mjs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { isAlive } from '../procs.mjs';
import { ClaudeTracker } from './claude-tracker.mjs';
import { emptyTokens } from './common.mjs';

const HOME = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const SESSIONS = join(HOME, 'sessions');
const PROJECTS = join(HOME, 'projects');
const ENDED_WINDOW_MS = 24 * 3600 * 1000;
// 끝난 팀원은 이 시간 동안 "완료"로 보였다가 목록에서 사라진다.
const MEMBER_FADE_MS = 6000;
// finished 표시 없이 중간에 끊긴 팀원 기록이 남기 때문에, 이 시간 넘게 기록이 없으면 실행 중으로 보지 않는다.
const MEMBER_STALE_MS = 15 * 60_000;

const trackers = new Map();
const subTrackers = new Map();
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

function loadingPhase(t) {
  return t?.loading != null ? { kind: 'think', text: `기록 읽는 중 ${Math.floor(t.loading * 100)}%` } : null;
}

// 서브에이전트 전체(끝난 것 포함)의 토큰·비용 합계. 메인 세션 합계에 더해 화면에 보인다.
function emptySub() {
  return { count: 0, tokens: emptyTokens(), cost: 0, costNoCache: 0, costUnknown: false };
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
    const age = Date.now() - t.mtimeMs;
    const awaited = Boolean(meta.toolUseId && parent?.pending.has(meta.toolUseId));
    const running = !meta.finished && !meta.stoppedByUser && (awaited || age < MEMBER_STALE_MS);
    const finished = !running;
    if (finished && age > MEMBER_FADE_MS) continue;
    members.push({
      id,
      name: meta.agentType ?? 'agent',
      model: t.model,
      task: meta.description ?? '',
      status: finished ? 'done' : 'busy',
      phase: finished ? { kind: 'done', text: '완료' } : loadingPhase(t) ?? t.phase(),
      now: t.lastTool,
      tokens: t.tokens.total,
      cost: t.cost,
      costUnknown: t.costUnknown,
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

function phaseOf(status, entry, t) {
  switch (status) {
    case 'ended':
      return { kind: 'ended', text: '종료' };
    case 'waiting':
      return { kind: 'waiting', text: entry.waitingFor ? `응답 대기 · ${entry.waitingFor}` : '응답 대기' };
    case 'shell':
      return { kind: 'tool', text: '쉘 명령 실행 중' };
    case 'idle':
      return { kind: 'idle', text: '다음 지시 대기' };
    default:
      return loadingPhase(t) ?? (t ? t.phase() : { kind: 'think', text: '작업 중' });
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
  } catch {}
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(join(PROJECTS, dir));
    } catch {
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

function readHead(path) {
  if (heads.has(path)) return heads.get(path);
  const head = { cwd: null, title: null, branch: null, startedAt: null };
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
      } catch {
        continue;
      }
      head.cwd ??= x.cwd ?? null;
      head.branch ??= x.gitBranch ?? null;
      if (x.timestamp) head.startedAt ??= Date.parse(x.timestamp) || null;
      if (x.type === 'ai-title' && x.aiTitle) head.title = x.aiTitle;
    }
  } catch {}
  heads.set(path, head);
  return head;
}

// 끝난 세션의 기록 본문은 선택했을 때(또는 이미 캐시가 있을 때)만 읽는다.
function endedFromTranscripts(known, selectedId, budget) {
  const out = [];
  for (const f of recentTranscripts()) {
    if (known.has(f.sessionId)) continue;
    const head = readHead(f.path);
    const t = f.sessionId === selectedId || trackers.has(f.path) || loadCache(f.path) ? tracker(trackers, f.path, budget) : null;
    const { members, sub } = t && f.sessionId === selectedId ? readMembers(f.path, t, budget) : { members: [], sub: emptySub() };
    const main = t?.tokens ?? emptyTokens();
    const tokens = { main: main.total, sub: sub.tokens.total, subCount: sub.count };
    for (const k of Object.keys(main)) tokens[k] = main[k] + sub.tokens[k];
    out.push({
      tool: 'claude',
      id: f.sessionId,
      attachId: null,
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
      phase: loadingPhase(t) ?? { kind: 'ended', text: '종료' },
      waitingFor: null,
      now: '',
      startedAt: head.startedAt,
      updatedAt: f.mtime,
      tokens,
      cost: t ? t.cost + sub.cost : null,
      costNoCache: t ? t.costNoCache + sub.costNoCache : null,
      costUnknown: Boolean(t?.costUnknown || sub.costUnknown),
      context: { used: t?.context ?? 0, window: (t?.context ?? 0) > 200_000 ? 1_000_000 : 200_000 },
      events: t?.events ?? [],
      members: [],
    });
  }
  return out;
}

export function collectClaude({ showEnded, budget, selectedId }) {
  let files;
  try {
    files = readdirSync(SESSIONS).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  seen = new Set();
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

    const transcript = findTranscript(e.sessionId);
    const t = transcript ? tracker(trackers, transcript, budget) : null;
    const { members, sub } = transcript ? readMembers(transcript, t, budget) : { members: [], sub: emptySub() };
    const mtime = Math.max(t?.mtimeMs ?? 0, touched);
    const status = statusOf(e, e.alive, mtime);
    const autoName = !e.name || e.name === e.sessionId.slice(0, 8);
    const main = t?.tokens ?? emptyTokens();
    const tokens = { main: main.total, sub: sub.tokens.total, subCount: sub.count };
    for (const k of Object.keys(main)) tokens[k] = main[k] + sub.tokens[k];

    out.push({
      tool: 'claude',
      id: e.sessionId,
      attachId: e.kind === 'bg' && e.alive ? e.sessionId.slice(0, 8) : null,
      pid: e.pid,
      kind: e.kind === 'bg' ? 'background' : e.kind ?? 'interactive',
      name: (autoName ? t?.title : e.name) ?? `${basename(e.cwd ?? '')} · ${e.sessionId.slice(0, 8)}`,
      cwd: e.cwd,
      project: basename(e.cwd ?? ''),
      branch: t?.branch,
      model: t?.model,
      live: e.alive,
      status,
      phase: phaseOf(status, e, t),
      waitingFor: e.waitingFor ?? null,
      now: t?.lastTool ?? t?.events.at(-1)?.text ?? '',
      startedAt: e.startedAt,
      updatedAt: mtime,
      tokens,
      cost: (t?.cost ?? 0) + sub.cost,
      costNoCache: (t?.costNoCache ?? 0) + sub.costNoCache,
      costUnknown: Boolean(t?.costUnknown || sub.costUnknown),
      context: { used: t?.context ?? 0, window: (t?.context ?? 0) > 200_000 ? 1_000_000 : 200_000 },
      events: t?.events ?? [],
      members: status === 'ended' ? [] : members,
    });
  }
  if (showEnded) out.push(...endedFromTranscripts(new Set(out.map((s) => s.id)), selectedId, budget));
  prune();
  return out;
}
