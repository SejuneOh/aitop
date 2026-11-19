// 실행 중인 AI CLI 프로세스와 그 작업 폴더를 찾는다.
// Linux·WSL 은 /proc 를 읽고, macOS 는 ps 와 lsof 를 부른다. Windows 는 PowerShell CIM(Win32_Process)을 부르고
// 작업 폴더는 얻지 않는다 (#195). 그 밖의 OS 는 프로세스를 세지 못한다.
import { readdirSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { platform } from 'node:os';
import { exeName } from './paths.mjs';
import { windowsPowerShell } from './notify.mjs';

const OS = platform();
const HAS_PROC = existsSync('/proc/self');

// Windows 프로세스 목록기 (createWinScanner). win32 에서만 만들고, 테스트는 _setWinScanner 로 끼운다.
let win = null;

export function _setWinScanner(scanner) {
  const prev = win;
  win = scanner;
  return prev;
}

// Windows 는 CIM 호출이 실패하면(PowerShell 없음, 막힘) false 가 되어, Codex 는 최근 기록으로 판정하는 예전 방식으로 돌아간다.
export function canListProcesses() {
  if (win) return win.ok();
  return HAS_PROC || OS === 'darwin';
}

// --doctor 에 보일 프로세스 목록 방식. Windows 는 { kind: 'cim', ms } (마지막 CIM 호출에 걸린 시간), 그 밖은 null.
// 목록을 얻지 못했으면 error 에 이유('timeout' · 'error')를 붙인다.
export function processMethod() {
  if (!win) return null;
  const error = win.error?.() ?? null;
  return { kind: 'cim', ms: win.ms(), ...(error ? { error } : {}) };
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

// ps -axo pid=,command= 출력을 { pid, argv } 목록으로. withPpid 면 pid 다음 칸을 부모 pid 로 읽는다 (-o pid=,ppid=,command=).
export function parsePs(text, exists = existsSync, withPpid = false) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = withPpid ? /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line) : /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const cmd = withPpid ? m[3] : m[2];
    out.push({ pid: Number(m[1]), ...(withPpid ? { ppid: Number(m[2]) } : {}), argv: joinPaths(cmd.trim().split(/\s+/), exists) });
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
    // 부모 pid 도 같은 호출로 받는다 (claude -p 실행의 부모 세션 찾기, parentPid). 프로세스 호출 수는 그대로다.
    return parsePs(run('ps', ['-axww', '-o', 'pid=,ppid=,command=']), existsSync, true);
  } catch {
    return [];
  }
}

// 한 번의 갱신 안에서 여러 도구가 각각 훑지 않도록 결과를 재사용한다. ps 는 프로세스를 띄우므로 더 길게 둔다.
// Windows 는 목록기가 따로 기억한다 (WIN_SCAN_TTL_MS).
const SCAN_TTL_MS = HAS_PROC ? 500 : 2000;
let scan = { at: 0, list: [] };

function scanAll() {
  if (win) return win.list().filter((p) => p.pid !== process.pid);
  if (Date.now() - scan.at < SCAN_TTL_MS) return scan.list;
  const list = (HAS_PROC ? listProc() : OS === 'darwin' ? listPs() : []).filter((p) => p.pid !== process.pid);
  scan = { at: Date.now(), list };
  return list;
}

// macOS 의 작업 폴더는 lsof 로 얻는다. 프로세스마다 바뀌는 일이 드물어 pid 별로 기억한다.
const cwdCache = new Map();

function cwdOf(pid) {
  if (win) return null;
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
// Windows 는 작업 폴더를 모르므로 cwd: null, cwdUnknown: true 로 돌려준다 (Codex 는 시작 시각으로 짝짓는다).
// 같은 도구가 자식을 띄우면(node codex.js → codex-*.exe) 둘 다 맞으므로, 부모도 맞는 프로세스는 빼고 맨 위 하나만 센다.
// Windows 는 부모가 끝난 뒤 그 pid 를 다른 프로세스가 다시 쓸 수 있으므로, 부모가 자식보다 먼저 뜬 경우만 부모로 본다.
export function findProcesses(match) {
  const all = scanAll();
  if (win) {
    const hit = all.filter((p) => match(p.argv));
    const byPid = new Map(hit.map((p) => [p.pid, p]));
    const isChild = (p) => {
      const parent = byPid.get(p.ppid);
      return Boolean(parent) && parent.start != null && p.start != null && parent.start <= p.start;
    };
    return hit.filter((p) => !isChild(p)).map((p) => ({ pid: p.pid, argv: p.argv, cwd: null, cwdUnknown: true }));
  }
  const found = all.filter((p) => match(p.argv));
  // 끝난 프로세스의 pid 는 다른 프로세스가 다시 쓸 수 있으니, 지금 목록에 없는 pid 의 작업 폴더는 잊는다.
  const alive = new Set(all.map((p) => p.pid));
  for (const pid of cwdCache.keys()) if (!alive.has(pid)) cwdCache.delete(pid);
  for (const pid of startCache.keys()) if (!alive.has(pid)) startCache.delete(pid);
  return found.map((p) => ({ ...p, cwd: cwdOf(p.pid) }));
}

// 실행 파일 이름 (paths.mjs exeName). Windows 에서만 \ 도 나누고 .exe·.cmd 등을 뗀다 (codex.cmd, agy.exe).
// Windows 목록기를 쓰는 동안(테스트가 끼운 것 포함)은 Windows 규칙으로 읽는다.
const base = (p) => exeName(p, win ? 'win32' : process.platform);

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

// /proc/<pid>/stat 의 4번째 칸은 부모 pid 다 (parseStartTicks 와 같이 마지막 ')' 뒤부터 센다). 모르면 null.
export function parsePpid(stat) {
  const s = String(stat);
  const end = s.lastIndexOf(')');
  if (end < 0) return null;
  const n = Number(s.slice(end + 2).split(' ')[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 부모 pid 를 OS 별 재료에서 고른다. 테스트가 세 갈래를 모두 부를 수 있게 재료를 받는다.
//   linux: /proc/<pid>/stat 원문을 주는 readStat. darwin: ps 목록(scanAll, ppid 칸 포함). win32: CIM 목록기(ppidOf).
export function parentPidFrom(pid, { os, readStat: rs, list, scanner }) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    if (os === 'win32') return scanner?.ppidOf?.(pid) ?? null;
    if (os === 'linux') return rs ? parsePpid(rs(pid)) : null;
    if (os === 'darwin') return list?.().find((p) => p.pid === pid)?.ppid ?? null;
  } catch {}
  return null;
}

// 지금 프로세스 정보로 부모 pid. 새 프로세스를 띄우지 않는다: Linux 는 파일 읽기, macOS 는 이미 받는 ps 목록, Windows 는 CIM 목록.
export function parentPid(pid) {
  const os = win ? 'win32' : readStat ? 'linux' : OS === 'darwin' ? 'darwin' : null;
  return parentPidFrom(pid, { os, readStat, list: scanAll, scanner: win });
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

// Windows: 클럭 틱이 없으므로 세션 파일에 마지막으로 쓰인 시각(writtenAt: updatedAt, 없으면 startedAt, ms)과
// CIM 의 시작 시각을 비교한다. 세션 파일은 그 프로세스가 뜬 뒤에 쓰므로, 지금 그 pid 의 프로세스가 마지막 기록보다
// 늦게 시작했으면(허용 오차 밖) 다른 프로세스가 pid 를 다시 쓴 것이다. startedAt 이 이어 연 세션의 처음 시각이어도 틀리지 않는다.
export const WIN_START_TOLERANCE_MS = 5000;

export function sameProcess(pid, procStart, writtenAt) {
  if (win) {
    const at = win.startOf(pid);
    if (at == null || !Number.isFinite(writtenAt)) return true;
    return at <= writtenAt + WIN_START_TOLERANCE_MS;
  }
  const want = Number(procStart);
  if (procStart == null || procStart === '' || !Number.isFinite(want)) return true;
  const got = startTicks(pid);
  if (got === null) return true;
  return Math.abs(got - want) <= START_TOLERANCE_TICKS;
}

// 세션 파일의 주인 프로세스가 아직 살아 있는지 (pid 재사용 제외). writtenAt 은 Windows 에서만 쓴다 (sameProcess).
export function isSessionAlive(pid, procStart, writtenAt) {
  return isAlive(pid) && sameProcess(pid, procStart, writtenAt);
}

// 프로세스가 시작한 시각(ms). 알 수 없으면 null. 시작 시각은 바뀌지 않으므로 pid 별로 기억한다.
const startCache = new Map();

export function processStart(pid) {
  if (win) return win.startOf(pid);
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

// ---- Windows: PowerShell CIM (#195) ----
// Get-CimInstance Win32_Process 를 한 번 불러 모든 프로세스의 pid·부모·이름·명령줄·시작 시각을 받는다 (wmic 는 Windows 11 에서 빠졌다).
// PowerShell 을 띄우는 데만 0.3초 남짓, 전체 1초 가까이 걸리므로:
// - 첫 호출만 기다려 받고(--once·--json·--doctor 가 바로 쓰게), 그 뒤에는 WIN_SCAN_TTL_MS 마다 뒤에서 새로 받으며 그동안 직전 목록을 쓴다.
// - 한 번에 WIN_SCAN_TIMEOUT_MS 를 넘기면 끊고, 실패하면 WIN_RETRY_MS 뒤에 다시 해 본다.
// 출력은 UTF-8 JSON 을 base64 로 감싸 콘솔 코드 페이지와 상관없이 한글 경로가 깨지지 않게 한다.
export const WIN_SCAN_TTL_MS = 5000;
export const WIN_SCAN_TIMEOUT_MS = 8000;
// --doctor 는 한 번 돌고 끝나는 진단이라 첫 호출을 더 오래 기다린다. 막 켠 PC 나 CI 러너에서는 PowerShell 의 첫 기동
// (.NET·CIM 모듈 적재)만으로 8초를 넘기는 일이 있어, 그때 "프로세스 확인 불가" 로 잘못 진단하지 않게 한다 (#195).
// 실시간 화면의 첫 호출은 화면이 그만큼 멈추므로 WIN_SCAN_TIMEOUT_MS 그대로 둔다.
export const WIN_DOCTOR_TIMEOUT_MS = 20_000;
export const WIN_RETRY_MS = 60_000;

// 첫 동기 호출의 상한. --doctor 가 setFirstScanTimeout(WIN_DOCTOR_TIMEOUT_MS) 로 늘린다 (첫 호출 전에 불러야 한다).
let firstTimeoutMs = WIN_SCAN_TIMEOUT_MS;
export function setFirstScanTimeout(ms) {
  firstTimeoutMs = ms;
}
export const WIN_FAIL_LIMIT = 3;

export const CIM_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$e = [datetime]'1970-01-01'",
  '$l = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object {',
  '  [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine; s = if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - $e).TotalMilliseconds } else { $null } }',
  '})',
  '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $l -Compress -Depth 2)))',
].join('\n');

const cimArgs = () => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(CIM_SCRIPT, 'utf16le').toString('base64')];

// Windows 명령줄을 인자 목록으로 (CommandLineToArgvW 규칙). 첫 칸(실행 파일)은 따옴표로만 묶고 \ 를 풀지 않는다.
// 나머지는 2n 개의 \ 뒤 " 는 \ n 개와 따옴표 열고 닫기, 2n+1 개의 \ 뒤 " 는 \ n 개와 글자 ", 따옴표 안의 "" 는 글자 " 다.
export function splitCommandLine(line) {
  const s = String(line ?? '');
  const out = [];
  const ws = (c) => c === ' ' || c === '\t';
  let i = 0;
  while (i < s.length && ws(s[i])) i++;
  if (i >= s.length) return out;
  let first = '';
  if (s[i] === '"') {
    const end = s.indexOf('"', i + 1);
    first = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
    i = end < 0 ? s.length : end + 1;
  }
  while (i < s.length && !ws(s[i])) first += s[i++];
  out.push(first);
  for (;;) {
    while (i < s.length && ws(s[i])) i++;
    if (i >= s.length) break;
    let cur = '';
    let quoted = false;
    while (i < s.length && (quoted || !ws(s[i]))) {
      const c = s[i];
      if (c === '\\') {
        let n = 0;
        while (s[i] === '\\') {
          n++;
          i++;
        }
        cur += '\\'.repeat(s[i] === '"' ? n >> 1 : n);
        if (s[i] === '"' && n % 2) {
          cur += '"';
          i++;
        }
      } else if (c === '"') {
        if (quoted && s[i + 1] === '"') {
          cur += '"';
          i += 2;
        } else {
          quoted = !quoted;
          i++;
        }
      } else {
        cur += c;
        i++;
      }
    }
    out.push(cur);
  }
  return out;
}

// CIM 출력(base64 로 감싼 JSON, 또는 JSON 그대로)을 { pid, ppid, name, argv, start } 목록으로.
// 명령줄을 읽을 수 없는 프로세스(다른 사용자, 보호된 프로세스)는 이름만 argv 로 둔다.
export function parseCim(text) {
  let raw = String(text ?? '').trim();
  if (raw && !/^[[{]/.test(raw)) raw = Buffer.from(raw, 'base64').toString('utf8');
  let data = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(data)) data = data ? [data] : [];
  const out = [];
  for (const x of data) {
    const pid = Number(x?.p);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const argv = x.c ? splitCommandLine(x.c) : x.n ? [String(x.n)] : [];
    if (!argv.length) continue;
    out.push({ pid, ppid: Number.isInteger(x.q) ? x.q : null, name: x.n ?? null, argv, start: Number.isFinite(x.s) ? x.s : null });
  }
  return out;
}

const psPath = () => windowsPowerShell() ?? 'powershell.exe';

const runCimSync = () => execFileSync(psPath(), cimArgs(), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: firstTimeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

// 실패 이유: 상한을 넘겨 끊었으면 'timeout', 그 밖은 'error'.
const failReason = (e) => (e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM' || e?.timedOut ? 'timeout' : 'error');

// 뒤에서 부르는 CIM. 끝나지 않으면 WIN_SCAN_TIMEOUT_MS 뒤에 끊는다. aitop 이 끝나는 것을 막지 않게 unref 한다.
function runCimAsync() {
  return new Promise((resolve, reject) => {
    const c = spawn(psPath(), cimArgs(), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      c.kill();
    }, WIN_SCAN_TIMEOUT_MS);
    timer.unref?.();
    c.stdout.on('data', (d) => chunks.push(d));
    c.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    c.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(Object.assign(new Error(`powershell exit ${code}`), { timedOut }));
    });
    c.unref();
    c.stdout.unref?.();
  });
}

// Windows 프로세스 목록기. runSync·runAsync·now 는 테스트에서 바꿔 끼운다.
// list(): 프로세스 목록 (첫 호출은 기다려 받고, 그 뒤에는 오래되면 뒤에서 새로 받으며 직전 목록을 준다).
// ok(): 마지막 호출이 성공했는지. startOf(pid): 시작 시각(ms) 또는 null. ms(): 마지막 호출에 걸린 시간.
export function createWinScanner({ runSync = runCimSync, runAsync = runCimAsync, now = Date.now, ttl = WIN_SCAN_TTL_MS, retry = WIN_RETRY_MS, failLimit = WIN_FAIL_LIMIT } = {}) {
  let st = null;
  let pending = null;
  let fails = 0;
  let byPid = new Map();
  const set = (list, ok, ms, error = null) => {
    st = { at: now(), list, ok, ms, error };
    byPid = new Map(list.map((p) => [p.pid, p]));
    if (ok) fails = 0;
  };
  const first = () => {
    const t0 = now();
    try {
      set(parseCim(runSync()), true, now() - t0);
    } catch (e) {
      set([], false, now() - t0, failReason(e));
    }
  };
  const refresh = () => {
    if (pending) return;
    const t0 = now();
    pending = Promise.resolve()
      .then(runAsync)
      .then(
        (text) => set(parseCim(text), true, now() - t0),
        // 한두 번의 실패(잠깐 바쁜 PC 의 시간 초과 등)는 직전 목록을 그대로 두고 TTL 뒤에 다시 받는다.
        // failLimit 번 이어 실패하면 목록을 버린다: 오래된 목록으로 끝난 세션을 살아 있다고 보지 않게, 최근 기록 판정으로 돌아간다.
        (e) => {
          if (++fails >= failLimit) set([], false, now() - t0, failReason(e));
          else st = { ...st, at: now() };
        },
      )
      .finally(() => (pending = null));
  };
  const ready = () => {
    if (!st) first();
    else if (now() - st.at >= (st.ok ? ttl : retry)) refresh();
  };
  return {
    list() {
      ready();
      return st.list;
    },
    ok() {
      ready();
      return st.ok;
    },
    ms: () => st?.ms ?? null,
    // 마지막으로 목록을 버린 이유: 'timeout' · 'error', 성공했으면 null.
    error: () => st?.error ?? null,
    startOf(pid) {
      ready();
      return byPid.get(pid)?.start ?? null;
    },
    // 부모 pid. 부모가 끝난 뒤 그 pid 를 다른 프로세스가 다시 쓸 수 있으므로, 부모가 자식보다 먼저 뜬 경우만 준다 (findProcesses 와 같은 규칙).
    ppidOf(pid) {
      ready();
      const p = byPid.get(pid);
      const q = p?.ppid != null ? byPid.get(p.ppid) : null;
      if (!p || p.ppid == null) return null;
      if (q && q.start != null && p.start != null && q.start > p.start) return null;
      return p.ppid;
    },
    // 테스트용: 뒤에서 받는 중인 호출을 기다린다.
    settle: () => pending ?? Promise.resolve(),
  };
}

if (OS === 'win32') win = createWinScanner();
