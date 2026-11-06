// 날짜별 사용량 장부의 Antigravity CLI(agy) 몫: 최근 7일 안에 바뀐 conversations/<id>.db 의 gen_metadata 를
// 호출 시각(호출 직전 단계의 만든 시각)의 날짜와 가격으로 나눠 모은다. 서브에이전트도 대화 기록이 따로 있어 함께 센다.
// 세션 화면과 상관없이 끝난 대화까지 세야 해서 토큰만 가볍게 따로 읽고(진행 기록은 읽지 않는다), 어디까지 읽었는지는 캐시에 둔다.
// 기록은 늘 immutable 로 열어 agy 폴더에 아무것도 만들거나 고치지 않는다.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGY_ROOT, readCalls, sigOf, maxIdx } from './antigravity.mjs';
import { openReadOnly, loadSqlite } from '../sqlite.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { dayKey, lastDays } from './common.mjs';

const KIND = 'agy-ledger';
const DAYS = 7;
const KEEP_DAYS = 10;
const LIST_TTL_MS = 30_000;

const outOf = (budget) => budget.left <= 0 || (budget.read > 0 && Date.now() >= (budget.deadline ?? Infinity));
const copyDays = (days) => Object.fromEntries(Object.entries(days).map(([k, v]) => [k, { ...v }]));

export class AgyBook {
  constructor(path) {
    this.path = path;
    this.sig = null;
    this.idx = -1;
    this.model = null;
    this.days = {};
    // 한 번이라도 끝까지 읽었는지. 처음 읽는 동안만 '집계 중' 진행률에 들어간다.
    this.complete = false;
    const c = loadCache(path, KIND);
    if (c) {
      this.idx = c.idx ?? -1;
      this.model = c.model ?? null;
      this.days = c.days ?? {};
      this.complete = true;
    }
  }

  get size() {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  update(budget) {
    const sig = sigOf(this.path);
    if (sig === null || sig === this.sig) return;
    if (outOf(budget)) {
      budget.exhausted = true;
      return;
    }
    const mainSig = sigOf(this.path, false);
    const mtime = statSync(this.path).mtimeMs;
    let n = { idx: this.idx, model: this.model, days: copyDays(this.days) };
    let db;
    let result = null;
    try {
      db = openReadOnly(this.path);
      if (!db) return;
      const has = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'gen_metadata'").get();
      const last = has ? maxIdx(db, 'gen_metadata') : -1;
      // 마지막 줄 번호가 줄었으면 기록이 새로 쓰인 것이니 처음부터 다시 센다.
      if (last < n.idx) n = { idx: -1, model: null, days: {} };
      result = has
        ? readCalls(db, n, last, budget, mtime, ({ usage: u, cost, at }) => {
            const day = (n.days[dayKey(at)] ??= { tokens: 0, cost: 0, costNoCache: 0, unknown: false });
            const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
            day.tokens += tokens;
            day.cost += cost?.total ?? 0;
            day.costNoCache += cost?.noCache ?? 0;
            if (!cost && tokens > 0) day.unknown = true;
          })
        : 'done';
      // 읽는 동안 agy 가 본 파일에 썼으면 읽은 내용을 버리고 다음 갱신에 다시 읽는다.
      if (sigOf(this.path, false) !== mainSig) result = null;
    } catch {
      result = null;
    } finally {
      db?.close();
    }
    if (!result) return;
    const changed = n.idx !== this.idx;
    Object.assign(this, n);
    if (result === 'done') {
      this.sig = sig;
      this.complete = true;
    }
    if (result === 'exhausted') budget.exhausted = true;
    if (changed) markDirty(this.path, () => this.snapshot(), KIND);
  }

  snapshot() {
    const keep = new Set(lastDays(KEEP_DAYS));
    const days = Object.fromEntries(Object.entries(this.days).filter(([k]) => keep.has(k)));
    return { offset: 0, idx: this.idx, model: this.model, days };
  }
}

let listed = { at: 0, files: [] };

function recentFiles() {
  if (Date.now() - listed.at < LIST_TTL_MS) return listed.files;
  const dir = join(AGY_ROOT, 'conversations');
  const cutoff = Date.now() - DAYS * 86400_000;
  const files = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {}
  for (const f of names) {
    if (!f.endsWith('.db')) continue;
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs >= cutoff) files.push(p);
    } catch {}
  }
  listed = { at: Date.now(), files };
  return files;
}

const books = new Map();

// 대화마다 날짜별 합계(days)와, 처음 읽기가 덜 끝난 기록의 크기(pending)·전체 크기(size).
// node:sqlite 를 못 쓰는 Node 에서는 비어 있다 (agy 는 프로세스만 보인다).
export function collectAgyLedger({ budget } = {}) {
  const out = { days: [], pending: 0, size: 0 };
  if (!loadSqlite() || !existsSync(join(AGY_ROOT, 'conversations'))) return out;
  const files = recentFiles();
  const keep = new Set(files);
  for (const p of books.keys()) if (!keep.has(p)) books.delete(p);
  for (const p of files) {
    let b = books.get(p);
    if (!b) books.set(p, (b = new AgyBook(p)));
    b.update(budget);
    const size = b.size;
    out.size += size;
    if (!b.complete) out.pending += size;
    out.days.push(b.days);
  }
  return out;
}

export const _test = { reset: () => ((listed = { at: 0, files: [] }), books.clear()) };
