// /proc 를 읽어 실행 중인 AI CLI 프로세스와 그 작업 폴더를 찾는다 (Linux·WSL 전용).
import { readdirSync, readFileSync, readlinkSync, existsSync } from 'node:fs';

export function isAlive(pid) {
  return existsSync(`/proc/${pid}`);
}

export function findProcesses(match) {
  const out = [];
  let pids;
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let argv;
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.length || !match(argv)) continue;
    let cwd = null;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
    out.push({ pid: Number(pid), argv, cwd });
  }
  return out;
}

const base = (p) => p.split('/').pop();

// `codex` 는 node 스크립트(…/bin/codex.js)이거나 네이티브 바이너리(codex-*)로 뜬다.
export const isCodex = (argv) => argv.slice(0, 2).some((a) => /^codex(\.js)?$/.test(base(a)) || /^codex-[\w-]+$/.test(base(a)));
export const isGemini = (argv) => argv.slice(0, 2).some((a) => /^gemini(\.js)?$/.test(base(a)));
