// Claude 대화 기록 한 개(메인 세션 또는 서브에이전트)를 따라 읽으며 토큰·비용·진행 단계를 누적한다.
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { claudeCost } from '../pricing.mjs';
import { addActivity, emptyTokens, pushEvent, describeTool, toolDetail, isNoisePrompt, parseTs, sessionName } from './common.mjs';
import { debugIo } from '../log.mjs';
import { addChange } from './files.mjs';
import { ARTIFACT_CALLS_MAX, addArtifact, isPublish, pickArtifact } from './artifacts.mjs';

const MAX_TURNS = 50;

const RECENT_IDS = 64;
const LOADING_MIN_BYTES = 4 * 1024 * 1024;
// Claude Code 는 /rename 이름(custom-title 줄)을 기록 뒤에 자주 다시 붙인다. 끝부분만 읽어도 마지막 이름을 찾는다.
const TAIL_BYTES = 256 * 1024;
const CUSTOM_TITLE = '"type":"custom-title"';

// 기록 끝 TAIL_BYTES 의 줄들. 읽지 못하면 null.
function tailLines(path) {
  let text;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      text = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, start));
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    debugIo('claude', 'transcript tail read failed', e, path);
    return null;
  }
  return text.split('\n');
}

// 기록 끝 TAIL_BYTES 에서 마지막 custom-title 이름. 줄이 없으면 undefined, 이름이 비었으면 null.
export function tailCustomTitle(path) {
  const lines = tailLines(path);
  if (!lines) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(CUSTOM_TITLE)) continue;
    try {
      const x = JSON.parse(lines[i]);
      if (x.type === 'custom-title') return sessionName(x.customTitle);
    } catch {}
  }
  return undefined;
}

// API 오류 줄(isApiErrorMessage)이 말하는 멈춘 이유. 이 PC 기록 표본에서 확인한 형식만 가른다.
//   error: 'authentication_failed' (본문 'Login expired · Please run /login', 'OAuth session expired ...') → auth
//   apiError: 'connection_failed' (error: 'server_error', 본문 'API Error: Connection lost mid-response ...') → network
// 사용 한도 줄은 표본이 없어 따로 가르지 않고(재개 시각도 읽지 않는다) 그 밖의 오류와 함께 api 로 둔다.
export function stopReasonOf(x) {
  if (x?.type !== 'assistant' || x.isApiErrorMessage !== true) return null;
  if (x.error === 'authentication_failed') return { kind: 'auth' };
  if (x.apiError === 'connection_failed') return { kind: 'network' };
  return { kind: 'api' };
}

// 기록 끝에서 멈춘 이유를 다시 찾는다: 마지막 대화 줄(assistant·user, isMeta 제외)이 API 오류면 그 이유, 아니면 null.
// 이 필드가 생기기 전 캐시를 위해서다. 오류 뒤에는 대화가 아닌 줄(last-prompt, turn_duration 등)만 붙는다.
export function tailStopReason(path) {
  const lines = tailLines(path);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"type":"assistant"') && !l.includes('"type":"user"')) continue;
    try {
      const x = JSON.parse(l);
      if ((x.type === 'assistant' || x.type === 'user') && x.message && !x.isMeta) return stopReasonOf(x);
    } catch {}
  }
  return null;
}

// 기록을 남긴 실행 방식 (entrypoint): 사람이 연 Claude Code 는 'cli', 다른 프로그램이 띄운 claude -p(SDK) 는 'sdk-cli' 다 (#286).
// 첫 줄부터 붙으므로 앞 HEAD_ENTRY_BYTES 만 본다. 모르면 null.
const HEAD_ENTRY_BYTES = 64 * 1024;
export function headEntrypoint(path) {
  let text;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(HEAD_ENTRY_BYTES);
      text = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    debugIo('claude', 'transcript head read failed', e, path);
    return null;
  }
  for (const l of text.split('\n')) {
    if (!l.includes('"entrypoint"')) continue;
    try {
      const x = JSON.parse(l);
      if (typeof x.entrypoint === 'string') return x.entrypoint;
    } catch {}
  }
  return null;
}

// 프롬프트 캐시 수명. 공식 문서(https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 기준:
//   기본 5분, 1시간은 선택. 캐시를 쓰거나 읽을 때마다 수명이 새로 시작되고, 수명은 응답 끝이 아니라 그 요청이 시작된 때부터 잰다.
// 요청 시작 시각은 기록에 없으므로 그 응답 바로 앞의 사용자 줄(지시·도구 결과) 시각으로 잡는다. 없으면 응답 줄 시각.
export const CACHE_TTL_5M = 300;
export const CACHE_TTL_1H = 3600;

// 응답 한 줄의 usage 로 캐시 상태를 갱신한다. st: { cacheAt, cacheTtl, inputAt, inputFor }. 바꾸면 true.
// inputAt 은 한 요청(message.id)에만 쓴다. 사용자 줄 없이 다른 응답이 이어지면 그 응답 줄 시각을 쓴다.
//   1시간 쓰기 토큰이 있으면 1시간, 5분 쓰기 토큰(또는 쪼갠 값이 없는 쓰기)이 있으면 5분.
//   읽기만 있으면 읽은 항목의 수명이 다시 시작되므로 앞서 정한 TTL 을 그대로 쓴다 (모르면 기본 5분).
//   캐시를 쓰지도 읽지도 않은 응답은 캐시를 건드리지 않는다.
export function applyCacheUsage(st, u, at, id = null) {
  if (!u || !Number.isFinite(at)) return false;
  const cc = u.cache_creation;
  const h1 = cc?.ephemeral_1h_input_tokens ?? 0;
  const m5 = cc?.ephemeral_5m_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  let ttl;
  if (h1 > 0) ttl = CACHE_TTL_1H;
  else if (m5 > 0 || write > 0) ttl = CACHE_TTL_5M;
  else if (read > 0) ttl = st.cacheTtl ?? CACHE_TTL_5M;
  else return false;
  const fresh = Number.isFinite(st.inputAt) && st.inputAt <= at && (st.inputFor == null || st.inputFor === id);
  st.cacheAt = fresh ? st.inputAt : at;
  st.inputFor = fresh ? id : null;
  if (!fresh) st.inputAt = null;
  st.cacheTtl = ttl;
  return true;
}

// 기록 끝 TAIL_BYTES 를 앞에서부터 다시 읽어 캐시 상태를 만든다. 이 필드가 생기기 전 캐시를 위해서다.
export function tailCacheState(path) {
  const st = { cacheAt: null, cacheTtl: null, inputAt: null, inputFor: null };
  for (const l of tailLines(path) ?? []) {
    if (!l.includes('"type":"assistant"') && !l.includes('"type":"user"')) continue;
    try {
      cacheStep(st, JSON.parse(l));
    } catch {}
  }
  return st;
}

// 대화 줄 하나를 캐시 상태에 반영한다 (apply 와 tailCacheState 가 같이 쓴다).
function cacheStep(st, x) {
  if (x.isMeta || !x.message) return;
  if (x.type === 'user') {
    st.inputAt = parseTs(x.timestamp);
    st.inputFor = null;
  }
  // API 오류 줄은 사용량이 0 이라 캐시를 건드리지 않는다.
  else if (x.type === 'assistant' && x.message.usage) applyCacheUsage(st, x.message.usage, parseTs(x.timestamp), x.message.id ?? null);
}

// 결과가 아직 없는 tool_use 의 시작 시각(at)을 기록 끝에서 찾아 채운다. at 필드가 생기기 전 캐시를 위해서다.
// pending: Map(tool_use id → 열린 호출). at 이 없는 것만 고치고, 고친 것이 있으면 true.
export function tailToolStarts(path, pending) {
  const want = [...pending].filter(([, p]) => !('at' in p));
  if (!want.length) return false;
  for (const [, p] of want) p.at = null;
  const ids = new Map(want);
  for (const l of tailLines(path) ?? []) {
    if (!l.includes('"tool_use"')) continue;
    try {
      const x = JSON.parse(l);
      for (const c of Array.isArray(x.message?.content) ? x.message.content : []) {
        if (c.type === 'tool_use' && ids.has(c.id)) ids.get(c.id).at = parseTs(x.timestamp);
      }
    } catch {}
  }
  return true;
}

export class ClaudeTracker {
  constructor(path) {
    this.tail = new JsonlTail(path);
    this.tail.onReset = () => this.reset();
    this.reset();
    this.title = null;
    // 사용자가 /rename 으로 붙인 이름. 기록의 마지막 custom-title 이 이긴다.
    this.customTitle = null;
    this.branch = null;
    // 실행 방식 (headEntrypoint). 기록의 첫 값을 쓴다.
    this.entrypoint = null;

    const c = loadCache(path);
    if (c) {
      this.tail.offset = c.offset;
      Object.assign(this, { tokens: c.tokens, cost: c.cost, costNoCache: c.costNoCache, costUnknown: c.costUnknown, context: c.context, model: c.model, title: c.title, customTitle: c.customTitle ?? null, branch: c.branch, events: c.events, lastTool: c.lastTool, lastKind: c.lastKind, files: c.files ?? [], turns: c.turns ?? [], turnCount: c.turnCount ?? 0, firstAt: c.firstAt ?? null, activity: c.activity ?? {}, stopReason: c.stopReason ?? null, cacheAt: c.cacheAt ?? null, cacheTtl: c.cacheTtl ?? null, inputAt: c.inputAt ?? null, inputFor: c.inputFor ?? null, artifacts: c.artifacts ?? [] });
      this.artCalls = new Map(c.artCalls ?? []);
      this.recent = new Map(c.recent);
      this.pending = new Map(c.pending);
      // 이 필드가 생기기 전 캐시는 이미 지나간 custom-title 을 모른다. 끝부분을 한 번 훑어 채우고 캐시에 다시 적어
      // 새 줄이 없어도 다음 실행에서 또 훑지 않게 한다 (캐시 버전은 그대로).
      if (!('customTitle' in c)) {
        this.customTitle = tailCustomTitle(path) ?? null;
        markDirty(path, () => this.snapshot());
      }
      // 실행 방식도 같은 방식으로 한 번만 채운다 (캐시 버전은 그대로, 기록 앞부분만 읽는다).
      if ('entrypoint' in c) this.entrypoint = c.entrypoint;
      else {
        this.entrypoint = headEntrypoint(path);
        markDirty(path, () => this.snapshot());
      }
      // 멈춘 이유도 같은 방식으로 한 번만 채운다 (캐시 버전은 그대로).
      if (!('stopReason' in c)) {
        this.stopReason = tailStopReason(path);
        markDirty(path, () => this.snapshot());
      }
      // 프롬프트 캐시 상태도 같은 방식으로 한 번만 채운다 (캐시 버전은 그대로).
      if (!('cacheAt' in c)) {
        const { cacheAt, cacheTtl } = tailCacheState(path);
        Object.assign(this, { cacheAt, cacheTtl });
        markDirty(path, () => this.snapshot());
      }
      // 열린 도구 호출의 시작 시각도 같은 방식으로 한 번만 채운다 (캐시 버전은 그대로).
      if (tailToolStarts(path, this.pending)) markDirty(path, () => this.snapshot());
    }
  }

  // 누적값 초기화. 기록 파일이 줄어 처음부터 다시 읽을 때도 쓴다.
  reset() {
    this.recent = new Map();
    this.tokens = emptyTokens();
    this.cost = 0;
    this.costNoCache = 0;
    // 가격표에 없는 모델의 사용량이 섞였는지. 그 몫은 비용에 넣지 않는다 (--json 의 costUnknown, 상세 패널 안내 줄).
    this.costUnknown = false;
    this.context = 0;
    this.model = null;
    this.events = [];
    this.lastTool = null;
    this.pending = new Map();
    this.lastKind = null;
    // Edit/Write 로 고친 파일 (files.mjs)
    this.files = [];
    // 사용자 지시: { n: 몇 번째 지시, at, text }. 변경 파일을 지시 단위로 나눌 때 쓴다.
    this.turns = [];
    this.turnCount = 0;
    // 기록의 첫 시각. 서브에이전트 편집을 지시에 나눌 때 쓴다.
    this.firstAt = null;
    // 시간별 토큰 (common.mjs addActivity)
    this.activity = {};
    // 마지막 대화 줄이 API 오류면 멈춘 이유 { kind: 'auth'|'network'|'api' } (stopReasonOf), 아니면 null.
    // 그 뒤 정상 assistant 줄이나 사용자 줄이 오면 지운다.
    this.stopReason = null;
    // 프롬프트 캐시 (applyCacheUsage): 수명이 시작된 시각(ms), TTL(초), 마지막 사용자 줄 시각(다음 요청 시작으로 본다).
    this.cacheAt = null;
    this.cacheTtl = null;
    this.inputAt = null;
    this.inputFor = null;
    // Artifact 도구로 게시한 것 (artifacts.mjs): 최근 순, 묶은 아티팩트마다 { id, title, url, from, to, at, audience, edits }.
    this.artifacts = [];
    // 결과를 기다리는 게시 호출: tool_use id → edits 로 고쳤는지.
    this.artCalls = new Map();
  }

  // 프롬프트 캐시가 만료되는 시각(ms). 캐시를 쓴 응답이 없으면 null.
  get cacheExpiresAt() {
    return Number.isFinite(this.cacheAt) && this.cacheTtl ? this.cacheAt + this.cacheTtl * 1000 : null;
  }

  get path() {
    return this.tail.path;
  }

  get mtimeMs() {
    return this.tail.mtimeMs;
  }

  // 아직 읽지 않은 양이 많으면 0~1 사이 진행률, 거의 다 읽었으면 null.
  // 새로 붙은 몇 줄을 다음 갱신으로 미룬 것까지 '읽는 중' 으로 보이면 실제 진행 단계가 가려진다.
  get loading() {
    return this.tail.size - this.tail.offset > LOADING_MIN_BYTES ? this.tail.progress : null;
  }

  update(budget) {
    const n = this.tail.read((x) => this.apply(x), budget);
    if (n) markDirty(this.path, () => this.snapshot());
    return n;
  }

  snapshot() {
    return {
      offset: this.tail.lineOffset,
      tokens: this.tokens,
      cost: this.cost,
      costNoCache: this.costNoCache,
      costUnknown: this.costUnknown,
      context: this.context,
      model: this.model,
      title: this.title,
      customTitle: this.customTitle,
      branch: this.branch,
      entrypoint: this.entrypoint,
      events: this.events,
      lastTool: this.lastTool,
      lastKind: this.lastKind,
      recent: [...this.recent],
      pending: [...this.pending],
      files: this.files,
      turns: this.turns,
      turnCount: this.turnCount,
      firstAt: this.firstAt,
      activity: this.activity,
      stopReason: this.stopReason,
      cacheAt: this.cacheAt,
      cacheTtl: this.cacheTtl,
      inputAt: this.inputAt,
      inputFor: this.inputFor,
      artifacts: this.artifacts,
      artCalls: [...this.artCalls],
    };
  }

  // 같은 message.id 가 블록마다 여러 줄로 반복되므로, 직전 값과의 차이만 더한다.
  addUsage(id, model, u, at) {
    const prev = this.recent.get(id);
    const n = (x, k) => x?.[k] ?? 0;
    const t = this.tokens;
    const before = t.total;
    t.input += n(u, 'input_tokens') - n(prev?.u, 'input_tokens');
    t.output += n(u, 'output_tokens') - n(prev?.u, 'output_tokens');
    t.cacheRead += n(u, 'cache_read_input_tokens') - n(prev?.u, 'cache_read_input_tokens');
    t.cacheWrite += n(u, 'cache_creation_input_tokens') - n(prev?.u, 'cache_creation_input_tokens');
    t.total = t.input + t.output + t.cacheRead + t.cacheWrite;
    addActivity(this.activity, at, t.total - before);
    const cost = claudeCost(model, u);
    const used = n(u, 'input_tokens') + n(u, 'output_tokens') + n(u, 'cache_read_input_tokens') + n(u, 'cache_creation_input_tokens');
    if (!cost && used > 0) this.costUnknown = true;
    this.cost += (cost?.total ?? 0) - (prev?.cost?.total ?? 0);
    this.costNoCache += (cost?.noCache ?? 0) - (prev?.cost?.noCache ?? 0);
    this.recent.delete(id);
    this.recent.set(id, { u, cost });
    if (this.recent.size > RECENT_IDS) this.recent.delete(this.recent.keys().next().value);
  }

  apply(x) {
    if (x.type === 'ai-title' && x.aiTitle) this.title = x.aiTitle;
    if (x.type === 'custom-title') this.customTitle = sessionName(x.customTitle);
    if (x.gitBranch) this.branch = x.gitBranch;
    if (typeof x.entrypoint === 'string') this.entrypoint ??= x.entrypoint;
    if (this.firstAt == null && x.timestamp) this.firstAt = parseTs(x.timestamp);
    if (x.isMeta) return;

    if ((x.type === 'assistant' || x.type === 'user') && x.message) {
      this.stopReason = stopReasonOf(x);
      cacheStep(this, x);
    }

    if (x.type === 'assistant' && x.message) {
      const m = x.message;
      if (m.model && !m.model.startsWith('<')) this.model = m.model;
      if (m.usage && m.id) {
        this.addUsage(m.id, m.model ?? this.model, m.usage, parseTs(x.timestamp));
        this.context = (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'tool_use') {
          this.lastTool = describeTool(c.name, c.input);
          // at: 호출을 낸 줄의 시각 (도구 실행 경과 시간의 기준). resumeAt: 허락 대기를 마지막으로 본 시각 (markWaiting).
          this.pending.set(c.id, { name: c.name, what: this.lastTool, detail: toolDetail(c.name, c.input), agent: c.input?.subagent_type ?? null, at: parseTs(x.timestamp) });
          if (c.name === 'Artifact' && isPublish(c.input)) {
            this.artCalls.set(c.id, Boolean(c.input?.edits));
            if (this.artCalls.size > ARTIFACT_CALLS_MAX) this.artCalls.delete(this.artCalls.keys().next().value);
          }
          pushEvent(this, x.timestamp, 'tool', this.lastTool);
          this.lastKind = 'tool';
        } else if (c.type === 'text' && c.text?.trim()) {
          pushEvent(this, x.timestamp, 'reply', c.text);
          this.lastKind = 'reply';
        }
      }
    }

    if (x.type === 'user' && x.message) {
      if (x.toolUseResult) addChange(this.files, x.toolUseResult, x.timestamp);
      const c = x.message.content;
      if (Array.isArray(c)) for (const p of c) if (p.type === 'tool_result') this.pending.delete(p.tool_use_id);
      if (Array.isArray(c) && this.artCalls.size) this.applyArtifact(x, c);
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '';
      if (text && !isNoisePrompt(text)) {
        const e = pushEvent(this, x.timestamp, 'prompt', text);
        if (e) {
          this.turns.push({ n: ++this.turnCount, at: e.at, text: e.text.slice(0, 120) });
          if (this.turns.length > MAX_TURNS) this.turns.shift();
        }
        this.lastKind = 'prompt';
        this.pending.clear();
      } else if (Array.isArray(c) && c.some((p) => p.type === 'tool_result')) this.lastKind = 'result';
    }
  }

  // 게시 호출의 결과 줄이면 아티팩트 목록에 더한다. 오류 결과는 빼고, 결과 값은 artifacts.mjs pickArtifact 가 고른 것만 담는다.
  applyArtifact(x, content) {
    for (const p of content) {
      if (p.type !== 'tool_result' || !this.artCalls.has(p.tool_use_id)) continue;
      const edits = this.artCalls.get(p.tool_use_id);
      this.artCalls.delete(p.tool_use_id);
      if (p.is_error) continue;
      const a = pickArtifact(x.toolUseResult, parseTs(x.timestamp), edits);
      if (a) this.artifacts = addArtifact(this.artifacts, a);
    }
  }

  // 허락을 기다리는 동안 보일 요청 내용. 열린 도구 호출 가운데 대기 문구(approve Bash 등)에 이름이 나온 것을 먼저,
  // 없으면 가장 최근 것을 고른다. 팀원(Agent·Task) 호출만 열려 있으면 없음.
  waitDetail(waitingFor = '') {
    const tools = [...this.pending.values()].filter((p) => p.name !== 'Agent' && p.name !== 'Task');
    const words = new Set(String(waitingFor ?? '').split(/[^A-Za-z0-9_]+/).filter(Boolean));
    const named = tools.filter((p) => words.has(p.name));
    return (named.at(-1) ?? tools.at(-1))?.detail ?? null;
  }

  // 허락 대기를 보는 동안 열린 도구 호출마다 그 시각을 적는다. 허락한 뒤의 경과 시간은 여기서부터 잰다 (toolStartedAt).
  // 기록에는 허락한 시각이 없으므로 대기를 마지막으로 본 시각(갱신 1초 간격)으로 갈음한다. 기록이 바뀐 것은 아니라 캐시에 따로 적지 않는다.
  markWaiting(now = Date.now()) {
    for (const p of this.pending.values()) if (p.name !== 'Agent' && p.name !== 'Task') p.resumeAt = now;
  }

  // phase() 가 보이는 도구(열린 도구 호출 가운데 마지막 것)가 돌기 시작한 시각(ms). 허락을 기다렸으면 대기가 끝난 뒤부터. 모르면 null.
  toolStartedAt() {
    const p = [...this.pending.values()].filter((p) => p.name !== 'Agent' && p.name !== 'Task').at(-1);
    if (!p || !Number.isFinite(p.at)) return null;
    return Number.isFinite(p.resumeAt) ? Math.max(p.at, p.resumeAt) : p.at;
  }

  // 지금 무엇을 하는 단계인지: 도구 실행 / 팀원 대기 / 생각 중 / 답변 작성 중.
  phase() {
    const open = [...this.pending.values()];
    const agents = open.filter((p) => p.name === 'Agent' || p.name === 'Task');
    const tools = open.filter((p) => p.name !== 'Agent' && p.name !== 'Task');
    if (tools.length) return { kind: 'tool', args: { what: tools.at(-1).name } };
    if (agents.length) return { kind: 'team', args: { n: agents.length } };
    if (this.lastKind === 'prompt' || this.lastKind === 'result') return { kind: 'think' };
    return { kind: 'write' };
  }
}
