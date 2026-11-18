// 호출 트리 (--report trace, #258): 부모 → 서브에이전트 가지, 실패·진행 중·결과 없음 노드, 같은 도구 묶기, 노드 상한, 깊이 접기,
// 비용 나누기·가지 합산, 인자·지시 글은 showArgs 일 때만(비밀값 가림), 세션 찾기(id 앞부분·이름·경로, Codex 미지원), 출력 모양(텍스트·Markdown·JSON).
process.env.TZ = 'Asia/Seoul';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeHome, usage } from './fixture.mjs';

const fx = makeClaudeHome();
const { build, findTrace, readTrace, formatTrace, traceMarkdown, traceJson, slim } = await import('../src/trace.mjs');
const { reportOption } = await import('../src/report.mjs');
const { claudeCost } = await import('../src/pricing.mjs');
const { width } = await import('../src/text.mjs');

const BIN = fileURLToPath(new URL('../bin/aitop.mjs', import.meta.url));
const T0 = Date.parse('2026-11-18T10:00:00+09:00');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const MODEL = 'claude-opus-5-5';
const U = usage(1000, 200);
const C = claudeCost(MODEL, U).total;

const prompt = (s, text) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content: text } });
const call = (s, id, tools, u = U) => ({ type: 'assistant', timestamp: at(s), message: { id, model: MODEL, usage: u, content: tools.map(([tid, name, input = {}]) => ({ type: 'tool_use', id: tid, name, input })) } });
const reply = (s, id, text = 'ok', u = U) => ({ type: 'assistant', timestamp: at(s), message: { id, model: MODEL, usage: u, content: [{ type: 'text', text }] } });
const result = (s, tid, isError = false) => ({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: tid, content: 'x', is_error: isError }] } });

const SID = '1a2b3c4d-0000-4000-8000-000000000001';
const main = [
  { type: 'custom-title', customTitle: 'fix-login' },
  prompt(0, 'fix the login bug with token=sk-ant-abcdefghijklmnopqrstuvwxyz0123'),
  call(1, 'm1', [['t1', 'Bash', { command: 'npm test', description: 'run tests' }]]),
  result(5, 't1', true),
  call(6, 'm2', [['g1', 'Grep', { pattern: 'login' }], ['g2', 'Grep', { pattern: 'auth' }]]),
  result(7, 'g1'),
  result(7, 'g2'),
  call(8, 'm3', [['g3', 'Grep', { pattern: 'x' }]]),
  result(9, 'g3'),
  call(10, 'm4', [['a1', 'Agent', { subagent_type: 'Explore', description: 'look around' }]]),
  result(40, 'a1'),
  reply(41, 'm5'),
  prompt(60, 'now deploy'),
  call(61, 'm6', [['r1', 'Read', { file_path: '/repo/secret/app.mjs' }]]),
];
const sub = [
  { type: 'user', timestamp: at(11), message: { content: 'look around' } },
  call(12, 's1', [['sr1', 'Read', { file_path: '/repo/a.mjs' }]]),
  result(13, 'sr1'),
  reply(14, 's2', 'found it'),
];
const subagents = [{ meta: { agentType: 'Explore', description: 'look around', toolUseId: 'a1' }, lines: sub }];

const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children)]);
const find = (r, pred) => flat(r.nodes).find(pred);

test('부모 → 서브에이전트 트리: 지시 아래 도구, Agent 노드 아래 서브에이전트 기록', () => {
  const r = build(main, { subagents });
  assert.equal(r.tool, 'claude');
  assert.equal(r.nodes.length, 2);
  const [p1, p2] = r.nodes;
  assert.equal(p1.kind, 'prompt');
  assert.equal(p1.n, 1);
  assert.deepEqual(p1.children.map((n) => [n.kind, n.name]), [['tool', 'Bash'], ['tool', 'Grep'], ['agent', 'Agent'], ['turn', 'reply']]);
  const agent = p1.children[2];
  assert.equal(agent.agent, 'Explore');
  assert.deepEqual(agent.children.map((n) => [n.kind, n.name]), [['tool', 'Read'], ['turn', 'reply']]);
  assert.equal(agent.start, T0 + 10_000);
  assert.equal(agent.end, T0 + 40_000);
  assert.equal(agent.status, 'done');
  assert.equal(p2.n, 2);
  assert.deepEqual(r.counts, { prompts: 2, tools: 7, agents: 1, errors: 1, running: 1 });
});

test('상태: is_error 는 실패, 마지막 지시의 결과 없는 도구는 진행 중, 앞 지시의 결과 없는 도구는 결과 없음(실패)', () => {
  const r = build(main, { subagents });
  const bash = find(r, (n) => n.name === 'Bash');
  assert.equal(bash.status, 'error');
  assert.equal(bash.end, T0 + 5000);
  const read = r.nodes[1].children[0];
  assert.equal(read.status, 'running');
  assert.equal(read.end, null);
  assert.equal(r.nodes[1].status, 'running');
  // 다음 지시가 와서 결과를 잃은 도구
  const lost = build([prompt(0, 'a'), call(1, 'x1', [['l1', 'Bash', {}]]), prompt(9, 'b'), reply(10, 'x2')]);
  const b = lost.nodes[0].children[0];
  assert.equal(b.status, 'error');
  assert.equal(b.lost, true);
  // 끝난 세션(기록이 오래 안 바뀜)이면 마지막 지시의 결과 없는 도구도 결과 없음
  const old = build(main, { subagents, ended: true }).nodes[1].children[0];
  assert.equal(old.status, 'error');
  assert.equal(old.lost, true);
  // 묶음 안 어느 하나라도 결과를 잃었으면 묶음에 표시
  const gl = build([prompt(0, 'a'), call(1, 'y1', [['y1', 'Grep', {}]]), result(2, 'y1'), call(3, 'y2', [['y2', 'Grep', {}]]), prompt(9, 'b')]);
  assert.equal(gl.nodes[0].children[0].count, 2);
  assert.equal(gl.nodes[0].children[0].lost, true);
  // 허락 대기 중인 호출은 밖에서 알려 준다
  assert.equal(build(main, { subagents, waiting: ['r1'] }).nodes[1].children[0].status, 'waiting');
});

test('묶기: 이어진 같은 도구는 한 줄(Grep ×3), 비용·토큰은 합, 묶지 않을 수도 있다', () => {
  const r = build(main, { subagents });
  const g = find(r, (n) => n.name === 'Grep');
  assert.equal(g.count, 3);
  assert.deepEqual(g.ids, ['g1', 'g2', 'g3']);
  assert.equal(g.start, T0 + 6000);
  assert.equal(g.end, T0 + 9000);
  // m2 의 비용을 Grep 둘이 반씩, m3 는 통째로
  assert.ok(Math.abs(g.cost - 2 * C) < 1e-12);
  assert.equal(g.tokens, 2400);
  const raw = build(main, { subagents, group: false });
  assert.equal(raw.nodes[0].children.filter((n) => n.name === 'Grep').length, 3);
  // 많은 연속 호출
  const many = [prompt(0, 'a'), ...Array.from({ length: 38 }, (_, i) => [call(1 + i, `q${i}`, [[`q${i}`, 'Grep', {}]]), result(1 + i, `q${i}`)]).flat()];
  const m = build(many);
  assert.equal(m.nodes[0].children.length, 1);
  assert.equal(m.nodes[0].children[0].count, 38);
});

test('비용: 도구 줄은 부른 응답의 몫, 서브에이전트 줄은 가지 합, 지시와 전체는 모두 더한 값', () => {
  const r = build(main, { subagents });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(find(r, (n) => n.name === 'Bash').cost, C);
  const agent = find(r, (n) => n.kind === 'agent');
  // Agent 를 부른 응답 m4 + 서브에이전트 응답 s1, s2
  near(agent.cost, 3 * C);
  assert.equal(agent.tokens, 3 * 1200);
  // 지시 1: m1..m5 와 서브에이전트 둘 = 7 응답
  near(r.nodes[0].cost, 7 * C);
  near(r.cost, 8 * C);
  assert.equal(r.tokens, 8 * 1200);
  assert.equal(r.unpriced, false);
  // 같은 message.id 가 여러 줄이면 한 번만 센다
  const dup = build([prompt(0, 'a'), reply(1, 'd1'), reply(2, 'd1')]);
  near(dup.cost, C);
  // message.id 가 없는 응답의 usage 는 세지 않는다 (tracker 와 같은 규칙). 도구 줄은 남는다
  const noId = build([prompt(0, 'a'), { type: 'assistant', timestamp: at(1), message: { model: MODEL, usage: U, content: [{ type: 'text', text: 'a' }] } }, { type: 'assistant', timestamp: at(1), message: { model: MODEL, usage: U, content: [{ type: 'tool_use', id: 'n1', name: 'Read', input: {} }] } }]);
  assert.equal(noId.tokens, 0);
  assert.equal(noId.cost, 0);
  assert.equal(noId.nodes[0].children.find((n) => n.name === 'Read').tokens, 0);
  // 가격표에 없는 모델
  const odd = build([prompt(0, 'a'), { type: 'assistant', timestamp: at(1), message: { id: 'o1', model: 'mystery-1', usage: U, content: [] } }]);
  assert.equal(odd.unpriced, true);
  assert.equal(odd.cost, 0);
});

test('상한: 넘치면 오래된 지시부터 빼고 수를 남긴다, 지시 하나가 넘치면 앞쪽 단계를 뺀다', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(prompt(i * 10, `p${i}`), reply(i * 10 + 1, `r${i}`));
  const r = build(rows, { maxNodes: 6 });
  assert.equal(r.omitted, 7);
  assert.deepEqual(r.nodes.map((n) => n.n), [8, 9, 10].map((n) => n));
  // 지시 하나에 단계가 많을 때 (도구 이름이 달라 묶이지 않는다)
  const one = [prompt(0, 'a'), ...Array.from({ length: 10 }, (_, i) => call(1 + i, `c${i}`, [[`c${i}`, `T${i}`, {}]]))];
  const o = build(one, { maxNodes: 4 });
  assert.equal(o.omitted, 0);
  assert.equal(o.nodes[0].omitted, 7);
  assert.deepEqual(o.nodes[0].children.map((n) => n.name), ['T7', 'T8', 'T9']);
  assert.match(formatTrace(o, { id: 'x', name: 'n' }), /앞 7개 생략/);
  // 서브에이전트 안이 넘쳐도 전체 노드 수는 상한 안 (Read·Grep 번갈아 1000번이라 묶이지 않는다)
  const deep = [];
  for (let i = 0; i < 1000; i++) deep.push(call(2 + i, `d${i}`, [[`d${i}`, i % 2 ? 'Read' : 'Grep', {}]]), result(2 + i, `d${i}`));
  const big = build([prompt(0, 'go'), call(1, 'ma', [['ag', 'Agent', {}]]), result(9999, 'ag')], { subagents: [{ meta: { toolUseId: 'ag' }, lines: deep }], maxNodes: 50 });
  const all = flat(big.nodes);
  assert.equal(all.length, 50);
  const ag = all.find((n) => n.kind === 'agent');
  assert.equal(ag.omitted, 1000 - 48);
  assert.equal(ag.children.at(-1).id, 'd999');
  assert.match(formatTrace(big, { id: 'x', name: 'n' }), /\n   ├─ 앞 952개 생략\n/);
  // 비용은 뺀 단계까지 포함한 가지 합 그대로
  assert.ok(Math.abs(ag.cost - 1001 * C) < 1e-9);
});

test('깊이 접기: 기본 깊이보다 깊은 가지는 자식을 숨기고 수만 남긴다', () => {
  const r = build(main, { subagents, depth: 1 });
  const agent = find(r, (n) => n.kind === 'agent');
  assert.equal(agent.children.length, 0);
  assert.equal(agent.folded, 2);
  // 비용은 접어도 가지 합 그대로
  assert.ok(Math.abs(agent.cost - 3 * C) < 1e-9);
  assert.match(formatTrace(r, { id: SID, name: 'fix-login' }), /\(\+2 접힘\)/);
  assert.equal(find(build(main, { subagents }), (n) => n.kind === 'agent').children.length, 2);
});

test('인자·지시 글은 showArgs 일 때만, 넣어도 비밀값을 가린다', () => {
  const off = build(main, { subagents });
  for (const n of flat(off.nodes)) {
    assert.equal(n.detail, undefined, n.name);
    assert.equal(n.text, undefined, n.name);
  }
  const txt = formatTrace(off, { id: SID, name: 'fix-login' });
  assert.doesNotMatch(txt, /npm test|login bug|secret|look around/);
  assert.doesNotMatch(JSON.stringify(traceJson(off, '0', {})), /npm test|login bug|look around/);
  const on = build(main, { subagents, showArgs: true });
  assert.equal(find(on, (n) => n.name === 'Bash').detail, 'npm test');
  assert.equal(find(on, (n) => n.kind === 'agent').detail, 'look around');
  assert.match(on.nodes[0].text, /fix the login bug/);
  assert.doesNotMatch(on.nodes[0].text, /sk-ant-abcdefghij/);
  assert.match(formatTrace(on, { id: SID, name: 'fix-login' }), /npm test/);
  // 지시 글·설명도 도구 인자와 같은 maskStrict 로 가리고 길이를 자른다
  const pw = build([prompt(0, `deploy with password=hunter2hunter2 ${'y'.repeat(900)}`), call(1, 'z1', [['z1', 'Agent', { description: 'use api_key=abcd1234abcd1234' }]])], { showArgs: true });
  assert.doesNotMatch(pw.nodes[0].text, /hunter2/);
  assert.ok(pw.nodes[0].text.length <= 500);
  assert.doesNotMatch(pw.nodes[0].children[0].detail, /abcd1234/);
});

test('slim: 결과 본문·응답 글은 버리고, 인자는 showArgs 일 때만 남긴다', () => {
  const big = { type: 'user', timestamp: at(1), toolUseResult: { stdout: 'z'.repeat(1e5) }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'z'.repeat(1e5) }] } };
  assert.deepEqual(slim(big), { type: 'user', timestamp: at(1), message: { id: undefined, model: undefined, usage: undefined, content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } });
  const a = slim(call(1, 'm1', [['t1', 'Bash', { command: 'rm -rf x' }], ['a1', 'Agent', { subagent_type: 'Explore', description: 'd', prompt: 'long' }]]));
  assert.deepEqual(a.message.content.map((c) => c.input), [undefined, { subagent_type: 'Explore' }]);
  assert.equal(slim(call(1, 'm1', [['t1', 'Bash', { command: 'ls' }]]), true).message.content[0].input.command, 'ls');
  assert.deepEqual(slim(reply(1, 'm9', 'a long answer')).message.content, []);
  // slim 한 줄로 만든 트리는 원래 줄로 만든 것과 같다
  assert.deepEqual(build(main.map((x) => slim(x)), { subagents }), build(main, { subagents }));
});

test('텍스트: 80열 안, 트리 기호, 묶음 수, 상태 기호, 비용 칸', () => {
  const txt = formatTrace(build(main, { subagents }), { id: SID, name: 'fix-login' });
  const lines = txt.split('\n');
  assert.match(lines[0], /호출 트리 · fix-login · 1a2b3c4d/);
  assert.match(lines[1], /지시 2 · 도구 호출 7 \(서브에이전트 1\)/);
  for (const l of lines.slice(0, lines.length - 1)) if (!/비용은 API/.test(l)) assert.ok(width(l) <= 80, l);
  assert.match(txt, /├─ ✗ Bash/);
  assert.match(txt, /Grep ×3/);
  assert.match(txt, /Agent Explore/);
  assert.match(txt, /│  ├─ ✓ Read/);
  assert.match(txt, /● Read/);
  assert.match(txt, /진행 중/);
  assert.match(txt, /\$0\.\d\d/);
});

test('Markdown 은 코드 블록 트리, JSON 은 영어 키·ISO 시각·중첩 children', () => {
  const r = build(main, { subagents });
  const md = traceMarkdown(r, { id: SID, name: 'fix-login' });
  assert.match(md, /^\*\*호출 트리 · fix-login · 1a2b3c4d\*\*/);
  assert.match(md, /```text\n[\s\S]*Grep ×3[\s\S]*```/);
  const j = traceJson(r, '9.9.9', { id: SID, name: 'fix-login' });
  assert.equal(j.report, 'trace');
  assert.equal(j.version, '9.9.9');
  assert.deepEqual(j.session, { id: SID, name: 'fix-login' });
  assert.equal(j.basis, 'api');
  assert.equal(j.nodes.length, 2);
  const p = j.nodes[0];
  assert.deepEqual(Object.keys(p).slice(0, 9), ['id', 'kind', 'name', 'start', 'end', 'status', 'tokens', 'cost', 'children']);
  assert.equal(p.name, '#1');
  assert.equal(p.start, at(0));
  const agent = p.children.find((n) => n.kind === 'agent');
  assert.equal(agent.agent, 'Explore');
  assert.equal(agent.children[0].name, 'Read');
  const grep = p.children.find((n) => n.name === 'Grep');
  assert.equal(grep.count, 3);
  assert.equal(grep.errors, 0);
  assert.equal(j.nodes[1].children[0].end, null);
  assert.equal(j.nodes[1].children[0].status, 'running');
});

test('세션 찾기와 읽기: id 앞부분·이름·파일 경로, 여럿이면 후보, Codex 는 도구만 알려 준다', async () => {
  const path = fx.transcript(SID, main);
  fx.subagent(SID, 'ag1', subagents[0].meta, sub);
  fx.transcript('1a2b9999-0000-4000-8000-000000000002', [prompt(0, 'other')]);
  const codexRoot = resolve(fx.home, '..', 'codex', 'sessions');
  const day = join(codexRoot, '2026', '11', '18');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-2026-11-18T10-00-00-77777777-0000-4000-8000-000000000003.jsonl'), '');
  const roots = { claudeRoots: [join(fx.home, 'projects')], codexRoots: [codexRoot], agyRoot: join(fx.home, 'agy-none') };
  const a = await findTrace('1a2b3c', roots);
  assert.equal(a.tool, 'claude');
  assert.equal(normalize(a.path), normalize(path));
  assert.equal(a.name, 'fix-login');
  const many = await findTrace('1a2b', roots);
  assert.equal(many.error, 'many');
  assert.equal(many.candidates.length, 2);
  assert.equal((await findTrace('FIX-LOGIN', roots)).id, SID);
  // 이름이 똑같은 세션은 id 앞부분보다 먼저
  const named = fx.transcript('bead0000-0000-4000-8000-000000000004', [{ type: 'custom-title', customTitle: '1a2b' }, prompt(0, 'x')]);
  assert.equal(normalize((await findTrace('1a2b', roots)).path), normalize(named));
  assert.equal((await findTrace('1a2b9', roots)).id, '1a2b9999-0000-4000-8000-000000000002');
  assert.equal((await findTrace('nothing-like-this', roots)).error, 'none');
  assert.equal((await findTrace(path, roots)).id, SID);
  assert.equal((await findTrace('7777', roots)).tool, 'codex');
  const got = await readTrace(path);
  assert.equal(got.lines.length, main.length);
  assert.equal(got.subagents.length, 1);
  assert.equal(got.subagents[0].meta.toolUseId, 'a1');
  assert.equal(find(build(got.lines, { subagents: got.subagents }), (n) => n.kind === 'agent').children.length, 2);
});

test('옵션: trace 는 세션 하나와 --md·--show-prompts 를 받고, 세션이 없거나 sessions 옵션이면 오류', () => {
  const r = reportOption(['--report', 'trace', 'abc', '--md', '--show-prompts', '--json']);
  assert.equal(r.error, null);
  assert.equal(r.kind, 'trace');
  assert.equal(r.session, 'abc');
  assert.equal(r.md, true);
  assert.equal(r.prompts, true);
  assert.deepEqual(r.rest, ['--json']);
  assert.equal(reportOption(['--json', '--report=trace', 'fix-login']).session, 'fix-login');
  assert.match(reportOption(['--report', 'trace']).error, /세션/);
  assert.match(reportOption(['--report', 'trace', 'x', '--since', '7d']).error, /--since 는 --report trace 와 함께 쓸 수 없다/);
  assert.match(reportOption(['--report', 'trace', 'x', '--days', '3']).error, /--days/);
  assert.match(reportOption(['--report', 'daily', '--md']).error, /--md 는 --report sessions/);
});

test('CLI: aitop --report trace 는 텍스트·JSON 을 내고, 모르는 세션은 1, Codex 는 미지원으로 1', () => {
  const env = { ...process.env, AITOP_LANG: 'ko', NO_COLOR: '1' };
  const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { env, encoding: 'utf8' });
  const txt = run('--report', 'trace', '1a2b3c4d');
  assert.equal(txt.status, 0, txt.stderr);
  assert.match(txt.stdout, /호출 트리 · fix-login/);
  assert.doesNotMatch(txt.stdout, /\x1b\[/);
  const j = run('--report', 'trace', '1a2b3c4d', '--json');
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).report, 'trace');
  const none = run('--report', 'trace', 'zzzz-nothing');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /찾지 못했습니다/);
  const cx = spawnSync(process.execPath, [BIN, '--report', 'trace', '77777777'], { env: { ...env, CODEX_HOME: resolve(fx.home, '..', 'codex') }, encoding: 'utf8' });
  assert.equal(cx.status, 1);
  assert.match(cx.stderr, /Codex 세션은 아직 호출 트리를/);
  assert.equal(run('--report', 'trace', '1a2b3c4d', '--md', '--json').status, 2);
});
