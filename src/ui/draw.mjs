// 그리기 기본: 조각(segment) 줄 만들기·자르기·채우기, 상자, 가로줄, 게이지, 시각·금액 표기.
import { fmtElapsed, pad, stripControl, truncate, width } from '../text.mjs';
import { homedir } from 'node:os';
import { tildeIn } from '../paths.mjs';
import { NO_COLOR, PALETTE, PHASE_COLOR, RESET, linksOn, osc8, style } from './theme.mjs';
import { artifactLink } from '../sources/artifacts.mjs';
import { glyphs } from './glyphs.mjs';
import { t as tr } from '../i18n.mjs';
import { MEMBER_STALL_LONG_MS } from '../sources/common.mjs';

// segs: [{ t: 텍스트, ...style }]. 폭 W 에 맞춰 자르고, 남는 칸은 bg 로 채운다.
// 화면에 나가는 글자는 모두 여기를 지나므로, 기록에서 온 제어문자도 여기서 한 번 더 지운다.
export function line(segs, W, bg) {
  let out = '';
  let used = 0;
  for (const seg of segs) {
    if (used >= W) break;
    const t = truncate(stripControl(seg.t ?? ''), W - used);
    // link: 아티팩트 주소 (#305). 허용 목록을 다시 지난 주소만, 링크를 켠 터미널에서만 OSC 8 로 감싼다. 폭은 t 로만 센다.
    const url = seg.link && linksOn() ? artifactLink(seg.link) : null;
    out += style({ bg, ...seg }) + (url && t ? osc8(url, t) : t);
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
  const G = glyphs();
  if (s.status === 'waiting') return { t: frame % 8 < 5 ? G.waiting : G.waitingBlink, fg: PALETTE.waiting, bold: true };
  if (k === 'ended') return { t: G.ended, fg: PALETTE.ended };
  if (k === 'done') return { t: G.done, fg: PALETTE.info };
  if (k === 'unseen') return { t: G.unseen, fg: PALETTE.busy, bold: true };
  // 오류로 멈춤: 돌지 않는 기호(G.stopped)로 작업 중(스피너)과 구분한다.
  if (k === 'stopped') return { t: G.stopped, fg: PALETTE.alert, bold: true };
  if (k === 'idle') return s.status === 'live' ? { t: G.live, fg: PALETTE.tools[s.tool] } : { t: G.idle, fg: PALETTE.idle };
  return { t: SPIN[frame % SPIN.length], fg: PHASE_COLOR[k] ?? PALETTE.busy, bold: true };
}

// glyph 가 frame 에 따라 모양을 바꾸는지 (응답 대기 깜빡임, 작업 중 스피너).
// SAFE 세트처럼 응답 대기 기호가 깜빡이지 않으면 응답 대기만으로는 다시 그리지 않는다.
export const glyphMoves = (s) => (s.status === 'waiting' ? glyphs().waiting !== glyphs().waitingBlink : !['ended', 'done', 'unseen', 'idle', 'stopped'].includes(s.phase?.kind));

// 막대는 같은 높이의 얇은 블록(▃)으로 그리고 채운 칸과 빈칸은 색으로 나눈다. 칸 높이가 모두 같아 끝이 튀어나오지 않는다.
// 색이 없으면 █ 와 ░ 로 모양을 가른다. 기호는 glyphs().bar 에 있다.

// 0% 보다 크면 최소 1칸, 100% 가 아니면 마지막 칸은 비워 둔다.
export function filledCells(r, cells) {
  if (r <= 0) return 0;
  if (r >= 1) return cells;
  return Math.min(cells - 1, Math.max(1, Math.round(r * cells)));
}

export function gauge(used, total, cells) {
  const BAR = glyphs().bar;
  if (!total) return [{ t: BAR.empty.repeat(cells) + '     ', fg: PALETTE.faint }];
  const r = Math.min(1, Math.max(0, used / total || 0));
  const pct = Math.round(r * 100);
  // 0% 로 보이면 칸도 채우지 않는다.
  const full = cells && pct > 0 ? filledCells(r, cells) : 0;
  const color = r >= 0.85 ? PALETTE.alert : r >= 0.6 ? PALETTE.text : PALETTE.busy;
  // 색이 없어도 보이게 60% 이상은 ~, 85% 이상은 ! 를 붙인다.
  const mark = r >= 0.85 ? '!' : r >= 0.6 ? '~' : '';
  return [
    { t: BAR.fill.repeat(full), fg: color },
    { t: BAR.empty.repeat(cells - full), fg: PALETTE.faint },
    { t: pad(`${mark}${pct}%`, 5, 'right'), fg: r >= 0.85 ? PALETTE.alert : PALETTE.muted },
  ];
}

export const dollars = (usd) => (usd >= 1000 ? `$${Math.round(usd).toLocaleString('en-US')}` : usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`);

// 비용을 모르는 도구는 '-'. 가격표에 없는 모델이 섞이면 아는 몫만 보이고(표시는 붙이지 않는다), 아는 몫이 없으면 '-'.
// 가격표에 없는 모델이 섞였는지는 --json 의 unpriced·costUnknown 과 상세 패널 안내 줄로 알린다.
// 비용 표시 기준: 'api' 는 API 정가 환산(캐시 포함), 'net' 은 캐시 읽기·쓰기를 뺀 입력·출력만.
export const costOf = (x, mode = 'api') => (mode === 'net' ? x?.costNoCache ?? null : x?.cost ?? null);

export function money(usd, unknown = false) {
  if (usd == null) return '-';
  if (unknown && !(usd > 0)) return '-';
  return dollars(usd);
}

// 홈 폴더로 시작하는 경로만 줄인다. Windows 는 \ 와 대소문자를 무시한다 (paths.mjs).
export const tilde = (p) => tildeIn(p, homedir());

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

// title: 조각 배열 또는 문자열. leftLines 가 null 이면 칸을 나누지 않고 rightLines 가 안쪽 전체 폭(W - 4)을 쓴다.
export function box(title, W, H, leftLines, rightLines, leftW, accent, focused = false) {
  const E = glyphs().edge;
  const e = focused && NO_COLOR ? E.heavy : E.normal;
  const fg = focused ? PALETTE.brand : PALETTE.line;
  const out = [];
  const titleSegs = typeof title === 'string' ? [{ t: title, fg: accent, bold: true }] : title;
  const titleW = segsWidth(titleSegs) + 2;
  out.push(line([{ t: e.tl + e.h, fg }, { t: ' ' }, ...titleSegs, { t: ' ' }, { t: e.h.repeat(Math.max(0, W - 3 - titleW)) + e.tr, fg }], W));
  // '│ ' + 왼쪽 + ' │ ' + 오른쪽 + ' │' = W
  const rightW = W - leftW - 7;
  for (let i = 0; i < H - 2; i++) {
    const body = leftLines ? [...fill(leftLines[i] ?? [], leftW), { t: ` ${e.v} `, fg }, ...fill(rightLines[i] ?? [], rightW)] : fill(rightLines[i] ?? [], W - 4);
    out.push(line([{ t: `${e.v} `, fg }, ...body, { t: ` ${e.v}`, fg }], W));
  }
  out.push(line([{ t: e.bl + e.h.repeat(W - 2) + e.br, fg }], W));
  return out;
}

export const hhmm = (ms) => clock(ms).slice(0, 5);

// ── 라벨 ───────── 메타 ─. 오른쪽 칸의 구획(변경 파일·최근 활동·diff)을 나누는 가로줄.
// 폭이 모자라면 메타부터 뺀다.
export function rule(label, meta, w, color = PALETTE.line) {
  const h = glyphs().rule;
  const head = [{ t: h + h + ' ', fg: color }, ...label];
  const headW = head.reduce((a, x) => a + width(x.t), 0);
  const tail = meta && headW + width(meta) + 4 <= w ? [{ t: ` ${meta} `, fg: PALETTE.info }, { t: h, fg: color }] : [];
  const used = [...head, ...tail].reduce((a, x) => a + width(x.t), 0);
  return [...head, { t: ' ' + h.repeat(Math.max(0, w - used - 1)), fg: color }, ...tail];
}

// 값 목록을 ▁▂…█ 막대로. 가장 큰 값을 █ 로 맞추고, 0 은 장식 색(faint) ▁, 0 보다 크면 ▂ 이상이라 색이 없어도 갈린다.
// 헤더 7일 막대(table.mjs weekBar)와 상세 패널의 시간별 활동 막대가 같이 쓴다.
// AITOP_AMBIGUOUS=wide 이면 ▁…█ 대신 1칸 ASCII 막대(glyphs().week)를 쓴다.
export function levelBar(values) {
  const bars = glyphs().week;
  const v = values.map((x) => Math.max(0, x ?? 0));
  const max = Math.max(0, ...v);
  return v.map((x) => (!(x > 0) || !(max > 0) ? { t: bars[0], fg: PALETTE.faint } : { t: bars[Math.min(7, Math.max(1, Math.ceil((x / max) * 7)))], fg: PALETTE.info }));
}

// 프롬프트 캐시 만료까지 남은 시간 (claude.mjs cacheOf). 남은 시간은 m:ss 로, 1분 미만이면 경고색, 만료면 흐린 '캐시 만료'.
// 초 단위로 바뀌지만 타이머를 따로 두지 않는다: 실시간 화면은 데이터 갱신(1초마다)에 맞춰 다시 그리므로 그때 바뀐다.
// 그래서 animating() 에 넣지 않고, 스피너가 없는 화면에서 120ms 프레임 타이머를 깨우지 않는다.
export const CACHE_WARN_MS = 60_000;
// warn: 1분 미만 남은 경고 단계. STATUS 칸이 좁아도 상태 글보다 먼저 남는다 (table.mjs statusCell).
export function cacheState(s, now = NOW) {
  if (s?.cacheExpiresAt == null || !s.live || (s.status !== 'waiting' && s.status !== 'idle')) return null;
  const left = s.cacheExpiresAt - now;
  const ttl = tr(s.cacheTtl >= 3600 ? 'cache.ttl1h' : 'cache.ttl5m');
  if (left <= 0) return { expired: true, ttl, text: tr('cache.expired'), fg: PALETTE.faint };
  const sec = Math.ceil(left / 1000);
  const t = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  return { expired: false, ttl, left: t, text: tr('cache.left', { t }), fg: left < CACHE_WARN_MS ? PALETTE.alert : PALETTE.info, bold: left < CACHE_WARN_MS, warn: left < CACHE_WARN_MS };
}

// 지금 도는 도구의 경과 시간 (수집기의 toolStartedAt). 작업 중이고 진행 단계가 도구 실행인 세션만 본다.
// 1분 미만은 대부분의 도구 호출이 끝나는 시간이라 보이지 않는다 (짧은 도구마다 숫자가 깜빡이지 않게).
// TOOL_LONG_MS(10분) 이상이면 흐린 경고색이고 warn 으로 표시해 STATUS 칸에서 상태 글보다 오래 남는다: Claude Code 의 Bash 시간 제한이 최대 10분이라 #233 의 '멈춘 듯' 긴 기준과 같은 값을 쓴다.
// 형식은 팀원 행 경과 시간과 같은 fmtElapsed 다. 이 세션은 작업 중이라 스피너가 돌고(animating) 그 틱에 실려 바뀌므로 타이머를 따로 두지 않는다.
export const TOOL_SHOW_MS = 60_000;
export const TOOL_LONG_MS = MEMBER_STALL_LONG_MS;
export function toolElapsed(s, now = NOW) {
  if (!Number.isFinite(s?.toolStartedAt) || s.status !== 'busy' || s.phase?.kind !== 'tool') return null;
  const ms = now - s.toolStartedAt;
  if (ms < TOOL_SHOW_MS) return null;
  const long = ms >= TOOL_LONG_MS;
  return { text: fmtElapsed(ms), fg: long ? PALETTE.alert : PALETTE.info, dim: long, long, warn: long };
}
