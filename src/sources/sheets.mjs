// 세션 리포트(--report sessions)용 기록 요약: Claude·Codex 기록 파일 하나마다 날짜별 활동 시작·끝 시각, 고친 파일, 그날 첫 지시와
// 세션 이름(사용자 이름, 그 밖 이름)을 모은다. 사용량(토큰·비용)은 장부(claude-ledger.mjs 등)가 세고, 여기서는 세지 않는다.
// 장부 캐시 모양은 그대로 두고 따로 읽는다 (장부를 다시 세지 않게). 리포트가 기간 안에 사용량이 있는 기록만 부른다.
// 기록은 읽기만 하고, 어디까지 읽었는지는 aitop 캐시에 둔다.
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { dayKey, isNoisePrompt, recentDays, sessionName } from './common.mjs';
import { readChange } from './files.mjs';
import { parsePatch, extractPatch, patchSucceeded } from './patch.mjs';
import { mask, oneLine } from '../text.mjs';

const KIND = 'sheet1';
// 하루에 남기는 고친 파일 수 상한 (캐시가 커지지 않게). 넘으면 more 에 표시해 '200+' 처럼 보인다.
export const FILES_MAX = 200;
// 캐시에 남기는 지시 글 길이. 화면에는 더 짧게 자른다.
const PROMPT_MAX = 200;
// 결과를 기다리는 Codex 패치 수 상한.
const PENDING_MAX = 50;
// 날짜를 남기는 일수 (리포트가 보는 30일보다 조금 길게).
const KEEP = 32;

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
    return { offset: this.tail.lineOffset, days: recentDays(this.days, KEEP), custom: this.custom, title: this.title, id: this.id, cwd: this.cwd, pending: this.pending };
  }

  day(at) {
    const d = (this.days[dayKey(at)] ??= { a: at, z: at, f: [] });
    if (at < d.a) d.a = at;
    if (at > d.z) d.z = at;
    return d;
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
    if (x.type !== 'user' || x.isMeta || !x.message) return;
    if (x.toolUseResult) {
      const c = readChange(x.toolUseResult, at);
      if (c) this.addFile(at, c.path);
    }
    const c = x.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : '';
    this.prompt(at, text);
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
      if (p.type === 'user_message') this.prompt(at, p.message);
      return;
    }
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
