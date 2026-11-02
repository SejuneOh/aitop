// 도구별 연결 점검: 기록 폴더를 찾았는지, 기록이 몇 개이고 언제 마지막으로 쓰였는지, 지금 몇 개가 실행 중인지,
// 가장 최근 기록을 읽을 수 있는지. aitop --doctor, 빈 화면, --json 의 tools 가 같은 결과를 쓴다.
// 기록 내용은 읽어 내보내지 않는다 (Gemini 는 형식 확인용으로 JSON 키 이름만 보인다).
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { findProcesses, isCodex, isGemini, canListProcesses, isAlive } from './procs.mjs';
import { fmtAgo, pad } from './text.mjs';

const UNIT = { s: '초', m: '분', h: '시간', d: '일' };
const ago = (ms) => fmtAgo(ms).replace(/[smhd]$/, (u) => UNIT[u]);

const HOME = homedir();
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, '.claude');
const CODEX = join(process.env.CODEX_HOME ?? join(HOME, '.codex'), 'sessions');
const GEMINI = join(process.env.GEMINI_HOME ?? join(HOME, '.gemini'), 'tmp');

const tilde = (p) => (p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
const ls = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// 폴더 아래 depth 단계까지 내려가며 조건에 맞는 파일을 모은다.
function walk(dir, depth, match, out = []) {
  for (const e of ls(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, match, out);
    else if (e.isFile() && match(e.name)) out.push(p);
  }
  return out;
}

function newest(files) {
  let best = null;
  for (const path of files) {
    try {
      const m = statSync(path).mtimeMs;
      if (!best || m > best.mtime) best = { path, mtime: m };
    } catch {}
  }
  return best;
}

// 파일 첫 줄(최대 64KB)이 JSON 으로 읽히면 true.
function firstLineIsJson(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    JSON.parse(first);
    return true;
  } catch {
    return false;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

// JSON 파일 맨 위 키 이름만 (값은 보지 않는다). 크면 앞 64KB 의 첫 줄로 대신한다.
function topKeys(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      obj = JSON.parse(text.split('\n')[0]);
    }
    if (Array.isArray(obj)) obj = obj[0];
    return obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 12) : [];
  } catch {
    return [];
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function claude() {
  const dir = join(CLAUDE, 'projects');
  const files = existsSync(dir) ? walk(dir, 1, (n) => n.endsWith('.jsonl')) : null;
  const last = files && newest(files);
  const running = canListProcesses()
    ? ls(join(CLAUDE, 'sessions')).filter((e) => /^\d+\.json$/.test(e.name) && isAlive(Number(e.name.split('.')[0]))).length
    : null;
  if (!files) return { tool: 'claude', state: 'missing', path: tilde(dir), records: 0, lastAt: null, running, readable: null, hint: 'claude 를 한 번 실행하면 생깁니다' };
  return { tool: 'claude', state: 'ok', path: tilde(dir), records: files.length, lastAt: last?.mtime ?? null, running, readable: last ? firstLineIsJson(last.path) : null, hint: null };
}

function codex() {
  const files = existsSync(CODEX) ? walk(CODEX, 3, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')) : null;
  const last = files && newest(files);
  const running = canListProcesses() ? findProcesses(isCodex).length : null;
  if (!files) return { tool: 'codex', state: 'missing', path: tilde(CODEX), records: 0, lastAt: null, running, readable: null, hint: 'codex 를 한 번 실행하면 생깁니다' };
  return { tool: 'codex', state: 'ok', path: tilde(CODEX), records: files.length, lastAt: last?.mtime ?? null, running, readable: last ? firstLineIsJson(last.path) : null, hint: null };
}

// Gemini 는 세션 기록 형식을 아직 모른다. 프로세스만 세고, 기록 폴더가 있으면 형식 확인용 키 이름을 남긴다.
function gemini() {
  const files = existsSync(GEMINI) ? walk(GEMINI, 3, (n) => n.endsWith('.json') || n.endsWith('.jsonl')) : null;
  const last = files && newest(files);
  return {
    tool: 'gemini',
    state: 'limited',
    path: tilde(GEMINI),
    found: Boolean(files),
    records: files?.length ?? 0,
    lastAt: last?.mtime ?? null,
    running: canListProcesses() ? findProcesses(isGemini).length : null,
    readable: null,
    keys: last ? topKeys(last.path) : [],
    hint: '프로세스만 감지합니다 (세션·토큰은 아직 지원하지 않음)',
  };
}

export function checkTools() {
  const tools = {};
  for (const fn of [claude, codex, gemini]) {
    const r = fn();
    tools[r.tool] = r;
  }
  return { platform: platform(), processes: canListProcesses(), tools };
}

// JSON 용: 시각은 ISO 문자열로.
export function toolsJson(tools) {
  if (!tools) return null;
  return Object.fromEntries(Object.entries(tools).map(([k, t]) => [k, { ...t, lastAt: t.lastAt ? new Date(t.lastAt).toISOString() : null }]));
}

// 점검 결과를 사람이 읽는 조각으로 바꾼다. 빈 화면과 --doctor 가 같은 문구를 쓴다.
export const MARK = { ok: '✓', missing: '✗', limited: '○' };
export const STATE_TEXT = { ok: '찾음', missing: '없음', limited: '일부 지원' };

export function describe(t, now = Date.now()) {
  const parts = [];
  if (t.found === false && t.state === 'limited') parts.push('기록 폴더 없음');
  else if (t.state !== 'missing') parts.push(`기록 ${t.records.toLocaleString('en-US')}개`);
  if (t.lastAt) parts.push(`마지막 ${ago(now - t.lastAt)} 전`);
  parts.push(t.running == null ? '실행 수 확인 불가 (/proc 없음)' : `실행 ${t.running}`);
  if (t.readable === false) parts.push('최근 기록 읽기 실패');
  if (t.keys?.length) parts.push(`키: ${t.keys.join(', ')}`);
  return { mark: MARK[t.state], state: STATE_TEXT[t.state], path: t.path, detail: parts.join(' · '), hint: t.hint };
}

// aitop --doctor 의 사람용 출력.
export function doctorText(result, version, now = Date.now()) {
  const os = `${result.platform}, 프로세스 ${result.processes ? '확인 가능' : '확인 불가'}`;
  const out = [`aitop ${version} 연결 점검 (${os})`, ''];
  for (const t of Object.values(result.tools)) {
    const d = describe(t, now);
    out.push(`${d.mark} ${pad(t.tool, 7)}${pad(d.state, 10)}${d.path}`);
    out.push(`         ${d.detail}`);
    if (d.hint) out.push(`         → ${d.hint}`);
  }
  return out.join('\n');
}
