#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { budgetDayOption, configJson, configPath, configText, parseRemote, readConfigFile, remoteOption, resolveConfig } from '../src/config.mjs';
import { langOption, pickLang, setLang, t } from '../src/i18n.mjs';
import { notifyOptions } from '../src/notify.mjs';
import { lineOption } from '../src/line.mjs';
import { reportOption } from '../src/report.mjs';
import { suggest } from '../src/suggest.mjs';
import { mask, setAmbiguous, stripControl } from '../src/text.mjs';

const KNOWN = new Set(['-h', '--help', '-v', '--version', '--once', '--all', '--json', '--doctor', '--bell', '--show-requests', '--print-config', '--no-bell', '--no-all', '--no-show-requests', '--debug', '--no-debug', '--color-blind', '--no-color-blind']);
const THEMES = ['light', 'dark'];
// 잘못 친 옵션에 제안할 후보. KNOWN 의 긴 옵션과, 다른 모듈이 먼저 꺼내는 값 옵션을 합친다.
const OPTIONS = [...[...KNOWN].filter((o) => o.startsWith('--')), '--theme', '--lang', '--notify', '--no-notify', '--on-waiting', '--no-on-waiting', '--budget-day', '--no-budget-day', '--line', '--line-width', '--report', '--by', '--days', '--months', '--since', '--plan', '--md', '--show-prompts', '--remote', '--no-remote'];
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
// --report daily|monthly|sessions|trace <세션>, --by tool|model|project, --days <N>, --months <N>, --since, --plan, --md, --show-prompts 는 reportOption 이 꺼낸다.
const report = reportOption(line.rest);
if (report.error) {
  process.stderr.write(`aitop: ${report.error}\n`);
  process.exit(2);
}
// --remote <목록>, --remote=<목록>, --no-remote 는 remoteOption 이 꺼낸다 (#308). 잘못된 호스트 이름은 여기서 끝낸다.
const remoteOpt = remoteOption(report.rest);
if (remoteOpt.error) {
  process.stderr.write(`aitop: ${remoteOpt.error}\n`);
  process.exit(2);
}
// 사용자가 준 NO_COLOR. 아래에서 파이프 출력이면 NO_COLOR 를 켜므로 그 전에 읽어 둔다 (tmux 의 #() 는 TTY 가 아니다).
const userNoColor = Boolean(process.env.NO_COLOR);
// --theme light, --theme=light 처럼 값을 받는 옵션은 따로 꺼낸다.
const argv = remoteOpt.rest;
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
// --notify=<종류> 로 종류를 정했으면 그 배열을 값으로 둔다 (--print-config 에 보이게).
const notifyFlag = cli.notify ? (cli.eventsSet ? cli.events : true) : notifyOptions(cliArgs, { notify: true }).notify ? undefined : false;
// onWaiting 은 --on-waiting 이 뒤에 오면 그 명령, --no-on-waiting 이 뒤에 오면 null(끔), 둘 다 없으면 정하지 않은 것이다.
const onWaitingFlag = cli.onWaiting ?? (notifyOptions(cliArgs, { onWaiting: 'x' }).onWaiting === null ? null : undefined);
const config = resolveConfig({ flags: { theme: THEMES.includes(theme) ? theme : undefined, colorBlind: flag('color-blind'), bell: flag('bell'), showRequests: flag('show-requests'), all: flag('all'), debug: flag('debug'), notify: notifyFlag, onWaiting: onWaitingFlag, budgetDay: budget.value, lang: langOpt.value, remotes: remoteOpt.value }, file: cfgFile });
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
// 읽을 Claude·Codex 기록 폴더 목록. 기록을 읽는 모듈을 불러오기 전에 정한다 (#212).
const { setDataDirs } = await import('../src/sources/dirs.mjs');
// agyApp 은 정하지 않았으면(기본값) 넘기지 않아 AITOP_AGY_HOME 격리 규칙(antigravity.mjs findAgyRoots)을 그대로 따른다.
// cowork(#304)도 같다: 기본값이면 넘기지 않고 findCoworkRoots 가 AITOP_COWORK_HOME 과 저절로 찾기를 따른다.
const chosen = (k) => (config.values[k].source === 'default' ? undefined : opt[k]);
setDataDirs({ claude: opt.claudeDirs, codex: opt.codexHomes, agyApp: chosen('agyApp'), cowork: chosen('cowork') });
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
// 모르는 옵션은 도움말 전체 대신 가까운 옵션 제안과 --help 안내 한 줄만 낸다 (#291).
const unknown = [...args].filter((a) => !KNOWN.has(a)).map((a) => {
  const near = a.startsWith('-') ? suggest(a, OPTIONS) : null;
  return near ? `${a} ${t('cli.didYouMean', { opt: near })}` : a;
});
if (theme != null && !THEMES.includes(theme)) {
  const near = suggest(theme, THEMES);
  unknown.push(`--theme ${theme} ${near ? t('cli.didYouMean', { opt: `--theme ${near}` }) : t('cli.themeValues')}`);
}
if (unknown.length) {
  process.stderr.write(`aitop: ${t('cli.unknown', { opts: stripControl(unknown.join(', ')) })}\naitop: ${t('cli.seeHelp')}\n`);
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

// --report: 날짜별 사용량 표(또는 --json)를 내고 끝낸다. 실시간 화면·세션 목록은 읽지 않고 장부만 읽는다.
// --report monthly 는 월별 보관함(monthly.mjs)과 장부를 합친다.
// 처음 실행은 30일치(monthly 는 1년치) 기록을 읽으므로 stderr 가 터미널이면 진행률을 보이고, 시간 상한(AITOP_REPORT_MS, 기본 120초)을 넘으면 읽은 만큼 낸다.
// --report sessions: 기간 안 세션별 한 줄과 요약 카드. 진행률·시간 상한은 daily 와 같다. --md 는 Markdown, --json 은 JSON.
if (report.kind === 'sessions') {
  const { collectSessions, buildSessions, formatSessions, sessionsMarkdown, sessionsJson } = await import('../src/sessions-report.mjs');
  const { progressWriter, MAX_DAYS } = await import('../src/report.mjs');
  const { flushCache } = await import('../src/cache.mjs');
  const json = args.has('--json');
  if (json && report.md) {
    process.stderr.write(`aitop: ${t('opt.mdJson')}\n`);
    process.exit(2);
  }
  if (report.capped) process.stderr.write(`aitop: ${t('sessions.capped', { n: MAX_DAYS })}\n`);
  const progress = progressWriter();
  const maxMs = Number(process.env.AITOP_REPORT_MS) > 0 ? Number(process.env.AITOP_REPORT_MS) : undefined;
  const now = Date.now();
  const got = await collectSessions({ since: report.since, now, maxMs, onProgress: progress.update });
  progress.done();
  flushCache();
  if (got.partial && json) process.stderr.write(`aitop: ${t('report.partial')}\n`);
  const r = buildSessions(got.books, { since: report.since, now, extra: got.extra, agy: got.agy, plan: report.plan });
  const cols = process.stdout.isTTY ? process.stdout.columns : Number(process.env.COLUMNS) || 0;
  const opts = { partial: got.partial, prompts: report.prompts };
  const text = json ? JSON.stringify(sessionsJson(r, VERSION, opts), null, 2) : report.md ? sessionsMarkdown(r, opts) : formatSessions(r, { ...opts, cols });
  process.stdout.on('error', (err) => process.exit(err.code === 'EPIPE' ? 0 : 1));
  await new Promise((resolve) => process.stdout.write(text + '\n', resolve));
  process.exit(0);
}

// --report trace <세션>: 세션 하나의 호출 트리 (trace.mjs). 장부·캐시·실시간 tracker 없이 기록 파일만 한 번 읽는다. Codex·agy 는 미지원으로 알린다.
if (report.kind === 'trace') {
  const { findTrace, readTrace, build, formatTrace, traceMarkdown, traceJson, candidatesText, STALE_MS } = await import('../src/trace.mjs');
  const json = args.has('--json');
  if (json && report.md) {
    process.stderr.write(`aitop: ${t('opt.mdJson')}\n`);
    process.exit(2);
  }
  const query = stripControl(report.session);
  const found = await findTrace(report.session);
  if (found.error) {
    const head = t(found.error === 'many' ? 'trace.many' : 'trace.notFound', { query: JSON.stringify(query) });
    process.stderr.write(`aitop: ${head}\n${found.error === 'many' ? candidatesText(found.candidates) + '\n' : ''}`);
    process.exit(found.error === 'many' ? 2 : 1);
  }
  if (found.tool !== 'claude') {
    process.stderr.write(`aitop: ${t('trace.unsupported', { tool: found.tool === 'agy' ? 'Antigravity' : 'Codex' })}\n`);
    process.exit(1);
  }
  const { lines, subagents, mtime } = await readTrace(found.path, { showArgs: report.prompts });
  // 기록이 STALE_MS 넘게 바뀌지 않았으면 끝난 세션으로 본다 (결과 없는 도구를 진행 중으로 두지 않는다).
  const r = build(lines, { subagents, showArgs: report.prompts, ended: Date.now() - mtime > STALE_MS });
  const meta = { id: found.id, name: found.name };
  const cols = process.stdout.isTTY ? process.stdout.columns : Number(process.env.COLUMNS) || 0;
  const text = json ? JSON.stringify(traceJson(r, VERSION, meta), null, 2) : report.md ? traceMarkdown(r, meta) : formatTrace(r, meta, { cols });
  process.stdout.on('error', (err) => process.exit(err.code === 'EPIPE' ? 0 : 1));
  await new Promise((resolve) => process.stdout.write(text + '\n', resolve));
  process.exit(0);
}

if (report.kind) {
  const { buildMonthly, buildReport, collectMonthly, collectReport, fitReport, formatReport, PIPE_COLUMNS, progressWriter, reportJson, MAX_DAYS, MAX_MONTHS } = await import('../src/report.mjs');
  const { flushCache } = await import('../src/cache.mjs');
  const monthly = report.kind === 'monthly';
  if (report.capped) process.stderr.write(`aitop: ${monthly ? t('report.cappedMonths', { n: MAX_MONTHS }) : t('report.capped', { n: MAX_DAYS })}\n`);
  const progress = progressWriter();
  const maxMs = Number(process.env.AITOP_REPORT_MS) > 0 ? Number(process.env.AITOP_REPORT_MS) : undefined;
  const now = Date.now();
  // monthly: 보관함(monthly.json)과 장부를 합친다. 처음이면 1년치 기록을 한 번 읽어 보관함을 채운다.
  const got = monthly ? await collectMonthly({ maxMs, now, onProgress: progress.update }) : await collectReport({ days: report.days, maxMs, now, by: report.by, onProgress: progress.update });
  progress.done();
  flushCache();
  if (got.partial && args.has('--json')) process.stderr.write(`aitop: ${t('report.partial')}\n`);
  // --by project 표는 터미널 폭(터미널이 아니면 COLUMNS 를 export 한 경우에만 그 폭, 아니면 열 8개)에 맞춰 열을 줄이고 나머지를 하나로 합친다 (--json 은 다 낸다).
  const fit = report.by === 'project' && !args.has('--json');
  const cols = process.stdout.isTTY ? process.stdout.columns : Number(process.env.COLUMNS) || 0;
  const maxColumns = fit && !cols ? PIPE_COLUMNS : Infinity;
  let r = monthly ? buildMonthly(got.books, got.archive, { by: report.by, months: report.months, now, viewLo: got.viewLo, liveLo: got.liveLo, partial: got.partial, maxColumns }) : buildReport(got.books, { by: report.by, days: report.days, now, maxColumns });
  if (fit && cols) r = fitReport(r, cols);
  const text = args.has('--json') ? JSON.stringify(reportJson(r, VERSION, { partial: got.partial }), null, 2) : formatReport(r, { partial: got.partial });
  process.stdout.on('error', (err) => process.exit(err.code === 'EPIPE' ? 0 : 1));
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
  // 진단은 한 번 돌고 끝나므로 Windows 의 첫 PowerShell CIM 호출을 더 오래 기다린다 (procs.mjs WIN_DOCTOR_TIMEOUT_MS).
  const { setFirstScanTimeout, WIN_DOCTOR_TIMEOUT_MS } = await import('../src/procs.mjs');
  setFirstScanTimeout(WIN_DOCTOR_TIMEOUT_MS);
  const result = { ...checkTools(), config: configJson(config), log: { on: log.on, path: log.path }, remotes: (opt.remotes ?? []).map((n) => parseRemote(n)?.name).filter(Boolean) };
  await printAndExit(args.has('--json') ? JSON.stringify({ version: VERSION, ...result, tools: toolsJson(result.tools) }, null, 2) : doctorText(result, VERSION));
}

// 설정 파일의 onWaiting 을 받지 않았으면 실행할 때도 알린다 (--doctor·--print-config 에는 problems 로 보인다).
if (cfgFile.onWaitingIgnored && !cli.onWaiting) process.stderr.write(`aitop: ${cfgFile.onWaitingIgnored}\n`);

const { collect } = await import('../src/collect.mjs');
const { render, pipeLines, filterSessions, animating } = await import('../src/ui.mjs');
const { arrange } = await import('../src/order.mjs');
const { frameTimer } = await import('../src/frames.mjs');
const { flushCache } = await import('../src/cache.mjs');
const { toJson } = await import('../src/json.mjs');
const { createSummaryWriter, summarize, writeSummary } = await import('../src/summary.mjs');
const { createAttention, updateAttention, markSeen, nextAttention, windowTitle, createWaitWatch, takeNewlyWaiting, attentionCounts, createEventWatch, takeEvents } = await import('../src/attention.mjs');
const { applyNotifyToggle, createNotifier, createNotifyToggle, notifyExplicitOff, notifyHintDue } = await import('../src/notify.mjs');
const { onKey, fixFocus } = await import('../src/keys.mjs');
const { admit, createLoading, latchReady } = await import('../src/loading.mjs');
const { osc52, resumeCmd } = await import('../src/resume.mjs');

// --remote (#308): 원격을 켰을 때만 remote.mjs 를 불러온다 (--report·--line 은 위에서 이미 끝났다).
// 폴러가 뒤에서 원격마다 aitop --json 을 부르고, refresh 가 그 마지막 결과를 로컬 세션 뒤에 붙인다.
let poller = null;
let mergeRemote = null;
if (opt.remotes?.length) {
  const remote = await import('../src/remote.mjs');
  poller = remote.createRemotePoller(remote.remoteTargets(opt.remotes));
  mergeRemote = remote.mergeRemote;
}

// 요청 전체 보기는 기본으로 꺼 둔다. 켜지 않으면 상세 패널에도 --json 에도 나가지 않는다.
const showRequests = opt.showRequests;
// settings: 도움말(?)에 보이는 지금 설정 값.
const settings = { budgetDay: opt.budgetDay, notify: Boolean(alerts.notify), events: alerts.events, onWaiting: Boolean(alerts.onWaiting), debug: log.on, configPath: config.path };
const view = { showRequests, budgetDay: opt.budgetDay, hideIdleTools: opt.hideIdleTools, settings, data: null, selectedId: null, showDetail: 'auto', showEnded: opt.all, frame: 0, filter: '', searching: false, help: false, focus: null, filePath: null, diffScroll: 0, tab: 'now', costMode: 'api', sort: 'default', group: 'none', pins: [] };
const once = args.has('--once') || args.has('--json') || !process.stdout.isTTY;
// ready: 시작할 때 세션 기록을 다 읽었는지 (loading.mjs). 그 전에는 비용·컨텍스트 정렬과 ▲ 를 고정한다. 한 번에 다 읽는 --once·--json 은 처음부터 준비 완료다.
view.ready = once;
const loading = createLoading();
// 실시간 화면에서 한 번 갱신할 때 읽는 기록 양과 시간. 큰 기록은 여러 번에 나눠 읽어서 키 입력이 막히지 않게 한다.
// AITOP_TICK_BYTES: 테스트에서 캐시 없는 긴 로딩을 흉내 낼 때 쓴다.
const TICK_BUDGET = Number(process.env.AITOP_TICK_BYTES) > 0 ? Number(process.env.AITOP_TICK_BYTES) : 24 * 1024 * 1024;
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
// 실시간 화면에서는 알림이 꺼져 있어도 알리미를 둔다. a 키로 데스크톱 알림을 이번 실행에만 켤 수 있게 (#294).
const notifier = !once ? createNotifier(alerts) : null;
// 켜기 힌트는 설정 파일이나 --no-notify 로 직접 끄지 않았을 때만 띄운다.
// --notify 로 켰어도 알림 도구가 없으면 키 줄·도움말에 꺼짐으로 보인다 (알리미에 desk 가 없다).
const notifyToggle = createNotifyToggle({ on: alerts.notify, explicitOff: notifyExplicitOff(config.values.notify, alerts.notify), available: once || Boolean(notifier?.desk) });
settings.notify = notifyToggle.on;
if (!once) view.notify = notifyToggle.on;
// 끝남(done)·context 경고는 켠 경우에만 센다 (#204). 벨은 늘 응답 대기만 울린다.
const eventKinds = alerts.events.filter((k) => k !== 'waiting');
const eventWatch = notifier && eventKinds.length ? createEventWatch({ doneMs: opt.doneMinutes * 60_000 }) : null;

// throttle: 주기 갱신(tick)에서만 참이다. 로딩 중에는 loading.mjs 의 admit 이 허락할 때만 화면 데이터를 바꾼다.
// 알림(벨·--notify·--on-waiting)은 화면에 올리지 않은 갱신에서도 그대로 돈다. 돌려주는 값은 화면 데이터를 바꿨는지.
function refresh({ throttle = false } = {}) {
  const data = collect({ showEnded: view.showEnded, selectedId: view.selectedId, budgetBytes: once ? Infinity : TICK_BUDGET, budgetMs: once ? Infinity : TICK_MS });
  // 원격 결과를 붙인다. 새로 붙은 원격의 세션은 응답 대기 알림의 기준선으로만 넣는다 (remote.mjs mergeRemote).
  if (poller) mergeRemote(data, poller, waitWatch);
  // 준비 완료를 먼저 정해, 처음 고르는 세션도 이번 갱신의 정렬을 따르게 한다.
  if (!once) latchReady(loading, data.sessionsMore);
  if (!data.sessions.some((s) => s.id === view.selectedId)) {
    view.selectedId = arrange(data.sessions, { ...view, ready: once || loading.ready }).sessions[0]?.id ?? null;
    view.focus = null;
    view.tab = 'now';
  }
  updateAttention(attention, data.sessions, view.selectedId);
  data.sessions = data.sessions.map((s) => (attention.unseen.has(s.id) ? { ...s, unseen: true, phase: { kind: 'unseen' }, plain: s } : s));
  // 도구별 점검은 기록 폴더를 훑으므로 30초에 한 번만 한다.
  if (!tools || Date.now() - tools.at > 30_000) tools = { at: Date.now(), result: checkTools() };
  data.tools = tools.result;
  if (!once && (bell || notifier)) {
    const fresh = takeNewlyWaiting(waitWatch, data.sessions);
    if (fresh.length && bell) process.stdout.write('\x07');
    if (alerts.events.includes('waiting')) notifier?.fire(fresh);
  }
  // 알림이 꺼진 채로 응답 대기 세션이 처음 보이면 키 줄에 켜기 힌트를 한 번 띄운다 (기록을 다 읽은 뒤).
  // 도움말·검색 중에는 키 줄이 힌트를 그리지 않으므로 닫힐 때까지 미룬다.
  if (!once && loading.ready && notifyHintDue(notifyToggle, data.sessions, { visible: !view.help && !view.searching })) toast('foot.notifyHint', HINT_MS);
  if (eventWatch) {
    const evs = takeEvents(eventWatch, data.sessions, { ready: loading.ready });
    for (const kind of eventKinds) notifier.fire(evs.filter((e) => e.kind === kind).map((e) => e.session), kind);
  }
  lastMore = data.more;
  if (!once) {
    const shown = admit(loading, data);
    if (throttle && !shown) return false;
    view.ready = loading.ready;
  }
  view.data = data;
  if (view.filter) keepSelectionVisible();
  fixFocus(view);
  return true;
}
let lastMore = false;

// 키 줄 왼쪽에 잠깐 보이는 알림 (y 복사 결과, 알림 켜기 힌트). ms 가 지나면 지운다.
const TOAST_MS = 2000;
const HINT_MS = 10_000;
let toastTimer = null;
function toast(key, ms = TOAST_MS) {
  view.toast = { key, until: Date.now() + ms };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    view.toast = null;
    draw();
  }, ms);
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
  // --once·--json 은 모든 원격이 끝날 때(원격마다 최대 20초)까지 기다린 뒤 낸다.
  if (poller) await poller.pollAll();
  refresh();
  flushCache();
  // --line 이 작업 중 수를 낼 수 있게 요약을 남긴다 (summary.mjs).
  // 원격 세션(#308)은 --line 이 다루지 않으므로 요약에 넣지 않는다.
  writeSummary(summarize(view.data.sessions.filter((s) => !s.host)));
  const size = (v) => (Number(v) > 0 ? Math.floor(Number(v)) : 0);
  const W = process.stdout.columns || size(process.env.COLUMNS) || 140;
  const H = process.stdout.rows || size(process.env.LINES) || 40;
  // 터미널이 아니면(파이프·파일) 높이 맞춤 빈 줄과 쓸 수 없는 키 안내를 빼고 내용만 낸다 (#292).
  const screen = () => (process.stdout.isTTY ? render(view, W, H) : pipeLines(render(view, W, H)));
  await printAndExit(args.has('--json') ? JSON.stringify(toJson(view.data, VERSION, { showRequests, budgetDay: opt.budgetDay }), null, 2) : screen().join('\n'));
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
  poller?.stop();
  notifier?.killAll();
  leaveScreen();
  flushCache();
};

function quit() {
  poller?.stop();
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
  poller?.stop();
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

// y: 이어 여는 명령을 OSC 52 로 클립보드에 쓴다. 터미널이 아니면 아무것도 하지 않는다. 알림은 2초 보인다.
function copy(s) {
  if (!out.isTTY) return;
  const cmd = resumeCmd(s);
  if (cmd) out.write(osc52(cmd));
  toast(cmd ? 'foot.copied' : 'foot.copyNone');
}

// a: 데스크톱 알림을 이번 실행에만 켜고 끈다. 설정 파일은 바꾸지 않는다 (#294).
// 알릴 종류는 시작할 때 정한 값(설정 파일·--notify=<종류>, 없으면 waiting)을 그대로 쓴다.
function flipNotify() {
  const key = applyNotifyToggle(notifyToggle, notifier);
  view.notify = notifyToggle.on;
  settings.notify = notifyToggle.on;
  toast(key);
}

stdin.setEncoding('utf8');
const act = {
  copy,
  toggleNotify: flipNotify,
  quit,
  refresh,
  move,
  next: () => goTo(nextAttention(attention, visible(), view.selectedId)),
  keepVisible: keepSelectionVisible,
  // 아티팩트 원본을 뒤에서 찾은 뒤 다시 그린다 (#307).
  redraw: () => draw(),
  // 키 줄에 잠깐 안내를 띄운다 (원격 세션의 아티팩트 원본 막힘, #308).
  notice: (key) => toast(key),
};

stdin.on('data', (key) => {
  onKey(view, key, act);
  draw();
});

let lastFlush = 0;
// --line 용 요약. 시작 때 기록을 다 읽기 전(ready 전)에는 수가 덜 잡혔을 수 있어 쓰지 않는다.
const writeSummaryThrottled = createSummaryWriter();
function tick() {
  const shown = refresh({ throttle: true });
  if (loading.ready && view.data) writeSummaryThrottled(view.data.sessions.filter((s) => !s.host));
  const more = lastMore;
  if (more ? Date.now() - lastFlush > LOADING_FLUSH_MS : Date.now() - lastFlush > 15_000) {
    flushCache();
    lastFlush = Date.now();
  }
  if (shown) draw();
  setTimeout(tick, more ? CATCH_UP_MS : 1000);
}

setTimeout(tick, 30);
// 원격은 화면에 들어간 뒤 뒤에서 부른다. 결과는 다음 갱신(1초 안)에 붙는다.
poller?.start();
