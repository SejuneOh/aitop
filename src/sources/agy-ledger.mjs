// 날짜별 사용량 장부의 Antigravity CLI(agy) 몫: 최근 7일 안에 바뀐 conversations/<id>.db 의 gen_metadata 를
// 호출 시각(호출 직전 단계의 만든 시각)의 날짜와 가격으로 나눠 모은다. 서브에이전트도 대화 기록이 따로 있어 함께 센다.
// 세션 화면과 상관없이 끝난 대화까지 세야 해서 토큰만 가볍게 따로 읽고(진행 기록은 읽지 않는다), 어디까지 읽었는지는 캐시에 둔다.
// 기록은 늘 immutable 로 열어 agy 폴더에 아무것도 만들거나 고치지 않는다.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGY_ROOT, readCalls, sigOf, maxIdx } from './antigravity.mjs';
import { openReadOnly, loadSqlite } from '../sqlite.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { dayKey, addSlot, addModel, recentDays } from './common.mjs';
import { debugIo } from '../log.mjs';

// 2: 사용량 벡터, 날짜 400일 보관 (#164).
const KIND = 'agy-ledger2';
const DAYS = 7;
const LIST_TTL_MS = 30_000;

const outOf = (budget) => budget.left <= 0 || (budget.read > 0 && Date.now() >= (budget.deadline ?? Infinity));
// 하루 합계 안의 모델별 몫도 따로 복사해, 읽다가 버릴 때 원래 장부가 바뀌지 않게 한다.
const copyDays = (days) => Object.fromEntries(Object.entries(days).map(([k, v]) => [k, v.models ? { ...v, models: Object.fromEntries(Object.entries(v.models).map(([m, x]) => [m, { ...x, ...(x.u ? { u: [...x.u] } : {}), ...(x.f ? { f: [...x.f] } : {}) }])) } : { ...v }]));

export class AgyBook {
  constructor(path) {
    this.path = path;
    this.sig = null;
    this.idx = -1;
    this.model = null;
    this.days = {};
    // 지출 속도용 5분 칸 (common.mjs addSlot).
    this.slots = {};
    // 한 번이라도 끝까지 읽었는지. 처음 읽는 동안만 '집계 중' 진행률에 들어간다.
    this.complete = false;
    // 마지막 갱신이 실패했는지 (열지 못함, 읽는 중 agy 가 씀, 예외). 캐시에서 불러온 값이 낡았을 수 있어
    // 월별 보관함은 이 기록이 쓰였을 수 있는 날(staleFrom 부터)을 접지 않는다 (monthly.mjs staleCut).
    this.stale = false;
    // 실패한 때의 sig. 파일이 바뀌기 전까지는 매 갱신마다 다시 열지 않는다.
    this.failSig = null;
    // 마지막으로 끝까지 읽었을 때의 파일 수정 시각 (그 뒤에 쓴 호출만 빠졌을 수 있다).
    this.okAt = null;
    const c = loadCache(path, KIND);
    if (c) {
      this.idx = c.idx ?? -1;
      this.model = c.model ?? null;
      this.days = c.days ?? {};
      this.slots = c.slots ?? {};
      this.okAt = c.okAt ?? null;
      this.complete = true;
    }
  }

  // 빠졌을 수 있는 첫날. 끝까지 읽은 적이 있으면 그때의 날, 없으면 파일이 생긴 날, 그것도 모르면 맨 처음부터.
  get staleFrom() {
    if (this.okAt != null) return dayKey(this.okAt);
    try {
      const born = statSync(this.path).birthtimeMs;
      if (born > 0) return dayKey(born);
    } catch {}
    return '0000-00-00';
  }

  fail(sig) {
    this.stale = true;
    this.failSig = sig;
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
    if (sig === null || sig === this.sig || sig === this.failSig) return;
    if (outOf(budget)) {
      budget.exhausted = true;
      return;
    }
    const mainSig = sigOf(this.path, false);
    const mtime = statSync(this.path).mtimeMs;
    let n = { idx: this.idx, model: this.model, days: copyDays(this.days), slots: copyDays(this.slots) };
    let db;
    let result = null;
    try {
      opens++;
      db = openReadOnly(this.path);
      if (!db) {
        this.fail(sig);
        return;
      }
      const has = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'gen_metadata'").get();
      const last = has ? maxIdx(db, 'gen_metadata') : -1;
      // 마지막 줄 번호가 줄었으면 기록이 새로 쓰인 것이니 처음부터 다시 센다.
      if (last < n.idx) n = { idx: -1, model: null, days: {}, slots: {} };
      result = has
        ? readCalls(db, n, last, budget, mtime, ({ model, usage: u, cost, at }) => {
            const day = (n.days[dayKey(at)] ??= { tokens: 0, cost: 0, costNoCache: 0, unknown: false });
            const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
            day.tokens += tokens;
            day.cost += cost?.total ?? 0;
            day.costNoCache += cost?.noCache ?? 0;
            addModel(day, model, tokens, cost?.total ?? 0, !cost && tokens > 0, [u.input, u.output, u.cacheRead, u.cacheWrite, 0]);
            if (!cost && tokens > 0) day.unknown = true;
            addSlot(n.slots, at, cost?.total ?? 0, cost?.noCache ?? 0, !cost && tokens > 0);
          })
        : 'done';
      // 읽는 동안 agy 가 본 파일에 썼으면 읽은 내용을 버리고 다음 갱신에 다시 읽는다.
      if (sigOf(this.path, false) !== mainSig) result = null;
    } catch (e) {
      debugIo('ledger', 'agy conversation read failed', e, this.path);
      result = null;
    } finally {
      db?.close();
    }
    if (!result) {
      this.fail(sig);
      return;
    }
    const changed = n.idx !== this.idx;
    Object.assign(this, n);
    if (result === 'done') {
      this.sig = sig;
      this.complete = true;
      this.stale = false;
      this.failSig = null;
      this.okAt = mtime;
    }
    if (result === 'exhausted') budget.exhausted = true;
    // 덜 쓰인 줄(torn)에서 멈췄으면 그 뒤가 빠졌을 수 있다. 파일이 바뀌면(마저 쓰이면) 다시 읽는다.
    if (result === 'torn') this.fail(sig);
    if (changed) markDirty(this.path, () => this.snapshot(), KIND);
  }

  snapshot() {
    return { offset: 0, idx: this.idx, model: this.model, days: recentDays(this.days), slots: this.slots, okAt: this.okAt };
  }
}

let listed = { at: 0, files: [], days: 0 };

// 최근 days 일(평소 7일, 리포트는 더 길게) 안에 바뀐 대화 기록.
function recentFiles(days = DAYS) {
  if (listed.days === days && Date.now() - listed.at < LIST_TTL_MS) return listed.files;
  const dir = join(AGY_ROOT, 'conversations');
  const cutoff = Date.now() - days * 86400_000;
  const files = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (e) {
    debugIo('ledger', 'agy conversations read failed', e);
  }
  for (const f of names) {
    if (!f.endsWith('.db')) continue;
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs >= cutoff) files.push(p);
    } catch {}
  }
  listed = { at: Date.now(), files, days };
  return files;
}

const books = new Map();

// 대화마다 날짜별 합계(days)와 5분 칸(slots), 처음 읽기가 덜 끝난 기록의 크기(pending)·전체 크기(size),
// 기록마다 마지막 갱신이 실패했으면 빠졌을 수 있는 첫날(stale, 아니면 null).
// node:sqlite 를 못 쓰는 Node 에서는 비어 있다 (agy 는 프로세스만 보인다).
export function collectAgyLedger({ budget, days = DAYS } = {}) {
  const out = { days: [], slots: [], paths: [], stale: [], pending: 0, size: 0 };
  if (!loadSqlite() || !existsSync(join(AGY_ROOT, 'conversations'))) return out;
  const files = recentFiles(days);
  const keep = new Set(files);
  for (const p of books.keys()) if (!keep.has(p)) books.delete(p);
  for (const p of files) {
    let b = books.get(p);
    if (!b) books.set(p, (b = new AgyBook(p)));
    b.update(budget);
    const size = b.size;
    out.size += size;
    if (!b.complete) out.pending += size;
    // 실패한 기록은 빠졌을 수 있는 첫날, 아니면 null.
    out.stale.push(b.stale ? b.staleFrom : null);
    out.days.push(b.days);
    out.paths.push(p);
    out.slots.push(b.slots);
  }
  return out;
}

// 테스트용: 기록을 연 횟수.
let opens = 0;
export const _test = { reset: () => ((listed = { at: 0, files: [], days: 0 }), books.clear()), opens: () => opens };
