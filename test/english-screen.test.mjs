// 영어 화면 3/3: 표·상세·도움말·키 줄이 영어로 나오고 어느 크기에서도 화면 폭을 넘지 않는다.
// 이 파일은 AITOP_LANG 고정 없이도(LANG=C) 돌아야 한다. 언어는 setLang('en') 으로 정한다 (테스트 파일마다 프로세스가 따로라 다른 테스트에 번지지 않는다).
// 스냅숏을 다시 만들려면 UPDATE_EN_SNAPSHOT=1 로 돌린다. 한국어 스냅숏(wide-table·wide-detail)은 그대로 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setLang, getLang, phaseText, t } from '../src/i18n.mjs';
import { ROOT, at, session } from './detail-fixture.mjs';
import { render } from '../src/ui.mjs';
import { detail } from '../src/ui/detail.mjs';
import { setNow } from '../src/ui/draw.mjs';
import { width } from '../src/text.mjs';
import { keysLine, settingsLine } from '../src/help.mjs';
import { describe } from '../src/doctor.mjs';
import { notifyText, waitingEnv } from '../src/notify.mjs';
import { toJson } from '../src/json.mjs';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

setLang('en');

const BIN = fileURLToPath(new URL('../bin/aitop.mjs', import.meta.url));
const HANGUL = /[ㄱ-ㆎ가-힣]/;
const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const UPDATE = process.env.UPDATE_EN_SNAPSHOT === '1';

// 사용자 글(세션 이름·지시·활동)도 영어로 둔 고정 세션. 화면에 한글이 하나라도 보이면 번역이 빠진 것이다.
const enSession = (extra = {}) => ({
  ...session(),
  turns: [{ n: 1, at: at - 30 * 60_000, text: 'fold the detail panel on narrow screens' }],
  events: [
    { at: at - 9 * 60_000, kind: 'prompt', text: 'fold the detail panel on narrow screens' },
    { at: at - 8 * 60_000, kind: 'tool', text: 'Read src/ui/detail.mjs' },
    { at: at - 7 * 60_000, kind: 'reply', text: 'I will fold the left column into two summary lines.' },
    { at: at - 1 * 60_000, kind: 'tool', text: 'Edit src/ui/draw.mjs' },
  ],
  // 소스가 붙이는 '메인' 과 Antigravity 의 '도구 허락' 은 화면에서 바꾼다.
  files: session().files.map((f) => ({ ...f, hunks: f.hunks.map((h) => ({ ...h, agent: '메인' })) })),
  ...extra,
});

const usageOf = { today: { cost: 12.3, costNoCache: 4.1, tokens: 1e6 }, week: { cost: 50, costNoCache: 20, tokens: 1e7 }, lastHour: { cost: 3, costNoCache: 1 }, days7: [1, 2, 0, 4, 5, 6, 7].map((c) => ({ cost: c, costNoCache: c / 2 })) };
const toolsOf = { tools: { claude: { tool: 'claude', state: 'ok', path: '~/.claude', records: 3, lastAt: at, running: 1 }, codex: { tool: 'codex', state: 'missing', path: '~/.codex', running: 0, hint: '...' }, gemini: { tool: 'gemini', state: 'limited', found: false, path: '~/.gemini', running: 0, hint: '...' } } };

function data(sessions) {
  return { sessions, usage: usageOf, errors: [], at, tools: toolsOf };
}

const main = enSession({ id: 'fix', name: 'aitop' });
const waiter = enSession({ id: 'w', name: 'waiter', status: 'waiting', phase: { kind: 'waiting', args: { what: '도구 허락', agents: 2 } }, waitDetail: 'rm -rf build' });
const team = enSession({ id: 't', name: 'team', tool: 'codex', model: 'gpt-5.1-codex', phase: { kind: 'team', args: { n: 2 } }, members: [{ name: 'Explore', task: 'find files', status: 'busy', phase: { kind: 'tool', args: { what: 'Grep' } }, tokens: 1000, cost: 0.1 }] });
const idle = enSession({ id: 'i', name: 'idle-one', status: 'idle', phase: { kind: 'idle' }, cwd: '', project: '', tokens: { total: 0 } });
const ended = enSession({ id: 'e', name: 'old', status: 'ended', live: false, phase: { kind: 'ended' } });
const all = [main, waiter, team, idle, ended];

const base = () => ({ data: data(all), selectedId: 'fix', showDetail: 'auto', frame: 0, tab: 'now', budgetDay: 10, settings: { budgetDay: 10, notify: true, onWaiting: true, debug: false, configPath: '/x/config.json' } });
const VIEWS = {
  table: {},
  help: { help: true },
  helpFiles: { help: true, focus: 'files', filePath: `${ROOT}/src/ui/draw.mjs`, filter: 'ai' },
  files: { focus: 'files', filePath: `${ROOT}/src/ui/draw.mjs` },
  diff: { focus: 'diff', filePath: `${ROOT}/src/ui/draw.mjs` },
  allTab: { tab: 'all', costMode: 'net', showDetail: true },
  group: { group: 'project', sort: 'cost', pins: ['t'] },
  groupTool: { group: 'tool', showEnded: true },
  filter: { filter: 'ai' },
  noMatch: { filter: 'zzz' },
  searching: { searching: true, filter: 'ai' },
  requests: { selectedId: 'w', showRequests: true, showDetail: true },
  empty: { data: data([]) },
  emptyEnded: { data: data([]), showEnded: true },
  loading: { data: null },
};

function check(name, W, H) {
  const view = { ...base(), ...VIEWS[name] };
  const lines = render(view, W, H).map(strip);
  assert.equal(lines.length, H, `${name} ${W}x${H} 줄 수`);
  for (const l of lines) {
    assert.ok(width(l) <= W, `${name} ${W}x${H} 폭 넘침: ${l}`);
    assert.doesNotMatch(l, HANGUL, `${name} ${W}x${H} 한글: ${l}`);
  }
}

test('영어 화면: 폭 40~160, 높이 10~40 에서 모든 줄이 화면 폭 안에 들고 한글이 없다', () => {
  assert.equal(getLang(), 'en');
  for (let W = 40; W <= 160; W++) for (let H = 10; H <= 40; H++) check('table', W, H);
  for (const name of Object.keys(VIEWS).filter((n) => n !== 'table')) {
    for (let W = 40; W <= 160; W++) for (const H of [10, 13, 16, 20, 24, 30, 40]) check(name, W, H);
  }
});

test('영어 화면: 주요 문구가 영어로 나온다', () => {
  const text = (v, W = 140, H = 40) => render({ ...base(), ...v }, W, H).map(strip).join('\n');
  const t = text({});
  for (const s of ['Sessions 5', 'API cost', 'today $12.30/$10', '7d $50.00', '◆ 1 wait','Changed files', 'Recent activity', 'Latest prompt', 'Session', 'Folder', 'Started', 'Tokens', 'cache read', 'Cost', 'API cost', 'show ended', 'hidden', 'Approve tool', 'Team · 2']) assert.ok(t.includes(s), s);
  assert.match(text({}, 160), /⊘ read-only$/m);
  assert.match(text({ help: true }), /Help {2}· {2}\? or Esc to close/);
  assert.match(text({ help: true }), /Session table {2}\(this view\)/);
  assert.match(text({ help: true }), /Now +budget \$10 · notify on · on-waiting set/);
  assert.match(text({ group: 'project' }), /▾ Waiting {2}1/);
  assert.match(text({ group: 'project', pins: ['t'] }), /▾ Pinned {2}1/);
  assert.match(text({ group: 'project' }), /▾ \(no folder\)/);
  assert.match(text({ sort: 'cost', group: 'tool' }), /s:cost g:tool/);
  assert.match(text({ focus: 'diff', filePath: `${ROOT}/src/ui/draw.mjs` }), /\d\d:\d\d:\d\d · main · @@/);
  assert.match(text({ filter: 'zzz' }), /No sessions match 'zzz'\./);
  assert.match(text({ data: data([]) }), /No AI sessions running\./);
  assert.match(text({ data: data([]) }), /not found|missing/);
  assert.match(text({ selectedId: 'e' }, 140, 10), /… \+\d+ sessions \(1 waiting\) {2}↑↓ to move/);
  assert.match(text({ data: null }), /Reading session logs…/);
});

test('영어 화면: 표·상세 스냅숏 (en)', (t) => {
  // render 는 그릴 때 시각(IDLE 칸)을 Date.now 로 잡으므로 고정 시각으로 바꿔 둔다.
  t.mock.method(Date, 'now', () => at);
  const got = { table: {}, detail: {} };
  for (const W of [80, 96, 100, 120, 150]) {
    got.table[W] = render({ ...base(), showDetail: false }, W, 20).map(strip).map((l) => l.trimEnd()).slice(0, 12);
  }
  for (const W of [60, 100, 120, 150]) {
    for (const H of [16, 24]) {
      setNow(at);
      got.detail[`${W}x${H}`] = detail(main, W, H, 0, { tab: 'now' }).map(strip).map((l) => l.trimEnd());
    }
  }
  const file = new URL('./english-screen.snapshot.json', import.meta.url);
  if (UPDATE) writeFileSync(file, JSON.stringify(got, null, 1) + '\n');
  assert.ok(existsSync(file), 'en 스냅숏 파일이 없다 (UPDATE_EN_SNAPSHOT=1 로 만든다)');
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(got, snap);
});

test('keysLine·settingsLine·describe 는 지금 언어가 기본이다', () => {
  assert.equal(keysLine('common'), '? help · q quit');
  assert.equal(keysLine('common', 'ko'), '? 도움말 · q 나가기');
  assert.equal(settingsLine({ budgetDay: 0, notify: false, debug: true }), 'budget none · notify off · debug on');
  assert.equal(describe({ tool: 'codex', state: 'missing', path: '~/.codex', running: 0 }, at).state, 'missing');
  assert.equal(describe({ tool: 'codex', state: 'missing', path: '~/.codex', running: 0 }, at, 'ko').state, '없음');
});

test('알림은 화면 언어를 따르고, AITOP_WAITING_FOR 와 --json phase 는 한국어 그대로다', () => {
  const s = { tool: 'claude', id: 'a', project: 'web', status: 'waiting', live: true, phase: { kind: 'waiting', args: { what: 'Bash' } } };
  assert.deepEqual(notifyText([s]), { title: 'aitop: waiting (claude)', body: 'web · Bash' });
  assert.deepEqual(notifyText([s, s]), { title: 'aitop: waiting', body: '2 sessions are waiting for you' });
  assert.deepEqual(notifyText([s], 'ko'), { title: 'aitop: 응답 대기 (claude)', body: 'web · Bash' });
  const a = { ...s, phase: { kind: 'waiting', args: { what: '도구 허락', agents: 1 } } };
  assert.equal(waitingEnv(a).AITOP_WAITING_FOR, '도구 허락 · 에이전트 1개 실행 중');
  assert.equal(notifyText([a]).body, 'web · Approve tool · 1 agent');
  assert.equal(toJson({ at, usage: null, sessions: [a] }, '0').sessions[0].phase, '응답 대기 · 도구 허락 · 에이전트 1개 실행 중');
  assert.equal(phaseText(a.phase), 'Waiting for you · Approve tool · 1 agent running');
});

test('영어 수 문구는 단수·복수를 나누고, 한국어는 그대로다', () => {
  assert.equal(t('ui.more', { n: 1 }), '… +1 session');
  assert.equal(t('ui.more', { n: 3 }), '… +3 sessions');
  assert.equal(t('ui.more', { n: 1 }, { lang: 'ko' }), '… +1 세션');
  assert.equal(t('detail.editCount', { n: 1 }), '  1 edit');
  assert.equal(t('detail.editCount', { n: 2 }), '  2 edits');
  assert.equal(t('detail.cut', { n: 1 }), '… 1 line cut');
  assert.equal(t('detail.cut', { n: 0 }), '… 0 lines cut');
  assert.equal(t('help.more', { n: 1 }), '… 1 more line · ↑↓ to scroll');
  assert.equal(t('doctor.records', { n: '1' }), '1 log');
  assert.equal(t('doctor.records', { n: '1,024' }), '1,024 logs');
  assert.equal(t('notify.many', { n: 2 }), '2 sessions are waiting for you');
  // 에이전트 문구: 문장 가운데는 소문자, 혼자 남으면 첫 글자 대문자
  assert.equal(phaseText({ kind: 'think', msg: 'steps', args: { n: 12, agents: 1 } }), 'Working · step 12 · 1 agent running');
  assert.equal(phaseText({ kind: 'waiting', args: { agents: 2 } }, { short: true }), '2 agents');
  assert.equal(phaseText({ kind: 'waiting', args: { agents: 1 } }, { short: true }), '1 agent');
  assert.equal(phaseText({ kind: 'think', args: { agents: 1 } }, { lang: 'ko' }), '생각 중 · 에이전트 1개 실행 중');
});

test('영어 도움말: 키·제목 칸과 설명 사이가 2칸 이상이다', () => {
  for (const W of [60, 80, 120, 160]) {
    const lines = render({ ...base(), help: true }, W, 80).map(strip);
    for (const key of ['Typing a search', 'Changed files', 'Filtered table', 'AITOP_AMBIGUOUS=wide', 'today / 7d']) {
      // 줄 맨 앞(테두리 바로 뒤) 키·제목 칸에 있는 줄만 본다. 설명 안에 같은 말이 있는 줄은 건너뛴다.
      const found = lines.filter((x) => x.includes(`│ ${key} `));
      for (const l of found) assert.ok(l.includes(`│ ${key}  `), `W=${W} ${key}: ${l}`);
      if (W >= 120) assert.ok(found.length, `W=${W} ${key} 없음`);
    }
  }
});

test('bin: AITOP_LANG 없이 LANG=C 의 --once 는 영어 화면이다', () => {
  const fx = makeClaudeHome();
  const now = Date.now();
  fx.session({ sessionId: 'en000000-1', name: 'english', status: 'idle', cwd: '/work/en' });
  fx.transcript('en000000-1', [{ ...user('add a test'), timestamp: new Date(now - 60_000).toISOString() }, { ...assistant('m1', [{ type: 'text', text: 'done' }], usage(1000, 10)), timestamp: new Date(now - 50_000).toISOString() }], '-work-en');
  const env = { ...process.env, LANG: 'C', LC_ALL: '', LC_MESSAGES: '', COLUMNS: '120', LINES: '40' };
  delete env.AITOP_LANG;
  const r = spawnSync(process.execPath, [BIN, '--once'], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Sessions \d+/);
  assert.match(r.stdout, /\[q\] quit/);
  // 이 PC 에서 도는 gemini 프로세스는 이름(사용자 글)에 한글이 있을 수 있어 그 줄은 빼고 본다.
  for (const l of r.stdout.split('\n').filter((x) => !/gemini/.test(x))) assert.doesNotMatch(l, HANGUL, l);
});
