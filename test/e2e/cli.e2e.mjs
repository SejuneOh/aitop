// 실제 bin/aitop.mjs 를 새 프로세스로 실행해 --json, --once, --help 결과를 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { BIN, SESSION_ID, makeSession } from './session.mjs';

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

test('--help 는 키 안내를 보이고 0 으로 끝난다', () => {
  assert.match(run('--help'), /키: .*f 변경 파일.*Esc 뒤로.*q 나가기/);
});
