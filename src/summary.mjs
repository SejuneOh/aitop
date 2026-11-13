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
// 요약에 적는 다른 도구 대기 세션 수 상한. --line 은 가장 오래 기다린 하나만 보이지만, 둘을 적어 둔다.
export const WAIT_TOP = 2;
// 이름은 화면에 보이는 것보다 넉넉히, 그래도 파일이 커지지 않게 자른다.
const NAME_MAX = 80;

// 요약의 waitTop: [{ tool, name, since }]. since 는 모르면 null. 형식이 맞는 항목만 남긴다 (예전 요약에는 없으므로 없으면 빈 목록).
function waitTopOf(x) {
  if (!Array.isArray(x)) return [];
  return x.filter((w) => typeof w?.name === 'string' && (w.since === null || Number.isFinite(w.since))).slice(0, WAIT_TOP);
}

// 세션의 대기 시작 시각. 출처가 따로 적은 waitSince 가 있으면 그것(null 이면 모름), 없으면 updatedAt.
// 모르는 시각을 지금 시각으로 메우면 요약이 매번 바뀌고 대기 시간이 늘 0s 로 보인다.
function sinceOf(s) {
  const t = s.waitSince !== undefined ? s.waitSince : s.updatedAt;
  return Number.isFinite(t) ? t : null;
}
// 시각을 모르는 세션은 정렬에서 맨 뒤.
const sinceKey = (t) => t ?? Number.MAX_SAFE_INTEGER;

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
    // 그중 가장 오래 기다린 세션 이름과 대기 시작 시각 (화면 IDLE 칸과 같은 기준). 대기 시간은 읽는 쪽이 지금 시각으로 센다.
    // v 는 그대로 둔다: 예전 aitop 은 이 칸을 모르고 넘기고, 새 aitop 은 이 칸이 없는 예전 요약도 읽는다.
    waitTop: waiting
      .filter((s) => s.tool !== 'claude')
      .map((s) => ({ tool: s.tool, name: String(s.name ?? '').slice(0, NAME_MAX), since: sinceOf(s) }))
      .sort((a, b) => sinceKey(a.since) - sinceKey(b.since))
      .slice(0, WAIT_TOP),
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
  return { ...s, waitTop: waitTopOf(s.waitTop) };
}

// 실시간 화면용: 수가 바뀌면 지난번 쓴 뒤 minMs 가 지났을 때, 그대로면 heartbeatMs 마다 쓴다.
export function createSummaryWriter({ file = SUMMARY_FILE, minMs = MIN_WRITE_MS, heartbeatMs = HEARTBEAT_MS, write = writeSummary } = {}) {
  let last = null;
  return (sessions, now = Date.now()) => {
    const s = summarize(sessions, now);
    const since = last ? now - last.at : Infinity;
    const top = (x) => x.waitTop.map((w) => `${w.name}@${w.since}`).join('|');
    const changed = !last || s.running !== last.running || s.waiting !== last.waiting || s.waitingOther !== last.waitingOther || top(s) !== top(last);
    if (since < (changed ? minMs : heartbeatMs)) return false;
    if (!write(s, file)) return false;
    last = s;
    return true;
  };
}
