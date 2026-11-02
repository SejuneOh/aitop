// 화면 그리기: 상단 요약 바 → 세션 표(팀원 트리 포함) → 선택한 세션 상세 → 단축키 바.
import { homedir } from 'node:os';
import { relative, isAbsolute } from 'node:path';
import { width, truncate, truncateLeft, pad, fmtTokens, fmtAgo, stripControl } from './text.mjs';
import { turnTabs, currentTab, filesForTab } from './turns.mjs';
import { describe } from './doctor.mjs';

const NO_COLOR = Boolean(process.env.NO_COLOR);

export const PALETTE = {
  text: '#e6e8ee',
  muted: '#8a90a2',
  faint: '#4b5060',
  line: '#2b2f3a',
  rowSel: '#1d2433',
  // 변경 파일 목록의 배경 띠(bar) 위에서도 보이는 선택 행 배경
  rowFocus: '#2a3550',
  rowWaiting: '#2e2610',
  bar: '#141821',
  brand: '#7dd3fc',
  busy: '#4ade80',
  waiting: '#fbbf24',
  tool: '#38bdf8',
  team: '#f0abfc',
  idle: '#8a90a2',
  ended: '#4b5060',
  alert: '#f87171',
  money: '#fcd34d',
  addBg: '#10261a',
  delBg: '#2c1517',
  tools: { claude: '#e8865f', codex: '#5eead4', gemini: '#8ab4f8' },
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(';');

export function style({ fg, bg, bold, dim, italic } = {}) {
  if (NO_COLOR) return '';
  let s = '\x1b[0m';
  if (bold) s += '\x1b[1m';
  if (dim) s += '\x1b[2m';
  if (italic) s += '\x1b[3m';
  if (fg) s += `\x1b[38;2;${hex(fg)}m`;
  if (bg) s += `\x1b[48;2;${hex(bg)}m`;
  return s;
}
const RESET = NO_COLOR ? '' : '\x1b[0m';

// segs: [{ t: 텍스트, ...style }]. 폭 W 에 맞춰 자르고, 남는 칸은 bg 로 채운다.
// 화면에 나가는 글자는 모두 여기를 지나므로, 기록에서 온 제어문자도 여기서 한 번 더 지운다.
function line(segs, W, bg) {
  let out = '';
  let used = 0;
  for (const seg of segs) {
    if (used >= W) break;
    const t = truncate(stripControl(seg.t ?? ''), W - used);
    out += style({ bg, ...seg }) + t;
    used += width(t);
  }
  return out + style({ bg }) + ' '.repeat(Math.max(0, W - used)) + RESET;
}

// 조각들의 화면 폭 합계.
const segsWidth = (segs) => segs.reduce((a, x) => a + width(x.t ?? ''), 0);

function clip(segs, max) {
  const out = [];
  let used = 0;
  for (const s of segs) {
    if (used >= max) break;
    const t = truncate(s.t, max - used);
    out.push({ ...s, t });
    used += width(t);
  }
  return out;
}

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const PHASE_COLOR = { tool: PALETTE.tool, team: PALETTE.team, think: PALETTE.busy, write: PALETTE.busy, waiting: PALETTE.waiting, idle: PALETTE.idle, ended: PALETTE.ended, done: PALETTE.faint, unseen: PALETTE.busy };

function glyph(s, frame) {
  const k = s.phase?.kind;
  if (s.status === 'waiting') return { t: frame % 8 < 5 ? '◆' : '◇', fg: PALETTE.waiting, bold: true };
  if (k === 'ended') return { t: '·', fg: PALETTE.ended };
  if (k === 'done') return { t: '✓', fg: PALETTE.faint };
  if (k === 'unseen') return { t: '●', fg: PALETTE.busy, bold: true };
  if (k === 'idle') return s.status === 'live' ? { t: '●', fg: PALETTE.tools[s.tool] } : { t: '○', fg: PALETTE.idle };
  return { t: SPIN[frame % SPIN.length], fg: PHASE_COLOR[k] ?? PALETTE.busy, bold: true };
}

// 막대 끝은 1/8 칸 단위로 그려 작은 변화도 보이게 한다.
const EIGHTHS = '▏▎▍▌▋▊▉';

function gauge(used, total, cells) {
  if (!total) return [{ t: '─'.repeat(cells) + '     ', fg: PALETTE.faint }];
  const r = Math.min(1, used / total);
  const exact = r * cells;
  let full = Math.floor(exact);
  let part = Math.round((exact - full) * 8);
  if (part === 8) {
    full++;
    part = 0;
  }
  const tip = part && full < cells ? EIGHTHS[part - 1] : '';
  const color = r >= 0.85 ? PALETTE.alert : r >= 0.6 ? PALETTE.waiting : PALETTE.busy;
  return [
    { t: '━'.repeat(full) + tip, fg: color },
    { t: '─'.repeat(cells - full - (tip ? 1 : 0)), fg: PALETTE.faint },
    { t: pad(`${Math.round(r * 100)}%`, 5, 'right'), fg: r >= 0.85 ? PALETTE.alert : PALETTE.muted },
  ];
}

// 검색어가 세션 이름·폴더·모델 중 하나에 들어 있으면 남긴다 (대소문자 무시).
export function filterSessions(sessions, query) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => [s.name, s.project, s.cwd, s.model, s.tool].some((v) => String(v ?? '').toLowerCase().includes(q)));
}

const dollars = (usd) => (usd >= 1000 ? `$${Math.round(usd).toLocaleString('en-US')}` : usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`);
// 비용을 모르는 도구는 '-'. 가격표에 없는 모델이 섞이면 아는 몫 뒤에 '?' 를 붙이고, 아는 몫이 없으면 '?' 만 보인다.
export function money(usd, unknown = false) {
  if (usd == null) return '-';
  if (unknown) return usd > 0 ? `${dollars(usd)}?` : '?';
  return dollars(usd);
}
const tilde = (p) => (p ?? '').replace(homedir(), '~');
const two = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

// 한 행 = 표시(1) + 상태 기호(2) + 각 열 + 열 뒤 공백 1칸. CONTEXT 는 게이지 11 + 퍼센트 5.
const shortModel = (m) => (m ? m.replace(/^claude-/, '') : '-');

function columns(W) {
  const showProject = W >= 110;
  const showCost = W >= 96;
  const showModel = W >= 104;
  const fixed = { mark: 1, glyph: 2, tool: 7, model: showModel ? 10 : 0, tokens: 7, cost: showCost ? 8 : 0, ctx: 16, age: 4 };
  const gaps = 5 + (showProject ? 1 : 0) + (showCost ? 1 : 0) + (showModel ? 1 : 0);
  const flex = W - Object.values(fixed).reduce((a, b) => a + b, 0) - gaps - 1;
  const name = Math.max(14, Math.min(32, Math.floor(flex * 0.36)));
  const project = showProject ? Math.max(10, Math.min(22, Math.floor(flex * 0.22))) : 0;
  const status = Math.max(12, flex - name - project);
  return { ...fixed, name, project, status, showProject, showCost, showModel };
}

function header(view, W) {
  const { sessions } = view.data;
  const live = sessions.filter((s) => s.live);
  const count = (pred) => live.filter(pred).length;
  const working = count((s) => ['busy', 'shell'].includes(s.status));
  const waiting = count((s) => s.status === 'waiting');
  const unseen = count((s) => s.unseen);
  const idle = count((s) => (s.status === 'idle' || s.status === 'live') && !s.unseen);
  const B = PALETTE.bar;
  // 0 인 상태는 흐리게 둔다. 좁으면 이름을 줄인다.
  const stat = (glyph, n, long, short, color, bold, narrow) => [
    { t: `  ${glyph} `, fg: n ? color : PALETTE.faint, bg: B },
    { t: `${n} ${narrow ? short : long}`, fg: n ? (bold ? color : PALETTE.text) : PALETTE.faint, bg: B, bold: bold && n > 0 },
  ];
  const leftOf = (narrow) => [
    { t: ' ◆ aitop ', fg: '#0b0e14', bg: PALETTE.brand, bold: true },
    { t: '  ', bg: B },
    { t: `${live.length} live`, fg: PALETTE.text, bg: B, bold: true },
    ...stat('⠿', working, '작업 중', '작업', PALETTE.busy, false, narrow),
    ...stat('◆', waiting, '응답 대기', '응답', PALETTE.waiting, true, narrow),
    ...stat('●', unseen, '확인 전', '확인', PALETTE.busy, true, narrow),
    ...stat('○', idle, '대기', '대기', PALETTE.idle, false, narrow),
  ];
  // 오른쪽: 오늘 $52 132M · 7일 $644 1.2B · 12:42:05. 폭이 모자라면 토큰 수, 7일, 오늘 순으로 뺀다.
  const u = view.data.usage;
  const dot = { t: ' · ', fg: PALETTE.faint, bg: B };
  const period = (label, p, tok) => [
    { t: `${label} `, fg: PALETTE.muted, bg: B },
    { t: money(p.cost, p.unknown), fg: PALETTE.money, bg: B, bold: true },
    ...(tok ? [{ t: ` ${fmtTokens(p.tokens)}`, fg: PALETTE.faint, bg: B }] : []),
  ];
  const week = (tok) => (u.loading != null ? [{ t: `7일 집계 중 ${Math.floor(u.loading * 100)}%`, fg: PALETTE.faint, bg: B }] : period('7일', u.week, tok));
  // 장부를 못 읽었으면 화면에 있는 세션(모든 도구)의 누적 토큰이라도 보인다.
  const fallback = [{ t: `Σ ${fmtTokens(sessions.reduce((a, s) => a + (s.tokens?.total ?? 0), 0))} tok`, fg: PALETTE.muted, bg: B }];
  const clockSeg = { t: clock(view.data.at), fg: PALETTE.muted, bg: B };
  const rights = u
    ? [
        [...period('오늘', u.today, true), dot, ...week(true), dot, clockSeg],
        [...period('오늘', u.today, false), dot, ...week(false), dot, clockSeg],
        [...period('오늘', u.today, false), dot, clockSeg],
        [clockSeg],
      ]
    : [[...fallback, dot, clockSeg], [clockSeg]];
  // 사용량 숫자가 상태 이름보다 중요하므로, 이름을 먼저 줄이고 그래도 모자라면 오른쪽을 줄인다.
  for (const r of rights) {
    for (const narrow of [false, true]) {
      const left = leftOf(narrow);
      const right = [...r, { t: ' ', bg: B }];
      if (segsWidth(left) + segsWidth(right) + 2 <= W) return line([...left, { t: ' '.repeat(W - segsWidth(left) - segsWidth(right)), bg: B }, ...right], W, B);
    }
  }
  return line(leftOf(true), W, B);
}

function toolStrip(view, W) {
  const segs = [{ t: ' ' }];
  for (const tool of ['claude', 'codex', 'gemini']) {
    const list = view.data.sessions.filter((s) => s.tool === tool);
    const live = list.filter((s) => s.live).length;
    const tok = list.reduce((a, s) => a + (s.tokens?.total ?? 0), 0);
    // 세션이 없는 도구는 이름만 흐리게 둔다.
    if (!live) {
      // 종료 세션을 함께 볼 때는 그 도구의 누적 토큰을 흐리게 남긴다. 기록 폴더가 없으면 미설치로 보인다.
      const missing = view.data.tools?.tools?.[tool]?.state === 'missing';
      segs.push({ t: ` ${tool}`, fg: PALETTE.faint }, ...(missing ? [{ t: ' 미설치', fg: PALETTE.faint, italic: true }] : view.showEnded && list.length ? [{ t: ` · ${fmtTokens(tok)}`, fg: PALETTE.faint }] : []), { t: '     ' });
      continue;
    }
    segs.push({ t: '▍', fg: PALETTE.tools[tool] }, { t: tool, fg: PALETTE.tools[tool], bold: true }, { t: ` ${live}`, fg: PALETTE.text }, { t: ` · ${fmtTokens(tok)}`, fg: PALETTE.muted }, { t: '     ' });
  }
  if (view.showEnded) segs.push({ t: '종료된 세션 포함 (24시간)', fg: PALETTE.waiting, italic: true });
  return line(segs, W);
}

function tableHeader(c, W) {
  const h = (t, n, align) => ({ t: pad(t, n, align) + ' ', fg: PALETTE.faint });
  const segs = [{ t: ' '.repeat(c.mark + c.glyph) }, h('TOOL', c.tool)];
  if (c.showModel) segs.push(h('MODEL', c.model));
  segs.push(h('SESSION', c.name));
  if (c.showProject) segs.push(h('PROJECT', c.project));
  segs.push(h('STATUS', c.status), h('TOKENS', c.tokens, 'right'));
  if (c.showCost) segs.push(h('COST', c.cost, 'right'));
  segs.push(h('CONTEXT', c.ctx), h('IDLE', c.age, 'right'));
  return line(segs, W);
}

// 표에서는 세션 이름과 상태가 먼저 보이도록 나머지 열은 흐리게 둔다.
// hot: 화면에서 비용이 가장 큰 세션들. 그 비용만 돈 색으로 칠한다.
function sessionRow(s, c, W, selected, frame, hot) {
  const waiting = s.status === 'waiting';
  const bg = selected ? PALETTE.rowFocus : waiting ? PALETTE.rowWaiting : undefined;
  // IDLE: 마지막 활동 후 지난 시간. 지금 일하고 있는 세션은 'now'.
  const working = s.status === 'busy' || s.status === 'shell';
  const idle = working ? 'now' : fmtAgo(NOW - (s.updatedAt ?? 0));
  const ended = s.status === 'ended';
  const tc = PALETTE.tools[s.tool];
  const g = glyph(s, frame);
  // 다음 지시를 기다리는 세션은 상태 글자만 흐리게 한다.
  const pc = s.phase?.kind === 'idle' ? PALETTE.faint : PHASE_COLOR[s.phase?.kind] ?? PALETTE.muted;
  const segs = [
    { t: selected ? '▌' : ' ', fg: PALETTE.brand, bold: true },
    { ...g, t: g.t + ' ' },
    { t: pad(s.tool, c.tool) + ' ', fg: ended ? PALETTE.ended : tc, bold: !ended },
  ];
  if (c.showModel) segs.push({ t: pad(shortModel(s.model), c.model) + ' ', fg: ended ? PALETTE.ended : PALETTE.muted });
  segs.push({ t: pad(s.name ?? '', c.name) + ' ', fg: ended ? PALETTE.ended : PALETTE.text, bold: selected });
  if (c.showProject) segs.push({ t: pad(s.project ?? '', c.project) + ' ', fg: PALETTE.muted });
  segs.push(
    { t: pad(s.phase?.text ?? '', c.status) + ' ', fg: pc, bold: s.status === 'waiting' },
    { t: pad(s.lazy ? '' : fmtTokens(s.tokens?.total ?? 0), c.tokens, 'right') + ' ', fg: ended ? PALETTE.ended : PALETTE.muted },
  );
  if (c.showCost) segs.push({ t: pad(s.lazy ? '' : money(s.cost, s.costUnknown), c.cost, 'right') + ' ', fg: s.cost == null || ended ? PALETTE.faint : hot?.has(s.id) ? PALETTE.money : PALETTE.muted, bold: Boolean(hot?.has(s.id)) });
  segs.push(...gauge(s.context?.used ?? 0, s.context?.window ?? 0, 11), { t: ' ' }, { t: pad(idle, c.age, 'right'), fg: waiting ? PALETTE.waiting : PALETTE.faint });
  return line(segs, W, bg);
}

// 메인 세션 아래에 붙는 팀원(서브에이전트) 행. 끝나면 잠깐 "완료"로 보였다가 사라진다.
function memberRow(m, last, c, W, frame) {
  const done = m.status === 'done';
  const g = done ? { t: '✓', fg: PALETTE.faint } : { t: SPIN[(frame + 3) % SPIN.length], fg: PALETTE.team, bold: true };
  const branch = last ? '└─ ' : '├─ ';
  const segs = [
    { t: ' '.repeat(c.mark + c.glyph) },
    { t: pad('  ' + branch, c.tool) + ' ', fg: PALETTE.line },
  ];
  // 같은 타입의 팀원이 여럿이어도 구분되도록, 하는 일(description)을 앞에 두고 타입은 흐리게 붙인다.
  const nameW = c.name - 2;
  const suffix = m.task ? ` · ${m.name}` : '';
  const label = truncate(m.task || m.name, suffix ? nameW - 6 : nameW);
  const showSuffix = suffix && nameW - width(label) >= 6;
  const started = m.started !== false;
  if (c.showModel) segs.push({ t: pad(started ? shortModel(m.model) : '', c.model) + ' ', fg: PALETTE.faint });
  segs.push(
    { ...g, t: g.t + ' ' },
    { t: label, fg: done ? PALETTE.faint : PALETTE.team },
    { t: pad(showSuffix ? suffix : '', nameW - width(label)) + ' ', fg: PALETTE.faint },
  );
  if (c.showProject) segs.push({ t: ' '.repeat(c.project + 1) });
  segs.push(
    { t: pad(m.phase?.text ?? '', c.status) + ' ', fg: done ? PALETTE.faint : PHASE_COLOR[m.phase?.kind] ?? PALETTE.muted },
    { t: pad(started ? fmtTokens(m.tokens ?? 0) : '', c.tokens, 'right') + ' ', fg: PALETTE.faint },
  );
  if (c.showCost) segs.push({ t: pad(started ? money(m.cost, m.costUnknown) : '', c.cost, 'right') + ' ', fg: PALETTE.faint });
  return line(segs, W);
}
let NOW = Date.now();

// segs 를 폭 n 에 맞춰 자르고 남는 칸을 공백으로 채운다. bg 를 주면 칸 끝까지 그 배경을 깐다.
function fill(segs, n, bg) {
  const c = clip(segs, n);
  const out = [...c, { t: ' '.repeat(Math.max(0, n - c.reduce((a, x) => a + width(x.t), 0))) }];
  return bg ? out.map((x) => ({ bg, ...x })) : out;
}

// 상자 테두리. 포커스가 있으면 강조색으로, 색이 없으면 굵은 선으로 구분한다.
const EDGE = {
  normal: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
};

// title: 조각 배열 또는 문자열.
function box(title, W, H, leftLines, rightLines, leftW, accent, focused = false) {
  const e = focused && NO_COLOR ? EDGE.heavy : EDGE.normal;
  const fg = focused ? PALETTE.brand : PALETTE.line;
  const out = [];
  const titleSegs = typeof title === 'string' ? [{ t: title, fg: accent, bold: true }] : title;
  const titleW = segsWidth(titleSegs) + 2;
  out.push(line([{ t: e.tl + e.h, fg }, { t: ' ' }, ...titleSegs, { t: ' ' }, { t: e.h.repeat(Math.max(0, W - 3 - titleW)) + e.tr, fg }], W));
  // '│ ' + 왼쪽 + ' │ ' + 오른쪽 + ' │' = W
  const rightW = W - leftW - 7;
  for (let i = 0; i < H - 2; i++) {
    out.push(line([{ t: `${e.v} `, fg }, ...fill(leftLines[i] ?? [], leftW), { t: ` ${e.v} `, fg }, ...fill(rightLines[i] ?? [], rightW), { t: ` ${e.v}`, fg }], W));
  }
  out.push(line([{ t: e.bl + e.h.repeat(W - 2) + e.br, fg }], W));
  return out;
}

const hhmm = (ms) => clock(ms).slice(0, 5);

// 세션 폴더 기준 상대 경로. 폴더 밖이면 ~ 로 줄인다.
function relPath(cwd, p) {
  if (cwd && isAbsolute(p)) {
    const r = relative(cwd, p);
    if (r && !r.startsWith('..') && !isAbsolute(r)) return r;
  }
  return tilde(p);
}

// ── 라벨 ───────── 메타 ─. 오른쪽 칸의 구획(변경 파일·최근 활동·diff)을 나누는 가로줄.
// 폭이 모자라면 메타부터 뺀다.
function rule(label, meta, w, color = PALETTE.line) {
  const head = [{ t: '── ', fg: color }, ...label];
  const headW = head.reduce((a, x) => a + width(x.t), 0);
  const tail = meta && headW + width(meta) + 4 <= w ? [{ t: ` ${meta} `, fg: PALETTE.faint }, { t: '─', fg: color }] : [];
  const used = [...head, ...tail].reduce((a, x) => a + width(x.t), 0);
  return [...head, { t: ' ' + '─'.repeat(Math.max(0, w - used - 1)), fg: color }, ...tail];
}


// 오른쪽 칸 여백: 구획 안 내용은 1칸 들여 쓰고, 배경 띠 안은 좌우 2칸, 항목 사이 3칸.
const INDENT = { t: ' ' };
const BAND_PAD = 2;
const BAND_LEFT = { t: ' '.repeat(BAND_PAD) };
const GAP = '   ';
// 오른쪽 칸 안쪽 줄 수가 이만큼이면 빈 줄 여백을 둔다 (목록·diff 공통).
const ROOMY = 16;

// ▸ src/ui.mjs   편집 ×3   새 파일   14:02. 파일 이름은 진하게, 폴더는 흐리게.
// 줄 수는 편집마다 더한 값이라 git diff 처럼 읽히지 않게 목록에는 넣지 않는다. 좁으면 시각, 새 파일 표시 순으로 뺀다.
function fileRow(f, cwd, w, selected) {
  const tail = [{ t: `${GAP}편집 ×${f.edits}`, fg: PALETTE.muted }, ...(f.created ? [{ t: `${GAP}새 파일`, fg: PALETTE.brand }] : []), { t: `${GAP}${hhmm(f.at)}`, fg: PALETTE.faint }];
  const tailW = () => tail.reduce((a, x) => a + width(x.t), 0);
  while (tail.length > 1 && w - 2 * BAND_PAD - tailW() < 12) tail.pop();
  const pathW = Math.max(1, w - 2 * BAND_PAD - tailW());
  const path = truncateLeft(relPath(cwd, f.path), pathW);
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  const quiet = f.hidden || f.noise;
  return fill(
    [
      { t: pad(selected ? '▸' : '', BAND_PAD), fg: PALETTE.brand, bold: true },
      { t: path.slice(0, cut), fg: PALETTE.muted },
      { t: pad(path.slice(cut), pathW - width(path.slice(0, cut))), fg: quiet ? PALETTE.muted : PALETTE.text, bold: !quiet },
      ...tail,
    ],
    w,
    selected ? PALETTE.rowFocus : PALETTE.bar,
  );
}

// 변경 조각을 고친 순서의 역순(최신 먼저)으로, 조각마다 시각 · 누가 · 위치 머리를 달아 보인다.
// 같은 파일을 여러 번 고치면 줄 번호 기준이 매번 달라져 하나의 diff 로 합칠 수 없다.
function diffBody(f, w) {
  if (f.hidden) return [[INDENT, { t: '비밀값이 있을 수 있는 파일이라 변경 내용을 숨겼습니다', fg: PALETTE.waiting, italic: true }]];
  if (!f.hunks.length) return [[INDENT, { t: '보관된 변경 내용이 없습니다', fg: PALETTE.faint, italic: true }]];
  const nums = w >= 50;
  const textW = w - 1 - (nums ? 5 : 0);
  const out = [];
  for (const h of f.hunks) {
    out.push([{ t: `${clock(h.at)} · ${h.agent ?? '메인'} · @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, fg: PALETTE.tool, dim: true }]);
    let n = h.newStart;
    for (const l of h.lines) {
      const k = l[0];
      const no = { t: pad(k === '-' ? '' : String(n), 4, 'right') + ' ', fg: PALETTE.faint };
      if (k !== '-') n++;
      const seg = k === '+' ? { fg: PALETTE.busy, bg: PALETTE.addBg } : k === '-' ? { fg: PALETTE.alert, bg: PALETTE.delBg } : { fg: PALETTE.muted };
      out.push([...(nums ? [no] : []), { ...seg, t: pad(l, textW) }]);
    }
    if (h.cut) out.push([{ t: `… ${h.cut}줄 생략`, fg: PALETTE.faint, italic: true }]);
  }
  if (f.dropped) out.push([{ t: `… 이전 변경 ${f.dropped}개는 보관 한도를 넘어 생략`, fg: PALETTE.faint, italic: true }]);
  return out.map((r) => [INDENT, ...r]);
}

// diff 는 오른쪽 칸 전체를 쓴다. 스크롤 위치는 여기서 내용 길이에 맞춰 다시 맞춘다.
function diffView(s, files, f, w, rows, view) {
  const body = diffBody(f, w);
  const gap = rows >= ROOMY ? 1 : 0;
  const page = rows - 1 - gap;
  view.diffPage = Math.max(1, page - 1);
  const top = Math.min(Math.max(0, view.diffScroll ?? 0), Math.max(0, body.length - page));
  view.diffScroll = top;
  const meta = `${files.indexOf(f) + 1}/${files.length}${body.length > page ? ` · ${Math.round(((top + page) / body.length) * 100)}%` : ''}`;
  // 좁으면 편집 수를 줄이거나 빼고, 파일 위치와 스크롤 위치는 남긴다.
  const room = w - 10 - width(meta);
  const stats = [` · 편집 ×${f.edits} · 쓴 줄 ${f.add} · 지운 줄 ${f.del}`, ` · ×${f.edits}`, ''].find((x) => room - width(x) >= 12) ?? '';
  const name = truncateLeft(relPath(s.cwd, f.path), Math.max(8, room - width(stats)));
  const label = [{ t: '‹ ', fg: PALETTE.brand, bold: true }, { t: name, fg: PALETTE.text, bold: true }, { t: stats, fg: PALETTE.faint }];
  return [rule(label, meta, w, PALETTE.brand), ...(gap ? [[]] : []), ...body.slice(top, top + page)];
}

// 사용자 입력(❯)만 진하게 두고 나머지 본문은 흐리게. 파일 목록에 들어가 있으면(dim) 전부 흐리게.
function activity(s, n, dim = false) {
  const tc = PALETTE.tools[s.tool];
  const icon = { prompt: { t: '❯ ', fg: tc, bold: true }, tool: { t: '• ', fg: PALETTE.tool }, reply: { t: '↳ ', fg: PALETTE.muted } };
  // 기록 줄 순서와 시각이 어긋날 때가 있어(병렬 도구 호출 등) 시각 순으로 다시 정렬한다. 같은 시각이면 기록 순서를 지킨다.
  const events = [...(s.events ?? [])].sort((a, b) => a.at - b.at).slice(-n);
  if (!events.length) return [[INDENT, { t: '아직 기록된 활동이 없습니다', fg: PALETTE.faint, italic: true }]];
  const rows = events.map((e) => [INDENT, { t: clock(e.at) + '  ', fg: PALETTE.faint }, icon[e.kind], { t: e.text, fg: e.kind === 'prompt' ? PALETTE.text : PALETTE.muted, bold: e.kind === 'prompt' }]);
  return dim ? rows.map((r) => r.map((x) => ({ ...x, fg: PALETTE.faint, bold: false }))) : rows;
}

// ‹이번 지시›  T5  T3  전체. 색을 꺼도 보이게 고른 탭은 ‹ › 로 감싼다. 폭이 모자라면 가운데 지시 탭부터 줄인다.
// 이전 지시 탭은 3개까지만 보이고 나머지는 … +N 으로 접는다. 고른 탭이 들어가게 창을 옮긴다.
const TAB_WINDOW = 3;

// 숨긴 탭 수는 숨긴 쪽에 따로 붙인다: 이번 지시  … +2  T4  T3  ‹T2›  … +1  전체.
// 폭이 모자라면 가운데 탭 → … +N → '이번 지시' 이름 → 고르지 않은 양끝 탭 순으로 줄여, 고른 탭은 늘 남긴다.
function tabsLine(tabs, tab, w) {
  const seg = (t, short) => (t.key === tab.key ? { t: `‹${t.label}›`, fg: PALETTE.text, bg: PALETTE.rowSel, bold: true } : { t: short && t.key === 'now' ? '이번' : t.label, fg: PALETTE.muted });
  const turns = tabs.slice(1, -1);
  const at = turns.findIndex((t) => t.key === tab.key);
  const start = at >= TAB_WINDOW ? at - TAB_WINDOW + 1 : 0;
  let shown = turns.slice(start, start + TAB_WINDOW);
  let ends = [tabs[0], tabs.at(-1)];
  let marks = true;
  let short = false;
  const build = () => {
    const first = turns.indexOf(shown[0]);
    const before = shown.length ? first : 0;
    const after = turns.length - before - shown.length;
    const parts = [];
    if (ends.includes(tabs[0])) parts.push(seg(tabs[0], short));
    if (marks && before) parts.push({ t: `… +${before}`, fg: PALETTE.faint });
    parts.push(...shown.map((t) => seg(t, short)));
    if (marks && after) parts.push({ t: `… +${after}`, fg: PALETTE.faint });
    if (ends.includes(tabs.at(-1))) parts.push(seg(tabs.at(-1), short));
    return parts.flatMap((x) => [x, { t: '  ' }]);
  };
  const fits = () => segsWidth(build()) <= w;
  while (!fits() && shown.some((t) => t.key !== tab.key)) shown.splice(shown.findIndex((t) => t.key !== tab.key), 1);
  if (!fits()) marks = false;
  if (!fits()) short = true;
  for (const end of [tabs[0], tabs.at(-1)]) if (!fits() && end.key !== tab.key) ends = ends.filter((t) => t !== end);
  return build();
}

// 탭 아래 설명: 지시면 시각과 첫 줄, 전체면 편집 수.
function tabNote(tab, files) {
  if (tab.key === 'all') return [{ t: `세션 전체 · 편집 ${files.reduce((a, f) => a + f.edits, 0)}회`, fg: PALETTE.faint, italic: true }];
  const p = tab.turn;
  const edits = files.reduce((a, f) => a + f.edits, 0);
  return [{ t: p ? `${hhmm(p.at)} "${p.text}"` : '지시 기록 없음', fg: PALETTE.faint, italic: true }, ...(edits ? [{ t: `  편집 ${edits}회`, fg: PALETTE.muted }] : [])];
}

// 오른쪽 칸: 고친 파일이 없으면 최근 활동만, 있으면 위쪽 절반까지 변경 파일 구획(배경 띠), 파일을 열면 diff.
// 머리는 안쪽 줄 수에 따라: 16 이상 가로줄+탭+지시, 11~15 가로줄+탭(지시는 탭 줄 오른쪽), 10 이하 가로줄만.
function rightColumn(s, w, rows, view) {
  const all = s.files ?? [];
  const focused = view?.focus === 'files';
  const activityRule = () => rule([{ t: '최근 활동', fg: focused ? PALETTE.muted : PALETTE.text, bold: true }], '', w);
  if (!all.length) return [activityRule(), ...activity(s, rows - 1)];
  const tab = currentTab(s, view?.tab);
  const files = filesForTab(s, tab);
  const open = view?.focus === 'diff' && files.find((f) => f.path === view.filePath);
  if (open) return diffView(s, files, open, w, rows, view);

  // 목록에 들어가 있으면 구획 왼쪽에 ▌ 막대를 세우고 가로줄을 강조색으로 바꾼다.
  const gutter = focused ? [{ t: '▌', fg: PALETTE.brand }] : [];
  const inner = w - gutter.length;
  const tier = rows >= ROOMY ? 3 : rows >= 11 ? 2 : 1;
  const label = [{ t: '변경 파일', fg: focused ? PALETTE.brand : PALETTE.text, bold: true }, ...(tier === 1 ? [{ t: ` · ${tab.label}`, fg: PALETTE.muted }] : [])];
  // git diff 가 아니라 Edit/Write 기록이고 Bash 로 바꾼 파일은 빠진다는 것을 화면에서 바로 알 수 있게 한다.
  const meta = `편집 기록 · Bash 제외 · ${files.length}개${focused ? '' : ' · f'}`;
  const head = [rule(label, meta, inner, focused ? PALETTE.brand : PALETTE.line)];
  // 11~15 줄에서는 지시 문장이 탭에 밀려 사라지지 않게 그 자리를 먼저 남긴다.
  const note = tabNote(tab, files);
  const noteW = tier === 2 ? Math.min(note.reduce((a, x) => a + width(x.t), 0), Math.floor(inner / 2)) + 1 : 0;
  if (tier >= 2) head.push([INDENT, ...tabsLine(turnTabs(s), tab, inner - 1 - noteW), ...(tier === 2 ? [{ t: ' ' }, ...note] : [])]);
  if (tier === 3) head.push([INDENT, ...note]);

  // 넉넉하면(tier 3) 지시 문장과 목록 사이, 목록과 최근 활동 사이에 빈 줄을 하나씩 둔다.
  // 목록은 칸의 절반까지만 쓰므로 빈 줄을 넣어도 최근 활동은 6줄 넘게 남는다.
  const gap = tier === 3 ? 1 : 0;
  const selIdx = focused ? files.findIndex((f) => f.path === view.filePath) : -1;
  const listRows = Math.max(1, Math.ceil(rows / 2) - head.length - gap);
  const overflow = files.length > listRows;
  const slots = overflow ? listRows - 1 : listRows;
  const start = selIdx >= slots ? selIdx - slots + 1 : 0;
  const shown = files.slice(start, start + slots);
  const list = [];
  if (!files.length) list.push(fill([BAND_LEFT, { t: '· 이 지시에서는 고친 파일 없음', fg: PALETTE.faint, italic: true }, { t: `${GAP}${focused ? '←/→' : 'f 다음 ←/→'} 다른 지시`, fg: PALETTE.faint }], inner, PALETTE.bar));
  shown.forEach((f, k) => list.push(fileRow(f, s.cwd, inner, start + k === selIdx)));
  if (overflow) list.push(fill([BAND_LEFT, { t: `+${files.length - shown.length}개 더`, fg: PALETTE.muted }], inner, PALETTE.bar));
  const block = [...head, ...(gap ? [[]] : []), ...list, ...(gap ? [[]] : [])];
  const R = block.map((segs) => [...gutter, ...segs]);
  R.push(activityRule(), ...activity(s, rows - R.length - 1, focused));
  return R;
}

function detail(s, W, H, frame, view) {
  const tc = PALETTE.tools[s.tool];
  const leftW = Math.min(46, Math.max(30, Math.floor((W - 4) * 0.38)));
  const L = [];
  // 왼쪽 칸도 오른쪽 칸처럼 라벨 가로줄로 나누고 내용은 1칸 들여 쓴다.
  const section = (name) => L.push(rule([{ t: name, fg: PALETTE.text, bold: true }], '', leftW));
  const kv = (k, v, fg = PALETTE.text) => L.push([INDENT, { t: pad(k, 9), fg: PALETTE.muted }, { t: v ?? '-', fg }]);
  const more = (segs) => L.push([INDENT, { t: ' '.repeat(9) }, ...segs]);

  const g = glyph(s, frame);
  L.push([{ ...g, t: g.t + ' ' }, { t: s.phase?.text ?? s.status, fg: PHASE_COLOR[s.phase?.kind] ?? PALETTE.text, bold: true }]);
  section('세션');
  kv('폴더', tilde(s.cwd));
  if (s.branch) kv('브랜치', s.branch);
  kv('모델', s.model ?? '-');
  kv('종류', `${s.kind ?? '-'}${s.pid ? ` · pid ${s.pid}` : ''}`);
  if (s.startedAt) kv('시작', `${clock(s.startedAt)}  (${fmtAgo(NOW - s.startedAt)} 전)`);

  // 합계 = 메인 + 서브 = 입력 + 출력 + 캐시 읽기 + 캐시 쓰기 가 화면에서 그대로 맞아떨어지게 보인다.
  const t = s.tokens ?? {};
  section('토큰');
  kv('합계', fmtTokens(t.total));
  if (t.subCount) more([{ t: `메인 ${fmtTokens(t.main)} + 서브 ${t.subCount}개 ${fmtTokens(t.sub)}`, fg: PALETTE.faint }]);
  more([{ t: `입력 ${fmtTokens(t.input)} · 출력 ${fmtTokens(t.output)}`, fg: PALETTE.faint }]);
  more([{ t: `캐시 읽기 ${fmtTokens(t.cacheRead)} · 쓰기 ${fmtTokens(t.cacheWrite)}`, fg: PALETTE.faint }]);
  if (s.cost != null) section('비용');
  else if (s.context?.window) section('컨텍스트');
  if (s.cost != null) {
    L.push([INDENT, { t: pad('API 환산', 9), fg: PALETTE.muted }, { t: money(s.cost, s.costUnknown), fg: PALETTE.money, bold: true }]);
    more([{ t: `캐시 제외 ${money(s.costNoCache, s.costUnknown)}`, fg: PALETTE.faint }, ...(s.costUnknown ? [{ t: '  ? 가격표에 없는 모델 포함', fg: PALETTE.waiting }] : [])]);
  }
  if (s.context?.window) {
    L.push([INDENT, { t: pad('컨텍스트', 9), fg: PALETTE.muted }, { t: pad(`${fmtTokens(s.context.used)}/${fmtTokens(s.context.window)}`, 11) + ' ', fg: PALETTE.text }, ...gauge(s.context.used, s.context.window, Math.max(4, leftW - width(INDENT.t) - 26))]);
  }

  const R = rightColumn(s, W - leftW - 7, H - 2, view);
  // 제목: 세션 이름은 진하게, 도구·모델은 도구 색으로.
  const title = [{ t: s.name ?? s.tool, fg: PALETTE.text, bold: true }, { t: `  ${s.tool}${s.model ? ' · ' + s.model : ''}`, fg: tc }];
  return box(title, W, H, L, R, leftW, tc, Boolean(view?.focus));
}

const HELP = [
  ['키', null],
  ['/', '세션 검색 (이름·폴더·모델). Enter 적용, Esc 지우기'],
  ['↑↓ j k', '세션 선택'],
  ['n', '다음 볼 세션으로 이동 (응답 대기 → 완료 · 확인 전)'],
  ['f Tab', '변경 파일 목록으로. ←→ 지시 탭, ↑↓ 고르기, Enter diff, [ ] 이전·다음 파일, space 페이지'],
  ['d', '상세 패널 열기·닫기'],
  ['e', '종료된 세션(24시간) 보이기·숨기기'],
  ['?', '이 도움말 열기·닫기'],
  ['Esc', '한 단계 뒤로 (도움말·검색 닫기, diff → 파일 목록 → 세션). 종료하지 않음'],
  ['q Ctrl-C', '나가기'],
  ['', ''],
  ['상태 기호', null],
  ['⠋', '작업 중 (색: 초록 생각·답변, 파랑 도구 실행, 분홍 팀원 작업)'],
  ['◆', '응답 대기 (권한·질문). 행 배경이 강조된다'],
  ['●', '완료 · 확인 전 (작업이 끝났는데 아직 선택해 보지 않음)'],
  ['○', '다음 지시 대기'],
  ['·', '종료'],
  ['', ''],
  ['열', null],
  ['STATUS', '지금 단계. 큰 기록을 처음 읽는 동안은 기록 읽는 중 N%'],
  ['TOKENS', '세션 누적 토큰 (서브에이전트 포함, 캐시 읽기 포함)'],
  ['COST', 'Claude API 정가로 환산한 비용. ? 는 가격표에 없는 모델 포함'],
  ['CONTEXT', '마지막 요청의 컨텍스트 사용률 (모델별 창 크기 기준)'],
  ['IDLE', '마지막 활동 후 지난 시간. 작업 중이면 now'],
  ['오늘 / 7일', '헤더 오른쪽. 최근 7일 Claude 기록의 날짜별 합계'],
  ['변경 파일', 'Edit/Write 도구로 고친 파일과 편집 횟수. git diff 가 아니다. Bash 로 고친 파일은 빠진다'],
  ['', 'diff 머리의 쓴 줄 · 지운 줄은 편집마다 더한 누적값 (최종 변경량 아님)'],
  ['지시 탭', '이번 지시(마지막 지시 뒤), 편집이 있던 이전 지시 T번호, 전체. lock·생성 파일은 끝에 흐리게'],
];

function help(W, H) {
  const left = HELP.map(([k, v]) => (v == null ? [{ t: k, fg: PALETTE.brand, bold: true }] : [{ t: pad(k, 12), fg: PALETTE.text, bold: true }, { t: v, fg: PALETTE.muted }]));
  return box('도움말  ·  ? 또는 Esc 로 닫기', W, H, left, [], W - 8, PALETTE.brand);
}

// 키 칩. 색이 없으면 [f] 처럼 괄호로 보인다.
const keyChip = (k) => (NO_COLOR ? { t: `[${k}]` } : { t: ` ${k} `, fg: '#0b0e14', bg: PALETTE.muted, bold: true });
const keyLabel = (t) => ({ t: ` ${t}   `, fg: PALETTE.muted });

// items: { k, t, keep } 또는 { segs, keep }. 폭이 모자라면 keep 이 아닌 항목을 오른쪽부터 뺀다.
function hintBar(items, W, right = '') {
  const segsOf = (list) => [{ t: ' ' }, ...list.flatMap((i) => i.segs ?? [keyChip(i.k), keyLabel(i.t)])];
  const wOf = (list) => segsWidth(segsOf(list));
  const list = [...items];
  while (wOf(list) > W && list.some((i) => !i.keep)) list.splice(list.findLastIndex((i) => !i.keep), 1);
  const segs = segsOf(list);
  const used = wOf(list);
  if (right && W - used >= width(right) + 1) segs.push({ t: ' '.repeat(W - used - width(right)) }, { t: right, fg: PALETTE.faint });
  return line(segs, W);
}

function footer(view, W, matched, sel) {
  const tail = [
    { k: '?', t: '도움', keep: true },
    { k: 'q', t: '나가기', keep: true },
  ];
  if (view.searching) {
    const input = NO_COLOR ? [{ t: '[/]' }] : [{ t: ' / ', fg: '#0b0e14', bg: PALETTE.brand, bold: true }];
    return hintBar([{ segs: [...input, { t: ` ${view.filter ?? ''}`, fg: PALETTE.text, bold: true }, { t: '▏', fg: PALETTE.brand }, { t: `  ${matched}개   `, fg: PALETTE.muted }], keep: true }, { k: '⏎', t: '적용', keep: true }, { k: 'Esc', t: '지우기', keep: true }], W);
  }
  if (view.focus) {
    const keys =
      view.focus === 'diff'
        ? [{ k: '↑↓', t: '스크롤' }, { k: 'space', t: '페이지' }, { k: '[ ]', t: '이전·다음 파일' }, { k: 'Esc', t: '파일 목록으로', keep: true }]
        : [{ k: '←→', t: '지시' }, { k: '↑↓', t: '파일 선택' }, { k: '⏎', t: 'diff 보기' }, { k: 'Esc', t: '세션으로', keep: true }];
    return hintBar([...keys, ...tail], W, '⊘ 읽기전용');
  }
  // 세션이 하나도 없으면 쓸 수 있는 키만 남긴다.
  if (!view.filter && !view.data?.sessions?.length) return hintBar([{ k: 'e', t: view.showEnded ? '종료 숨김' : '종료 포함' }, ...tail], W, '⊘ 읽기전용');
  const search = view.filter
    ? { segs: [{ t: ` /${view.filter} `, fg: '#0b0e14', bg: PALETTE.brand, bold: true }, { t: ` ${matched}개 `, fg: PALETTE.muted }, keyChip('Esc'), keyLabel('검색 지우기')], keep: true }
    : { k: '/', t: '검색' };
  const items = [
    search,
    { k: '↑↓', t: '선택' },
    { k: 'n', t: '다음' },
    ...(sel?.files?.length ? [{ k: 'f', t: '파일' }] : []),
    { k: 'd', t: view.showDetail ? '상세 닫기' : '상세 열기' },
    { k: 'e', t: view.showEnded ? '종료 숨김' : '종료 포함' },
    ...tail,
  ];
  return hintBar(items, W, '⊘ 읽기전용');
}

// 세션이 없을 때: aitop --doctor 와 같은 도구별 점검 줄과 종료 세션 보기 안내.
const MARK_COLOR = { ok: PALETTE.busy, missing: PALETTE.alert, limited: PALETTE.muted };
function emptyLines(view, W) {
  const out = [line([{ t: view.showEnded ? '   지난 24시간 안에 AI 세션이 없습니다.' : '   실행 중인 AI 세션이 없습니다.', fg: PALETTE.muted, italic: true }], W), line([], W)];
  const tools = Object.values(view.data.tools?.tools ?? {});
  const pathW = Math.max(0, ...tools.map((t) => width(t.path)));
  for (const t of tools) {
    const d = describe(t, NOW);
    out.push(line([{ t: `   ${d.mark} `, fg: MARK_COLOR[t.state], bold: true }, { t: pad(t.tool, 7), fg: PALETTE.tools[t.tool], bold: true }, { t: pad(d.state, 10), fg: PALETTE.text }, { t: pad(d.path, pathW + 2), fg: PALETTE.muted }, { t: d.detail, fg: PALETTE.faint }], W));
    if (d.hint) out.push(line([{ t: `            → ${d.hint}`, fg: PALETTE.faint }], W));
  }
  if (!view.showEnded) out.push(line([], W), line([{ t: '   지난 24시간 세션 보기: ', fg: PALETTE.faint }, { t: 'e', fg: PALETTE.text, bold: true }, { t: ' 또는 ', fg: PALETTE.faint }, { t: 'aitop --all', fg: PALETTE.text }], W));
  return out;
}

// 화면에서 비용이 가장 큰 세션 두 개 (0 보다 클 때만).
function topCost(sessions) {
  const top = sessions.filter((s) => s.cost > 0 && s.status !== 'ended').sort((a, b) => b.cost - a.cost).slice(0, 2);
  return new Set(top.map((s) => s.id));
}

// 표를 둥근 상자로 감싼다. 안쪽 줄은 이미 폭 W-4 로 그려져 있다.
function tableBox(inner, W, count) {
  const e = EDGE.normal;
  const ln = (t) => style({ fg: PALETTE.line }) + t + RESET;
  const title = ` 세션 ${count} `;
  const top = line([{ t: e.tl + e.h, fg: PALETTE.line }, { t: title, fg: PALETTE.muted }, { t: e.h.repeat(Math.max(0, W - 3 - width(title))) + e.tr, fg: PALETTE.line }], W);
  return [top, ...inner.map((l) => ln(`${e.v} `) + l + ln(` ${e.v}`)), line([{ t: e.bl + e.h.repeat(W - 2) + e.br, fg: PALETTE.line }], W)];
}

// 이 높이 이상이면 세션 표를 상자로 감싼다 (상자 테두리에 두 줄이 든다).
const TABLE_BOX_H = 30;

export function render(view, W, H) {
  NOW = Date.now();
  const lines = [];
  if (!view.data) {
    const msg = '세션 기록을 읽는 중…';
    for (let i = 0; i < H; i++) lines.push(i === Math.floor(H / 2) ? line([{ t: ' '.repeat(Math.max(0, Math.floor((W - width(msg)) / 2))) }, { t: msg, fg: PALETTE.brand }], W) : line([], W));
    return lines;
  }
  const { errors } = view.data;
  const sessions = filterSessions(view.data.sessions, view.filter);
  const boxed = H >= TABLE_BOX_H && W >= 60;
  const TW = boxed ? W - 4 : W;
  const c = columns(TW);
  if (view.help) {
    lines.push(header(view, W), ...help(W, Math.max(3, H - 2)));
    lines.length = H - 1;
    lines.push(footer(view, W, sessions.length));
    return lines;
  }
  lines.push(header(view, W), toolStrip(view, W));
  if (!boxed) lines.push(line([], W));
  const table = [tableHeader(c, TW)];

  const rows = [];
  for (const s of sessions) {
    rows.push({ s });
    s.members.forEach((m, i) => rows.push({ s, m, last: i === s.members.length - 1 }));
  }
  const sel = sessions.find((s) => s.id === view.selectedId) ?? sessions[0];
  const wantDetail = view.showDetail && Boolean(sel);
  const minDetail = wantDetail ? 12 : 0;
  const used = lines.length + table.length + (boxed ? 2 : 0);
  const room = Math.max(1, Math.min(Math.max(1, rows.length), H - used - minDetail - 2));
  // 표가 다 들어가지 않으면 마지막 줄에 몇 개가 가려졌는지 알린다.
  const clipped = rows.length > room && room > 1;
  const shown = clipped ? room - 1 : room;
  const selRow = Math.max(0, rows.findIndex((r) => !r.m && r.s === sel));
  const lastOfSel = selRow + (sel?.members.length ?? 0);
  const start = Math.min(Math.max(0, lastOfSel - shown + 1), Math.max(0, rows.length - shown), selRow);
  const visible = rows.slice(start, start + shown);
  const hot = topCost(sessions);
  if (!sessions.length) table.push(...(view.filter ? [line([{ t: `   '${view.filter}' 에 맞는 세션이 없습니다.`, fg: PALETTE.muted, italic: true }], TW)] : emptyLines(view, TW)));
  for (const r of visible) table.push(r.m ? memberRow(r.m, r.last, c, TW, view.frame) : sessionRow(r.s, c, TW, r.s === sel, view.frame, hot));
  if (clipped) {
    const onScreen = new Set(visible.filter((r) => !r.m).map((r) => r.s));
    const hidden = sessions.filter((s) => !onScreen.has(s));
    const waitingHidden = hidden.filter((s) => s.status === 'waiting').length;
    table.push(line([{ t: `   … +${hidden.length} 세션`, fg: PALETTE.muted }, ...(waitingHidden ? [{ t: ` (응답 대기 ${waitingHidden})`, fg: PALETTE.waiting, bold: true }] : []), { t: '  ↑↓ 로 이동', fg: PALETTE.faint }], TW));
  }
  lines.push(...(boxed ? tableBox(table, W, sessions.length) : table));
  if (wantDetail) {
    lines.push(line([], W));
    lines.push(...detail(sel, W, Math.max(minDetail, H - lines.length - 1), view.frame, view));
  }
  if (errors?.length) lines[lines.length - 1] = line([{ t: ' ! ' + errors.join(' / '), fg: PALETTE.alert }], W);
  while (lines.length < H - 1) lines.push(line([], W));
  lines.length = H - 1;
  lines.push(footer(view, W, sessions.length, sel));
  return lines;
}
