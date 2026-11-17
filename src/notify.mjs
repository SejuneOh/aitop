// 알림: --notify[=종류] (데스크톱 알림), --on-waiting <명령> (사용자 명령 실행). 종류는 waiting(기본)·done·context.
// 세션 정보는 명령 문자열에 넣지 않는다. 알림 도구에는 인자로, 사용자 명령에는 AITOP_* 환경변수로만 넘긴다.
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { mask, stripControl } from './text.mjs';
import { getLang, phaseText, t } from './i18n.mjs';

export const HOOK_TIMEOUT_MS = 10_000;
const LABEL_MAX = 120;

// 옵션 해석은 여기 한 곳에서 한다. config 에는 설정 파일 값(notify, onWaiting)을 넘기고, 명령줄 옵션이 그 위를 덮는다.
// argv 에서 --notify, --no-notify, --on-waiting <cmd>, --on-waiting=<cmd>, --no-on-waiting 을 꺼내고 나머지는 rest 로 돌려준다.
// 값을 따로 받는 다른 옵션(valueOpts)의 값은 건드리지 않고 그대로 넘긴다 (그 옵션의 해석과 같게 - 로 시작하지 않는 다음 인자).
export const VALUE_OPTS = ['--theme'];
// 알림 종류. --notify 만 주면 예전처럼 waiting 만 알린다 (#204).
export const EVENT_KINDS = ['waiting', 'done', 'context'];
export const DEFAULT_EVENTS = ['waiting'];

// 'waiting,done' 같은 글이나 배열을 종류 목록으로. 모르는 종류나 빈 목록이면 null.
export function parseEvents(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) return null;
  const out = [...new Set(list.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== ''))];
  return out.length && out.every((x) => EVENT_KINDS.includes(x)) ? out : null;
}

// events: 알릴 종류 (데스크톱 알림과 --on-waiting 명령에 함께 쓴다). eventsSet: 명령줄 --notify=<종류> 로 정했는지.
// config.notify 는 true/false 또는 종류 배열(켜고 종류를 정함)이다.
export function notifyOptions(argv, config = {}, valueOpts = VALUE_OPTS) {
  const cfgEvents = Array.isArray(config.notify) ? parseEvents(config.notify) : null;
  let notify = config.notify === true || cfgEvents != null;
  let events = cfgEvents ?? DEFAULT_EVENTS;
  let eventsSet = false;
  let onWaiting = typeof config.onWaiting === 'string' && config.onWaiting.trim() ? config.onWaiting : null;
  let error = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueOpts.includes(a)) {
      rest.push(a);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) rest.push(argv[++i]);
      continue;
    }
    if (a === '--notify') {
      notify = true;
      continue;
    }
    if (a.startsWith('--notify=')) {
      const v = parseEvents(a.slice('--notify='.length));
      if (!v) error = t('opt.notifyBad', { value: a.slice('--notify='.length), kinds: EVENT_KINDS.join(',') });
      else {
        notify = true;
        events = v;
        eventsSet = true;
      }
      continue;
    }
    if (a === '--no-notify') {
      notify = false;
      continue;
    }
    if (a === '--no-on-waiting') {
      onWaiting = null;
      continue;
    }
    const m = /^--on-waiting(?:=([\s\S]*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    const v = m[1] ?? (i + 1 < argv.length ? argv[++i] : '');
    if (!v.trim()) error = t('opt.onWaitingMissing');
    else if (m[1] == null && v.startsWith('-')) error = t('opt.onWaitingDash', { value: v });
    else onWaiting = v;
  }
  return { notify, events, eventsSet, onWaiting, rest, error };
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function which(name, envPath = process.env.PATH ?? '') {
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (executable(p)) return p;
  }
  return null;
}

// WSL 인지. 알림 수단 고르기와 --doctor 의 알림 안내에 쓴다. readVersion 은 테스트에서 /proc/version 대신 넣는다.
export function isWsl(env = process.env, readVersion = () => readFileSync('/proc/version', 'utf8')) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readVersion());
  } catch {
    return false;
  }
}

// 쓸 수 있는 데스크톱 알림 도구. 없으면 null (조용히 건너뛴다).
// WSL 은 powershell.exe 로 Windows 토스트를 먼저 띄운다 (WSL 에는 D-Bus 세션 버스가 없는 일이 흔하다, #250).
// powershell.exe 가 없으면 notify-send 를 쓴다. 일반 Linux 는 notify-send 만 쓴다.
// wsl 은 테스트에서 바꿔 끼운다.
export function findNotifier({ platform = process.platform, env = process.env, wsl = platform === 'linux' && isWsl(env) } = {}) {
  if (platform === 'darwin') {
    const path = which('osascript', env.PATH);
    return path ? { kind: 'osascript', path } : null;
  }
  if (platform === 'linux') {
    if (wsl) {
      const ps = which('powershell.exe', env.PATH);
      if (ps) return { kind: 'powershell', path: ps };
    }
    const path = which('notify-send', env.PATH);
    return path ? { kind: 'notify-send', path } : null;
  }
  return null;
}

// notify-send 가 기대는 D-Bus 세션 버스를 찾을 수 있는지. 알림을 실제로 보내 보지는 않는다 (--doctor 가 알림을 띄우면 안 된다).
// 문제가 없거나 확인할 수 없으면 null, 주소가 없으면 { reason: 'missing' }, unix:path= 소켓이 모두 없으면 { reason: 'socket', path }.
// 주소가 없을 때 GLib 처럼 $XDG_RUNTIME_DIR/bus 를 먼저 본다. abstract 소켓·tcp 등은 파일로 확인할 수 없으니 문제로 보지 않는다.
export function busProblem(env = process.env, exists = existsSync) {
  const addr = env.DBUS_SESSION_BUS_ADDRESS;
  if (!addr) {
    if (env.XDG_RUNTIME_DIR && exists(join(env.XDG_RUNTIME_DIR, 'bus'))) return null;
    return { reason: 'missing' };
  }
  let firstPath = null;
  for (const entry of addr.split(';')) {
    const m = /^unix:(.*)$/.exec(entry.trim());
    if (!m) return null;
    const keys = Object.fromEntries(m[1].split(',').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
    if (keys.path == null) return null;
    let path;
    try {
      path = decodeURIComponent(keys.path);
    } catch {
      path = keys.path;
    }
    if (exists(path)) return null;
    firstPath ??= path;
  }
  return firstPath ? { reason: 'socket', path: firstPath } : null;
}

// Windows PowerShell 의 AUMID. 시작 메뉴에 등록되어 있어 따로 등록하지 않아도 토스트가 뜬다 (Get-StartApps 로 확인).
export const PS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const TOAST_MAX = 250;

// Windows 토스트를 띄우는 PowerShell 스크립트. Windows 네이티브(#197)에서도 그대로 쓸 수 있게 따로 둔다.
// 제목·본문은 UTF-8 base64 로만 스크립트에 들어가고(글자는 A-Z a-z 0-9 + / = 뿐), 스크립트 안에서 풀어
// XML 글 노드(CreateTextNode)로 넣는다. 그래서 따옴표·$()·XML 특수문자가 명령이나 XML 구조를 바꾸지 못한다.
export function toastScript(title, body, appId = PS_APP_ID) {
  const b64 = (v) => Buffer.from(String(v).slice(0, TOAST_MAX), 'utf8').toString('base64');
  const id = b64(appId);
  return [
    "$ErrorActionPreference = 'Stop'",
    '$d = { param($s) [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($s)) }',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "$n = $x.GetElementsByTagName('text')",
    `$n.Item(0).AppendChild($x.CreateTextNode((& $d '${b64(title)}'))) > $null`,
    `$n.Item(1).AppendChild($x.CreateTextNode((& $d '${b64(body)}'))) > $null`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier((& $d '${id}')).Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('\n');
}

// powershell.exe -EncodedCommand 의 값: 스크립트를 UTF-16LE 로 바꿔 base64.
export const encodePowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');

// 알림 도구 실행 인자. 제목·본문은 인자로만 넘긴다 (셸·AppleScript 문자열에 넣지 않는다).
export function notifierCommand(notifier, title, body) {
  if (notifier.kind === 'osascript') {
    return [notifier.path, ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]];
  }
  if (notifier.kind === 'powershell') {
    return [notifier.path, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(toastScript(title, body))]];
  }
  // notify-send 는 본문을 마크업으로 읽으므로 <, >, & 를 바꿔 넣는다.
  return [notifier.path, ['--app-name=aitop', '--', escapeMarkup(title), escapeMarkup(body)]];
}

const escapeMarkup = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 세션에서 짧은 대기 사유. "응답 대기 · Bash" → "Bash". 비밀값처럼 보이는 것은 가린다.
// AITOP_WAITING_FOR 로도 넘기는 값이라 기본은 화면 언어와 상관없이 예전과 같은 한국어 문구다. 알림 본문은 lang 으로 화면 언어를 준다.
// 요청도 에이전트도 없으면 빈 글.
export function waitingLabel(s, lang = 'ko') {
  const a = s.phase?.args ?? {};
  const text = s.phase?.kind === 'waiting' && (a.what || a.agents) ? phaseText(s.phase, { lang, short: true }) : '';
  const one = stripControl(text).replace(/\s+/g, ' ').trim();
  return mask(one.length > LABEL_MAX ? one.slice(0, LABEL_MAX - 1) + '…' : one);
}

// --on-waiting 명령에 넘기는 환경변수.
export function waitingEnv(s) {
  return {
    AITOP_TOOL: String(s.tool ?? ''),
    AITOP_PROJECT: String(s.project ?? ''),
    AITOP_SESSION_ID: String(s.id ?? ''),
    AITOP_CWD: String(s.cwd ?? ''),
    AITOP_WAITING_FOR: waitingLabel(s),
  };
}

// 알림 본문의 세션 이름: 사용자가 붙인 이름(/rename, thread_name)이 있으면 그것, 없으면 예전처럼 프로젝트.
const whoOf = (s) => s.customName || s.project || s.id || '';

// 알림 제목·본문은 화면 언어를 따른다 (AITOP_WAITING_FOR 와 달리 사람이 읽는 글이라).
// kind 가 done·context 면 그 종류의 문구를 쓴다. context 본문에는 사용률(%)을 붙인다.
export function notifyText(sessions, lang = getLang(), kind = 'waiting') {
  const o = { lang };
  if (kind !== 'waiting') {
    if (sessions.length !== 1) return { title: t(`notify.${kind}.title`, null, o), body: t(`notify.${kind}.many`, { n: sessions.length }, o) };
    const s = sessions[0];
    const pct = s.context?.window > 0 ? ` · ${Math.round(((s.context.used ?? 0) / s.context.window) * 100)}%` : '';
    return { title: t(`notify.${kind}.one`, { tool: s.tool ?? '?' }, o), body: stripControl(`${whoOf(s)}${kind === 'context' ? pct : ''}`) };
  }
  if (sessions.length === 1) {
    const s = sessions[0];
    const label = waitingLabel(s, lang);
    return { title: t('notify.one', { tool: s.tool ?? '?' }, o), body: stripControl(`${whoOf(s)}${label ? ' · ' + label : ''}`) };
  }
  return { title: t('notify.title', null, o), body: t('notify.many', { n: sessions.length }, o) };
}

// 한 번에 하나만 실행하는 자식 프로세스 실행기.
// 실행 중에 새 일이 오면 하나만 대기열에 두고(가장 최근 것으로 덮어씀), 끝나면 그것을 실행한다.
// 출력은 버리고, timeoutMs 가 지나면 프로세스 그룹째(셸과 그 자식) SIGKILL 한다.
// 자식은 'exit' 를 받아 거두므로 좀비가 남지 않는다. UI 루프는 기다리지 않는다.
// WSL 의 powershell.exe 는 Windows 쪽 프로세스지만, Linux 쪽 중계 프로세스를 SIGKILL 하면 Windows 프로세스도 함께 끝난다 (#250 에서 확인).
function killGroup(c, sig) {
  try {
    process.kill(-c.pid, sig);
  } catch {
    try {
      c.kill(sig);
    } catch {}
  }
}

// 실행 중인 모든 자식(이 모듈이 띄운 것). 자식은 따로 프로세스 그룹이라 aitop 이 끝나도 같이 죽지 않으므로,
// 끝날 때(process 'exit') 그룹째 SIGKILL 한다. 'exit' 안에서는 동기 호출만 되므로 process.kill 만 쓴다.
const liveChildren = new Set();
let exitHooked = false;

export function killAllChildren() {
  for (const c of liveChildren) killGroup(c, 'SIGKILL');
  liveChildren.clear();
}

function track(c) {
  liveChildren.add(c);
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', killAllChildren);
  }
}

export function createRunner({ timeoutMs = HOOK_TIMEOUT_MS, spawnFn = spawn } = {}) {
  let child = null;
  let pending = null;
  const stats = { started: 0, dropped: 0, timedOut: 0 };

  function start(job) {
    let c;
    try {
      c = spawnFn(job.file, job.args, { env: job.env, stdio: 'ignore', detached: true });
    } catch {
      return next();
    }
    child = c;
    if (c.pid) track(c);
    stats.started++;
    // 셸이 아직 살아 있을 때만 그룹을 죽이므로 그룹 id 가 다른 프로세스 것으로 바뀌어 있을 일이 없다.
    const timer = setTimeout(() => {
      stats.timedOut++;
      killGroup(c, 'SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      liveChildren.delete(c);
      if (child === c) child = null;
      next();
    };
    c.once('exit', finish);
    c.once('error', finish);
  }

  function next() {
    if (!pending) return;
    const job = pending;
    pending = null;
    start(job);
  }

  return {
    run(job) {
      if (child) {
        if (pending) stats.dropped++;
        pending = job;
        return false;
      }
      start(job);
      return true;
    },
    get busy() {
      return child != null;
    },
    // 대기열을 비우고 실행 중인 자식을 그룹째 SIGKILL 한다 (aitop 이 끝날 때).
    killAll() {
      pending = null;
      if (child) {
        killGroup(child, 'SIGKILL');
        liveChildren.delete(child);
        child = null;
      }
    },
    stats,
  };
}

// --notify, --on-waiting 을 묶은 알리미. 알릴 세션 목록과 종류(waiting·done·context)를 받는다.
// --on-waiting 명령에는 AITOP_EVENT 로 종류를 넘긴다 (예전 명령은 waiting 만 받으므로 그대로 동작한다).
export function createNotifier({ notify = false, onWaiting = null, notifier = notify ? findNotifier() : null, env = process.env, timeoutMs = HOOK_TIMEOUT_MS, spawnFn = spawn } = {}) {
  const hook = onWaiting ? createRunner({ timeoutMs, spawnFn }) : null;
  const desk = notify && notifier ? createRunner({ timeoutMs, spawnFn }) : null;
  return {
    hook,
    desk,
    killAll() {
      hook?.killAll();
      desk?.killAll();
    },
    fire(fresh, kind = 'waiting') {
      if (!fresh.length) return;
      if (desk) {
        const { title, body } = notifyText(fresh, getLang(), kind);
        const [file, args] = notifierCommand(notifier, title, body);
        desk.run({ file, args, env });
      }
      if (hook) for (const s of fresh) hook.run({ file: '/bin/sh', args: ['-c', onWaiting], env: { ...env, ...waitingEnv(s), AITOP_EVENT: kind } });
    },
  };
}
