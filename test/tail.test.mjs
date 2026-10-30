import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlTail } from '../src/tail.mjs';

test('새로 붙은 줄만 읽고, 끊긴 줄은 다음 번에 이어 읽는다', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'aitop-')), 's.jsonl');
  writeFileSync(f, '{"a":1}\n{"a":2}\n{"a"');
  const t = new JsonlTail(f);
  assert.deepEqual(t.read(), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(t.read(), []);
  appendFileSync(f, ':3}\n{"a":4}\n');
  assert.deepEqual(t.read(), [{ a: 3 }, { a: 4 }]);
});
