// Claude 남은 사용 한도(5시간·7일, 게이트웨이 지출 한도) (#332).
// Claude Code 는 상태줄 명령의 stdin JSON 에만 rate_limits 를 넣고 기록 파일에는 남기지 않는다.
// 그래서 사용자가 settings.json 의 statusLine.command 에 `aitop --statusline` 을 넣으면, 그 입력에서 숫자·시각만 꺼내
// 캐시 루트의 claude-limits.json 에 저장하고, 실시간 화면·--json·--line 이 그 파일을 읽는다. 네트워크는 쓰지 않는다.
// 이 모듈은 상태줄이 자주(응답마다) 부르는 가벼운 경로라 paths.mjs·rename.mjs 만 불러온다 (화면 모듈·수집기·i18n 없음).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appDir } from './paths.mjs';
import { renameSync } from './rename.mjs';

// cache.mjs 의 CACHE_ROOT 와 같은 곳 (summary.json 옆). 버전 폴더 밖이라 aitop 버전이 바뀌어도 그대로 읽힌다.
export const LIMITS_NAME = 'claude-limits.json';
export const LIMITS_FILE = join(appDir('cache', { home: homedir() }), LIMITS_NAME);
// 이보다 오래된 저장값은 보이지 않는다 (7일 창보다 오래됐으면 어느 값도 믿을 수 없다).
export const MAX_AGE_MS = 7 * 86_400_000;
// 시계가 조금 어긋난 것은 봐준다. 이보다 미래 시각이면 잘못된 파일로 본다.
const SKEW_MS = 5_000;
// 같은 값이면 이 간격보다 자주 다시 쓰지 않는다 (상태줄은 응답마다 불린다). 마지막 갱신 시각이 이만큼 늦을 수 있다.
export const REWRITE_MS = 30_000;
// 5시간·7일 한도는 0~100 이다 (문서). 지출 한도(spend_limit)는 한도를 넘으면 100 을 넘을 수 있어 상한을 넉넉히 둔다.
const PCT_MAX = { fiveHour: 100, sevenDay: 100, spend: 1000 };
// resets_at 은 초 단위 epoch. 2001~2286년 밖이면 단위가 틀렸거나 깨진 값으로 본다.
const SEC_MIN = 1e9;
const SEC_MAX = 1e10;
// 창마다 resets_at 이 지금보다 이만큼 넘게 먼 미래면 버린다 (5시간 창은 6시간, 7일 창은 8일). 지출 한도는 기간(일·주·달)이 달라 SEC_MAX 만 본다.
const AHEAD_MS = { fiveHour: 6 * 3600_000, sevenDay: 8 * 86_400_000, spend: Infinity };
// 화면·--line 에서 주의색·경고색을 쓰는 기준 (예산 색 규칙과 같은 단계 이름).
export const CAUTION_PCT = 80;
export const WARN_PCT = 95;

const KEYS = [
  ['fiveHour', 'five_hour'],
  ['sevenDay', 'seven_day'],
  ['spend', 'spend_limit'],
];

// 창 하나: used_percentage(숫자, 0~max)와 resets_at(초 epoch)이 둘 다 맞아야 { pct, resetsAt(ms) }. 아니면 null.
// 문자열 숫자·음수·상한 넘는 값·NaN 은 받지 않는다.
function windowOf(w, max, maxAt = Infinity) {
  if (!w || typeof w !== 'object') return null;
  const pct = w.used_percentage;
  const sec = w.resets_at;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > max) return null;
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < SEC_MIN || sec > SEC_MAX) return null;
  if (sec * 1000 > maxAt) return null;
  return { pct: Math.round(pct * 10) / 10, resetsAt: Math.round(sec * 1000) };
}

// 상태줄 입력(JSON 객체)에서 한도만 꺼낸다. 맞는 창이 하나도 없으면 null. now 는 초기화 시각 상한(AHEAD_MS)의 기준.
// 모델명·경로·세션 id·비용 같은 다른 필드는 보지도 담지도 않는다. 지출 한도의 used_usd·limit_usd·period 도 담지 않는다.
export function parseLimits(input, now = Date.now()) {
  const r = input && typeof input === 'object' ? input.rate_limits : null;
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (const [key, src] of KEYS) {
    const w = windowOf(r[src], PCT_MAX[key], now + AHEAD_MS[key]);
    if (w) out[key] = w;
  }
  return Object.keys(out).length ? out : null;
}

// 파일에서 읽은 창 하나를 다시 검사한다 (손으로 고친 파일·다른 버전이 쓴 파일).
function storedWindow(w, max) {
  if (!w || typeof w !== 'object') return null;
  if (typeof w.pct !== 'number' || !Number.isFinite(w.pct) || w.pct < 0 || w.pct > max) return null;
  if (typeof w.resetsAt !== 'number' || !Number.isFinite(w.resetsAt) || w.resetsAt < SEC_MIN * 1000 || w.resetsAt > SEC_MAX * 1000) return null;
  return { pct: w.pct, resetsAt: w.resetsAt };
}

// 저장 파일을 그대로 읽는다 (만료 검사 없음). 없거나 깨졌으면 null. --doctor 의 '마지막 갱신' 은 이 값의 at 이다.
export function loadLimits({ file = LIMITS_FILE } = {}) {
  let s;
  try {
    s = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object' || typeof s.at !== 'number' || !Number.isFinite(s.at) || s.at <= 0) return null;
  const out = { at: s.at };
  for (const [key] of KEYS) {
    const w = storedWindow(s[key], PCT_MAX[key]);
    if (w) out[key] = w;
  }
  return out;
}

// 보여도 되는 값만 남긴다: 저장한 지 7일이 넘었거나 미래 시각이면 null, 초기화 시각이 지난 창은 뺀다. 남는 창이 없으면 null.
export function freshLimits(rec, now = Date.now()) {
  if (!rec || !Number.isFinite(rec.at)) return null;
  if (now - rec.at > MAX_AGE_MS || rec.at - now > SKEW_MS) return null;
  const out = { at: rec.at };
  for (const [key] of KEYS) if (rec[key] && rec[key].resetsAt > now) out[key] = rec[key];
  return Object.keys(out).length > 1 ? out : null;
}

const sameWindows = (a, b) => KEYS.every(([k]) => (a?.[k]?.pct ?? null) === (b?.[k]?.pct ?? null) && (a?.[k]?.resetsAt ?? null) === (b?.[k]?.resetsAt ?? null));

// 원자적으로 저장한다: pid 별 임시 파일에 쓰고 rename (여러 Claude 세션의 상태줄이 함께 써도 섞이지 않고 마지막 쪽이 남는다).
// 값이 지난번과 같고 REWRITE_MS 안이면 쓰지 않는다. 쓴 경우 true.
export function saveLimits(limits, { file = LIMITS_FILE, now = Date.now() } = {}) {
  if (!limits) return false;
  const prev = loadLimits({ file });
  if (prev && sameWindows(prev, limits) && now - prev.at >= 0 && now - prev.at < REWRITE_MS) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify({ at: now, ...limits }), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
}

// 남은 시간을 짧게: 2h10m, 45m, 3d4h.
export function fmtLeft(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
}

export const pctText = (p) => `${Math.round(p)}%`;
// 'caution' | 'warn' | 'ok'. 예산 단계와 같은 이름이라 BUDGET_COLOR 를 그대로 쓴다.
export const pctLevel = (p) => (p >= WARN_PCT ? 'warn' : p >= CAUTION_PCT ? 'caution' : 'ok');

// --statusline 기본 줄 (사용자 상태줄 명령이 없을 때). ASCII 만 쓴다: 5h 23% (2h10m) | 7d 41% | spend 63%
// 값이 하나도 없으면 빈 글.
export function statusText(limits, now = Date.now()) {
  if (!limits) return '';
  const parts = [];
  if (limits.fiveHour) parts.push(`5h ${pctText(limits.fiveHour.pct)} (${fmtLeft(limits.fiveHour.resetsAt - now)})`);
  if (limits.sevenDay) parts.push(`7d ${pctText(limits.sevenDay.pct)}`);
  if (limits.spend) parts.push(`spend ${pctText(limits.spend.pct)}`);
  return parts.join(' | ');
}

// --doctor 용 점검: 상태줄이 한 번이라도 저장했는지와 마지막 갱신 시각(ISO), 아직 유효한 값.
// 파일을 읽기만 한다 (사용자 Claude Code 설정은 열지 않는다).
export function limitsCheck({ file = LIMITS_FILE, now = Date.now() } = {}) {
  const rec = loadLimits({ file });
  const f = freshLimits(rec, now);
  const pct = (w) => (w ? w.pct : null);
  return { connected: Boolean(rec), at: rec ? new Date(rec.at).toISOString() : null, file, fiveHour: pct(f?.fiveHour), sevenDay: pct(f?.sevenDay) };
}
