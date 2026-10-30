// 화면 그리기: 상단 요약 바 → 세션 표 → 선택한 세션 상세(토큰·팀원·최근 활동) → 단축키 바.
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
  shell: '#38bdf8',
  idle: '#8a90a2',
  ended: '#4b5060',
  alert: '#f87171',
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

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const LABEL = { busy: '작업 중', waiting: '응답 대기', shell: '쉘 실행', idle: '쉬는 중', ended: '종료', live: '실행 중' };

function statusGlyph(s, frame) {
  switch (s.status) {
    case 'busy':
      return { t: SPIN[frame % SPIN.length], fg: PALETTE.busy, bold: true };
    case 'waiting':
      return { t: frame % 8 < 5 ? '◆' : '◇', fg: PALETTE.waiting, bold: true };
    case 'shell':
      return { t: '◐', fg: PALETTE.shell };
    case 'live':
      return { t: '●', fg: PALETTE.tools[s.tool] };
    case 'ended':
      return { t: '·', fg: PALETTE.ended };
    default:
      return { t: '○', fg: PALETTE.idle };
  }
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

const tilde = (p) => (p ?? '').replace(homedir(), '~');
const two = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

// 한 행 = 표시(1) + 상태(2) + 각 열 뒤 공백 1칸. CONTEXT 는 게이지 11 + 퍼센트 5.
function columns(W) {
  const fixed = { mark: 1, status: 2, tool: 7, tokens: 7, ctx: 16, age: 4 };
  const showProject = W >= 100;
  const gaps = showProject ? 7 : 6;
  const flex = W - Object.values(fixed).reduce((a, b) => a + b, 0) - gaps - 1;
  const name = Math.max(14, Math.min(34, Math.floor(flex * 0.3)));
  const project = showProject ? Math.max(10, Math.min(24, Math.floor(flex * 0.2))) : 0;
  const now = Math.max(10, flex - name - project);
  return { ...fixed, name, project, now, showProject };
}

function header(view, W) {
  const { sessions } = view.data;
  const live = sessions.filter((s) => s.live);
  const count = (st) => live.filter((s) => s.status === st).length;
  const total = sessions.reduce((a, s) => a + (s.tokens?.total ?? 0), 0);
  const B = PALETTE.bar;
  const left = [
    { t: ' ◆ aitop ', fg: '#0b0e14', bg: PALETTE.brand, bold: true },
    { t: '  ', bg: B },
    { t: `${live.length} live`, fg: PALETTE.text, bg: B, bold: true },
    { t: '   ', bg: B },
    { t: '⠿ ', fg: PALETTE.busy, bg: B },
    { t: `${count('busy')} 작업 중`, fg: PALETTE.text, bg: B },
    { t: '   ◆ ', fg: PALETTE.waiting, bg: B },
    { t: `${count('waiting')} 응답 대기`, fg: count('waiting') ? PALETTE.waiting : PALETTE.text, bg: B, bold: count('waiting') > 0 },
    { t: '   ○ ', fg: PALETTE.idle, bg: B },
    { t: `${count('idle') + count('shell')} 쉬는 중`, fg: PALETTE.text, bg: B },
  ];
  const right = `Σ ${fmtTokens(total)} tok   ${clock(view.data.at)} `;
  const leftW = left.reduce((a, s) => a + width(s.t), 0);
  const gap = Math.max(1, W - leftW - width(right));
  return line([...left, { t: ' '.repeat(gap), bg: B }, { t: right, fg: PALETTE.muted, bg: B }], W, B);
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
  const segs = [{ t: ' '.repeat(c.mark + c.status) }, h('TOOL', c.tool), h('SESSION', c.name)];
  if (c.showProject) segs.push(h('PROJECT', c.project));
  segs.push(h('NOW', c.now), h('TOKENS', c.tokens, 'right'), h('CONTEXT', c.ctx), h('AGE', c.age, 'right'));
  return line(segs, W);
}

function row(s, c, W, selected, frame) {
  const bg = selected ? PALETTE.rowSel : undefined;
  const ended = s.status === 'ended';
  const tc = PALETTE.tools[s.tool];
  const segs = [
    { t: selected ? '▌' : ' ', fg: tc },
    { ...statusGlyph(s, frame), t: statusGlyph(s, frame).t + ' ' },
    { t: pad(s.tool, c.tool) + ' ', fg: ended ? PALETTE.ended : tc, bold: !ended },
    { t: pad(s.name ?? '', c.name) + ' ', fg: ended ? PALETTE.ended : PALETTE.text, bold: selected },
  ];
  if (c.showProject) segs.push({ t: pad(s.project ?? '', c.project) + ' ', fg: PALETTE.muted });
  segs.push(
    s.now
      ? { t: pad(s.now, c.now) + ' ', fg: ended ? PALETTE.ended : s.status === 'busy' ? PALETTE.text : PALETTE.muted }
      : { t: pad('기록 없음', c.now) + ' ', fg: PALETTE.faint, italic: true },
    { t: pad(fmtTokens(s.tokens?.total ?? 0), c.tokens, 'right') + ' ', fg: ended ? PALETTE.ended : PALETTE.text },
    ...gauge(s.context?.used ?? 0, s.context?.window ?? 0, 11),
    { t: ' ' },
    { t: pad(fmtAgo(NOW - (s.updatedAt ?? 0)), c.age, 'right'), fg: PALETTE.faint },
  );
  return line(segs, W, bg);
}
let NOW = Date.now();

function box(title, W, H, leftLines, rightLines, leftW, accent) {
  const out = [];
  const inner = W - 2;
  const titleText = ` ${title} `;
  const top = [{ t: '╭─', fg: PALETTE.line }, { t: titleText, fg: accent, bold: true }, { t: '─'.repeat(Math.max(0, inner - 1 - width(titleText))) + '╮', fg: PALETTE.line }];
  out.push(line(top, W));
  // '│ ' + 왼쪽 + ' │ ' + 오른쪽 + ' │' = W
  const rightW = W - leftW - 7;
  const fill = (segs, n) => {
    const c = clip(segs, n);
    return [...c, { t: ' '.repeat(Math.max(0, n - c.reduce((a, s) => a + width(s.t), 0))) }];
  };
  for (let i = 0; i < H - 2; i++) {
    out.push(line([{ t: '│ ', fg: PALETTE.line }, ...fill(leftLines[i] ?? [], leftW), { t: ' │ ', fg: PALETTE.line }, ...fill(rightLines[i] ?? [], rightW), { t: ' │', fg: PALETTE.line }], W));
  }
  out.push(line([{ t: '╰' + '─'.repeat(inner) + '╯', fg: PALETTE.line }], W));
  return out;
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

function detail(s, W, H, frame) {
  const tc = PALETTE.tools[s.tool];
  const leftW = Math.min(44, Math.max(30, Math.floor((W - 4) * 0.38)));
  const L = [];
  const kv = (k, v, fg = PALETTE.text) => L.push([{ t: pad(k, 9), fg: PALETTE.muted }, { t: v ?? '-', fg }]);

  const st = statusGlyph(s, frame);
  L.push([{ ...st, t: st.t + ' ' }, { t: LABEL[s.status] ?? s.status, fg: st.fg, bold: true }, ...(s.waitingFor ? [{ t: `  (${s.waitingFor})`, fg: PALETTE.waiting }] : [])]);
  kv('폴더', tilde(s.cwd));
  if (s.branch) kv('브랜치', s.branch);
  kv('모델', s.model ?? '-');
  kv('종류', `${s.kind ?? '-'}${s.pid ? ` · pid ${s.pid}` : ''}`);
  if (s.startedAt) kv('시작', `${clock(s.startedAt)}  (${fmtAgo(NOW - s.startedAt)} 전)`);
  L.push([]);

  const t = s.tokens ?? {};
  L.push([{ t: '토큰 ', fg: PALETTE.muted, bold: true }, { t: fmtTokens(t.total), fg: PALETTE.text, bold: true }]);
  const parts = [
    ['입력', t.input, '#93c5fd'],
    ['출력', t.output, '#c4b5fd'],
    ['캐시 읽기', t.cacheRead, '#5eead4'],
    ['캐시 쓰기', t.cacheWrite, '#fcd34d'],
  ];
  if (t.sub) parts.push(['팀원 합계', t.sub, '#f9a8d4']);
  const barW = Math.max(6, leftW - 20);
  const max = Math.max(1, ...parts.map((p) => p[1] ?? 0));
  for (const [k, v, color] of parts) {
    const n = Math.round(((v ?? 0) / max) * barW);
    L.push([{ t: pad(k, 9), fg: PALETTE.muted }, { t: pad(fmtTokens(v ?? 0), 7, 'right') + ' ', fg: PALETTE.text }, { t: '█'.repeat(n), fg: color }, { t: '░'.repeat(barW - n), fg: PALETTE.line }]);
  }
  if (s.context?.window) {
    L.push([{ t: pad('컨텍스트', 9), fg: PALETTE.muted }, { t: pad(`${fmtTokens(s.context.used)}/${fmtTokens(s.context.window)}`, 11) + ' ', fg: PALETTE.text }, ...gauge(s.context.used, s.context.window, Math.max(4, leftW - 26))]);
  }

  if (s.members?.length) {
    L.push([]);
    L.push([{ t: `팀원 ${s.members.length}`, fg: PALETTE.muted, bold: true }]);
    for (const m of s.members) {
      const g = m.status === 'busy' ? { t: SPIN[frame % SPIN.length], fg: PALETTE.busy } : m.status === 'done' ? { t: '✓', fg: PALETTE.faint } : { t: '○', fg: PALETTE.idle };
      L.push([{ ...g, t: g.t + ' ' }, { t: pad(m.name, 15) + ' ', fg: m.status === 'done' ? PALETTE.faint : PALETTE.text }, { t: m.status === 'done' ? m.task : m.now ?? m.task, fg: PALETTE.muted }]);
    }
  }

  const R = [[{ t: '최근 활동', fg: PALETTE.muted, bold: true }]];
  const room = H - 3;
  const icon = { prompt: { t: '❯ ', fg: tc, bold: true }, tool: { t: '• ', fg: PALETTE.shell }, reply: { t: '↳ ', fg: PALETTE.muted } };
  const textColor = { prompt: PALETTE.text, tool: PALETTE.text, reply: PALETTE.muted };
  const events = (s.events ?? []).slice(-room);
  if (!events.length) R.push([{ t: s.now || '아직 기록된 활동이 없습니다', fg: PALETTE.faint, italic: true }]);
  for (const e of events) {
    R.push([{ t: clock(e.at) + '  ', fg: PALETTE.faint }, icon[e.kind], { t: e.text, fg: textColor[e.kind], bold: e.kind === 'prompt' }]);
  }

  const title = `${s.name ?? s.tool}  ·  ${s.tool}${s.model ? ' · ' + s.model : ''}`;
  return box(title, W, H, L, R, leftW, tc);
}

function footer(view, W) {
  const key = (k) => ({ t: ` ${k} `, fg: '#0b0e14', bg: PALETTE.muted, bold: true });
  const lab = (t) => ({ t: ` ${t}   `, fg: PALETTE.muted });
  const segs = [{ t: ' ' }, key('↑↓'), lab('선택'), key('⏎'), lab(view.showDetail ? '상세 닫기' : '상세 열기'), key('e'), lab(view.showEnded ? '종료 숨기기' : '종료 포함'), key('q'), lab('나가기')];
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

  const wantDetail = view.showDetail && sessions.length > 0;
  const minDetail = wantDetail ? 12 : 0;
  const tableRoom = Math.max(1, Math.min(Math.max(1, sessions.length), H - lines.length - minDetail - 2));
  const sel = Math.max(0, sessions.findIndex((s) => s.id === view.selectedId));
  const start = Math.min(Math.max(0, sel - tableRoom + 1), Math.max(0, sessions.length - tableRoom));
  const visible = sessions.slice(start, start + tableRoom);
  if (!sessions.length) lines.push(line([{ t: '   실행 중인 AI 세션이 없습니다.', fg: PALETTE.muted, italic: true }], W));
  for (const s of visible) lines.push(row(s, c, W, s.id === sessions[sel]?.id, view.frame));
  if (wantDetail) {
    lines.push(line([], W));
    lines.push(...detail(sessions[sel], W, Math.max(minDetail, H - lines.length - 1), view.frame));
  }
  if (errors?.length) lines[lines.length - 1] = line([{ t: ' ! ' + errors.join(' / '), fg: PALETTE.alert }], W);
  while (lines.length < H - 1) lines.push(line([], W));
  lines.length = H - 1;
  lines.push(footer(view, W));
  return lines;
}
