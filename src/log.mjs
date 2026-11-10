// 디버그 로그: --debug (AITOP_DEBUG=1, 설정 파일 debug) 일 때만 $XDG_STATE_HOME/aitop/aitop.log 에 남긴다.
// 기록 형식이 바뀌어 값이 비는 원인을 찾기 위한 것이라, 오류 이름·코드와 짧은 맥락(출처, 파일 이름)만 쓴다.
// 기록 내용·도구 입력은 쓰지 않고, 쓰는 글은 모두 mask() 와 stripControl() 을 거친다.
// 꺼져 있으면 파일을 만들지 않고 debug() 는 바로 돌아간다.
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { mask, stripControl } from './text.mjs';

// 이 크기를 넘으면 aitop.log.1 로 옮기고 새로 쓴다 (이전 것 하나만 남긴다).
export const MAX_BYTES = 1024 * 1024;
// 같은 출처·같은 문구는 이 간격에 한 번만 쓴다.
export const REPEAT_MS = 60_000;
const MAX_KEYS = 1000;

export function logPath(env = process.env, home = homedir()) {
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state'), 'aitop', 'aitop.log');
}

let state = { on: false, path: null };

export const logState = () => ({ on: state.on, path: state.path });

// 오류에서 원인만 꺼낸다. JSON.parse 의 SyntaxError 문구에는 읽던 내용 일부가 들어가므로 이름만 쓴다.
function errText(err) {
  if (err == null) return '';
  if (typeof err !== 'object') return String(err);
  // node:sqlite 오류의 문구("database is locked", "no such table: …")는 SQLite 가 정한 말이라 함께 쓴다.
  if (err.code === 'ERR_SQLITE_ERROR') return [err.code, err.errcode, err.errstr, err.message].filter((x) => x != null && x !== '').join(' ').slice(0, 200);
  if (err.code) return [err.code, err.syscall].filter(Boolean).join(' ');
  if (err instanceof SyntaxError) return 'SyntaxError';
  return `${err.name ?? 'Error'}: ${err.message ?? ''}`;
}

const clean = (s, max) => mask(stripControl(String(s ?? '').replace(/[\r\n\t]+/g, ' '))).slice(0, max);

function openLog(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    // 예전에 다른 권한으로 만들어진 파일이어도 나만 읽게 한다.
    fchmodSync(fd, 0o600);
    return { fd, size: fstatSync(fd).size };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

// enabled 가 아니면 아무것도 만들지 않는다. now·maxBytes 는 테스트에서 바꿔 끼운다.
export function initLog({ enabled = false, path = logPath(), maxBytes = MAX_BYTES, now = Date.now, version = '' } = {}) {
  closeLog();
  state = { on: false, path };
  if (!enabled) return logState();
  try {
    const { fd, size } = openLog(path);
    state = { on: true, path, fd, size, maxBytes, now, seen: new Map() };
    write(`aitop ${clean(version, 40)} 디버그 로그 시작 (pid ${process.pid}, node ${process.versions.node})`);
  } catch (err) {
    state = { on: false, path, error: errText(err) };
  }
  return logState();
}

export function closeLog() {
  if (state.fd != null) {
    try {
      closeSync(state.fd);
    } catch {}
  }
  state = { on: false, path: state.path };
}

function write(text) {
  const line = Buffer.from(`${new Date(state.now()).toISOString()} ${text}\n`);
  if (state.size + line.length > state.maxBytes && state.size > 0) {
    closeSync(state.fd);
    state.fd = null;
    renameSync(state.path, state.path + '.1');
    Object.assign(state, openLog(state.path));
  }
  writeSync(state.fd, line);
  state.size += line.length;
}

// source: 'codex', 'claude' 처럼 어디서 났는지. message: 무엇이 실패했는지 (고정 문구). err: 잡은 오류. file: 경로면 파일 이름만 쓴다.
export function debug(source, message, err, file) {
  if (!state.on) return;
  try {
    const key = `${source}\0${message}`;
    const t = state.now();
    const prev = state.seen.get(key);
    if (prev && t - prev.at < REPEAT_MS) {
      prev.skipped++;
      return;
    }
    if (state.seen.size >= MAX_KEYS) state.seen.clear();
    state.seen.set(key, { at: t, skipped: 0 });
    const parts = [`[${clean(source, 32)}] ${clean(message, 200)}`];
    const why = errText(err);
    if (why) parts.push(`: ${clean(why, 300)}`);
    if (file) parts.push(` (${clean(basename(String(file)), 120)})`);
    if (prev?.skipped) parts.push(` (+${prev.skipped}번 생략)`);
    write(parts.join(''));
  } catch (e) {
    // 로그를 쓸 수 없으면 끄고 조용히 계속한다. 화면은 로그 때문에 멈추지 않는다.
    closeLog();
    state.error = errText(e);
  }
}

// 파일이 없거나(지워졌거나 아직 안 생김) 경로 중간이 폴더가 아닌 경우는 늘 있는 일이라 남기지 않는다.
const ROUTINE = new Set(['ENOENT', 'ENOTDIR']);
export function debugIo(source, message, err, file) {
  if (state.on && !ROUTINE.has(err?.code)) debug(source, message, err, file);
}
