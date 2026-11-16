// 서브에이전트(팀원) 행의 경과 시간과 '멈춘 듯' 표시 (#233).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';
import { fmtElapsed } from '../src/text.mjs';
import { utimesSync } from 'node:fs';
import { MEMBER_STALL_LONG_MS, MEMBER_STALL_MS, isLongTool, memberStalled } from '../src/sources/common.mjs';
import { getLang, setLang } from '../src/i18n.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');
const { columns, memberRow } = await import('../src/ui/table.mjs');
const { setNow } = await import('../src/ui/draw.mjs');
const { toJson } = await import('../src/json.mjs');

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const AT = Date.UTC(2026, 10, 16, 3, 0, 0);
const member = (more = {}) => ({ id: 'a', name: 'Explore', task: '코드 찾기', model: 'claude-haiku-5-5', status: 'busy', started: true, phase: { kind: 'think' }, tokens: 1200, cost: 0.01, startedAt: AT - 192_000, lastActivityAt: AT - 10_000, longStep: false, ...more });
const row = (m, W) => {
  setNow(AT);
  return strip(memberRow(m, true, columns(W), W, 0, 'claude-opus-5-5'));
};

test('경과 시간 형식: 42s, 3m12s, 12m05s, 1h05m (1시간부터 초를 버린다)', () => {
  assert.equal(fmtElapsed(0), '0s');
  assert.equal(fmtElapsed(42_400), '42s');
  assert.equal(fmtElapsed(192_000), '3m12s');
  assert.equal(fmtElapsed(725_000), '12m05s');
  assert.equal(fmtElapsed(3_599_999), '59m59s');
  assert.equal(fmtElapsed(3_600_000), '1h00m');
  assert.equal(fmtElapsed(3_900_000 + 59_000), '1h05m');
  assert.equal(fmtElapsed(-5), '0s', '시계가 거꾸로 가도 음수를 보이지 않는다');
});

test('멈춘 듯 경계: 마지막 기록 후 3분, 오래 걸리는 도구가 도는 중이면 10분', () => {
  const at = (ago, more) => memberStalled({ status: 'busy', lastActivityAt: AT - ago, ...more }, AT);
  assert.equal(MEMBER_STALL_MS, 180_000);
  assert.equal(MEMBER_STALL_LONG_MS, 600_000);
  assert.equal(at(MEMBER_STALL_MS - 1), false);
  assert.equal(at(MEMBER_STALL_MS), true);
  assert.equal(at(MEMBER_STALL_LONG_MS - 1, { longStep: true }), false);
  assert.equal(at(MEMBER_STALL_LONG_MS, { longStep: true }), true);
  assert.equal(at(MEMBER_STALL_LONG_MS, { status: 'done' }), false, '끝난 팀원은 멈춘 듯이 아니다');
  assert.equal(memberStalled({ status: 'busy', lastActivityAt: null }, AT), false, '마지막 기록 시각을 모르면 짐작하지 않는다');
});

test('넓은 화면: 작업 중 팀원 행 끝에 경과 시간, 멈췄으면 그 앞에 멈춘 듯', () => {
  const W = 140;
  assert.match(row(member(), W).trimEnd(), / 3m12s$/);
  assert.doesNotMatch(row(member(), W), /멈춘 듯/);
  assert.match(row(member({ lastActivityAt: AT - MEMBER_STALL_MS }), W).trimEnd(), /멈춘 듯 3m12s$/);
  // 끝난 팀원은 경과 시간을 그리지 않는다.
  assert.doesNotMatch(row(member({ status: 'done', phase: { kind: 'done' } }), W), /3m12s/);
  // 시작 시각을 모르면 비운다.
  assert.doesNotMatch(row(member({ startedAt: undefined }), W), /\d+s\s*$/);
});

test('좁은 화면: 이름이 먼저 줄고 경과 시간은 남는다. 멈춘 듯이 끝 칸에 안 들어가면 STATUS 앞에 붙는다', () => {
  const long = member({ task: '아주 긴 하는 일 설명이 들어가서 이름 칸을 넘친다', lastActivityAt: AT - MEMBER_STALL_MS });
  for (const W of [60, 50]) {
    const c = columns(W);
    assert.equal(c.cells, 0, `W=${W} 는 CTX 막대가 없는 단계`);
    const r = row(long, W);
    assert.match(r.trimEnd(), / 3m12s$/, `W=${W}: 경과 시간은 그대로`);
    assert.doesNotMatch(r, /넘친다/, `W=${W}: 이름은 잘린다`);
    assert.match(r, / 멈춘 듯 /, `W=${W}: 멈춘 듯은 STATUS 칸 앞에 남는다`);
  }
  // STATUS 칸이 '멈춘 듯' 보다 좁은 가장 좁은 단계: 경과 시간 뒤의 ? 하나로 줄인다.
  assert.ok(columns(44).status < 8);
  assert.match(row(long, 44).trimEnd(), / 3m12s\?$/);
  assert.match(row(member(), 44).trimEnd(), / 3m12s$/, '멈추지 않았으면 ? 가 없다');
  // CONTEXT 막대 4칸 단계(끝 칸 14칸)에서는 둘 다 끝 칸에 들어간다.
  const W = [...Array(40).keys()].map((i) => 95 - i).find((w) => columns(w).cells === 4);
  assert.ok(W, 'CONTEXT 막대 4칸 단계가 있다');
  assert.match(row(long, W).trimEnd(), /멈춘 듯 3m12s$/);
});

test('영어 화면은 stalled? 로 적는다', () => {
  const before = getLang();
  try {
    setLang('en');
    assert.match(row(member({ lastActivityAt: AT - MEMBER_STALL_MS }), 140).trimEnd(), /stalled\? 3m12s$/);
  } finally {
    setLang(before);
  }
});

test('NO_COLOR·밝은 테마·색약 팔레트에서도 멈춘 듯이 글자로 보인다', () => {
  const m = member({ lastActivityAt: AT - MEMBER_STALL_MS });
  const src = `const { columns, memberRow } = await import(${JSON.stringify(new URL('../src/ui/table.mjs', import.meta.url).href)});
const { setNow } = await import(${JSON.stringify(new URL('../src/ui/draw.mjs', import.meta.url).href)});
const { setLang } = await import(${JSON.stringify(new URL('../src/i18n.mjs', import.meta.url).href)});
setLang(process.env.AITOP_LANG);
setNow(${AT});
process.stdout.write(memberRow(${JSON.stringify(m)}, true, columns(120), 120, 0, 'claude-opus-5-5'));`;
  const run = (env) => execFileSync(process.execPath, ['--input-type=module', '-e', src], { env: { ...process.env, AITOP_LANG: 'ko', ...env }, encoding: 'utf8' });
  const plain = run({ NO_COLOR: '1' });
  assert.doesNotMatch(plain, /\x1b\[[0-9;]*[34]8;/, '색 코드 없음');
  assert.match(strip(plain), /멈춘 듯 3m12s/);
  assert.match(strip(run({ AITOP_THEME: 'light' })), /멈춘 듯 3m12s/);
  assert.match(strip(run({ AITOP_COLOR_BLIND: '1' })), /멈춘 듯 3m12s/);
  assert.match(strip(run({ AITOP_LANG: 'en', NO_COLOR: '1' })), /stalled\? 3m12s/);
});

test('--json member 에 startedAt·lastActivityAt·stalled 를 더한다 (기존 필드는 그대로)', () => {
  const m = member({ lastActivityAt: AT - MEMBER_STALL_MS });
  const j = toJson({ at: AT, sessions: [{ tool: 'claude', id: 's', status: 'busy', members: [m, member({ id: 'b' }), { name: 'x', status: 'done' }] }], errors: [] });
  const [a, b, c] = j.sessions[0].members;
  assert.deepEqual(Object.keys(a), ['name', 'task', 'model', 'status', 'phase', 'phaseKind', 'tokens', 'cost', 'startedAt', 'lastActivityAt', 'stalled']);
  assert.equal(a.startedAt, new Date(AT - 192_000).toISOString());
  assert.equal(a.lastActivityAt, new Date(AT - MEMBER_STALL_MS).toISOString());
  assert.equal(a.stalled, true);
  assert.equal(b.stalled, false);
  assert.deepEqual([c.startedAt, c.lastActivityAt, c.stalled], [null, null, false]);
});

test('Claude 수집기: 팀원에 시작·마지막 기록 시각을 넣고, Bash 가 도는 중이면 긴 기준', () => {
  fx.session({ sessionId: 'elapsed-1' });
  fx.transcript('elapsed-1', [user('팀원 둘'), assistant('m1', [{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }, { type: 'tool_use', id: 'tb', name: 'Agent', input: {} }], usage(1, 1))]);
  fx.subagent('elapsed-1', 'a', { agentType: 'Explore', description: '빌드', toolUseId: 'ta' }, [assistant('s1', [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'npm test' } }], usage(3, 4))]);
  fx.subagent('elapsed-1', 'b', { agentType: 'Explore', description: '읽기', toolUseId: 'tb' }, [assistant('s2', [{ type: 'tool_use', id: 'y', name: 'Read', input: { file_path: '/a/b.mjs' } }], usage(3, 4))]);
  const [s] = collectClaude({ showEnded: false, budget: createBudget() });
  const a = s.members.find((m) => m.task === '빌드');
  const b = s.members.find((m) => m.task === '읽기');
  for (const m of [a, b]) {
    assert.ok(Number.isFinite(m.startedAt) && Math.abs(Date.now() - m.startedAt) < 60_000);
    assert.ok(Number.isFinite(m.lastActivityAt) && Math.abs(Date.now() - m.lastActivityAt) < 60_000);
  }
  assert.equal(a.longStep, true);
  assert.equal(b.longStep, false);
});

test('허락 대기: 팀원이 응답 대기이거나 부모 세션이 응답 대기면 멈춘 듯이 아니다. MCP 도구는 오래 걸리는 단계, Skill 은 아니다', () => {
  const quiet = { status: 'busy', lastActivityAt: AT - MEMBER_STALL_LONG_MS };
  assert.equal(memberStalled(quiet, AT), true);
  assert.equal(memberStalled(quiet, AT, 'waiting'), false);
  assert.equal(memberStalled({ ...quiet, status: 'waiting' }, AT), false);
  assert.equal(isLongTool('mcp__cms__create'), true);
  assert.equal(isLongTool('call_mcp_tool'), true);
  assert.equal(isLongTool('Task'), true);
  assert.equal(isLongTool('Skill'), false);
  assert.equal(isLongTool('Read'), false);
  // 화면: 부모가 응답 대기면 경과 시간만 남는다.
  setNow(AT);
  const m = member({ lastActivityAt: AT - MEMBER_STALL_MS });
  assert.match(strip(memberRow(m, true, columns(140), 140, 0, 'claude-opus-5-5', 'api', 'busy')).trimEnd(), /멈춘 듯 3m12s$/);
  const r = strip(memberRow(m, true, columns(140), 140, 0, 'claude-opus-5-5', 'api', 'waiting')).trimEnd();
  assert.match(r, / 3m12s$/);
  assert.doesNotMatch(r, /멈춘 듯/);
});

test('Claude: 서브에이전트가 Edit 허락을 기다리는 동안(부모가 응답 대기) 기록이 멈춰도 멈춘 듯을 붙이지 않는다', async () => {
  const { render } = await import('../src/ui.mjs');
  const old = (Date.now() - 5 * 60_000) / 1000;
  const sub = () => {
    fx.transcript('wait-1', [user('고쳐'), assistant('m1', [{ type: 'tool_use', id: 'ta', name: 'Agent', input: {} }], usage(1, 1))]);
    const p = fx.subagent('wait-1', 'a', { agentType: 'Explore', description: '파일 고치기', toolUseId: 'ta' }, [assistant('s1', [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: '/a/b.mjs' } }], usage(3, 4))]);
    utimesSync(p, old, old);
  };
  const look = () => {
    const [s] = collectClaude({ showEnded: false, budget: createBudget() });
    const at = Date.now();
    const screen = render({ data: { sessions: [s], errors: [], at }, selectedId: s.id, showDetail: false, frame: 0 }, 140, 12).map(strip).find((l) => l.includes('파일 고치기'));
    return { s, screen, json: toJson({ at, sessions: [s], errors: [] }).sessions[0].members[0] };
  };
  fx.session({ sessionId: 'wait-1', status: 'busy', waitingFor: 'Edit b.mjs' });
  sub();
  let x = look();
  assert.equal(x.s.status, 'waiting');
  assert.equal(x.s.members[0].status, 'busy');
  assert.doesNotMatch(x.screen, /멈춘 듯/);
  assert.match(x.screen, / \d+s\s*$/, '경과 시간은 보인다');
  assert.equal(x.json.stalled, false);

  // 같은 상태에서 부모가 대기가 아니면 3분 기준으로 멈춘 듯이다.
  fx.session({ sessionId: 'wait-1', status: 'busy' });
  sub();
  x = look();
  assert.equal(x.s.status, 'busy');
  assert.match(x.screen, /멈춘 듯 \d+s\s*$/);
  assert.equal(x.json.stalled, true);
});
