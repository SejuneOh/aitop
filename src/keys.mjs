// 키 입력 처리. 화면 상태(view)를 바꾸고, 종료·갱신·세션 이동처럼 밖에서 해야 할 일은 act 로 부른다.
// Esc 는 한 단계씩 뒤로 가고 종료하지 않는다.
export const KEY = { up: '\x1b[A', down: '\x1b[B', esc: '\x1b', enter: '\r', ctrlC: '\x03', backspace: '\x7f' };

const isUp = (k) => k === KEY.up || k === 'k';
const isDown = (k) => k === KEY.down || k === 'j';

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

export function onKey(view, key, act) {
  if (key === KEY.ctrlC) return act.quit();
  if (view.searching) return searchKey(view, key, act);
  if (key === '?' || (key === KEY.esc && view.help)) {
    view.help = !view.help && key === '?';
    return;
  }
  if (key === 'q') return act.quit();
  if (key === KEY.esc) {
    view.filter = '';
    return;
  }
  if (key === '/') {
    view.searching = true;
    view.filter = '';
  } else if (isUp(key)) act.move(-1);
  else if (isDown(key)) act.move(1);
  else if (key === 'n') act.next();
  else if (key === 'd') view.showDetail = !view.showDetail;
  else if (key === 'e') {
    view.showEnded = !view.showEnded;
    act.refresh();
  }
}
