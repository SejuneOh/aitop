import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ROOT, at, session } from './detail-fixture.mjs';
import { width } from '../src/text.mjs';
import { fill, setNow } from '../src/ui/draw.mjs';
import { detail, rightColumn } from '../src/ui/detail.mjs';
import { render } from '../src/ui.mjs';

// Windows 는 경로를 \ 로 이어 붙이고 보인다. 기대값은 / 로 적었으므로 비교 전에 / 로 바꾼다 (Linux·macOS 는 그대로).
const px = (p) => (process.platform === 'win32' ? String(p).replace(/\\/g, '/') : p);

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const draw = (W, H, view = { tab: 'now' }) => {
  setNow(at);
  return detail(session(), W, H, 0, view).map(strip).map(px);
};
const VIEWS = [{ tab: 'now' }, { tab: 'all', costMode: 'net' }, { tab: 'now', focus: 'files', filePath: `${ROOT}/src/ui/draw.mjs` }, { tab: 'now', focus: 'diff', filePath: `${ROOT}/src/ui/draw.mjs` }];

// wide-detail.snapshot.json: 100칸 이상 경계 폭(100·101·120·150) × 높이 16·24 의 상세 패널(고정 세션). 좁은 화면 한 칸 구성 전과 같은 출력이다.
// 넓은 화면 배치는 바뀌면 안 되므로, 이 테스트가 깨지면 스냅숏을 고치기 전에 의도한 변경인지 먼저 확인한다.
test('100칸 이상의 상세 패널은 좁은 화면 대응 전과 같다', () => {
  const snapshot = JSON.parse(readFileSync(new URL('./wide-detail.snapshot.json', import.meta.url), 'utf8'));
  for (const key of Object.keys(snapshot)) {
    const [W, H] = key.split('x').map(Number);
    assert.deepEqual(draw(W, H).map((l) => l.trimEnd()), snapshot[key], key);
  }
  assert.deepEqual(Object.keys(snapshot), ['100x16', '100x24', '101x16', '101x24', '120x16', '120x24', '150x16', '150x24']);
});

test('100칸 미만은 칸을 나누지 않고 모든 줄이 화면 폭 안에 든다', () => {
  for (let W = 56; W <= 99; W++) {
    for (const H of [12, 16, 24]) {
      for (const view of VIEWS) {
        const lines = draw(W, H, view);
        assert.equal(lines.length, H, `W=${W} H=${H}`);
        for (const l of lines) assert.ok(width(l) <= W, `W=${W} H=${H} ${view.focus ?? view.tab}: ${l}`);
        // 가운데 세로줄이 없다.
        assert.ok(lines.slice(1, -1).every((l) => !l.slice(1, -1).includes('│')), `W=${W} 칸 나눔 없음`);
      }
    }
  }
});

test('좁은 화면 요약 줄에 토큰·비용·컨텍스트가 있다', () => {
  for (let W = 56; W <= 99; W++) {
    const [, first, second] = draw(W, 16);
    assert.match(first, /도구 실행 · Bash · .*aitop/, `W=${W}`);
    assert.match(second, /571k .*\$0\.17 · ctx 5%/, `W=${W}`);
  }
  assert.match(draw(80, 16)[2], /571k \+서브2 \(입력 90\.3k·출력 18\.4k·캐시 463k\) · \$0\.17 · ctx 5%/);
  assert.match(draw(90, 16)[2], /ctx 5% · pid 218093/);
  assert.match(draw(80, 16, { tab: 'now', costMode: 'net' })[2], /캐시제외 \$0\.09/);
});

test('서브에이전트 수는 토큰 내역 다음으로 빠지고, 없으면 붙지 않는다', () => {
  const second = (W, extra = {}) => {
    setNow(at);
    const s = session();
    Object.assign(s.tokens, extra);
    return detail(s, W, 16, 0, { tab: 'now' }).map(strip)[2];
  };
  assert.match(second(80), /571k \+서브2 \(입력/);
  // 내역이 빠질 만큼 좁아도 서브에이전트 수는 남는다.
  assert.match(second(56), /571k \+서브2 · \$0\.17 · ctx 5%/);
  assert.doesNotMatch(second(56), /입력/);
  assert.doesNotMatch(second(80, { subCount: 0 }), /서브/);
});

test('80칸에서 최근 활동은 안쪽 전체 폭을 쓴다', () => {
  const W = 80;
  const texts = session().events.map((e) => e.text);
  // 활동 줄마다 시각 뒤에 보이는 글자 폭. 같은 활동끼리 비교한다.
  const shown = (lines) => {
    const out = new Map();
    for (const l of lines) {
      const m = l.match(/\d\d:\d\d:\d\d  [•↳❯] (.*?)[\s│]*$/);
      const t = m && texts.find((x) => x.startsWith(m[1].replace(/…$/, '')));
      if (t) out.set(t, width(m[1]));
    }
    return out;
  };
  const after = shown(draw(W, 16));
  // 한 칸 구성 전에는 오른쪽 칸 폭(W - 왼쪽 칸 - 7)만 썼다.
  const leftW = Math.min(46, Math.max(30, Math.floor((W - 4) * 0.38)));
  const rightW = W - leftW - 7;
  setNow(at);
  const before = shown(rightColumn(session(), rightW, 14, { tab: 'now' }).map((r) => strip(fill(r, rightW).map((x) => x.t).join(''))));
  const common = [...after.keys()].filter((t) => before.has(t));
  assert.ok(common.length >= 4, `공통 활동 ${common.length}개`);
  const sum = (m) => common.reduce((a, t) => a + m.get(t), 0);
  assert.ok(sum(after) > sum(before) * 1.4, `before=${sum(before)} after=${sum(after)}`);
  // 잘리는 긴 활동은 안쪽 폭 끝까지 쓴다.
  const long = draw(W, 16).find((l) => l.includes('$ COLUMNS=80'));
  assert.ok(width(long.replace(/[\s│]+$/, '')) >= W - 4, long);
});

test('화면 전체 그리기: 80칸은 요약 줄, 100칸은 왼쪽 칸 구획', () => {
  const view = { data: { sessions: [session()], usage: null, errors: [], at }, selectedId: 'fix', showDetail: true, frame: 0, tab: 'now' };
  const narrow = render(view, 80, 30).map(strip);
  assert.ok(narrow.some((l) => /^│   571k \+서브2 \(입력/.test(l)));
  assert.ok(!narrow.some((l) => l.startsWith('│ ── 세션 ─')));
  const wide = render(view, 100, 30).map(strip);
  assert.ok(wide.some((l) => l.startsWith('│ ── 세션 ─')));
});

test('색이 없어도 좁은 화면 요약이 읽힌다', () => {
  const script = `
    const { ROOT, at, session } = await import(${JSON.stringify(new URL('./detail-fixture.mjs', import.meta.url).href)});
    const { render } = await import(${JSON.stringify(new URL('../src/ui.mjs', import.meta.url).href)});
    const view = { data: { sessions: [session()], usage: null, errors: [], at }, selectedId: 'fix', showDetail: true, frame: 0, tab: 'now', focus: 'files', filePath: ROOT + '/src/ui/draw.mjs' };
    process.stdout.write(render(view, 80, 30).join('\\n'));`;
  const out = px(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' }));
  assert.doesNotMatch(out, /\x1b\[/);
  assert.match(out, /^┃   571k \+서브2 \(입력 90\.3k·출력 18\.4k·캐시 463k\) · \$0\.17 · ctx 5%/m);
  assert.match(out, /^┃ ▌▸ src\/ui\/draw\.mjs/m);
});
