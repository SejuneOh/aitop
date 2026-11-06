// Antigravity CLI (agy): ~/.gemini/antigravity-cli 의 SQLite 기록을 읽기 전용으로 읽는다.
// - conversation_summaries.db: 대화마다 제목, 작업 폴더, 실행 상태, 부모 대화(서브에이전트)
// - conversations/<id>.db 의 gen_metadata: 모델 호출 한 번에 한 줄. protobuf 안에 모델 이름과 토큰 사용량이 있다.
// 실행 중인 agy 와 대화는 /proc/<pid>/fd 에 열린 presence/<id>.lock 으로 짝짓는다. /proc 이 없으면 작업 폴더로 짝짓는다.
// 세션은 Gemini 탭에 보인다 (agy 는 Gemini CLI 의 후속 도구다).
import { statSync, openSync, readSync, closeSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openReadOnly, loadSqlite } from '../sqlite.mjs';
import { findProcesses, isAgy, openFiles } from '../procs.mjs';
import { emptyTokens, pushEvent, describeTool, isNoisePrompt } from './common.mjs';
import { contextWindow } from '../pricing.mjs';

// /proc/<pid>/fd 의 링크는 늘 심볼릭 링크를 푼 절대 경로라서, 기록 폴더도 같은 모양으로 바꿔 둔다
// (끝의 /, 상대 경로, 심볼릭 링크로 걸린 ~/.gemini). 폴더가 없으면 절대 경로까지만 바꾼다.
export function agyRoot(dir) {
  const abs = resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export const AGY_ROOT = agyRoot(process.env.AITOP_AGY_HOME ?? join(homedir(), '.gemini', 'antigravity-cli'));

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

// ---- 진행 기록: steps 한 줄이 단계 하나다 ----

// step_payload 의 필드 번호는 기록에서 확인한 값이다: 1 단계 종류, 5 메타 (1 만든 시각 {1 초, 2 나노초},
// 4 도구 호출 {1 호출 id, 2 이름, 3 인자 JSON}), 19 → 2 사용자 입력, 20 → 1 답변 글, 20 → 7 답변이 낸 도구 호출 (5 → 4 와 같은 모양).
export const STEP = { PROMPT: 14, REPLY: 15, TOOL: 132 };
// steps.status: 1 대기, 2 실행 중, 8 답변 생성 중, 9 사용자 허락 대기, 3 끝. 3 이 아닌 넷은 아직 바뀌는 중이다.
// 9 는 도구 호출이 사용자의 허락을 기다리는 동안이다 (MCP 호출, run_command 에서 보았다). 허락하면 2 로 바뀐다.
const OPEN = new Set([1, 2, 8, 9]);
const APPROVAL = 9;
const MAX_TURNS = 50;
const EMPTY = Buffer.alloc(0);

// 도구 호출을 한 줄로. agy 도구 인자는 PascalCase 다 (read_file {Path}, run_command {CommandLine}, call_mcp_tool {ServerName, ToolName}).
export function describeAgyTool(name, args = {}) {
  if (name === 'call_mcp_tool') return describeTool(`mcp ${args.ServerName ?? ''}/${args.ToolName ?? ''}`, {});
  if (name === 'run_command') return describeTool('Bash', { command: args.CommandLine ?? '' });
  const path = args.Path ?? args.AbsolutePath ?? args.TargetFile;
  if (typeof path === 'string') return describeTool(`${name} ${basename(path)}`, {});
  return describeTool(name, args);
}

function toolOf(call) {
  if (!call) return null;
  const f = pbFields(call);
  const name = msg(f, 2)?.toString('utf8');
  if (!name) return null;
  let args = {};
  try {
    args = JSON.parse(msg(f, 3)?.toString('utf8') ?? '{}');
  } catch {}
  return { name, what: describeAgyTool(name, args && typeof args === 'object' ? args : {}) };
}

// step_payload 한 줄 → { type, at, text, tool }. 해석하지 못하면 null.
export function readStep(data) {
  try {
    const f = pbFields(Buffer.from(data ?? EMPTY));
    const type = int(f, 1);
    if (!type) return null;
    const meta = pbFields(msg(f, 5) ?? EMPTY);
    const t = msg(meta, 1) && pbFields(msg(meta, 1));
    const step = { type, at: t ? int(t, 1) * 1000 + Math.floor(int(t, 2) / 1e6) : null, text: null, tool: null };
    if (type === STEP.PROMPT) step.text = msg(pbFields(msg(f, 19) ?? EMPTY), 2)?.toString('utf8') || null;
    else if (type === STEP.REPLY) {
      const b = pbFields(msg(f, 20) ?? EMPTY);
      step.text = msg(b, 1)?.toString('utf8') || null;
      step.tool = toolOf(msg(b, 7));
    } else if (type === STEP.TOOL) step.tool = toolOf(msg(meta, 4));
    return step;
  } catch {
    return null;
  }
}

// ---- 대화별 기록 (gen_metadata 와 steps 를 새 줄만 이어 읽는다) ----

const convs = new Map();

const fresh = () => ({
  sig: null,
  idx: -1,
  tokens: emptyTokens(),
  model: null,
  prompt: 0,
  // steps 는 step 번까지 다 넣었고, 그 뒤로는 seen 에 적힌 줄만 넣었다.
  step: -1,
  seen: [],
  events: [],
  turns: [],
  turnCount: 0,
  lastTool: null,
  last: null,
  // 아직 바뀌는 중인 단계 가운데 가장 뒤의 것 (지금 무엇을 하는지 보이는 데 쓴다).
  open: null,
  // 허락을 기다리는 단계 가운데 가장 뒤의 것. main·wal 은 그 상태를 본 파일에서 읽었을 때의 본 파일·-wal 서명이다.
  wait: null,
  path: null,
});

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

// gen_metadata 를 이어 읽어 n 에 더한다. 'done' 끝까지, 'torn' 마지막 줄이 쓰는 중, 'exhausted' 읽기 한도.
function readGenerations(db, n, last, budget) {
  const q = db.prepare('select idx, data from gen_metadata where idx > ? order by idx limit ?');
  for (;;) {
    const rows = q.all(n.idx, BATCH);
    for (const r of rows) {
      spend(budget, r.data);
      const x = readGeneration(r.data);
      // 마지막 줄을 해석하지 못하면 아직 쓰는 중일 수 있으니 그 앞에서 멈추고 다음 갱신에 다시 읽는다.
      // 뒤에 줄이 더 있는데도 못 읽는 줄은 형식이 다른 것이라 건너뛴다.
      if (!x && r.idx === last) return 'torn';
      n.idx = r.idx;
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
    if (rows.length < BATCH) return 'done';
    if (outOf(budget)) return 'exhausted';
  }
}

// steps 를 이어 읽어 n 의 진행 기록에 넣는다. 돌려주는 값은 readGenerations 와 같다.
// agy 는 단계 한 줄을 만든 뒤 상태와 내용을 그 자리에서 고쳐 쓰므로, 아직 바뀌는 중인 단계는 넣지 않고 다음에 다시 읽는다.
// 그 뒤의 단계를 먼저 넣었으면 n.seen 에 적어 두어 두 번 넣지 않는다. 바뀌는 중인 단계는 매번 다시 훑으므로 open·wait 도 매번 새로 정한다.
function readSteps(db, n, last, budget) {
  const q = db.prepare('select idx, status, step_payload data from steps where idx > ? order by idx limit ?');
  const seen = new Set(n.seen);
  let cur = n.step;
  let hold = null;
  let result = 'done';
  n.open = null;
  n.wait = null;
  scan: for (;;) {
    const rows = q.all(cur, BATCH);
    for (const r of rows) {
      spend(budget, r.data);
      if (seen.has(r.idx)) {
        cur = r.idx;
        continue;
      }
      const s = readStep(r.data);
      // 바뀌는 중인 단계는 내용이 아직 비어 있어도 나중에 다시 읽는다.
      if (OPEN.has(r.status)) {
        cur = r.idx;
        hold ??= r.idx;
        if (s) n.open = { ...s, idx: r.idx, status: r.status };
        if (r.status === APPROVAL) n.wait = { idx: r.idx, what: s?.tool?.what || '도구 허락' };
        continue;
      }
      if (!s && r.idx === last) {
        hold ??= r.idx;
        result = 'torn';
        break scan;
      }
      cur = r.idx;
      applyStep(n, s, r.idx);
      seen.add(r.idx);
    }
    if (rows.length < BATCH) break;
    if (outOf(budget)) {
      result = 'exhausted';
      break;
    }
  }
  n.step = hold === null ? cur : hold - 1;
  n.seen = [...seen].filter((i) => i > n.step);
  return result;
}

// 늦게 끝난 단계는 뒤 단계보다 나중에 들어오므로 시각 순서 자리로 옮긴다.
function addEvent(n, at, kind, text) {
  const e = pushEvent(n, at, kind, text);
  if (!e) return null;
  const ev = n.events;
  for (let i = ev.length - 1; i > 0 && ev[i - 1].at > e.at; i--) [ev[i - 1], ev[i]] = [ev[i], ev[i - 1]];
  return e;
}

function applyStep(n, s, idx) {
  if (!s) return;
  const at = s.at ? new Date(s.at).toISOString() : null;
  if (s.type === STEP.PROMPT) {
    if (s.text && !isNoisePrompt(s.text)) {
      const e = addEvent(n, at, 'prompt', s.text);
      if (e) {
        n.turns.push({ n: ++n.turnCount, at: e.at, text: e.text.slice(0, 120) });
        if (n.turns.length > MAX_TURNS) n.turns.shift();
      }
    }
  } else if (s.type === STEP.REPLY) {
    if (s.text) addEvent(n, at, 'reply', s.text);
  } else if (s.type === STEP.TOOL) {
    if (s.tool) {
      addEvent(n, at, 'tool', s.tool.what);
      n.lastTool = s.tool.what;
    }
  } else return;
  if (idx > (n.last?.idx ?? -1)) n.last = { type: s.type, tool: s.tool, idx };
}

const spend = (budget, data) => {
  const size = data?.length ?? 0;
  budget.left -= size;
  budget.read = (budget.read ?? 0) + size;
};

const maxIdx = (db, table) => db.prepare(`select max(idx) m from ${table}`).get()?.m ?? -1;

// 대화 기록 하나를 한 번 열어 토큰(gen_metadata)과 진행 기록(steps)을 함께 읽는다.
export function readConversation(id, budget) {
  let g = convs.get(id);
  if (!g) convs.set(id, (g = fresh()));
  const path = join(AGY_ROOT, 'conversations', `${id}.db`);
  const sig = sigOf(path);
  if (sig === null || sig === g.sig) return g;
  const mainSig = sigOf(path, false);
  if (outOf(budget)) {
    budget.exhausted = true;
    return g;
  }
  // 복사본에 더하고, 끝까지 탈 없이 읽었을 때만 반영한다.
  let n = { ...g, tokens: { ...g.tokens }, events: [...g.events], turns: [...g.turns], seen: [...g.seen] };
  let db;
  let ok = false;
  try {
    db = openReadOnly(path);
    if (!db) return g;
    const tables = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((r) => r.name));
    const lastGen = tables.has('gen_metadata') ? maxIdx(db, 'gen_metadata') : -1;
    const lastStep = tables.has('steps') ? maxIdx(db, 'steps') : -1;
    // 마지막 줄 번호가 줄었으면 기록이 새로 쓰인 것이니 처음부터 다시 읽는다.
    if (lastGen < n.idx || lastStep < n.step) n = fresh();
    const gen = tables.has('gen_metadata') ? readGenerations(db, n, lastGen, budget) : 'done';
    const steps = gen !== 'exhausted' && tables.has('steps') ? readSteps(db, n, lastStep, budget) : 'done';
    if (gen === 'done' && steps === 'done') n.sig = sig;
    if (gen === 'exhausted' || steps === 'exhausted') budget.exhausted = true;
    n.path = path;
    // 허락 대기를 본 파일에서 처음 읽은 때의 -wal 서명을 남긴다. 본 파일이 그대로인 채 -wal 만 바뀌면 같은 대기로 보고 남긴 값을 둔다.
    if (n.wait) {
      const prev = g.wait;
      const same = prev?.idx === n.wait.idx && prev.main === mainSig;
      n.wait = { ...n.wait, main: mainSig, wal: same ? prev.wal : walSig(path) };
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
// root 는 agyRoot() 로 바꾼 경로여야 한다.
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
export function matchLive(procs, rows, filesOf = openFiles, dir = AGY_ROOT) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const live = new Map();
  const loose = [];
  for (const p of procs) {
    const files = filesOf(p.pid);
    const ids = (files ?? []).map((f) => idFromPath(f, dir)).filter((id) => id && byId.has(id));
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

function member(r, g) {
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

// -wal 의 크기·수정 시각. 열지 않고 stat 만 한다.
function walSig(path) {
  try {
    const w = statSync(`${path}-wal`);
    return `${w.mtimeMs}:${w.size}`;
  } catch {
    return '-';
  }
}

// 허락을 기다리는 도구 호출이 있으면 그 도구를 한 줄로 돌려준다.
// immutable 로는 -wal 을 읽지 못해 본 파일에 합쳐진 뒤에야 대기가 보이고, 허락한 뒤에도 다시 합쳐질 때까지 대기로 남는다.
// 그래서 대기를 본 뒤 -wal 이 바뀌었으면 agy 가 다시 쓰고 있는 것(사용자가 이미 답한 것)으로 보고 대기로 치지 않는다.
export function waitingFor(g) {
  const w = g.wait;
  if (!w) return null;
  if (g.path && w.wal !== undefined && walSig(g.path) !== w.wal) return null;
  return w.what;
}

// 실행 중일 때는 아직 바뀌는 중인 단계, 없으면 마지막으로 끝난 단계로 지금 할 일을 짐작한다.
// 끝난 답변이 도구 호출을 냈으면 그 도구를 실행할 차례이고, 끝난 도구 호출 뒤에는 모델이 결과를 읽고 생각한다.
export function phaseOf(live, r, g, runningMembers = 0) {
  if (!live) return { kind: 'ended', text: '종료' };
  const extra = runningMembers ? ` · 에이전트 ${runningMembers}개 실행 중` : '';
  const wait = waitingFor(g);
  if (wait) return { kind: 'waiting', text: `응답 대기 · ${wait}${extra}` };
  if (!r.running) return { kind: 'idle', text: '다음 지시 대기' };
  // 바뀌는 중인 단계와 끝난 단계 가운데 더 뒤의 것이 지금 하는 일이다 (앞의 명령이 오래 도는 동안 뒤 단계가 이어질 수 있다).
  const open = g.open && (!g.last || (g.open.idx ?? Infinity) > (g.last.idx ?? -1));
  const s = open ? g.open : (g.last ?? g.open);
  let p;
  if (!s) p = { kind: 'think', text: `작업 중 · ${r.steps}단계` };
  else if (s.type === STEP.TOOL && open) p = { kind: 'tool', text: `도구 실행 · ${s.tool?.what || '도구'}` };
  else if (s.type === STEP.REPLY && !open && s.tool) p = { kind: 'tool', text: `도구 실행 · ${s.tool.what}` };
  else if (s.type === STEP.REPLY) p = { kind: 'write', text: '답변 작성 중' };
  else p = { kind: 'think', text: '생각 중' };
  return { ...p, text: p.text + extra };
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
  if (!loadSqlite()) return procs.map((p) => placeholder(p, '실행 중 (세부 정보는 Node 22.15 이상)'));

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
  // 부모가 목록에 없는 서브에이전트(목록 상한 밖)는 혼자 최상위로 본다.
  const tops = rows.filter((r) => rootOf(r.id, byId) === r.id && (live.has(r.id) || (showEnded && Date.now() - (r.updatedAt ?? 0) < RECENT_MS)));
  tops.sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)));
  for (const r of tops) {
    const isLive = live.has(r.id);
    const g = readConversation(r.id, budget);
    const kids = children.get(r.id) ?? [];
    // 서브에이전트 기록은 한 번만 읽어 행과 합계가 같은 값을 쓰게 한다.
    const kidUsage = kids.map((c) => readConversation(c.id, budget));
    const members = kids.map((c, i) => member(c, kidUsage[i])).sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    // 메인과 서브에이전트를 항목별로 더한다 (Claude 세션과 같은 방식).
    const tokens = { ...g.tokens, main: g.tokens.total, sub: 0, subCount: kids.length };
    for (const u of kidUsage) {
      const t = u.tokens;
      for (const k of Object.keys(emptyTokens())) tokens[k] += t[k];
      tokens.sub += t.total;
    }
    const running = members.filter((m) => m.status === 'busy').length;
    const wait = isLive ? waitingFor(g) : null;
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
      status: !isLive ? 'ended' : wait ? 'waiting' : r.running ? 'busy' : 'idle',
      phase: phaseOf(isLive, r, g, running),
      cost: null,
      costNoCache: null,
      costUnknown: tokens.total > 0,
      waitingFor: wait,
      now: g.lastTool ?? g.events.at(-1)?.text ?? '',
      startedAt: null,
      updatedAt: r.updatedAt ?? Date.now(),
      tokens,
      context: { used: g.prompt, window: contextWindow(g.model, g.prompt) },
      events: g.events,
      files: [],
      turns: g.turns,
      members: isLive ? members : [],
    });
  }
  for (const p of loose) out.push(placeholder(p, '첫 입력 대기'));

  const keep = new Set(rows.map((r) => r.id));
  for (const id of convs.keys()) if (!keep.has(id)) convs.delete(id);
  return out;
}
