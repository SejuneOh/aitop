// 실행 중인 AI CLI 프로세스와 그 작업 폴더를 찾는다.
// Linux·WSL 은 /proc 를 읽고, macOS 는 ps 와 lsof 를 부른다. 그 밖의 OS 는 프로세스를 세지 못한다.
import { readdirSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

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
export function joinPaths(tokens, exists = existsSync) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let cur = tokens[i++];
    if (out.length < 2 && cur.startsWith('/') && !exists(cur)) {
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

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });

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
  return found.map((p) => ({ ...p, cwd: cwdOf(p.pid) }));
}

const base = (p) => p.split('/').pop();

// `codex` 는 node 스크립트(…/bin/codex.js)이거나 네이티브 바이너리(codex-*)로 뜬다.
export function isCodex(argv) {
  return argv.slice(0, 2).some((a) => /^codex(\.js)?$/.test(base(a)) || /^codex-[\w-]+$/.test(base(a)));
}

export function isGemini(argv) {
  return argv.slice(0, 2).some((a) => /^gemini(\.js)?$/.test(base(a)));
}
