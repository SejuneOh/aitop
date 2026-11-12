// --line 용 작은 요약 파일. 실시간 화면·--once·--json 이 세션을 다 모은 뒤 작업 중·응답 대기 수를 적고,
// --line 은 이 파일만 읽어 작업 중 수를 낸다 (세션 기록·프로세스 목록을 다시 읽지 않게).
// 가격·캐시 형식과 무관하므로 버전 폴더가 아니라 캐시 루트에 두고, 파일 안의 v 로 형식을 가른다.
// 그래야 다른 버전의 aitop 화면이 쓴 요약도 --line 이 읽는다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CACHE_ROOT } from './cache.mjs';
import { debugIo } from './log.mjs';

const V = 1;
export const SUMMARY_FILE = join(CACHE_ROOT, 'summary.json');
// 이보다 오래된 요약은 버린다. 화면은 수가 그대로여도 HEARTBEAT_MS 마다 다시 쓰므로 두 번 넘게 놓쳐야 버려진다.
// 화면을 끄면 마지막 수가 1분 안에 사라진다 (tmux 기본 갱신 15초로 네 번 안).
export const STALE_MS = 60_000;
// 수가 바뀌었을 때도 이 간격보다 자주 쓰지 않는다.
export const MIN_WRITE_MS = 5_000;
// 수가 그대로여도 이 간격마다 시각을 새로 적는다.
export const HEARTBEAT_MS = 20_000;
// 시계가 조금 어긋난 것은 봐준다. 이보다 미래 시각이면 잘못된 파일로 본다.
const SKEW_MS = 5_000;

const nat = (x) => Number.isInteger(x) && x >= 0;

// 세션 목록에서 요약 값을 뽑는다. 화면 헤더(ui/table.mjs)와 같은 기준이다.
export function summarize(sessions, now = Date.now()) {
  const live = sessions.filter((s) => s.live);
  const waiting = live.filter((s) => s.status === 'waiting');
  return {
    v: V,
    at: now,
    running: live.filter((s) => s.status === 'busy' || s.status === 'shell').length,
    waiting: waiting.length,
    // Claude 대기 수는 --line 이 세션 파일에서 바로 세므로, 그 밖의 도구 몫(지금은 Antigravity 만 대기 상태가 있다)을 따로 적는다.
    waitingOther: waiting.filter((s) => s.tool !== 'claude').length,
  };
}

// 여러 aitop 이 함께 써도 섞이지 않게 pid 별 임시 파일에 쓰고 rename 한다 (마지막에 쓴 쪽이 남는다).
export function writeSummary(summary, file = SUMMARY_FILE) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(summary), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (e) {
    debugIo('summary', 'summary write failed', e);
    try {
      rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
}

// 새 요약이면 값, 없거나 깨졌거나 오래됐으면 null.
export function readSummary({ file = SUMMARY_FILE, now = Date.now(), staleMs = STALE_MS } = {}) {
  let s;
  try {
    s = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (s?.v !== V || !Number.isFinite(s.at) || ![s.running, s.waiting, s.waitingOther].every(nat)) return null;
  if (now - s.at > staleMs || s.at - now > SKEW_MS) return null;
  return s;
}

// 실시간 화면용: 수가 바뀌면 지난번 쓴 뒤 minMs 가 지났을 때, 그대로면 heartbeatMs 마다 쓴다.
export function createSummaryWriter({ file = SUMMARY_FILE, minMs = MIN_WRITE_MS, heartbeatMs = HEARTBEAT_MS, write = writeSummary } = {}) {
  let last = null;
  return (sessions, now = Date.now()) => {
    const s = summarize(sessions, now);
    const since = last ? now - last.at : Infinity;
    const changed = !last || s.running !== last.running || s.waiting !== last.waiting || s.waitingOther !== last.waitingOther;
    if (since < (changed ? minMs : heartbeatMs)) return false;
    if (!write(s, file)) return false;
    last = s;
    return true;
  };
}
