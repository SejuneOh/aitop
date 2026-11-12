// OS 마다 다른 경로 규칙을 한곳에 모은다. platform 과 env 를 받아서 테스트가 win32 를 흉내 낼 수 있다.
import path from 'node:path';
import { homedir } from 'node:os';

const pathFor = (plat) => (plat === 'win32' ? path.win32 : path.posix);

// 경로의 마지막 이름. win32 는 / 와 \ 를 모두 나누고, 그 밖의 OS 는 예전처럼 / 만 나눈다.
export const lastName = (p, plat = process.platform) =>
  String(p ?? '')
    .split(plat === 'win32' ? /[\\/]+/ : '/')
    .filter(Boolean)
    .at(-1) ?? '';

// 실행 파일 이름. win32 는 마지막 이름에서 .exe·.cmd·.bat·.ps1 을 떼고, 그 밖의 OS 는 예전처럼 마지막 / 뒤 그대로.
export const exeName = (p, plat = process.platform) =>
  plat === 'win32' ? lastName(p, plat).replace(/\.(exe|cmd|bat|ps1)$/i, '') : String(p).split('/').pop();

// home 아래 경로를 ~ 로 줄인다. win32 는 드라이브 문자·대소문자를 무시하고 \ 와 / 를 같게 본다.
export function tildeIn(p, home = homedir(), plat = process.platform) {
  const s = String(p ?? '');
  const win = plat === 'win32';
  const norm = (x) => (win ? x.replace(/\//g, '\\').toLowerCase() : x);
  const h = String(home ?? '').replace(win ? /[\\/]+$/ : /\/+$/, '');
  if (!h || s.length < h.length) return s;
  if (norm(s.slice(0, h.length)) !== norm(h)) return s;
  const rest = s.slice(h.length);
  if (rest === '') return '~';
  const sepOk = win ? /^[\\/]/.test(rest) : rest.startsWith('/');
  return sepOk ? '~' + rest : s;
}

// 절대 경로인 환경 변수 값만 쓴다.
const absEnv = (env, key, plat) => {
  const v = env[key];
  return v && pathFor(plat).isAbsolute(v) ? v : null;
};

// aitop 이 쓰는 폴더(끝이 aitop 또는 aitop\<종류>). XDG_* 가 있으면 어느 OS 든 그것을 쓴다.
// Linux·macOS: ~/.cache/aitop, ~/.local/state/aitop, ~/.config/aitop
// Windows: %LOCALAPPDATA%\aitop\cache, %LOCALAPPDATA%\aitop\state, %APPDATA%\aitop
export function appDir(kind, { env = process.env, home = homedir(), platform = process.platform } = {}) {
  const { join } = pathFor(platform);
  const win = platform === 'win32';
  const local = () => absEnv(env, 'LOCALAPPDATA', platform) ?? join(home, 'AppData', 'Local');
  if (kind === 'cache') {
    // 캐시는 예전부터 XDG_CACHE_HOME 을 절대 경로인지 보지 않고 썼다. 그대로 둔다.
    if (env.XDG_CACHE_HOME != null) return join(env.XDG_CACHE_HOME, 'aitop');
    return win ? join(local(), 'aitop', 'cache') : join(home, '.cache', 'aitop');
  }
  if (kind === 'state') {
    const xdg = absEnv(env, 'XDG_STATE_HOME', platform);
    if (xdg) return join(xdg, 'aitop');
    return win ? join(local(), 'aitop', 'state') : join(home, '.local', 'state', 'aitop');
  }
  if (kind === 'config') {
    const xdg = absEnv(env, 'XDG_CONFIG_HOME', platform);
    if (xdg) return join(xdg, 'aitop');
    return win ? join(absEnv(env, 'APPDATA', platform) ?? join(home, 'AppData', 'Roaming'), 'aitop') : join(home, '.config', 'aitop');
  }
  throw new Error(`unknown dir kind: ${kind}`);
}
