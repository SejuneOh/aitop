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
  assert.match(head, /^ ⣠⣴⣾  +◆ 1 응답 대기 +1 live/);
  assert.match(draw(view([sess('a')]))[0], /1 live .*◆ 0 응답 대기/, '없으면 원래 자리');
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
  assert.match(lines.at(-1), /c +비용 API 환산/);
  onKey(v, 'c', act);
  assert.equal(v.costMode, 'api');
});

test('날짜별 합계에 캐시 제외 비용도 더한다', () => {
  fx.transcript('llll0000-1', [user('x'), { ...assistant('m1', [], { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 }), timestamp: new Date().toISOString() }]);
  const u = collectLedger({ budget: createBudget() });
  assert.ok(u.today.cost > u.today.costNoCache && u.today.costNoCache > 0, JSON.stringify(u.today));
});
