// Claude Code: ~/.claude/sessions/<pid>.json 으로 살아 있는 세션을 찾고,
// ~/.claude/projects/*/<sessionId>.jsonl 대화 기록에서 진행 단계·토큰·비용을 읽는다.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { isAlive } from '../procs.mjs';
import { ClaudeTracker } from './claude-tracker.mjs';

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

function tracker(map, path) {
  let t = map.get(path);
  if (!t) map.set(path, (t = new ClaudeTracker(path)));
  t.update();
  return t;
}

function readMembers(transcript, parent) {
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return { members: [], subTokens: 0, subCost: 0 };
  const members = [];
  let subTokens = 0;
  let subCost = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.meta.json')) continue;
    const id = f.slice('agent-'.length, -'.meta.json'.length);
    const meta = readJson(join(dir, f)) ?? {};
    const t = tracker(subTrackers, join(dir, `agent-${id}.jsonl`));
    subTokens += t.tokens.total;
    subCost += t.cost;
    const age = Date.now() - t.mtimeMs;
    const awaited = Boolean(meta.toolUseId && parent?.pending.has(meta.toolUseId));
    const running = !meta.finished && !meta.stoppedByUser && (awaited || age < MEMBER_STALE_MS);
    const finished = !running;
    if (finished && age > MEMBER_FADE_MS) continue;
    members.push({
      id,
      name: meta.agentType ?? 'agent',
      task: meta.description ?? '',
      status: finished ? 'done' : 'busy',
      phase: finished ? { kind: 'done', text: '완료' } : t.phase(),
      now: t.lastTool,
      tokens: t.tokens.total,
      cost: t.cost,
      startedAt: t.events[0]?.at,
    });
  }
  members.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return { members, subTokens, subCost };
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
      return t ? t.phase() : { kind: 'think', text: '작업 중' };
  }
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

    const transcript = findTranscript(e.sessionId);
    const t = transcript ? tracker(trackers, transcript) : null;
    const { members, subTokens, subCost } = transcript ? readMembers(transcript, t) : { members: [], subTokens: 0, subCost: 0 };
    const mtime = Math.max(t?.mtimeMs ?? 0, touched);
    const status = statusOf(e, e.alive, mtime);
    const autoName = !e.name || e.name === e.sessionId.slice(0, 8);
    const tokens = t?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

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
      tokens: { ...tokens, total: tokens.total + subTokens, sub: subTokens },
      cost: (t?.cost ?? 0) + subCost,
      context: { used: t?.context ?? 0, window: (t?.context ?? 0) > 200_000 ? 1_000_000 : 200_000 },
      events: t?.events ?? [],
      members: status === 'ended' ? [] : members,
    });
  }
  return out;
}
