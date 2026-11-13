// aitop --line: tmux 상태줄 같은 곳에 넣을 한 줄 요약. 예) $54.13/$50 wait 2 gemini-gen 2m run 3 $3.1/h
// 글자는 ASCII 만 쓴다 (이모지·폭이 모호한 기호는 tmux 에서 칸이 어긋난다). 표기는 짧은 영어 약어로 고정하고 번역하지 않는다.
// 예외는 세션 이름 속 한글·한자·가나뿐이다 (늘 2칸이라 어긋나지 않는다). 그 밖의 글자는 이름에서 지운다.
// 색은 --line=tmux 일 때 tmux 서식(#[fg=colourN])으로만 넣고 ANSI 코드는 쓰지 않는다. NO_COLOR 면 서식도 넣지 않는다.
// 옵션 오류 문구만 i18n 으로 지금 언어를 따른다.
import { t } from './i18n.mjs';
import { fmtAgo, stripControl, truncate, width } from './text.mjs';

export const MODES = ['plain', 'tmux'];
export const DEFAULT_WIDTH = 40;
// 캐시가 없을 때(처음 실행) 장부를 읽는 시간 상한. 넘으면 '...' 만 내고 끝낸다 (tmux 를 오래 막지 않게).
export const CAP_MS = 1500;
// 캐시가 없거나 시간 상한을 넘었을 때 내는 글.
export const PENDING = '...';
// 기다리는 세션 이름의 최대 폭 (칸). 기본 폭 40 에 오늘 비용·예산·대기(이름과 시간)·작업 중이 함께 들어가는 길이.
export const NAME_WIDTH = 12;
// 이름을 자른 자리 표시. … 는 ASCII 가 아니다.
const CUT = '~';

// tmux 256색 번호. 응답 대기는 눈에 띄는 주황, 돈은 화면 헤더와 같은 연두. 색약용은 노랑·파랑 계열로 가른다.
// 작업 중은 눈에 덜 띄는 회색 계열로 둔다 (주목할 것은 대기다).
const COLOURS = { normal: { waiting: 'colour214', money: 'colour154', running: 'colour250' }, colorBlind: { waiting: 'colour226', money: 'colour75', running: 'colour250' } };

// --line, --line=plain|tmux, --line-width <N>, --line-width=<N> 를 꺼낸다. line 은 켜지 않았으면 null.
export function lineOption(argv) {
  let mode = null;
  let width = DEFAULT_WIDTH;
  let error = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--line(?:=(.*))?$/.exec(a);
    if (m) {
      const v = m[1] ?? 'plain';
      if (MODES.includes(v)) mode = v;
      else error ??= t('opt.lineBad', { value: JSON.stringify(v) });
      continue;
    }
    const w = /^--line-width(?:=(.*))?$/.exec(a);
    if (!w) {
      rest.push(a);
      continue;
    }
    const raw = w[1] ?? (argv[i + 1]?.startsWith('-') ? '' : (argv[++i] ?? ''));
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (n > 0) width = n;
    else error ??= raw === '' ? t('opt.lineWidthMissing') : t('opt.lineWidthBad', { value: JSON.stringify(raw) });
  }
  return { mode, width, rest, error };
}

// 오늘 비용: 화면 헤더와 같은 자릿수 (100 달러 아래는 센트까지).
export const money = (x) => (x >= 1000 ? `$${Math.round(x).toLocaleString('en-US')}` : x >= 100 ? `$${x.toFixed(0)}` : `$${x.toFixed(2)}`);
const budgetText = (d) => (Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`);
// 시간당 지출: 짧게 (1 달러 아래만 센트까지).
const rate = (x) => (x >= 100 ? `$${x.toFixed(0)}` : x >= 1 ? `$${x.toFixed(1)}` : `$${x.toFixed(2)}`);
// 표시하면 0 으로 보이는 값은 0 으로 본다.
const zero = (x) => !(Number(x) >= 0.005);

// 이름에 남겨 둘 글자: 보이는 ASCII, 한글, 한자, 가나. 나머지(제어 문자·이모지·폭이 모호한 기호)는 공백으로 바꾼다.
const KEEP = /[\x20-\x7e\u1100-\u115f\u3041-\u30ff\u3131-\u318e\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]/u;

// 상태줄에 넣을 세션 이름: 제어 문자와 색 순서를 지우고, 쓸 수 없는 글자를 빼고, 공백을 하나로 줄여 NAME_WIDTH 칸으로 자른다.
export function lineName(s, max = NAME_WIDTH) {
  // 터미널 순서는 ESC 만 지우면 [31m 같은 꼬리가 남으므로 통째로 지운다: CSI(ESC [ ... 끝 글자), OSC(ESC ] ... BEL 또는 ESC \).
  const bare = String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const kept = [...stripControl(bare)].map((ch) => (KEEP.test(ch) ? ch : ' ')).join('').replace(/\s+/g, ' ').trim();
  return truncate(kept, max, CUT);
}

// 응답 대기 항목의 글: [이름과 대기 시간까지 넣은 글, 수만 넣은 글]. 폭이 모자라면 이름부터 뺀다.
// 하나만 기다리면 수 대신 이름을 쓴다 (wait gemini-gen 2m). 둘 이상이면 수 뒤에 가장 오래 기다린 세션 (wait 3 gemini-gen 2m).
function waitTexts(waiting, longest, now) {
  const count = `wait ${waiting}`;
  const name = longest ? lineName(longest.name) : '';
  if (!name) return [count];
  const age = Number.isFinite(longest.since) ? ` ${fmtAgo(now - longest.since)}` : '';
  return [`${waiting === 1 ? 'wait' : count} ${name}${age}`, count];
}

// 값: today(오늘 비용, API 정가 환산), budgetDay(하루 예산, 없으면 null), waiting(응답 대기 수),
// longest(가장 오래 기다린 세션 { name, since }, 모르면 null), running(작업 중 수, 요약이 없거나 오래됐으면 null), perHour(최근 1시간 지출).
// 0 인 항목은 뺀다. 오늘 비용이 0 이어도 예산이 있으면 $0.00/$50 으로 보인다.
// width 를 넘으면 뒤 항목부터 줄인다: 시간당 지출, 작업 중, 대기 세션 이름, 대기 수, 오늘 비용 차례.
// mode 가 tmux 이고 noColor 가 아니면 항목마다 tmux 서식을 씌운다. tmux 모드에서는 이름 속 # 을 ## 로 바꿔 서식으로 읽히지 않게 한다.
export function formatLine({ today = 0, budgetDay = null, waiting = 0, longest = null, running = null, perHour = 0 } = {}, { mode = 'plain', noColor = false, width: max = DEFAULT_WIDTH, colorBlind = false, now = Date.now() } = {}) {
  const c = COLOURS[colorBlind ? 'colorBlind' : 'normal'];
  // texts: 긴 글부터. 폭이 모자라면 다음 글로 줄이고, 마지막 글도 넘으면 항목을 뺀다.
  const parts = [];
  const hasBudget = typeof budgetDay === 'number' && budgetDay > 0;
  if (!zero(today) || hasBudget) parts.push({ texts: [`${money(zero(today) ? 0 : today)}${hasBudget ? `/${budgetText(budgetDay)}` : ''}`], fg: c.money });
  if (waiting > 0) parts.push({ texts: waitTexts(waiting, longest, now), fg: c.waiting });
  if (running > 0) parts.push({ texts: [`run ${running}`], fg: c.running });
  if (!zero(perHour)) parts.push({ texts: [`${rate(perHour)}/h`], fg: c.money });
  while (parts.length && width(parts.map((p) => p.texts[0]).join(' ')) > max) {
    if (parts.at(-1).texts.length > 1) parts.at(-1).texts.shift();
    else parts.pop();
  }
  const tmux = mode === 'tmux';
  const styled = tmux && !noColor;
  return parts
    .map((p) => {
      const text = tmux ? p.texts[0].replaceAll('#', '##') : p.texts[0];
      return styled ? `#[fg=${p.fg}]${text}#[default]` : text;
    })
    .join(' ');
}

// 요약 파일(summary.mjs)에서 작업 중 수와 응답 대기 수를 고른다. claudeWaiting 은 세션 파일에서 지금 찾은 Claude 대기 세션 [{ name, since }].
// 대기는 Claude 몫을 늘 지금 값으로 쓰고(요약은 최대 1분 늦다), 다른 도구 몫(지금은 Antigravity)만 요약에서 더한다. 요약이 없으면 Claude 몫만.
// longest 는 둘을 합쳐 대기 시작이 가장 이른 세션. 요약이 오래돼 버려지면 다른 도구 몫은 수도 이름도 뺀다.
// 작업 중은 요약에만 있으므로 요약이 없거나 오래됐으면 null (줄에서 뺀다).
export function pickCounts(summary, claudeWaiting = []) {
  const list = [...claudeWaiting, ...(summary?.waitTop ?? [])];
  const at = (w) => (Number.isFinite(w.since) ? w.since : Number.MAX_SAFE_INTEGER);
  const top = list.toSorted((x, y) => at(x) - at(y))[0];
  const pick = top ? { name: top.name, since: top.since } : null;
  if (!summary) return { waiting: claudeWaiting.length, longest: pick, running: null };
  return { waiting: claudeWaiting.length + summary.waitingOther, longest: pick, running: summary.running };
}

// 장부 캐시와 새로 붙은 줄, 요약 파일만 읽어 값을 모은다 (세션 화면용 기록 전체·프로세스 목록은 읽지 않는다).
// 시간 상한 안에 다 읽지 못했거나 아직 집계 중이면 null. 읽은 만큼은 aitop 캐시에 남아 다음 실행이 이어 읽는다.
export async function collectLine({ capMs = CAP_MS, now = Date.now() } = {}) {
  const { createBudget } = await import('./tail.mjs');
  const { collectLedger } = await import('./sources/claude-ledger.mjs');
  const { claudeWaiting } = await import('./sources/claude.mjs');
  const { readSummary } = await import('./summary.mjs');
  const budget = createBudget(Infinity, capMs);
  const usage = collectLedger({ budget, now });
  if (budget.exhausted || usage.loading != null) return null;
  return { today: usage.today.cost, ...pickCounts(readSummary({ now }), claudeWaiting()), perHour: usage.lastHour.cost };
}
