// 80칸 도움말 설명 감싸기 (#265). 한글 2칸·폭이 모호한 글자 2칸에서도 줄이 칸을 넘지 않고 "…" 로 잘리지 않는다.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/ui.mjs';
import { footer, hintBar } from '../src/ui/chrome.mjs';
import { setAmbiguous, width, wrapWords } from '../src/text.mjs';
import { getLang, setLang, t } from '../src/i18n.mjs';

const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
const view = (extra) => ({ data: { sessions: [], errors: [], at: Date.now(), usage: null }, selectedId: null, showDetail: true, frame: 0, help: true, ...extra });
const lang0 = getLang();
afterEach(() => {
  setAmbiguous('narrow');
  setLang(lang0);
});

// 도움말 상자 안쪽만 (테두리·제목·키 줄 빼고).
const body = (W, H, extra) => render(view(extra), W, H).map(strip).slice(2, H - 2);

test('wrapWords: 띄어쓰기에서 끊고, 한글 2칸을 세며, 긴 낱말은 글자 단위로 끊는다', () => {
  assert.deepEqual(wrapWords('가나다 라마 바사아자', 10), ['가나다', '라마', '바사아자']);
  assert.deepEqual(wrapWords('abc def', 20), ['abc def']);
  assert.deepEqual(wrapWords('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapWords('', 5), ['']);
  for (const w of [3, 7, 12]) for (const l of wrapWords('비용 기준: API 환산 ↔ 캐시 제외. 표·헤더·상세가 같이 바뀐다', w)) assert.ok(width(l) <= w, `${w}: ${l}`);
});

test('80칸 도움말: 한/영, 폭이 모호한 글자 2칸에서도 설명을 자르지 않고 들여쓴 다음 줄로 감싼다', () => {
  for (const amb of ['narrow', 'wide'])
    for (const lang of ['ko', 'en']) {
      setAmbiguous(amb);
      setLang(lang);
      const lines = body(80, 200);
      const tag = `${amb}/${lang}`;
      assert.ok(lines.every((l) => width(l) <= 80), `${tag}: 폭`);
      assert.ok(!lines.some((l) => l.includes('…')), `${tag}: 잘린 줄 ${lines.find((l) => l.includes('…'))}`);
    }
  setAmbiguous('narrow');
  setLang('ko');
  const lines = body(80, 200);
  // 예: c 설명의 끝 '(예산은 늘 API 환산)' 이 키 칸(12칸)만큼 들여쓴 다음 줄에 이어진다.
  const at = lines.findIndex((l) => /^│ c {11}비용 기준/.test(l));
  assert.ok(at > 0);
  assert.match(lines[at + 1], /^│ {13}\S/);
  assert.ok(lines.join('\n').includes('(예산은 늘 API 환산)'));
  for (const word of ['기록의 API 오류 줄로', '판단한다', '"hideIdleTools": false', '청구액이 아니다', '(tmux']) assert.ok(lines.join('\n').includes(word), word);
});

test('80칸 도움말: 감싼 줄까지 스크롤 끝(helpMax)에 들어가고, 마지막 페이지에 범례 끝이 보인다', () => {
  const v = view();
  render(v, 80, 24);
  v.helpScroll = v.helpMax;
  const last = render(v, 80, 24).map(strip).join('\n');
  assert.ok(last.includes(t('legend.auto')), '범례 마지막 줄');
  assert.ok(!last.includes(t('help.more', { n: 1 }).slice(0, 4)), '더 남은 줄 안내가 없다');
});

test('두 칸(100칸 이상) 도움말은 예전처럼 한 줄씩 두고 120x40 한 화면에 열 설명이 들어간다', () => {
  const all = render(view(), 120, 40).map(strip).join('\n');
  for (const word of ['IDLE', 'CONTEXT', '응답 대기']) assert.ok(all.includes(word), word);
});

test('키 안내: hintBar 의 cut 라벨 때문에 보이던 항목이 더 빠지지 않는다 (? 칩은 #290 부터 cut 을 쓰지 않는다)', () => {
  const v = (extra) => ({ data: { sessions: [{ id: 'a' }] }, showDetail: false, ...extra });
  const bar = (extra, W) => strip(footer(v(extra), W, 1, { id: 'a', files: [{ path: '/a' }] }));
  for (const [lang, short] of [['ko', '도움'], ['en', 'help']]) {
    setLang(lang);
    for (const W of [40, 80, 120, 200]) assert.match(bar({}, W), new RegExp(`\\?\\s+${short}\\s+q`), `${lang} W=${W}: 라벨 하나`);
  }
  // 폭마다: 바꾼 라벨이 있든 없든 보이는 항목 수가 같다 (cut 없는 같은 항목과 비교).
  const items = (cut) => [{ k: '/', t: '검색' }, { k: '↑↓', t: '선택' }, { k: 'n', t: '다음' }, { k: 'f', t: '파일' }, { k: 'd', t: '상세 열기' }, { k: 'e', t: '종료 포함' }, { k: 'c', t: '비용 기준' }, { k: 'p', t: '고정' }, { k: '?', t: '도움', ...(cut ? { cut: '키 전체' } : {}), keep: true }, { k: 'q', t: '나가기', keep: true }];
  const chips = (s) => (strip(s).match(/\S+  \S/g) ?? []).length;
  for (let W = 30; W <= 140; W++) {
    const a = strip(hintBar(items(true), W));
    const b = strip(hintBar(items(false), W));
    assert.equal(chips(a), chips(b), `${W}: ${a} / ${b}`);
    assert.ok(width(a) <= W);
  }
  setLang('ko');
  assert.match(bar({ sort: 'cost', group: 'project' }, 80), /s:비용 g:프로젝트/, '정렬·묶기 표시는 남는다');
  for (const W of [30, 34, 40]) assert.match(bar({}, W), /q\s+나가기/, `${W}`);
});

test('키 안내: 바꾼 라벨 때문에 오른쪽 ⊘ 읽기전용이 밀려 사라지면 라벨을 바꾸지 않는다 (#265)', () => {
  setLang('ko');
  const RO = t('foot.readOnly');
  const items = [{ k: '/', t: '검색' }, { k: '↑↓', t: '선택' }, { k: 'n', t: '다음' }, { k: 'f', t: '파일' }, { k: 'd', t: '상세 열기' }, { k: '?', t: '도움', cut: '키 전체', keep: true }, { k: 'q', t: '나가기', keep: true }];
  const plain = items.map(({ cut, ...i }) => i);
  let checked = 0;
  for (let W = 40; W <= 120; W++) {
    const a = strip(hintBar(items, W, RO));
    const b = strip(hintBar(plain, W, RO));
    assert.equal(a.includes(RO), b.includes(RO), `${W}: ${a} / ${b}`);
    if (b.includes(RO) && a.includes('키 전체')) checked++;
  }
  assert.ok(checked > 0, '읽기전용과 키 전체가 함께 보이는 폭도 있다');
});
