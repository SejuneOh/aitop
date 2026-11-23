// --remote (#308): SSH 원격과 WSL 배포판에서 `aitop --json --no-remote` 를 돌려 그 세션을 함께 본다.
// 원격을 켰을 때만 bin 이 이 모듈을 불러온다 (켜지 않으면 시작 시간·화면이 예전과 같다).
// 실행은 child_process.execFile 에 인자 배열로만 한다 (셸 없음). 인증·호스트 신뢰는 사용자의 ssh 설정·agent 에 맡기고
// BatchMode=yes 로 비밀번호를 묻지 않게 한다. StrictHostKeyChecking 은 건드리지 않는다.
// 원격 출력은 믿지 않는 입력이다: 정해진 필드만 골라 값을 확인하고 다시 만든다. 원격 stderr 는 화면에 내지 않는다.
import { execFile } from 'node:child_process';
import { STRINGS } from './i18n.mjs';
import { mask, stripControl } from './text.mjs';
import { artifactLink } from './sources/artifacts.mjs';
import { SCHEMA } from './json.mjs';
import { bySession } from './collect.mjs';
import { parseRemote } from './config.mjs';

// 한 번 호출의 시간 상한, 출력 상한, 다시 부르는 간격. AITOP_REMOTE_TIMEOUT_MS 는 테스트에서 시간 초과를 짧게 흉내 낼 때 쓴다.
export const TIMEOUT_MS = 20_000;
export const MAX_BUFFER = 8 * 1024 * 1024;
export const INTERVAL_MS = 10_000;
// 원격 하나에서 받는 개수 상한.
export const MAX_SESSIONS = 500;
export const MAX_FILES = 200;
export const MAX_MEMBERS = 50;
export const MAX_ARTIFACTS = 20;
const STR_MAX = 200;
// 폴더·파일 경로는 줄이면 이어 열기(y)와 파일 이름이 틀어지므로 조금 길게 둔다.
const PATH_MAX = 1024;

const REMOTE_ARGS = ['aitop', '--json', '--no-remote'];

// 실행할 파일과 인자. fake(AITOP_REMOTE_FAKE, 테스트 전용 node 스크립트)가 있으면 ssh·wsl.exe 대신 그 스크립트를 node 로 부른다:
// node <script> <ssh|wsl> <대상> aitop --json --no-remote. 셸을 거치지 않으므로 Windows CI 에서도 같다.
export function remoteCommand(r, { fake = process.env.AITOP_REMOTE_FAKE, node = process.execPath } = {}) {
  if (fake) return [node, [fake, r.kind, r.target, ...REMOTE_ARGS]];
  if (r.kind === 'wsl') return ['wsl.exe', ['-d', r.target, '--', ...REMOTE_ARGS]];
  return ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T', '--', r.target, ...REMOTE_ARGS]];
}

// wsl.exe 의 오류 출력은 UTF-16 이라 글자 사이에 NUL 이 낀다. 판정에만 쓰므로 NUL 을 지우고 읽는다.
const errText = (b) => String(Buffer.isBuffer(b) ? b.toString('utf8') : (b ?? '')).replace(/\0/g, '');

// 끝난 호출을 오류 코드로 가른다. ok 면 null.
// auth: ssh 인증·호스트 키 실패, unreachable: 접속 실패(그 밖의 ssh 255, 없는 배포판 등), notFound: 원격에 aitop 이 없음(127) 또는 ssh·wsl.exe 가 없음,
// old: --no-remote 를 모르는 옛 aitop(2) 또는 schema 가 없는 출력, newer: 더 큰 schema, timeout: 시간 초과, bad: 깨진 JSON·크기 초과.
export function classify({ err = null, stdout = '', stderr = '' } = {}) {
  if (err) {
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { error: 'bad' };
    if (err.code === 'ENOENT') return { error: 'notFound' };
    if (err.killed || err.timedOut) return { error: 'timeout' };
    const code = typeof err.code === 'number' ? err.code : null;
    const why = errText(stderr);
    if (code === 127) return { error: 'notFound' };
    if (code === 2) return { error: 'old' };
    if (/permission denied|host key verification failed|too many authentication failures|no supported authentication/i.test(why)) return { error: 'auth' };
    if (/command not found|not recognized|no such file or directory/i.test(why) && code !== 255) return { error: 'notFound' };
    return { error: 'unreachable' };
  }
  let json;
  try {
    json = JSON.parse(errText(stdout));
  } catch {
    return { error: 'bad' };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json) || !Array.isArray(json.sessions)) return { error: 'bad' };
  if (typeof json.schema !== 'number' || !Number.isInteger(json.schema)) return { error: 'old', version: cleanStr(json.version, 40) };
  if (json.schema > SCHEMA) return { error: 'newer', version: cleanStr(json.version, 40), schema: json.schema };
  return { error: null, json };
}

// ── 정리 규칙 ────────────────────────────────────────────

const TOOLS = new Set(['claude', 'codex', 'gemini', 'cowork']);
const STATUSES = new Set(['waiting', 'busy', 'shell', 'live', 'idle', 'ended']);
const MEMBER_STATUSES = new Set(['busy', 'idle', 'waiting', 'done']);
const STOP_KINDS = new Set(['auth', 'network', 'api']);
const SOURCES = new Set(['cli', 'app']);

export function cleanStr(v, max = STR_MAX) {
  if (typeof v !== 'string') return null;
  // 색·커서 이동 같은 escape 열은 통째로 지운 뒤 남은 제어 문자를 지운다 (ESC 만 지우면 '[31m' 이 글자로 남는다).
  const s = mask(stripControl(v.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, ''))).replace(/[\t\n\r]/g, ' ').slice(0, max);
  return s || null;
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const count = (v) => num(v) ?? 0;
const time = (v) => {
  if (typeof v !== 'string' || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// --json 의 phase 는 늘 한국어 문구(i18n.mjs 의 ko 표)라, 그 표를 거꾸로 맞춰 phase 객체({ kind, msg, args })를 되살린다.
// 그래야 영어 화면에서도 지금 언어로 보이고, 응답 대기 사유(what)가 알림에 들어간다. 맞는 문구가 없으면 kind 의 기본 문구를 쓴다.
const PHASE_MSGS = {
  ended: ['ended'],
  done: ['done'],
  idle: ['idle', 'starting', 'firstInput', 'noPrompt', 'geminiLimited', 'agyOldNode'],
  waiting: ['waiting'],
  stopped: ['stopAuth', 'stopNetwork', 'stopApi'],
  tool: ['tool', 'shell', 'toolUnknown'],
  team: ['team'],
  think: ['think', 'working', 'steps', 'loading'],
  write: ['write'],
};
const FALLBACK_MSG = { tool: 'toolUnknown', think: 'working', stopped: 'stopApi' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templateRe = (tpl) => new RegExp(`^${escapeRe(tpl).replace(/\\\{(\w+)\\\}/g, '(?<$1>.+?)')}$`);
const AGENTS_RE = new RegExp(`^(.*) · ${escapeRe(STRINGS.ko['phase.agents']).replace(/\\\{n\\\}/, '(\\d+)')}$`);

export function phaseFrom(kind, text) {
  if (kind === 'unseen') kind = 'done';
  if (typeof kind !== 'string' || !Object.hasOwn(PHASE_MSGS, kind)) return null;
  let rest = cleanStr(text) ?? '';
  const args = {};
  const ag = AGENTS_RE.exec(rest);
  if (ag) {
    rest = ag[1];
    args.agents = Math.min(999, Number(ag[2]));
  }
  if (kind === 'waiting') {
    const head = STRINGS.ko['phase.waiting'];
    if (rest.startsWith(`${head} · `)) args.what = rest.slice(head.length + 3);
    return { kind, args };
  }
  for (const msg of PHASE_MSGS[kind]) {
    const m = templateRe(STRINGS.ko[`phase.${msg}`]).exec(rest);
    if (m) return { kind, ...(msg !== kind ? { msg } : {}), args: { ...m.groups, ...args } };
  }
  const msg = FALLBACK_MSG[kind];
  return { kind, ...(msg ? { msg } : {}), args };
}

function cleanTokens(t) {
  const o = obj(t);
  const opt = (v) => num(v);
  return { total: count(o.total), input: count(o.input), output: count(o.output), cacheRead: count(o.cacheRead), cacheWrite: count(o.cacheWrite), main: opt(o.main), sub: opt(o.sub), subCount: opt(o.subCount) };
}

function cleanFile(f) {
  const o = obj(f);
  const path = cleanStr(o.path, PATH_MAX);
  if (!path) return null;
  // 변경 내용(diff)은 받지 않는다. 상세 패널이 '원격 세션은 변경 내용 없음' 을 보이도록 remote 를 붙인다.
  return { path, created: o.created === true, edits: count(o.edits), add: count(o.writtenLines), del: count(o.deletedLines), at: time(o.updatedAt) ?? 0, agents: arr(o.agents, 10).map((x) => cleanStr(x, 60)).filter(Boolean), hunks: [], remote: true };
}

function cleanMember(m) {
  const o = obj(m);
  const name = cleanStr(o.name, 80);
  if (!name) return null;
  return {
    name,
    task: cleanStr(o.task),
    model: cleanStr(o.model, 80),
    status: MEMBER_STATUSES.has(o.status) ? o.status : 'done',
    phase: phaseFrom(o.phaseKind, o.phase),
    tokens: count(o.tokens),
    cost: num(o.cost),
    startedAt: time(o.startedAt),
    lastActivityAt: time(o.lastActivityAt),
  };
}

function cleanArtifact(a, i) {
  const o = obj(a);
  return { id: `r${i}`, title: cleanStr(o.title), url: artifactLink(o.url), from: num(o.versionFrom), to: num(o.versionTo), at: time(o.updatedAt) ?? 0, audience: cleanStr(o.audience, 20), edits: o.viaEdits === true };
}

// 원격 세션 하나를 허용 필드만으로 다시 만든다. 쓸 수 없으면 null.
// waitDetail·resumeCmd·pid·tools·usage 는 받지 않는다 (이어 열기는 resume.mjs 가 host·remoteId 로 다시 만든다).
export function cleanSession(raw, host) {
  const o = obj(raw);
  const remoteId = cleanStr(o.id);
  if (!remoteId || !TOOLS.has(o.tool)) return null;
  const status = STATUSES.has(o.status) ? o.status : 'idle';
  const stop = obj(o.stopReason);
  const ctx = obj(o.context);
  const phase = phaseFrom(o.phaseKind, o.phase);
  return {
    tool: o.tool,
    id: `${host}:${remoteId}`,
    remoteId,
    host,
    name: cleanStr(o.name),
    project: cleanStr(o.project),
    cwd: cleanStr(o.cwd, PATH_MAX),
    branch: cleanStr(o.branch),
    model: cleanStr(o.model, 80),
    kind: cleanStr(o.kind, 40),
    entrypoint: cleanStr(o.entrypoint, 40),
    source: SOURCES.has(o.source) ? o.source : null,
    auto: o.auto === true,
    live: o.live === true,
    status,
    phase: phase ?? (status === 'ended' ? { kind: 'ended' } : null),
    stopReason: STOP_KINDS.has(stop.kind) ? { kind: stop.kind } : null,
    cacheExpiresAt: time(o.cacheExpiresAt),
    toolStartedAt: time(o.toolStartedAt),
    waitingFor: cleanStr(o.waitingFor),
    now: cleanStr(o.now) ?? '',
    startedAt: time(o.startedAt),
    updatedAt: time(o.updatedAt),
    tokens: cleanTokens(o.tokens),
    cost: num(o.cost),
    costNoCache: num(o.costNoCache),
    costUnknown: o.costUnknown === true,
    context: { used: count(ctx.used), window: num(ctx.window) },
    files: arr(o.files, MAX_FILES).map(cleanFile).filter(Boolean),
    artifacts: arr(o.artifacts, MAX_ARTIFACTS).map(cleanArtifact),
    members: arr(o.members, MAX_MEMBERS).map(cleanMember).filter(Boolean),
  };
}

export function cleanSessions(json, host) {
  const seen = new Set();
  const out = [];
  for (const raw of arr(json?.sessions, MAX_SESSIONS)) {
    const s = cleanSession(raw, host);
    // 같은 id 가 두 번 오면 화면 선택이 꼬이므로 처음 것만 둔다.
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out.sort(bySession);
}

// ── 실행 ────────────────────────────────────────────────

// 원격 하나를 한 번 부른다. 돌려주는 값: { name, kind, ok, error, version, schema, at, sessions }. 거부하지 않는다.
// at 은 이번 호출이 끝난 시각 (실패면 null). opts.onChild 는 끝낼 때 죽일 수 있게 자식을 받는다.
export function runRemote(r, { timeoutMs = TIMEOUT_MS, exec = execFile, now = Date.now, onChild = () => {}, fake } = {}) {
  const [file, args] = remoteCommand(r, fake === undefined ? {} : { fake });
  return new Promise((resolve) => {
    let child;
    let timedOut = false;
    let timer;
    const done = (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err && timedOut) err.timedOut = true;
      const c = classify({ err, stdout, stderr });
      const base = { name: r.name, kind: r.kind, version: null, schema: null, at: null, sessions: [] };
      if (c.error) return resolve({ ...base, ok: false, error: c.error, version: c.version ?? null, schema: c.schema ?? null });
      resolve({ ...base, ok: true, error: null, version: cleanStr(c.json.version, 40), schema: c.json.schema, at: now(), sessions: cleanSessions(c.json, r.name) });
    };
    try {
      child = exec(file, args, { encoding: 'buffer', maxBuffer: MAX_BUFFER, windowsHide: true, shell: false }, done);
    } catch (err) {
      return done(err, '', '');
    }
    // 원격 aitop 은 입력을 읽지 않는다. 입력을 바로 닫아 ssh 가 기다리지 않게 한다.
    try {
      child?.stdin?.end();
    } catch {}
    onChild(child);
    // execFile 의 timeout 대신 직접 재서 SIGKILL 한다 (ssh 가 SIGTERM 을 받고도 접속을 붙잡는 경우가 있다).
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill('SIGKILL');
      } catch {}
    }, timeoutMs);
  });
}

// 이름 목록(설정 값)을 대상 목록으로. 잘못된 이름은 빼고, 같은 이름은 한 번만.
export function remoteTargets(names = []) {
  const out = new Map();
  for (const n of names ?? []) {
    const r = parseRemote(n);
    if (r && !out.has(r.name)) out.set(r.name, r);
  }
  return [...out.values()];
}

// 모든 원격을 병렬로 부르고, 원격마다 마지막 결과를 들고 있는 폴러.
// 실시간 화면: start() 가 바로 한 번, 그 뒤 intervalMs 마다 부른다. 앞 호출이 아직 돌고 있는 원격은 그 차례를 건너뛴다.
// --once·--json: pollAll() 이 모든 원격이 끝날 때까지 기다린다. stop() 은 타이머를 멈추고 돌고 있는 자식을 죽인다.
// 실패한 뒤에도 마지막으로 성공했을 때의 세션은 지우고(낡은 상태를 보이지 않게) 시각 at 은 남긴다.
export function createRemotePoller(targets, { intervalMs = INTERVAL_MS, timeoutMs = Number(process.env.AITOP_REMOTE_TIMEOUT_MS) > 0 ? Number(process.env.AITOP_REMOTE_TIMEOUT_MS) : TIMEOUT_MS, run = runRemote, onUpdate = () => {} } = {}) {
  const state = new Map(targets.map((r) => [r.name, { name: r.name, kind: r.kind, ok: false, error: null, pending: true, version: null, schema: null, at: null, sessions: [] }]));
  const inflight = new Map();
  const children = new Set();
  let timer = null;
  let stopped = false;

  const pollOne = (r) => {
    if (inflight.has(r.name)) return inflight.get(r.name);
    let mine = null;
    const p = run(r, {
      timeoutMs,
      onChild: (c) => {
        mine = c;
        if (c) children.add(c);
      },
    }).then((res) => {
      children.delete(mine);
      inflight.delete(r.name);
      if (stopped) return;
      const prev = state.get(r.name);
      state.set(r.name, { ...res, pending: false, at: res.ok ? res.at : prev.at });
      onUpdate();
    });
    inflight.set(r.name, p);
    return p;
  };
  const pollAll = () => Promise.all(targets.map(pollOne));

  return {
    pollAll,
    start() {
      pollAll();
      timer = setInterval(pollAll, intervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const c of children) {
        try {
          c.kill('SIGKILL');
        } catch {}
      }
      children.clear();
    },
    // 화면·--json 이 쓰는 지금 결과. statuses 는 원격 순서대로, sessions 는 원격 순서대로 이어 붙인다.
    snapshot() {
      const statuses = targets.map((r) => {
        const s = state.get(r.name);
        return { name: s.name, kind: s.kind, ok: s.ok, error: s.error, pending: s.pending, version: s.version, schema: s.schema, at: s.at, count: s.sessions.length };
      });
      return { statuses, sessions: targets.flatMap((r) => state.get(r.name).sessions) };
    },
  };
}
