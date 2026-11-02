import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';
import { width } from '../src/text.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const view = (extra) => ({ data: { sessions: [], errors: [], at: Date.now(), usage: null }, selectedId: null, showDetail: true, frame: 0, ...extra });

test('도움말은 단축키·상태 기호·열 설명을 보이고 하단에 ? 안내가 있다', () => {
  const lines = render(view({ help: true }), 120, 40).map(strip);
  const all = lines.join('\n');
  for (const word of ['검색', '다음 볼 세션', '응답 대기', '완료 · 확인 전', 'IDLE', 'CONTEXT']) assert.ok(all.includes(word), word);
  assert.match(lines.at(-1), /\?\s+도움/);
});

test('작은 화면에서도 도움말이 화면 크기를 넘지 않는다', () => {
  for (const [W, H] of [[80, 12], [120, 24], [60, 8]]) {
    const lines = render(view({ help: true }), W, H);
    assert.equal(lines.length, H, `${W}x${H} 줄 수`);
    assert.ok(lines.every((l) => width(strip(l)) <= W), `${W}x${H} 폭`);
  }
});
