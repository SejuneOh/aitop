// 도움말 화면과 아래 키 안내 줄.
import { pad, width } from '../text.mjs';
import { NO_COLOR, PALETTE } from './theme.mjs';
import { box, line, segsWidth } from './draw.mjs';
import { GROUP_LABEL, SORT_LABEL } from '../order.mjs';
import { OPTIONS, VIEWS, helpContext, keysLine, settingsLine } from '../help.mjs';

// 상세 패널을 기본으로 여는 최소 화면 높이. 이보다 낮으면 세션 표에 줄을 준다.
export const DETAIL_MIN_H = 24;

// view.showDetail: 'auto' 는 화면 높이로 정하고, true/false 는 사용자가 d·f 로 고른 값이라 높이와 상관없이 따른다.
export function detailOpen(view, H) {
  return view.showDetail === 'auto' ? H >= DETAIL_MIN_H : Boolean(view.showDetail);
}

// 상태 기호와 열 설명. 키는 help.mjs 의 VIEWS 에서 화면별로 고른다.
export const LEGEND = [
  ['상태 기호', null],
  ['⠋', '작업 중 (STATUS 칸에 생각·답변, 도구 실행, 팀원 작업. 색으로도 나뉜다)'],
  ['◆', '응답 대기 (권한·질문). 행 배경이 강조된다'],
  ['●', '완료 · 확인 전 (작업이 끝났는데 아직 선택해 보지 않음)'],
  ['○', '다음 지시 대기'],
  ['·', '종료'],
  ['', ''],
  ['열', null],
  ['STATUS', '지금 단계. 큰 기록을 처음 읽는 동안은 기록 읽는 중 N%'],
  ['TOKENS', '세션 누적 토큰 (서브에이전트 포함, 캐시 읽기 포함)'],
  ['COST', 'API 정가로 환산한 비용 (Codex 는 OpenAI 정가 추정). ? 는 가격표에 없는 모델 포함'],
  ['CONTEXT', '마지막 요청의 컨텍스트 사용률 (모델별 창 크기 기준)'],
  ['IDLE', '마지막 활동 후 지난 시간. 작업 중이면 now'],
  ['오늘 / 7일', '헤더 오른쪽. 날짜별 합계, API 정가 환산이며 구독 요금제의 청구액이 아니다'],
  ['변경 파일', 'Edit/Write(Codex 는 apply_patch) 로 고친 파일과 편집 횟수. git diff 가 아니다'],
];

// 도움말 줄 목록: 지금 화면의 키 → (표에 검색어가 걸려 있으면) 그 키 → (상세 패널이 열려 있으면) 상세 패널 키 → 다른 화면 한 줄씩 → 옵션 → 상태 기호·열.
// 넓으면(100칸 이상) 키는 왼쪽, 옵션·기호·열은 오른쪽 칸에 둔다.
export function helpSections(view = {}, open = false) {
  const ctx = helpContext(view);
  const here = ctx === 'table' ? ['table', ...(view.filter ? ['filtered'] : []), ...(open ? ['detail'] : [])] : [ctx];
  const keys = here.flatMap((n, i) => [...(i ? [['', '']] : []), [`${VIEWS[n].title}${i ? '' : '  (지금 화면)'}`, null], ...VIEWS[n].keys.map(([k, t]) => [k, t])]);
  const others = Object.keys(VIEWS).filter((n) => !here.includes(n));
  const rest = [['', ''], ['다른 화면', null], ...others.map((n) => [VIEWS[n].title, keysLine(n), 'dim'])];
  const now = settingsLine(view.settings);
  const options = [
    ['옵션', null],
    ...OPTIONS,
    ...(view.settings?.configPath ? [['설정 파일', view.settings.configPath, 'dim']] : []),
    ...(now ? [['지금', now]] : []),
  ];
  return { keys: [...keys, ...rest], more: [...options, ['', ''], ...LEGEND] };
}

// 키 칸 폭은 제목 줄 사이 묶음마다 그 묶음의 가장 긴 키에 맞춘다 (12~21칸).
function helpLines(list) {
  const out = [];
  let kw = 12;
  list.forEach(([k, v, dim], i) => {
    if (v == null) {
      const next = list.slice(i + 1);
      const block = next.slice(0, Math.max(0, next.findIndex((e) => e[1] == null)) || next.length);
      kw = Math.min(21, Math.max(12, ...block.filter((e) => e[1]).map((e) => width(e[0]) + 1)));
      out.push([{ t: k, fg: PALETTE.brand, bold: true }]);
    } else out.push([{ t: pad(k, kw), fg: PALETTE.text, bold: !dim }, { t: v, fg: dim ? PALETTE.info : PALETTE.muted }]);
  });
  return out;
}

// 줄이 넘치면 scroll 만큼 내려 보이고, 아래에 남은 줄이 있으면 마지막 줄에 알린다.
function windowOf(lines, n, scroll) {
  const more = (k) => [{ t: `… ${k}줄 더 · ↑↓ 로 스크롤`, fg: PALETTE.info, italic: true }];
  const part = lines.slice(scroll, scroll + n);
  const left = lines.length - scroll - n;
  return left > 0 ? [...part.slice(0, n - 1), more(left + 1)] : part;
}

// view.helpScroll: ↑↓ 로 내린 줄 수. 넘치지 않으면 0. 내릴 수 있는 끝은 view.helpMax 에 남긴다 (keys.mjs 가 쓴다).
export function help(W, H, view = {}, open = false) {
  const { keys, more } = helpSections(view, open);
  const title = '도움말  ·  ? 또는 Esc 로 닫기';
  const rows = H - 2;
  const wide = W >= 100;
  const cols = wide ? [helpLines(keys), helpLines(more)] : [helpLines([...keys, ['', ''], ...more])];
  const max = Math.max(0, ...cols.map((c) => c.length - rows));
  const scroll = Math.min(max, Math.max(0, view.helpScroll ?? 0));
  view.helpMax = max;
  view.helpScroll = scroll;
  if (wide) return box(title, W, H, windowOf(cols[0], rows, scroll), windowOf(cols[1], rows, scroll), Math.min(64, Math.floor((W - 7) * 0.5)), PALETTE.brand);
  return box(title, W, H, null, windowOf(cols[0], rows, scroll), 0, PALETTE.brand);
}

// 키 칩. 색이 없으면 [f] 처럼 괄호로 보인다.
export const keyChip = (k) => (NO_COLOR ? { t: `[${k}]` } : { t: ` ${k} `, fg: PALETTE.chipText, bg: PALETTE.muted, bold: true });

export const keyLabel = (t) => ({ t: ` ${t}   `, fg: PALETTE.muted });

// items: { k, t, keep } 또는 { segs, keep }. 폭이 모자라면 keep 이 아닌 항목을 오른쪽부터 뺀다.
export function hintBar(items, W, right = '') {
  const segsOf = (list) => [{ t: ' ' }, ...list.flatMap((i) => i.segs ?? [keyChip(i.k), keyLabel(i.t)])];
  const wOf = (list) => segsWidth(segsOf(list));
  const list = [...items];
  while (wOf(list) > W && list.some((i) => !i.keep)) list.splice(list.findLastIndex((i) => !i.keep), 1);
  const segs = segsOf(list);
  const used = wOf(list);
  if (right && W - used >= width(right) + 1) segs.push({ t: ' '.repeat(W - used - width(right)) }, { t: right, fg: PALETTE.info });
  return line(segs, W);
}

// 정렬·묶기가 기본이 아닐 때만 지금 상태를 짧게 보인다 (예: s:비용 g:프로젝트). 표 순서를 읽는 데 필요하므로 d·e·c 안내보다 늦게 빠진다.
function orderHint(view) {
  const parts = [
    ...(view.sort && view.sort !== 'default' ? [['s', SORT_LABEL[view.sort]]] : []),
    ...(view.group && view.group !== 'none' ? [['g', GROUP_LABEL[view.group]]] : []),
  ];
  if (!parts.length) return null;
  const segs = parts.flatMap(([k, t], i) => [{ t: i ? ' ' : '', fg: PALETTE.info }, { t: k, fg: PALETTE.muted, bold: true }, { t: `:${t}`, fg: PALETTE.info }]);
  return { segs: [...segs, { t: '   ' }] };
}

export function footer(view, W, matched, sel) {
  const tail = [
    { k: '?', t: '도움', keep: true },
    { k: 'q', t: '나가기', keep: true },
  ];
  // 도움말이 열려 있으면 ↑↓ 는 도움말을 스크롤하고 ? · Esc 는 닫는다.
  if (view.help) return hintBar([{ k: '↑↓', t: '스크롤' }, { k: '?', t: '도움 닫기', keep: true }, { k: 'Esc', t: '닫기' }, { k: 'q', t: '나가기', keep: true }], W, '⊘ 읽기전용');
  if (view.searching) {
    const input = NO_COLOR ? [{ t: '[/]' }] : [{ t: ' / ', fg: PALETTE.chipText, bg: PALETTE.brand, bold: true }];
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
  const order = orderHint(view);
  const search = view.filter
    ? { segs: [{ t: ` /${view.filter} `, fg: PALETTE.chipText, bg: PALETTE.brand, bold: true }, { t: ` ${matched}개 `, fg: PALETTE.muted }, keyChip('Esc'), keyLabel('검색 지우기')], keep: true }
    : { k: '/', t: '검색' };
  const items = [
    search,
    { k: '↑↓', t: '선택' },
    { k: 'n', t: '다음' },
    ...(order ? [order] : []),
    ...(sel?.files?.length ? [{ k: 'f', t: '파일' }] : []),
    { k: 'd', t: view.showDetail ? '상세 닫기' : '상세 열기' },
    { k: 'e', t: view.showEnded ? '종료 숨김' : '종료 포함' },
    { k: 'c', t: '비용 기준' },
    ...tail,
  ];
  return hintBar(items, W, '⊘ 읽기전용');
}
