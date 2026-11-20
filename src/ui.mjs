// 화면 그리기: 상단 요약 바 → 세션 표(팀원 트리 포함) → 선택한 세션 상세 → 단축키 바.
import { width } from './text.mjs';
import { BRAND } from './brand.mjs';
import { PALETTE } from './ui/theme.mjs';
import { glyphMoves, line, setNow } from './ui/draw.mjs';
import { glyphs } from './ui/glyphs.mjs';
import { TABLE_BOX_H, columns, emptyLines, filterSessions, groupRow, header, memberRow, sessionRow, tableBox, tableHeader, toolStrip, topCost } from './ui/table.mjs';
import { detail } from './ui/detail.mjs';
import { detailOpen, footer, help } from './ui/chrome.mjs';
import { arrange } from './order.mjs';
import { callsYou } from './attention.mjs';
import { t } from './i18n.mjs';

export { PALETTE, style } from './ui/theme.mjs';
export { money } from './ui/draw.mjs';
export { filterSessions } from './ui/table.mjs';
export { DETAIL_MIN_H, detailOpen } from './ui/chrome.mjs';

// 프레임마다 바뀌는 표시(세션 스피너·응답 대기 깜빡임, 일하는 팀원 스피너)가 화면에 있는지.
// 표에서 가려진 세션까지 셈에 넣으므로, 실제보다 조금 더 자주 그릴 수는 있어도 덜 그리지는 않는다.
export function animating(view) {
  if (!view.data || view.help) return false;
  return filterSessions(view.data.sessions, view.filter).some((s) => glyphMoves(s) || (s.members ?? []).some((m) => m.status !== 'done'));
}

// 터미널이 아닌 곳(파이프·파일)으로 내는 --once 용 (#292). render 결과에서 맨 아래 키 안내 줄과,
// 화면 높이를 맞추려고 채운 빈 줄(끝의 빈 줄, 상세 상자 아래쪽의 테두리만 있는 줄)과 줄 끝 공백을 뺀다.
// 테두리 글자는 지금 기호 세트(AITOP_AMBIGUOUS=wide 면 ASCII)에서 고른다.
// 색 코드와 OSC 8 링크 머리·꼬리 (#305).
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const plain = (l) => l.replace(ANSI, '');
// 줄 끝의 공백과 색 코드를 지운다. 색 코드가 있던 줄은 끝에 초기화(ESC[0m)를 붙여 색이 다음 줄로 번지지 않게 한다.
const trimEnd = (l) => {
  const cut = l.replace(/(?:\s|\x1b\[[0-9;]*m)+$/, '');
  return cut !== l && /\x1b\[/.test(l) && /\x1b\[/.test(cut) ? cut + '\x1b[0m' : cut;
};
export function pipeLines(lines) {
  const E = Object.values(glyphs().edge);
  const vert = new Set(E.map((e) => e.v));
  const filler = (l) => [...plain(l)].every((ch) => /\s/.test(ch) || vert.has(ch));
  const isBottom = (l) => E.some((e) => plain(l).startsWith(e.bl + e.h));
  const out = lines.slice(0, -1);
  while (out.length && !plain(out.at(-1)).trim()) out.pop();
  // 마지막 줄이 상자 아래 테두리면 그 바로 위의 빈 칸 줄들을 지운다.
  const bottom = out.length - 1;
  if (bottom >= 1 && isBottom(out[bottom])) {
    let top = bottom;
    while (top > 1 && filler(out[top - 1])) top--;
    out.splice(top, bottom - top);
  }
  return out.map(trimEnd);
}

// 로딩 중(준비 완료 전이거나 7일 집계 중)에는 경과 시간(IDLE 등)을 데이터를 받은 시각에 맞춰, 스피너 프레임마다 숫자가 따로 바뀌지 않게 한다.
const settling = (view) => view.data && (view.ready === false || view.data.usage?.loading != null);

export function render(view, W, H) {
  setNow(settling(view) && view.data.at ? view.data.at : Date.now());
  const lines = [];
  if (!view.data) {
    // 첫 수집은 동기로 돌아 이 화면이 다시 그려지지 않으므로 움직이지 않는 로고를 둔다.
    const msg = `${BRAND.logo}  ${t('ui.loading')}`;
    for (let i = 0; i < H; i++) lines.push(i === Math.floor(H / 2) ? line([{ t: ' '.repeat(Math.max(0, Math.floor((W - width(msg)) / 2))) }, { t: msg, fg: PALETTE.brand }], W) : line([], W));
    return lines;
  }
  const { errors } = view.data;
  const { sessions, groups } = arrange(filterSessions(view.data.sessions, view.filter), view);
  const boxed = H >= TABLE_BOX_H && W >= 60;
  const TW = boxed ? W - 4 : W;
  const c = columns(TW);
  if (view.help) {
    lines.push(header(view, W), ...help(W, Math.max(3, H - 2), view, detailOpen(view, H)));
    lines.length = H - 1;
    lines.push(footer({ ...view, showDetail: detailOpen(view, H) }, W, sessions.length));
    return lines;
  }
  lines.push(header(view, W), toolStrip(view, W));
  if (!boxed) lines.push(line([], W));
  const table = [tableHeader(c, TW)];

  const rows = [];
  const pushSession = (s) => {
    rows.push({ s });
    s.members.forEach((m, i) => rows.push({ s, m, last: i === s.members.length - 1 }));
  };
  if (groups) {
    for (const g of groups) {
      rows.push({ g });
      g.sessions.forEach(pushSession);
    }
  } else sessions.forEach(pushSession);
  const sel = sessions.find((s) => s.id === view.selectedId) ?? sessions[0];
  const open = detailOpen(view, H);
  const wantDetail = open && Boolean(sel);
  let minDetail = wantDetail ? 12 : 0;
  const used = lines.length + table.length + (boxed ? 2 : 0);
  let room = Math.max(1, Math.min(Math.max(1, rows.length), H - used - minDetail - 2));
  // 표가 다 들어가지 않으면 마지막 줄에 몇 개가 가려졌는지 알린다.
  // 고른 세션 한 줄밖에 안 남으면 상세 패널에서 한 줄을 가져와 그 알림 줄을 둔다.
  // 화면 자체가 표 두 줄(맨 아래 키 줄 제외)을 못 담으면 알림 없이 고른 세션 행만 남긴다.
  if (rows.length > room && room < 2 && H - used - 1 >= 2) {
    room = 2;
    minDetail = Math.max(0, minDetail - 1);
  }
  const clipped = rows.length > room && room > 1;
  const shown = clipped ? room - 1 : room;
  const selRow = Math.max(0, rows.findIndex((r) => r.s && !r.m && r.s === sel));
  const lastOfSel = selRow + (sel?.members.length ?? 0);
  let start = Math.min(Math.max(0, lastOfSel - shown + 1), Math.max(0, rows.length - shown), selRow);
  // 고른 세션이 묶음의 첫 행이고 자리가 남으면 그 묶음 머리도 보이게 한 줄 올린다.
  if (start === selRow && rows[start - 1]?.g && lastOfSel - start + 2 <= shown) start--;
  const isSession = (r) => r.s && !r.m;
  const visible = rows.slice(start, start + shown);
  // 준비 완료 전에는 값이 커지는 대로 ▲ 가 옮겨 다니므로 붙이지 않는다.
  const hot = view.ready === false ? null : topCost(visible.filter(isSession).map((r) => r.s), view.costMode);
  if (!sessions.length) table.push(...(view.filter ? [line([{ t: `   ${t('ui.noMatch', { q: view.filter })}`, fg: PALETTE.muted, italic: true }], TW)] : emptyLines(view, TW)));
  for (const r of visible) table.push(r.g ? groupRow(r.g, TW) : r.m ? memberRow(r.m, r.last, c, TW, view.frame, r.s.model, view.costMode, r.s.status) : sessionRow(r.s, c, TW, r.s === sel, view.frame, hot, view.costMode, Boolean(view.pins?.includes(r.s.id))));
  if (clipped) {
    const onScreen = new Set(visible.filter(isSession).map((r) => r.s));
    const hidden = sessions.filter((s) => !onScreen.has(s));
    const waitingHidden = hidden.filter(callsYou).length;
    table.push(line([{ t: `   ${t('ui.more', { n: hidden.length })}`, fg: PALETTE.muted }, ...(waitingHidden ? [{ t: t('ui.moreWaiting', { n: waitingHidden }), fg: PALETTE.waiting, bold: true }] : []), { t: t('ui.moveHint'), fg: PALETTE.info }], TW));
  }
  lines.push(...(boxed ? tableBox(table, W, sessions.length) : table));
  if (wantDetail) {
    lines.push(line([], W));
    lines.push(...detail(sel, W, Math.max(minDetail, H - lines.length - 1), view.frame, view));
  }
  if (errors?.length) lines[lines.length - 1] = line([{ t: ' ! ' + errors.join(' / '), fg: PALETTE.alert }], W);
  while (lines.length < H - 1) lines.push(line([], W));
  lines.length = H - 1;
  lines.push(footer({ ...view, showDetail: open }, W, sessions.length, sel));
  return lines;
}
