// 키 안내의 한 곳: 화면 안 도움말(ui/chrome.mjs 의 help)과 aitop --help 의 키 줄이 이 표에서 만들어진다.
// 화면 모듈을 불러오지 않는다 (bin 이 색·테마를 정하기 전에 불러도 되게).
// 화면 이름, 키 설명, 키 짧은 이름은 i18n.mjs 표에 있다. 표(VIEWS)에는 ko 값을 두고, 화면 안 도움말과 --help 는 지금 언어로 바꾼다.
import { STRINGS, getLang, t } from './i18n.mjs';

const ko = (key) => STRINGS.ko[key];

// 화면별 키. [키, 설명, 짧은 이름, --help 에 쓸 키(없으면 첫 글자 묶음), 설명 id]
// 설명·짧은 이름은 ko 값으로 둔다 (KEY_ID 가 ko 짧은 이름으로 키를 찾는다). 화면에서는 viewText 가 지금 언어로 바꾼다.
const k = (id, key, short, cli) => [key, ko(`hk.${id}`), ko(`key.${short}`), cli, id];

export const VIEWS = {
  table: {
    name: 'table',
    title: ko('view.table'),
    keys: [
      k('table.search', '/', 'search'),
      k('table.select', '↑↓ j k', 'select', '↑↓/jk'),
      k('table.next', 'n', 'next'),
      k('table.sort', 's', 'sort'),
      k('table.group', 'g', 'group'),
      k('table.costMode', 'c', 'costMode'),
      k('table.pin', 'p', 'pin'),
      k('table.files', 'f Tab', 'files'),
      k('table.detail', 'd', 'detail'),
      k('table.ended', 'e', 'ended'),
      k('table.back', 'Esc', 'back'),
    ],
  },
  detail: {
    name: 'detail',
    title: ko('view.detail'),
    keys: [
      k('detail.switch', '↑↓ j k', 'switchSession', '↑↓/jk'),
      k('detail.files', 'f Tab', 'files'),
      k('detail.close', 'd', 'close'),
    ],
  },
  files: {
    name: 'files',
    title: ko('view.files'),
    keys: [
      k('files.pick', '↑↓ j k', 'pick', '↑↓/jk'),
      k('files.tabs', '←→', 'promptTab'),
      k('files.diff', 'Enter l', 'diff'),
      k('files.back', 'Esc h f Tab', 'back'),
    ],
  },
  diff: {
    name: 'diff',
    title: ko('view.diff'),
    keys: [
      k('diff.scroll', '↑↓ j k', 'scroll', '↑↓/jk'),
      k('diff.page', 'space PgDn PgUp', 'page', 'space'),
      k('diff.prevNext', '[ ]', 'prevNext', '[ ]'),
      k('diff.back', 'Esc h ← f Tab', 'back'),
    ],
  },
  filtered: {
    name: 'filtered',
    title: ko('view.filtered'),
    keys: [
      k('filtered.select', '↑↓ j k', 'select', '↑↓/jk'),
      k('filtered.clear', 'Esc', 'clearSearch'),
      k('filtered.new', '/', 'newSearch'),
    ],
  },
  // 검색어를 입력하는 동안은 ? 도 검색어로 들어가므로 도움말에서는 '다른 화면' 과 --help 에만 나온다.
  search: {
    name: 'search',
    title: ko('view.search'),
    keys: [
      k('search.type', ko('key.letters'), 'type', ko('key.letters')),
      k('search.erase', 'Backspace', 'erase'),
      k('search.apply', 'Enter', 'apply'),
      k('search.cancel', 'Esc', 'cancel'),
    ],
  },
};

// 어느 화면에서나 듣는 키. 화면마다 되풀이하지 않고 도움말에서는 지금 화면 키 바로 아래 한 번만 보인다.
export const COMMON = {
  name: 'common',
  title: ko('view.common'),
  keys: [
    k('common.help', '?', 'help'),
    k('common.quit', 'q Ctrl-C', 'quit'),
  ],
};

// 화면 안 도움말의 옵션 묶음. 자세한 설명은 aitop --help. [옵션(값을 받는 옵션은 i18n 키), 설명 i18n 키]
const OPTION_IDS = [
  ['hopt.notifyOpt', 'hopt.notify'],
  ['hopt.onWaiting', 'hopt.onWaitingText'],
  ['hopt.budgetDay', 'hopt.budgetDayText'],
  ['--show-requests', 'hopt.showRequests'],
  ['--color-blind', 'hopt.colorBlind'],
  ['--debug', 'hopt.debug'],
  ['--line[=tmux]', 'hopt.line'],
  ['--print-config', 'hopt.printConfig'],
  ['AITOP_AMBIGUOUS=wide', 'hopt.ambiguous'],
];

// 지금 언어의 옵션 묶음 [[옵션, 설명], ...]. OPTIONS 는 ko 값이다.
export const options = (lang = getLang()) => OPTION_IDS.map(([o, d]) => [o.startsWith('hopt.') ? t(o, null, { lang }) : o, t(d, null, { lang })]);
export const OPTIONS = options('ko');

// 지금 보는 화면: 파일 목록·diff 에 들어가 있으면 그 화면, 아니면 세션 표. 검색어는 표에 붙는 것이라 helpSections 가 따로 본다.
export function helpContext(view) {
  if (view.focus === 'diff' || view.focus === 'files') return view.focus;
  return 'table';
}

const cliKey = ([k, , , cli]) => cli ?? k.split(' ')[0];
// 한국어 짧은 이름 → i18n 키 (key.*). 다른 언어에서 같은 키의 문구를 찾는다.
const KEY_ID = new Map(Object.entries(STRINGS.ko).filter(([k]) => k.startsWith('key.')).map(([k, v]) => [v, k]));
// 한국어 문구면 lang 의 문구로, 아니면(/, Esc 같은 키 이름) 그대로.
const word = (s, lang) => (lang !== 'ko' && KEY_ID.has(s) ? t(KEY_ID.get(s), null, { lang }) : s);
// 한 화면의 키를 한 줄로: '/ 검색 · ↑↓/jk 선택 · ...'
// 'common' 은 어디서나 쓰는 키. 없는 화면 이름은 예전처럼 오류로 드러낸다. lang 을 주지 않으면 지금 언어다.
export const keysLine = (name, lang = getLang()) => (name === 'common' ? COMMON : VIEWS[name]).keys.map((e) => `${word(cliKey(e), lang)} ${word(e[2], lang)}`).join(' · ');

// 화면 하나(VIEWS 의 값 또는 COMMON)의 제목과 키 [[키, 설명], ...] 를 지금 언어로. 검색 화면의 '글자' 같은 키 이름도 바꾼다.
export function viewText(v, lang = getLang()) {
  return { title: t(`view.${v.name}`, null, { lang }), keys: v.keys.map((e) => [word(e[0], lang), t(`hk.${e[4]}`, null, { lang })]) };
}

// aitop --help 끝의 키 안내. 지금 언어(bin 이 정한다)로 쓴다.
export function keysText(lang = getLang()) {
  const title = (n) => t(`view.${n}`, null, { lang });
  return [`${t('help.keys', null, { lang })}: ${keysLine('table', lang)} · ${keysLine('common', lang)}`, ...['files', 'diff', 'filtered', 'search'].map((n) => `  ${title(n)}: ${keysLine(n, lang)}`)].join('\n');
}

// 지금 설정 값 한 줄 (예: 예산 $50 · 알림 켜짐 · 디버그 꺼짐). settings 가 없으면 null.
export function settingsLine(s, lang = getLang()) {
  if (!s) return null;
  const o = { lang };
  const onOff = (v) => t(v ? 'set.on' : 'set.off', null, o);
  const usd = (x) => (Number.isInteger(x) ? `$${x}` : `$${x.toFixed(2)}`);
  // 알림이 켜져 있고 종류를 기본(waiting)과 다르게 정했으면 함께 보인다. 예: 알림 켜짐 (waiting,done)
  const kinds = s.notify && s.events && s.events.join(',') !== 'waiting' ? ` (${s.events.join(',')})` : '';
  return [t('set.budget', { v: s.budgetDay > 0 ? usd(s.budgetDay) : t('set.none', null, o) }, o), t('set.notify', { v: onOff(s.notify) + kinds }, o), ...(s.onWaiting ? [t('set.onWaiting', null, o)] : []), t('set.debug', { v: onOff(s.debug) }, o)].join(' · ');
}
