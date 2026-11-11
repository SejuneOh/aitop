// 키 안내의 한 곳: 화면 안 도움말(ui/chrome.mjs 의 help)과 aitop --help 의 키 줄이 이 표에서 만들어진다.
// 화면 모듈을 불러오지 않는다 (bin 이 색·테마를 정하기 전에 불러도 되게).
// 화면 이름과 키 짧은 이름은 i18n.mjs 표에 있다. 화면 안 도움말은 아직 한국어라 ko 값을 쓰고, --help 는 지금 언어로 바꾼다.
import { STRINGS, getLang, t } from './i18n.mjs';

const ko = (key) => STRINGS.ko[key];

// 화면별 키. [키, 설명, 짧은 이름, --help 에 쓸 키(없으면 첫 글자 묶음)]
export const VIEWS = {
  table: {
    title: ko('view.table'),
    keys: [
      ['/', '세션 검색 (이름·폴더·모델). Enter 적용, Esc 지우기', ko('key.search')],
      ['↑↓ j k', '세션 선택', ko('key.select'), '↑↓/jk'],
      ['n', '다음 볼 세션으로 (응답 대기 → 완료 · 확인 전)', ko('key.next')],
      ['s', '정렬: 기본 → 비용순 → 컨텍스트순 → 최근순. 응답 대기는 늘 맨 위', ko('key.sort')],
      ['g', '묶기: 없음 → 프로젝트 → 도구. 묶음 머리에 세션 수·비용', ko('key.group')],
      ['c', '비용 기준: API 환산 ↔ 캐시 제외. 표·헤더·상세가 같이 바뀐다 (예산은 늘 API 환산)', ko('key.costMode')],
      ['p', '고른 세션을 맨 위(응답 대기 아래)에 고정·해제. 여러 개는 고정한 순서, 이번 실행에만', ko('key.pin')],
      ['f Tab', '고른 세션의 변경 파일 목록으로', ko('key.files')],
      ['d', '상세 패널 열기·닫기', ko('key.detail')],
      ['e', '종료된 세션(24시간) 보이기·숨기기', ko('key.ended')],
      ['Esc', '한 단계 뒤로 (도움말·검색 닫기, diff → 파일 목록 → 세션). 종료하지 않음', ko('key.back')],
    ],
  },
  detail: {
    title: ko('view.detail'),
    keys: [
      ['↑↓ j k', '다른 세션을 고르면 상세도 따라 바뀐다', ko('key.switchSession'), '↑↓/jk'],
      ['f Tab', '변경 파일 목록으로', ko('key.files')],
      ['d', '상세 패널 닫기', ko('key.close')],
    ],
  },
  files: {
    title: ko('view.files'),
    keys: [
      ['↑↓ j k', '파일 고르기', ko('key.pick'), '↑↓/jk'],
      ['←→', '지시 탭: 이번 지시 · 편집이 있던 이전 지시 T번호 · 전체', ko('key.promptTab')],
      ['Enter l', '고른 파일의 diff 보기', ko('key.diff')],
      ['Esc h f Tab', '세션 표로', ko('key.back')],
    ],
  },
  diff: {
    title: ko('view.diff'),
    keys: [
      ['↑↓ j k', '한 줄씩 스크롤', ko('key.scroll'), '↑↓/jk'],
      ['space PgDn PgUp', '한 페이지씩', ko('key.page'), 'space'],
      ['[ ]', '이전·다음 파일', ko('key.prevNext'), '[ ]'],
      ['Esc h ← f Tab', '파일 목록으로', ko('key.back')],
    ],
  },
  filtered: {
    title: ko('view.filtered'),
    keys: [
      ['↑↓ j k', '검색 결과 안에서 세션 선택', ko('key.select'), '↑↓/jk'],
      ['Esc', '검색어 지우기 (표 전체로)', ko('key.clearSearch')],
      ['/', '지금 검색어를 지우고 새로 입력', ko('key.newSearch')],
    ],
  },
  // 검색어를 입력하는 동안은 ? 도 검색어로 들어가므로 도움말에서는 '다른 화면' 과 --help 에만 나온다.
  search: {
    title: ko('view.search'),
    keys: [
      ['글자', '검색어 입력 (이름·폴더·모델, 대소문자 무시)', ko('key.type'), ko('key.letters')],
      ['Backspace', '한 글자 지우기', ko('key.erase')],
      ['Enter', '검색어를 남기고 표로', ko('key.apply')],
      ['Esc', '검색 취소 (검색어 지우기)', ko('key.cancel')],
    ],
  },
};

// 어느 화면에서나 듣는 키. 화면마다 되풀이하지 않고 도움말에서는 지금 화면 키 바로 아래 한 번만 보인다.
export const COMMON = {
  title: ko('view.common'),
  keys: [
    ['?', '이 도움말 열기·닫기', ko('key.help')],
    ['q Ctrl-C', '나가기', ko('key.quit')],
  ],
};

// 화면 안 도움말의 옵션 묶음. 자세한 설명은 aitop --help.
export const OPTIONS = [
  ['--notify', '응답 대기가 생기면 데스크톱 알림'],
  ['--on-waiting <명령>', '응답 대기가 생기면 명령 실행'],
  ['--budget-day <달러>', '하루 예산. 헤더에 예상 비용 경고'],
  ['--show-requests', '응답 대기 요청 전체를 상세·--json 에'],
  ['--color-blind', '적록 색약용 색 (대기·돈·경고를 노랑·파랑 계열로)'],
  ['--debug', '디버그 로그를 남긴다'],
  ['--line[=tmux]', '오늘 비용·대기 수·시간당 지출 한 줄 (tmux 상태줄용)'],
  ['--print-config', '설정 값과 출처, 설정 파일 위치'],
  ['AITOP_AMBIGUOUS=wide', '·→─● 를 2칸으로 그리는 터미널용 (1칸 기호로)'],
];

// 지금 보는 화면: 파일 목록·diff 에 들어가 있으면 그 화면, 아니면 세션 표. 검색어는 표에 붙는 것이라 helpSections 가 따로 본다.
export function helpContext(view) {
  if (view.focus === 'diff' || view.focus === 'files') return view.focus;
  return 'table';
}

const cliKey = ([k, , , cli]) => cli ?? k.split(' ')[0];
// 한국어 짧은 이름 → i18n 키 (key.*). 다른 언어의 --help 에서 같은 키의 문구를 찾는다.
const KEY_ID = new Map(Object.entries(STRINGS.ko).filter(([k]) => k.startsWith('key.')).map(([k, v]) => [v, k]));
// 한국어 문구면 lang 의 문구로, 아니면(/, Esc 같은 키 이름) 그대로.
const word = (s, lang) => (lang !== 'ko' && KEY_ID.has(s) ? t(KEY_ID.get(s), null, { lang }) : s);
// 한 화면의 키를 한 줄로: '/ 검색 · ↑↓/jk 선택 · ...'
// 'common' 은 어디서나 쓰는 키. 없는 화면 이름은 예전처럼 오류로 드러낸다. lang 을 주지 않으면 화면용 한국어다.
export const keysLine = (name, lang = 'ko') => (name === 'common' ? COMMON : VIEWS[name]).keys.map((e) => `${word(cliKey(e), lang)} ${word(e[2], lang)}`).join(' · ');

// aitop --help 끝의 키 안내. 지금 언어(bin 이 정한다)로 쓴다.
export function keysText(lang = getLang()) {
  const title = (n) => t(`view.${n}`, null, { lang });
  return [`${t('help.keys', null, { lang })}: ${keysLine('table', lang)} · ${keysLine('common', lang)}`, ...['files', 'diff', 'filtered', 'search'].map((n) => `  ${title(n)}: ${keysLine(n, lang)}`)].join('\n');
}

// 지금 설정 값 한 줄 (예: 예산 $50 · 알림 켜짐 · 디버그 꺼짐). settings 가 없으면 null.
export function settingsLine(s) {
  if (!s) return null;
  const onOff = (v) => (v ? '켜짐' : '꺼짐');
  const usd = (x) => (Number.isInteger(x) ? `$${x}` : `$${x.toFixed(2)}`);
  return [`예산 ${s.budgetDay > 0 ? usd(s.budgetDay) : '없음'}`, `알림 ${onOff(s.notify)}`, ...(s.onWaiting ? ['대기 명령 있음'] : []), `디버그 ${onOff(s.debug)}`].join(' · ');
}
