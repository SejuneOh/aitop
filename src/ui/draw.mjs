// 그리기 기본: 조각(segment) 줄 만들기·자르기·채우기, 상자, 가로줄, 게이지, 시각·금액 표기.
import { pad, stripControl, truncate, width } from '../text.mjs';
import { homedir } from 'node:os';
import { EDGE, NO_COLOR, PALETTE, PHASE_COLOR, RESET, style } from './theme.mjs';

// segs: [{ t: 텍스트, ...style }]. 폭 W 에 맞춰 자르고, 남는 칸은 bg 로 채운다.
// 화면에 나가는 글자는 모두 여기를 지나므로, 기록에서 온 제어문자도 여기서 한 번 더 지운다.
export function line(segs, W, bg) {
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
export const segsWidth = (segs) => segs.reduce((a, x) => a + width(x.t ?? ''), 0);

export function clip(segs, max) {
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

export const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

export function glyph(s, frame) {
  const k = s.phase?.kind;
  if (s.status === 'waiting') return { t: frame % 8 < 5 ? '◆' : '◇', fg: PALETTE.waiting, bold: true };
  if (k === 'ended') return { t: '·', fg: PALETTE.ended };
  if (k === 'done') return { t: '✓', fg: PALETTE.faint };
  if (k === 'unseen') return { t: '●', fg: PALETTE.busy, bold: true };
  if (k === 'idle') return s.status === 'live' ? { t: '●', fg: PALETTE.tools[s.tool] } : { t: '○', fg: PALETTE.idle };
  return { t: SPIN[frame % SPIN.length], fg: PHASE_COLOR[k] ?? PALETTE.busy, bold: true };
}

// 막대는 같은 높이의 얇은 블록(▃)으로 그리고 채운 칸과 빈칸은 색으로 나눈다. 칸 높이가 모두 같아 끝이 튀어나오지 않는다.
// 색이 없으면 빈칸을 가장 얇은 ▁ 로 그려 모양으로 구분한다.
export const BAR = { fill: '▃', empty: NO_COLOR ? '▁' : '▃' };

// 0% 보다 크면 최소 1칸, 100% 가 아니면 마지막 칸은 비워 둔다.
export function filledCells(r, cells) {
  if (r <= 0) return 0;
  if (r >= 1) return cells;
  return Math.min(cells - 1, Math.max(1, Math.round(r * cells)));
}

export function gauge(used, total, cells) {
  if (!total) return [{ t: BAR.empty.repeat(cells) + '     ', fg: PALETTE.faint }];
  const r = Math.min(1, Math.max(0, used / total || 0));
  const full = cells ? filledCells(r, cells) : 0;
  const color = r >= 0.85 ? PALETTE.alert : r >= 0.6 ? PALETTE.waiting : PALETTE.busy;
  return [
    { t: BAR.fill.repeat(full), fg: color },
    { t: BAR.empty.repeat(cells - full), fg: PALETTE.faint },
    // 85% 이상은 색이 없어도 보이게 ! 를 붙인다.
    { t: pad(`${r >= 0.85 ? '!' : ''}${Math.round(r * 100)}%`, 5, 'right'), fg: r >= 0.85 ? PALETTE.alert : PALETTE.muted },
  ];
}

export const dollars = (usd) => (usd >= 1000 ? `$${Math.round(usd).toLocaleString('en-US')}` : usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`);

// 비용을 모르는 도구는 '-'. 가격표에 없는 모델이 섞이면 아는 몫 뒤에 '?' 를 붙이고, 아는 몫이 없으면 '?' 만 보인다.
// 비용 표시 기준: 'api' 는 API 정가 환산(캐시 포함), 'net' 은 캐시 읽기·쓰기를 뺀 입력·출력만.
export const costOf = (x, mode = 'api') => (mode === 'net' ? x?.costNoCache ?? null : x?.cost ?? null);

export function money(usd, unknown = false) {
  if (usd == null) return '-';
  if (unknown) return usd > 0 ? `${dollars(usd)}?` : '?';
  return dollars(usd);
}

export const tilde = (p) => (p ?? '').replace(homedir(), '~');

export const two = (n) => String(n).padStart(2, '0');

export const clock = (ms) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

// 한 행 = 표시(1) + 상태 기호(2) + 각 열 + 열 뒤 공백 1칸. CONTEXT 는 게이지 11 + 퍼센트 5.
export const shortModel = (m) => (m ? m.replace(/^claude-/, '') : '-');

export let NOW = Date.now();
export function setNow(t) {
  NOW = t;
}

// segs 를 폭 n 에 맞춰 자르고 남는 칸을 공백으로 채운다. bg 를 주면 칸 끝까지 그 배경을 깐다.
export function fill(segs, n, bg) {
  const c = clip(segs, n);
  const out = [...c, { t: ' '.repeat(Math.max(0, n - c.reduce((a, x) => a + width(x.t), 0))) }];
  return bg ? out.map((x) => ({ bg, ...x })) : out;
}

// title: 조각 배열 또는 문자열.
export function box(title, W, H, leftLines, rightLines, leftW, accent, focused = false) {
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

export const hhmm = (ms) => clock(ms).slice(0, 5);

// ── 라벨 ───────── 메타 ─. 오른쪽 칸의 구획(변경 파일·최근 활동·diff)을 나누는 가로줄.
// 폭이 모자라면 메타부터 뺀다.
export function rule(label, meta, w, color = PALETTE.line) {
  const head = [{ t: '── ', fg: color }, ...label];
  const headW = head.reduce((a, x) => a + width(x.t), 0);
  const tail = meta && headW + width(meta) + 4 <= w ? [{ t: ` ${meta} `, fg: PALETTE.faint }, { t: '─', fg: color }] : [];
  const used = [...head, ...tail].reduce((a, x) => a + width(x.t), 0);
  return [...head, { t: ' ' + '─'.repeat(Math.max(0, w - used - 1)), fg: color }, ...tail];
}
