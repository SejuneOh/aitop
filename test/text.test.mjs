import { test } from 'node:test';
import assert from 'node:assert/strict';
import { width, truncate, pad, mask, fmtTokens } from '../src/text.mjs';

test('한글은 2칸으로 센다', () => {
  assert.equal(width('abc'), 3);
  assert.equal(width('작업 중'), 7);
});

test('자르기와 채우기는 표시 폭을 지킨다', () => {
  assert.equal(width(truncate('가나다라마바사', 7)), 7);
  assert.equal(truncate('가나다라마바사', 7), '가나다…');
  assert.equal(width(pad('가나', 6)), 6);
  assert.equal(pad('12', 4, 'right'), '  12');
});

test('비밀값처럼 보이는 문자열은 가린다', () => {
  assert.equal(mask('key sk-ant-api03-abcdefghijklmnopqrst'), 'key ••••');
  assert.equal(mask('export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz12'), 'export GITHUB_TOKEN=••••');
  assert.equal(mask('password: hunter2hunter'), 'password: ••••');
  assert.equal(mask('npm test'), 'npm test');
});

test('토큰 수 축약', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(1234), '1.2k');
  assert.equal(fmtTokens(17_600_000), '17.6M');
  assert.equal(fmtTokens(2_300_000_000), '2.30B');
});
