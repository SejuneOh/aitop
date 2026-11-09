// 화면 그리기: 상단 요약 바 → 세션 표(팀원 트리 포함) → 선택한 세션 상세 → 단축키 바.
import { width } from './text.mjs';
import { BRAND } from './brand.mjs';
import { PALETTE } from './ui/theme.mjs';
import { line, setNow } from './ui/draw.mjs';
import { TABLE_BOX_H, columns, emptyLines, filterSessions, groupRow, header, memberRow, sessionRow, tableBox, tableHeader, toolStrip, topCost } from './ui/table.mjs';
import { detail } from './ui/detail.mjs';
import { detailOpen, footer, help } from './ui/chrome.mjs';
import { arrange } from './order.mjs';

export { PALETTE, style } from './ui/theme.mjs';
export { money } from './ui/draw.mjs';
export { filterSessions } from './ui/table.mjs';
export { DETAIL_MIN_H, detailOpen } from './ui/chrome.mjs';

export function render(view, W, H) {
  setNow(Date.now());
  const lines = [];
  if (!view.data) {
    // 첫 수집은 동기로 돌아 이 화면이 다시 그려지지 않으므로 움직이지 않는 로고를 둔다.
    const msg = `${BRAND.logo}  세션 기록을 읽는 중…`;
    for (let i = 0; i < H; i++) lines.push(i === Math.floor(H / 2) ? line([{ t: ' '.repeat(Math.max(0, Math.floor((W - width(msg)) / 2))) }, { t: msg, fg: PALETTE.brand }], W) : line([], W));
    return lines;
  }
  const { errors } = view.data;
  const { sessions, groups } = arrange(filterSessions(view.data.sessions, view.filter), view);
  const boxed = H >= TABLE_BOX_H && W >= 60;
  const TW = boxed ? W - 4 : W;
  const c = columns(TW);
  if (view.help) {
    lines.push(header(view, W), ...help(W, Math.max(3, H - 2)));
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
  const hot = topCost(visible.filter(isSession).map((r) => r.s), view.costMode);
  if (!sessions.length) table.push(...(view.filter ? [line([{ t: `   '${view.filter}' 에 맞는 세션이 없습니다.`, fg: PALETTE.muted, italic: true }], TW)] : emptyLines(view, TW)));
  for (const r of visible) table.push(r.g ? groupRow(r.g, TW) : r.m ? memberRow(r.m, r.last, c, TW, view.frame, r.s.model, view.costMode) : sessionRow(r.s, c, TW, r.s === sel, view.frame, hot, view.costMode));
  if (clipped) {
    const onScreen = new Set(visible.filter(isSession).map((r) => r.s));
    const hidden = sessions.filter((s) => !onScreen.has(s));
    const waitingHidden = hidden.filter((s) => s.status === 'waiting').length;
    table.push(line([{ t: `   … +${hidden.length} 세션`, fg: PALETTE.muted }, ...(waitingHidden ? [{ t: ` (응답 대기 ${waitingHidden})`, fg: PALETTE.waiting, bold: true }] : []), { t: '  ↑↓ 로 이동', fg: PALETTE.info }], TW));
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
