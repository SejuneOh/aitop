import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';
import { width } from '../src/text.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const at = Date.parse('2026-10-30T05:00:00Z');
const hunk = (agent, newStart, lines) => ({ at, agent, oldStart: newStart, oldLines: 1, newStart, newLines: lines.length, lines, cut: 0 });

function session(files) {
  return { tool: 'claude', id: 's1', name: 'demo', cwd: '/work/demo', status: 'busy', live: true, phase: { kind: 'tool', text: '도구 실행 · Edit' }, updatedAt: Date.now(), tokens: { total: 10 }, context: {}, members: [], events: [{ at, kind: 'tool', text: 'Edit ui.mjs' }], files };
}
const view = (s, extra = {}) => ({ data: { sessions: [s], usage: null, errors: [], at: Date.now() }, selectedId: s.id, showDetail: true, frame: 0, focus: null, ...extra });

const files = Array.from({ length: 9 }, (_, i) => ({ path: `/work/demo/src/deep/folder/file${i}.mjs`, created: i === 0, edits: i + 1, add: 10 * i, del: i, at: at - i * 60_000, hidden: false, dropped: 0, hunks: [hunk('메인', 5, [' ctx', '-old', '+new'])], agents: ['메인'] }));

test('고친 파일이 없으면 오른쪽 칸은 최근 활동만 보인다', () => {
  const out = render(view(session([])), 120, 30).map(strip).join('\n');
  assert.match(out, /── 최근 활동 ─/);
  assert.doesNotMatch(out, /변경 파일/);
});

test('고친 파일이 있으면 위쪽에 목록, 아래쪽에 최근 활동을 보이고 넘치면 외 N개', () => {
  const lines = render(view(session(files)), 120, 22).map(strip);
  const all = lines.join('\n');
  // 두 구획은 라벨 가로줄로 나뉘고, 변경 파일 가로줄 끝에 git diff 가 아님을 알리는 '편집 기록' 이 붙는다.
  assert.match(all, /── 변경 파일 ─+ 편집 기록 · Bash 제외 · 9개 · f ─/);
  assert.match(all, /‹이번 지시›  전체/);
  assert.match(all, /src\/deep\/folder\/file0\.mjs\s+편집 ×1   새 파일   \d\d:\d\d/);
  assert.match(all, /src\/deep\/folder\/file1\.mjs\s+편집 ×2   \d\d:\d\d/);
  // +N -M 은 기준 대비 순변경으로 읽히므로 누적 줄 수에는 쓰지 않는다.
  assert.doesNotMatch(all, /[+-]\d+ [+-]\d+/);
  assert.match(all, /\+\d+개 더/);
  const fileLine = lines.findIndex((l) => l.includes('── 변경 파일'));
  const actLine = lines.findIndex((l) => l.includes('── 최근 활동'));
  assert.ok(actLine > fileLine);
  assert.match(lines.at(-1), /f\s+파일/);
});

test('목록과 diff 는 어느 화면 크기에서도 패널을 넘지 않는다', () => {
  const longLine = '+' + '가'.repeat(150);
  const fs = files.map((f) => ({ ...f, hunks: [hunk('general-purpose', 1, Array.from({ length: 60 }, (_, i) => (i % 3 ? longLine : ' ctx\tx')))] }));
  for (const [W, H] of [[80, 20], [100, 24], [140, 40], [60, 18]]) {
    for (const extra of [{}, { focus: 'files', filePath: fs[7].path }, { focus: 'diff', filePath: fs[2].path, diffScroll: 999 }]) {
      const v = view(session(fs), extra);
      const lines = render(v, W, H);
      assert.equal(lines.length, H, `${W}x${H} ${extra.focus}`);
      assert.ok(lines.every((l) => width(strip(l)) <= W), `${W}x${H} ${extra.focus} 폭`);
      if (extra.focus === 'diff') assert.ok(v.diffScroll < 60, '스크롤은 내용 끝에서 멈춘다');
    }
  }
});

test('목록에서 고른 파일은 표시되고, 아래쪽 파일을 고르면 그 파일이 보이게 내려간다', () => {
  const lines = render(view(session(files), { focus: 'files', filePath: files[8].path }), 120, 30).map(strip);
  // 목록에 들어가면 구획 왼쪽에 ▌, 고른 행에 ▸. 색이 없어도 글자로 구분된다.
  assert.ok(lines.some((l) => /▌▸ src\/deep\/folder\/file8\.mjs/.test(l)));
  assert.ok(lines.some((l) => /▌── 변경 파일 ─+ 편집 기록 · Bash 제외 · 9개 ─/.test(l)));
  assert.match(lines.at(-1), /파일 선택.*diff 보기.*세션으로/);
});

test('diff 는 오른쪽 칸 전체에 시각 · 누가 · 위치 머리와 함께 보인다', () => {
  const f = { ...files[1], hunks: [hunk('general-purpose', 40, ['-a', '+b']), hunk('메인', 5, [' ctx', '-old', '+new'])] };
  const lines = render(view(session([files[0], f]), { focus: 'diff', filePath: f.path }), 120, 30).map(strip);
  const all = lines.join('\n');
  assert.match(all, /── ‹ (src|…)\/deep\/folder\/file1\.mjs · 편집 ×2 · 쓴 줄 10 · 지운 줄 1 ─+ 2\/2 ─/);
  assert.match(all, /\d\d:\d\d:\d\d · general-purpose · @@ -40,1 \+40,2 @@/);
  assert.match(all, /\s+5 \sctx/);
  assert.match(all, /\s+6 \+new/);
  assert.doesNotMatch(all, /최근 활동/);
  assert.match(lines.at(-1), /스크롤.*이전·다음 파일.*파일 목록으로/);
});

test('비밀 파일은 diff 대신 안내를 보이고, 제어문자는 화면에 나가지 않는다', () => {
  const secret = { ...files[0], path: '/work/demo/.env', hidden: true, hunks: [] };
  const hidden = render(view(session([secret]), { focus: 'diff', filePath: secret.path }), 120, 30).map(strip).join('\n');
  assert.match(hidden, /변경 내용을 숨겼습니다/);

  const evil = { ...files[0], path: '/work/demo/a\x1b[31m.mjs', hunks: [hunk('메인', 1, ['+ok\x1b]0;title\x07\x1b[2J'])] };
  const s = { ...session([evil]), name: 'x\x1b[2Jy' };
  for (const extra of [{}, { focus: 'diff', filePath: evil.path }]) {
    const raw = render(view(s, extra), 120, 30).join('\n');
    // 화면 색을 입히는 SGR(ESC [ ... m) 말고는 ESC 가 나가면 안 된다.
    assert.doesNotMatch(raw.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x09\x0b-\x1f\x7f]/);
  }
});
