// e2e 테스트용 가짜 Claude 세션. 지시 하나, 응답 하나, 파일 편집 두 번이 있는 살아 있는 세션을 만든다.
// 세션 pid 는 이 테스트 프로세스라서, 테스트가 도는 동안 aitop 이 실행 중인 세션으로 본다.
import { makeClaudeHome, assistant, user, usage } from '../fixture.mjs';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../../bin/aitop.mjs', import.meta.url));

// 이 PC 에서 실제로 돌고 있는 agy 의 기록을 읽지 않게 한다 (기록 폴더가 없으면 agy 를 보지 않는다).
process.env.AITOP_AGY_HOME = '/nonexistent/aitop-e2e-agy';
export const SESSION_ID = 'e2e00000-1';

export function makeSession() {
  const fx = makeClaudeHome();
  const now = Date.now();
  const ts = (sec) => new Date(now - 60_000 + sec * 1000).toISOString();
  const edit = (filePath, sec, lines) => ({ ...user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]), timestamp: ts(sec), toolUseResult: { filePath, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines }] } });
  fx.session({ sessionId: SESSION_ID, name: 'e2e 세션', status: 'idle', cwd: '/work/demo' });
  fx.transcript(SESSION_ID, [
    { ...user('footer 정리해줘'), timestamp: ts(0) },
    { ...assistant('m1', [{ type: 'text', text: '정리하겠습니다' }], usage(1200, 300)), timestamp: ts(1) },
    edit('/work/demo/src/app.mjs', 2, [' ctx', '-old', '+new', '+more']),
    edit('/work/demo/src/footer.mjs', 3, ['-a', '+b']),
  ]);
  return fx;
}
