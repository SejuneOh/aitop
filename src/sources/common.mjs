import { basename } from 'node:path';
import { mask, maskStrict, oneLine, plainText, stripControl, STRICT_NAME } from '../text.mjs';

export const MAX_EVENTS = 40;
// 끝난 서브에이전트(팀원)는 이 시간 동안 "완료"로 보였다가 목록에서 사라진다.
export const MEMBER_FADE_MS = 6000;

export function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

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
export function lastHourOf(books, now = Date.now()) {
  const out = { cost: 0, costNoCache: 0, unknown: false };
  for (const slots of books)
    for (const [k, s] of Object.entries(slots ?? {})) {
      if (Number(k) < now - 3600_000) continue;
      out.cost += s.cost;
      out.costNoCache += s.costNoCache;
      out.unknown ||= s.unknown;
    }
  return out;
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
