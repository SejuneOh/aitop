// Claude 대화 기록 한 개(메인 세션 또는 서브에이전트)를 따라 읽으며 토큰·비용·진행 단계를 누적한다.
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { claudeCost } from '../pricing.mjs';
import { emptyTokens, pushEvent, describeTool, toolDetail, isNoisePrompt, parseTs } from './common.mjs';
import { addChange } from './files.mjs';

const MAX_TURNS = 50;

const RECENT_IDS = 64;
const LOADING_MIN_BYTES = 4 * 1024 * 1024;

export class ClaudeTracker {
  constructor(path) {
    this.tail = new JsonlTail(path);
    this.tail.onReset = () => this.reset();
    this.reset();
    this.title = null;
    this.branch = null;

    const c = loadCache(path);
    if (c) {
      this.tail.offset = c.offset;
      Object.assign(this, { tokens: c.tokens, cost: c.cost, costNoCache: c.costNoCache, costUnknown: c.costUnknown, context: c.context, model: c.model, title: c.title, branch: c.branch, events: c.events, lastTool: c.lastTool, lastKind: c.lastKind, files: c.files ?? [], turns: c.turns ?? [], turnCount: c.turnCount ?? 0, firstAt: c.firstAt ?? null });
      this.recent = new Map(c.recent);
      this.pending = new Map(c.pending);
    }
  }

  // 누적값 초기화. 기록 파일이 줄어 처음부터 다시 읽을 때도 쓴다.
  reset() {
    this.recent = new Map();
    this.tokens = emptyTokens();
    this.cost = 0;
    this.costNoCache = 0;
    // 가격표에 없는 모델의 사용량이 섞였는지. 그 몫은 비용에 넣지 않고 화면에 '?' 로 알린다.
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
      branch: this.branch,
      events: this.events,
      lastTool: this.lastTool,
      lastKind: this.lastKind,
      recent: [...this.recent],
      pending: [...this.pending],
      files: this.files,
      turns: this.turns,
      turnCount: this.turnCount,
      firstAt: this.firstAt,
    };
  }

  // 같은 message.id 가 블록마다 여러 줄로 반복되므로, 직전 값과의 차이만 더한다.
  addUsage(id, model, u) {
    const prev = this.recent.get(id);
    const n = (x, k) => x?.[k] ?? 0;
    const t = this.tokens;
    t.input += n(u, 'input_tokens') - n(prev?.u, 'input_tokens');
    t.output += n(u, 'output_tokens') - n(prev?.u, 'output_tokens');
    t.cacheRead += n(u, 'cache_read_input_tokens') - n(prev?.u, 'cache_read_input_tokens');
    t.cacheWrite += n(u, 'cache_creation_input_tokens') - n(prev?.u, 'cache_creation_input_tokens');
    t.total = t.input + t.output + t.cacheRead + t.cacheWrite;
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
    if (x.gitBranch) this.branch = x.gitBranch;
    if (this.firstAt == null && x.timestamp) this.firstAt = parseTs(x.timestamp);
    if (x.isMeta) return;

    if (x.type === 'assistant' && x.message) {
      const m = x.message;
      if (m.model && !m.model.startsWith('<')) this.model = m.model;
      if (m.usage && m.id) {
        this.addUsage(m.id, m.model ?? this.model, m.usage);
        this.context = (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'tool_use') {
          this.lastTool = describeTool(c.name, c.input);
          this.pending.set(c.id, { name: c.name, what: this.lastTool, detail: toolDetail(c.name, c.input), agent: c.input?.subagent_type ?? null });
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

  // 허락을 기다리는 동안 보일 요청 내용. 열린 도구 호출 가운데 대기 문구(approve Bash 등)에 이름이 나온 것을 먼저,
  // 없으면 가장 최근 것을 고른다. 팀원(Agent·Task) 호출만 열려 있으면 없음.
  waitDetail(waitingFor = '') {
    const tools = [...this.pending.values()].filter((p) => p.name !== 'Agent' && p.name !== 'Task');
    const words = new Set(String(waitingFor ?? '').split(/[^A-Za-z0-9_]+/).filter(Boolean));
    const named = tools.filter((p) => words.has(p.name));
    return (named.at(-1) ?? tools.at(-1))?.detail ?? null;
  }

  // 지금 무엇을 하는 단계인지: 도구 실행 / 팀원 대기 / 생각 중 / 답변 작성 중.
  phase() {
    const open = [...this.pending.values()];
    const agents = open.filter((p) => p.name === 'Agent' || p.name === 'Task');
    const tools = open.filter((p) => p.name !== 'Agent' && p.name !== 'Task');
    if (tools.length) return { kind: 'tool', text: `도구 실행 · ${tools.at(-1).name}` };
    if (agents.length) return { kind: 'team', text: `팀원 ${agents.length}명 작업 중` };
    if (this.lastKind === 'prompt' || this.lastKind === 'result') return { kind: 'think', text: '생각 중' };
    return { kind: 'write', text: '답변 작성 중' };
  }
}
