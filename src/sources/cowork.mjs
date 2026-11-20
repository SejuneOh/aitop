// Claude Desktop 의 에이전트 모드(Cowork) 세션 (#304).
// Cowork 는 앱이 띄우는 VM 안에서 Claude Code 를 돌리고, 기록은 호스트의 앱 폴더에 남는다:
//   <앱>/local-agent-mode-sessions/<uuid>/<uuid>/local_<id>.json                 세션 메타 (제목, 모델, 마지막 활동 시각 등)
//   <앱>/local-agent-mode-sessions/<uuid>/<uuid>/local_<id>/.claude/projects/*/*.jsonl   Claude Code 와 같은 대화 기록 (+ <id>/subagents/)
//   <앱>/local-agent-mode-sessions/<uuid>/<uuid>/local_<id>/audit.jsonl          권한 요청·응답이 든 감사 기록
// 앱 폴더에는 쿠키·Local Storage·설정 같은 다른 파일도 있으므로 위 세 가지만 연다 (허용 목록). 폴더는 목록만 읽는다.
// 프로세스가 VM 안이라 보이지 않으므로 실행 중은 메타의 lastActivityAt 과 기록 수정 시각 중 늦은 쪽이 2분 안이면으로 본다.
// 세션은 TOOL 칸에 cowork 로 보이고(색은 claude), 기록 파서는 Claude 것(claude-tracker.mjs)을 그대로 쓴다.
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ClaudeTracker } from './claude-tracker.mjs';
import { sessionName } from './common.mjs';
import { emptySub, sessionTotals, readMembers, withRunningMembers, phaseOf, stoppedPhase, cacheOf, toolStartOf } from './claude.mjs';
import { coworkEnv, coworkSetting, expandHome, wslWindowsHomes } from './dirs.mjs';
import { loadCache } from '../cache.mjs';
import { isWsl } from '../notify.mjs';
import { debugIo } from '../log.mjs';

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const realOf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export const SESSIONS_DIR = 'local-agent-mode-sessions';
// 실행 중으로 볼 시간 (Antigravity 앱 대화의 APP_LIVE_MS 와 같은 값).
export const COWORK_LIVE_MS = 2 * 60_000;
// 앱 폴더는 WSL 에서 /mnt/c(9P, stat 한 번에 약 0.6ms)에 있을 수 있어, 세션 목록·메타·기록 목록·audit.jsonl 은
// 이 간격마다 한 번만 본다 (Antigravity 앱 폴더의 APP_TTL_MS 와 같은 값). 2분 판정은 매 갱신 지금 시각으로 한다.
export const COWORK_TTL_MS = 10_000;
// 끝난 세션을 --all 에 보이는 기간 (Claude 와 같은 24시간).
const ENDED_WINDOW_MS = 24 * 3600 * 1000;
// 장부·화면이 보는 기본 기간 (7일).
const DAYS = 7;
// audit.jsonl 끝에서 읽는 양. 권한 대기 중에는 새 줄이 거의 붙지 않으므로 마지막 요청은 이 안에 있다.
const AUDIT_TAIL = 256 * 1024;
// 꼬리의 첫 줄이 잘렸으면 줄 시작까지 앞으로 더 읽는 상한 (요청 한 줄이 아주 길 때, tool_input 이 큰 Write 등).
const AUDIT_MAX = 4 * 1024 * 1024;
// 응답 없는 권한 요청을 응답 대기로 두는 최대 시간 (요청 시각 기준). 2분 실행 중 기준과 상관없이 이 동안은 대기다.
// 실제 기록에서 요청→응답이 2분을 넘는 경우가 드물지 않았다 (10분 넘게도). 이보다 오래되면 버려진 요청으로 보고 종료로 둔다.
export const COWORK_WAIT_MAX_MS = 60 * 60_000;
// 앱 폴더 목록을 다시 찾는 간격 (실행 중에 앱을 설치하거나 지워도 반영되게).
const ROOTS_TTL_MS = 60_000;
// 대기 대상(도구 이름)의 최대 길이.
const TOOL_MAX = 60;

// 앱 폴더 목록 (#304). 앱 폴더는 그 아래에 local-agent-mode-sessions/ 가 있는 것만 넣는다.
// - AITOP_COWORK_HOME: 앱 폴더 (여럿이면 path.delimiter 로 잇는다). off·0·none·false 면 읽지 않는다. 가장 높다.
// - app: 설정 파일의 cowork (false 면 끔, 경로 배열이면 그 폴더들, true·undefined 면 저절로 찾는다).
// - 저절로: macOS ~/Library/Application Support/Claude, Windows %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude(MSIX)
//   와 %APPDATA%\Claude, WSL 이면 Windows 홈(dirs.mjs wslWindowsHomes)의 같은 두 곳.
// 같은 실제 폴더는 한 번만.
export function findCoworkRoots({ env = process.env, home = homedir(), app, platform = process.platform, wsl = null, winHomes = null, has = isDir } = {}) {
  const own = coworkEnv(env.AITOP_COWORK_HOME);
  const choice = own !== undefined ? own : app;
  if (choice === false) return [];
  const packages = (dir) => {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((n) => /^Claude_/i.test(n)).sort().map((n) => join(dir, n, 'LocalCache', 'Roaming', 'Claude'));
  };
  let cands = [];
  if (Array.isArray(choice)) cands = choice.map((p) => expandHome(p, home));
  else {
    if (platform === 'darwin') cands.push(join(home, 'Library', 'Application Support', 'Claude'));
    if (platform === 'win32') {
      if (env.LOCALAPPDATA) cands.push(...packages(join(env.LOCALAPPDATA, 'Packages')));
      if (env.APPDATA) cands.push(join(env.APPDATA, 'Claude'));
    }
    const onWsl = wsl ?? (platform === 'linux' && isWsl(env));
    if (onWsl) {
      for (const h of (winHomes ?? (() => wslWindowsHomes({ env })))()) cands.push(...packages(join(h, 'AppData', 'Local', 'Packages')), join(h, 'AppData', 'Roaming', 'Claude'));
    }
  }
  const seen = new Set();
  const out = [];
  for (const c of cands) {
    if (!has(join(c, SESSIONS_DIR))) continue;
    const real = realOf(c);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(resolve(c));
  }
  return out;
}

// 처음 쓸 때 정한다 (bin/aitop.mjs 가 설정 파일 값을 setDataDirs 로 넘긴 뒤). ROOTS_TTL_MS 마다 다시 찾는다.
let rootsCache = null;
export const coworkRoots = (now = Date.now()) => {
  if (!rootsCache || now < rootsCache.at || now - rootsCache.at >= ROOTS_TTL_MS) rootsCache = { at: now, list: findCoworkRoots({ app: coworkSetting() }) };
  return rootsCache.list;
};

// ---- 세션 목록과 메타 ----

const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
// 메타에서 쓰는 값만 꺼낸다. initialMessage·enabledMcpTools 등 나머지는 담지 않는다.
export function pickMeta(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    sessionId: str(m.sessionId),
    cliSessionId: str(m.cliSessionId),
    title: str(m.title),
    model: str(m.model),
    cwd: str(m.cwd),
    createdAt: num(m.createdAt),
    lastActivityAt: num(m.lastActivityAt),
    isArchived: m.isArchived === true,
  };
}

const ls = (dir, what) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') debugIo('cowork', what, e, dir);
    return [];
  }
};

// 파일 시스템이 항목 종류를 알려 주지 않으면(Dirent 가 모두 false) 폴더는 stat 으로 확인하고, 파일은 파일로 본다.
const dirEnt = (e, p) => e.isDirectory() || (!e.isFile() && !e.isSymbolicLink() && isDir(p));
const fileEnt = (e) => e.isFile() || (!e.isDirectory() && !e.isSymbolicLink());

// 메타 파일 경로 → { mtime, size, meta }. 수정 시각·크기가 그대로면 다시 읽지 않는다.
const metas = new Map();
function readMeta(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    metas.delete(path);
    return null;
  }
  const c = metas.get(path);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c;
  let meta = null;
  try {
    meta = pickMeta(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    debugIo('cowork', 'meta read failed', e, path);
  }
  const out = { mtime: st.mtimeMs, size: st.size, meta };
  metas.set(path, out);
  return out;
}

// 세션 폴더의 대화 기록 목록: .claude/projects/<폴더>/*.jsonl 과 <id>/subagents/*.jsonl.
// key 는 projects/ 아래 상대 경로 (claude-ledger.mjs 와 같은 모양이라 ~/.claude/projects 에 같은 기록이 있으면 한 번만 센다).
function listTranscripts(dir) {
  const root = join(dir, '.claude', 'projects');
  const out = [];
  for (const d of ls(root, 'projects read failed')) {
    if (!dirEnt(d, join(root, d.name))) continue;
    for (const e of ls(join(root, d.name), 'project folder read failed')) {
      const p = join(root, d.name, e.name);
      if (fileEnt(e) && e.name.endsWith('.jsonl')) {
        try {
          out.push({ key: `${d.name}/${e.name}`, path: p, mtime: statSync(p).mtimeMs, sub: false });
        } catch {}
      } else if (dirEnt(e, p)) {
        for (const s of ls(join(p, 'subagents'), 'subagents read failed')) {
          if (!fileEnt(s) || !s.name.endsWith('.jsonl')) continue;
          const sp = join(p, 'subagents', s.name);
          try {
            out.push({ key: `${d.name}/${e.name}/${s.name}`, path: sp, mtime: statSync(sp).mtimeMs, sub: true });
          } catch {}
        }
      }
    }
  }
  return out;
}

// 세션 폴더 → { sig, files, main }. 메타가 그대로이고 메인 기록 수정 시각도 그대로면 목록을 다시 읽지 않는다.
const listings = new Map();
function transcriptsOf(dir, meta, metaMtime) {
  const c = listings.get(dir);
  const sig = `${metaMtime}:${meta.lastActivityAt}`;
  if (c && c.sig === sig && c.main) {
    let m = null;
    try {
      m = statSync(c.main.path).mtimeMs;
    } catch {}
    if (m === c.main.mtime) return c;
  }
  const files = listTranscripts(dir);
  const tops = files.filter((f) => !f.sub);
  // 메인 기록: 메타의 cliSessionId 와 이름이 같은 것, 없으면 가장 최근에 바뀐 것.
  const main = tops.find((f) => basename(f.path, '.jsonl') === meta.cliSessionId) ?? tops.toSorted((a, b) => b.mtime - a.mtime)[0] ?? null;
  const out = { sig, files, main };
  listings.set(dir, out);
  return out;
}

// ---- audit.jsonl: 응답 대기 ----

const REQUEST = 'permission_request';
const SETTLED = new Set(['permission_response', 'permission_denied', 'permission_auto_approved']);

// 줄에서 쓰는 표지. 요청 뒤에 이것들이 오면 그 요청은 끝난 것이다:
// 응답(permission_response·permission_denied·permission_auto_approved), 턴 끝(type result), 새 세션 시작(system init).
const SUBTYPE_RE = /"subtype"\s*:\s*"(permission_request|permission_response|permission_denied|permission_auto_approved|init)"/;
const RESULT_RE = /"type"\s*:\s*"result"/;
const TOOL_RE = /"tool_name"\s*:\s*"((?:[^"\\]|\\.){1,200})"/;
const TS_RE = /"_audit_timestamp"\s*:\s*(?:"([^"\\]{1,40})"|(\d{10,16}))/;
// 이보다 짧은 줄은 JSON 으로 풀어 맨 위 type·subtype 을 확인한다. 긴 줄은 풀지 않고 위 표지만 문자열에서 찾는다
// (안의 문자열 값에 든 따옴표는 \" 로 이스케이프돼 있어 표지와 섞이지 않는다).
const PARSE_MAX = 64 * 1024;

// 한 줄 → { kind: 'request', tool, at } | { kind: 'end' } | null. tool_input·_audit_hmac 등은 꺼내지 않는다.
function auditLine(line) {
  const sub = SUBTYPE_RE.exec(line)?.[1];
  const result = !sub && RESULT_RE.test(line);
  if (!sub && !result) return null;
  if (line.length <= PARSE_MAX) {
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      return null;
    }
    if (x?.type === 'result') return { kind: 'end' };
    if (x?.type !== 'system') return null;
    if (x.subtype === REQUEST) return { kind: 'request', tool: typeof x.tool_name === 'string' ? x.tool_name : null, at: num(x._audit_timestamp) };
    return SETTLED.has(x.subtype) || x.subtype === 'init' ? { kind: 'end' } : null;
  }
  if (sub !== REQUEST) return { kind: 'end' };
  let tool = null;
  const m = TOOL_RE.exec(line);
  if (m) {
    try {
      tool = JSON.parse(`"${m[1]}"`);
    } catch {}
  }
  const ts = TS_RE.exec(line);
  return { kind: 'request', tool, at: ts ? num(ts[1] ?? Number(ts[2])) : null };
}

// audit.jsonl 의 줄들에서 응답 대기를 고른다. 마지막 permission_request 뒤에 끝 표지(auditLine)가 없으면 { tool, since }, 아니면 null.
// 요청과 응답을 잇는 id 가 없어 순서만 본다. 줄마다 표지·tool_name·_audit_timestamp 만 꺼내고
// tool_input·_audit_hmac·대화 내용은 담지 않는다. 표지가 없는 줄은 JSON 으로 풀지도 않는다.
export function auditWait(lines) {
  let wait = null;
  for (const line of lines) {
    const x = auditLine(line);
    if (!x) continue;
    if (x.kind === 'end') wait = null;
    else wait = { tool: (x.tool && sessionName(x.tool)?.slice(0, TOOL_MAX)) || 'tool', since: x.at };
  }
  return wait;
}

// audit.jsonl 끝 AUDIT_TAIL 바이트를 읽어 응답 대기를 고른다. 파일이 그대로면 지난 값을 쓴다.
const audits = new Map();
function readAudit(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    audits.delete(path);
    return null;
  }
  const c = audits.get(path);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.wait;
  let wait = null;
  let fd;
  try {
    fd = openSync(path, 'r');
    // 끝 AUDIT_TAIL 을 읽고, 파일 중간에서 시작했으면 첫 줄이 잘렸을 수 있으므로 앞 줄의 끝(\n)이 나올 때까지
    // 앞으로 더 읽는다 (모두 AUDIT_MAX 까지). 그러면 아주 긴 요청 한 줄도 통째로 들어온다.
    const read = (from, len) => {
      const b = Buffer.alloc(len);
      readSync(fd, b, 0, len, from);
      return b;
    };
    let start = Math.max(0, st.size - AUDIT_TAIL);
    let buf = read(start, st.size - start);
    let bounded = start === 0;
    while (!bounded && st.size - start < AUDIT_MAX) {
      const step = Math.min(start, AUDIT_TAIL, AUDIT_MAX - (st.size - start));
      const more = read(start - step, step);
      start -= step;
      buf = Buffer.concat([more, buf]);
      bounded = start === 0 || more.includes(10);
    }
    const lines = buf.toString('utf8').split('\n');
    // 앞 줄의 꼬리 조각은 버린다. 상한에 걸려 줄 시작을 못 찾았으면 잘린 줄이어도 남겨 표지만 찾는다 (auditLine 의 긴 줄 처리).
    if (start > 0 && bounded) lines.shift();
    wait = auditWait(lines);
  } catch (e) {
    debugIo('cowork', 'audit read failed', e, path);
  } finally {
    if (fd != null) closeSync(fd);
  }
  if (wait && wait.since == null) wait.since = st.mtimeMs;
  audits.set(path, { mtime: st.mtimeMs, size: st.size, wait });
  return wait;
}

// ---- 앱 폴더 훑기 (COWORK_TTL_MS 마다 한 번) ----

// 앱 폴더 하나의 세션 목록. days 일 안에 활동한 세션만 기록 목록을 읽는다 (그보다 오래된 세션은 메타만).
// 실행 중이거나 응답을 기다리고 있을 수 있는 세션(보관하지 않았고 활동이 COWORK_WAIT_MAX_MS + COWORK_TTL_MS 안)만 audit.jsonl 을 본다.
// audit 는 수정 시각·크기가 그대로면 다시 읽지 않으므로(readAudit) 대기 중인 세션도 stat 한 번이다.
function scanRoot(root, days, now) {
  const base = join(root, SESSIONS_DIR);
  const out = [];
  let ok = true;
  let top = [];
  try {
    top = readdirSync(base, { withFileTypes: true });
  } catch (e) {
    ok = false;
    if (e.code !== 'ENOENT') debugIo('cowork', 'sessions read failed', e, base);
  }
  for (const a of top) {
    if (!dirEnt(a, join(base, a.name))) continue;
    for (const b of ls(join(base, a.name), 'sessions read failed')) {
      if (!dirEnt(b, join(base, a.name, b.name))) continue;
      const dir2 = join(base, a.name, b.name);
      for (const f of ls(dir2, 'sessions read failed')) {
        const m = /^(local_[\w-]+)\.json$/.exec(f.name);
        if (!m || !fileEnt(f)) continue;
        const metaPath = join(dir2, f.name);
        const got = readMeta(metaPath);
        if (!got?.meta) continue;
        const meta = got.meta;
        const dir = join(dir2, m[1]);
        const touched = Math.max(meta.lastActivityAt ?? 0, got.mtime);
        const recent = now - touched < days * 86400_000;
        const list = recent ? transcriptsOf(dir, meta, got.mtime) : { files: [], main: null };
        const newest = Math.max(0, ...list.files.map((x) => x.mtime));
        const activity = Math.max(meta.lastActivityAt ?? 0, newest);
        const maybe = !meta.isArchived && now - activity <= COWORK_WAIT_MAX_MS + COWORK_TTL_MS;
        out.push({ localId: m[1], root, dir, meta, metaMtime: got.mtime, files: list.files, main: list.main, wait: maybe ? readAudit(join(dir, 'audit.jsonl')) : null, audited: maybe });
      }
    }
  }
  return { ok, sessions: out };
}

const snaps = new Map();
// 앱 폴더들의 세션 목록 (TTL 안이면 지난 값). days 마다 따로 둔다 (화면·장부는 7일, 리포트는 더 길게).
export function coworkSnapshot({ roots = coworkRoots(), days = DAYS, now = Date.now() } = {}) {
  const key = `${roots.join('\0')}|${days}`;
  const c = snaps.get(key);
  // 시계가 거꾸로 갔으면(또는 미래 시각으로 모았으면) 다시 본다.
  if (c && now >= c.at && now - c.at < COWORK_TTL_MS) return c;
  const per = roots.map((r) => ({ root: r, ...scanRoot(r, days, now) }));
  const snap = { at: now, roots: per, sessions: per.flatMap((r) => r.sessions) };
  snaps.set(key, snap);
  // 이번 목록에 없는 세션(지워진 세션, 이제 읽지 않는 앱 폴더)의 캐시는 지운다. 기간이 다른 목록(리포트)은 세션이 같으므로 7일 목록 때만 한다.
  if (days === DAYS) {
    const dirs = new Set(snap.sessions.map((s) => s.dir));
    const dirOf = (p, tail) => p.slice(0, -tail.length);
    for (const p of metas.keys()) if (!dirs.has(dirOf(p, '.json'))) metas.delete(p);
    for (const d of listings.keys()) if (!dirs.has(d)) listings.delete(d);
    // audit 는 이번에 보지 않은 것(대기 기간이 지났거나 보관한 세션)도 지운다.
    const audited = new Set(snap.sessions.filter((s) => s.audited).map((s) => join(s.dir, 'audit.jsonl')));
    for (const p of audits.keys()) if (!audited.has(p)) audits.delete(p);
  }
  return snap;
}

// 장부용: days 일 안에 바뀐 Cowork 기록 [{ key, path, mtime }] (claude-ledger.mjs recentFiles 가 Claude 기록과 함께 센다).
export function coworkLedgerFiles(days = DAYS, now = Date.now()) {
  const cutoff = now - days * 86400_000;
  return coworkSnapshot({ days: Math.max(DAYS, days), now }).sessions.flatMap((s) => s.files.filter((f) => f.mtime >= cutoff).map(({ key, path, mtime }) => ({ key, path, mtime })));
}

// --report trace 가 세션 id 로 기록을 찾을 때 쓰는 projects/ 폴더 목록.
export function coworkProjectRoots() {
  return coworkSnapshot().sessions.map((s) => join(s.dir, '.claude', 'projects'));
}

// --doctor 용: 앱 폴더마다 { dir, sessions, lastAt, ok }. 기록 내용은 읽지 않는다 (세션 목록과 메타만).
export function coworkCheck(roots = coworkRoots()) {
  const snap = coworkSnapshot({ roots });
  return snap.roots.map((r) => {
    const last = Math.max(0, ...r.sessions.map((s) => Math.max(s.meta.lastActivityAt ?? 0, ...s.files.map((f) => f.mtime))));
    return { dir: r.root, ok: r.ok, sessions: r.sessions.length, lastAt: last || null };
  });
}

// ---- 화면 세션 ----

const trackers = new Map();
const subTrackers = new Map();
let seen = new Set();
function tracker(map, path, budget, fresh = true) {
  let t = map.get(path);
  if (!t) map.set(path, (t = new ClaudeTracker(path)));
  // 끝난 세션의 다 읽은 기록은 목록(TTL)에서 수정 시각이 바뀌었을 때만 다시 본다 (/mnt/c 에서 갱신마다 stat 하지 않게).
  if (fresh || !t.mtimeMs || t.tail.offset < t.tail.size) t.update(budget);
  seen.add(path);
  return t;
}

// 캐시가 있는지는 기록이 바뀔 때만 다시 확인한다.
const cacheChecked = new Map();
function hasCache(path, mtime) {
  const c = cacheChecked.get(path);
  if (c && c.mtime === mtime) return c.ok;
  const ok = Boolean(loadCache(path));
  cacheChecked.set(path, { mtime, ok });
  return ok;
}

// 끝난 세션의 행은 기록이 그대로면 지난 값을 쓴다 (서브에이전트 폴더를 갱신마다 다시 읽지 않게).
const endedRows = new Map();

function statusOf(live, wait, t, mtime, now) {
  if (!live) return 'ended';
  if (wait) return 'waiting';
  if (!t) return 'busy';
  // 열린 도구 호출이 있거나 마지막 줄이 지시·도구 결과면 작업 중. 답변으로 끝났으면 잠깐(5초) 뒤 다음 지시 대기로 본다.
  if (t.pending.size || t.lastKind === 'prompt' || t.lastKind === 'result') return 'busy';
  return now - mtime < 5000 ? 'busy' : 'idle';
}

// 응답 대기로 볼 audit 요청 (기록 확인 전). 보관한 세션은 대기가 아니고, 요청이 COWORK_WAIT_MAX_MS 보다 오래되면 버려진 것으로 본다.
function waitOf(s, now) {
  const w = s.wait;
  if (!w || s.meta.isArchived) return null;
  return w.since != null && now - w.since > COWORK_WAIT_MAX_MS ? null : w;
}

// 세션 하나의 행. 끝난 세션(want 가 false)은 기록 본문을 읽지 않고 lazy 로 둔다.
// timeLive: 2분 기준으로 실행 중인지. 응답 대기(waitOf)가 있으면 2분과 상관없이 실행 중(대기)이다.
function row(s, { budget, now, want, timeLive }) {
  const m = s.meta;
  let wait = waitOf(s, now);
  const fresh = timeLive || Boolean(wait);
  const t = s.main && want ? tracker(trackers, s.main.path, budget, fresh || s.main.mtime !== trackers.get(s.main.path)?.mtimeMs) : null;
  const track = (p, b) => tracker(subTrackers, p, b, fresh || s.files.find((f) => f.path === p)?.mtime !== subTrackers.get(p)?.mtimeMs);
  const { members, sub } = t ? readMembers(s.main.path, t, budget, { track, meta: false }) : { members: [], sub: emptySub() };
  const mtime = Math.max(m.lastActivityAt ?? 0, t?.mtimeMs ?? 0, ...s.files.map((f) => f.mtime));
  // 대화 기록에 열린 tool_use 가 없으면 허락을 기다릴 도구 호출이 없으므로 대기를 지운다 (audit 에 응답 줄이 빠진 경우).
  // 기록을 아직 다 읽지 못한 처음 상태(t 없음, 또는 읽는 중)는 열린 호출을 모르므로 audit 만으로 판단한다.
  if (wait && t && t.loading == null && t.pending.size === 0) wait = null;
  const live = timeLive || Boolean(wait);
  const waitingFor = wait ? `approve ${wait.tool}` : null;
  const status = statusOf(live, wait, t, mtime, now);
  const phase = withRunningMembers(phaseOf(status, { waitingFor }, t), status, members);
  const name = sessionName(m.title ?? '') ?? t?.customTitle ?? t?.title ?? `${basename(m.cwd ?? '') || 'cowork'} · ${s.localId.slice(6, 14)}`;
  return {
    tool: 'cowork',
    id: m.cliSessionId ?? m.sessionId ?? s.localId,
    pid: null,
    kind: 'interactive',
    name,
    customName: null,
    cwd: m.cwd,
    project: basename(m.cwd ?? ''),
    branch: t?.branch ?? null,
    model: t?.model ?? m.model,
    // Cowork 기록의 실행 방식 ('local-agent').
    entrypoint: t?.entrypoint ?? 'local-agent',
    live,
    lazy: !t && !live,
    status,
    phase,
    toolStartedAt: toolStartOf(status, phase, t),
    stopReason: status === 'idle' && stoppedPhase(t) ? t.stopReason : null,
    ...cacheOf(live, status, t),
    waitingFor,
    waitDetail: status === 'waiting' ? (t?.waitDetail(waitingFor) ?? null) : null,
    now: t?.lastTool ?? t?.events.at(-1)?.text ?? '',
    startedAt: m.createdAt ?? t?.firstAt ?? null,
    updatedAt: mtime || null,
    // 대기 시작 시각 (--line 요약용).
    waitSince: wait?.since ?? null,
    ...sessionTotals(t, sub),
    events: t?.events ?? [],
    members: status === 'ended' ? [] : members,
  };
}

export function collectCowork({ showEnded, budget, selectedId, roots = coworkRoots(), now = Date.now() } = {}) {
  if (!roots.length) return [];
  const snap = coworkSnapshot({ roots, now });
  seen = new Set();
  const eager = budget?.left === Infinity;
  const out = [];
  // 살아 있는 세션부터 읽어 읽기 한도가 끝난 세션에 먼저 쓰이지 않게 한다.
  const list = snap.sessions
    .map((s) => {
      const newest = Math.max(0, ...s.files.map((f) => f.mtime), trackers.get(s.main?.path)?.mtimeMs ?? 0);
      const activity = Math.max(s.meta.lastActivityAt ?? 0, newest);
      return { s, activity, live: !s.meta.isArchived && now - activity <= COWORK_LIVE_MS };
    })
    .sort((a, b) => Number(b.live || Boolean(waitOf(b.s, now))) - Number(a.live || Boolean(waitOf(a.s, now))));
  const keep = new Set();
  for (const { s, activity, live: timeLive } of list) {
    // 응답 대기일 수 있는 세션도 실행 중 후보다 (기록의 열린 호출은 row 가 확인한다).
    const live = timeLive || Boolean(waitOf(s, now));
    if (!live && !(showEnded && now - activity < ENDED_WINDOW_MS)) continue;
    const id = s.meta.cliSessionId ?? s.meta.sessionId ?? s.localId;
    const path = s.main?.path;
    const want = Boolean(path) && (live || eager || id === selectedId || trackers.has(path) || hasCache(path, s.main.mtime));
    keep.add(s.dir);
    if (!live) {
      const sig = `${s.metaMtime}:${s.files.map((f) => f.mtime).join(',')}:${want}`;
      const c = endedRows.get(s.dir);
      if (c && c.sig === sig) {
        if (path) seen.add(path);
        for (const f of s.files) if (f.sub) seen.add(f.path);
        out.push(c.row);
        continue;
      }
      const r = row(s, { budget, now, want, timeLive });
      if (!r.loading) endedRows.set(s.dir, { sig, row: r });
      out.push(r);
      continue;
    }
    endedRows.delete(s.dir);
    const r = row(s, { budget, now, want, timeLive });
    // 대기 후보였지만 기록에 열린 호출이 없어 대기를 지웠고 2분 기준으로도 끝났으면, 종료 세션으로 --all 에서만 보인다.
    if (r.live || (showEnded && now - activity < ENDED_WINDOW_MS)) out.push(r);
  }
  for (const d of endedRows.keys()) if (!keep.has(d)) endedRows.delete(d);
  for (const map of [trackers, subTrackers]) for (const p of map.keys()) if (!seen.has(p)) map.delete(p);
  return out;
}

// 테스트용: 앱 폴더 캐시를 ms 만큼 오래된 것으로 만든다 (TTL 이 지난 것을 흉내 낸다), 또는 모두 비운다.
export const _test = {
  age(ms) {
    for (const c of snaps.values()) c.at -= ms;
  },
  // 캐시에 남은 열쇠 (정리 확인용).
  keys() {
    return { metas: [...metas.keys()], listings: [...listings.keys()], audits: [...audits.keys()] };
  },
  reset() {
    snaps.clear();
    metas.clear();
    listings.clear();
    audits.clear();
    cacheChecked.clear();
    endedRows.clear();
    trackers.clear();
    subTrackers.clear();
    rootsCache = null;
  },
};
