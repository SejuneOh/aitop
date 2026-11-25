// 날짜별 사용량 장부의 Antigravity CLI(agy) 몫: 최근 7일 안에 바뀐 conversations/<id>.db 의 gen_metadata 를
// 호출 시각(호출 직전 단계의 만든 시각)의 날짜와 가격으로 나눠 모은다. 서브에이전트도 대화 기록이 따로 있어 함께 센다.
// 세션 화면과 상관없이 끝난 대화까지 세야 해서 토큰만 가볍게 따로 읽고(진행 기록은 읽지 않는다), 어디까지 읽었는지는 캐시에 둔다.
// 기록은 늘 immutable 로 열어 agy 폴더에 아무것도 만들거나 고치지 않는다.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { agyRoots, readCalls, sigOf, sigStat, maxIdx, APP_TTL_MS, settledAt, cachedAppWal } from './antigravity.mjs';
import { openReadOnly, loadSqlite } from '../sqlite.mjs';
import { loadCache, markDirty } from '../cache.mjs';
import { dayKey, addSlot, addModel, recentDays } from './common.mjs';
import { debugIo } from '../log.mjs';

// 2: 사용량 벡터, 날짜 400일 보관 (#164).
const KIND = 'agy-ledger2';
const DAYS = 7;
const LIST_TTL_MS = 30_000;
// 한 번 갱신에서 TTL 이 끝난 앱 기록을 시간 한도와 상관없이 다시 확인하는 최소 개수 (#326).
// 다른 장부가 시간을 다 써도 확인이 조금씩은 앞으로 가게 한다.
const MIN_APP_CHECKS = 4;

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

  update(budget) {
    // 서명을 본 stat 하나를 크기·수정 시각에도 나눠 쓴다 (따로 stat 하지 않는다, #326).
    const s = sigStat(this.path);
    const sig = s?.sig ?? null;
    // 이번에 본 서명. 끝까지 읽었는지(sig) 또는 실패로 멈춰 둔 것인지(failSig) 판단에 쓴다 (앱 폴더 TTL, #303).
    this.seenSig = sig;
    // 이번에 본 크기 (없으면 0). 갱신마다 장부 전체 크기와 '집계 중' 진행률에 쓴다.
    this.lastSize = s?.st.size ?? 0;
    // 이번에 본 수정 시각. 앱 폴더 목록을 새로 만들 때 이 값으로 7일 판정을 해서 다시 stat 하지 않는다 (recentFiles).
    if (s) this.mtime = s.st.mtimeMs;
    if (sig === null || sig === this.sig || sig === this.failSig) return;
    if (outOf(budget)) {
      budget.exhausted = true;
      return;
    }
    // 읽은 뒤 이 본 파일 서명과 견줘, 읽는 동안 agy 가 썼는지 본다.
    const mainSig = s.main;
    const mtime = s.st.mtimeMs;
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
            const fresh = !n.days[dayKey(at)];
            const day = (n.days[dayKey(at)] ??= { tokens: 0, cost: 0, costNoCache: 0, unknown: false });
            // 그날 첫·마지막 호출 시각 (세션 리포트의 시작·끝). 장부 kind 는 그대로라 예전 캐시에서 불러온 날에는 a 가 없다.
            // 그런 날(이미 센 호출이 있는데 a 가 없는 날)은 첫 호출을 모르므로 a 를 채우지 않는다 (시작은 '모름').
            // z 는 마지막 호출이라 이어서 갱신해도 맞다.
            if (Number.isFinite(at)) {
              if ((fresh || day.a != null) && !(day.a <= at)) day.a = at;
              if (!(day.z >= at)) day.z = at;
            }
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
// 앱 폴더의 conversations/ 경로들 (#303). 이 아래 기록은 APP_TTL_MS 마다 한 번만 서명을 본다.
let apps = new Set();
const inApp = (p) => apps.has(dirname(p));

// 최근 days 일(평소 7일, 리포트는 더 길게) 안에 바뀐 대화 기록. CLI 폴더와 앱 폴더를 모두 본다 (#303).
// 장부·캐시는 파일 경로로 나뉘어 폴더끼리 섞이지 않는다. 같은 대화 id 가 두 폴더에 있으면 앞 폴더 것만 센다.
//
// 앱 폴더(WSL 에서는 /mnt/c, stat 이 느리다)는 목록을 새로 만들 때 기록마다 stat 하지 않는다 (#326).
// - 처음 보는 이름과, -wal 이 있는(쓰는 중인) 기록만 바로 stat 한다.
// - 장부에 있는 기록은 장부 확인(sigStat)에서 마지막으로 본 수정 시각으로 7일 판정을 한다. 그 사이 바뀌었으면 TTL 확인
//   (recheckApps)이 수정 시각을 새로 고친다. 마지막으로 안 시각이 7일 밖이면 그 기록만 다시 stat 해서 정한다
//   (경계를 넘는 기록은 몇 개뿐이고, 마지막 확인 뒤 다시 쓰인 기록을 장부에서 지우지 않게 한다).
// - 7일 밖이라 장부에 없는 기록은 지난번 목록에서 본 수정 시각을 쓰고, 갱신 시간 한도 안에서 가장 오래 보지 않은 것부터
//   돌아가며 다시 stat 한다 (적어도 MIN_APP_CHECKS 개). 다시 쓰이기 시작하면 대개 -wal 이 생겨 바로 잡힌다.
// 한도가 없으면(--once·--json·리포트처럼 days 가 긴 때) 예전처럼 모두 stat 해 정확히 판정한다. CLI 폴더는 늘 모두 stat 한다.
function recentFiles(days = DAYS, roots = agyRoots(), budget) {
  if (listed.days === days && Date.now() - listed.at < LIST_TTL_MS) return listed.files;
  apps = new Set(roots.filter((r) => r.source === 'app').map((r) => join(r.dir, 'conversations')));
  const cutoff = Date.now() - days * 86400_000;
  const exact = (budget?.deadline ?? Infinity) === Infinity;
  // 목록 차례대로 [경로, 수정 시각]. 수정 시각이 null 이면 아래에서 지난 값 또는 다시 stat 한 값으로 정한다.
  const order = [];
  const seen = new Set();
  const known = new Map();
  const wals = new Set();
  // 지난 값으로 판정해 두고 시간이 남으면 다시 stat 할 앱 기록.
  const later = [];
  const look = (p) => {
    try {
      const m = statSync(p).mtimeMs;
      known.set(p, { mtime: m, at: Date.now() });
      return m;
    } catch {
      return null;
    }
  };
  for (const r of roots) {
    const dir = join(r.dir, 'conversations');
    if (!existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch (e) {
      debugIo('ledger', 'agy conversations read failed', e);
    }
    const app = r.source === 'app';
    const wal = app ? new Set(names.filter((f) => f.endsWith('.db-wal'))) : null;
    for (const f of names) {
      if (!f.endsWith('.db') || seen.has(f)) continue;
      seen.add(f);
      const p = join(dir, f);
      if (app && wal.has(`${f}-wal`)) wals.add(p);
      const book = app ? books.get(p)?.mtime : undefined;
      const prev = app ? appMtimes.get(p) : undefined;
      let m = null;
      if (!app || exact || wals.has(p) || (book == null && prev == null) || (book != null && book < cutoff)) m = look(p);
      else if (book != null) {
        m = book;
        known.set(p, { mtime: book, at: Date.now() });
      } else {
        known.set(p, prev);
        later.push(p);
      }
      order.push([p, m]);
    }
  }
  // 다시 stat 하지 못한 옛 기록은 지난 값, 다시 stat 한 기록은 그 결과로 정한다 (사라졌으면 뺀다).
  const restat = new Map();
  if (later.length) {
    later.sort((x, y) => known.get(x).at - known.get(y).at || (x < y ? -1 : x > y ? 1 : 0));
    const deadline = budget?.deadline ?? Infinity;
    for (let i = 0; i < later.length; i++) {
      if (i >= MIN_APP_CHECKS && Date.now() >= deadline) break;
      const m = look(later[i]);
      if (m == null) known.delete(later[i]);
      restat.set(later[i], m);
    }
  }
  const files = [];
  for (const [p, m0] of order) {
    const m = m0 ?? (restat.has(p) ? restat.get(p) : (known.get(p)?.mtime ?? null));
    if (m != null && m >= cutoff) files.push(p);
  }
  appMtimes = new Map([...known].filter(([p]) => inApp(p)));
  appWals = wals;
  listed = { at: Date.now(), files, days };
  return files;
}

// 앱 폴더 기록마다 지난번 목록에서 쓴 수정 시각과 그것을 stat 으로 본 때 ({ mtime, at }).
let appMtimes = new Map();
// 지난번 목록에서 -wal 이 있던(쓰는 중인) 앱 기록 경로. 다시 확인 순서에서 앞에 둔다 (recheckApps).
let appWals = new Set();

// 쓰는 중인 앱 기록인지. 목록을 새로 만들 때 본 -wal(30초마다)과 세션 수집이 10초마다 읽는 -wal 목록(cachedAppWal)을
// 함께 본다. 둘 다 이미 읽은 폴더 목록이라 stat 이 늘지 않는다.
const writing = (p) => appWals.has(p) || cachedAppWal(dirname(dirname(p))).has(basename(p, '.db'));

const books = new Map();

// 앱 기록의 확인을 마쳤을 때: 지금 서명까지 다 읽었거나 실패로 멈춰 둔 서명이면 TTL 을 시작하고, 아니면(덜 읽음·없음) 다음 갱신에 바로 본다.
function settle(b, p, prev) {
  b.checkedAt = b.seenSig != null && (b.seenSig === b.sig || b.seenSig === b.failSig) ? settledAt(prev, p) : null;
}

// TTL 이 끝난 앱 기록을 다시 확인한다 (#326). 확인(stat·헤더 읽기)도 /mnt/c 에서는 느려서 갱신 한도의 시간(deadline) 안에서만 한다.
// 쓰는 중인(-wal 이 있는) 기록을 먼저, 그다음 가장 오래 확인하지 않은 것부터 보고 (오늘 합계·5분 칸에 바로 잡히게), 한도를 넘으면 멈춘다 (다른 장부가 시간을 다 썼어도 적어도 MIN_APP_CHECKS 개는 본다).
// 한도가 없으면(--once·--json·리포트) 모두 본다. 못 본 기록은 checkedAt 이 그대로라 다음 갱신에 앞쪽에 선다 (계속 밀리는 기록이 없다).
// 확인한 기록의 경로를 돌려준다.
function recheckApps(files, budget) {
  const now = Date.now();
  const due = files.filter((p) => inApp(p) && books.get(p).checkedAt != null && now - books.get(p).checkedAt >= APP_TTL_MS);
  const busy = new Set(due.filter(writing));
  due.sort((x, y) => Number(busy.has(y)) - Number(busy.has(x)) || books.get(x).checkedAt - books.get(y).checkedAt || (x < y ? -1 : x > y ? 1 : 0));
  const deadline = budget?.deadline ?? Infinity;
  const done = new Set();
  for (const p of due) {
    if (done.size >= MIN_APP_CHECKS && Date.now() >= deadline) break;
    const b = books.get(p);
    const prev = b.checkedAt;
    b.update(budget);
    settle(b, p, prev);
    done.add(p);
  }
  return done;
}

// 대화마다 날짜별 합계(days)와 5분 칸(slots), 처음 읽기가 덜 끝난 기록의 크기(pending)·전체 크기(size),
// 기록마다 마지막 갱신이 실패했으면 빠졌을 수 있는 첫날(stale, 아니면 null).
// node:sqlite 를 못 쓰는 Node 에서는 비어 있다 (agy 는 프로세스만 보인다).
export function collectAgyLedger({ budget, days = DAYS } = {}) {
  const out = { days: [], slots: [], paths: [], stale: [], pending: 0, size: 0 };
  if (!loadSqlite() || !agyRoots().some((r) => existsSync(join(r.dir, 'conversations')))) return out;
  const files = recentFiles(days, agyRoots(), budget);
  const keep = new Set(files);
  for (const p of books.keys()) if (!keep.has(p)) books.delete(p);
  for (const p of files) if (!books.has(p)) books.set(p, new AgyBook(p));
  const checked = recheckApps(files, budget);
  for (const p of files) {
    const b = books.get(p);
    // 앱 폴더(/mnt/c 일 수 있음)의 기록은 지금 서명까지 다 읽었거나(sig), 실패로 멈춰 둔 서명(failSig)이면
    // TTL 안에서는 다시 stat·열기를 하지 않고 지난 값을 쓴다. 읽기 한도에 걸려 덜 읽었으면 다음 갱신에 바로 이어 읽는다.
    // TTL 이 끝났어도 이번 갱신의 확인(recheckApps)에 들지 못했으면 지난 값을 쓰고 다음 갱신에 확인한다 (#326).
    // 이미 다 읽은 기록의 확인이 밀린 것이라 읽기 한도 바닥(exhausted)으로 치지 않는다 ('집계 중' 진행 줄이 뜨지 않는다).
    const app = inApp(p);
    if (!checked.has(p) && !(app && b.checkedAt != null)) {
      const prev = b.checkedAt;
      b.update(budget);
      if (app) settle(b, p, prev);
    }
    const size = b.lastSize ?? 0;
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
export const _test = {
  reset: () => ((listed = { at: 0, files: [], days: 0 }), (appMtimes = new Map()), (appWals = new Set()), books.clear()),
  opens: () => opens,
  // 기록 하나의 장부 (확인 시각 checkedAt 등을 보거나 바꾼다).
  book: (p) => books.get(p),
  // 앱 폴더 기록의 TTL 이 지난 것을 흉내 낸다.
  age: (ms) => {
    listed.at -= ms;
    for (const b of books.values()) if (b.checkedAt != null) b.checkedAt -= ms;
  },
};
