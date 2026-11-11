#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { budgetDayOption, configJson, configPath, configText, readConfigFile, resolveConfig } from '../src/config.mjs';
import { langOption, pickLang, setLang, t } from '../src/i18n.mjs';
import { notifyOptions } from '../src/notify.mjs';
import { lineOption } from '../src/line.mjs';
import { mask, setAmbiguous, stripControl } from '../src/text.mjs';

const KNOWN = new Set(['-h', '--help', '-v', '--version', '--once', '--all', '--json', '--doctor', '--bell', '--show-requests', '--print-config', '--no-bell', '--no-all', '--no-show-requests', '--debug', '--no-debug', '--color-blind', '--no-color-blind']);
const THEMES = ['light', 'dark'];
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// 언어는 다른 옵션의 오류 문구보다 먼저 정한다: --lang > AITOP_LANG > 설정 파일 lang > LC_ALL > LC_MESSAGES > LANG.
// 설정 파일의 문제 문구는 읽을 때 만들어지므로(처음엔 한국어) 언어가 한국어가 아니면 한 번 더 읽는다.
const langOpt = langOption(process.argv.slice(2));
const cfgPath = configPath();
let cfgFile = readConfigFile(cfgPath);
if (setLang(pickLang({ flag: langOpt.value, file: cfgFile.values.lang })) !== 'ko') cfgFile = readConfigFile(cfgPath);
if (langOpt.error) {
  process.stderr.write(`aitop: ${t(...langOpt.error)}\n`);
  process.exit(2);
}

// --notify, --no-notify, --on-waiting, --no-on-waiting 은 notifyOptions 한 곳에서 해석한다. 여기서는 명령줄에서 준 값만 본다.
const cliArgs = langOpt.rest;
const cli = notifyOptions(cliArgs);
if (cli.error) {
  process.stderr.write(`aitop: ${cli.error}\n`);
  process.exit(2);
}
// --budget-day <usd>, --budget-day=<usd>, --no-budget-day 는 budgetDayOption 이 꺼낸다.
const budget = budgetDayOption(cli.rest);
if (budget.error) {
  process.stderr.write(`aitop: ${budget.error}\n`);
  process.exit(2);
}
// --line, --line=tmux, --line-width <N> 은 lineOption 이 꺼낸다.
const line = lineOption(budget.rest);
if (line.error) {
  process.stderr.write(`aitop: ${line.error}\n`);
  process.exit(2);
}
// 사용자가 준 NO_COLOR. 아래에서 파이프 출력이면 NO_COLOR 를 켜므로 그 전에 읽어 둔다 (tmux 의 #() 는 TTY 가 아니다).
const userNoColor = Boolean(process.env.NO_COLOR);
// --theme light, --theme=light 처럼 값을 받는 옵션은 따로 꺼낸다.
const argv = line.rest;
let theme = null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--theme(?:=(.*))?$/.exec(argv[i]);
  if (!m) rest.push(argv[i]);
  else theme = m[1] ?? (argv[i + 1]?.startsWith('-') ? '' : (argv[++i] ?? ''));
}
const args = new Set(rest);

// 옵션 > 환경 변수 > 설정 파일 > 기본값. 잘못된 --theme 값은 아래에서 모르는 옵션으로 알린다.
// --bell 과 --no-bell 처럼 켜고 끄는 옵션은 뒤에 준 쪽을 따른다.
const flag = (name) => {
  const on = rest.lastIndexOf(`--${name}`);
  const off = rest.lastIndexOf(`--no-${name}`);
  return on < 0 && off < 0 ? undefined : on > off;
};
// notify 는 --notify 가 뒤에 오면 true, --no-notify 가 뒤에 오면 false, 둘 다 없으면 정하지 않은 것이다.
const notifyFlag = cli.notify ? true : notifyOptions(cliArgs, { notify: true }).notify ? undefined : false;
// onWaiting 은 --on-waiting 이 뒤에 오면 그 명령, --no-on-waiting 이 뒤에 오면 null(끔), 둘 다 없으면 정하지 않은 것이다.
const onWaitingFlag = cli.onWaiting ?? (notifyOptions(cliArgs, { onWaiting: 'x' }).onWaiting === null ? null : undefined);
const config = resolveConfig({ flags: { theme: THEMES.includes(theme) ? theme : undefined, colorBlind: flag('color-blind'), bell: flag('bell'), showRequests: flag('show-requests'), all: flag('all'), debug: flag('debug'), notify: notifyFlag, onWaiting: onWaitingFlag, budgetDay: budget.value, lang: langOpt.value }, file: cfgFile });
const opt = Object.fromEntries(Object.entries(config.values).map(([k, v]) => [k, v.value]));
// 알림은 설정 파일 값(onWaiting 은 권한 검사를 통과한 것만)을 깔고 명령줄 옵션이 덮는다.
const fromFile = (k) => (config.values[k].source === 'file' ? config.values[k].value : undefined);
const alerts = notifyOptions(cliArgs, { notify: fromFile('notify'), onWaiting: fromFile('onWaiting') });
// 화면 모듈과 표식 모듈은 불러올 때 테마·아이콘을 고르므로 그 전에 넘긴다.
if (opt.theme) process.env.AITOP_THEME = opt.theme;
process.env.AITOP_COLOR_BLIND = opt.colorBlind ? '1' : '0';
if (config.values.icons.source === 'file') process.env.AITOP_ICONS = opt.icons;
// 폭이 모호한 기호를 2칸으로 셀지는 글자 폭 계산(text.mjs)이 쓴다. 화면 모듈은 그릴 때마다 이 값을 본다.
setAmbiguous(opt.ambiguous);
const { BRAND, userVarsSeq } = await import('../src/brand.mjs');
const { keysText } = await import('../src/help.mjs');
const { debug, initLog, logPath } = await import('../src/log.mjs');

// 실시간 화면에 들어간 뒤에는 restore 가 터미널을 되돌리고 훅을 끝낸다. 그 전에는 할 일이 없다.
let restore = () => {};
process.on('unhandledRejection', (reason) => {
  debug('aitop', 'unhandledRejection', reason);
  try {
    restore();
  } catch {}
  const why = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`aitop: ${t('cli.unhandled', { why: stripControl(mask(why)).slice(0, 200) })}\n`);
  process.exit(1);
});

// --help 문구는 i18n.mjs 의 help.usage 표에 있다.
const HELP = t('help.usage', { logo: BRAND.logo, logPath: logPath(), configPath: config.path, keys: keysText().replace(/^/gm, '  ') });

if (theme === '') {
  process.stderr.write(`aitop: ${t('cli.themeMissing')}\n`);
  process.exit(2);
}
const unknown = [...args].filter((a) => !KNOWN.has(a));
if (theme != null && !THEMES.includes(theme)) unknown.push(`--theme ${theme}`);
if (unknown.length) {
  process.stderr.write(`aitop: ${t('cli.unknown', { opts: unknown.join(' ') })}\n\n${HELP}\n`);
  process.exit(2);
}
if (args.has('-h') || args.has('--help')) {
  console.log(HELP);
  process.exit(0);
}
if (args.has('-v') || args.has('--version')) {
  console.log(VERSION);
  process.exit(0);
}
if (args.has('--print-config')) {
  console.log(args.has('--json') ? JSON.stringify(configJson(config), null, 2) : configText(config));
  process.exit(0);
}

// 디버그 로그는 켰을 때만 파일을 만든다. --help·--version·--print-config 처럼 바로 끝나는 경우에는 만들지 않는다.
const log = initLog({ enabled: opt.debug, version: VERSION });
if (opt.debug && !log.on) process.stderr.write(`aitop: ${t('cli.logOff', { path: log.path })}\n`);

// --line: 세션 화면·프로세스 목록 없이 장부 캐시만 읽어 한 줄을 내고 끝낸다. 실패해도 tmux 에 오류를 남기지 않게 0 으로 끝낸다.
if (line.mode) {
  const { collectLine, formatLine, PENDING } = await import('../src/line.mjs');
  const { flushCache } = await import('../src/cache.mjs');
  let text = PENDING;
  try {
    // AITOP_LINE_MS: 시간 상한(ms). 테스트에서 캐시 없는 첫 실행을 흉내 낼 때 쓴다.
    const capMs = Number(process.env.AITOP_LINE_MS) > 0 ? Number(process.env.AITOP_LINE_MS) : undefined;
    const v = await collectLine({ capMs });
    if (v) text = formatLine({ ...v, budgetDay: opt.budgetDay }, { mode: line.mode, noColor: userNoColor, width: line.width, colorBlind: opt.colorBlind });
    flushCache();
  } catch (e) {
    debug('aitop', 'line failed', e);
  }
  await new Promise((resolve) => process.stdout.write(text + '\n', resolve));
  process.exit(0);
}

// 파이프나 파일로 받을 때는 색 코드를 넣지 않는다. 화면 모듈이 불러올 때 NO_COLOR 를 읽으므로 그 전에 정한다.
const forced = process.env.FORCE_COLOR != null && !['', '0', 'false'].includes(process.env.FORCE_COLOR);
if (!process.stdout.isTTY && !forced && !process.env.NO_COLOR) process.env.NO_COLOR = '1';

// 받는 쪽(| head 등)이 먼저 닫으면 조용히 끝낸다.
process.stdout.on('error', (err) => process.exit(err.code === 'EPIPE' ? 0 : 1));
// 다 쓴 뒤에 끝낸다 (파이프로 넘길 때 64KB 넘는 출력이 잘리지 않게).
const printAndExit = async (text) => {
  await new Promise((resolve) => process.stdout.write(text + '\n', resolve));
  process.exit(0);
};

// 알림은 실시간 화면에서만 동작한다.
if ((cli.notify || cli.onWaiting) && (args.has('--once') || args.has('--json') || args.has('--doctor') || !process.stdout.isTTY)) {
  process.stderr.write(`aitop: ${t('cli.notifyLiveOnly')}\n`);
}

const { checkTools, doctorText, toolsJson } = await import('../src/doctor.mjs');
if (args.has('--doctor')) {
  const result = { ...checkTools(), config: configJson(config), log: { on: log.on, path: log.path } };
  await printAndExit(args.has('--json') ? JSON.stringify({ version: VERSION, ...result, tools: toolsJson(result.tools) }, null, 2) : doctorText(result, VERSION));
}

const { collect } = await import('../src/collect.mjs');
const { render, filterSessions, animating } = await import('../src/ui.mjs');
const { arrange } = await import('../src/order.mjs');
const { frameTimer } = await import('../src/frames.mjs');
const { flushCache } = await import('../src/cache.mjs');
const { toJson } = await import('../src/json.mjs');
const { createAttention, updateAttention, markSeen, nextAttention, windowTitle, createWaitWatch, takeNewlyWaiting, attentionCounts } = await import('../src/attention.mjs');
const { createNotifier } = await import('../src/notify.mjs');
const { onKey, fixFocus } = await import('../src/keys.mjs');

// 요청 전체 보기는 기본으로 꺼 둔다. 켜지 않으면 상세 패널에도 --json 에도 나가지 않는다.
const showRequests = opt.showRequests;
// settings: 도움말(?)에 보이는 지금 설정 값.
const settings = { budgetDay: opt.budgetDay, notify: Boolean(alerts.notify), onWaiting: Boolean(alerts.onWaiting), debug: log.on, configPath: config.path };
const view = { showRequests, budgetDay: opt.budgetDay, hideIdleTools: opt.hideIdleTools, settings, data: null, selectedId: null, showDetail: 'auto', showEnded: opt.all, frame: 0, filter: '', searching: false, help: false, focus: null, filePath: null, diffScroll: 0, tab: 'now', costMode: 'api', sort: 'default', group: 'none', pins: [] };
const once = args.has('--once') || args.has('--json') || !process.stdout.isTTY;
// 실시간 화면에서 한 번 갱신할 때 읽는 기록 양과 시간. 큰 기록은 여러 번에 나눠 읽어서 키 입력이 막히지 않게 한다.
const TICK_BUDGET = 24 * 1024 * 1024;
const TICK_MS = 60;
// 덜 읽은 기록이 있으면 1초를 기다리지 않고 이만큼 쉰 뒤 이어 읽는다 (그 사이 키 입력과 그리기가 돈다).
const CATCH_UP_MS = 15;
// 처음 읽는 동안은 캐시를 자주 저장해, 도중에 끝내도 읽은 만큼은 남게 한다.
const LOADING_FLUSH_MS = 3000;

const attention = createAttention();
let tools = null;
// --bell · --notify · --on-waiting: 실시간 화면에서만, 첫 갱신에서 이미 응답 대기인 세션은 알리지 않는다.
const bell = opt.bell;
const waitWatch = createWaitWatch();
const notifier = !once && (alerts.notify || alerts.onWaiting) ? createNotifier(alerts) : null;

function refresh() {
  const data = collect({ showEnded: view.showEnded, selectedId: view.selectedId, budgetBytes: once ? Infinity : TICK_BUDGET, budgetMs: once ? Infinity : TICK_MS });
  if (!data.sessions.some((s) => s.id === view.selectedId)) {
    view.selectedId = arrange(data.sessions, view).sessions[0]?.id ?? null;
    view.focus = null;
    view.tab = 'now';
  }
  updateAttention(attention, data.sessions, view.selectedId);
  data.sessions = data.sessions.map((s) => (attention.unseen.has(s.id) ? { ...s, unseen: true, phase: { kind: 'unseen', text: '완료 · 확인 전' }, plain: s } : s));
  // 도구별 점검은 기록 폴더를 훑으므로 30초에 한 번만 한다.
  if (!tools || Date.now() - tools.at > 30_000) tools = { at: Date.now(), result: checkTools() };
  data.tools = tools.result;
  view.data = data;
  if (!once && (bell || notifier)) {
    const fresh = takeNewlyWaiting(waitWatch, data.sessions);
    if (fresh.length && bell) process.stdout.write('\x07');
    notifier?.fire(fresh);
  }
  if (view.filter) keepSelectionVisible();
  fixFocus(view);
}

function select(id) {
  if (id !== view.selectedId) {
    view.focus = null;
    view.tab = 'now';
  }
  view.selectedId = id;
  markSeen(attention, id);
}

if (once) {
  refresh();
  flushCache();
  const size = (v) => (Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const W = process.stdout.columns || size(process.env.COLUMNS) || 140;
  const H = process.stdout.rows || size(process.env.LINES) || 40;
  await printAndExit(args.has('--json') ? JSON.stringify(toJson(view.data, VERSION, { showRequests, budgetDay: opt.budgetDay }), null, 2) : render(view, W, H).join('\n'));
}

const out = process.stdout;
const stdin = process.stdin;
let last = '';
let lastTitle = '';
// 스피너처럼 움직이는 표시가 있을 때만 120ms 마다 다시 그린다. 없으면 데이터 갱신·키 입력·창 크기 변경 때만 그린다.
const frames = frameTimer({
  ms: 120,
  animating: () => animating(view),
  onFrame: () => {
    view.frame++;
    draw();
  },
});

function draw() {
  frames.sync();
  view.rows = out.rows;
  const frame = render(view, out.columns, out.rows).join('\r\n');
  const title = windowTitle(view.data?.sessions ?? [], BRAND.tab);
  if (title !== lastTitle) {
    lastTitle = title;
    out.write(`\x1b]0;${title}\x07`);
    // WezTerm 탭 제목에서 읽을 수 있게 같은 수를 user var 로도 내보낸다.
    if (BRAND.userVars) out.write(userVarsSeq(attentionCounts(view.data?.sessions ?? [])));
  }
  if (frame === last) return;
  last = frame;
  out.write('\x1b[?2026h\x1b[H' + frame + '\x1b[?2026l');
}

function enterScreen() {
  // 창 제목을 저장해 두었다가 끝낼 때 되돌린다 (지원하지 않는 터미널은 무시한다).
  out.write('\x1b[22;0t\x1b[?1049h\x1b[?25l\x1b[2J');
  lastTitle = '';
  stdin.setRawMode(true);
  stdin.resume();
  last = '';
}

function leaveScreen() {
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l\x1b[23;0t' + (BRAND.userVars ? userVarsSeq(null) : ''));
  if (stdin.isTTY) stdin.setRawMode(false);
}

restore = () => {
  notifier?.killAll();
  leaveScreen();
  flushCache();
};

function quit() {
  notifier?.killAll();
  leaveScreen();
  flushCache();
  process.exit(0);
}

enterScreen();
draw();
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('SIGHUP', quit);
process.on('SIGQUIT', quit);
process.on('SIGCONT', () => {
  enterScreen();
  draw();
});
process.on('uncaughtException', (err) => {
  debug('aitop', 'uncaughtException', err);
  notifier?.killAll();
  leaveScreen();
  try {
    flushCache();
  } catch {}
  console.error(err);
  process.exit(1);
});
out.on('resize', () => {
  last = '';
  out.write('\x1b[2J');
  draw();
});

// 화면에 그린 순서 그대로 (정렬·묶기 반영). ↑↓ 와 n 이 이 순서를 따른다.
const visible = () => arrange(filterSessions(view.data?.sessions ?? [], view.filter), view).sessions;

function move(delta) {
  const list = visible();
  if (!list.length) return;
  const i = Math.max(0, list.findIndex((s) => s.id === view.selectedId));
  goTo(list[Math.min(list.length - 1, Math.max(0, i + delta))]);
}

function goTo(next) {
  if (!next) return;
  select(next.id);
  // 아직 본문을 읽지 않은 종료 세션을 고르면 다음 갱신을 기다리지 않고 바로 읽는다. 그 밖에는 전체 갱신 없이 화면만 바꾼다.
  if (next.lazy) return refresh();
  if (next.unseen) view.data.sessions = view.data.sessions.map((s) => (s.id === next.id ? s.plain : s));
}

function keepSelectionVisible() {
  const list = visible();
  if (list.length && !list.some((s) => s.id === view.selectedId)) select(list[0].id);
}

stdin.setEncoding('utf8');
const act = {
  quit,
  refresh,
  move,
  next: () => goTo(nextAttention(attention, visible(), view.selectedId)),
  keepVisible: keepSelectionVisible,
};

stdin.on('data', (key) => {
  onKey(view, key, act);
  draw();
});

let lastFlush = 0;
function tick() {
  refresh();
  const more = view.data?.more;
  if (more ? Date.now() - lastFlush > LOADING_FLUSH_MS : Date.now() - lastFlush > 15_000) {
    flushCache();
    lastFlush = Date.now();
  }
  draw();
  setTimeout(tick, more ? CATCH_UP_MS : 1000);
}

setTimeout(tick, 30);
