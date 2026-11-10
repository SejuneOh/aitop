// 날짜별 사용량 장부: 최근 7일 안에 바뀐 Claude 기록(서브에이전트 포함)에서 사용량만 날짜별로 모은다.
// Antigravity CLI(agy)·Codex CLI 사용량은 agy-ledger.mjs·codex-ledger.mjs 가 같은 모양으로 모으고, 여기서 함께 더한다.
// 세션 화면과 상관없이 끝난 세션까지 세야 해서, 세션 tracker 와 따로 가볍게 읽고 캐시도 따로 둔다.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { claudeCost } from '../pricing.mjs';
import { dayKey, lastDays, addSlot, lastHourOf, recentTodayOf } from './common.mjs';
import { collectAgyLedger } from './agy-ledger.mjs';
import { collectCodexLedger } from './codex-ledger.mjs';

export { dayKey };

const HOME = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const PROJECTS = join(HOME, 'projects');
const KIND = 'ledger';
const DAYS = 7;
const KEEP_DAYS = 10;
const LIST_TTL_MS = 30_000;
const RECENT_IDS = 64;
const LOADING_MIN_BYTES = 4 * 1024 * 1024;

export class UsageTracker {
  constructor(path) {
    this.tail = new JsonlTail(path);
    this.tail.onReset = () => {
      this.recent = new Map();
      this.days = {};
      this.slots = {};
    };
    this.recent = new Map();
    this.days = {};
    // 지출 속도용 5분 칸 (common.mjs addSlot).
    this.slots = {};
    const c = loadCache(path, KIND);
    if (c) {
      this.tail.offset = c.offset;
      this.days = c.days ?? {};
      this.slots = c.slots ?? {};
      this.recent = new Map(c.recent ?? []);
    }
  }

  update(budget) {
    const n = this.tail.read((x) => this.apply(x), budget);
    if (n) markDirty(this.tail.path, () => this.snapshot(), KIND);
    return n;
  }

  get pending() {
    return Math.max(0, this.tail.size - this.tail.offset);
  }

  snapshot() {
    const keep = new Set(lastDays(KEEP_DAYS));
    const days = Object.fromEntries(Object.entries(this.days).filter(([k]) => keep.has(k)));
    return { offset: this.tail.lineOffset, days, slots: this.slots, recent: [...this.recent] };
  }

  // 같은 message.id 가 여러 줄로 반복되므로 직전 값과의 차이만, 그 줄의 날짜와 5분 칸에 더한다.
  apply(x) {
    const m = x.message;
    if (x.type !== 'assistant' || !m?.usage || !m.id) return;
    const u = m.usage;
    const n = (o, k) => o?.[k] ?? 0;
    const tokensOf = (o) => n(o, 'input_tokens') + n(o, 'output_tokens') + n(o, 'cache_read_input_tokens') + n(o, 'cache_creation_input_tokens');
    const prev = this.recent.get(m.id);
    const cost = claudeCost(m.model, u);
    const at = Date.parse(x.timestamp) || Date.now();
    const day = (this.days[dayKey(at)] ??= { tokens: 0, cost: 0, costNoCache: 0, unknown: false });
    const dCost = (cost?.total ?? 0) - (prev?.cost ?? 0);
    const dNoCache = (cost?.noCache ?? 0) - (prev?.costNoCache ?? 0);
    const unknown = !cost && tokensOf(u) > 0;
    day.tokens += tokensOf(u) - tokensOf(prev?.u);
    day.cost += dCost;
    day.costNoCache = (day.costNoCache ?? 0) + (cost?.noCache ?? 0) - (prev?.costNoCache ?? 0);
    if (unknown) day.unknown = true;
    addSlot(this.slots, at, dCost, dNoCache, unknown);
    this.recent.delete(m.id);
    this.recent.set(m.id, { u, cost: cost?.total ?? 0, costNoCache: cost?.noCache ?? 0 });
    if (this.recent.size > RECENT_IDS) this.recent.delete(this.recent.keys().next().value);
  }
}

let listed = { at: 0, files: [] };

// 최근 7일 안에 바뀐 메인 기록과 서브에이전트 기록.
function recentFiles() {
  if (Date.now() - listed.at < LIST_TTL_MS) return listed.files;
  const cutoff = Date.now() - DAYS * 86400_000;
  const files = [];
  const add = (p) => {
    try {
      if (statSync(p).mtimeMs >= cutoff) files.push(p);
    } catch {}
  };
  let dirs = [];
  try {
    dirs = readdirSync(PROJECTS);
  } catch {}
  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(join(PROJECTS, dir));
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(PROJECTS, dir, n);
      if (n.endsWith('.jsonl')) add(p);
      else if (existsSync(join(p, 'subagents'))) {
        try {
          for (const s of readdirSync(join(p, 'subagents'))) if (s.endsWith('.jsonl')) add(join(p, 'subagents', s));
        } catch {}
      }
    }
  }
  listed = { at: Date.now(), files };
  return files;
}

const trackers = new Map();

// 오늘·최근 7일·최근 1시간 합계 (Claude + agy + Codex). 아직 다 읽지 못했으면 loading 에 진행률(0~1).
export function collectLedger({ budget, now = Date.now() } = {}) {
  const files = recentFiles();
  const keep = new Set(files);
  for (const p of trackers.keys()) if (!keep.has(p)) trackers.delete(p);
  let pending = 0;
  let size = 0;
  for (const p of files) {
    let t = trackers.get(p);
    if (!t) trackers.set(p, (t = new UsageTracker(p)));
    t.update(budget);
    pending += t.pending;
    size += t.tail.size;
  }
  const others = [collectAgyLedger({ budget, now }), collectCodexLedger({ budget })];
  const books = [...trackers.values()].map((t) => t.days);
  const slots = [...trackers.values()].map((t) => t.slots);
  for (const o of others) {
    pending += o.pending;
    size += o.size;
    books.push(...o.days);
    slots.push(...o.slots);
  }
  const sum = (keys) => {
    const out = { tokens: 0, cost: 0, costNoCache: 0, unknown: false };
    for (const days of books)
      for (const k of keys) {
        const d = days[k];
        if (!d) continue;
        out.tokens += d.tokens;
        out.cost += d.cost;
        out.costNoCache += d.costNoCache ?? 0;
        out.unknown ||= d.unknown;
      }
    return out;
  };
  return {
    today: sum([dayKey(now)]),
    week: sum(lastDays(DAYS, now)),
    // 7일 막대용 날짜별 비용. 오래된 날부터 오늘까지 (읽을 때 날짜별 합계에서 만든다).
    days7: lastDays(DAYS, now).reverse().map((date) => {
      const d = sum([date]);
      return { date, cost: d.cost, costNoCache: d.costNoCache, unknown: d.unknown };
    }),
    lastHour: lastHourOf(slots, now),
    recentToday: recentTodayOf(slots, now),
    // 살아 있는 세션은 계속 조금씩 늘어나므로, 많이 밀렸을 때만 '집계 중' 으로 본다.
    loading: pending > LOADING_MIN_BYTES && size ? 1 - pending / size : null,
  };
}

export const _test = { lastDays };
