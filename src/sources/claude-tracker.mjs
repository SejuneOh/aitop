// Claude 대화 기록 한 개(메인 세션 또는 서브에이전트)를 따라 읽으며 토큰·비용·진행 단계를 누적한다.
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { claudeCost } from '../pricing.mjs';
import { emptyTokens, pushEvent, describeTool, isNoisePrompt } from './common.mjs';

const RECENT_IDS = 64;

export class ClaudeTracker {
  constructor(path) {
    this.tail = new JsonlTail(path);
    this.recent = new Map();
    this.tokens = emptyTokens();
    this.cost = 0;
    this.context = 0;
    this.model = null;
    this.title = null;
    this.branch = null;
    this.events = [];
    this.lastTool = null;
    this.pending = new Map();
    this.lastKind = null;

    const c = loadCache(path);
    if (c) {
      this.tail.offset = c.offset;
      Object.assign(this, { tokens: c.tokens, cost: c.cost, context: c.context, model: c.model, title: c.title, branch: c.branch, events: c.events, lastTool: c.lastTool, lastKind: c.lastKind });
      this.recent = new Map(c.recent);
      this.pending = new Map(c.pending);
    }
  }

  get path() {
    return this.tail.path;
  }

  get mtimeMs() {
    return this.tail.mtimeMs;
  }

  // 아직 기록을 끝까지 읽지 못했으면 0~1 사이 진행률, 다 읽었으면 null.
  get loading() {
    return this.tail.done ? null : this.tail.progress;
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
      context: this.context,
      model: this.model,
      title: this.title,
      branch: this.branch,
      events: this.events,
      lastTool: this.lastTool,
      lastKind: this.lastKind,
      recent: [...this.recent],
      pending: [...this.pending],
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
    this.cost += cost - (prev?.cost ?? 0);
    this.recent.delete(id);
    this.recent.set(id, { u, cost });
    if (this.recent.size > RECENT_IDS) this.recent.delete(this.recent.keys().next().value);
  }

  apply(x) {
    if (x.type === 'ai-title' && x.aiTitle) this.title = x.aiTitle;
    if (x.gitBranch) this.branch = x.gitBranch;
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
          this.pending.set(c.id, { name: c.name, what: this.lastTool, agent: c.input?.subagent_type ?? null });
          pushEvent(this, x.timestamp, 'tool', this.lastTool);
          this.lastKind = 'tool';
        } else if (c.type === 'text' && c.text?.trim()) {
          pushEvent(this, x.timestamp, 'reply', c.text);
          this.lastKind = 'reply';
        }
      }
    }

    if (x.type === 'user' && x.message) {
      const c = x.message.content;
      if (Array.isArray(c)) for (const p of c) if (p.type === 'tool_result') this.pending.delete(p.tool_use_id);
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '';
      if (text && !isNoisePrompt(text)) {
        pushEvent(this, x.timestamp, 'prompt', text);
        this.lastKind = 'prompt';
        this.pending.clear();
      } else if (Array.isArray(c) && c.some((p) => p.type === 'tool_result')) this.lastKind = 'result';
    }
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
