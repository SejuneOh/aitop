// aitop --line 의 한 줄 만들기: 0 인 항목 빼기, 예산, 폭 상한, tmux 서식, NO_COLOR, ASCII 만.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLine, lineOption, DEFAULT_WIDTH, PENDING } from '../src/line.mjs';

const ascii = (s) => assert.match(s, /^[\x20-\x7e]*$/, `ASCII 만: ${JSON.stringify(s)}`);
const v = { today: 54.13, waiting: 2, perHour: 3.14 };

test('기본은 색 없는 글: 오늘 비용, 대기 수, 시간당 지출', () => {
  assert.equal(formatLine(v), '$54.13 wait 2 $3.1/h');
});

test('0 인 항목은 뺀다', () => {
  assert.equal(formatLine({ today: 54.13, waiting: 0, perHour: 0 }), '$54.13');
  assert.equal(formatLine({ today: 0, waiting: 1, perHour: 0.001 }), 'wait 1');
  assert.equal(formatLine({}), '');
});

test('예산이 있으면 오늘 비용 뒤에 /$예산 을 붙인다 (오늘 비용이 0 이어도)', () => {
  assert.equal(formatLine({ ...v, budgetDay: 50 }), '$54.13/$50 wait 2 $3.1/h');
  assert.equal(formatLine({ today: 0, budgetDay: 12.5 }), '$0.00/$12.50');
  assert.equal(formatLine({ today: 1, budgetDay: null }), '$1.00');
});

test('금액 자릿수: 100 달러 넘으면 정수, 시간당 1 달러 아래는 센트까지', () => {
  assert.equal(formatLine({ today: 123.4, perHour: 0.42 }), '$123 $0.42/h');
  assert.equal(formatLine({ today: 1234.5, perHour: 150 }), '$1,235 $150/h');
});

test('폭 상한을 넘으면 뒤 항목부터 뺀다', () => {
  assert.equal(formatLine(v, { width: 13 }), '$54.13 wait 2');
  assert.equal(formatLine(v, { width: 12 }), '$54.13');
  assert.equal(formatLine(v, { width: 3 }), '');
  assert.ok(formatLine({ today: 99999, budgetDay: 99999, waiting: 99, perHour: 999 }).length <= DEFAULT_WIDTH);
});

test('tmux 모드는 항목마다 #[fg=colourN]...#[default] 를 씌운다 (대기는 주목 색, 돈은 돈 색)', () => {
  const out = formatLine(v, { mode: 'tmux' });
  assert.equal(out, '#[fg=colour154]$54.13#[default] #[fg=colour214]wait 2#[default] #[fg=colour154]$3.1/h#[default]');
  assert.doesNotMatch(out, /\x1b/);
  // 폭은 서식을 뺀 글자로 센다.
  assert.equal(formatLine(v, { mode: 'tmux', width: 13 }), '#[fg=colour154]$54.13#[default] #[fg=colour214]wait 2#[default]');
  assert.match(formatLine(v, { mode: 'tmux', colorBlind: true }), /colour226\]wait 2/);
});

test('NO_COLOR 면 tmux 모드여도 서식을 넣지 않는다', () => {
  assert.equal(formatLine(v, { mode: 'tmux', noColor: true }), '$54.13 wait 2 $3.1/h');
});

test('출력은 늘 ASCII 만 쓴다', () => {
  for (const mode of ['plain', 'tmux']) for (const x of [v, { ...v, budgetDay: 7.25 }, { today: 5000, perHour: 0.5 }]) ascii(formatLine(x, { mode }));
  ascii(PENDING);
});

test('lineOption 은 --line, --line=tmux, --line-width 를 꺼낸다', () => {
  assert.deepEqual(lineOption(['--line', '--all']), { mode: 'plain', width: DEFAULT_WIDTH, rest: ['--all'], error: null });
  assert.equal(lineOption(['--line=tmux']).mode, 'tmux');
  assert.equal(lineOption(['--once']).mode, null);
  assert.equal(lineOption(['--line', '--line-width', '20']).width, 20);
  assert.equal(lineOption(['--line-width=25']).width, 25);
  assert.match(lineOption(['--line=bar']).error, /plain 또는 tmux/);
  assert.match(lineOption(['--line-width', '0']).error, /0 보다 큰 정수/);
  assert.match(lineOption(['--line-width']).error, /값이 없습니다/);
});
