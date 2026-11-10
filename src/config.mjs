// 설정: 옵션마다 명령줄 옵션(flag) > 환경 변수(env) > 설정 파일(file) > 기본값(default) 순서로 고른다.
// 설정 파일은 $XDG_CONFIG_HOME/aitop/config.json (없으면 ~/.config/aitop/config.json). aitop 은 이 파일을 읽기만 한다.
// 잘못된 JSON, 모르는 키, 잘못된 값은 그 키만 무시하고 problems 에 남긴다 (--doctor 와 --print-config 가 보인다).
// 화면 모듈은 불러올 때 테마·아이콘을 고르므로, 이 모듈은 다른 aitop 모듈을 불러오지 않는다.
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { stripControl } from './text.mjs';

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
    if (n == null) error ??= raw === '' ? '--budget-day 값이 없습니다 (하루 예산, 달러)' : `--budget-day 값 ${JSON.stringify(raw)} 이 잘못되었습니다 (0 보다 큰 수)`;
    else value = n;
  }
  return { value, rest, error };
}

// env: 환경 변수 이름과 그 값을 옵션 값으로 바꾸는 함수 (undefined 면 설정하지 않은 것으로 본다).
// envProblem: 환경 변수 값이 잘못되면 무시하고 problems 에 남긴다 (--doctor, --print-config 가 보인다).
// notify, onWaiting 은 응답 대기 알림(notify.mjs)이 쓴다. budgetDay 는 하루 예산(달러)으로, 헤더와 --json 의 예상 비용 경고(budget.mjs)가 쓴다.
export const KEYS = {
  theme: { ok: oneOf('light', 'dark'), expect: 'light 또는 dark', def: null, env: ['AITOP_THEME', (v) => (v === 'light' || v === 'dark' ? v : undefined)] },
  icons: { ok: oneOf('plain', 'ascii'), expect: 'plain 또는 ascii', def: 'full', env: ['AITOP_ICONS', (v) => (v === 'plain' || v === 'ascii' ? v : undefined)] },
  bell: { ok: bool, expect: 'true 또는 false', def: false },
  showRequests: { ok: bool, expect: 'true 또는 false', def: false, env: ['AITOP_SHOW_REQUESTS', (v) => (v === '1' ? true : v === '0' ? false : undefined)] },
  all: { ok: bool, expect: 'true 또는 false', def: false },
  notify: { ok: bool, expect: 'true 또는 false', def: false },
  onWaiting: { ok: (v) => typeof v === 'string' && v.trim() !== '', expect: '실행할 명령 문자열', def: null },
  budgetDay: { ok: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0, expect: '0 보다 큰 수', def: null, env: ['AITOP_BUDGET_DAY', (v) => usd(v) ?? undefined], envProblem: true },
};

export function configPath(env = process.env, home = homedir()) {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.config'), 'aitop', 'config.json');
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
  const notFile = () => res.problems.push('설정 파일이 일반 파일이 아니라 읽지 않습니다');
  const tooBig = () => res.problems.push(`설정 파일이 ${MAX_BYTES / 1024}KB 를 넘어 읽지 않습니다`);
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
      res.problems.push(`설정 파일을 읽을 수 없습니다 (${err.code ?? err.message})`);
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
    res.problems.push(`설정 파일이 올바른 JSON 이 아니라 무시합니다 (${stripControl(err.message).slice(0, 120)})`);
    return res;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    res.problems.push('설정 파일의 맨 위는 JSON 객체({ ... })여야 합니다');
    return res;
  }
  for (const [key, value] of Object.entries(obj)) {
    const spec = Object.hasOwn(KEYS, key) ? KEYS[key] : null;
    if (!spec) res.problems.push(`모르는 키 ${show(key)} 는 무시합니다`);
    else if (!spec.ok(value)) res.problems.push(`${key} 값 ${show(value)} 이 잘못되어 무시합니다 (${spec.expect})`);
    else res.values[key] = value;
  }
  // 응답 대기 때 실행할 명령은 다른 사용자가 바꿀 수 없는 파일에서만 받는다.
  if ('onWaiting' in res.values) {
    const mine = uid == null || st.uid === uid;
    const shared = (st.mode & 0o022) !== 0;
    if (!mine || shared) {
      delete res.values.onWaiting;
      const why = [!mine && '파일 소유자가 현재 사용자가 아님', shared && `그룹·다른 사용자가 쓸 수 있음 (mode ${(st.mode & 0o777).toString(8).padStart(3, '0')})`].filter(Boolean).join(', ');
      res.problems.push(`onWaiting 은 무시합니다: ${why}. chmod 600 으로 고치세요`);
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
    if (spec.envProblem && env[spec.env[0]] != null && fromEnv === undefined) problems.push(`환경 변수 ${spec.env[0]} 값 ${show(env[spec.env[0]])} 이 잘못되어 무시합니다 (${spec.expect})`);
    if (flags[key] !== undefined) values[key] = { value: flags[key], source: 'flag' };
    else if (fromEnv !== undefined) values[key] = { value: fromEnv, source: 'env' };
    else if (key in file.values) values[key] = { value: file.values[key], source: 'file' };
    else values[key] = { value: spec.def, source: 'default' };
  }
  return { path: file.path, exists: file.exists, values, problems };
}

// --print-config 의 사람용 출력.
export function configText(cfg) {
  const out = [`설정 파일: ${stripControl(cfg.path)} (${cfg.exists ? '있음' : '없음'})`, ''];
  for (const [key, { value, source }] of Object.entries(cfg.values)) {
    const v = value == null ? (key === 'theme' ? 'auto' : '-') : typeof value === 'string' ? JSON.stringify(value) : String(value);
    out.push(`${key.padEnd(14)}${v.padEnd(12)} ${source}`);
  }
  if (cfg.problems.length) out.push('', ...cfg.problems.map((p) => `! ${stripControl(p)}`));
  return out.join('\n');
}

// --print-config --json, --doctor --json 용.
export const configJson = (cfg) => ({ path: cfg.path, exists: cfg.exists, values: cfg.values, problems: cfg.problems });
