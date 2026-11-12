// 월별 보관함 (--report monthly, #164). 장부(캐시)는 버전·가격표가 바뀌면 통째로 버려지고, 원본 기록도 도구가 오래되면 지운다.
// 그래서 지난 날의 합계를 캐시 루트의 monthly.json 에 달(YYYY-MM)별로 접어 12개월 남긴다 (버전 폴더 밖, summary.json 과 같은 자리).
//
// 한 번만 세기: since~through 의 날은 모두 보관함에 접혀 있다. 리포트는 through 까지는 보관함에서, through 다음 날부터는
// 살아 있는 장부에서 센다. 장부를 처음부터 다시 세도(버전·가격 변경) through 이전 날은 보관함 값만 쓰므로 두 번 더해지지 않는다.
// 접을 때는 [lo, hi] 를 빠짐없이 읽은 장부만 받고, 이미 [since, through] 에 든 날은 건너뛴다.
// 새 범위가 [since, through] 와 이어지지 않으면(사이가 빈다) 접지 않는다 (1년치를 다시 읽은 때만 빈 날을 holes 에 적고 접는다).
// from: 이 날부터는 빠짐없이 셌다 (그 앞은 기록이 지워졌을 수 있어 '일부' 로 보인다). holes 의 날도 '일부' 다.
//
// 여러 aitop 이 함께 써도 파일 하나에는 늘 "since~through 의 합" 만 들어 있다: 쓰기 전에 다시 읽어 rev 가 바뀌었으면 쓰지 않고
// (다음 기회에 다시 접는다), pid 별 임시 파일에 쓴 뒤 rename 한다.
//
// 값마다 사용량 벡터(입력·출력·캐시 읽기·캐시 쓰기 5분·1시간, fast 모드는 따로)를 남겨, 가격표가 바뀌면 지금 가격으로 다시 계산한다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CACHE_ROOT } from './cache.mjs';
import { PRICE_TAG, vecCost } from './pricing.mjs';
import { dayKey } from './sources/common.mjs';
import { debug, debugIo } from './log.mjs';

export const V = 1;
export const ARCHIVE_FILE = join(CACHE_ROOT, 'monthly.json');
// 남기는 달 수 (이번 달 포함).
export const KEEP_MONTHS = 12;
// 갱신이 실패한 agy 기록 때문에 접기가 이만큼 넘게 밀리면, 그 기록을 빼고 접고 그 날들을 '일부' 로 적는다.
export const STALE_MAX_DAYS = 7;
// 오늘·어제는 아직 늦게 쓰이는 줄(자정을 넘긴 응답, agy 의 늦은 기록)이 있을 수 있어 그제까지만 접는다.
export const LAG_DAYS = 2;

const DAY = /^\d{4}-\d\d-\d\d$/;
const MONTH = /^\d{4}-\d\d$/;

// 날짜 키 산술 (로컬 정오 기준이라 서머타임에도 하루씩 움직인다).
const atNoon = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};
export const addDays = (key, n) => {
  const d = atNoon(key);
  d.setDate(d.getDate() + n);
  return dayKey(d.getTime());
};
export const monthOf = (key) => key.slice(0, 7);

// 이번 달부터 거꾸로 n 달 (YYYY-MM).
export function lastMonths(n, now = Date.now()) {
  const d = new Date(now);
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1, 12);
    out.push(dayKey(x.getTime()).slice(0, 7));
  }
  return out;
}

// 보관함이 남기는 가장 오래된 날 (12개월 전 달의 1일).
export const keepFrom = (now = Date.now()) => `${lastMonths(KEEP_MONTHS, now).at(-1)}-01`;
// 접을 수 있는 가장 최근 날.
export const foldHi = (now = Date.now()) => dayKey(now - LAG_DAYS * 86400_000);
// 그 달의 마지막 날.
export const monthEnd = (month) => {
  const [y, m] = month.split('-').map(Number);
  return dayKey(new Date(y, m, 0, 12).getTime());
};

export const emptyArchive = () => ({ v: V, rev: 0, price: PRICE_TAG, since: null, from: null, through: null, backfilled: null, holes: [], months: {} });

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isVec = (x) => Array.isArray(x) && x.every(isNum);
const validEntry = (e) => e && typeof e.t === 'string' && typeof e.m === 'string' && (e.p == null || typeof e.p === 'string') && isNum(e.n) && isNum(e.c) && (e.u == null || isVec(e.u)) && (e.f == null || isVec(e.f));
function valid(a) {
  if (!a || typeof a !== 'object' || !Number.isInteger(a.rev)) return false;
  for (const k of ['since', 'from', 'through', 'backfilled']) if (a[k] != null && !(typeof a[k] === 'string' && DAY.test(a[k]))) return false;
  if ((a.since == null) !== (a.through == null) || (a.from == null) !== (a.through == null)) return false;
  // holes: [첫날, 끝날] 또는 [첫날, 끝날, 빠진 도구]. 남는 칸은 무시한다.
  if (!Array.isArray(a.holes) || !a.holes.every((h) => Array.isArray(h) && h.length >= 2 && DAY.test(h[0]) && DAY.test(h[1]))) return false;
  if (!a.months || typeof a.months !== 'object') return false;
  return Object.entries(a.months).every(([k, list]) => MONTH.test(k) && Array.isArray(list) && list.every(validEntry));
}

// 가격표가 바뀌었으면 벡터로 지금 가격을 다시 매긴다. 가격표에서 모델이 사라졌으면 예전 비용을 그대로 둔다.
function reprice(a) {
  if (a.price === PRICE_TAG) return a;
  for (const [month, list] of Object.entries(a.months)) {
    const at = Date.parse(`${month}-15T12:00:00Z`);
    for (const e of list) {
      if (!e.u && !e.f) continue;
      const c = vecCost(e.t, e.m, e.u, e.f, at);
      if (c == null) continue;
      e.c = c;
      delete e.x;
    }
  }
  a.price = PRICE_TAG;
  return a;
}

// { archive, state }. state: ok, missing(없음), corrupt(깨짐, 옆으로 옮기고 빈 보관함), newer(더 새 형식: 읽지도 쓰지도 않는다, archive null).
export function readArchive(file = ARCHIVE_FILE) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') debugIo('monthly', 'archive read failed', e);
    return { archive: emptyArchive(), state: 'missing' };
  }
  let a = null;
  try {
    a = JSON.parse(raw);
  } catch {}
  if (a && Number.isInteger(a.v) && a.v > V) return { archive: null, state: 'newer' };
  if (a?.v === V && valid(a)) return { archive: reprice(a), state: 'ok' };
  // 지우지 않고 옆으로 옮겨 둔다 (사용자 기록이라 손으로 살릴 수 있게).
  try {
    renameSync(file, `${file}.bad-${Date.now()}`);
  } catch (e) {
    debugIo('monthly', 'archive move aside failed', e);
  }
  return { archive: emptyArchive(), state: 'corrupt' };
}

// 지금 파일의 rev (없으면 0, 읽을 수 없으면 null).
function revOf(file) {
  try {
    const a = JSON.parse(readFileSync(file, 'utf8'));
    return a?.v === V && Number.isInteger(a.rev) ? a.rev : null;
  } catch (e) {
    return e.code === 'ENOENT' ? 0 : null;
  }
}

// 읽은 뒤(rev = base) 아무도 쓰지 않았을 때만 쓴다. 썼으면 true.
export function writeArchive(a, base, file = ARCHIVE_FILE) {
  if (revOf(file) !== base) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify({ ...a, v: V, rev: base + 1, price: PRICE_TAG }), { mode: 0o600 });
    // 임시 파일을 쓰는 사이에 다른 쪽이 썼으면 버린다. 이 확인과 rename 사이에 다른 쪽이 rename 하면 그쪽 접기가
    // 덮여 사라질 수 있다 (lost update). 그래도 남는 파일은 이쪽의 since~through 합이라 두 번 세지 않고, 사라진 날은
    // 아직 장부 창 안(그제 근처)이라 다음 접기 때 다시 접힌다.
    if (revOf(file) !== base) {
      rmSync(tmp, { force: true });
      return false;
    }
    renameSync(tmp, file);
    a.rev = base + 1;
    return true;
  } catch (e) {
    debugIo('monthly', 'archive write failed', e);
    try {
      rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
}

// books 의 날짜별 장부를 [lo, hi] 안의 날만 보관함 a 에 접는다 (a 를 고친다). books: [{ tool, project, days }].
// 부르는 쪽은 [lo, hi] 의 날을 빠짐없이 읽은 장부만 넘긴다. 이미 [since, through] 에 든 날은 건너뛴다.
// complete: 이 날부터는 원본 기록이 다 남아 있다 (기본 lo). 1년치를 다시 읽을 때 Claude 기록이 지워진 앞쪽을 가른다.
// gap: 사이가 비면 'hole'(빈 날을 holes 에 적고 접는다) 또는 'refuse'(접지 않는다).
// 돌려주는 값: 'folded', 'none'(더 접을 날 없음), 'gap'.
// extraHoles: 이번에 접는 날 중 일부만 센 범위 (staleCut 이 뺀 agy 기록 등).
export function foldInto(a, books, { lo, hi, complete = lo, now = Date.now(), gap = 'refuse', extraHoles = [] }) {
  const keep = keepFrom(now);
  if (lo < keep) lo = keep;
  if (complete < lo) complete = lo;
  if (hi < lo) return 'none';
  const holes = [];
  // 이번에 새로 접는 범위 (이미 접은 [since, through] 밖).
  const fresh = a.through == null ? [[lo, hi]] : [[lo, addDays(a.since, -1)], [addDays(a.through, 1), hi]];
  if (a.through != null) {
    if (lo >= a.since && hi <= a.through) return 'none';
    const after = addDays(a.through, 1);
    if (hi < addDays(a.since, -1) || (lo > after && gap !== 'hole')) return 'gap';
    // 빈 날, 그리고 원본 기록이 덜 남은 앞쪽과 원래 빠짐없던 날 사이는 '일부' 다.
    const end = lo > complete ? lo : complete;
    if (end > after) holes.push([after, addDays(end, -1)]);
  }
  const has = (d) => a.through != null && d >= a.since && d <= a.through;
  const index = new Map();
  const slot = (month, t, m, p) => {
    const key = `${month}\t${t}\t${m}\t${p ?? ''}`;
    let e = index.get(key);
    if (!e) {
      const list = (a.months[month] ??= []);
      e = list.find((x) => x.t === t && x.m === m && (x.p ?? null) === (p ?? null));
      if (!e) list.push((e = { t, m, p: p ?? null, n: 0, c: 0 }));
      index.set(key, e);
    }
    return e;
  };
  for (const { tool, project, days } of books)
    for (const [d, day] of Object.entries(days ?? {})) {
      if (d < lo || d > hi || has(d)) continue;
      const models = day.models && Object.keys(day.models).length ? day.models : { unknown: { tokens: day.tokens, cost: day.cost, unknown: day.unknown } };
      for (const [model, x] of Object.entries(models)) {
        if (!(x.tokens > 0) && !(x.cost > 0)) continue;
        const e = slot(monthOf(d), tool, model, project);
        e.n += x.tokens;
        e.c += x.cost;
        if (x.unknown) e.x = 1;
        for (const k of ['u', 'f']) if (x[k]) e[k] = (e[k] ?? [0, 0, 0, 0, 0]).map((v, i) => v + (x[k][i] ?? 0));
      }
    }
  if (a.through == null) {
    a.since = lo;
    a.from = complete;
    a.through = hi;
  } else {
    // 앞으로 넓혔으면 from 도 앞당긴다 (complete 가 원래 from 보다 늦으면 그 사이는 위에서 holes 로 적었다).
    if (lo < a.since && complete < a.from) a.from = complete;
    if (lo < a.since) a.since = lo;
    if (hi > a.through) a.through = hi;
  }
  // 이번에 새로 접은 날만 적는다 (이미 접은 날에 겹쳐 쌓이지 않게).
  for (const [x, y, tool] of extraHoles)
    for (const [p, q] of fresh) {
      const from = x > p ? x : p;
      const to = y < q ? y : q;
      if (from <= to) holes.push(tool ? [from, to, tool] : [from, to]);
    }
  a.holes.push(...holes.filter(([x, y]) => x <= y));
  // 12개월보다 오래된 달은 버린다.
  const keepMonth = monthOf(keep);
  for (const k of Object.keys(a.months)) if (k < keepMonth) delete a.months[k];
  a.holes = a.holes.filter(([, to]) => to >= keep);
  if (a.since < keep) a.since = keep;
  if (a.from < keep) a.from = keep;
  if (a.from > a.through) a.from = addDays(a.through, 1);
  return 'folded';
}

// 갱신이 실패한 agy 기록(book.staleFrom)이 있을 때 접을 범위. 그 기록이 쓰였을 수 있는 첫날 전날까지만 접는다.
// 그렇게 STALE_MAX_DAYS 넘게 밀리면, 그 기록은 staleFrom 앞의 날(마지막으로 다 읽은 정상 값)만 남겨 hi 까지 접고
// 빠졌을 수 있는 범위를 holes 로 남긴다 (Claude·Codex 몫이 지워지기 전에).
export function staleCut(books, hi) {
  const stale = books.filter((b) => b.staleFrom && b.staleFrom <= hi);
  if (!stale.length) return { books, hi, holes: [] };
  const first = stale.reduce((x, b) => (b.staleFrom < x ? b.staleFrom : x), hi);
  const cut = addDays(first, -1);
  if (cut >= addDays(hi, -STALE_MAX_DAYS)) {
    debug('monthly', 'fold held back: an agy log failed to update', null, `${first}`);
    return { books, hi: cut, holes: [] };
  }
  debug('monthly', 'fold skipped failing agy logs, days marked partial', null, `${first}`);
  const trim = (b) => ({ ...b, days: Object.fromEntries(Object.entries(b.days ?? {}).filter(([k]) => k < b.staleFrom)) });
  return { books: books.map((b) => (stale.includes(b) ? trim(b) : b)), hi, holes: [[first, hi, 'agy']] };
}

// 읽고, 접고, 쓴다. attach: 장부에 project 를 붙이는 함수 (projects.mjs attachProjects).
// 돌려주는 값: 'folded', 'none', 'gap', 'newer', 'busy'(다른 aitop 이 먼저 썼다), 'error'.
export function foldArchive(books, { lo, hi, complete = lo, now = Date.now(), gap = 'refuse', backfilled = false, attach = (b) => b, file = ARCHIVE_FILE } = {}) {
  const { archive: a, state } = readArchive(file);
  if (state === 'newer') return 'newer';
  const cut = staleCut(books, hi);
  books = cut.books;
  hi = cut.hi;
  // 접을 날이 없으면 프로젝트를 찾지도 않는다 (평소 화면은 대개 여기서 끝난다).
  if (a.through != null && lo >= a.since && hi <= a.through && !backfilled) return 'none';
  const base = a.rev;
  let r;
  try {
    r = foldInto(a, attach(books), { lo, hi, complete, now, gap, extraHoles: cut.holes });
  } catch (e) {
    debugIo('monthly', 'archive fold failed', e);
    return 'error';
  }
  if (r === 'gap') return r;
  if (backfilled) a.backfilled = dayKey(now);
  else if (r === 'none') return r;
  return writeArchive(a, base, file) ? r : 'busy';
}
