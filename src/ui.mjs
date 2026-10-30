// 화면 그리기: 상단 요약 바 → 세션 표(팀원 트리 포함) → 선택한 세션 상세 → 단축키 바.
import { homedir } from 'node:os';
import { width, truncate, pad, fmtTokens, fmtAgo } from './text.mjs';

const NO_COLOR = Boolean(process.env.NO_COLOR);

export const PALETTE = {
  text: '#e6e8ee',
  muted: '#8a90a2',
  faint: '#4b5060',
  line: '#2b2f3a',
  rowSel: '#1d2433',
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
function line(segs, W, bg) {
  let out = '';
  let used = 0;
  for (const seg of segs) {
    if (used >= W) break;
    const t = truncate(seg.t ?? '', W - used);
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
const PHASE_COLOR = { tool: PALETTE.tool, team: PALETTE.team, think: PALETTE.busy, write: PALETTE.busy, waiting: PALETTE.waiting, idle: PALETTE.idle, ended: PALETTE.ended, done: PALETTE.faint };

function glyph(s, frame) {
  const k = s.phase?.kind;
  if (s.status === 'waiting') return { t: frame % 8 < 5 ? '◆' : '◇', fg: PALETTE.waiting, bold: true };
  if (k === 'ended') return { t: '·', fg: PALETTE.ended };
  if (k === 'done') return { t: '✓', fg: PALETTE.faint };
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

const money = (usd) => (usd == null ? '-' : usd >= 1000 ? `$${Math.round(usd).toLocaleString('en-US')}` : usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`);
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
  const idle = count((s) => s.status === 'idle' || s.status === 'live');
  const total = sessions.reduce((a, s) => a + (s.tokens?.total ?? 0), 0);
  const cost = sessions.reduce((a, s) => a + (s.cost ?? 0), 0);
  const B = PALETTE.bar;
  const left = [
    { t: ' ◆ aitop ', fg: '#0b0e14', bg: PALETTE.brand, bold: true },
    { t: '  ', bg: B },
    { t: `${live.length} live`, fg: PALETTE.text, bg: B, bold: true },
    { t: '   ⠿ ', fg: PALETTE.busy, bg: B },
    { t: `${working} 작업 중`, fg: PALETTE.text, bg: B },
    { t: '   ◆ ', fg: PALETTE.waiting, bg: B },
    { t: `${waiting} 응답 대기`, fg: waiting ? PALETTE.waiting : PALETTE.text, bg: B, bold: waiting > 0 },
    { t: '   ○ ', fg: PALETTE.idle, bg: B },
    { t: `${idle} 대기`, fg: PALETTE.text, bg: B },
  ];
  const right = [
    { t: `Σ ${fmtTokens(total)} tok`, fg: PALETTE.muted, bg: B },
    { t: '  ', bg: B },
    { t: money(cost), fg: PALETTE.money, bg: B, bold: true },
    { t: ` API 환산   ${clock(view.data.at)} `, fg: PALETTE.muted, bg: B },
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
  segs.push(h('CONTEXT', c.ctx), h('AGE', c.age, 'right'));
  return line(segs, W);
}

function sessionRow(s, c, W, selected, frame) {
  const bg = selected ? PALETTE.rowSel : undefined;
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
    { t: pad(fmtTokens(s.tokens?.total ?? 0), c.tokens, 'right') + ' ', fg: ended ? PALETTE.ended : PALETTE.text },
  );
  if (c.showCost) segs.push({ t: pad(money(s.cost), c.cost, 'right') + ' ', fg: s.cost == null || ended ? PALETTE.faint : PALETTE.money });
  segs.push(...gauge(s.context?.used ?? 0, s.context?.window ?? 0, 11), { t: ' ' }, { t: pad(fmtAgo(NOW - (s.updatedAt ?? 0)), c.age, 'right'), fg: PALETTE.faint });
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
  if (c.showModel) segs.push({ t: pad(shortModel(m.model), c.model) + ' ', fg: PALETTE.faint });
  segs.push({ ...g, t: g.t + ' ' }, { t: pad(m.name, c.name - 2) + ' ', fg: done ? PALETTE.faint : PALETTE.team });
  if (c.showProject) segs.push({ t: pad(m.task ?? '', c.project) + ' ', fg: PALETTE.faint, italic: true });
  segs.push(
    { t: pad(m.phase?.text ?? '', c.status) + ' ', fg: done ? PALETTE.faint : PHASE_COLOR[m.phase?.kind] ?? PALETTE.muted },
    { t: pad(fmtTokens(m.tokens ?? 0), c.tokens, 'right') + ' ', fg: PALETTE.faint },
  );
  if (c.showCost) segs.push({ t: pad(money(m.cost), c.cost, 'right') + ' ', fg: PALETTE.faint });
  return line(segs, W);
}
let NOW = Date.now();

function box(title, W, H, leftLines, rightLines, leftW, accent) {
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
    out.push(line([{ t: '│ ', fg: PALETTE.line }, ...fill(leftLines[i] ?? [], leftW), { t: ' │ ', fg: PALETTE.line }, ...fill(rightLines[i] ?? [], rightW), { t: ' │', fg: PALETTE.line }], W));
  }
  out.push(line([{ t: '╰' + '─'.repeat(W - 2) + '╯', fg: PALETTE.line }], W));
  return out;
}

function detail(s, W, H, frame) {
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

  const t = s.tokens ?? {};
  L.push([{ t: '토큰 ', fg: PALETTE.muted, bold: true }, { t: fmtTokens(t.total), fg: PALETTE.text, bold: true }, ...(s.cost != null ? [{ t: '   비용 ', fg: PALETTE.muted, bold: true }, { t: money(s.cost), fg: PALETTE.money, bold: true }, { t: ' (API 환산)', fg: PALETTE.faint }] : [])]);
  const parts = [
    ['입력', t.input, '#93c5fd'],
    ['출력', t.output, '#c4b5fd'],
    ['캐시 읽기', t.cacheRead, '#5eead4'],
    ['캐시 쓰기', t.cacheWrite, '#fcd34d'],
  ];
  const barW = Math.max(6, leftW - 20);
  const max = Math.max(1, ...parts.map((p) => p[1] ?? 0));
  for (const [k, v, color] of parts) {
    const n = Math.round(((v ?? 0) / max) * barW);
    L.push([{ t: pad(k, 9), fg: PALETTE.muted }, { t: pad(fmtTokens(v ?? 0), 7, 'right') + ' ', fg: PALETTE.text }, { t: '█'.repeat(n), fg: color }, { t: '░'.repeat(barW - n), fg: PALETTE.line }]);
  }
  if (s.context?.window) {
    L.push([{ t: pad('컨텍스트', 9), fg: PALETTE.muted }, { t: pad(`${fmtTokens(s.context.used)}/${fmtTokens(s.context.window)}`, 11) + ' ', fg: PALETTE.text }, ...gauge(s.context.used, s.context.window, Math.max(4, leftW - 26))]);
  }
  if (s.attachId) {
    L.push([]);
    L.push([{ t: ' ⏎ ', fg: '#0b0e14', bg: PALETTE.muted, bold: true }, { t: ' 이 세션 열기', fg: PALETTE.muted }]);
  }

  const R = [[{ t: '최근 활동', fg: PALETTE.muted, bold: true }]];
  const room = H - 3;
  const icon = { prompt: { t: '❯ ', fg: tc, bold: true }, tool: { t: '• ', fg: PALETTE.tool }, reply: { t: '↳ ', fg: PALETTE.muted } };
  const textColor = { prompt: PALETTE.text, tool: PALETTE.text, reply: PALETTE.muted };
  const events = (s.events ?? []).slice(-room);
  if (!events.length) R.push([{ t: '아직 기록된 활동이 없습니다', fg: PALETTE.faint, italic: true }]);
  for (const e of events) R.push([{ t: clock(e.at) + '  ', fg: PALETTE.faint }, icon[e.kind], { t: e.text, fg: textColor[e.kind], bold: e.kind === 'prompt' }]);

  const title = `${s.name ?? s.tool}  ·  ${s.tool}${s.model ? ' · ' + s.model : ''}`;
  return box(title, W, H, L, R, leftW, tc);
}

function footer(view, W) {
  if (view.toast && view.toast.until > NOW) {
    return line([{ t: ' ' }, { t: ` ${view.toast.text} `, fg: '#0b0e14', bg: view.toast.error ? PALETTE.alert : PALETTE.waiting, bold: true }], W);
  }
  const key = (k) => ({ t: ` ${k} `, fg: '#0b0e14', bg: PALETTE.muted, bold: true });
  const lab = (t) => ({ t: ` ${t}   `, fg: PALETTE.muted });
  const segs = [{ t: ' ' }, key('↑↓'), lab('선택'), key('⏎'), lab('세션 열기'), key('d'), lab(view.showDetail ? '상세 닫기' : '상세 열기'), key('e'), lab(view.showEnded ? '종료 숨기기' : '종료 포함'), key('q'), lab('나가기')];
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
  const { sessions, errors } = view.data;
  const c = columns(W);
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
  const selRow = Math.max(0, rows.findIndex((r) => !r.m && r.s === sel));
  const lastOfSel = selRow + (sel?.members.length ?? 0);
  const start = Math.min(Math.max(0, lastOfSel - room + 1, 0), Math.max(0, rows.length - room), selRow);
  if (!sessions.length) lines.push(line([{ t: '   실행 중인 AI 세션이 없습니다.', fg: PALETTE.muted, italic: true }], W));
  for (const r of rows.slice(start, start + room)) lines.push(r.m ? memberRow(r.m, r.last, c, W, view.frame) : sessionRow(r.s, c, W, r.s === sel, view.frame));
  if (wantDetail) {
    lines.push(line([], W));
    lines.push(...detail(sel, W, Math.max(minDetail, H - lines.length - 1), view.frame));
  }
  if (errors?.length) lines[lines.length - 1] = line([{ t: ' ! ' + errors.join(' / '), fg: PALETTE.alert }], W);
  while (lines.length < H - 1) lines.push(line([], W));
  lines.length = H - 1;
  lines.push(footer(view, W));
  return lines;
}
