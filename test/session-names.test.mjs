// 사용자가 붙인 세션 이름 (#213): Claude /rename(custom-title), Codex thread_name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const root = mkdtempSync(join(tmpdir(), 'aitop-names-'));
process.env.CODEX_HOME = join(root, 'codex');
const { collectClaude, claudeWaiting } = await import('../src/sources/claude.mjs');
const { ClaudeTracker } = await import('../src/sources/claude-tracker.mjs');
const { collectCodex } = await import('../src/sources/codex.mjs');
const { sessionName } = await import('../src/sources/common.mjs');
const { markDirty, flushCache, loadCache } =await import('../src/cache.mjs');
const { notifyText } = await import('../src/notify.mjs');
const { toJson } = await import('../src/json.mjs');
const { createBudget } = await import('../src/tail.mjs');

const rename = (customTitle, sessionId) => ({ type: 'custom-title', customTitle, sessionId });
const run = (opts = {}) => collectClaude({ showEnded: false, budget: createBudget(), ...opts });

test('custom-title 이 없으면 예전처럼 세션 파일 이름, 그다음 대화 제목', () => {
  fx.session({ sessionId: 'n1000000-b', pid: process.pid, name: 'n1000000' });
  fx.transcript('n1000000-b', [{ type: 'ai-title', aiTitle: '대화 제목' }, user('시작')]);
  const s = run().find((x) => x.id === 'n1000000-b');
  assert.equal(s.name, '대화 제목');
  assert.equal(s.customName, null);
});

test('세션 중간에 /rename 하면 다음 갱신에 이름이 바뀌고, 나중 이름이 이긴다', () => {
  fx.session({ sessionId: 'n2000000-a', name: 'derived-name' });
  const p = fx.transcript('n2000000-a', [user('시작'), assistant('m1', [{ type: 'text', text: 'hi' }], usage(1, 1))]);
  assert.equal(run()[0].name, 'derived-name');
  fx.append(p, [rename('first', 'n2000000-a')]);
  let [s] = run();
  assert.equal(s.name, 'first');
  assert.equal(s.customName, 'first');
  fx.append(p, [user('계속'), rename('second', 'n2000000-a'), assistant('m2', [{ type: 'text', text: 'ok' }], usage(1, 1))]);
  [s] = run();
  assert.equal(s.name, 'second', '나중 rename 이 이긴다 (세션 파일 이름보다 먼저)');
  assert.equal(toJson({ sessions: [s] }).sessions[0].name, 'second');
});

test('이름은 제어문자·색 순서를 지우고 비밀값을 가린다', () => {
  assert.equal(sessionName('\x1b[31mred\x1b[0m\nname‮'), 'red name');
  assert.equal(sessionName('token=abcdefghijk'), 'token=••••');
  assert.equal(sessionName('   '), null);
  assert.equal(sessionName(42), null);
  assert.equal(sessionName('x'.repeat(200)).length, 80);
  fx.session({ sessionId: 'n3000000-a' });
  fx.transcript('n3000000-a', [rename('evil\x1b]0;title\x07\tname', 'n3000000-a')]);
  assert.equal(run()[0].name, 'evil name');
});

test('캐시: customTitle 을 저장했다가 다시 읽고, 이 필드가 없는 예전 캐시는 끝부분을 훑어 채운다', () => {
  const p = fx.transcript('n4000000-a', [user('시작'), rename('cached-name', 'n4000000-a'), assistant('m1', [{ type: 'text', text: 'x' }], usage(1, 1))]);
  const t = new ClaudeTracker(p);
  t.update(createBudget());
  flushCache();
  const again = new ClaudeTracker(p);
  assert.equal(again.tail.offset > 0, true, '캐시에서 이어 읽는다');
  assert.equal(again.customTitle, 'cached-name');

  markDirty(p, () => {
    const s = t.snapshot();
    delete s.customTitle;
    return s;
  });
  flushCache();
  assert.equal(new ClaudeTracker(p).customTitle, 'cached-name', '예전 캐시도 이름을 찾는다');
});

test('끝난 세션(기록만 남음)도 기록의 /rename 이름을 쓴다', () => {
  fx.transcript('n5000000-a', [{ type: 'ai-title', aiTitle: '제목' }, user('x'), rename('ended-name', 'n5000000-a')], '-work-ended');
  const s = collectClaude({ showEnded: true, budget: createBudget(0) }).find((x) => x.id === 'n5000000-a');
  assert.equal(s.name, 'ended-name');
  assert.equal(s.customName, 'ended-name');
});

test('--line 대기 이름: 기록 끝의 /rename 이름이 세션 파일 이름보다 먼저', () => {
  fx.session({ sessionId: 'n6000000-a', name: 'n6000000', cwd: '/work/linecwd', waitingFor: 'approve Bash' });
  const p = fx.transcript('n6000000-a', [user('x')]);
  assert.equal(claudeWaiting()[0].name, 'linecwd', '없으면 예전처럼 폴더 이름');
  appendFileSync(p, JSON.stringify(rename('line-name', 'n6000000-a')) + '\n');
  assert.equal(claudeWaiting()[0].name, 'line-name');
});

test('알림 본문: 사용자 이름이 있으면 프로젝트 대신 이름', () => {
  const base = { tool: 'claude', project: 'proj', phase: { kind: 'waiting', args: { what: 'approve Bash' } } };
  assert.match(notifyText([base], 'en').body, /^proj/);
  assert.match(notifyText([{ ...base, customName: 'my-name' }], 'en').body, /^my-name/);
  assert.match(notifyText([{ ...base, customName: 'my-name' }], 'en', 'done').body, /^my-name/);
});

function rollout(name, cwd, rows = []) {
  const d = new Date();
  const dir = join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(path, [{ type: 'session_meta', payload: { id: name, timestamp: d.toISOString(), cwd } }, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

test('Codex: session_index.jsonl 의 thread_name, 기록의 thread_name_updated 이벤트', () => {
  rollout('cx-plain', '/work/plain');
  rollout('cx-index', '/work/index');
  const p = rollout('cx-event', '/work/event');
  const index = join(process.env.CODEX_HOME, 'session_index.jsonl');
  writeFileSync(index, JSON.stringify({ id: 'cx-index', thread_name: 'old', updated_at: 'x' }) + '\n');
  const byId = () => Object.fromEntries(collectCodex({ showEnded: false, canList: () => false }).map((r) => [r.id, r]));
  let rows = byId();
  assert.equal(rows['cx-plain'].name, 'plain');
  assert.equal(rows['cx-plain'].customName, null);
  assert.equal(rows['cx-index'].name, 'old');

  appendFileSync(index, JSON.stringify({ id: 'cx-index', thread_name: 'new\x1b[1m', updated_at: 'y' }) + '\n');
  appendFileSync(p, JSON.stringify({ type: 'event_msg', payload: { type: 'thread_name_updated', thread_id: 'cx-event', thread_name: 'renamed' } }) + '\n');
  rows = byId();
  assert.equal(rows['cx-index'].name, 'new', '같은 id 는 마지막 줄이 이긴다');
  assert.equal(rows['cx-event'].name, 'renamed');
  assert.equal(rows['cx-event'].customName, 'renamed');
});

test('세션 파일의 user/peer 이름은 custom-title 이 없어도 알림용 사용자 이름, auto·derived 는 화면 이름으로만', () => {
  fx.session({ sessionId: 'n7000000-a', name: 'given', nameSource: 'user' });
  fx.transcript('n7000000-a', [user('x')]);
  let [s] = run();
  assert.equal(s.name, 'given');
  assert.equal(s.customName, 'given');
  assert.match(notifyText([{ ...s, phase: { kind: 'waiting' } }], 'en').body, /^given/);
  fx.session({ sessionId: 'n7000000-a', name: 'model-made', nameSource: 'auto' });
  [s] = run();
  assert.equal(s.name, 'model-made');
  assert.equal(s.customName, null);
});

test('예전 캐시를 훑은 뒤 캐시에 다시 적어 다음에는 훑지 않는다', () => {
  const p = fx.transcript('n8000000-a', [user('x'), rename('once', 'n8000000-a')]);
  const t = new ClaudeTracker(p);
  t.update(createBudget());
  markDirty(p, () => {
    const s = t.snapshot();
    delete s.customTitle;
    return s;
  });
  flushCache();
  assert.equal(new ClaudeTracker(p).customTitle, 'once');
  flushCache();
  assert.equal(loadCache(p).customTitle, 'once', '훑은 결과가 캐시에 남는다');
});
