// 실행 중인 AI CLI 프로세스와 그 작업 폴더를 찾는다.
// Linux·WSL 은 /proc 를 읽고, macOS 는 ps 와 lsof 를 부른다. 그 밖의 OS 는 프로세스를 세지 못한다.
import { readdirSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { exeName } from './paths.mjs';

const OS = platform();
const HAS_PROC = existsSync('/proc/self');

export function canListProcesses() {
  return HAS_PROC || OS === 'darwin';
}

// 신호 0 은 보내지 않고 프로세스가 있는지만 본다. 다른 사용자 프로세스면 EPERM 이지만 살아 있다.
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// ps 는 인자를 공백으로만 이어 보여 준다. 앞 두 칸(실행 파일, node 스크립트)이 없는 절대 경로면
// 실제로 있는 경로가 될 때까지 뒤 토큰을 이어 붙인다 (예: ~/Library/Application Support/…/codex.js).
// 절대 경로: /… 또는 드라이브 문자(C:\…, C:/…).
const isAbs = (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

export function joinPaths(tokens, exists = existsSync) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let cur = tokens[i++];
    if (out.length < 2 && isAbs(cur) && !exists(cur)) {
      let j = i;
      let joined = cur;
      while (j < tokens.length && j - i < 8) {
        joined += ' ' + tokens[j++];
        if (exists(joined)) {
          cur = joined;
          i = j;
          break;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

// ps -axo pid=,command= 출력을 { pid, argv } 목록으로.
export function parsePs(text, exists = existsSync) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), argv: joinPaths(m[2].trim().split(/\s+/), exists) });
  }
  return out;
}

// lsof -a -p PID -d cwd -Fn 출력에서 n 으로 시작하는 줄이 작업 폴더다.
export function parseLsofCwd(text) {
  return /^n(.+)$/m.exec(String(text))?.[1] ?? null;
}

const run = (cmd, args, env) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, env });

function listProc() {
  const list = [];
  let pids = [];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {}
  for (const pid of pids) {
    let argv;
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (argv.length) list.push({ pid: Number(pid), argv });
  }
  return list;
}

function listPs() {
  try {
    return parsePs(run('ps', ['-axww', '-o', 'pid=,command=']));
  } catch {
    return [];
  }
}

// 한 번의 갱신 안에서 여러 도구가 각각 훑지 않도록 결과를 재사용한다. ps 는 프로세스를 띄우므로 더 길게 둔다.
const SCAN_TTL_MS = HAS_PROC ? 500 : 2000;
let scan = { at: 0, list: [] };

function scanAll() {
  if (Date.now() - scan.at < SCAN_TTL_MS) return scan.list;
  const list = (HAS_PROC ? listProc() : OS === 'darwin' ? listPs() : []).filter((p) => p.pid !== process.pid);
  scan = { at: Date.now(), list };
  return list;
}

// macOS 의 작업 폴더는 lsof 로 얻는다. 프로세스마다 바뀌는 일이 드물어 pid 별로 기억한다.
const cwdCache = new Map();

function cwdOf(pid) {
  if (HAS_PROC) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (OS !== 'darwin') return null;
  if (cwdCache.has(pid)) return cwdCache.get(pid);
  let cwd = null;
  try {
    cwd = parseLsofCwd(run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']));
  } catch {}
  // 실패(lsof 없음, 시간 초과)는 기억하지 않고 다음 갱신에 다시 묻는다.
  if (cwd) cwdCache.set(pid, cwd);
  return cwd;
}

// 작업 폴더는 일치한 프로세스만 읽는다.
export function findProcesses(match) {
  const all = scanAll();
  const found = all.filter((p) => match(p.argv));
  // 끝난 프로세스의 pid 는 다른 프로세스가 다시 쓸 수 있으니, 지금 목록에 없는 pid 의 작업 폴더는 잊는다.
  const alive = new Set(all.map((p) => p.pid));
  for (const pid of cwdCache.keys()) if (!alive.has(pid)) cwdCache.delete(pid);
  for (const pid of startCache.keys()) if (!alive.has(pid)) startCache.delete(pid);
  return found.map((p) => ({ ...p, cwd: cwdOf(p.pid) }));
}

// 실행 파일 이름 (paths.mjs exeName). Windows 에서만 \ 도 나누고 .exe·.cmd 등을 뗀다 (codex.cmd, agy.exe).
const base = (p) => exeName(p);

// `codex` 는 node 스크립트(…/bin/codex.js)이거나 네이티브 바이너리(codex-*)로 뜬다.
export function isCodex(argv) {
  return argv.slice(0, 2).some((a) => /^codex(\.js)?$/.test(base(a)) || /^codex-[\w-]+$/.test(base(a)));
}

export function isGemini(argv) {
  return argv.slice(0, 2).some((a) => /^gemini(\.js)?$/.test(base(a)));
}

// Antigravity CLI 는 Go 실행 파일 하나(`agy`)로 뜬다.
export function isAgy(argv) {
  return argv.length > 0 && base(argv[0]) === 'agy';
}

// 프로세스가 열어 둔 파일 경로들. Linux·WSL 의 /proc 에서만 알 수 있고, 그 밖의 OS 나 읽을 권한이 없으면 null.
export function openFiles(pid) {
  if (!HAS_PROC) return null;
  let fds;
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return null;
  }
  const out = [];
  for (const fd of fds) {
    try {
      out.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
    } catch {}
  }
  return out;
}

let ticksPerSec = null;
let bootMs = null;

// /proc/<pid>/stat 의 22번째 칸은 부팅 뒤 지난 시간(클럭 틱)이다. 명령 이름에 공백·괄호가 들 수 있어 마지막 ')' 뒤부터 센다.
export function parseStartTicks(stat) {
  const s = String(stat);
  const end = s.lastIndexOf(')');
  if (end < 0) return null;
  const ticks = Number(s.slice(end + 2).split(' ')[19]);
  return Number.isFinite(ticks) ? ticks : null;
}

// /proc/<pid>/stat 원문을 읽는다. /proc 가 없는 OS 는 null. 테스트는 _setStatReader 로 바꾼다.
let readStat = HAS_PROC ? (pid) => readFileSync(`/proc/${pid}/stat`, 'utf8') : null;

export function _setStatReader(fn) {
  const prev = readStat;
  readStat = fn;
  return prev;
}

// 프로세스 시작 시각(부팅 뒤 클럭 틱). 알 수 없으면 null.
export function startTicks(pid) {
  if (!readStat) return null;
  try {
    return parseStartTicks(readStat(pid));
  } catch {
    return null;
  }
}

function procStartLinux(pid) {
  if (bootMs === null) {
    const m = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
    if (!m) return null;
    bootMs = Number(m[1]) * 1000;
  }
  if (ticksPerSec === null) {
    try {
      ticksPerSec = Number(run('getconf', ['CLK_TCK']).trim()) || 100;
    } catch {
      ticksPerSec = 100;
    }
  }
  const ticks = parseStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  return ticks !== null ? bootMs + (ticks / ticksPerSec) * 1000 : null;
}

// 세션 파일의 procStart(부팅 뒤 클럭 틱, 문자열)와 지금 그 pid 의 시작 시각을 비교한다.
// pid 를 다른 프로세스가 다시 쓰면 시작 시각이 다르다. 틱 단위로 비교해 btime 흔들림(WSL)의 영향을 받지 않는다.
// procStart 가 없거나 /proc 를 못 읽으면 알 수 없으므로 같은 프로세스로 본다 (예전 동작).
const START_TOLERANCE_TICKS = 100;

export function sameProcess(pid, procStart) {
  const want = Number(procStart);
  if (procStart == null || procStart === '' || !Number.isFinite(want)) return true;
  const got = startTicks(pid);
  if (got === null) return true;
  return Math.abs(got - want) <= START_TOLERANCE_TICKS;
}

// 세션 파일의 주인 프로세스가 아직 살아 있는지 (pid 재사용 제외).
export function isSessionAlive(pid, procStart) {
  return isAlive(pid) && sameProcess(pid, procStart);
}

// 프로세스가 시작한 시각(ms). 알 수 없으면 null. 시작 시각은 바뀌지 않으므로 pid 별로 기억한다.
const startCache = new Map();

export function processStart(pid) {
  if (startCache.has(pid)) return startCache.get(pid);
  let at = null;
  try {
    if (HAS_PROC) at = procStartLinux(pid);
    // lstart 는 로케일에 따라 요일·달 이름이 바뀌므로 영어(C) 로케일로 받는다.
    else if (OS === 'darwin') at = Date.parse(run('ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, LC_ALL: 'C', LANG: 'C' }).trim()) || null;
  } catch {}
  if (at !== null) startCache.set(pid, at);
  return at;
}
