// 도구별 연결 점검: 기록 폴더를 찾았는지, 기록이 몇 개이고 언제 마지막으로 쓰였는지, 지금 몇 개가 실행 중인지,
// 가장 최근 기록을 읽을 수 있는지. aitop --doctor, 빈 화면, --json 의 tools 가 같은 결과를 쓴다.
// 기록 내용은 읽어 내보내지 않는다 (Gemini 는 형식 확인용으로 JSON 키 이름만 보인다).
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { findProcesses, isCodex, isGemini, isAgy, canListProcesses, isAlive, isSessionAlive } from './procs.mjs';
import { AGY_ROOT } from './sources/antigravity.mjs';
import { loadSqlite, openReadOnly } from './sqlite.mjs';
import { fmtAgo, pad, stripControl } from './text.mjs';
import { BRAND } from './brand.mjs';
import { tildeIn } from './paths.mjs';
import { busProblem, findNotifier, isWsl } from './notify.mjs';
import { getLang, t as tr } from './i18n.mjs';
import { candidateDirs, claudeDirs, codexHomes } from './sources/dirs.mjs';

const UNIT = { s: '초', m: '분', h: '시간', d: '일' };
const ago = (ms) => fmtAgo(ms).replace(/[smhd]$/, (u) => UNIT[u]);

const HOME = homedir();
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

// 살아 있는 pid 의 세션 파일만 연다. 대기 프로세스(spare)와 pid 재사용은 세지 않는다.
function liveSessionFile(path) {
  try {
    const e = JSON.parse(readFileSync(path, 'utf8'));
    return !e.spare && isSessionAlive(e.pid, e.procStart);
  } catch {
    return false;
  }
}

// 기록 폴더 여러 개(#212)를 한 도구 결과로 모은다. 같은 기록(key 가 같은 파일)은 한 번만 센다.
// path 는 첫 폴더(예전 모양), dirs 는 읽는 폴더마다 { path, found, records }.
function gatherDirs(roots, list) {
  const dirs = [];
  const byKey = new Map();
  for (const root of roots) {
    const files = existsSync(root) ? list(root) : null;
    dirs.push({ path: tilde(root), found: Boolean(files), records: files?.length ?? 0 });
    for (const f of files ?? []) if (!byKey.has(f.key)) byKey.set(f.key, f.path);
  }
  const found = dirs.some((d) => d.found);
  const files = [...byKey.values()];
  const last = found ? newest(files) : null;
  return { found, path: dirs[0]?.path ?? '', dirs, records: files.length, lastAt: last?.mtime ?? null, readable: last ? firstLineIsJson(last.path) : null };
}

const claudeFiles = (dir) => walk(dir, 1, (n) => n.endsWith('.jsonl')).map((p) => ({ key: p.slice(dir.length), path: p }));
const codexFiles = (dir) => walk(dir, 3, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')).map((p) => ({ key: basename(p), path: p }));

// 읽지 않는 폴더 중 기록이 있는 것 (dirs.mjs candidateDirs). 기록 수만 센다.
function candidatesOf(paths, sub, list) {
  return paths.map((p) => ({ path: tilde(p), records: list(join(p, sub)).length })).filter((c) => c.records > 0);
}

function claude(cand) {
  const homes = claudeDirs();
  const g = gatherDirs(homes.map((h) => join(h, 'projects')), claudeFiles);
  let running = null;
  if (canListProcesses()) {
    running = 0;
    for (const h of homes) running += ls(join(h, 'sessions')).filter((e) => /^\d+\.json$/.test(e.name) && isAlive(Number(e.name.split('.')[0])) && liveSessionFile(join(h, 'sessions', e.name))).length;
  }
  const candidates = candidatesOf(cand, 'projects', claudeFiles);
  if (!g.found) return { tool: 'claude', state: 'missing', path: g.path, dirs: g.dirs, candidates, records: 0, lastAt: null, running, readable: null, hint: null };
  return { tool: 'claude', state: 'ok', path: g.path, dirs: g.dirs, candidates, records: g.records, lastAt: g.lastAt, running, readable: g.readable, hint: null };
}

function codex(cand) {
  const g = gatherDirs(codexHomes().map((h) => join(h, 'sessions')), codexFiles);
  const running = canListProcesses() ? findProcesses(isCodex).length : null;
  const candidates = candidatesOf(cand, 'sessions', codexFiles);
  if (!g.found) return { tool: 'codex', state: 'missing', path: g.path, dirs: g.dirs, candidates, records: 0, lastAt: null, running, readable: null, hint: null };
  return { tool: 'codex', state: 'ok', path: g.path, dirs: g.dirs, candidates, records: g.records, lastAt: g.lastAt, running, readable: g.readable, hint: null };
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

// home: 후보 폴더를 찾을 홈 폴더 (테스트에서 바꿔 끼운다).
export function checkTools({ home = HOME } = {}) {
  const cand = candidateDirs({ home });
  const tools = {};
  for (const fn of [claude, codex, gemini, agy]) {
    const r = fn === claude ? claude(cand.claude) : fn === codex ? codex(cand.codex) : fn();
    r.hint = hintOf(r, 'ko');
    tools[r.tool] = r;
  }
  const con = consoleCheck();
  return { platform: platform(), processes: canListProcesses(), tools, notifier: notifierCheck(), ...(con ? { console: con } : {}) };
}

// Windows 의 터미널이 구형 콘솔(conhost)로 보이는지. Windows Terminal(WT_SESSION), VS Code·WezTerm(TERM_PROGRAM),
// ConEmu(ConEmuANSI), mintty 같은 TERM 을 넣는 터미널이면 아니라고 본다. win32 가 아니면 null.
// 구형 콘솔의 기본 글꼴에는 ▕█░ 막대와 점자(⠋, 로고 ⣠⣴⣾)가 없어 네모로 보일 수 있다 (#198).
export function consoleCheck({ platform: plat = platform(), env = process.env } = {}) {
  if (plat !== 'win32') return null;
  const modern = Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI || env.TERM);
  return { legacy: !modern };
}

// 알림 도구와, notify-send 면 D-Bus 세션 버스를 찾을 수 있는지 (#250). 알림을 실제로 보내 보지는 않는다.
// bus: 문제가 있을 때만 { reason, path? }. 테스트에서 platform·env·wsl·exists 를 바꿔 끼운다.
export function notifierCheck({ platform: plat = platform(), env = process.env, wsl = plat === 'linux' && isWsl(env), exists } = {}) {
  const n = findNotifier({ platform: plat, env, wsl });
  if (!n) return null;
  const bus = n.kind === 'notify-send' ? busProblem(env, exists) : null;
  return { kind: n.kind, path: tilde(n.path), ...(bus ? { bus: bus.path ? { ...bus, path: tilde(bus.path) } : bus } : {}) };
}

// --notify 에 쓸 데스크톱 알림 도구. 알림이 뜨지 않을 것이 확실하면 ! 와 안내 줄(→)을 붙인다.
export function notifierText(n, plat = platform(), lang = getLang(), wsl = plat === 'linux' && isWsl()) {
  const o = { lang };
  const hint = (k) => `         → ${tr(k, null, o)}`;
  if (n?.bus) {
    const why = n.bus.reason === 'socket' ? tr('doctor.busSocket', { path: n.bus.path }, o) : tr('doctor.busMissing', null, o);
    const out = [tr('doctor.busBad', { kind: n.kind, path: n.path, why }, o), hint('doctor.busHint')];
    if (wsl) out.push(hint('doctor.wslHint'));
    return out.join('\n');
  }
  if (n) return tr('doctor.notifier', { kind: n.kind, path: n.path }, o);
  if (wsl) return [tr('doctor.noNotifierWsl', null, o), hint('doctor.wslHint')].join('\n');
  const want = plat === 'darwin' ? 'osascript' : 'notify-send';
  return tr('doctor.noNotifier', { want }, o);
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
    // 기록 폴더가 여럿이면 둘째부터 한 줄씩, 읽지 않는 후보 폴더는 넣는 방법과 함께 (#212).
    for (const x of t.dirs?.slice(1) ?? []) out.push(`  + ${pad('', 15)}${x.path}  ${x.found ? tr('doctor.records', { n: x.records.toLocaleString('en-US') }, o) : tr('doctor.dirMissing', null, o)}`);
    out.push(`         ${d.detail}`);
    if (d.hint) out.push(`         → ${d.hint}`);
    if (t.candidates?.length) {
      for (const c of t.candidates) out.push(`         ? ${tr('doctor.candidate', { path: c.path, n: c.records.toLocaleString('en-US') }, o)}`);
      out.push(`         → ${tr(t.tool === 'claude' ? 'doctor.candidateHintClaude' : 'doctor.candidateHintCodex', null, o)}`);
    }
  }
  if ('notifier' in result) out.push('', notifierText(result.notifier, result.platform, lang));
  if (result.console?.legacy) out.push('', tr('doctor.legacyConsole', null, o), `         → ${tr('doctor.legacyConsoleHint', null, o)}`);
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
