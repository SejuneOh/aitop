import { basename } from 'node:path';
import { mask, maskStrict, oneLine, plainText, stripControl, STRICT_NAME } from '../text.mjs';

export const MAX_EVENTS = 40;
// 끝난 서브에이전트(팀원)는 이 시간 동안 "완료"로 보였다가 목록에서 사라진다.
export const MEMBER_FADE_MS = 6000;

// 작업 중인 서브에이전트가 '멈춘 듯' 보이기까지 기록이 바뀌지 않은 시간.
// 서브에이전트는 모델 응답 한 번, 도구 결과 한 번마다 기록에 한 줄을 쓴다. 긴 생각을 하는 응답도 대개 1~2분 안에 끝나므로
// 3분 동안 한 줄도 없으면 드문 일로 본다. 다만 Bash 같은 도구가 도는 동안에는 결과가 올 때까지 쓰지 않는데,
// Claude Code 의 Bash 시간 제한이 최대 10분이라 그런 단계에서는 10분을 기다린다.
// 짐작일 뿐이라 화면에 흐리게만 보이고 정렬·알림·창 제목·--line 에는 쓰지 않는다.
export const MEMBER_STALL_MS = 3 * 60_000;
export const MEMBER_STALL_LONG_MS = 10 * 60_000;
// 결과가 올 때까지 오래 기록이 없을 수 있는 도구 (Claude·agy 이름). 서브에이전트 안의 서브에이전트(Agent·Task)도 그동안 쓰지 않는다.
// Skill 은 지침 글을 바로 돌려주는 도구라 넣지 않는다.
export const LONG_TOOLS = new Set(['Bash', 'PowerShell', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'run_command', 'shell', 'call_mcp_tool']);
// MCP 도구(mcp__서버__도구, agy 는 call_mcp_tool)는 바깥 서버가 응답할 때까지 기다리므로 얼마나 걸릴지 알 수 없어 오래 걸리는 쪽으로 본다.
export const isLongTool = (name) => LONG_TOOLS.has(name) || String(name ?? '').startsWith('mcp__');

// m: 수집기가 만든 팀원. status 'busy' 이고 lastActivityAt 이 기준보다 오래됐으면 true. longStep 이면 긴 기준을 쓴다.
// 허락을 기다리는 동안은 기록이 멈추는 것이 정상이므로, 팀원이 응답 대기('waiting')이거나 부모 세션(parentStatus)이
// 응답 대기면 멈춘 듯으로 보지 않는다 (Claude 는 서브에이전트의 허락 요청이 부모 세션의 대기로만 보인다).
// 팀원 쪽은 'busy' 가 아니면(대기·완료 모두) 따로 보지 않고 false 다. 부모가 기다리면 형제 팀원의 표시도 함께 꺼진다 (덜 알리는 쪽).
export function memberStalled(m, now = Date.now(), parentStatus = null) {
  if (parentStatus === 'waiting') return false;
  if (m?.status !== 'busy' || !Number.isFinite(m.lastActivityAt)) return false;
  return now - m.lastActivityAt >= (m.longStep ? MEMBER_STALL_LONG_MS : MEMBER_STALL_MS);
}

export function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

// 프롬프트 캐시 적중률 (#334): 캐시 읽기 / (입력 + 캐시 읽기 + 캐시 쓰기), 0~1. 모델에 보낸 프롬프트 중 캐시에서 읽은 몫이다.
// 입력은 캐시를 뺀 몫이어야 한다 (Claude usage 의 input_tokens, Codex 는 수집기가 cached 를 뺀 값, agy 도 따로 센다).
// 분모가 0 이면(토큰을 모르는 도구, 아직 호출이 없는 세션) null.
export function cacheHitRate(t) {
  const read = t?.cacheRead ?? 0;
  const all = (t?.input ?? 0) + read + (t?.cacheWrite ?? 0);
  return all > 0 ? read / all : null;
}

// 장부 벡터([입력, 출력, 캐시 읽기, 캐시 쓰기 5분, 캐시 쓰기 1시간], addModel 의 u·f)를 적중률 계산용 토큰 모양으로.
export const vecTokens = (v) => ({ input: v?.[0] ?? 0, cacheRead: v?.[2] ?? 0, cacheWrite: (v?.[3] ?? 0) + (v?.[4] ?? 0) });

// 적중률 글: 87%. 0 보다 크지만 반올림하면 0% 인 값은 <1%, 1 보다 작지만 100% 로 오르는 값은 99% 로 (다 맞은 것처럼 보이지 않게).
export function hitText(r) {
  if (r == null) return null;
  if (r > 0 && r < 0.005) return '<1%';
  const n = Math.round(r * 100);
  return `${n === 100 && r < 1 ? 99 : n}%`;
}

// --json 용: 소수 셋째 자리까지.
export const hitJson = (r) => (r == null ? null : Math.round(r * 1000) / 1000);

const two = (n) => String(n).padStart(2, '0');
// 사용자가 보는 날짜(로컬 시간대) 기준 날짜 키.
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// 오늘부터 거꾸로 n 일의 날짜 키.
export function lastDays(n, now = Date.now()) {
  const keys = [];
  const d = new Date(now);
  for (let i = 0; i < n; i++) {
    keys.push(dayKey(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return keys;
}

// 날짜별 리포트(--report daily)가 볼 수 있는 가장 긴 기간. 리포트는 30일 안에 바뀐 기록을 읽는다.
// 평소 실행은 최근 7일 안에 바뀐 기록만 읽지만, 그 기록 안의 날짜 합계는 캐시에 남겨(STORE_DAYS) 리포트가 다시 읽지 않게 한다.
export const KEEP_DAYS = 30;

// 캐시에 날짜별 합계를 남기는 일수. 월별 보관함(monthly.mjs)이 12개월치를 처음 채울 때 다시 읽지 않게 1년 넘게 남긴다.
// 기록 하나에는 그 기록이 쓰인 날만 있어 길게 남겨도 캐시가 거의 커지지 않는다.
export const STORE_DAYS = 400;

// 날짜별 합계 중 최근 n 일(키 비교) 것만 남긴 복사본.
export function recentDays(days, n = STORE_DAYS, now = Date.now()) {
  const from = dayKey(now - (n - 1) * 86400_000);
  return Object.fromEntries(Object.entries(days).filter(([k]) => k >= from));
}

// 하루 합계(day)에 모델별 몫 { tokens, cost, u } 를 더한다. 모델 이름을 모르면 'unknown' 으로 센다.
// unknown: 가격표에 없는 모델이라 비용을 0 으로 셌을 때. 그 모델 몫에 unknown 을 남겨 리포트가 ? 를 붙인다.
// vec: 사용량 벡터(pricing.mjs VEC). fast 면 f 에 따로 더한다 (Claude fast 모드는 단가가 다르다).
export function addModel(day, model, tokens, cost, unknown = false, vec = null, fast = false) {
  const m = ((day.models ??= {})[String(model || 'unknown')] ??= { tokens: 0, cost: 0 });
  m.tokens += tokens;
  m.cost += cost;
  if (unknown) m.unknown = true;
  if (vec) {
    const to = fast ? (m.f ??= [0, 0, 0, 0, 0]) : (m.u ??= [0, 0, 0, 0, 0]);
    for (let i = 0; i < to.length; i++) to[i] += vec[i] ?? 0;
  }
}

// 지출 속도용 짧은 구간 장부. 비용을 5분 칸(키 = 칸 시작 시각 ms)에 모으고, 그 장부에서 가장 새 칸부터
// 2시간 안의 칸만 남긴다. 기준이 시계가 아니라 기록 안의 시각이라 처음 읽기 중에도 칸 수가 일정하다.
export const SLOT_MS = 5 * 60_000;
const SLOT_KEEP_MS = 2 * 3600_000;

export function addSlot(slots, at, cost, costNoCache, unknown) {
  if (!Number.isFinite(at)) return;
  const k = Math.floor(at / SLOT_MS) * SLOT_MS;
  let s = slots[k];
  if (!s) {
    s = slots[k] = { cost: 0, costNoCache: 0, unknown: false };
    const newest = Math.max(...Object.keys(slots).map(Number));
    for (const key of Object.keys(slots)) if (Number(key) < newest - SLOT_KEEP_MS) delete slots[key];
    if (!slots[k]) return;
  }
  s.cost += cost;
  s.costNoCache += costNoCache;
  if (unknown) s.unknown = true;
}

// 최근 1시간 합계. 시작 시각이 now 로부터 60분 안인 칸만 센다 (5분 단위 근사라 55~60분 구간).
export const lastHourOf = (books, now = Date.now()) => slotsSince(books, now - 3600_000);

// 시작 시각이 from 이후인 칸의 합계.
function slotsSince(books, from) {
  const out = { cost: 0, costNoCache: 0, unknown: false };
  for (const slots of books)
    for (const [k, s] of Object.entries(slots ?? {})) {
      if (Number(k) < from) continue;
      out.cost += s.cost;
      out.costNoCache += s.costNoCache;
      out.unknown ||= s.unknown;
    }
  return out;
}

// 하루 예산의 예상 속도용: 최근 1시간 중 로컬 자정 이후의 몫만 센다.
// ms 는 실제로 센 칸이 덮는 길이다: 구간 시작을 칸 경계로 올린 시각부터 지금까지 (55~60분, 자정 직후면 더 짧다).
export function recentTodayOf(books, now = Date.now()) {
  const d = new Date(now);
  const from = Math.max(now - 3600_000, new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
  const start = Math.ceil(from / SLOT_MS) * SLOT_MS;
  return { ...slotsSince(books, start), ms: Math.max(0, now - start) };
}

// 세션별 활동 장부: 토큰을 1시간 칸(키 = 칸 시작 시각 ms)에 모은다. 상세 패널의 24시간 막대가 쓴다.
// 기준은 장부 안 가장 새 칸이라 처음 읽기 중에도 칸 수가 ACT_HOURS 를 넘지 않는다 (세션 하나에 숫자 24개).
export const ACT_MS = 3600_000;
export const ACT_HOURS = 24;
// 시계가 어긋난 줄 하나가 미래 칸을 만들어 앞 칸을 모두 지우지 않게, 지금보다 이만큼 넘게 앞선 시각은 버린다.
export const ACT_SKEW_MS = 5 * 60_000;

export function addActivity(act, at, tokens, now = Date.now()) {
  if (!Number.isFinite(at) || !(tokens > 0) || at > now + ACT_SKEW_MS) return;
  const k = Math.floor(at / ACT_MS) * ACT_MS;
  if (act[k] == null) {
    const newest = Math.max(k, ...Object.keys(act).map(Number));
    if (k <= newest - ACT_HOURS * ACT_MS) return;
    for (const key of Object.keys(act)) if (Number(key) <= newest - ACT_HOURS * ACT_MS) delete act[key];
    act[k] = 0;
  }
  act[k] += tokens;
}

// 여러 장부(메인 + 서브에이전트)를 칸별로 더한다.
export function mergeActivity(books) {
  const out = {};
  for (const b of books) for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}

// now 가 든 칸까지 거꾸로 n 칸의 토큰 (오래된 칸 → 지금 칸).
export function activitySeries(act, now = Date.now(), n = ACT_HOURS) {
  const last = Math.floor(now / ACT_MS) * ACT_MS;
  return Array.from({ length: n }, (_, i) => act?.[last - (n - 1 - i) * ACT_MS] ?? 0);
}

// 기록 줄의 timestamp. 없거나 읽을 수 없으면 지금 시각.
export const parseTs = (ts) => (ts && Date.parse(ts)) || Date.now();

// 답변(reply)은 마크다운 기호를 지운 평문으로 남긴다.
export function pushEvent(state, at, kind, text) {
  const t = mask(oneLine(kind === 'reply' ? plainText(text) : text));
  if (!t) return null;
  const e = { at: parseTs(at), kind, text: t };
  state.events.push(e);
  if (state.events.length > MAX_EVENTS) state.events.shift();
  return e;
}

const short = (p) => (p ? basename(String(p)) : '');

// 도구 호출을 "무엇을 하는지" 한 줄로 줄인다. Claude·Codex 도구 이름을 모두 다룬다.
// 도구 설명은 화면·--json 어디로 나가든 비밀값을 가린 뒤 한 줄로 만든다.
export function describeTool(name, input = {}) {
  return mask(oneLine(rawDescribeTool(name, input)));
}

function rawDescribeTool(name, input) {
  if (typeof input === 'string') {
    const file = input.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
    return file ? `${name} ${short(file[1])}` : name;
  }
  switch (name) {
    case 'Bash':
    case 'exec_command':
    case 'shell':
      return `$ ${input.description ?? input.cmd ?? input.command ?? ''}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${name} ${short(input.file_path ?? input.notebook_path)}`;
    case 'Grep':
    case 'Glob':
      return `${name} ${input.pattern ?? ''}`;
    case 'WebFetch':
      return `WebFetch ${(input.url ?? '').replace(/^https?:\/\//, '').split('/')[0]}`;
    case 'WebSearch':
      return `WebSearch ${input.query ?? ''}`;
    case 'Agent':
    case 'Task':
      return `▸ ${input.subagent_type ?? 'agent'}: ${input.description ?? ''}`;
    case 'TodoWrite':
      return 'TodoWrite';
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return first ? `${name} ${first}` : name;
    }
  }
}

// 허락을 기다리는 도구 호출의 전체 내용. 한 줄 설명(describeTool)과 달리 Bash 는 설명 대신 실제 명령을, 파일 도구는 전체 경로를 남긴다.
// 화면 색을 바꾸는 ANSI 순서와 제어문자를 지우고 비밀값을 가린 뒤 DETAIL_MAX 자에서 자른다. 줄바꿈은 남긴다.
export const DETAIL_MAX = 2048;
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// 사용자가 붙인 세션 이름 (Claude /rename 의 custom-title, Codex thread_name). 사용자·모델이 쓴 글이라
// 색 순서·제어문자를 지우고 한 줄로 줄인 뒤 비밀값을 가리고 NAME_MAX 자에서 자른다. 비었으면 null.
export const NAME_MAX = 80;
export function sessionName(raw) {
  if (typeof raw !== 'string') return null;
  const one = mask(oneLine(raw.replace(ANSI, '')));
  if (!one) return null;
  return one.length > NAME_MAX ? one.slice(0, NAME_MAX - 1) + '…' : one;
}

export function toolDetail(name, input = {}) {
  const raw = rawToolDetail(name, input);
  if (!raw) return null;
  const clean = maskStrict(stripControl(String(raw).replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/\t/g, '  '))).trim();
  if (!clean) return null;
  return clean.length > DETAIL_MAX ? clean.slice(0, DETAIL_MAX - 1) + '…' : clean;
}

// 이름이 비밀값처럼 보이는 키(api_key, token, password, cookie 등)의 값은 문자열·숫자·객체·배열 가리지 않고 통째로 가린다.
// { name: 'API_KEY', value: '…' } 처럼 이름과 값을 나눠 담은 항목도 value 를 가린다. 너무 깊은 곳은 통째로 가린다.
const MAX_DEPTH = 32;
const secretLabel = (x) => typeof x === 'string' && STRICT_NAME.test(x.replace(/^-{1,2}/, '').replace(/[:=]$/, ''));

export function maskKeys(v, depth = 0) {
  if (!v || typeof v !== 'object') return v;
  if (depth > MAX_DEPTH) return '••••';
  // ["--token", "x"], ["Authorization", "x"]: 비밀 이름 바로 다음 칸을 가린다.
  if (Array.isArray(v)) {
    let after = false;
    return v.map((x) => {
      const hide = after && x != null && typeof x !== 'boolean';
      after = !hide && secretLabel(x);
      return hide ? '••••' : maskKeys(x, depth + 1);
    });
  }
  const label = v.name ?? v.Name ?? v.key ?? v.Key;
  const pair = typeof label === 'string' && STRICT_NAME.test(label);
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => {
      const secret = STRICT_NAME.test(k) || (pair && /^value$/i.test(k));
      return [k, secret && x != null && typeof x !== 'boolean' ? '••••' : maskKeys(x, depth + 1)];
    }),
  );
}

function rawToolDetail(name, input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  switch (name) {
    case 'Bash':
    case 'exec_command':
    case 'shell': {
      const cmd = input.command ?? input.cmd;
      return Array.isArray(cmd) ? cmd.join(' ') : cmd;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return input.file_path ?? input.notebook_path;
    default:
      try {
        return Object.keys(input).length ? JSON.stringify(maskKeys(input)) : null;
      } catch {
        return null;
      }
  }
}

export function isNoisePrompt(text) {
  return /^\s*(<|\[Request interrupted|Caveat:|This session is being continued from a previous conversation)/.test(text);
}
