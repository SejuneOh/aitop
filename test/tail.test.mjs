import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlTail, createBudget } from '../src/tail.mjs';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'aitop-')), 's.jsonl');
const readAll = (t, budget) => {
  const out = [];
  t.read((x) => out.push(x), budget);
  return out;
};

test('새로 붙은 줄만 읽고, 끊긴 줄은 다음 번에 이어 읽는다', () => {
  const f = tmpFile();
  writeFileSync(f, '{"a":1}\n{"a":2}\n{"a"');
  const t = new JsonlTail(f);
  assert.deepEqual(readAll(t), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(readAll(t), []);
  appendFileSync(f, ':3}\n{"a":4}\n');
  assert.deepEqual(readAll(t), [{ a: 3 }, { a: 4 }]);
  assert.equal(t.lineOffset, t.offset);
});

test('읽기 한도를 넘으면 멈췄다가 다음 번에 이어 읽는다', () => {
  const f = tmpFile();
  const line = JSON.stringify({ text: '가'.repeat(400_000) }) + '\n';
  writeFileSync(f, line.repeat(3));
  const t = new JsonlTail(f);
  const first = readAll(t, createBudget(1));
  assert.ok(first.length < 3);
  assert.ok(!t.done);
  const rest = readAll(t);
  assert.equal(first.length + rest.length, 3);
  assert.ok(t.done);
  assert.ok([...first, ...rest].every((x) => x.text.length === 400_000));
});

test('여러 청크에 걸친 아주 긴 줄도 정확히 읽는다', () => {
  const f = tmpFile();
  const long = 'a'.repeat(5 * 1024 * 1024 + 7);
  writeFileSync(f, JSON.stringify({ long }) + '\n' + JSON.stringify({ b: 1 }) + '\n');
  const t = new JsonlTail(f);
  const out = readAll(t);
  assert.equal(out.length, 2);
  assert.equal(out[0].long.length, long.length);
  assert.equal(t.lineOffset, t.offset);
});

test('청크 경계에서 한글이 잘려도 깨지지 않는다', () => {
  const f = tmpFile();
  const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ i, text: '한글'.repeat(300_000 + i) })).join('\n') + '\n';
  writeFileSync(f, lines);
  const out = readAll(new JsonlTail(f));
  assert.equal(out.length, 5);
  out.forEach((x, i) => assert.equal(x.text, '한글'.repeat(300_000 + i)));
});
