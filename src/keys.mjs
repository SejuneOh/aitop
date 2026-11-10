// 키 입력 처리. 화면 상태(view)를 바꾸고, 종료·갱신·세션 이동처럼 밖에서 해야 할 일은 act 로 부른다.
// view.focus: null(세션 선택) → 'files'(변경 파일 목록) → 'diff'(고른 파일의 변경 내용). Esc 는 한 단계씩 뒤로 가고 종료하지 않는다.
// view.tab: 변경 파일을 보는 지시 탭 ('now' 이번 지시, 지시 번호, 'all' 전체). turns.mjs 참고.
import { turnTabs, visibleFiles } from './turns.mjs';
import { detailOpen } from './ui/chrome.mjs';
import { nextGroup, nextSort, togglePin } from './order.mjs';

export const KEY = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', pageUp: '\x1b[5~', pageDown: '\x1b[6~', esc: '\x1b', enter: '\r', tab: '\t', ctrlC: '\x03', backspace: '\x7f' };

const isUp = (k) => k === KEY.up || k === 'k';
const isDown = (k) => k === KEY.down || k === 'j';
const isBack = (k) => k === KEY.esc || k === 'h';

export function selectedSession(view) {
  return view.data?.sessions.find((s) => s.id === view.selectedId) ?? null;
}

const hasFiles = (view) => Boolean(selectedSession(view)?.files?.length);
// 지금 탭에 보이는 파일
const filesOf = (view) => visibleFiles(selectedSession(view), view.tab);

// 갱신 뒤에 고른 파일이 탭에서 빠졌거나 세션에 고친 파일이 없어졌으면 포커스를 맞춘다.
export function fixFocus(view) {
  if (!view.focus) return;
  if (!hasFiles(view) || !view.showDetail) {
    view.focus = null;
    return;
  }
  const files = filesOf(view);
  if (files.some((f) => f.path === view.filePath)) return;
  // 보던 diff 의 파일이 탭에서만 빠졌으면(새 지시가 들어와 이번 지시가 바뀜) 닫지 않고 전체 탭으로 옮긴다.
  if (view.focus === 'diff' && selectedSession(view).files.some((f) => f.path === view.filePath)) {
    view.tab = 'all';
    return;
  }
  view.filePath = files[0]?.path ?? null;
  view.focus = 'files';
}

// 이번 지시에 고친 파일이 없어도 목록에는 들어간다. ←/→ 로 다른 지시를 볼 수 있다.
function enterFiles(view) {
  if (!hasFiles(view)) return;
  view.showDetail = true;
  view.focus = 'files';
  const files = filesOf(view);
  if (!files.some((f) => f.path === view.filePath)) view.filePath = files[0]?.path ?? null;
}

function stepTab(view, delta) {
  const tabs = turnTabs(selectedSession(view));
  const i = Math.max(0, tabs.findIndex((t) => t.key === (view.tab ?? 'now')));
  view.tab = tabs[Math.min(tabs.length - 1, Math.max(0, i + delta))].key;
  const files = filesOf(view);
  if (!files.some((f) => f.path === view.filePath)) view.filePath = files[0]?.path ?? null;
}

function stepFile(view, delta) {
  const files = filesOf(view);
  const i = Math.max(0, files.findIndex((f) => f.path === view.filePath));
  view.filePath = files[Math.min(files.length - 1, Math.max(0, i + delta))]?.path ?? null;
}

function filesKey(view, key) {
  if (isUp(key)) stepFile(view, -1);
  else if (isDown(key)) stepFile(view, 1);
  else if (key === KEY.left || key === KEY.right) stepTab(view, key === KEY.left ? -1 : 1);
  else if (key === KEY.enter || key === 'l') {
    if (!view.filePath) return true;
    view.focus = 'diff';
    view.diffScroll = 0;
  } else if (isBack(key) || key === 'f' || key === KEY.tab) view.focus = null;
  else return false;
  return true;
}

function diffKey(view, key) {
  const page = view.diffPage ?? 10;
  if (isUp(key)) view.diffScroll = Math.max(0, (view.diffScroll ?? 0) - 1);
  else if (isDown(key)) view.diffScroll = (view.diffScroll ?? 0) + 1;
  else if (key === ' ' || key === KEY.pageDown) view.diffScroll = (view.diffScroll ?? 0) + page;
  else if (key === KEY.pageUp) view.diffScroll = Math.max(0, (view.diffScroll ?? 0) - page);
  else if (key === '[' || key === ']') {
    stepFile(view, key === '[' ? -1 : 1);
    view.diffScroll = 0;
  } else if (isBack(key) || key === KEY.left) view.focus = 'files';
  else return false;
  return true;
}

// 검색 중에는 글자를 검색어로 받는다. Enter 는 검색어를 남기고 목록으로, Esc 는 검색을 지운다.
function searchKey(view, key, act) {
  if (key === KEY.enter) view.searching = false;
  else if (key === KEY.esc) {
    view.searching = false;
    view.filter = '';
  } else if (key === KEY.backspace || key === '\b') view.filter = [...(view.filter ?? '')].slice(0, -1).join('');
  else if (!/[\x00-\x1f\x7f]/.test(key)) view.filter = (view.filter ?? '') + key;
  act.keepVisible();
}

// 도움말은 모달이다: 열려 있는 동안은 스크롤(↑↓ j k space PgUp PgDn), 닫기(? Esc), 나가기(q)만 듣고 나머지 키는 버린다.
// 스크롤 끝과 한 페이지 줄 수는 마지막으로 그린 도움말이 정한다 (view.helpMax, view.helpPage).
function helpKey(view, key, act) {
  if (key === '?' || key === KEY.esc) view.help = false;
  else if (key === 'q') act.quit();
  else {
    const page = view.helpPage ?? 10;
    const step = isUp(key) ? -1 : isDown(key) ? 1 : key === ' ' || key === KEY.pageDown ? page : key === KEY.pageUp ? -page : 0;
    if (step) view.helpScroll = Math.min(view.helpMax ?? 0, Math.max(0, (view.helpScroll ?? 0) + step));
  }
}

export function onKey(view, key, act) {
  if (key === KEY.ctrlC) return act.quit();
  if (view.help) return helpKey(view, key, act);
  if (view.searching) return searchKey(view, key, act);
  if (key === '?') {
    view.help = true;
    view.helpScroll = 0;
    return;
  }
  if (key === 'q') return act.quit();
  if (view.focus === 'diff' && diffKey(view, key)) return;
  if (view.focus === 'files' && filesKey(view, key)) return;
  if (key === KEY.esc) {
    view.filter = '';
    return;
  }
  if (key === 'f' || key === KEY.tab) return enterFiles(view);
  if (key === '/') {
    view.searching = true;
    view.filter = '';
    view.focus = null;
  } else if (isUp(key)) act.move(-1);
  else if (isDown(key)) act.move(1);
  else if (key === 'n') act.next();
  // 정렬·묶기는 순서만 바꾸고 선택은 같은 세션 id 에 남는다.
  else if (key === 's') view.sort = nextSort(view.sort);
  else if (key === 'g') view.group = nextGroup(view.group);
  // 고정(p)은 이번 실행에만 기억한다. 고른 세션은 그대로 남고 자리만 위로 옮긴다.
  // 파일 목록·diff 에 들어가 있을 때는 키 안내에 없으므로 받지 않는다.
  else if (key === 'p') {
    if (view.selectedId != null && !view.focus) view.pins = togglePin(view.pins, view.selectedId);
  }
  else if (key === 'c') view.costMode = view.costMode === 'net' ? 'api' : 'net';
  else if (key === 'd') {
    // view.rows: 마지막으로 그린 화면 높이. 'auto' 일 때 지금 보이는 상태를 뒤집는 데 쓴다.
    view.showDetail = !detailOpen(view, view.rows ?? Infinity);
    if (!view.showDetail) view.focus = null;
  } else if (key === 'e') {
    view.showEnded = !view.showEnded;
    act.refresh();
  }
}
