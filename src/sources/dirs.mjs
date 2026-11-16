// Claude 설정 폴더와 Codex 홈 폴더 목록 (#212). 프로필을 여러 개 쓰면 폴더도 여럿이다.
// 순서: AITOP_CLAUDE_DIRS·AITOP_CODEX_HOMES(aitop 전용, 구분자 path.delimiter) > 설정 파일(claudeDirs, codexHomes)
// > 물려받은 CLAUDE_CONFIG_DIR·CODEX_HOME (Claude Code·Codex 가 쓰는 변수라 설정 파일보다 낮다) > 기본(~/.claude, ~/.codex).
// 설정 파일까지 본 결과는 bin/aitop.mjs 가 setDataDirs 로 넘긴다. 넘기지 않으면(테스트) 환경 변수와 기본값만 본다.
// 비슷한 이름의 폴더를 저절로 읽지는 않는다. --doctor 가 후보로 안내만 한다 (candidateDirs).
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// 'a:b' 를 경로 배열로. 빈 칸은 버린다. 남는 것이 없으면 undefined (정하지 않은 것으로 본다).
// 값 전체가 있는 폴더면 나누지 않는다 (예전처럼 경로 하나를 준 사용자의 경로에 : 가 들어 있어도 그대로).
export function splitPaths(v, delim = delimiter, exists = isDir) {
  if (typeof v !== 'string') return undefined;
  if (v.includes(delim) && v.trim() && exists(expandHome(v.trim()))) return [v.trim()];
  const out = v.split(delim).map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

// 맨 앞 ~ 를 홈 폴더로 바꾼다.
export function expandHome(p, home = homedir()) {
  return p === '~' ? home : /^~[\\/]/.test(p) ? join(home, p.slice(2)) : p;
}

// 설정 파일에 쓸 수 있는 경로: 절대 경로이거나 ~ 로 시작.
export const pathLike = (p) => typeof p === 'string' && p.trim() !== '' && (/^~(?:$|[\\/])/.test(p) || /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(p));

const realOf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// ~ 를 풀고 절대 경로로 바꾼 뒤, 실제 경로(realpath)가 같은 것은 처음 것만 남긴다.
export function uniqueDirs(list, home = homedir()) {
  const seen = new Set();
  const out = [];
  for (const raw of list ?? []) {
    const p = resolve(expandHome(String(raw), home));
    const real = realOf(p);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(p);
  }
  return out;
}

// 환경 변수 이름: aitop 전용(설정 파일보다 높음)과 물려받는 것(설정 파일보다 낮음).
export const DIR_ENV = {
  claude: { own: 'AITOP_CLAUDE_DIRS', inherited: 'CLAUDE_CONFIG_DIR', home: '.claude' },
  codex: { own: 'AITOP_CODEX_HOMES', inherited: 'CODEX_HOME', home: '.codex' },
};
// 설정 파일 없이 고른 목록 (테스트, setDataDirs 를 부르기 전).
const envDirs = (k, env, home) => splitPaths(env[DIR_ENV[k].own]) ?? splitPaths(env[DIR_ENV[k].inherited]) ?? [join(home, DIR_ENV[k].home)];
export const defaultClaudeDirs = (env = process.env, home = homedir()) => envDirs('claude', env, home);
export const defaultCodexHomes = (env = process.env, home = homedir()) => envDirs('codex', env, home);

let chosen = null;

// 설정까지 반영한 목록을 정한다. 소스 모듈이 처음 읽기 전에 불러야 한다.
export function setDataDirs({ claude, codex } = {}) {
  chosen = { claude: uniqueDirs(claude ?? defaultClaudeDirs()), codex: uniqueDirs(codex ?? defaultCodexHomes()) };
}

const pick = () => (chosen ??= { claude: uniqueDirs(defaultClaudeDirs()), codex: uniqueDirs(defaultCodexHomes()) });
export const claudeDirs = () => pick().claude;
export const codexHomes = () => pick().codex;
export const claudeProjectRoots = () => claudeDirs().map((d) => join(d, 'projects'));
export const codexSessionRoots = () => codexHomes().map((h) => join(h, 'sessions'));

// 여러 폴더에 같은 기록이 있으면(복사본, 링크) 한 번만 센다. key 가 같으면 더 최근에 바뀐 쪽, 같으면 앞 폴더 것.
// items: [{ key, mtime, ... }]. 순서는 처음 나온 자리를 지킨다.
export function dedupeBy(items) {
  const at = new Map();
  const out = [];
  for (const it of items) {
    const i = at.get(it.key);
    if (i === undefined) {
      at.set(it.key, out.length);
      out.push(it);
    } else if (it.mtime > out[i].mtime) out[i] = it;
  }
  return out;
}

// --doctor 용: 읽지 않는 폴더 중 기록이 있어 보이는 것. 홈 바로 아래 .claude 와 .claude-*·.claude.*·.claude_* (+ ~/.config/claude) 에
// projects/ 가 있거나, .codex-* 등에 sessions/ 가 있으면 후보다. 내 것(uid)이 아닌 폴더는 보지 않는다. 읽지는 않는다.
// 설정 파일 목록 때문에 쓰지 않게 된 CLAUDE_CONFIG_DIR·CODEX_HOME 의 폴더도 기록이 있으면 후보로 보인다.
export function candidateDirs({ home = homedir(), claude = claudeDirs(), codex = codexHomes(), uid = process.getuid?.(), env = process.env } = {}) {
  let names = [];
  try {
    names = readdirSync(home);
  } catch {}
  const mine = (p) => {
    try {
      const st = statSync(p);
      return st.isDirectory() && (uid == null || st.uid === uid);
    } catch {
      return false;
    }
  };
  const look = (paths, read, sub) => {
    const known = new Set(read.map(realOf));
    const out = [];
    for (const p of paths) {
      const real = realOf(p);
      if (known.has(real) || !mine(p) || !mine(join(p, sub))) continue;
      known.add(real);
      out.push(p);
    }
    return out;
  };
  const inherited = (k) => uniqueDirs(splitPaths(env[DIR_ENV[k].inherited]) ?? [], home);
  const near = (re) => names.filter((n) => re.test(n)).sort().map((n) => join(home, n));
  return {
    claude: look([...inherited('claude'), join(home, '.claude'), ...near(/^\.claude[-_.]./), join(home, '.config', 'claude')], claude, 'projects'),
    codex: look([...inherited('codex'), join(home, '.codex'), ...near(/^\.codex[-_.]./)], codex, 'sessions'),
  };
}
