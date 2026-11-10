import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { render } = await import('../src/ui.mjs');
const { onKey } = await import('../src/keys.mjs');
const { collectLedger } = await import('../src/sources/claude-ledger.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { width } = await import('../src/text.mjs');

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.now();
const member = (name, task, model, extra = {}) => ({ id: task, name, task, model, status: 'busy', started: true, phase: { kind: 'tool', text: '도구 실행 · Read' }, tokens: 1000, cost: 0.5, costNoCache: 0.1, ...extra });
const sess = (id, extra = {}) => ({ tool: 'claude', id, name: id, cwd: '/w', project: 'w', model: 'claude-opus-5-5', status: 'idle', live: true, phase: { kind: 'idle', text: '다음 지시 대기' }, updatedAt: at, tokens: { total: 1000 }, cost: 100, costNoCache: 10, context: {}, members: [], events: [], ...extra });
const usageData = { today: { cost: 52, costNoCache: 5.2, tokens: 1e8 }, week: { cost: 640, costNoCache: 64, tokens: 1e9 }, loading: null };
const view = (sessions, extra = {}) => ({ data: { sessions, usage: usageData, errors: [], at }, selectedId: sessions[0]?.id, showDetail: false, frame: 0, costMode: 'api', ...extra });
const draw = (v, W = 160, H = 24) => render(v, W, H).map(strip);

test('팀원 행: 부모와 같은 모델은 비우고, 하는 일 글을 PROJECT 칸까지 이어 쓴다', () => {
  const task = 'PM: next update ideas for the release';
  const s = sess('parent', { members: [member('general-purpose', task, 'claude-opus-5-5'), member('Explore', '코드 찾기', 'claude-haiku-5-5')] });
  const lines = draw(view([s]));
  const pm = lines.find((l) => l.includes('PM: next'));
  assert.match(pm, /PM: next update ideas for the release/, '잘리지 않는다');
  assert.doesNotMatch(pm, /opus-5-5|general-purpose/);
  const ex = lines.find((l) => l.includes('코드 찾기'));
  assert.match(ex, /haiku-5-5/, '다른 모델은 보인다');
  assert.match(ex, /코드 찾기 · Explore/, 'general-purpose 가 아닌 타입은 붙인다');
  for (const W of [80, 100, 120, 160]) for (const l of draw(view([s]), W)) assert.ok(width(l) <= W, `W=${W}`);
});

test('헤더: 응답 대기가 있으면 로고 바로 뒤에 둔다', () => {
  const head = draw(view([sess('w', { status: 'waiting', phase: { kind: 'waiting', text: '응답 대기' } })]))[0];
  assert.match(head, /^ ⣠⣴⣾ +◆ 1 응답 대기 +1 live/);
  assert.doesNotMatch(draw(view([sess('a')]))[0], /◆/, '없으면 보이지 않는다');
});

test('좁은 헤더는 live 수와 ○ 대기를 먼저 빼서 오늘 비용을 남긴다', () => {
  const list = [sess('w', { status: 'waiting', phase: { kind: 'waiting', text: '응답 대기' } }), sess('b', { status: 'busy', phase: { kind: 'think', text: '생각 중' } }), sess('i1'), sess('i2')];
  // 캐시 제외 기준은 '캐시제외' 표시가 끝까지 남는다. 그 9칸 때문에 좁으면 시각을 먼저 빼고 오늘 비용을 지킨다.
  const sweep = (from) => Array.from({ length: 70 - from + 1 }, (_, i) => from + i);
  for (const [costMode, widths] of [['api', sweep(50)], ['net', sweep(48)]]) {
    for (const W of widths) {
      const head = draw(view(list, { costMode }), W)[0];
      assert.ok(width(head) <= W, `W=${W}`);
      assert.match(head, /◆ 1 응답 .*⠿ 1 작업/, `W=${W} ${costMode}: ${head}`);
      assert.match(head, costMode === 'net' ? /캐시제외 오늘 \$5\.20/ : /오늘 \$/, `W=${W} ${costMode}: ${head}`);
      if (W <= 64) assert.doesNotMatch(head, /live/, `W=${W}`);
    }
  }
  assert.match(draw(view(list), 160)[0], /4 live +⠿ 1 작업 중 +○ 2 대기/, '넓으면 그대로 보인다');
});

test('좁은 헤더: 빼고 나서 남는 상태 수가 없으면 live 수를 남긴다', () => {
  // 캐시 제외 40칸은 오늘 비용이 들어가므로 비용이 빠지는 더 좁은 폭에서 본다.
  for (const [costMode, W] of [['net', 36], ['api', 36]]) {
    const head = draw(view([sess('i1')], { costMode }), W)[0];
    assert.ok(width(head) <= W);
    assert.match(head, /1 live/, head);
  }
});

test('도구 줄: 종료 세션 표시가 들어가지 않으면 조각 없이 뺀다', () => {
  const s = sess('a', { tokens: { total: 571000 } });
  for (let W = 40; W <= 100; W++) {
    const tools = draw(view([s], { showEnded: true }), W)[1];
    assert.ok(width(tools) <= W, `W=${W}`);
    assert.doesNotMatch(tools, /…/, `W=${W}: ${tools}`);
    if (tools.includes('종')) assert.match(tools, /종료된 세션 포함 \(24시간\)/, `W=${W}`);
  }
  assert.match(draw(view([s], { showEnded: true }), 100)[1], /종료된 세션 포함 \(24시간\)/);
});

test('헤더: 0 인 상태 수는 빼고 live 수는 남긴다', () => {
  const head = draw(view([sess('a'), sess('b')]))[0];
  assert.match(head, /2 live +○ 2 대기/);
  assert.doesNotMatch(head, /[⠿◆●] |\b0 /);
  const busy = draw(view([sess('a', { status: 'busy', phase: { kind: 'think', text: '생각 중' } })]))[0];
  assert.match(busy, /1 live +⠿ 1 작업 중 /);
  assert.doesNotMatch(busy, /○|\b0 /);
});

test('헤더: 80 칸에서 live 7·작업 2·대기 5 여도 7일 비용이 잘리지 않는다', () => {
  const busy = { status: 'busy', phase: { kind: 'think', text: '생각 중' } };
  const list = [...Array.from({ length: 2 }, (_, i) => sess(`b${i}`, busy)), ...Array.from({ length: 5 }, (_, i) => sess(`i${i}`))];
  const big = { today: { cost: 158, costNoCache: 15, tokens: 3.74e8 }, week: { cost: 751, costNoCache: 75, tokens: 2.02e9 }, loading: null };
  for (const costMode of ['api', 'net']) {
    const v = view(list, { costMode });
    v.data.usage = big;
    const head = draw(v, 80)[0];
    assert.match(head, /7 live +⠿ 2 작업.*○ 5 대기 .*7일 \$75.* \d\d:\d\d:\d\d/, `${costMode}: ${head}`);
    assert.ok(width(head) <= 80);
  }
  const waiting = sess('w', { status: 'waiting', phase: { kind: 'waiting', text: '응답 대기' } });
  const v = view([waiting, ...list.slice(1)]);
  v.data.usage = big;
  assert.match(draw(v, 80)[0], /◆ 1 응답 +7 live .*7일 \$751/, '응답 대기가 앞에 붙어도 7일은 남는다');
});

test('c 키로 비용 기준을 바꾸면 표·헤더·상세가 같이 바뀐다', () => {
  const v = view([sess('a', { cost: 2120, costNoCache: 195 })], { showDetail: true });
  let lines = draw(v, 160, 40);
  assert.match(lines[0], /API 환산 +오늘 \$52\.00/);
  assert.match(lines.find((l) => l.includes(' a ')), /▲\$2,120/);
  assert.match(lines.join('\n'), /API 환산 +\$2,120/);
  const act = { quit() {}, refresh() {}, move() {}, next() {}, keepVisible() {} };
  onKey(v, 'c', act);
  assert.equal(v.costMode, 'net');
  lines = draw(v, 160, 40);
  assert.match(lines[0], /캐시 제외 +오늘 \$5\.20/);
  assert.match(lines.find((l) => l.includes(' a ')), /▲\$195/);
  assert.match(lines.join("\n"), /캐시제외 +\$195[\s\S]*API 환산 \$2,120/);
  assert.match(lines.at(-1), /c +비용 기준/, '키 안내는 바뀔 상태가 아니라 고정된 이름이다');
  for (const W of [60, 70, 80, 90, 100, 110, 120]) {
    const head = draw(v, W, 40)[0];
    if (/\$/.test(head)) assert.match(head, /캐시 ?제외/, `W=${W} 금액이 보이면 기준도 보인다: ${head}`);
  }
  onKey(v, 'c', act);
  assert.equal(v.costMode, 'api');
  assert.match(draw(v, 160, 40).at(-1), /c +비용 기준/);
  assert.doesNotMatch(draw(v, 160, 40).at(-1), /비용 캐시 제외|비용 API 환산/);
});

test('응답 대기를 앞에 둘 때 로고 뒤 공백은 두 칸', () => {
  const head = draw(view([sess('w', { status: 'waiting', phase: { kind: 'waiting', text: '응답 대기' } })]))[0];
  assert.match(head, /^ ⣠⣴⣾   ◆ 1 응답 대기/);
});

test('날짜별 합계에 캐시 제외 비용도 더한다', () => {
  fx.transcript('llll0000-1', [user('x'), { ...assistant('m1', [], { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }), timestamp: new Date().toISOString() }]);
  const u = collectLedger({ budget: createBudget() });
  assert.ok(u.today.cost > u.today.costNoCache && u.today.costNoCache > 0, JSON.stringify(u.today));
});

test('응답 대기 행의 STATUS 칸은 요청 내용을 바로 보이고, 상세 창은 전체 문구를 보인다', () => {
  const s = sess('w', { status: 'waiting', phase: { kind: 'waiting', text: '응답 대기 · $ which cloudflared && which python3' } });
  const bare = sess('b', { status: 'waiting', phase: { kind: 'waiting', text: '응답 대기' } });
  const lines = draw(view([s, bare], { showDetail: true }), 160, 30);
  const row = lines.find((l) => l.includes('◆ claude') && / w +/.test(l));
  assert.match(row, / w +\$ which cloudflared && which python3/);
  assert.doesNotMatch(row, /응답 대기/);
  assert.match(lines.find((l) => l.includes('◆ claude') && / b +/.test(l)), /응답 대기/, '요청 내용이 없으면 응답 대기라고 적는다');
  assert.ok(lines.some((l) => l.includes('◆ 응답 대기 · $ which cloudflared')), '상세 창');
  assert.match(lines[0], /◆ 2 응답 대기/, '헤더 수는 그대로');
});

test('STATUS 칸 글: 응답 대기 접두어를 빼고, 요청이 없으면 응답 대기를 남긴다', async () => {
  const { statusText } = await import('../src/ui/table.mjs');
  assert.equal(statusText({ kind: 'waiting', text: '응답 대기 · approve Bash · 에이전트 1개 실행 중' }), 'approve Bash · 에이전트 1개 실행 중');
  assert.equal(statusText({ kind: 'waiting', text: '응답 대기' }), '응답 대기');
  assert.equal(statusText({ kind: 'tool', text: '응답 대기 · x' }), '응답 대기 · x', '대기가 아니면 그대로');
  assert.equal(statusText(undefined), '');
  const m = member('Explore', '찾기', 'claude-haiku-5-5', { phase: { kind: 'waiting', text: '응답 대기 · $ ls' } });
  const row = draw(view([sess('p', { members: [m] })])).find((l) => l.includes('찾기'));
  assert.match(row, /\$ ls/);
  assert.doesNotMatch(row, /응답 대기/, '팀원 행도 같은 규칙');
});

test('종료 행과 끝난 팀원 행은 기울임꼴, 색이 없어도 · 와 종료 글자로 구분된다', () => {
  const ended = sess('e', { status: 'ended', live: false, phase: { kind: 'ended', text: '종료' } });
  const raw = render(view([sess('a'), ended], { showEnded: true }), 160, 24);
  const row = raw.find((l) => strip(l).includes(' e '));
  if (!process.env.NO_COLOR) assert.match(row, /\x1b\[3m/);
  assert.match(strip(row), /^ · claude .* e +.*종료/);
});
