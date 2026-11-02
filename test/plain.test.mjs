import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainText } from '../src/text.mjs';
import { pushEvent } from '../src/sources/common.mjs';

test('구분선·굵은 이름표·인용 기호를 건너뛰고 내용부터 보인다', () => {
  const md = '---\n\n**Your question, rephrased:**\n> Can other users use it too?\n\n**Key corrections:**\n- Drop the space';
  assert.equal(plainText(md), 'Can other users use it too? - Drop the space');
});

test('머리·굵게·백틱·표를 평문으로 바꾼다', () => {
  assert.equal(plainText('## 결론\n**바로** `npm test` 를 실행합니다'), '결론 바로 npm test 를 실행합니다');
  assert.equal(plainText('| 항목 | 값 |\n|---|---|\n| 버전 | 0.6 |'), '항목 · 값 버전 · 0.6');
  assert.equal(plainText('```js\nconst a = 1;\n```'), 'const a = 1;');
});

test('이름에 흔한 밑줄·별표 하나는 그대로 둔다', () => {
  assert.equal(plainText('snake_case 와 *.mjs 와 a*b'), 'snake_case 와 *.mjs 와 a*b');
  assert.equal(plainText('**주의:** 실제로 확인함'), '주의: 실제로 확인함');
});

test('활동 기록에서 답변만 평문으로 바꾸고, 지시·도구 줄은 그대로 둔다', () => {
  const st = { events: [] };
  pushEvent(st, null, 'reply', '---\n**Q:**\n> 질문 **내용**');
  pushEvent(st, null, 'prompt', '**그대로** 둔다');
  assert.deepEqual(st.events.map((e) => e.text), ['질문 내용', '**그대로** 둔다']);
});
