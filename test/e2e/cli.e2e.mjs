// 실제 bin/aitop.mjs 를 새 프로세스로 실행해 --json, --once, --help 결과를 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { BIN, SESSION_ID, makeSession } from './session.mjs';
import { assistant, user, usage } from '../fixture.mjs';

makeSession();
const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { env: process.env, encoding: 'utf8', timeout: 20_000 });

test('--json 은 세션·토큰·변경 파일 통계를 JSON 으로 낸다', () => {
  const data = JSON.parse(run('--json'));
  const s = data.sessions.find((x) => x.id === SESSION_ID);
  assert.ok(s, '가짜 세션이 보인다');
  assert.equal(s.name, 'e2e 세션');
  assert.equal(s.live, true);
  assert.equal(s.tokens.total, 1500);
  assert.deepEqual(s.files.map((f) => [f.path, f.edits]).sort(), [['/work/demo/src/app.mjs', 1], ['/work/demo/src/footer.mjs', 1]]);
  assert.ok(!('hunks' in s.files[0]), '변경 내용은 넣지 않는다');
});

test('--once 는 세션 표와 변경 파일·최근 활동 구획을 한 번 그린다', () => {
  const out = run('--once').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /e2e 세션/);
  assert.match(out, /── 변경 파일 /);
  assert.match(out, /src\/app\.mjs/);
  assert.match(out, /── 최근 활동 /);
  assert.match(out, /footer 정리해줘/);
});

test('NO_COLOR 이면 색 없이 키를 [q] 처럼 괄호로 보인다', () => {
  const out = execFileSync(process.execPath, [BIN, '--once'], { env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8', timeout: 20_000 });
  assert.doesNotMatch(out, /\x1b\[/, '색 코드가 없다');
  assert.match(out, /\[\?\] 도움\s+\[q\] 나가기/);
});

// 응답 대기 중인 세션의 요청 전체는 --show-requests (또는 AITOP_SHOW_REQUESTS=1) 를 켰을 때만 밖으로 나간다.
test('요청 전체 보기는 기본으로 꺼져 있고 --show-requests 로 켠다', () => {
  const fx = makeSession();
  const id = 'e2ewait0-1';
  const cmd = 'rsync -av ./dist/ deploy@host:/srv/app/';
  fx.session({ sessionId: id, pid: process.pid, name: '대기 세션', status: 'waiting', waitingFor: 'approve Bash', cwd: '/work/demo' });
  fx.transcript(id, [user('배포해줘'), assistant('w1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { description: 'Deploy', command: cmd } }], usage(10, 5))]);

  const off = JSON.parse(run('--json'));
  assert.ok(off.sessions.every((s) => !('waitDetail' in s)), '기본 --json 에는 waitDetail 이 없다');
  assert.ok(off.sessions.find((s) => s.id === id), '대기 세션은 보인다');
  assert.doesNotMatch(run('--once'), /── 요청/, '기본 화면에는 요청 구획이 없다');

  const on = JSON.parse(run('--json', '--show-requests'));
  assert.equal(on.sessions.find((s) => s.id === id).waitDetail, cmd);
  const env = JSON.parse(execFileSync(process.execPath, [BIN, '--json'], { env: { ...process.env, AITOP_SHOW_REQUESTS: '1' }, encoding: 'utf8', timeout: 20_000 }));
  assert.equal(env.sessions.find((s) => s.id === id).waitDetail, cmd);
  assert.match(run('--once', '--show-requests').replace(/\x1b\[[0-9;]*m/g, ''), /── 요청[\s\S]*rsync -av/);
});

test('--help 는 키 안내를 보이고 0 으로 끝난다', () => {
  assert.match(run('--help'), /키: .*s 정렬 · g 묶기.*f 변경 파일.*Esc 뒤로.*q 나가기/);
});
