// 설정: 옵션마다 명령줄 옵션(flag) > 환경 변수(env) > 설정 파일(file) > 기본값(default) 순서로 고른다.
// 설정 파일은 $XDG_CONFIG_HOME/aitop/config.json (없으면 ~/.config/aitop/config.json). aitop 은 이 파일을 읽기만 한다.
// 잘못된 JSON, 모르는 키, 잘못된 값은 그 키만 무시하고 problems 에 남긴다 (--doctor 와 --print-config 가 보인다).
// 화면 모듈은 불러올 때 테마·아이콘을 고르므로, 이 모듈은 화면 모듈을 불러오지 않는다 (notify.mjs 는 text·i18n 만 쓴다).
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { appDir } from './paths.mjs';
import { stripControl } from './text.mjs';
import { langValue, localeLang, t } from './i18n.mjs';
import { EVENT_KINDS } from './notify.mjs';
import { DIR_ENV, agyAppEnv, coworkEnv, pathLike, splitPaths } from './sources/dirs.mjs';

const bool = (v) => typeof v === 'boolean';
const oneOf = (...xs) => (v) => xs.includes(v);
// 달러 금액 글자("50", "12.5", "$50")를 0 보다 큰 수로 바꾼다. 아니면 null.
const usd = (v) => {
  const t = String(v).trim().replace(/^\$/, '');
  const n = /^\d+(\.\d+)?$|^\.\d+$/.test(t) ? Number(t) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

// argv 에서 --budget-day <usd>, --budget-day=<usd>, --no-budget-day 를 꺼낸다. 뒤에 준 쪽을 따른다.
// value: 금액, null(이번 실행만 끔), undefined(주지 않음). 나머지 인자는 rest 로 돌려준다.
export function budgetDayOption(argv) {
  let value;
  let error = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-budget-day') {
      value = null;
      continue;
    }
    const m = /^--budget-day(?:=(.*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    // 다음 인자가 옵션이면 값으로 먹지 않는다. -5 처럼 수로 보이면 값으로 받아 잘못된 값으로 알린다.
    const next = argv[i + 1];
    const raw = m[1] ?? (next == null || (next.startsWith('-') && !/^-[\d.]/.test(next)) ? '' : argv[++i]);
    const n = usd(raw);
    if (n == null) error ??= raw === '' ? t('opt.budgetMissing') : t('opt.budgetBad', { value: JSON.stringify(raw) });
    else value = n;
  }
  return { value, rest, error };
}

// 원격(#308): SSH 호스트(별칭, user@host) 또는 wsl:<배포판>. 원격 실행은 remote.mjs 가 하고, 여기는 이름만 확인한다
// (remote.mjs 는 원격을 켤 때만 불러오므로 확인 규칙은 늘 불러오는 이 모듈에 둔다).
// ssh 인자로 들어가므로 - 로 시작하는 값(-oProxyCommand=…), 포트(:22), 공백·셸 메타 문자는 받지 않는다. 포트는 ~/.ssh/config 별칭으로 준다.
export const REMOTE_MAX = 16;
const SSH_HOST = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const WSL_DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// 'dev' → { name: 'dev', kind: 'ssh', target: 'dev' }, 'wsl:Ubuntu' → { name: 'wsl:Ubuntu', kind: 'wsl', target: 'Ubuntu' }. 잘못되면 null.
export function parseRemote(v) {
  if (typeof v !== 'string') return null;
  const w = /^wsl:(.*)$/i.exec(v);
  if (w) return WSL_DISTRO.test(w[1]) ? { name: `wsl:${w[1]}`, kind: 'wsl', target: w[1] } : null;
  return SSH_HOST.test(v) ? { name: v, kind: 'ssh', target: v } : null;
}
// 같은 원격인지 가르는 열쇠. WSL 배포판 이름은 대소문자를 가리지 않으므로(wsl.exe -d) 작은 글자로 맞춘다. ssh 호스트는 그대로.
export const remoteKey = (r) => (r.kind === 'wsl' ? r.name.toLowerCase() : r.name);
const remoteList = (v) => Array.isArray(v) && v.length > 0 && v.length <= REMOTE_MAX && v.every((x) => parseRemote(x) != null);

// argv 에서 --remote <목록>, --remote=<목록>, --no-remote 를 꺼낸다. 목록은 쉼표로 잇는다. 뒤에 준 쪽을 따른다.
// value: 이름 배열, null(--no-remote, 설정 파일 remotes 도 끔), undefined(주지 않음).
export function remoteOption(argv) {
  let value;
  let error = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-remote') {
      value = null;
      continue;
    }
    const m = /^--remote(?:=(.*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    const next = argv[i + 1];
    const raw = m[1] ?? (next == null || next.startsWith('-') ? '' : argv[++i]);
    const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = list.find((x) => parseRemote(x) == null);
    if (!list.length) error ??= t('opt.remoteMissing');
    else if (bad != null) error ??= t('opt.remoteBad', { value: JSON.stringify(stripControl(bad).slice(0, 80)) });
    else if (list.length > REMOTE_MAX) error ??= t('opt.remoteMany', { n: REMOTE_MAX });
    // 같은 이름을 두 번 주면 한 번만 부른다 (WSL 배포판은 대소문자 무시, 처음 적은 표기).
    else {
      const seen = new Map();
      for (const r of list.map(parseRemote)) if (!seen.has(remoteKey(r))) seen.set(remoteKey(r), r.name);
      value = [...seen.values()];
    }
  }
  return { value, rest, error };
}

const BOOL = ['true', 'false'];
// 기록 폴더 목록: 절대 경로(또는 ~ 로 시작) 문자열 배열, 1~16개.
const pathList = (v) => Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every(pathLike);
// expect, envExpect: 둘 중 하나면 [a, b], 아니면 i18n 키. 문구는 쓸 때 지금 언어로 만든다.
const expectText = (x) => (Array.isArray(x) ? t('cfg.either', { a: x[0], b: x[1] }) : t(x));

// env: 환경 변수 이름과 그 값을 옵션 값으로 바꾸는 함수 (undefined 면 설정하지 않은 것으로 본다).
// envProblem: 환경 변수 값이 잘못되면 무시하고 problems 에 남긴다 (--doctor, --print-config 가 보인다).
// notify, onWaiting 은 응답 대기 알림(notify.mjs)이 쓴다. debug 는 디버그 로그(log.mjs)를 켠다. budgetDay 는 하루 예산(달러)으로, 헤더와 --json 의 예상 비용 경고(budget.mjs)가 쓴다.
export const KEYS = {
  theme: { ok: oneOf('light', 'dark'), expect: ['light', 'dark'], def: null, env: ['AITOP_THEME', (v) => (v === 'light' || v === 'dark' ? v : undefined)] },
  icons: { ok: oneOf('plain', 'ascii'), expect: ['plain', 'ascii'], def: 'full', env: ['AITOP_ICONS', (v) => (v === 'plain' || v === 'ascii' ? v : undefined)] },
  bell: { ok: bool, expect: BOOL, def: false },
  showRequests: { ok: bool, expect: BOOL, def: false, env: ['AITOP_SHOW_REQUESTS', (v) => (v === '1' ? true : v === '0' ? false : undefined)] },
  all: { ok: bool, expect: BOOL, def: false },
  // notify 는 true/false 또는 알릴 종류 배열 (예: ["waiting", "done", "context"]).
  notify: { ok: (v) => bool(v) || (Array.isArray(v) && v.length > 0 && v.every((x) => EVENT_KINDS.includes(x))), expect: 'cfg.notify', def: false },
  // done 알림을 띄우려면 작업 중이 이어져야 하는 시간(분).
  doneMinutes: { ok: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0, expect: 'cfg.positive', def: 3 },
  onWaiting: { ok: (v) => typeof v === 'string' && v.trim() !== '', expect: 'cfg.command', def: null },
  debug: { ok: bool, expect: BOOL, def: false, env: ['AITOP_DEBUG', (v) => (v === '1' ? true : v === '0' ? false : undefined)], envProblem: true, envExpect: ['1', '0'] },
  budgetDay: { ok: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0, expect: 'cfg.positive', def: null, env: ['AITOP_BUDGET_DAY', (v) => usd(v) ?? undefined], envProblem: true },
  // colorBlind 는 적록 색약 팔레트(ui/theme.mjs)를 고른다. theme(밝기)과 따로 정한다.
  colorBlind: { ok: bool, expect: BOOL, def: false, env: ['AITOP_COLOR_BLIND', (v) => (v === '1' ? true : v === '0' ? false : undefined)], envProblem: true, envExpect: ['1', '0'] },
  // 실행 중 세션이 없고 7일 동안 쓰지 않은 도구를 도구 줄에서 숨긴다. false 면 늘 셋 다 보인다.
  hideIdleTools: { ok: bool, expect: BOOL, def: true },
  // 폭이 모호한 기호(·, →, ─, ● 등)를 2칸으로 그리는 터미널이면 wide. 표 칸이 밀리지 않게 1칸 기호로 바꾸고 폭을 2칸으로 센다.
  ambiguous: { ok: oneOf('narrow', 'wide'), expect: ['narrow', 'wide'], def: 'narrow', env: ['AITOP_AMBIGUOUS', (v) => (v === 'narrow' || v === 'wide' ? v : undefined)], envProblem: true },
  // --help·--doctor·오류 문구의 언어(i18n.mjs). 기본값은 로캘(LC_ALL > LC_MESSAGES > LANG)이 ko 로 시작하면 ko, 아니면 en.
  lang: { ok: oneOf('ko', 'en'), expect: ['ko', 'en'], def: localeLang, env: ['AITOP_LANG', langValue], envProblem: true },
  // 읽을 Claude 설정 폴더·Codex 홈 폴더 목록 (#212, sources/dirs.mjs). 환경 변수는 path.delimiter(: 또는 ;)로 여러 개를 잇는다.
  // AITOP_CLAUDE_DIRS > 설정 파일 > 물려받은 CLAUDE_CONFIG_DIR (inherit, Claude Code 용 변수라 설정 파일보다 낮다) > ~/.claude.
  claudeDirs: { ok: pathList, expect: 'cfg.paths', def: () => [join(homedir(), DIR_ENV.claude.home)], env: [DIR_ENV.claude.own, (v) => splitPaths(v)], inherit: [DIR_ENV.claude.inherited, (v) => splitPaths(v)] },
  codexHomes: { ok: pathList, expect: 'cfg.paths', def: () => [join(homedir(), DIR_ENV.codex.home)], env: [DIR_ENV.codex.own, (v) => splitPaths(v)], inherit: [DIR_ENV.codex.inherited, (v) => splitPaths(v)] },
  // Antigravity 데스크톱 앱 폴더 (#303, antigravity.mjs findAgyRoots). true 면 저절로 찾고, false 면 읽지 않고, 경로 배열이면 그 폴더만.
  // AITOP_AGY_APP_HOME(경로 또는 off) > 설정 파일 > 기본(true). AITOP_AGY_HOME 을 주고 AITOP_AGY_APP_HOME 을 주지 않으면 이 값과 상관없이 읽지 않는다.
  // masked: 이 환경 변수가 있으면(그리고 자기 환경 변수가 없으면) 값을 false 로 두고 출처를 그 변수로 보인다. 설정 파일 값은 무시됨으로 알린다.
  agyApp: { ok: (v) => bool(v) || pathList(v), expect: 'cfg.agyApp', def: true, env: ['AITOP_AGY_APP_HOME', agyAppEnv], envProblem: true, envExpect: 'cfg.agyAppEnv', masked: 'AITOP_AGY_HOME' },
  // Claude Desktop Cowork(에이전트 모드) 세션을 담은 앱 폴더 (#304, cowork.mjs findCoworkRoots). 모양은 agyApp 과 같다.
  // AITOP_COWORK_HOME(경로 또는 off) > 설정 파일 > 기본(true, 저절로 찾음).
  cowork: { ok: (v) => bool(v) || pathList(v), expect: 'cfg.cowork', def: true, env: ['AITOP_COWORK_HOME', coworkEnv], envProblem: true, envExpect: 'cfg.agyAppEnv' },
  // 모아 볼 원격 (#308): SSH 호스트 또는 wsl:<배포판> 배열, 1~16개. --remote 가 덮고 --no-remote 는 끈다 (null).
  remotes: { ok: remoteList, expect: 'cfg.remotes', def: null },
};

// Windows 는 XDG_CONFIG_HOME 이 없으면 %APPDATA%\aitop\config.json.
export function configPath(env = process.env, home = homedir(), platform = process.platform) {
  return (platform === 'win32' ? win32 : posix).join(appDir('config', { env, home, platform }), 'config.json');
}

// 설정 파일은 작다. 이보다 크면 읽지 않는다.
export const MAX_BYTES = 64 * 1024;

const show = (v) => JSON.stringify(v)?.slice(0, 60) ?? String(v);

// Windows: 설정 파일의 실제 경로(링크를 따라간 뒤)가 사용자 프로필(%USERPROFILE%) 아래인지. 대소문자와 \ / 를 무시한다.
// 프로필 폴더는 기본 ACL 로 다른 일반 사용자가 쓸 수 없지만, 그 밖(예: C:\cfg)은 Authenticated Users 가 고칠 수 있는 일이 흔하다 (#196).
export function underProfile(file, profile, realpath = realpathSync.native) {
  if (!profile) return false;
  const norm = (p) => {
    let r;
    try {
      r = realpath(p);
    } catch {
      r = p;
    }
    return win32.normalize(String(r)).replace(/\\+$/, '').toLowerCase();
  };
  return norm(file).startsWith(norm(profile) + '\\');
}

// 파일을 읽어 올바른 키만 values 에 담는다. uid: 현재 사용자, platform: OS, profile·realpath: Windows 프로필 확인용 (테스트에서 바꿔 끼운다).
export function readConfigFile(path, { uid = process.getuid?.(), platform = process.platform, profile = process.env.USERPROFILE || homedir(), realpath } = {}) {
  const res = { path, exists: false, values: {}, problems: [] };
  let fd;
  let text;
  let st;
  const notFile = () => res.problems.push(t('cfg.notFile'));
  const tooBig = () => res.problems.push(t('cfg.tooBig', { kb: MAX_BYTES / 1024 }));
  try {
    // FIFO 나 장치 파일을 열면 멈출 수 있으므로 열기 전에 확인하고, 열 때도 기다리지 않게 연다.
    st = statSync(path);
    res.exists = true;
    if (!st.isFile()) return (notFile(), res);
    if (st.size > MAX_BYTES) return (tooBig(), res);
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    st = fstatSync(fd);
    if (!st.isFile()) return (notFile(), res);
    if (st.size > MAX_BYTES) return (tooBig(), res);
    // 확인한 뒤에 파일이 커져도 한도 + 1 바이트까지만 읽는다.
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let n = 0;
    for (let got; n < buf.length && (got = readSync(fd, buf, n, buf.length - n, n)) > 0; ) n += got;
    if (n > MAX_BYTES) return (tooBig(), res);
    text = buf.subarray(0, n).toString('utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      res.exists = err.code !== 'ENOTDIR';
      res.problems.push(t('cfg.unreadable', { code: err.code ?? err.message }));
    }
    return res;
  } finally {
    if (fd != null) closeSync(fd);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    // 오류 문구에 파일 내용 일부가 들어가므로 제어문자를 지우고 줄인다.
    res.problems.push(t('cfg.badJson', { why: stripControl(err.message).slice(0, 120) }));
    return res;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    res.problems.push(t('cfg.notObject'));
    return res;
  }
  for (const [key, value] of Object.entries(obj)) {
    const spec = Object.hasOwn(KEYS, key) ? KEYS[key] : null;
    if (!spec) res.problems.push(t('cfg.unknownKey', { key: show(key) }));
    else if (!spec.ok(value)) res.problems.push(t('cfg.badValue', { key, value: show(value), expect: expectText(spec.expect) }));
    else res.values[key] = value;
  }
  // 응답 대기 때 실행할 명령은 다른 사용자가 바꿀 수 없는 파일에서만 받는다.
  // Windows 는 uid 가 없고 mode 가 보통 0o666 이라(권한은 ACL) mode 대신, 파일이 사용자 프로필 아래에 있을 때만 받는다 (#196).
  if ('onWaiting' in res.values && platform === 'win32') {
    if (!underProfile(path, profile, realpath)) {
      delete res.values.onWaiting;
      res.onWaitingIgnored = t('cfg.onWaitingIgnoredWin');
      res.problems.push(res.onWaitingIgnored);
    }
  } else if ('onWaiting' in res.values) {
    const mine = uid == null || st.uid === uid;
    const shared = (st.mode & 0o022) !== 0;
    if (!mine || shared) {
      delete res.values.onWaiting;
      const why = [!mine && t('cfg.notMine'), shared && t('cfg.shared', { mode: (st.mode & 0o777).toString(8).padStart(3, '0') })].filter(Boolean).join(', ');
      res.onWaitingIgnored = t('cfg.onWaitingIgnored', { why });
      res.problems.push(res.onWaitingIgnored);
    }
  }
  return res;
}

// flags: 명령줄에서 정한 값만 담는다 (주지 않은 옵션은 넣지 않는다).
export function resolveConfig({ flags = {}, env = process.env, file } = {}) {
  file ??= readConfigFile(configPath(env));
  const values = {};
  const problems = [...file.problems];
  for (const [key, spec] of Object.entries(KEYS)) {
    const fromEnv = spec.env && env[spec.env[0]] != null ? spec.env[1](env[spec.env[0]]) : undefined;
    if (spec.envProblem && env[spec.env[0]] != null && fromEnv === undefined) problems.push(t('cfg.badEnv', { name: spec.env[0], value: show(env[spec.env[0]]), expect: expectText(spec.envExpect ?? spec.expect) }));
    if (flags[key] !== undefined) values[key] = { value: flags[key], source: 'flag' };
    else if (fromEnv !== undefined) values[key] = spec.inherit ? { value: fromEnv, source: 'env', env: spec.env[0] } : { value: fromEnv, source: 'env' };
    else if (key in file.values) values[key] = { value: file.values[key], source: 'file' };
    // 물려받은 변수(CLAUDE_CONFIG_DIR 등)는 설정 파일 다음. 어느 변수에서 왔는지 env 에 남긴다.
    else if (spec.inherit && spec.inherit[1](env[spec.inherit[0]]) !== undefined) values[key] = { value: spec.inherit[1](env[spec.inherit[0]]), source: 'env', env: spec.inherit[0] };
    // 기본값이 함수면 환경에서 고른다 (lang 은 로캘).
    else values[key] = { value: typeof spec.def === 'function' ? spec.def(env) : spec.def, source: 'default' };
    // 다른 환경 변수가 이 값을 덮는 경우 (agyApp 과 AITOP_AGY_HOME, antigravity.mjs findAgyRoots).
    if (spec.masked && env[spec.masked] != null && (values[key].source === 'file' || values[key].source === 'default')) {
      if (values[key].source === 'file') problems.push(t('cfg.masked', { key, name: spec.masked }));
      values[key] = { value: false, source: 'env', env: spec.masked };
    }
  }
  return { path: file.path, exists: file.exists, values, problems };
}

// --print-config 의 사람용 출력.
export function configText(cfg) {
  const out = [t('cfg.file', { path: stripControl(cfg.path), state: t(cfg.exists ? 'cfg.exists' : 'cfg.missing') }), ''];
  for (const [key, { value, source }] of Object.entries(cfg.values)) {
    // 배열(notify 의 종류, 기록 폴더)은 waiting,done 처럼 쉼표로 잇는다.
    const v = value == null ? (key === 'theme' ? 'auto' : '-') : typeof value === 'string' ? JSON.stringify(value) : Array.isArray(value) ? stripControl(value.join(',')) : String(value);
    out.push(`${key.padEnd(14)}${v.padEnd(12)} ${source}${cfg.values[key].env ? ` (${cfg.values[key].env})` : ''}`);
  }
  if (cfg.problems.length) out.push('', ...cfg.problems.map((p) => `! ${stripControl(p)}`));
  return out.join('\n');
}

// --print-config --json, --doctor --json 용.
export const configJson = (cfg) => ({ path: cfg.path, exists: cfg.exists, values: cfg.values, problems: cfg.problems });
