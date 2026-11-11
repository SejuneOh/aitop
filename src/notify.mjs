// 응답 대기 알림: --notify (데스크톱 알림), --on-waiting <명령> (사용자 명령 실행).
// 세션 정보는 명령 문자열에 넣지 않는다. 알림 도구에는 인자로, 사용자 명령에는 AITOP_* 환경변수로만 넘긴다.
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { mask, stripControl } from './text.mjs';
import { t } from './i18n.mjs';

export const HOOK_TIMEOUT_MS = 10_000;
const LABEL_MAX = 120;

// 옵션 해석은 여기 한 곳에서 한다. config 에는 설정 파일 값(notify, onWaiting)을 넘기고, 명령줄 옵션이 그 위를 덮는다.
// argv 에서 --notify, --no-notify, --on-waiting <cmd>, --on-waiting=<cmd>, --no-on-waiting 을 꺼내고 나머지는 rest 로 돌려준다.
// 값을 따로 받는 다른 옵션(valueOpts)의 값은 건드리지 않고 그대로 넘긴다 (그 옵션의 해석과 같게 - 로 시작하지 않는 다음 인자).
export const VALUE_OPTS = ['--theme'];
export function notifyOptions(argv, config = {}, valueOpts = VALUE_OPTS) {
  let notify = config.notify === true;
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
  return { notify, onWaiting, rest, error };
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

// WSL 인지. --doctor 의 알림 안내에 쓴다. readVersion 은 테스트에서 /proc/version 대신 넣는다.
export function isWsl(env = process.env, readVersion = () => readFileSync('/proc/version', 'utf8')) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readVersion());
  } catch {
    return false;
  }
}

// 쓸 수 있는 데스크톱 알림 도구. 없으면 null (조용히 건너뛴다).
// Linux·WSL 은 notify-send 만 쓴다. WSL 에서 없으면 powershell 로 대신하지 않는다.
export function findNotifier({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') {
    const path = which('osascript', env.PATH);
    return path ? { kind: 'osascript', path } : null;
  }
  if (platform === 'linux') {
    const path = which('notify-send', env.PATH);
    return path ? { kind: 'notify-send', path } : null;
  }
  return null;
}

// 알림 도구 실행 인자. 제목·본문은 인자로만 넘긴다 (셸·AppleScript 문자열에 넣지 않는다).
export function notifierCommand(notifier, title, body) {
  if (notifier.kind === 'osascript') {
    return [notifier.path, ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]];
  }
  // notify-send 는 본문을 마크업으로 읽으므로 <, >, & 를 바꿔 넣는다.
  return [notifier.path, ['--app-name=aitop', '--', escapeMarkup(title), escapeMarkup(body)]];
}

const escapeMarkup = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 세션에서 짧은 대기 사유. "응답 대기 · Bash" → "Bash". 비밀값처럼 보이는 것은 가린다.
export function waitingLabel(s) {
  const text = String(s.phase?.kind === 'waiting' ? (s.phase.text ?? '') : '').replace(/^응답 대기(?: · )?/, '');
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

export function notifyText(sessions) {
  if (sessions.length === 1) {
    const s = sessions[0];
    const label = waitingLabel(s);
    return { title: `aitop: 응답 대기 (${s.tool ?? '?'})`, body: stripControl(`${s.project ?? s.id ?? ''}${label ? ' · ' + label : ''}`) };
  }
  return { title: 'aitop: 응답 대기', body: `${sessions.length}개 세션이 응답을 기다립니다` };
}

// 한 번에 하나만 실행하는 자식 프로세스 실행기.
// 실행 중에 새 일이 오면 하나만 대기열에 두고(가장 최근 것으로 덮어씀), 끝나면 그것을 실행한다.
// 출력은 버리고, timeoutMs 가 지나면 프로세스 그룹째(셸과 그 자식) SIGKILL 한다.
// 자식은 'exit' 를 받아 거두므로 좀비가 남지 않는다. UI 루프는 기다리지 않는다.
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

// --notify, --on-waiting 을 묶은 알리미. 새로 응답 대기가 된 세션 목록을 받는다.
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
    fire(fresh) {
      if (!fresh.length) return;
      if (desk) {
        const { title, body } = notifyText(fresh);
        const [file, args] = notifierCommand(notifier, title, body);
        desk.run({ file, args, env });
      }
      if (hook) for (const s of fresh) hook.run({ file: '/bin/sh', args: ['-c', onWaiting], env: { ...env, ...waitingEnv(s) } });
    },
  };
}
