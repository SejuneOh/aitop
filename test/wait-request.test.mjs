import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, session } from './detail-fixture.mjs';
import { makeClaudeHome, assistant, user, usage } from './fixture.mjs';
import { width, mask, maskStrict, stripControl } from '../src/text.mjs';
import { setNow } from '../src/ui/draw.mjs';
import { detail, wrapText, REQUEST_LINES } from '../src/ui/detail.mjs';
import { toolDetail, DETAIL_MAX } from '../src/sources/common.mjs';
import { toJson } from '../src/json.mjs';
import { phaseText } from '../src/i18n.mjs';

const fx = makeClaudeHome();
const { collectClaude } = await import('../src/sources/claude.mjs');
const { createBudget } = await import('../src/tail.mjs');

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const CMD = 'git -C /home/dev/Document/dev/playground/aitop log --oneline --decorate -n 20 origin/dev..HEAD && npm test -- --test-name-pattern=waiting';
const waiting = (extra = {}) => ({ ...session(), status: 'waiting', phase: { kind: 'waiting', args: { what: 'approve Bash' } }, waitDetail: CMD, ...extra });
const draw = (s, W, H = 16) => {
  setNow(at);
  return detail(s, W, H, 0, { tab: 'now', showRequests: true }).map(strip);
};
// 화면에서 테두리·칸 나눔을 걷어 내고 요청 구획 줄만 이어 붙인다.
const requestText = (lines) => {
  const i = lines.findIndex((l) => l.includes('── 요청'));
  assert.ok(i > 0, '요청 구획이 있다');
  // 넓은 화면은 │ 왼쪽 │ 오른쪽 │, 좁은 화면은 │ 한 칸 │ 이다. 요청은 마지막 칸에 있다.
  const cellOf = (l) => l.split('│').at(-2).replace(/^ /, '');
  const out = [];
  for (const l of lines.slice(i + 1)) {
    const cell = cellOf(l);
    if (cell.startsWith('──')) break;
    out.push(cell.slice(1));
  }
  return out;
};

test('Bash 요청은 설명이 아니라 실제 명령을 남긴다', () => {
  assert.equal(toolDetail('Bash', { description: 'Show recent commits', command: 'git log -n 5' }), 'git log -n 5');
  assert.equal(toolDetail('exec_command', { cmd: ['bash', '-lc', 'ls'] }), 'bash -lc ls');
  assert.equal(toolDetail('Edit', { file_path: '/home/dev/a/b/c.mjs', old_string: 'x', new_string: 'y' }), '/home/dev/a/b/c.mjs');
  assert.equal(toolDetail('WebFetch', { url: 'https://example.com/a', prompt: 'p' }), '{"url":"https://example.com/a","prompt":"p"}');
});

test('요청 내용은 비밀값을 가리고 ANSI·제어문자를 지우고 길이를 자른다', () => {
  const d = toolDetail('Bash', { command: 'echo \x1b[31mred\x1b[0m\x07 && curl -H "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123" x' });
  assert.ok(!d.includes('\x1b') && !d.includes('[31m') && !d.includes('\x07'), d);
  assert.ok(d.startsWith('echo red && curl'), d);
  assert.ok(!d.includes('sk-ant-abcdefghijklmnopqrstuvwxyz0123'), d);
  assert.match(d, /••••/);
  const long = toolDetail('Bash', { command: 'x'.repeat(DETAIL_MAX * 3) });
  assert.equal(long.length, DETAIL_MAX);
  assert.ok(long.endsWith('…'));
});

test('Claude 세션이 허락을 기다리면 waitDetail 에 실제 명령이 실린다', () => {
  fx.session({ sessionId: 'rqrqrqrq-1', pid: process.pid, status: 'waiting', waitingFor: 'approve Bash' });
  fx.transcript('rqrqrqrq-1', [user('커밋 보여줘'), assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'Show commits', command: CMD } }], usage(1, 1))]);
  const s = collectClaude({ showEnded: false, budget: createBudget() }).find((x) => x.id === 'rqrqrqrq-1');
  assert.equal(phaseText(s.phase), '응답 대기 · approve Bash');
  assert.equal(s.waitDetail, CMD);
  assert.equal(toJson({ sessions: [s] }, null, { showRequests: true }).sessions[0].waitDetail, CMD);
});

test('응답 대기가 아니면 waitDetail 은 없다', () => {
  fx.session({ sessionId: 'rqrqrqrq-2', pid: process.pid, status: 'busy' });
  fx.transcript('rqrqrqrq-2', [user('실행'), assistant('m2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }], usage(1, 1))]);
  const s = collectClaude({ showEnded: false, budget: createBudget() }).find((x) => x.id === 'rqrqrqrq-2');
  assert.equal(s.waitDetail, null);
});

test('상세 패널은 80·120·160칸과 좁은 화면에서 명령 전체를 보인다', () => {
  for (const W of [60, 80, 99, 120, 160]) {
    const lines = draw(waiting(), W);
    assert.equal(lines.length, 16);
    for (const l of lines) assert.ok(width(l) <= W, `W=${W}: ${l}`);
    const req = requestText(lines);
    assert.ok(req.length <= REQUEST_LINES, `W=${W}`);
    // 줄 끝에서 끊긴 띄어쓰기는 테두리 여백과 구분되지 않으므로 공백을 빼고 비교한다.
    assert.equal(req.join('').replace(/\s+/g, ''), CMD.replace(/\s+/g, ''), `W=${W}`);
    assert.ok(lines.some((l) => l.includes('◆') || l.includes('응답 대기 · approve Bash')), `W=${W} 상태 줄`);
    assert.ok(lines.some((l) => l.includes('최근 활동') || l.includes('변경 파일')), `W=${W} 아래 구획이 남는다`);
  }
});

test('요청이 6줄을 넘으면 … 로 끝난다', () => {
  const lines = requestText(draw(waiting({ waitDetail: 'y'.repeat(2000) }), 80));
  assert.equal(lines.length, REQUEST_LINES);
  assert.ok(lines.at(-1).trimEnd().endsWith('…'));
});

test('응답 대기가 아니거나 요청 내용이 없으면 요청 구획이 없다', () => {
  assert.ok(!draw(waiting({ waitDetail: null }), 120).some((l) => l.includes('── 요청')));
  assert.ok(!draw({ ...session(), waitDetail: CMD }, 120).some((l) => l.includes('── 요청')));
});

test('--show-requests 를 켜지 않으면 요청 구획도 --json waitDetail 도 없다', () => {
  for (const W of [80, 120, 160]) {
    setNow(at);
    const lines = detail(waiting(), W, 16, 0, { tab: 'now' }).map(strip);
    assert.ok(!lines.some((l) => l.includes('── 요청') || l.includes('rsync') || l.includes('origin/dev..HEAD')), `W=${W}`);
  }
  const out = toJson({ sessions: [waiting()] });
  assert.ok(!('waitDetail' in out.sessions[0]));
  assert.deepEqual(Object.keys(out.sessions[0]), Object.keys(toJson({ sessions: [session()] }).sessions[0]), '모양이 그대로다');
});

test('maskStrict: key 가 든 이름, 배열 속 비밀 이름 다음 칸, \\" 붙은 JSON 을 가린다', () => {
  for (const [x, want] of [
    ['export OPENAI_KEY=Zq9secretvalue', 'export OPENAI_KEY=••••'],
    ['MY_KEY=Zq9secretvalue npm start', 'MY_KEY=•••• npm start'],
    ['export STRIPE_KEY=rk_live_Zq9secretvalue123456', 'export STRIPE_KEY=••••'],
    ['curl -H "X-Custom-Key: Zq9secret" x', 'curl -H "X-Custom-Key: ••••" x'],
  ])
    assert.equal(maskStrict(x), want, x);
  const escaped = toolDetail('Bash', { command: 'curl -d "{\\"password\\":\\"Zq9secret\\"}" x' });
  assert.ok(!escaped.includes('Zq9secret'), escaped);
  assert.equal(toolDetail('mcp__x', { headers: { 'X-Custom-Key': 'Zq9 secret' } }), '{"headers":{"X-Custom-Key":"••••"}}');
  assert.equal(toolDetail('mcp__x', { args: ['--token', 'Zq9secret', '--verbose'] }), '{"args":["--token","••••","--verbose"]}');
  assert.equal(toolDetail('mcp__x', { headers: ['Authorization', 'Zq9 secret', 'Accept', 'json'] }), '{"headers":["Authorization","••••","Accept","json"]}');
});

test('wrapText 는 줄바꿈을 지키고 넓은 글자를 폭에 맞춰 끊는다', () => {
  assert.deepEqual(wrapText('ab\ncdef', 3), ['ab', 'cde', 'f']);
  assert.deepEqual(wrapText('가나다', 4), ['가나', '다']);
});

test('maskStrict: 명령 속 비밀값을 가린다', () => {
  const cases = [
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI aws s3 ls', 'AWS_SECRET_ACCESS_KEY=•••• aws s3 ls'],
    ['MY_PASS=hunter2hunter curl x', 'MY_PASS=•••• curl x'],
    ['curl -H "Authorization: Bearer abcDEF123456789" x', 'curl -H "Authorization: Bearer ••••" x'],
    ['Authorization: Bearer abc', 'Authorization: Bearer ••••'],
    ['curl -H "Authorization: Basic dXNlcjpwYXNz" x', 'curl -H "Authorization: Basic ••••" x'],
    ['curl -H "X-Api-Key: abcd1234efgh" https://x', 'curl -H "X-Api-Key: ••••" https://x'],
    ['curl -H "Cookie: session=abcdef0123456789; b=2" x', 'curl -H "Cookie: ••••" x'],
    ['Set-Cookie: sid=abc123; Path=/', 'Set-Cookie: ••••'],
    ['clone https://user:hunter2pass@host/r', 'clone https://user:••••@host/r'],
    ['open https://u:pa ss@h/x', 'open https://u:••••@h/x'],
    ['curl "https://api.x.com/v1?api_key=abcdef123456&x=1"', 'curl "https://api.x.com/v1?api_key=••••&x=1"'],
    ['curl "https://api.x.com/v1?key=AIzaSyabcdefghijklmnop"', 'curl "https://api.x.com/v1?key=••••"'],
    ['curl -u admin:SuperSecret1 https://x', 'curl -u admin:•••• https://x'],
    ['curl --user admin:SuperSecret1 https://x', 'curl --user admin:•••• https://x'],
    ['mysql -pS3cret db', 'mysql -p•••• db'],
    ['mytool --password hunter2xx', 'mytool --password ••••'],
    ['mytool --password=hunter2xx', 'mytool --password=••••'],
    ['mytool --token abcdefghij12345', 'mytool --token ••••'],
    ['mytool --api-key "abc def"', 'mytool --api-key ••••'],
    ['mytool --secret s3cr3t', 'mytool --secret ••••'],
    ['sshpass -p hunter2xx ssh host', 'sshpass -p •••• ssh host'],
    ['redis-cli -a mypassword123', 'redis-cli -a ••••'],
    ['aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG', 'aws configure set aws_secret_access_key ••••'],
    ['PASSWORD="hunter2 x"', 'PASSWORD=••••'],
    ["PASSWORD='quoted pass'", 'PASSWORD=••••'],
    ['token = "abc def ghi"', 'token = ••••'],
    ['echo "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\nxyz\n-----END RSA PRIVATE KEY----- done"', 'echo "•••• done"'],
    ['key: -----BEGIN OPENSSH PRIVATE KEY-----\nabc', 'key: ••••'],
  ];
  for (const [x, want] of cases) assert.equal(maskStrict(x), want, x);
});

test('maskStrict: 비밀값이 아닌 비슷한 글자는 그대로 둔다', () => {
  for (const x of ['ls -p /tmp', 'mysql -P3306 -u root -p db', 'git log --author=sejune', 'authored by sejune', 'Basic usage of the command', 'Bearer of bad news', 'token budget exceeded', 'echo $GITHUB_TOKEN', 'https://example.com:8080/a', 'Read /home/u/tokens/auth.json', 'cat ~/.ssh/id_rsa', 'npm test'])
    assert.equal(maskStrict(x), x);
});

test('요청 내용(toolDetail)은 비밀 이름 아래 값을 통째로 가린다', () => {
  const cases = [
    [{ api_key: 'abcdef123456', token: 'zzzzzzzzzz' }, '{"api_key":"••••","token":"••••"}'],
    [{ headers: { 'X-Api-Key': 'abc def' }, url: 'https://x' }, '{"headers":{"X-Api-Key":"••••"},"url":"https://x"}'],
    [{ config: { db: { password: 'p w' } } }, '{"config":{"db":{"password":"••••"}}}'],
    [{ creds: ['hunter2 x', 'y'] }, '{"creds":"••••"}'],
    [{ secret: { value: 'abc 123 xyz' } }, '{"secret":"••••"}'],
    [{ pin: 12345678 }, '{"pin":"••••"}'],
    [{ env: [{ name: 'API_KEY', value: 'abc def ghi' }, { name: 'HOME', value: '/home/u' }] }, '{"env":[{"name":"API_KEY","value":"••••"},{"name":"HOME","value":"/home/u"}]}'],
    [{ Authorization: 'Bearer abcdefghijkl' }, '{"Authorization":"••••"}'],
    [{ cookie: 'sid=abcdef12345 x' }, '{"cookie":"••••"}'],
    [{ url: 'https://x?token=abcdef12' }, '{"url":"https://x?token=••••"}'],
  ];
  for (const [input, want] of cases) assert.equal(toolDetail('mcp__x__call', input), want, JSON.stringify(input));
  let deep = { password: 'deepsecretvalue' };
  for (let i = 0; i < 40; i++) deep = { a: deep };
  assert.ok(!toolDetail('mcp__x__call', deep).includes('deepsecretvalue'), '아주 깊은 곳도 가린다');
  assert.equal(toolDetail('Bash', { command: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI aws s3 ls' }), 'AWS_SECRET_ACCESS_KEY=•••• aws s3 ls');
});

test('화면 다른 곳의 mask() 는 #98 이전과 같다 (요청 구획만 엄격하게 가린다)', () => {
  const same = ['  auth: { user, pass },', 'const tokenCount = tokens.length;', 'headers: { Authorization: `Bearer ${token}` }', '"oauth_callback": "/cb"', 'authorization=required', 'oauth: enabled', '--auth-type basic', 'pwd: /home/u', 'echo pwd=$(pwd)', 'tokenizer: cl100k', 'npm run auth:test', 'max_tokens=4096', 'MY_PASS="hunter2 x"'];
  for (const x of same) assert.equal(mask(x), x);
  assert.equal(mask('PASSWORD="hunter2 x"'), 'PASSWORD="•••• x"');
  assert.equal(mask('password: hunter2hunter'), 'password: ••••');
});

test('비밀값 가림은 긴 입력에서도 빠르다', () => {
  const N = 200_000;
  const inputs = ['token'.repeat(N / 5), 'x.'.repeat(N / 2), ('mysql ' + ' x'.repeat(100) + ' ').repeat(N / 200), 'a://b:'.repeat(N / 6), 'password='.repeat(N / 9), ('a'.repeat(60) + 'tokentoken' + 'a'.repeat(60) + '"').repeat(N / 130), 'token' + ' '.repeat(N) + 'x', 'cookie: '.repeat(N / 8), '-----BEGIN RSA PRIVATE KEY-----'.repeat(N / 31), '--password '.repeat(N / 11)];
  const t = performance.now();
  for (const s of inputs) {
    mask(s);
    maskStrict(s);
  }
  const ms = Math.round(performance.now() - t);
  assert.ok(ms < 3000, `${ms}ms`);
});


test('폭이 0인 글자와 방향 바꾸기 문자를 지운다', () => {
  assert.equal(stripControl('r​m‌ ‍-⁠r﻿f ‮x⁦y⁩'), 'rm -rf xy');
});

test('여러 도구가 열려 있으면 대기 문구에 나온 도구의 요청을 고른다', () => {
  fx.session({ sessionId: 'rqrqrqrq-3', pid: process.pid, status: 'waiting', waitingFor: 'approve Bash' });
  fx.transcript('rqrqrqrq-3', [
    user('둘 다'),
    assistant(
      'm3',
      [
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rm -rf build' } },
        { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/a.txt' } },
      ],
      usage(1, 1),
    ),
  ]);
  const s = collectClaude({ showEnded: false, budget: createBudget() }).find((x) => x.id === 'rqrqrqrq-3');
  assert.equal(s.waitDetail, 'rm -rf build');
});
