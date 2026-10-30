// 화면 그리기: 상단 요약 바 → 세션 표(팀원 트리 포함) → 선택한 세션 상세 → 단축키 바.
import { homedir } from 'node:os';
import { relative, isAbsolute } from 'node:path';
import { width, truncate, truncateLeft, pad, fmtTokens, fmtAgo, stripControl } from './text.mjs';

const NO_COLOR = Boolean(process.env.NO_COLOR);

export const PALETTE = {
  text: '#e6e8ee',
  muted: '#8a90a2',
  faint: '#4b5060',
  line: '#2b2f3a',
  rowSel: '#1d2433',
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

function gauge(used, total, cells) {
  if (!total) return [{ t: '─'.repeat(cells) + '     ', fg: PALETTE.faint }];
  const r = Math.min(1, used / total);
  const filled = Math.round(r * cells);
  const color = r >= 0.85 ? PALETTE.alert : r >= 0.6 ? PALETTE.waiting : PALETTE.busy;
  return [
    { t: '━'.repeat(filled), fg: color },
    { t: '─'.repeat(cells - filled), fg: PALETTE.faint },
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
  const left = [
    { t: ' ◆ aitop ', fg: '#0b0e14', bg: PALETTE.brand, bold: true },
    { t: '  ', bg: B },
    { t: `${live.length} live`, fg: PALETTE.text, bg: B, bold: true },
    { t: '   ⠿ ', fg: working ? PALETTE.busy : PALETTE.faint, bg: B },
    { t: `${working} 작업 중`, fg: working ? PALETTE.text : PALETTE.faint, bg: B },
    { t: '   ◆ ', fg: waiting ? PALETTE.waiting : PALETTE.faint, bg: B },
    { t: `${waiting} 응답 대기`, fg: waiting ? PALETTE.waiting : PALETTE.faint, bg: B, bold: waiting > 0 },
    { t: '   ● ', fg: unseen ? PALETTE.busy : PALETTE.faint, bg: B },
    { t: `${unseen} 확인 전`, fg: unseen ? PALETTE.busy : PALETTE.faint, bg: B, bold: unseen > 0 },
    { t: '   ○ ', fg: idle ? PALETTE.idle : PALETTE.faint, bg: B },
    { t: `${idle} 대기`, fg: idle ? PALETTE.text : PALETTE.faint, bg: B },
  ];
  // 오늘·최근 7일 사용량 (Claude, API 환산). 처음 집계 중에는 진행률을 보인다.
  const u = view.data.usage;
  const period = (label, p) => [
    { t: `${label} `, fg: PALETTE.muted, bg: B },
    { t: money(p.cost, p.unknown), fg: PALETTE.money, bg: B, bold: true },
    { t: ` ${fmtTokens(p.tokens)}`, fg: PALETTE.muted, bg: B },
  ];
  // 장부를 못 읽었으면 화면에 있는 세션(모든 도구)의 누적 토큰이라도 보인다.
  const fallback = [{ t: `Σ ${fmtTokens(view.data.sessions.reduce((a, s) => a + (s.tokens?.total ?? 0), 0))} tok`, fg: PALETTE.muted, bg: B }];
  const right = [
    ...(u ? [...period('오늘', u.today), { t: '   ', bg: B }, ...(u.loading != null ? [{ t: `7일 집계 중 ${Math.floor(u.loading * 100)}%`, fg: PALETTE.faint, bg: B }] : period('7일', u.week))] : fallback),
    { t: `   ${clock(view.data.at)} `, fg: PALETTE.muted, bg: B },
  ];
  const lw = left.reduce((a, s) => a + width(s.t), 0);
  const rw = right.reduce((a, s) => a + width(s.t), 0);
  return line([...left, { t: ' '.repeat(Math.max(1, W - lw - rw)), bg: B }, ...right], W, B);
}

function toolStrip(view, W) {
  const segs = [{ t: ' ' }];
  for (const tool of ['claude', 'codex', 'gemini']) {
    const list = view.data.sessions.filter((s) => s.tool === tool);
    const live = list.filter((s) => s.live).length;
    const tok = list.reduce((a, s) => a + (s.tokens?.total ?? 0), 0);
    const on = live > 0;
    segs.push({ t: '▍', fg: on ? PALETTE.tools[tool] : PALETTE.faint });
    segs.push({ t: tool, fg: on ? PALETTE.tools[tool] : PALETTE.faint, bold: on });
    segs.push({ t: `  ${live} 세션 · ${fmtTokens(tok)}`, fg: on ? PALETTE.muted : PALETTE.faint });
    segs.push({ t: '     ' });
  }
  if (view.showEnded) segs.push({ t: '종료된 세션 포함 (24시간)', fg: PALETTE.waiting, italic: true });
  return line(segs, W);
}

function tableHeader(c, W) {
  const h = (t, n, align) => ({ t: pad(t, n, align) + ' ', fg: PALETTE.faint, bold: true });
  const segs = [{ t: ' '.repeat(c.mark + c.glyph) }, h('TOOL', c.tool)];
  if (c.showModel) segs.push(h('MODEL', c.model));
  segs.push(h('SESSION', c.name));
  if (c.showProject) segs.push(h('PROJECT', c.project));
  segs.push(h('STATUS', c.status), h('TOKENS', c.tokens, 'right'));
  if (c.showCost) segs.push(h('COST', c.cost, 'right'));
  segs.push(h('CONTEXT', c.ctx), h('IDLE', c.age, 'right'));
  return line(segs, W);
}

function sessionRow(s, c, W, selected, frame) {
  const waiting = s.status === 'waiting';
  const bg = selected ? PALETTE.rowSel : waiting ? PALETTE.rowWaiting : undefined;
  // IDLE: 마지막 활동 후 지난 시간. 지금 일하고 있는 세션은 'now'.
  const working = s.status === 'busy' || s.status === 'shell';
  const idle = working ? 'now' : fmtAgo(NOW - (s.updatedAt ?? 0));
  const ended = s.status === 'ended';
  const tc = PALETTE.tools[s.tool];
  const g = glyph(s, frame);
  const pc = PHASE_COLOR[s.phase?.kind] ?? PALETTE.muted;
  const segs = [
    { t: selected ? '▌' : ' ', fg: tc },
    { ...g, t: g.t + ' ' },
    { t: pad(s.tool, c.tool) + ' ', fg: ended ? PALETTE.ended : tc, bold: !ended },
  ];
  if (c.showModel) segs.push({ t: pad(shortModel(s.model), c.model) + ' ', fg: ended ? PALETTE.ended : PALETTE.muted });
  segs.push({ t: pad(s.name ?? '', c.name) + ' ', fg: ended ? PALETTE.ended : PALETTE.text, bold: selected });
  if (c.showProject) segs.push({ t: pad(s.project ?? '', c.project) + ' ', fg: PALETTE.muted });
  segs.push(
    { t: pad(s.phase?.text ?? '', c.status) + ' ', fg: pc, bold: s.status === 'waiting' },
    { t: pad(s.lazy ? '' : fmtTokens(s.tokens?.total ?? 0), c.tokens, 'right') + ' ', fg: ended ? PALETTE.ended : PALETTE.text },
  );
  if (c.showCost) segs.push({ t: pad(s.lazy ? '' : money(s.cost, s.costUnknown), c.cost, 'right') + ' ', fg: s.cost == null || ended ? PALETTE.faint : PALETTE.money });
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

function box(title, W, H, leftLines, rightLines, leftW, accent, divider = PALETTE.line) {
  const out = [];
  const titleText = ` ${title} `;
  out.push(line([{ t: '╭─', fg: PALETTE.line }, { t: titleText, fg: accent, bold: true }, { t: '─'.repeat(Math.max(0, W - 3 - width(titleText))) + '╮', fg: PALETTE.line }], W));
  // '│ ' + 왼쪽 + ' │ ' + 오른쪽 + ' │' = W
  const rightW = W - leftW - 7;
  const fill = (segs, n) => {
    const c = clip(segs, n);
    return [...c, { t: ' '.repeat(Math.max(0, n - c.reduce((a, s) => a + width(s.t), 0))) }];
  };
  for (let i = 0; i < H - 2; i++) {
    out.push(line([{ t: '│ ', fg: PALETTE.line }, ...fill(leftLines[i] ?? [], leftW), { t: ' │ ', fg: divider }, ...fill(rightLines[i] ?? [], rightW), { t: ' │', fg: PALETTE.line }], W));
  }
  out.push(line([{ t: '╰' + '─'.repeat(W - 2) + '╯', fg: PALETTE.line }], W));
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

// …/src/ui.mjs  새 파일  편집 ×3  14:02. 줄 수는 편집마다 더한 값이라 git diff 처럼 읽히지 않게 목록에는 넣지 않는다.
// 좁으면 시각, 새 파일 표시 순으로 뺀다.
function fileRow(f, cwd, w, selected) {
  const tail = [{ t: `  편집 ×${f.edits}`, fg: PALETTE.muted }, ...(f.created ? [{ t: '  새 파일', fg: PALETTE.busy }] : []), { t: `  ${hhmm(f.at)}`, fg: PALETTE.faint }];
  const tailW = () => tail.reduce((a, x) => a + width(x.t), 0);
  while (tail.length > 1 && w - 1 - tailW() < 12) tail.pop();
  const pathW = Math.max(1, w - 1 - tailW());
  const bg = selected ? PALETTE.rowSel : undefined;
  return [
    { t: selected ? '▸' : ' ', fg: PALETTE.brand, bold: true },
    { t: pad(truncateLeft(relPath(cwd, f.path), pathW), pathW), fg: f.hidden ? PALETTE.muted : PALETTE.text, bold: selected },
    ...tail,
  ].map((x) => ({ ...x, bg }));
}

// 변경 조각을 고친 순서의 역순(최신 먼저)으로, 조각마다 시각 · 누가 · 위치 머리를 달아 보인다.
// 같은 파일을 여러 번 고치면 줄 번호 기준이 매번 달라져 하나의 diff 로 합칠 수 없다.
function diffBody(f, w) {
  if (f.hidden) return [[{ t: '비밀값이 있을 수 있는 파일이라 변경 내용을 숨겼습니다', fg: PALETTE.waiting, italic: true }]];
  if (!f.hunks.length) return [[{ t: '보관된 변경 내용이 없습니다', fg: PALETTE.faint, italic: true }]];
  const nums = w >= 50;
  const textW = w - (nums ? 5 : 0);
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
  return out;
}

// diff 는 오른쪽 칸 전체를 쓴다. 스크롤 위치는 여기서 내용 길이에 맞춰 다시 맞춘다.
function diffView(s, f, w, rows, view) {
  const body = diffBody(f, w);
  const page = rows - 1;
  view.diffPage = Math.max(1, page - 1);
  const top = Math.min(Math.max(0, view.diffScroll ?? 0), Math.max(0, body.length - page));
  view.diffScroll = top;
  const i = s.files.indexOf(f);
  const pct = body.length > page ? `${Math.round(((top + page) / body.length) * 100)}%` : '';
  const stats = [{ t: `  편집 ×${f.edits} · 쓴 줄 ${f.add} · 지운 줄 ${f.del}`, fg: PALETTE.faint }, { t: `  ${i + 1}/${s.files.length}`, fg: PALETTE.faint }];
  const statsW = stats.reduce((a, x) => a + width(x.t), 0);
  const name = truncateLeft(relPath(s.cwd, f.path), Math.max(8, w - 2 - statsW - width(pct) - 1));
  const gap = Math.max(1, w - 2 - width(name) - statsW - width(pct));
  const head = [{ t: '‹ ', fg: PALETTE.brand, bold: true }, { t: name, fg: PALETTE.text, bold: true }, ...stats, { t: ' '.repeat(gap) }, { t: pct, fg: PALETTE.muted }];
  return [head, ...body.slice(top, top + page)];
}

function activity(s, n) {
  const tc = PALETTE.tools[s.tool];
  const icon = { prompt: { t: '❯ ', fg: tc, bold: true }, tool: { t: '• ', fg: PALETTE.tool }, reply: { t: '↳ ', fg: PALETTE.muted } };
  const textColor = { prompt: PALETTE.text, tool: PALETTE.text, reply: PALETTE.muted };
  // 기록 줄 순서와 시각이 어긋날 때가 있어(병렬 도구 호출 등) 시각 순으로 다시 정렬한다. 같은 시각이면 기록 순서를 지킨다.
  const events = [...(s.events ?? [])].sort((a, b) => a.at - b.at).slice(-n);
  if (!events.length) return [[{ t: '아직 기록된 활동이 없습니다', fg: PALETTE.faint, italic: true }]];
  return events.map((e) => [{ t: clock(e.at) + '  ', fg: PALETTE.faint }, icon[e.kind], { t: e.text, fg: textColor[e.kind], bold: e.kind === 'prompt' }]);
}

// 오른쪽 칸: 고친 파일이 없으면 최근 활동만, 있으면 위쪽 절반까지 변경 파일 목록, 파일을 열면 diff.
function rightColumn(s, w, rows, view) {
  const files = s.files ?? [];
  const title = [{ t: '최근 활동', fg: PALETTE.muted, bold: true }];
  const open = view?.focus === 'diff' && files.find((f) => f.path === view.filePath);
  if (open) return diffView(s, open, w, rows, view);
  if (!files.length) return [title, ...activity(s, rows - 1)];
  if (rows < 6) return [[...title, { t: `   변경 파일 ${files.length} · f`, fg: PALETTE.faint }], ...activity(s, rows - 1)];

  const focused = view?.focus === 'files';
  const selIdx = focused ? Math.max(0, files.findIndex((f) => f.path === view.filePath)) : -1;
  const listRows = Math.ceil(rows / 2) - 1;
  const overflow = files.length > listRows;
  const slots = overflow ? listRows - 1 : listRows;
  const start = selIdx >= slots ? selIdx - slots + 1 : 0;
  const shown = files.slice(start, start + slots);
  const R = [[{ t: '변경 파일 ', fg: PALETTE.muted, bold: true }, { t: String(files.length), fg: PALETTE.text, bold: true }, { t: '  Edit/Write 기록 기준 · Bash 변경 제외', fg: PALETTE.faint }, ...(focused ? [] : [{ t: '  · f 로 이동', fg: PALETTE.faint }])]];
  shown.forEach((f, k) => R.push(fileRow(f, s.cwd, w, start + k === selIdx)));
  if (overflow) R.push([{ t: `  … 외 ${files.length - shown.length}개`, fg: PALETTE.muted }]);
  R.push(title, ...activity(s, rows - R.length - 1));
  return R;
}

function detail(s, W, H, frame, view) {
  const tc = PALETTE.tools[s.tool];
  const leftW = Math.min(46, Math.max(30, Math.floor((W - 4) * 0.38)));
  const L = [];
  const kv = (k, v, fg = PALETTE.text) => L.push([{ t: pad(k, 9), fg: PALETTE.muted }, { t: v ?? '-', fg }]);

  const g = glyph(s, frame);
  L.push([{ ...g, t: g.t + ' ' }, { t: s.phase?.text ?? s.status, fg: PHASE_COLOR[s.phase?.kind] ?? PALETTE.text, bold: true }]);
  kv('폴더', tilde(s.cwd));
  if (s.branch) kv('브랜치', s.branch);
  kv('모델', s.model ?? '-');
  kv('종류', `${s.kind ?? '-'}${s.pid ? ` · pid ${s.pid}` : ''}`);
  if (s.startedAt) kv('시작', `${clock(s.startedAt)}  (${fmtAgo(NOW - s.startedAt)} 전)`);
  L.push([]);

  // 합계 = 메인 + 서브 = 입력 + 출력 + 캐시 읽기 + 캐시 쓰기 가 화면에서 그대로 맞아떨어지게 보인다.
  const t = s.tokens ?? {};
  L.push([{ t: pad('토큰', 9), fg: PALETTE.muted, bold: true }, { t: fmtTokens(t.total), fg: PALETTE.text, bold: true }]);
  if (t.subCount) L.push([{ t: ' '.repeat(9) }, { t: `메인 ${fmtTokens(t.main)} + 서브 ${t.subCount}개 ${fmtTokens(t.sub)}`, fg: PALETTE.faint }]);
  L.push([{ t: ' '.repeat(9) }, { t: `입력 ${fmtTokens(t.input)} · 출력 ${fmtTokens(t.output)}`, fg: PALETTE.faint }]);
  L.push([{ t: ' '.repeat(9) }, { t: `캐시 읽기 ${fmtTokens(t.cacheRead)} · 쓰기 ${fmtTokens(t.cacheWrite)}`, fg: PALETTE.faint }]);
  if (s.cost != null) {
    L.push([{ t: pad('비용', 9), fg: PALETTE.muted, bold: true }, { t: money(s.cost, s.costUnknown), fg: PALETTE.money, bold: true }, { t: ' API 환산', fg: PALETTE.faint }]);
    L.push([{ t: ' '.repeat(9) }, { t: `캐시 제외 ${money(s.costNoCache, s.costUnknown)}`, fg: PALETTE.faint }, ...(s.costUnknown ? [{ t: '  ? 가격표에 없는 모델 포함', fg: PALETTE.waiting }] : [])]);
  }
  if (s.context?.window) {
    L.push([{ t: pad('컨텍스트', 9), fg: PALETTE.muted }, { t: pad(`${fmtTokens(s.context.used)}/${fmtTokens(s.context.window)}`, 11) + ' ', fg: PALETTE.text }, ...gauge(s.context.used, s.context.window, Math.max(4, leftW - 26))]);
  }

  const R = rightColumn(s, W - leftW - 7, H - 2, view);
  const title = `${s.name ?? s.tool}  ·  ${s.tool}${s.model ? ' · ' + s.model : ''}`;
  return box(title, W, H, L, R, leftW, tc, view?.focus ? tc : PALETTE.line);
}

const HELP = [
  ['키', null],
  ['/', '세션 검색 (이름·폴더·모델). Enter 적용, Esc 지우기'],
  ['↑↓ j k', '세션 선택'],
  ['n', '다음 볼 세션으로 이동 (응답 대기 → 완료 · 확인 전)'],
  ['f Tab', '변경 파일 목록으로. ↑↓ 고르기, Enter diff, [ ] 이전·다음 파일, space 페이지'],
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
];

function help(W, H) {
  const left = HELP.map(([k, v]) => (v == null ? [{ t: k, fg: PALETTE.brand, bold: true }] : [{ t: pad(k, 12), fg: PALETTE.text, bold: true }, { t: v, fg: PALETTE.muted }]));
  return box('도움말  ·  ? 또는 Esc 로 닫기', W, H, left, [], W - 8, PALETTE.brand);
}

function footer(view, W, matched, sel) {
  const key = (k) => ({ t: ` ${k} `, fg: '#0b0e14', bg: PALETTE.muted, bold: true });
  const lab = (t) => ({ t: ` ${t}   `, fg: PALETTE.muted });
  if (view.searching) {
    return line([{ t: ' / ', fg: '#0b0e14', bg: PALETTE.brand, bold: true }, { t: ` ${view.filter ?? ''}`, fg: PALETTE.text, bold: true }, { t: '▏', fg: PALETTE.brand }, { t: `  ${matched}개   `, fg: PALETTE.muted }, key('⏎'), lab('적용'), key('Esc'), lab('지우기')], W);
  }
  if (view.focus) {
    const keys = view.focus === 'diff' ? [key('↑↓'), lab('스크롤'), key('space'), lab('페이지'), key('[ ]'), lab('이전·다음 파일'), key('Esc'), lab('파일 목록으로')] : [key('↑↓'), lab('파일 선택'), key('⏎'), lab('diff 보기'), key('Esc'), lab('세션으로')];
    return line([{ t: ' ' }, ...keys, key('?'), lab('도움말'), key('q'), lab('나가기')], W);
  }
  const search = view.filter ? [{ t: ` /${view.filter} `, fg: '#0b0e14', bg: PALETTE.brand, bold: true }, { t: ` ${matched}개 `, fg: PALETTE.muted }, key('Esc'), lab('검색 지우기')] : [key('/'), lab('검색')];
  const segs = [{ t: ' ' }, ...search, key('↑↓'), lab('선택'), key('n'), lab('다음 볼 세션'), ...(sel?.files?.length ? [key('f'), lab('변경 파일')] : []), key('d'), lab(view.showDetail ? '상세 닫기' : '상세 열기'), key('e'), lab(view.showEnded ? '종료 숨기기' : '종료 포함'), key('?'), lab('도움말'), key('q'), lab('나가기')];
  const right = '읽기 전용 · 네트워크 없음 ';
  const used = segs.reduce((a, s) => a + width(s.t), 0);
  segs.push({ t: ' '.repeat(Math.max(1, W - used - width(right))) }, { t: right, fg: PALETTE.faint });
  return line(segs, W);
}

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
  const c = columns(W);
  if (view.help) {
    lines.push(header(view, W), ...help(W, Math.max(3, H - 2)));
    lines.length = H - 1;
    lines.push(footer(view, W, sessions.length));
    return lines;
  }
  lines.push(header(view, W), toolStrip(view, W), line([], W), tableHeader(c, W));

  const rows = [];
  for (const s of sessions) {
    rows.push({ s });
    s.members.forEach((m, i) => rows.push({ s, m, last: i === s.members.length - 1 }));
  }
  const sel = sessions.find((s) => s.id === view.selectedId) ?? sessions[0];
  const wantDetail = view.showDetail && Boolean(sel);
  const minDetail = wantDetail ? 12 : 0;
  const room = Math.max(1, Math.min(Math.max(1, rows.length), H - lines.length - minDetail - 2));
  // 표가 다 들어가지 않으면 마지막 줄에 몇 개가 가려졌는지 알린다.
  const clipped = rows.length > room && room > 1;
  const shown = clipped ? room - 1 : room;
  const selRow = Math.max(0, rows.findIndex((r) => !r.m && r.s === sel));
  const lastOfSel = selRow + (sel?.members.length ?? 0);
  const start = Math.min(Math.max(0, lastOfSel - shown + 1), Math.max(0, rows.length - shown), selRow);
  const visible = rows.slice(start, start + shown);
  if (!sessions.length) lines.push(line([{ t: view.filter ? `   '${view.filter}' 에 맞는 세션이 없습니다.` : '   실행 중인 AI 세션이 없습니다.', fg: PALETTE.muted, italic: true }], W));
  for (const r of visible) lines.push(r.m ? memberRow(r.m, r.last, c, W, view.frame) : sessionRow(r.s, c, W, r.s === sel, view.frame));
  if (clipped) {
    const onScreen = new Set(visible.filter((r) => !r.m).map((r) => r.s));
    const hidden = sessions.filter((s) => !onScreen.has(s));
    const waitingHidden = hidden.filter((s) => s.status === 'waiting').length;
    lines.push(line([{ t: `   … +${hidden.length} 세션`, fg: PALETTE.muted }, ...(waitingHidden ? [{ t: ` (응답 대기 ${waitingHidden})`, fg: PALETTE.waiting, bold: true }] : []), { t: '  ↑↓ 로 이동', fg: PALETTE.faint }], W));
  }
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
