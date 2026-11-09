// 도움말 화면과 아래 키 안내 줄.
import { pad, width } from '../text.mjs';
import { NO_COLOR, PALETTE } from './theme.mjs';
import { box, line, segsWidth } from './draw.mjs';
import { GROUP_LABEL, SORT_LABEL } from '../order.mjs';

// 상세 패널을 기본으로 여는 최소 화면 높이. 이보다 낮으면 세션 표에 줄을 준다.
export const DETAIL_MIN_H = 24;

// view.showDetail: 'auto' 는 화면 높이로 정하고, true/false 는 사용자가 d·f 로 고른 값이라 높이와 상관없이 따른다.
export function detailOpen(view, H) {
  return view.showDetail === 'auto' ? H >= DETAIL_MIN_H : Boolean(view.showDetail);
}

export const HELP = [
  ['키', null],
  ['/', '세션 검색 (이름·폴더·모델). Enter 적용, Esc 지우기'],
  ['↑↓ j k', '세션 선택'],
  ['n', '다음 볼 세션으로 이동 (응답 대기 → 완료 · 확인 전)'],
  ['s', '정렬 바꾸기: 기본 → 비용순 → 컨텍스트순 → 최근순. 응답 대기는 늘 맨 위'],
  ['g', '묶기 바꾸기: 없음 → 프로젝트 → 도구. 묶음 머리에 세션 수·비용, 응답 대기는 맨 위 묶음'],
  ['f Tab', '변경 파일 목록으로. ←→ 지시 탭, ↑↓ 고르기, Enter diff, [ ] 이전·다음 파일, space 페이지'],
  ['d', '상세 패널 열기·닫기'],
  ['e', '종료된 세션(24시간) 보이기·숨기기'],
  ['?', '이 도움말 열기·닫기'],
  ['Esc', '한 단계 뒤로 (도움말·검색 닫기, diff → 파일 목록 → 세션). 종료하지 않음'],
  ['c', '비용 기준: API 환산(기본) ↔ 캐시 제외(입력·출력만). 표·헤더·상세가 같이 바뀐다'],
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
  ['COST', 'API 정가로 환산한 비용 (Codex 는 OpenAI 정가 추정). ? 는 가격표에 없는 모델 포함'],
  ['CONTEXT', '마지막 요청의 컨텍스트 사용률 (모델별 창 크기 기준)'],
  ['IDLE', '마지막 활동 후 지난 시간. 작업 중이면 now'],
  ['오늘 / 7일', '헤더 오른쪽. 최근 7일 Claude 기록의 날짜별 합계. API 정가 환산이며 구독 요금제의 청구액이 아니다'],
  ['변경 파일', 'Edit/Write(Codex 는 apply_patch) 로 고친 파일과 편집 횟수. git diff 가 아니다. Bash 로 고친 파일은 빠진다'],
  ['', 'diff 머리의 쓴 줄 · 지운 줄은 편집마다 더한 누적값 (최종 변경량 아님)'],
  ['지시 탭', '이번 지시(마지막 지시 뒤), 편집이 있던 이전 지시 T번호, 전체. lock·생성 파일은 끝에 흐리게'],
];

export function help(W, H) {
  const left = HELP.map(([k, v]) => (v == null ? [{ t: k, fg: PALETTE.brand, bold: true }] : [{ t: pad(k, 12), fg: PALETTE.text, bold: true }, { t: v, fg: PALETTE.muted }]));
  return box('도움말  ·  ? 또는 Esc 로 닫기', W, H, left, [], W - 8, PALETTE.brand);
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
