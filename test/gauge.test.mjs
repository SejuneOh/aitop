import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gauge, filledCells } from '../src/ui/draw.mjs';
import { glyphs } from '../src/ui/glyphs.mjs';
import { width } from '../src/text.mjs';

test('채운 칸 수: 0 보다 크면 최소 1칸, 100% 가 아니면 마지막 칸은 비운다', () => {
  assert.equal(filledCells(0, 11), 0);
  assert.equal(filledCells(0.01, 11), 1);
  assert.equal(filledCells(0.57, 11), 6);
  assert.equal(filledCells(0.99, 11), 10);
  assert.equal(filledCells(1, 11), 11);
});

test('막대는 늘 같은 폭이고 채움과 빈칸 모두 ▃ (색으로 구분)', () => {
  for (const r of [0, 0.03, 0.57, 0.85, 1]) {
    const segs = gauge(r * 1000, 1000, 11);
    assert.equal(width(segs.map((x) => x.t).join('')), 16, `${r}`);
    assert.match(segs[0].t + segs[1].t, /^▃{11}$/);
  }
  assert.equal(glyphs().bar.fill, '▃');
  assert.match(gauge(900, 1000, 11).at(-1).t, /!90%/);
  assert.equal(width(gauge(0, 0, 11)[0].t), 16, '컨텍스트 크기를 모를 때도 같은 폭');
  for (const used of [NaN, -5, 5000]) assert.equal(width(gauge(used, 1000, 11).map((x) => x.t).join('')), 16, `used=${used}`);
  assert.match(gauge(-5, 1000, 11).at(-1).t, / 0%/);
});

test('NO_COLOR 에서는 빈칸을 ▁ 로 그려 모양으로 구분한다', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const { gauge } = await import(process.argv[1]); console.log(gauge(570, 1000, 11).map((x) => x.t).join(''));", pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'ui', 'draw.mjs')).href], { env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '▃▃▃▃▃▃▁▁▁▁▁  57%');
});
