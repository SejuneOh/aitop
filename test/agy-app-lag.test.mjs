// WSL 에서 Antigravity 앱 폴더(/mnt/c)를 한 번 갱신에 몰아 훑지 않는지 본다 (#326).
// 가짜 앱 폴더에 대화 기록 수백 개를 만들고, node:fs 의 stat·open 등을 앱 폴더 경로에 대해 센다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, utimesSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSqlite } from '../src/sqlite.mjs';
import * as fx from './agy-fixture.mjs';

const N = 300;
const base = realpathSync(mkdtempSync(join(tmpdir(), 'aitop-agy-lag-')));
const home = join(base, 'home');
const cli = join(home, '.gemini', 'antigravity-cli');
const app = join(home, '.gemini', 'antigravity');
for (const d of [cli, app]) mkdirSync(join(d, 'conversations'), { recursive: true });
process.env.AITOP_AGY_HOME = cli;
process.env.AITOP_AGY_APP_HOME = app;
process.env.XDG_CACHE_HOME = join(base, 'cache');
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-empty');
process.env.CODEX_HOME = join(base, 'codex-missing');
process.env.GEMINI_HOME = join(base, 'gemini-missing');
process.env.AITOP_COWORK_HOME = 'off';

// 앱 폴더 안 경로에 대한 파일 조회를 센다. node:fs 의 이름 있는 내보내기도 바뀌도록 syncBuiltinESMExports 를 부른다.
let counting = false;
const calls = [];
for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'existsSync', 'lstatSync']) {
  const orig = fs[name];
  fs[name] = function (p, ...rest) {
    const s = String(p?.href ?? p);
    if (counting && (s === app || s.startsWith(app + sep))) calls.push({ name, path: s });
    return orig.call(this, p, ...rest);
  };
}
syncBuiltinESMExports();
function count(fn) {
  calls.length = 0;
  counting = true;
  try {
    return { value: fn(), calls: [...calls] };
  } finally {
    counting = false;
  }
}

const { APP_TTL_MS, ttlJitter } = await import('../src/sources/antigravity.mjs');
const { collectAgyLedger, _test: ledgerTest } = await import('../src/sources/agy-ledger.mjs');
const { checkTools } = await import('../src/doctor.mjs');
const { createBudget } = await import('../src/tail.mjs');

after(() => rmSync(base, { recursive: true, force: true }));

const noSqlite = !loadSqlite() && 'agy 기록을 immutable 로 열 수 없는 Node (22.15 미만)';
const now = Date.now();
const ids = Array.from({ length: N }, (_, i) => `lag-${String(i).padStart(4, '0')}`);
// 가짜 기록에는 단계(호출 시각)가 없어 장부는 호출 시각을 읽을 때의 파일 수정 시각으로 어림한다.
// 그 시각이 5분 칸 경계를 넘나들면 나눠 읽은 장부와 한 번에 읽은 장부가 다른 칸에 넣으므로, 수정 시각을 한 5분 칸 안에 고정한다.
const fixedAt = (Math.floor(now / 300_000) * 300_000 - 600_000 + 60_000) / 1000;
const pin = (id) => utimesSync(join(app, 'conversations', `${id}.db`), fixedAt, fixedAt);
if (loadSqlite()) {
  ids.forEach((id, i) => fx.makeConversation(app, id, [{ input: i + 1, output: 1 }]));
  ids.forEach(pin);
  fx.makeSummaries(cli, []);
  fx.makeSummaries(app, ids.map((id, i) => ({ id, title: id, modified: fx.ts(now - 3600_000 - i * 1000), ws: ['file:///w/app'] })));
}

const total = (out) => out.days.flatMap((d) => Object.values(d)).reduce((a, x) => a + (x.tokens ?? 0), 0);
const slotSum = (out) => out.slots.flatMap((s) => Object.values(s)).reduce((a, x) => a + (x.cost ?? 0) + (x.n ?? 0), 0);
// 시간 한도가 이미 끝난 갱신 (실시간 화면에서 다른 장부가 시간을 다 쓴 경우). 바이트 한도는 넉넉하다.
const tight = () => createBudget(24 * 1024 * 1024, 0);

test('확인 시각을 흩는 값은 경로로 정해지고 0~0.9*TTL 에 고루 퍼진다', () => {
  const j = ids.map((id) => ttlJitter(join(app, 'conversations', `${id}.db`)));
  assert.equal(ttlJitter('/x/a.db'), ttlJitter('/x/a.db'));
  assert.ok(j.every((v) => v >= 0 && v < APP_TTL_MS * 0.9));
  const buckets = new Set(j.map((v) => Math.floor(v / (APP_TTL_MS / 10))));
  assert.ok(buckets.size >= 8, `칸 ${buckets.size}`);
});

test(`장부: 앱 기록 ${N}개의 TTL 이 다 끝나도 한도 있는 갱신 1회는 몇 개만 다시 확인하고, 여러 갱신에 걸쳐 모두 공평하게 확인한다`, { skip: noSqlite }, () => {
  ledgerTest.reset();
  const full = collectAgyLedger({ budget: createBudget() });
  assert.equal(full.paths.length, N);
  const want = total(full);
  assert.equal(want, (N * (N + 1)) / 2 + N);

  ledgerTest.age(APP_TTL_MS);
  const seen = new Map();
  let ticks = 0;
  while (seen.size < N && ticks < N) {
    const budget = tight();
    const { value: out, calls: c } = count(() => collectAgyLedger({ budget }));
    ticks++;
    assert.ok(c.length <= 20, `갱신 ${ticks}: 앱 폴더 조회 ${c.length}회`);
    assert.equal(budget.exhausted, false, '다 읽은 기록의 확인이 밀린 것은 읽기 한도 바닥이 아니다');
    assert.equal(out.pending, 0, "'집계 중' 진행률에 들지 않는다");
    assert.equal(total(out), want, '확인하지 못한 기록은 지난 값을 쓴다');
    assert.equal(out.size, full.size, '크기도 지난 값을 쓴다');
    for (const x of c) if (x.name === 'statSync' && x.path.endsWith('.db')) seen.set(x.path, (seen.get(x.path) ?? 0) + 1);
  }
  assert.equal(seen.size, N, `${ticks}번 갱신 뒤 모든 기록을 다시 확인했다`);
  assert.ok([...seen.values()].every((n) => n === 1), '모두 확인하기 전에 같은 기록을 두 번 확인하지 않는다');
  assert.ok(ticks <= Math.ceil(N / 4) + 1, `갱신 ${ticks}번`);

  // 한도 없는 갱신(--once·--json)은 TTL 이 끝난 기록을 한 번에 모두 본다.
  ledgerTest.age(APP_TTL_MS);
  const { calls: all } = count(() => collectAgyLedger({ budget: createBudget() }));
  assert.equal(new Set(all.filter((x) => x.name === 'statSync' && x.path.endsWith('.db')).map((x) => x.path)).size, N);
});

test('장부: 한도 있는 갱신을 이어 가면 바뀐 기록도 결국 세고, 합계(days·slots)는 한도 없는 결과와 같다', { skip: noSqlite }, () => {
  ledgerTest.reset();
  collectAgyLedger({ budget: createBudget() });
  fx.makeConversation(app, ids[123], [{ input: 1000, output: 0 }]);
  fx.makeConversation(app, ids[7], [{ input: 2000, output: 0 }]);
  // 다시 쓴 기록도 수정 시각을 같은 칸에 둔다 (서명은 크기·변경 카운터가 바뀌어 달라진다).
  pin(ids[123]);
  pin(ids[7]);
  ledgerTest.age(APP_TTL_MS);
  // 바뀐 두 기록을 첫 갱신에서 함께 확인하게 맨 앞에 세운다 (기계 속도에 따라 같은 갱신에 들 수도, 아닐 수도 있어서 정해 둔다).
  const first = Math.min(...[...ids.map((id) => ledgerTest.book(join(app, 'conversations', `${id}.db`)).checkedAt)]) - 1;
  for (const id of [ids[123], ids[7]]) ledgerTest.book(join(app, 'conversations', `${id}.db`)).checkedAt = first;
  // 첫 갱신: 앞의 기록을 읽은 뒤에는 시간 한도가 이미 끝나 뒤의 기록은 읽지 못한다. 바뀐 기록을 덜 읽은 것이라 exhausted 가 맞다.
  const b1 = tight();
  let out = collectAgyLedger({ budget: b1 });
  assert.equal(b1.exhausted, true, '바뀐 기록을 덜 읽으면 exhausted');
  // 그다음부터는 덜 읽은 기록을 마저 읽고, 나머지는 다 읽은 기록의 확인만 밀린 것이라 exhausted 가 아니다.
  for (let i = 1; i < N; i++) {
    const budget = tight();
    out = collectAgyLedger({ budget });
    assert.equal(budget.exhausted, false, `갱신 ${i + 1}`);
  }
  ledgerTest.reset();
  const fresh = collectAgyLedger({ budget: createBudget() });
  assert.equal(total(out), total(fresh));
  assert.equal(total(out), (N * (N + 1)) / 2 + N + 3000);
  assert.equal(slotSum(out), slotSum(fresh));
  assert.deepEqual(out.days, fresh.days);
  assert.deepEqual(out.slots, fresh.slots);
});

test(`--doctor 의 agy 점검: 앱 기록 ${N}개여도 앱 폴더를 기록마다 stat 하지 않고, 기록 수·마지막 사용 시각은 맞다`, { skip: noSqlite }, () => {
  // 쓰는 중인 대화 하나: -wal 의 수정 시각이 가장 늦다.
  const wal = join(app, 'conversations', `${ids[5]}.db-wal`);
  writeFileSync(wal, '');
  const walAt = Math.floor(now / 1000) * 1000 - 60_000;
  utimesSync(wal, walAt / 1000, walAt / 1000);
  const { value: r, calls: c } = count(() => checkTools({ home: join(base, 'h-none') }));
  const a = r.tools.agy;
  assert.equal(a.state, 'ok');
  assert.equal(a.readable, true);
  assert.equal(a.records, N);
  assert.equal(a.dirs.find((d) => d.source === 'app').records, N);
  const per = c.filter((x) => x.name === 'statSync' || x.name === 'existsSync');
  assert.ok(per.length <= 10, `앱 폴더 stat·존재 확인 ${per.length}회`);
  assert.equal(a.lastAt, walAt, '쓰는 중인 -wal 의 수정 시각');

  // -wal 이 없으면 요약 DB 의 가장 늦은 대화 수정 시각.
  rmSync(wal);
  assert.equal(checkTools({ home: join(base, 'h-none') }).tools.agy.lastAt, Date.parse(fx.ts(now - 3600_000)));
});

test(`장부: 앱 폴더 대화 목록을 새로 만들 때 기록 ${N}개를 다 stat 하지 않고, 새 기록·다시 쓰인 기록·7일 밖으로 나간 기록은 맞게 판정한다`, { skip: noSqlite }, () => {
  const conv = (id) => join(app, 'conversations', `${id}.db`);
  const old = Date.now() / 1000 - 8 * 86400;
  const olds = Array.from({ length: 50 }, (_, i) => `old-${i}`);
  for (const id of olds) {
    fx.makeConversation(app, id, [{ input: 1, output: 1 }]);
    utimesSync(conv(id), old, old);
  }
  ledgerTest.reset();
  assert.equal(collectAgyLedger({ budget: createBudget() }).paths.length, N, '7일 밖의 기록은 빠진다');
  // 7일 밖으로 나가는 기록: TTL 확인에서 수정 시각을 새로 본다 (목록은 아직 TTL 안).
  utimesSync(conv(ids[10]), old, old);
  ledgerTest.age(APP_TTL_MS);
  collectAgyLedger({ budget: createBudget() });
  // 새 기록 3개, 다시 쓰이기 시작한 옛 기록 하나(-wal 이 있다).
  const news = ['new-0', 'new-1', 'new-2'];
  for (const id of news) fx.makeConversation(app, id, [{ input: 1, output: 1 }]);
  writeFileSync(`${conv(olds[0])}-wal`, '');
  const t = Date.now() / 1000;
  utimesSync(conv(olds[0]), t, t);

  // 마지막으로 본 수정 시각은 7일 밖인데, 그 뒤 -wal 없이 다시 쓰인 기록. 목록에서 다시 stat 해 남긴다.
  const back = conv(ids[20]);
  utimesSync(back, old, old);
  ledgerTest.book(back).checkedAt -= APP_TTL_MS;
  collectAgyLedger({ budget: createBudget() });
  assert.ok(ledgerTest.book(back).mtime < Date.now() - 7 * 86400_000);
  utimesSync(back, t, t);

  ledgerTest.age(30_000);
  const { value: out, calls: c } = count(() => collectAgyLedger({ budget: tight() }));
  const stats = c.filter((x) => x.name === 'statSync' && x.path.endsWith('.db'));
  // 새 기록·다시 쓰인 기록은 목록 stat 과 첫 읽기 stat, 그 밖에 TTL 확인 4개와 옛 기록 돌려 보기 4개, 여유 2.
  assert.ok(stats.length <= (news.length + 1) * 2 + 4 + 4 + 2 + 2, `앱 폴더 .db stat ${stats.length}회`);
  for (const id of news) assert.ok(out.paths.includes(conv(id)), `새 기록 ${id}`);
  assert.ok(out.paths.includes(conv(olds[0])), '-wal 이 있는 옛 기록은 바로 다시 본다');
  assert.ok(!out.paths.includes(conv(ids[10])), '마지막으로 본 수정 시각이 7일 밖이면 뺀다');
  assert.ok(!out.paths.includes(conv(olds[1])), '조용한 옛 기록은 그대로 빠진다');
  assert.ok(out.paths.includes(back), '7일 밖으로 알던 기록이 다시 쓰였으면 남긴다');
  assert.equal(out.paths.length, N - 1 + news.length + 1);

  // 한도 없는 목록은 예전처럼 모두 stat 해 같은 결과다.
  ledgerTest.age(30_000);
  const { value: exact, calls: all } = count(() => collectAgyLedger({ budget: createBudget() }));
  assert.ok(all.filter((x) => x.name === 'statSync' && x.path.endsWith('.db')).length >= N + 50);
  assert.deepEqual([...exact.paths].sort(), [...out.paths].sort());
  rmSync(`${conv(olds[0])}-wal`);
});

test(`장부: TTL 이 끝난 앱 기록 ${N}개 가운데 쓰는 중인(-wal 이 있는) 기록을 첫 한도 갱신에서 먼저 다시 확인한다`, { skip: noSqlite }, () => {
  ledgerTest.reset();
  collectAgyLedger({ budget: createBudget() });
  // 순서로는 맨 뒤(가장 최근에 확인한 것)가 되는 기록을 고른다.
  const paths = ids.map((id) => join(app, 'conversations', `${id}.db`)).filter((p) => ledgerTest.book(p));
  const last = paths.reduce((a, p) => (ledgerTest.book(p).checkedAt > ledgerTest.book(a).checkedAt ? p : a));
  writeFileSync(`${last}-wal`, '');
  ledgerTest.age(30_000);
  const before = ledgerTest.book(last).checkedAt;
  const { calls: c } = count(() => collectAgyLedger({ budget: tight() }));
  assert.notEqual(ledgerTest.book(last).checkedAt, before, '쓰는 중인 기록을 다시 확인했다');
  assert.ok(c.filter((x) => x.name === 'statSync' && x.path.endsWith('.db')).length <= 4 + 4 + 2, '다시 확인은 여전히 몇 개뿐');
  rmSync(`${last}-wal`);
});

test('장부: 쓰는 중인(-wal 이 있는) 기록이 많아도 앞당기는 것은 갱신마다 몇 개뿐이라, -wal 없는 오래된 기록도 몇 갱신 안에 다시 확인한다', { skip: noSqlite }, () => {
  ledgerTest.reset();
  collectAgyLedger({ budget: createBudget() });
  const paths = ids.map((id) => join(app, 'conversations', `${id}.db`)).filter((p) => ledgerTest.book(p));
  paths.sort((x, y) => ledgerTest.book(x).checkedAt - ledgerTest.book(y).checkedAt || (x < y ? -1 : 1));
  // 가장 최근에 확인한 100개에 -wal 을 둔다. 확인 순서로 10번째인 -wal 없는 기록을 본다.
  const busy = paths.slice(-100);
  for (const p of busy) writeFileSync(`${p}-wal`, '');
  const target = paths[9];
  ledgerTest.age(30_000);
  const before = ledgerTest.book(target).checkedAt;
  let ticks = 0;
  while (ledgerTest.book(target).checkedAt === before && ticks < 50) {
    collectAgyLedger({ budget: tight() });
    ticks++;
  }
  assert.ok(ticks <= 6, `-wal 없는 기록을 ${ticks}번째 갱신에 확인했다`);
  for (const p of busy) rmSync(`${p}-wal`);
});
