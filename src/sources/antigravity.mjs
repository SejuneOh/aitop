// Antigravity CLI (agy): ~/.gemini/antigravity-cli 의 SQLite 기록을 읽기 전용으로 읽는다.
// - conversation_summaries.db: 대화마다 제목, 작업 폴더, 실행 상태, 부모 대화(서브에이전트)
// - conversations/<id>.db 의 gen_metadata: 모델 호출 한 번에 한 줄. protobuf 안에 모델 이름과 토큰 사용량이 있다.
// 실행 중인 agy 와 대화는 /proc/<pid>/fd 에 열린 presence/<id>.lock 으로 짝짓는다. /proc 이 없으면 작업 폴더로 짝짓는다.
// 세션은 Gemini 탭에 보인다 (agy 는 Gemini CLI 의 후속 도구다).
import { statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openReadOnly, loadSqlite } from '../sqlite.mjs';
import { findProcesses, isAgy, openFiles } from '../procs.mjs';
import { emptyTokens } from './common.mjs';
import { contextWindow } from '../pricing.mjs';

export const AGY_ROOT = process.env.AITOP_AGY_HOME ?? join(homedir(), '.gemini', 'antigravity-cli');

const RECENT_MS = 24 * 3600 * 1000;
const BATCH = 32;
const RUNNING = 'CASCADE_RUN_STATUS_RUNNING';

// ---- protobuf: 필요한 필드만 꺼내는 최소 해석기 ----

function varint(b, i) {
  let x = 0;
  let s = 1;
  for (;;) {
    if (i >= b.length) throw new Error('truncated');
    const c = b[i++];
    x += (c & 127) * s;
    s *= 128;
    if (c < 128) return [x, i];
  }
}

// 메시지의 맨 위 필드를 [번호, 값] 목록으로. 정수는 number, 길이 있는 값은 Buffer 조각이다.
export function pbFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = varint(buf, i);
    const f = Math.floor(key / 8);
    const w = key % 8;
    if (w === 0) {
      let v;
      [v, i] = varint(buf, i);
      out.push([f, v]);
    } else if (w === 2) {
      let n;
      [n, i] = varint(buf, i);
      if (i + n > buf.length) throw new Error('truncated');
      out.push([f, buf.subarray(i, i + n)]);
      i += n;
    } else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else throw new Error(`wire type ${w}`);
  }
  return out;
}

const msg = (fields, n) => fields.find(([f, v]) => f === n && Buffer.isBuffer(v))?.[1] ?? null;
const int = (fields, n) => fields.find(([f, v]) => f === n && typeof v === 'number')?.[1] ?? 0;

// gen_metadata 한 줄 → { model, usage }. 필드 번호는 기록에서 확인한 값이다:
// 1 → 19 모델 이름, 1 → 17 → 2 사용량 (2 입력, 3 출력, 4 캐시 쓰기, 5 캐시 읽기). 출력(3) 은 생각(9) + 답변(10) 이다.
// 입력(2) 에는 캐시 읽기가 들어 있지 않다.
export function readGeneration(data) {
  try {
    const gen = msg(pbFields(Buffer.from(data)), 1);
    if (!gen) return null;
    const f = pbFields(gen);
    const model = msg(f, 19)?.toString('utf8') || null;
    const stats = msg(f, 17);
    const usage = stats && msg(pbFields(stats), 2);
    if (!usage) return { model, usage: null };
    const u = pbFields(usage);
    return { model, usage: { input: int(u, 2), output: int(u, 3), cacheWrite: int(u, 4), cacheRead: int(u, 5) } };
  } catch {
    return null;
  }
}

// ---- 대화별 토큰 합계 (gen_metadata 를 새 줄만 이어 읽는다) ----

const usages = new Map();

const fresh = () => ({ sig: null, idx: -1, tokens: emptyTokens(), model: null, prompt: 0 });

// SQLite 파일 머리 24번째 바이트의 변경 카운터. 쓰기마다 1 씩 늘어서, 수정 시각·크기가 그대로인 쓰기도 알아챈다.
function changeCounter(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const b = Buffer.alloc(4);
    return readSync(fd, b, 0, 4, 24) === 4 ? b.readUInt32BE(0) : '';
  } catch {
    return '';
  } finally {
    if (fd != null) closeSync(fd);
  }
}

// 파일 서명. 커널의 수정 시각은 몇 ms 단위로 거칠고 WAL 모드에서는 변경 카운터가 늘지 않아,
// 다시 읽을지는 -wal 의 상태까지 함께 본다 (agy 가 쓰면 -wal 이 생기거나 바뀌고, 합치면 지워지거나 비워진다).
// 읽은 결과를 버릴지는 본 파일만 본다 (immutable 은 본 파일만 읽는다).
export function sigOf(path, withWal = true) {
  let main;
  try {
    const st = statSync(path);
    main = `${changeCounter(path)};${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  if (!withWal) return main;
  try {
    const w = statSync(`${path}-wal`);
    return `${main};${w.mtimeMs}:${w.size}`;
  } catch {
    return `${main};-`;
  }
}

const outOf = (budget) => budget.left <= 0 || (budget.read > 0 && Date.now() >= (budget.deadline ?? Infinity));

export function readUsage(id, budget) {
  let g = usages.get(id);
  if (!g) usages.set(id, (g = fresh()));
  const path = join(AGY_ROOT, 'conversations', `${id}.db`);
  const sig = sigOf(path);
  if (sig === null || sig === g.sig) return g;
  const mainSig = sigOf(path, false);
  if (outOf(budget)) {
    budget.exhausted = true;
    return g;
  }
  // 복사본에 더하고, 끝까지 탈 없이 읽었을 때만 반영한다.
  const n = { ...g, tokens: { ...g.tokens } };
  let db;
  let ok = false;
  try {
    db = openReadOnly(path);
    if (!db) return g;
    const last = db.prepare('select max(idx) m from gen_metadata').get()?.m ?? -1;
    // 마지막 줄 번호가 줄었으면 기록이 새로 쓰인 것이니 처음부터 다시 더한다.
    if (last < n.idx) Object.assign(n, fresh());
    const q = db.prepare('select idx, data from gen_metadata where idx > ? order by idx limit ?');
    for (;;) {
      const rows = q.all(n.idx, BATCH);
      for (const r of rows) {
        n.idx = r.idx;
        const size = r.data?.length ?? 0;
        budget.left -= size;
        budget.read = (budget.read ?? 0) + size;
        const x = readGeneration(r.data);
        if (x?.model) n.model = x.model;
        const u = x?.usage;
        if (!u) continue;
        const t = n.tokens;
        t.input += u.input;
        t.output += u.output;
        t.cacheRead += u.cacheRead;
        t.cacheWrite += u.cacheWrite;
        t.total += u.input + u.output + u.cacheRead + u.cacheWrite;
        n.prompt = u.input + u.cacheRead + u.cacheWrite;
      }
      if (rows.length < BATCH) {
        n.sig = sig;
        break;
      }
      if (outOf(budget)) {
        budget.exhausted = true;
        break;
      }
    }
    // 읽는 동안 agy 가 본 파일에 썼으면 읽은 내용을 믿을 수 없으니 버리고 다음 갱신에 다시 읽는다.
    ok = sigOf(path, false) === mainSig;
  } catch {
    // agy 가 쓰는 중이라 잠겨 있으면 다음 갱신에 다시 읽는다.
  } finally {
    db?.close();
  }
  if (ok) Object.assign(g, n);
  return g;
}

// ---- 대화 목록 ----

// '2026-11-06 02:19:18.516555503+00:00' 형식. 값이 없으면 0001-01-01 이 들어 있는데, Date.parse 는 이것을 2001 년으로 읽으므로 연도를 먼저 본다.
export function parseTime(s) {
  if (!(Number(String(s ?? '').slice(0, 4)) >= 2000)) return null;
  return Date.parse(s) || null;
}

export function cwdOf(workspaceUris) {
  try {
    const first = JSON.parse(workspaceUris || '[]')[0];
    if (!first) return null;
    return first.startsWith('file:') ? fileURLToPath(first) : first;
  } catch {
    return null;
  }
}

// 읽는 동안 agy 가 쓰면 결과를 버리고 지난번 목록을 쓴다 (한 번 갱신 동안 세션이 사라져 보이지 않게).
let summaries = { sig: null, rows: [] };

function readSummaries() {
  const path = join(AGY_ROOT, 'conversation_summaries.db');
  const sig = sigOf(path);
  if (sig === null) return [];
  if (sig === summaries.sig) return summaries.rows;
  const mainSig = sigOf(path, false);
  let db;
  try {
    db = openReadOnly(path);
    if (!db) return [];
    const rows = db
      .prepare(
        `select conversation_id id, title, step_count steps, last_modified_time modified, workspace_uris ws, status,
                agent_name agent, parent_conversation_id parent, not_fully_idle busy, killed
           from conversation_summaries order by last_modified_time desc limit 500`,
      )
      .all()
      .map((r) => ({ ...r, cwd: cwdOf(r.ws), updatedAt: parseTime(r.modified), running: r.status === RUNNING || Boolean(r.busy) }));
    if (sigOf(path, false) === mainSig) summaries = { sig, rows };
  } catch {
    // 다음 갱신에 다시 읽는다.
  } finally {
    db?.close();
  }
  return summaries.rows;
}

// 열린 파일 경로에서 대화 id 를 꺼낸다 (presence/<id>.lock, conversations/<id>.db[-wal|-shm]).
export function idFromPath(p, root = AGY_ROOT) {
  if (!p.startsWith(root + '/')) return null;
  const m = /^(?:presence\/([\w-]+)\.lock|conversations\/([\w-]+)\.db(?:-wal|-shm)?)(?: \(deleted\))?$/.exec(p.slice(root.length + 1));
  return m ? m[1] ?? m[2] : null;
}

const rootOf = (id, byId) => {
  let cur = byId.get(id);
  for (let i = 0; cur?.parent && byId.has(cur.parent) && i < 10; i++) cur = byId.get(cur.parent);
  return cur?.id ?? id;
};

// 실행 중인 agy 프로세스와 최상위 대화를 짝짓는다. 짝을 못 찾은 프로세스는 따로 돌려준다.
export function matchLive(procs, rows, filesOf = openFiles) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const live = new Map();
  const loose = [];
  for (const p of procs) {
    const files = filesOf(p.pid);
    const ids = (files ?? []).map((f) => idFromPath(f)).filter((id) => id && byId.has(id));
    if (ids.length) {
      for (const id of ids) {
        const root = rootOf(id, byId);
        if (!live.has(root)) live.set(root, p.pid);
      }
      continue;
    }
    // /proc 이 없으면 같은 작업 폴더에서 가장 최근에 바뀐 대화를 고른다.
    const guess = files === null ? rows.find((r) => !r.parent && r.cwd === p.cwd && !live.has(r.id)) : null;
    if (guess) live.set(guess.id, p.pid);
    else loose.push(p);
  }
  return { live, loose };
}

function member(r, budget) {
  const g = readUsage(r.id, budget);
  return {
    id: r.id,
    name: r.agent || 'agent',
    model: g.model,
    task: r.title ?? '',
    status: r.running ? 'busy' : 'done',
    started: g.tokens.total > 0,
    phase: r.running ? { kind: 'think', text: `작업 중 · ${r.steps}단계` } : { kind: 'done', text: '완료' },
    now: '',
    tokens: g.tokens.total,
    cost: null,
    costNoCache: null,
    costUnknown: g.tokens.total > 0,
    // 기록에 시작 시각이 없어 마지막으로 바뀐 시각을 둔다 (정렬용).
    updatedAt: r.updatedAt,
  };
}

function phaseOf(live, r, runningMembers) {
  if (!live) return { kind: 'ended', text: '종료' };
  if (!r.running) return { kind: 'idle', text: '다음 지시 대기' };
  const extra = runningMembers ? ` · 에이전트 ${runningMembers}개 실행 중` : '';
  return { kind: 'think', text: `작업 중 · ${r.steps}단계${extra}` };
}

function placeholder(p, text) {
  return {
    tool: 'gemini',
    id: `agy-${p.pid}`,
    pid: p.pid,
    kind: 'interactive',
    name: basename(p.cwd ?? '') || 'agy',
    cwd: p.cwd,
    project: basename(p.cwd ?? ''),
    model: null,
    live: true,
    status: 'idle',
    phase: { kind: 'idle', text },
    cost: null,
    now: '',
    updatedAt: Date.now(),
    tokens: emptyTokens(),
    context: { used: 0, window: 0 },
    events: [],
    members: [],
  };
}

export function collectAgy({ showEnded, budget }) {
  const procs = findProcesses(isAgy);
  // 기록 폴더가 없으면 agy 를 실행한 적이 없는 것이다 (테스트에서 AITOP_AGY_HOME 으로 실제 기록과 떼어 놓을 때도 쓴다).
  if (!existsSync(AGY_ROOT) || (!procs.length && !showEnded)) return [];
  if (!loadSqlite()) return procs.map((p) => placeholder(p, '실행 중 (세부 정보는 Node 22.13 이상)'));

  const rows = readSummaries();
  const { live, loose } = matchLive(procs, rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map();
  for (const r of rows) if (r.parent) {
    const root = rootOf(r.id, byId);
    children.set(root, [...(children.get(root) ?? []), r]);
  }

  const out = [];
  // 살아 있는 대화부터 읽어 읽기 한도가 오래된 기록에 먼저 쓰이지 않게 한다.
  const tops = rows.filter((r) => !r.parent && (live.has(r.id) || (showEnded && Date.now() - (r.updatedAt ?? 0) < RECENT_MS)));
  tops.sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)));
  for (const r of tops) {
    const isLive = live.has(r.id);
    const g = readUsage(r.id, budget);
    const kids = children.get(r.id) ?? [];
    const members = kids.map((c) => member(c, budget)).sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    // 메인과 서브에이전트를 항목별로 더한다 (Claude 세션과 같은 방식).
    const tokens = { ...g.tokens, main: g.tokens.total, sub: 0, subCount: kids.length };
    for (const c of kids) {
      const t = readUsage(c.id, budget).tokens;
      for (const k of Object.keys(emptyTokens())) tokens[k] += t[k];
      tokens.sub += t.total;
    }
    const running = members.filter((m) => m.status === 'busy').length;
    out.push({
      tool: 'gemini',
      id: r.id,
      pid: live.get(r.id) ?? null,
      kind: 'interactive',
      name: r.title || basename(r.cwd ?? '') || 'agy',
      cwd: r.cwd,
      project: basename(r.cwd ?? ''),
      branch: null,
      model: g.model,
      live: isLive,
      status: !isLive ? 'ended' : r.running ? 'busy' : 'idle',
      phase: phaseOf(isLive, r, running),
      cost: null,
      costNoCache: null,
      costUnknown: tokens.total > 0,
      waitingFor: null,
      now: '',
      startedAt: null,
      updatedAt: r.updatedAt ?? Date.now(),
      tokens,
      context: { used: g.prompt, window: contextWindow(g.model, g.prompt) },
      events: [],
      files: [],
      turns: [],
      members: isLive ? members : [],
    });
  }
  for (const p of loose) out.push(placeholder(p, '첫 입력 대기'));

  const keep = new Set(rows.map((r) => r.id));
  for (const id of usages.keys()) if (!keep.has(id)) usages.delete(id);
  return out;
}
