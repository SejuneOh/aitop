// 날짜별 사용량 장부의 Codex CLI 몫: 최근 7일 안에 바뀐 rollout-*.jsonl 의 token_count 를 날짜와 5분 칸에 나눠 모은다.
// token_count 는 세션 누적값(total_token_usage)이라, 같은 파일의 직전 누적값과의 차이만 그 줄의 시각에 더한다.
// 같은 누적값이 되풀이되면 차이가 0 이라 두 번 세지 않고, 누적값이 줄었으면 새 카운터가 시작된 것으로 보고 새 누적값을 그대로 더한다.
// 가격은 그 줄 앞의 마지막 turn_context 모델로 매긴다. 기록은 읽기만 하고, 어디까지 읽었는지는 캐시에 둔다.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlTail } from '../tail.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { codexCost } from '../pricing.mjs';
import { allDayDirs } from './codex.mjs';
import { dayKey, addSlot, addModel, recentDays } from './common.mjs';
import { debugIo } from '../log.mjs';

// 2: 사용량 벡터, 날짜 400일 보관 (#164).
const KIND = 'codex-ledger2';
const DAYS = 7;
const LIST_TTL_MS = 30_000;

// total_token_usage 를 codexCost 가 받는 모양으로 바꾼다 (input 은 캐시 제외).
export function tokensOf(t) {
  const cached = t.cached_input_tokens ?? 0;
  return { input: (t.input_tokens ?? 0) - cached, cacheRead: cached, output: t.output_tokens ?? 0 };
}

// 직전 누적값 prev 에서 cur 까지 늘어난 양. 어느 값이든 줄었으면 새 카운터로 보고 cur 전체를 돌려준다.
export function deltaOf(prev, cur) {
  if (!prev || cur.input < prev.input || cur.cacheRead < prev.cacheRead || cur.output < prev.output) return { ...cur };
  return { input: cur.input - prev.input, cacheRead: cur.cacheRead - prev.cacheRead, output: cur.output - prev.output };
}

export class CodexBook {
  constructor(path) {
    this.tail = new JsonlTail(path);
    this.tail.onReset = () => this.clear();
    this.clear();
    const c = loadCache(path, KIND);
    if (c) {
      this.tail.offset = c.offset;
      this.model = c.model ?? null;
      this.last = c.last ?? null;
      this.days = c.days ?? {};
      this.slots = c.slots ?? {};
    }
  }

  clear() {
    this.model = null;
    this.last = null;
    this.days = {};
    // 지출 속도용 5분 칸 (common.mjs addSlot).
    this.slots = {};
  }

  get pending() {
    return Math.max(0, this.tail.size - this.tail.offset);
  }

  update(budget) {
    const n = this.tail.read((x) => this.apply(x), budget);
    if (n) markDirty(this.tail.path, () => this.snapshot(), KIND);
    return n;
  }

  snapshot() {
    return { offset: this.tail.lineOffset, model: this.model, last: this.last, days: recentDays(this.days), slots: this.slots };
  }

  apply(x) {
    const p = x.payload ?? {};
    if (x.type === 'turn_context') {
      this.model = p.model ?? this.model;
      return;
    }
    if (x.type !== 'event_msg' || p.type !== 'token_count' || !p.info?.total_token_usage) return;
    const cur = tokensOf(p.info.total_token_usage);
    const d = deltaOf(this.last, cur);
    this.last = cur;
    const tokens = d.input + d.cacheRead + d.output;
    if (tokens <= 0) return;
    const cost = codexCost(this.model, d);
    const at = Date.parse(x.timestamp) || Date.now();
    const day = (this.days[dayKey(at)] ??= { tokens: 0, cost: 0, costNoCache: 0, unknown: false });
    day.tokens += tokens;
    day.cost += cost?.total ?? 0;
    day.costNoCache += cost?.noCache ?? 0;
    addModel(day, this.model, tokens, cost?.total ?? 0, !cost, [d.input, d.output, d.cacheRead, 0, 0]);
    if (!cost) day.unknown = true;
    addSlot(this.slots, at, cost?.total ?? 0, cost?.noCache ?? 0, !cost);
  }
}

let listed = { at: 0, files: [], days: 0 };

// 며칠 전에 시작했거나 다시 이어 쓴 세션도 시작한 날짜 폴더에 쓰므로, 모든 날짜 폴더에서 days 일 안에 바뀐 기록을 고른다.
// 오래전에 시작해 최근까지 이어 쓴 세션도 빠지지 않아야 월별 보관함에 빠짐없이 접힌다 (목록은 30초 동안 다시 쓴다).
function recentFiles(days = DAYS) {
  if (listed.days === days && Date.now() - listed.at < LIST_TTL_MS) return listed.files;
  const cutoff = Date.now() - days * 86400_000;
  const files = [];
  for (const dir of allDayDirs()) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch (e) {
      debugIo('ledger', 'codex day folder read failed', e, dir);
    }
    for (const n of names) {
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue;
      const p = join(dir, n);
      try {
        if (statSync(p).mtimeMs >= cutoff) files.push(p);
      } catch {}
    }
  }
  listed = { at: Date.now(), files, days };
  return files;
}

const books = new Map();

// 기록마다 날짜별 합계(days)와 5분 칸(slots), 아직 읽지 않은 크기(pending)·전체 크기(size).
// days: 최근 며칠 안에 바뀐 기록을 볼지 (평소 7일, 리포트는 더 길게).
export function collectCodexLedger({ budget, days = DAYS } = {}) {
  const out = { days: [], slots: [], paths: [], pending: 0, size: 0 };
  const files = recentFiles(days);
  const keep = new Set(files);
  for (const p of books.keys()) if (!keep.has(p)) books.delete(p);
  for (const p of files) {
    let b = books.get(p);
    if (!b) books.set(p, (b = new CodexBook(p)));
    b.update(budget);
    out.pending += b.pending;
    out.size += b.tail.size;
    out.days.push(b.days);
    out.paths.push(p);
    out.slots.push(b.slots);
  }
  return out;
}

export const _test = { reset: () => ((listed = { at: 0, files: [], days: 0 }), books.clear()) };
