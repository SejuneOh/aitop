// aitop --line 의 한 줄 만들기: 0 인 항목 빼기, 예산, 폭 상한, tmux 서식, NO_COLOR, ASCII 만.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLine, lineOption, lineName, DEFAULT_WIDTH, NAME_WIDTH, PENDING } from '../src/line.mjs';
import { width } from '../src/text.mjs';

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

const NOW = 1_800_000_000_000;
const one = { today: 176, waiting: 1, longest: { name: 'gemini-gen', since: NOW - 125_000 }, running: 3, perHour: 37.7 };
const two = { ...one, waiting: 2 };

test('대기 세션 이름: 하나면 수 대신 이름, 둘 이상이면 수 뒤에 가장 오래 기다린 세션과 대기 시간', () => {
  assert.equal(formatLine(one, { now: NOW }), '$176 wait gemini-gen 2m run 3 $37.7/h');
  assert.equal(formatLine(two, { now: NOW }), '$176 wait 2 gemini-gen 2m run 3 $37.7/h');
  // 이름을 모르면 예전처럼 수만. 시각을 모르면 시간만 뺀다.
  assert.equal(formatLine({ ...one, longest: null }, { now: NOW }), '$176 wait 1 run 3 $37.7/h');
  assert.equal(formatLine({ ...one, longest: { name: 'x', since: null } }, { now: NOW }), '$176 wait x run 3 $37.7/h');
  assert.equal(formatLine({ ...one, longest: { name: '\x1b[31m', since: NOW } }, { now: NOW }), '$176 wait 1 run 3 $37.7/h');
});

test('폭이 모자라면 시간당 지출, 작업 중, 이름 순서로 빼고, 대기 수는 이름보다 늦게 뺀다', () => {
  const at = (w, v = two) => formatLine(v, { now: NOW, width: w });
  assert.equal(at(33), '$176 wait 2 gemini-gen 2m run 3');
  assert.equal(at(25), '$176 wait 2 gemini-gen 2m');
  assert.equal(at(24), '$176 wait 2');
  assert.equal(at(11), '$176 wait 2');
  assert.equal(at(10), '$176');
  // 하나만 기다릴 때도 이름이 빠지면 수가 남는다.
  assert.equal(at(23, one), '$176 wait gemini-gen 2m');
  assert.equal(at(22, one), '$176 wait 1');
});

test('lineName: 제어 문자·색 순서·이모지·폭이 모호한 기호는 지우고 NAME_WIDTH 칸에서 ~ 로 자른다', () => {
  assert.equal(lineName('a\x1b[31mred\x1b[0m\x07'), 'ared');
  assert.equal(lineName('fix \u{1f389} bug \u00b7 x'), 'fix bug x');
  assert.equal(lineName('gemini-generator-long'), 'gemini-gene~');
  assert.equal(width(lineName('gemini-generator-long')), NAME_WIDTH);
  // 한글은 2칸으로 센다.
  assert.equal(lineName('한글 세션 이름이 깁니다'), '한글 세션~');
  assert.ok(width(lineName('한글 세션 이름이 깁니다')) <= NAME_WIDTH);
  // OSC(창 제목·링크)는 BEL 이나 ESC \ 까지 통째로 지운다.
  assert.equal(lineName('a\x1b]0;title\x07b'), 'ab');
  assert.equal(lineName('a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\c'), 'alinkc');
  assert.equal(lineName('a\x1b]2;unterminated'), 'a');
  assert.equal(lineName(null), '');
  assert.equal(lineName('\n\t'), '');
});

test('폭은 표시 칸으로 센다 (한글 이름)', () => {
  const v = { today: 1, waiting: 1, longest: { name: '한글세션', since: NOW } };
  assert.equal(formatLine(v, { now: NOW }), '$1.00 wait 한글세션 0s');
  assert.equal(formatLine(v, { now: NOW, width: 20 }), '$1.00 wait 1');
});

test('tmux 모드: 이름 속 # 은 ## 로 바꿔 서식으로 읽히지 않게 한다 (NO_COLOR 여도)', () => {
  const v = { waiting: 1, longest: { name: 'a#[x]#(rm)', since: NOW } };
  assert.equal(formatLine(v, { now: NOW, mode: 'tmux' }), '#[fg=colour214]wait a##[x]##(rm) 0s#[default]');
  assert.equal(formatLine(v, { now: NOW, mode: 'tmux', noColor: true }), 'wait a##[x]##(rm) 0s');
  assert.equal(formatLine(v, { now: NOW }), 'wait a#[x]#(rm) 0s');
  assert.equal(formatLine(two, { now: NOW, mode: 'tmux' }), '#[fg=colour154]$176#[default] #[fg=colour214]wait 2 gemini-gen 2m#[default] #[fg=colour250]run 3#[default] #[fg=colour154]$37.7/h#[default]');
});

test('이름이 ASCII 면 출력도 ASCII 만', () => {
  for (const mode of ['plain', 'tmux']) for (const x of [one, two, { ...two, longest: { name: 'x\u00e9\u2192y', since: NOW } }]) ascii(formatLine(x, { mode, now: NOW }));
});
