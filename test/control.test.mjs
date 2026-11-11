import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';
import { oneLine } from '../src/text.mjs';

test('기록에서 온 제어문자는 화면에 나가지 않는다', () => {
  const evil = 'x\x1b]0;title\x07\x1b[2J\x9b31m‮y';
  assert.equal(oneLine(evil), 'x]0;title[2J31my');
  const s = { tool: 'claude', id: 's1', name: evil, cwd: '/w/' + evil, branch: evil, status: 'busy', live: true, phase: { kind: 'tool', args: { what: evil } }, updatedAt: Date.now(), tokens: { total: 1 }, context: {}, members: [], events: [{ at: Date.now(), kind: 'tool', text: evil }] };
  const raw = render({ data: { sessions: [s], usage: null, errors: [], at: Date.now() }, selectedId: 's1', showDetail: true, frame: 0 }, 120, 30).join('\n');
  // 화면 색을 입히는 SGR(ESC [ ... m) 말고는 제어문자가 나가면 안 된다.
  assert.doesNotMatch(raw.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x09\x0b-\x1f\x7f-\x9f‮]/);
});
