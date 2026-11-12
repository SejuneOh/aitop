// aitop --line: tmux 상태줄 같은 곳에 넣을 한 줄 요약. 예) $54.13/$50 wait 2 run 3 $3.1/h
// 글자는 ASCII 만 쓴다 (이모지·폭이 모호한 기호는 tmux 에서 칸이 어긋난다). 표기는 짧은 영어 약어로 고정하고 번역하지 않는다.
// 색은 --line=tmux 일 때 tmux 서식(#[fg=colourN])으로만 넣고 ANSI 코드는 쓰지 않는다. NO_COLOR 면 서식도 넣지 않는다.
// 옵션 오류 문구만 i18n 으로 지금 언어를 따른다.
import { t } from './i18n.mjs';

export const MODES = ['plain', 'tmux'];
export const DEFAULT_WIDTH = 40;
// 캐시가 없을 때(처음 실행) 장부를 읽는 시간 상한. 넘으면 '...' 만 내고 끝낸다 (tmux 를 오래 막지 않게).
export const CAP_MS = 1500;
// 캐시가 없거나 시간 상한을 넘었을 때 내는 글.
export const PENDING = '...';

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

// 값: today(오늘 비용, API 정가 환산), budgetDay(하루 예산, 없으면 null), waiting(응답 대기 수),
// running(작업 중 수, 요약이 없거나 오래됐으면 null), perHour(최근 1시간 지출).
// 0 인 항목은 뺀다. 오늘 비용이 0 이어도 예산이 있으면 $0.00/$50 으로 보인다.
// width 를 넘으면 뒤 항목부터 뺀다. mode 가 tmux 이고 noColor 가 아니면 항목마다 tmux 서식을 씌운다.
export function formatLine({ today = 0, budgetDay = null, waiting = 0, running = null, perHour = 0 } = {}, { mode = 'plain', noColor = false, width = DEFAULT_WIDTH, colorBlind = false } = {}) {
  const c = COLOURS[colorBlind ? 'colorBlind' : 'normal'];
  const parts = [];
  const hasBudget = typeof budgetDay === 'number' && budgetDay > 0;
  if (!zero(today) || hasBudget) parts.push({ text: `${money(zero(today) ? 0 : today)}${hasBudget ? `/${budgetText(budgetDay)}` : ''}`, fg: c.money });
  if (waiting > 0) parts.push({ text: `wait ${waiting}`, fg: c.waiting });
  if (running > 0) parts.push({ text: `run ${running}`, fg: c.running });
  if (!zero(perHour)) parts.push({ text: `${rate(perHour)}/h`, fg: c.money });
  while (parts.length && parts.map((p) => p.text).join(' ').length > width) parts.pop();
  const styled = mode === 'tmux' && !noColor;
  return parts.map((p) => (styled ? `#[fg=${p.fg}]${p.text}#[default]` : p.text)).join(' ');
}

// 요약 파일(summary.mjs)에서 작업 중 수와 응답 대기 수를 고른다. claudeWaiting 은 세션 파일에서 지금 센 Claude 대기 수.
// 대기는 Claude 몫을 늘 지금 값으로 쓰고(요약은 최대 1분 늦다), 다른 도구 몫(지금은 Antigravity)만 요약에서 더한다. 요약이 없으면 Claude 몫만.
// 작업 중은 요약에만 있으므로 요약이 없거나 오래됐으면 null (줄에서 뺀다).
export function pickCounts(summary, claudeWaiting) {
  if (!summary) return { waiting: claudeWaiting, running: null };
  return { waiting: claudeWaiting + summary.waitingOther, running: summary.running };
}

// 장부 캐시와 새로 붙은 줄, 요약 파일만 읽어 값을 모은다 (세션 화면용 기록 전체·프로세스 목록은 읽지 않는다).
// 시간 상한 안에 다 읽지 못했거나 아직 집계 중이면 null. 읽은 만큼은 aitop 캐시에 남아 다음 실행이 이어 읽는다.
export async function collectLine({ capMs = CAP_MS, now = Date.now() } = {}) {
  const { createBudget } = await import('./tail.mjs');
  const { collectLedger } = await import('./sources/claude-ledger.mjs');
  const { claudeWaitingCount } = await import('./sources/claude.mjs');
  const { readSummary } = await import('./summary.mjs');
  const budget = createBudget(Infinity, capMs);
  const usage = collectLedger({ budget, now });
  if (budget.exhausted || usage.loading != null) return null;
  return { today: usage.today.cost, ...pickCounts(readSummary({ now }), claudeWaitingCount()), perHour: usage.lastHour.cost };
}
