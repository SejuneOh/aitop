// 상태 기호가 세트(기본·AITOP_AMBIGUOUS=wide)마다 서로 겹치지 않는지 (#263).
// 색이 없거나(NO_COLOR) 색약 팔레트에서는 기호 모양이 상태를 가르는 유일한 단서다.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { glyphSets, glyphs, legendMark, STATUS_KEYS } from '../src/ui/glyphs.mjs';
import { glyph, glyphMoves, SPIN } from '../src/ui/draw.mjs';
import { legend } from '../src/ui/chrome.mjs';
import { setAmbiguous } from '../src/text.mjs';

afterEach(() => setAmbiguous('narrow'));

for (const [name, G] of Object.entries(glyphSets())) {
  test(`${name}: 상태 기호·선택·고정이 서로 다르고 접힘 + - 나 스피너와도 겹치지 않는다`, () => {
    const marks = STATUS_KEYS.map((k) => G[k]);
    assert.ok(marks.every(Boolean), `${name}: 빠진 기호`);
    assert.equal(new Set(marks).size, marks.length, `${name}: ${STATUS_KEYS.map((k) => `${k}=${G[k]}`).join(' ')}`);
    for (const m of [...marks, G.waitingBlink]) {
      assert.ok(!['+', '-'].includes(m), `${name}: ${m} 은 접힘 표시와 겹친다`);
      assert.ok(!SPIN.includes(m), `${name}: ${m} 은 스피너와 겹친다`);
    }
    // 깜빡일 때 모양도 다른 상태와 겹치면 안 된다.
    const others = STATUS_KEYS.filter((k) => k !== 'waiting').map((k) => G[k]);
    assert.ok(!others.includes(G.waitingBlink), `${name}: 응답 대기 깜빡임 ${G.waitingBlink}`);
  });
}

const S = (status, kind, extra = {}) => ({ tool: 'claude', status, phase: { kind }, ...extra });
const ROWS = [S('waiting', 'waiting'), S('idle', 'unseen'), S('live', 'idle', { tool: 'gemini' }), S('idle', 'idle'), S('idle', 'stopped'), S('idle', 'done'), S('ended', 'ended')];

test('표의 상태 칸은 응답 대기·확인 전·실행 중·대기·멈춤·완료·종료를 모든 프레임에서 서로 다른 기호로 그린다', () => {
  for (const mode of ['narrow', 'wide']) {
    setAmbiguous(mode);
    for (let frame = 0; frame < 8; frame++) {
      const got = ROWS.map((s) => glyph(s, frame).t);
      assert.equal(new Set(got).size, got.length, `${mode} frame ${frame}: ${got.join(' ')}`);
    }
  }
  setAmbiguous('wide');
  assert.equal(glyphMoves(S('waiting', 'waiting')), false, 'SAFE 응답 대기는 깜빡이지 않아 다시 그릴 필요가 없다');
  assert.equal(glyphMoves(S('busy', 'tool')), true, '스피너는 그대로 돈다');
  setAmbiguous('narrow');
  assert.equal(glyphMoves(S('waiting', 'waiting')), true, '기본 세트는 깜빡인다');
  setAmbiguous('wide');
  assert.equal(glyph(S('waiting', 'waiting'), 0).t, '?');
  assert.equal(glyph(S('idle', 'stopped'), 0).t, '!');
  assert.equal(glyph(S('idle', 'unseen'), 0).t, '*');
  assert.equal(glyph(S('live', 'idle', { tool: 'gemini' }), 0).t, '@');
});

test('범례의 상태 기호도 지금 세트를 따르고 서로 겹치지 않는다', () => {
  for (const mode of ['narrow', 'wide']) {
    setAmbiguous(mode);
    const L = legend();
    // 첫 묶음(상태 기호): 제목 다음부터 빈 줄 전까지. 스피너는 뺀다.
    const marks = L.slice(1, L.findIndex(([k]) => k === ''))
      .filter(([k]) => !SPIN.includes(k))
      .map(([k]) => legendMark(k));
    assert.equal(new Set(marks).size, marks.length, `${mode}: ${marks.join(' ')}`);
    for (const k of ['waiting', 'unseen', 'live', 'idle', 'stopped', 'ended', 'pin']) assert.ok(marks.includes(glyphs()[k]), `${mode}: ${k} 이 범례에 없다 (${marks.join(' ')})`);
  }
});
