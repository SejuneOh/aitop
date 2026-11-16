// 세션 리포트(--report sessions)용 기록 요약: Claude·Codex 기록 파일 하나마다 날짜별 활동 시작·끝 시각, 고친 파일, 그날 첫 지시와
// 세션 이름(사용자 이름, 그 밖 이름)을 모은다. 사용량(토큰·비용)은 장부(claude-ledger.mjs 등)가 세고, 여기서는 세지 않는다.
// 장부 캐시 모양은 그대로 두고 따로 읽는다 (장부를 다시 세지 않게). 리포트가 기간 안에 사용량이 있는 기록만 부른다.
// 기록은 읽기만 하고, 어디까지 읽었는지는 aitop 캐시에 둔다.
// 날짜별로 "나를 기다린 시간"(w, ms)도 모은다: 에이전트 쪽 마지막 줄(응답·도구 결과) 시각부터 다음 사용자 입력(지시, 허락·질문 답)
// 시각까지의 간격 합이다. 기록에는 화면 앞에 있었는지가 없어 자리를 비운 시간과 가르지 못하는 추정값이다.
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { dayKey, isNoisePrompt, recentDays, sessionName } from './common.mjs';
import { readChange } from './files.mjs';
import { parsePatch, extractPatch, patchSucceeded } from './patch.mjs';
import { mask, oneLine } from '../text.mjs';

// 2: 날짜별 기다린 시간(w)과 이어 읽기용 상태(agentAt)를 더했다 (#243). 예전 캐시는 이미 읽은 줄의 w 가 없어
// 0 으로 보이므로 kind 를 올려 기록을 한 번 다시 읽는다.
const KIND = 'sheet2';
// 하루에 남기는 고친 파일 수 상한 (캐시가 커지지 않게). 넘으면 more 에 표시해 '200+' 처럼 보인다.
export const FILES_MAX = 200;
// 캐시에 남기는 지시 글 길이. 화면에는 더 짧게 자른다.
const PROMPT_MAX = 200;
// 결과를 기다리는 Codex 패치 수 상한.
const PENDING_MAX = 50;
// 날짜를 남기는 일수 (리포트가 보는 30일보다 조금 길게).
const KEEP = 32;
// 간격 하나에서 세는 기다린 시간 상한 (2시간). 그보다 긴 간격은 대개 자리를 비웠거나 다음 날 이어 쓴 것이라,
// 그대로 더하면 밤새 열어 둔 세션 하나가 합계를 덮는다. 버리지 않고 앞 2시간만 센다 (에이전트가 끝낸 직후가 실제로 기다린 몫에 가깝다).
export const WAIT_CAP_MS = 2 * 3600_000;

// 다음 로컬 0시 (기다린 시간을 날짜별로 나눌 때 쓴다).
const nextMidnight = (at) => {
  const d = new Date(at);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
};
// Claude 사용자 줄의 글.
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : '');
// 사람이 직접 낸 지시인지. 새 기록은 origin.kind(human, task-notification 등)나 turnOrigin 이 있고, 예전 기록은 글로 가른다
// (꺾쇠로 시작하는 글 가운데 슬래시 명령만 사람 입력이다).
function isHumanPrompt(x, text) {
  if (x.origin?.kind) return x.origin.kind === 'human';
  if (x.turnOrigin) return x.turnOrigin === 'human';
  return Boolean(text) && (!isNoisePrompt(text) || /^\s*<command-(name|message)>/.test(text));
}
// 도구 결과가 사용자의 답인지: 허락 창에서 사용자가 고른 결과(permissionDecision.source 가 user_ 로 시작)와 질문 도구(AskUserQuestion)의 답.
// 허락 창이 뜬 시각은 기록에 없어, 도구 호출 줄부터 결과 줄까지를 기다림으로 센다 (허락 뒤 도구가 돈 시간도 섞인다).
const isUserAnswer = (x) => /^user/.test(x.permissionDecision?.source ?? '') || (x.toolUseResult?.questions != null && x.toolUseResult?.answers != null);

const clip = (s) => {
  const one = mask(oneLine(s));
  return one ? one.slice(0, PROMPT_MAX) : null;
};

export class SessionSheet {
  // tool: 'claude' 또는 'codex'. sub: Claude 서브에이전트 기록 (지시 글을 세션 첫 지시로 쓰지 않는다).
  constructor(path, tool, { sub = false } = {}) {
    this.tool = tool;
    this.sub = sub;
    this.tail = new JsonlTail(path);
    this.tail.onReset = () => this.clear();
    this.clear();
    const c = loadCache(path, KIND);
    if (c) {
      this.tail.offset = c.offset;
      this.days = c.days ?? {};
      this.custom = c.custom ?? null;
      this.title = c.title ?? null;
      this.id = c.id ?? null;
      this.cwd = c.cwd ?? null;
      this.pending = c.pending ?? {};
      this.agentAt = c.agentAt ?? null;
    }
  }

  clear() {
    // 날짜 → { a: 첫 활동 ms, z: 마지막 활동 ms, f: 고친 파일 경로들, more: 상한을 넘었는지, p: 그날 첫 지시 }
    this.days = {};
    // custom: 사용자가 붙인 이름 (Claude custom-title, Codex thread_name_updated). title: 그 밖 이름 (Claude ai-title).
    this.custom = null;
    this.title = null;
    // Codex 세션 id (session_index.jsonl 이름을 찾을 때 쓴다)와 작업 폴더 (상대 경로 패치를 풀 때 쓴다).
    this.id = null;
    this.cwd = null;
    // Codex: 결과를 기다리는 패치 호출 id → 고칠 파일 경로들.
    this.pending = {};
    // 에이전트 쪽 마지막 줄 시각. 그 뒤 사용자 입력이 오면 그 사이를 기다린 시간으로 센다. 사용자 입력 뒤에는 null.
    this.agentAt = null;
  }

  // 아직 읽지 않은 크기.
  get left() {
    return Math.max(0, this.tail.size - this.tail.offset);
  }

  get path() {
    return this.tail.path;
  }

  update(budget) {
    const n = this.tail.read((x) => this.apply(x), budget);
    if (n) markDirty(this.tail.path, () => this.snapshot(), KIND);
    return n;
  }

  snapshot() {
    return { offset: this.tail.lineOffset, days: recentDays(this.days, KEEP), custom: this.custom, title: this.title, id: this.id, cwd: this.cwd, pending: this.pending, agentAt: this.agentAt };
  }

  day(at) {
    const d = (this.days[dayKey(at)] ??= { a: at, z: at, f: [] });
    // 기다린 시간만 넘어온 날(answer)은 a·z 가 없다.
    if (!(d.a <= at)) d.a = at;
    if (!(d.z >= at)) d.z = at;
    return d;
  }

  // 에이전트 쪽 줄: 여기부터 사용자를 기다린다.
  agent(at) {
    this.agentAt = at;
  }

  // 사용자 입력: 에이전트 쪽 마지막 줄부터 지금까지(상한 WAIT_CAP_MS)를 날짜별로 나눠 더한다.
  // 기간은 로컬 0시에 끊기므로 날짜별로 나눠 두면 기간 경계에 걸친 간격도 기간 안 몫만 세어진다.
  answer(at) {
    const from = this.agentAt;
    this.agentAt = null;
    if (from == null || !(at > from)) return;
    const end = from + Math.min(at - from, WAIT_CAP_MS);
    for (let t = from; t < end; ) {
      const cut = Math.min(end, nextMidnight(t));
      const d = (this.days[dayKey(t)] ??= { f: [] });
      d.w = (d.w ?? 0) + (cut - t);
      t = cut;
    }
  }

  // Claude 줄 하나로 기다린 시간 상태를 바꾼다. 서브에이전트 기록은 세지 않는다 (부모 세션에서만 센다, 이중 계산 방지).
  waitClaude(x, at) {
    // 예전 기록은 서브에이전트 줄(isSidechain)을 부모 기록 안에 섞어 썼다.
    if (this.sub || x.isSidechain) return;
    if (x.type === 'assistant') return this.agent(at);
    if (x.isMeta || x.isCompactSummary || !x.message) return;
    const c = x.message.content;
    if (Array.isArray(c) && c.some((p) => p?.type === 'tool_result')) return isUserAnswer(x) ? this.answer(at) : this.agent(at);
    const text = textOf(c);
    // 사용자가 끊으면 에이전트는 그때 멈추고 다음 지시를 기다린다. 끊기 전은 에이전트가 일하던 시간이다.
    if (/^\s*\[Request interrupted/.test(text)) return this.agent(at);
    if (!isHumanPrompt(x, text)) return;
    // 에이전트가 일하는 동안 미리 넣어 둔 지시(queued)는 기다림이 아니다.
    if (x.promptSource === 'queued') this.agentAt = null;
    else this.answer(at);
  }

  addFile(at, path) {
    if (typeof path !== 'string' || !path) return;
    const d = this.day(at);
    if (d.f.includes(path)) return;
    if (d.f.length >= FILES_MAX) d.more = true;
    else d.f.push(path);
  }

  prompt(at, text) {
    if (this.sub || !text || isNoisePrompt(text)) return;
    const d = this.day(at);
    d.p ??= clip(text);
  }

  apply(x) {
    if (this.tool === 'codex') return this.applyCodex(x);
    if (x.type === 'custom-title') this.custom = sessionName(x.customTitle);
    if (x.type === 'ai-title' && x.aiTitle) this.title = sessionName(x.aiTitle);
    if (x.type !== 'user' && x.type !== 'assistant') return;
    const at = Date.parse(x.timestamp);
    if (!Number.isFinite(at)) return;
    this.day(at);
    this.waitClaude(x, at);
    if (x.type !== 'user' || x.isMeta || !x.message) return;
    if (x.toolUseResult) {
      const c = readChange(x.toolUseResult, at);
      if (c) this.addFile(at, c.path);
    }
    const c = x.message.content;
    this.prompt(at, textOf(c));
  }

  applyCodex(x) {
    const p = x.payload ?? {};
    if (x.type === 'session_meta') {
      this.id = p.id ?? this.id;
      this.cwd = p.cwd ?? this.cwd;
      return;
    }
    if (x.type === 'turn_context') this.cwd = p.cwd ?? this.cwd;
    if (x.type !== 'event_msg' && x.type !== 'response_item') return;
    const at = Date.parse(x.timestamp);
    if (!Number.isFinite(at)) return;
    this.day(at);
    if (x.type === 'event_msg') {
      if (p.type === 'thread_name_updated') this.custom = sessionName(p.thread_name);
      if (p.type === 'user_message') {
        this.prompt(at, p.message);
        this.answer(at);
      } else if (p.type === 'turn_aborted') this.agent(at);
      // 차례 시작 알림은 사용자 지시와 함께 오므로 에이전트 줄로 보지 않는다. 그 밖(agent_message, token_count 등)은 에이전트 쪽이다.
      else if (p.type !== 'thread_name_updated' && p.type !== 'task_started' && p.type !== 'turn_started') this.agent(at);
      return;
    }
    // Codex 는 허락 요청·답을 기록에 남기지 않아 user_message 만 사용자 입력으로 센다. 사용자·개발자 메시지 줄은 에이전트 쪽이 아니다.
    if (!(p.type === 'message' && p.role !== 'assistant')) this.agent(at);
    // 패치는 결과가 성공일 때만 고친 파일로 센다 (codex.mjs 와 같다).
    let text = null;
    if (p.type === 'custom_tool_call' && p.name === 'apply_patch') text = String(p.input ?? '');
    else if (p.type === 'function_call') {
      let args = {};
      try {
        args = JSON.parse(p.arguments ?? '{}');
      } catch {}
      const cmd = Array.isArray(args.command) ? args.command.join('\n') : String(args.command ?? '');
      if (/\bapply_patch\b/.test(cmd)) text = extractPatch(cmd);
    } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && this.pending[p.call_id]) {
      const paths = this.pending[p.call_id];
      delete this.pending[p.call_id];
      if (patchSucceeded(p.output)) for (const f of paths) this.addFile(at, f);
      return;
    }
    if (text && p.call_id) {
      const paths = parsePatch(text, this.cwd).map((r) => r.filePath);
      if (!paths.length) return;
      const keys = Object.keys(this.pending);
      if (keys.length >= PENDING_MAX) delete this.pending[keys[0]];
      this.pending[p.call_id] = paths;
    }
  }
}

const sheets = new Map();

// 기록 파일 하나의 요약. 처음이면 만들고(캐시가 있으면 이어 읽는다), 같은 실행 안에서는 다시 쓴다.
export function sheetOf(path, tool, opts) {
  let s = sheets.get(path);
  if (!s) sheets.set(path, (s = new SessionSheet(path, tool, opts)));
  return s;
}

export const _test = { reset: () => sheets.clear() };
