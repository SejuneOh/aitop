// /proc 를 읽어 실행 중인 AI CLI 프로세스와 그 작업 폴더를 찾는다 (Linux·WSL 전용).
import { readdirSync, readFileSync, readlinkSync, existsSync } from 'node:fs';

export function isAlive(pid) {
  return existsSync(`/proc/${pid}`);
}

// 한 번의 갱신 안에서 여러 도구가 /proc 를 각각 훑지 않도록, 짧게 결과를 재사용한다.
const SCAN_TTL_MS = 500;
let scan = { at: 0, list: [] };

function scanAll() {
  if (Date.now() - scan.at < SCAN_TTL_MS) return scan.list;
  const list = [];
  let pids = [];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {}
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let argv;
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.length || !(isCodex(argv) || isGemini(argv))) continue;
    let cwd = null;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
    list.push({ pid: Number(pid), argv, cwd });
  }
  scan = { at: Date.now(), list };
  return list;
}

export function findProcesses(match) {
  return scanAll().filter((p) => match(p.argv));
}

const base = (p) => p.split('/').pop();

// `codex` 는 node 스크립트(…/bin/codex.js)이거나 네이티브 바이너리(codex-*)로 뜬다.
export function isCodex(argv) {
  return argv.slice(0, 2).some((a) => /^codex(\.js)?$/.test(base(a)) || /^codex-[\w-]+$/.test(base(a)));
}

export function isGemini(argv) {
  return argv.slice(0, 2).some((a) => /^gemini(\.js)?$/.test(base(a)));
}
