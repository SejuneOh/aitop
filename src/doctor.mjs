// 도구별 연결 점검: 기록 폴더를 찾았는지, 기록이 몇 개이고 언제 마지막으로 쓰였는지, 지금 몇 개가 실행 중인지,
// 가장 최근 기록을 읽을 수 있는지. aitop --doctor, 빈 화면, --json 의 tools 가 같은 결과를 쓴다.
// 기록 내용은 읽어 내보내지 않는다 (Gemini 는 형식 확인용으로 JSON 키 이름만 보인다).
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { findProcesses, isCodex, isGemini, isAgy, canListProcesses, isAlive } from './procs.mjs';
import { AGY_ROOT } from './sources/antigravity.mjs';
import { loadSqlite, openReadOnly } from './sqlite.mjs';
import { fmtAgo, pad, stripControl } from './text.mjs';
import { BRAND } from './brand.mjs';
import { tildeIn } from './paths.mjs';
import { findNotifier, isWsl } from './notify.mjs';
import { getLang, t as tr } from './i18n.mjs';

const UNIT = { s: '초', m: '분', h: '시간', d: '일' };
const ago = (ms) => fmtAgo(ms).replace(/[smhd]$/, (u) => UNIT[u]);

const HOME = homedir();
const CLAUDE = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, '.claude');
const CODEX = join(process.env.CODEX_HOME ?? join(HOME, '.codex'), 'sessions');
const GEMINI = join(process.env.GEMINI_HOME ?? join(HOME, '.gemini'), 'tmp');

// Windows 는 \ 와 대소문자를 무시하고 줄인다 (paths.mjs).
const tilde = (p) => tildeIn(p, HOME);
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

// 파일 첫 줄이 JSON 으로 읽히면 true, 아니면 false. 비어 있거나 첫 줄이 64KB 를 넘으면 판정하지 않는다(null).
function firstLineIsJson(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const end = text.indexOf('\n');
    if (!n || (end < 0 && n === buf.length)) return null;
    JSON.parse(end < 0 ? text : text.slice(0, end));
    return true;
  } catch {
    return false;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

// 키 이름도 사용자 글이나 경로일 수 있으므로 식별자처럼 생긴 것만 보인다.
const KEY_NAME = /^[A-Za-z_][\w.-]{0,40}$/;

// JSON 파일 맨 위 키 이름만 (값은 보지 않는다). 앞 64KB 로 읽지 못하면(큰 파일) 맨 위 수준 들여쓰기의 "키": 줄에서 찾는다.
function topKeys(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    let keys;
    try {
      let obj = JSON.parse(text);
      if (Array.isArray(obj)) obj = obj[0];
      keys = obj && typeof obj === 'object' ? Object.keys(obj) : [];
    } catch {
      try {
        keys = Object.keys(JSON.parse(text.split('\n')[0]));
      } catch {
        keys = [...text.matchAll(/^ {0,2}\t?"([^"\n]{1,60})"\s*:/gm)].map((m) => m[1]);
      }
    }
    return [...new Set(keys)].filter((k) => KEY_NAME.test(k)).slice(0, 12);
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
  if (!files) return { tool: 'claude', state: 'missing', path: tilde(dir), records: 0, lastAt: null, running, readable: null, hint: null };
  return { tool: 'claude', state: 'ok', path: tilde(dir), records: files.length, lastAt: last?.mtime ?? null, running, readable: last ? firstLineIsJson(last.path) : null, hint: null };
}

function codex() {
  const files = existsSync(CODEX) ? walk(CODEX, 3, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')) : null;
  const last = files && newest(files);
  const running = canListProcesses() ? findProcesses(isCodex).length : null;
  if (!files) return { tool: 'codex', state: 'missing', path: tilde(CODEX), records: 0, lastAt: null, running, readable: null, hint: null };
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
    hint: null,
  };
}

// Antigravity CLI: 요약 DB 를 열어 대화 목록을 읽을 수 있는지 본다. node:sqlite 가 없으면 프로세스만 센다.
function agy() {
  const dir = join(AGY_ROOT, 'conversations');
  const running = canListProcesses() ? findProcesses(isAgy).length : null;
  const files = existsSync(dir) ? walk(dir, 0, (n) => n.endsWith('.db')) : null;
  if (!files) return { tool: 'agy', state: 'missing', path: tilde(AGY_ROOT), records: 0, lastAt: null, running, readable: null, hint: null };
  const last = newest(files.flatMap((f) => [f, `${f}-wal`]).filter((f) => existsSync(f)));
  if (!loadSqlite()) return { tool: 'agy', state: 'limited', path: tilde(AGY_ROOT), records: files.length, lastAt: last?.mtime ?? null, running, readable: null, hint: null };
  let readable = false;
  let db;
  try {
    db = openReadOnly(join(AGY_ROOT, 'conversation_summaries.db'));
    db.prepare('select count(*) n from conversation_summaries').get();
    readable = true;
  } catch {
  } finally {
    db?.close();
  }
  return { tool: 'agy', state: 'ok', path: tilde(AGY_ROOT), records: files.length, lastAt: last?.mtime ?? null, running, readable, hint: null };
}

// 도구별 안내 한 줄. 없으면 null. 점검 결과(--json 의 tools.*.hint)에는 예전처럼 한국어로 넣고, --doctor 글은 지금 언어로 다시 만든다.
export function hintOf(r, lang = 'ko') {
  const o = { lang };
  if (r.tool === 'gemini') return tr('doctor.hint.gemini', null, o);
  if (r.state === 'missing') return r.tool === 'agy' ? tr('doctor.hint.agyMissing', null, o) : tr('doctor.hint.missing', { tool: r.tool }, o);
  if (r.tool === 'agy' && r.state === 'limited') return tr('doctor.hint.agyNode', { node: process.versions.node }, o);
  return null;
}

export function checkTools() {
  const tools = {};
  for (const fn of [claude, codex, gemini, agy]) {
    const r = fn();
    r.hint = hintOf(r, 'ko');
    tools[r.tool] = r;
  }
  const n = findNotifier();
  return { platform: platform(), processes: canListProcesses(), tools, notifier: n ? { kind: n.kind, path: tilde(n.path) } : null };
}

// --notify 에 쓸 데스크톱 알림 도구.
export function notifierText(n, plat = platform(), lang = getLang()) {
  const o = { lang };
  if (n) return tr('doctor.notifier', { kind: n.kind, path: n.path }, o);
  const want = plat === 'darwin' ? 'osascript' : 'notify-send';
  const wsl = plat === 'linux' && isWsl() ? tr('doctor.wsl', null, o) : '';
  return tr('doctor.noNotifier', { want, wsl }, o);
}

// JSON 용: 시각은 ISO 문자열로.
export function toolsJson(tools) {
  if (!tools) return null;
  return Object.fromEntries(Object.entries(tools).map(([k, t]) => [k, { ...t, lastAt: t.lastAt ? new Date(t.lastAt).toISOString() : null }]));
}

// 점검 결과를 사람이 읽는 조각으로 바꾼다. 빈 화면과 --doctor 가 같은 문구를 쓴다.
export const MARK = { ok: '✓', missing: '✗', limited: '○' };
export const STATE_TEXT = { ok: '찾음', missing: '없음', limited: '일부 지원' };

// lang: 빈 화면(세션 없을 때의 점검 줄)과 --doctor 모두 지금 언어가 기본이다.
export function describe(t, now = Date.now(), lang = getLang()) {
  const o = { lang };
  const parts = [];
  if (t.found === false && t.state === 'limited') parts.push(tr('doctor.noFolder', null, o));
  else if (t.state !== 'missing') parts.push(tr('doctor.records', { n: t.records.toLocaleString('en-US') }, o));
  if (t.lastAt) parts.push(tr('doctor.last', { ago: lang === 'ko' ? ago(now - t.lastAt) : fmtAgo(now - t.lastAt) }, o));
  parts.push(t.running == null ? tr('doctor.runningUnknown', null, o) : tr('doctor.running', { n: t.running }, o));
  if (t.readable === false) parts.push(tr('doctor.unreadable', null, o));
  if (t.keys?.length) parts.push(tr('doctor.keys', { keys: t.keys.join(', ') }, o));
  // 한국어 안내는 점검 결과에 든 그대로, 다른 언어는 같은 조건으로 다시 만든다.
  const hint = lang === 'ko' || !t.hint ? t.hint : (hintOf(t, lang) ?? t.hint);
  return { mark: MARK[t.state], state: lang === 'ko' ? STATE_TEXT[t.state] : tr(`doctor.state.${t.state}`, null, { lang, short: true }), path: t.path, detail: parts.join(' · '), hint };
}

// aitop --doctor 의 사람용 출력.
export function doctorText(result, version, now = Date.now(), lang = getLang()) {
  const o = { lang };
  const os = tr('doctor.os', { platform: result.platform, state: tr(result.processes ? 'doctor.procsOk' : 'doctor.procsNo', null, o) }, o);
  const out = [tr('doctor.title', { logo: BRAND.logo, version, os }, o), ''];
  for (const t of Object.values(result.tools)) {
    const d = describe(t, now, lang);
    out.push(`${d.mark} ${pad(t.tool, 7)}${pad(d.state, 10)}${d.path}`);
    out.push(`         ${d.detail}`);
    if (d.hint) out.push(`         → ${d.hint}`);
  }
  if ('notifier' in result) out.push('', notifierText(result.notifier, result.platform, lang));
  // 설정 파일: 무시한 키와 값, 받지 않은 onWaiting 을 알린다.
  const cfg = result.config;
  if (cfg) {
    const state = pad(tr(cfg.exists ? 'doctor.configExists' : 'doctor.configMissing', null, o), 10);
    out.push('', tr('doctor.config', { mark: cfg.problems.length ? '!' : '✓', state, path: tilde(cfg.path) }, o));
    for (const p of cfg.problems) out.push(`         ! ${p}`);
  }
  if (result.log) {
    const on = result.log.on;
    out.push('', tr('doctor.debug', { mark: on ? '✓' : '○', state: pad(tr(on ? 'doctor.debugOn' : 'doctor.debugOff', null, o), 10), path: tilde(result.log.path), tail: on ? '' : tr('doctor.debugTail', null, o) }, o));
  }
  return stripControl(out.join('\n'));
}
