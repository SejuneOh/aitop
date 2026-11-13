// 설정: 옵션마다 명령줄 옵션(flag) > 환경 변수(env) > 설정 파일(file) > 기본값(default) 순서로 고른다.
// 설정 파일은 $XDG_CONFIG_HOME/aitop/config.json (없으면 ~/.config/aitop/config.json). aitop 은 이 파일을 읽기만 한다.
// 잘못된 JSON, 모르는 키, 잘못된 값은 그 키만 무시하고 problems 에 남긴다 (--doctor 와 --print-config 가 보인다).
// 화면 모듈은 불러올 때 테마·아이콘을 고르므로, 이 모듈은 화면 모듈을 불러오지 않는다 (notify.mjs 는 text·i18n 만 쓴다).
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { appDir } from './paths.mjs';
import { stripControl } from './text.mjs';
import { langValue, localeLang, t } from './i18n.mjs';
import { EVENT_KINDS } from './notify.mjs';

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

const BOOL = ['true', 'false'];
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
};

// Windows 는 XDG_CONFIG_HOME 이 없으면 %APPDATA%\aitop\config.json.
export function configPath(env = process.env, home = homedir(), platform = process.platform) {
  return (platform === 'win32' ? win32 : posix).join(appDir('config', { env, home, platform }), 'config.json');
}

// 설정 파일은 작다. 이보다 크면 읽지 않는다.
export const MAX_BYTES = 64 * 1024;

const show = (v) => JSON.stringify(v)?.slice(0, 60) ?? String(v);

// 파일을 읽어 올바른 키만 values 에 담는다. uid: 현재 사용자 (테스트에서 바꿔 끼운다).
export function readConfigFile(path, { uid = process.getuid?.() } = {}) {
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
  if ('onWaiting' in res.values) {
    const mine = uid == null || st.uid === uid;
    const shared = (st.mode & 0o022) !== 0;
    if (!mine || shared) {
      delete res.values.onWaiting;
      const why = [!mine && t('cfg.notMine'), shared && t('cfg.shared', { mode: (st.mode & 0o777).toString(8).padStart(3, '0') })].filter(Boolean).join(', ');
      res.problems.push(t('cfg.onWaitingIgnored', { why }));
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
    else if (fromEnv !== undefined) values[key] = { value: fromEnv, source: 'env' };
    else if (key in file.values) values[key] = { value: file.values[key], source: 'file' };
    // 기본값이 함수면 환경에서 고른다 (lang 은 로캘).
    else values[key] = { value: typeof spec.def === 'function' ? spec.def(env) : spec.def, source: 'default' };
  }
  return { path: file.path, exists: file.exists, values, problems };
}

// --print-config 의 사람용 출력.
export function configText(cfg) {
  const out = [t('cfg.file', { path: stripControl(cfg.path), state: t(cfg.exists ? 'cfg.exists' : 'cfg.missing') }), ''];
  for (const [key, { value, source }] of Object.entries(cfg.values)) {
    // 배열(notify 의 종류)은 waiting,done 처럼 쉼표로 잇는다.
    const v = value == null ? (key === 'theme' ? 'auto' : '-') : typeof value === 'string' ? JSON.stringify(value) : Array.isArray(value) ? value.join(',') : String(value);
    out.push(`${key.padEnd(14)}${v.padEnd(12)} ${source}`);
  }
  if (cfg.problems.length) out.push('', ...cfg.problems.map((p) => `! ${stripControl(p)}`));
  return out.join('\n');
}

// --print-config --json, --doctor --json 용.
export const configJson = (cfg) => ({ path: cfg.path, exists: cfg.exists, values: cfg.values, problems: cfg.problems });
