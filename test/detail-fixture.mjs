// 상세 패널 테스트용 고정 세션. 시각은 UTC 로 고정해 어느 PC 에서나 같은 글자가 나온다.
process.env.TZ = 'UTC';

export const at = Date.parse('2026-10-30T05:00:00Z');
const min = (m) => at - m * 60_000;

const hunk = (m) => ({ at: min(m), oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;'] });
const file = (path, m, extra = {}) => ({ path, edits: 2, add: 2, del: 1, at: min(m), hunks: [hunk(m)], log: [{ at: min(m), add: 2, del: 1 }], ...extra });

export const ROOT = '/home/dev/Document/dev/playground/aitop';

export const session = () => ({
  tool: 'claude',
  id: 'fix',
  name: 'aitop',
  cwd: ROOT,
  branch: 'feat/87-narrow-detail',
  model: 'claude-opus-5-5',
  kind: 'background',
  pid: 218093,
  status: 'busy',
  live: true,
  phase: { kind: 'tool', text: '도구 실행 · Bash' },
  startedAt: min(185),
  updatedAt: at,
  tokens: { total: 571_234, main: 520_000, sub: 51_234, subCount: 2, input: 90_312, output: 18_405, cacheRead: 440_117, cacheWrite: 22_400 },
  cost: 0.1734,
  costNoCache: 0.0912,
  context: { used: 52_000, window: 1_000_000 },
  members: [],
  turns: [{ n: 1, at: min(30), text: '좁은 화면에서 상세 패널을 한 칸으로 정리해 줘' }],
  files: [
    file(`${ROOT}/src/ui/detail.mjs`, 5),
    file(`${ROOT}/test/detail-narrow.test.mjs`, 4, { created: true }),
    file(`${ROOT}/src/ui/draw.mjs`, 3),
  ],
  events: [
    { at: min(9), kind: 'prompt', text: '좁은 화면에서 상세 패널을 한 칸으로 정리해 줘' },
    { at: min(8), kind: 'tool', text: 'Read src/ui/detail.mjs' },
    { at: min(7), kind: 'reply', text: '왼쪽 칸을 위쪽 요약 두 줄로 접고 최근 활동에 전체 폭을 주는 방향으로 진행합니다. 넓은 화면 배치는 그대로 둡니다.' },
    { at: min(6), kind: 'tool', text: '$ COLUMNS=80 LINES=30 NO_COLOR=1 node bin/aitop.mjs --once | sed -n 14,40p' },
    { at: min(5), kind: 'tool', text: 'Edit src/ui/detail.mjs' },
    { at: min(4), kind: 'tool', text: 'Write test/detail-narrow.test.mjs' },
    { at: min(3), kind: 'tool', text: '$ node --test test/detail-narrow.test.mjs test/panel.test.mjs test/table.test.mjs' },
    { at: min(2), kind: 'reply', text: '테스트가 모두 통과했습니다. 80칸에서 활동 줄이 예전보다 훨씬 길게 보입니다.' },
    { at: min(1), kind: 'tool', text: 'Edit src/ui/draw.mjs' },
  ],
});
