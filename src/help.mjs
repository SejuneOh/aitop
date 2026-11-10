// 키 안내의 한 곳: 화면 안 도움말(ui/chrome.mjs 의 help)과 aitop --help 의 키 줄이 이 표에서 만들어진다.
// 화면 모듈을 불러오지 않는다 (bin 이 색·테마를 정하기 전에 불러도 되게).

// 화면별 키. [키, 설명, 짧은 이름, --help 에 쓸 키(없으면 첫 글자 묶음)]
export const VIEWS = {
  table: {
    title: '세션 표',
    keys: [
      ['/', '세션 검색 (이름·폴더·모델). Enter 적용, Esc 지우기', '검색'],
      ['↑↓ j k', '세션 선택', '선택', '↑↓/jk'],
      ['n', '다음 볼 세션으로 (응답 대기 → 완료 · 확인 전)', '다음 볼 세션'],
      ['s', '정렬: 기본 → 비용순 → 컨텍스트순 → 최근순. 응답 대기는 늘 맨 위', '정렬'],
      ['g', '묶기: 없음 → 프로젝트 → 도구. 묶음 머리에 세션 수·비용', '묶기'],
      ['c', '비용 기준: API 환산 ↔ 캐시 제외. 표·헤더·상세가 같이 바뀐다 (예산은 늘 API 환산)', '비용 기준'],
      ['p', '고른 세션을 맨 위(응답 대기 아래)에 고정·해제. 여러 개는 고정한 순서, 이번 실행에만', '고정'],
      ['f Tab', '고른 세션의 변경 파일 목록으로', '변경 파일'],
      ['d', '상세 패널 열기·닫기', '상세'],
      ['e', '종료된 세션(24시간) 보이기·숨기기', '종료 세션 토글'],
      ['Esc', '한 단계 뒤로 (도움말·검색 닫기, diff → 파일 목록 → 세션). 종료하지 않음', '뒤로'],
      ['?', '이 도움말 열기·닫기', '도움말'],
      ['q Ctrl-C', '나가기', '나가기'],
    ],
  },
  detail: {
    title: '상세 패널',
    keys: [
      ['↑↓ j k', '다른 세션을 고르면 상세도 따라 바뀐다', '세션 바꾸기', '↑↓/jk'],
      ['f Tab', '변경 파일 목록으로', '변경 파일'],
      ['d', '상세 패널 닫기', '닫기'],
    ],
  },
  files: {
    title: '변경 파일 목록',
    keys: [
      ['↑↓ j k', '파일 고르기', '고르기', '↑↓/jk'],
      ['←→', '지시 탭: 이번 지시 · 편집이 있던 이전 지시 T번호 · 전체', '지시 탭'],
      ['Enter l', '고른 파일의 diff 보기', 'diff'],
      ['Esc h f Tab', '세션 표로', '뒤로'],
    ],
  },
  diff: {
    title: 'diff',
    keys: [
      ['↑↓ j k', '한 줄씩 스크롤', '스크롤', '↑↓/jk'],
      ['space PgDn PgUp', '한 페이지씩', '페이지', 'space'],
      ['[ ]', '이전·다음 파일', '이전·다음 파일', '[ ]'],
      ['Esc h ← f Tab', '파일 목록으로', '뒤로'],
    ],
  },
  filtered: {
    title: '검색어가 걸린 표',
    keys: [
      ['↑↓ j k', '검색 결과 안에서 세션 선택', '선택', '↑↓/jk'],
      ['Esc', '검색어 지우기 (표 전체로)', '검색어 지우기'],
      ['/', '지금 검색어를 지우고 새로 입력', '새 검색'],
    ],
  },
  // 검색어를 입력하는 동안은 ? 도 검색어로 들어가므로 도움말에서는 '다른 화면' 과 --help 에만 나온다.
  search: {
    title: '검색 입력 중',
    keys: [
      ['글자', '검색어 입력 (이름·폴더·모델, 대소문자 무시)', '입력'],
      ['Backspace', '한 글자 지우기', '지우기'],
      ['Enter', '검색어를 남기고 표로', '적용'],
      ['Esc', '검색 취소 (검색어 지우기)', '취소'],
    ],
  },
};

// 화면 안 도움말의 옵션 묶음. 자세한 설명은 aitop --help.
export const OPTIONS = [
  ['--notify', '응답 대기가 생기면 데스크톱 알림'],
  ['--on-waiting <명령>', '응답 대기가 생기면 명령 실행'],
  ['--budget-day <달러>', '하루 예산. 헤더에 예상 비용 경고'],
  ['--show-requests', '응답 대기 요청 전체를 상세·--json 에'],
  ['--debug', '디버그 로그를 남긴다'],
  ['--print-config', '설정 값과 출처, 설정 파일 위치'],
];

// 지금 보는 화면: 파일 목록·diff 에 들어가 있으면 그 화면, 아니면 세션 표. 검색어는 표에 붙는 것이라 helpSections 가 따로 본다.
export function helpContext(view) {
  if (view.focus === 'diff' || view.focus === 'files') return view.focus;
  return 'table';
}

const cliKey = ([k, , , cli]) => cli ?? k.split(' ')[0];
// 한 화면의 키를 한 줄로: '/ 검색 · ↑↓/jk 선택 · ...'
export const keysLine = (name) => VIEWS[name].keys.map((e) => `${cliKey(e)} ${e[2]}`).join(' · ');

// aitop --help 끝의 키 안내.
export function keysText() {
  return [`키: ${keysLine('table')}`, ...['files', 'diff', 'filtered', 'search'].map((n) => `  ${VIEWS[n].title}: ${keysLine(n)}`)].join('\n');
}

// 지금 설정 값 한 줄 (예: 예산 $50 · 알림 켜짐 · 디버그 꺼짐). settings 가 없으면 null.
export function settingsLine(s) {
  if (!s) return null;
  const onOff = (v) => (v ? '켜짐' : '꺼짐');
  const usd = (x) => (Number.isInteger(x) ? `$${x}` : `$${x.toFixed(2)}`);
  return [`예산 ${s.budgetDay > 0 ? usd(s.budgetDay) : '없음'}`, `알림 ${onOff(s.notify)}`, ...(s.onWaiting ? ['대기 명령 있음'] : []), `디버그 ${onOff(s.debug)}`].join(' · ');
}
