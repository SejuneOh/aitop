// 고른 세션을 다른 터미널에서 이어 여는 명령과 OSC 52 클립보드 복사 (#214).
// 명령을 보이고 복사만 한다. 세션에는 아무것도 보내지 않는다 (읽기 전용).

import { stripControl } from './text.mjs';
import { homeEnv } from './sources/dirs.mjs';

// 제어 문자(C0, DEL, C1, 폭 0·방향 바꿈 글자)와 탭·줄바꿈을 지운다. 줄바꿈이 섞이면 붙여 넣을 때 명령이 바로 실행될 수 있다.
export const stripControls = (s) => stripControl(s).replace(/[\t\n]/g, '');

// POSIX 셸 따옴표. 안전한 글자만 있으면 그대로, 아니면 '...' 로 감싸고 ' 는 '\'' 로 바꾼다.
export function shellQuote(s) {
  const v = stripControls(s);
  // = 로 시작하는 단어는 zsh 가 명령 경로로 바꾸므로(=cmd) 따옴표로 감싼다.
  if (v && /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/.test(v)) return v;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

// Codex 기록 파일 이름(rollout-2025-...-<uuid>.jsonl)에서 세션 UUID 를 꺼낸다. `codex resume <UUID>` 가 받는 값이다.
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i;
export const codexId = (id) => UUID.exec(String(id ?? ''))?.[1] ?? null;
// Claude 세션 id 는 UUID 다. 그 밖의 값(예: --dangerously-skip-permissions)은 옵션으로 읽힐 수 있어 받지 않는다.
const isUuid = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
// agy 대화 id 도 UUID 다 (conversations/<UUID>.db, 2026-11-16 이 PC 의 파일 이름 모양으로 확인).

// 도구별 이어 열기 인자. 알 수 없으면 null.
// claude: claude --resume <UUID> (작업 폴더를 알 때만)
// codex: codex resume <id> (codex-cli 0.107 의 `codex resume --help` 로 확인)
// antigravity(agy, tool 'gemini' 이고 id 가 대화 id): agy --conversation <id> (agy --help 로 확인)
// Gemini CLI 와 기록 없이 프로세스만 본 세션(pid-·agy- id)은 id 가 없어 null.
function resumeArgs(s) {
  const id = stripControls(s.id);
  if (!id || /^(pid|agy)-/.test(id)) return null;
  // Claude 는 작업 폴더별로 기록을 찾으므로 폴더를 모르면 다른 폴더에서는 찾지 못한다. 그때는 만들지 않는다.
  if (s.tool === 'claude') return isUuid(id) && stripControls(s.cwd) ? ['claude', '--resume', id] : null;
  if (s.tool === 'codex') {
    const u = codexId(id);
    return u ? ['codex', 'resume', u] : null;
  }
  // Antigravity 데스크톱 앱의 대화(source 'app')는 agy CLI 로 이어 열 수 없어 만들지 않는다 (#303).
  if (s.tool === 'gemini') return isUuid(id) && s.source !== 'app' ? ['agy', '--conversation', id] : null;
  return null;
}

// PowerShell 작은따옴표 (Windows 에서 원격 세션 명령을 붙여 넣는 로컬 셸). 안전한 글자만이면 그대로, 아니면 '...' 로 감싸고 ' 는 '' 로.
// - 로 시작하는 값(-- 포함)과 @ 가 든 값도 감싼다 (PowerShell 이 매개변수 끝 표시나 splatting 으로 읽지 않게).
export function psQuote(v) {
  return /^[A-Za-z0-9_./:\\][A-Za-z0-9_./:\\-]*$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
}

// PowerShell 이 작은따옴표 안에서도 따옴표로 읽는 유니코드 따옴표(‘ ’ ‚ ‛ 등), Windows PowerShell 5.1 이 네이티브 명령에 넘길 때 깨뜨리는 ",
// 그리고 붙여 넣을 때 위험한 글자(제어 문자·줄바꿈·NUL·백틱·$, 폭 0·방향 바꿈 글자). 이런 값이 있으면 Windows 에서는 명령을 만들지 않는다.
const PS_UNSAFE = /[\x00-\x1f\x7f-\x9f`$"\u2018-\u201f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

// 원격 세션(#308)의 이어 열기: 원격이 준 resumeCmd 는 믿지 않고, 원래 id·도구·폴더로 여기서 다시 만든다.
// ssh: ssh -t <host> 'cd <폴더> && claude --resume <id>' (원격 셸이 받는 한 줄을 통째로 따옴표로 감싼다).
// WSL: wsl.exe -d <배포판> --cd <폴더> -- claude --resume <id>. 기본이 아닌 기록 폴더 변수는 원격에서 알 수 없어 붙이지 않는다.
// 로컬이 Windows 면 붙여 넣는 셸을 PowerShell 로 보고 로컬 쪽 인자를 PowerShell 따옴표로 감싼다.
// ssh 의 원격 쪽 한 줄은 원격 POSIX 셸이 읽으므로 POSIX 따옴표로 만든 뒤 그 줄 전체를 PowerShell 따옴표로 한 번 더 감싼다.
function remoteResumeCmd(s, platform) {
  const win = platform === 'win32';
  // Windows 에서는 위험한 글자를 지워서 넘기지 않고 아예 만들지 않는다.
  if (win && [s.host, s.cwd, s.remoteId].some((v) => v != null && PS_UNSAFE.test(String(v)))) return null;
  const host = stripControls(s.host);
  const local = { ...s, host: null, id: s.remoteId, home: null };
  const wsl = /^wsl:(.+)$/i.exec(host);
  let words;
  if (wsl) {
    const args = resumeArgs(local);
    if (!args) return null;
    const cwd = stripControls(s.cwd);
    words = ['wsl.exe', '-d', wsl[1], ...(cwd ? ['--cd', cwd] : []), '--', ...args];
  } else {
    const inner = resumeCmd(local);
    if (!inner || !host) return null;
    words = ['ssh', '-t', host, inner];
  }
  if (win && words.some((w) => PS_UNSAFE.test(w))) return null;
  // 맨 앞 실행 파일 이름은 따옴표 없이 둔다 (PowerShell 은 따옴표로 시작하면 명령이 아니라 글로 읽는다).
  return [words[0], ...words.slice(1).map(win ? psQuote : shellQuote)].join(' ');
}

// 세션을 이어 여는 한 줄 명령. 작업 폴더를 알면 cd 를 앞에 붙인다. 만들 수 없으면 null.
// platform 은 원격 세션(#308)의 로컬 셸 따옴표를 고를 때만 쓴다 (테스트에서 바꿔 끼운다). 로컬 세션은 늘 POSIX 따옴표다.
export function resumeCmd(s, { platform = process.platform } = {}) {
  if (!s) return null;
  if (s.host) return remoteResumeCmd(s, platform);
  const args = resumeArgs(s);
  if (!args) return null;
  // 기본 폴더가 아닌 설정 폴더(#212)의 세션은 그 폴더를 변수로 집어 줘야 도구가 기록을 찾는다.
  const kind = s.tool === 'claude' ? 'claude' : s.tool === 'codex' ? 'codex' : null;
  const env = kind ? homeEnv(kind, stripControls(s.home)) : null;
  const run = (env ? `${env[0]}=${shellQuote(env[1])} ` : '') + args.map(shellQuote).join(' ');
  const cwd = stripControls(s.cwd);
  return cwd ? `cd ${shellQuote(cwd)} && ${run}` : run;
}

// OSC 52 클립보드 쓰기: ESC ] 52 ; c ; <base64> BEL. 터미널이 지원하지 않으면 조용히 무시된다.
export const osc52 = (text) => `\x1b]52;c;${Buffer.from(String(text), 'utf8').toString('base64')}\x07`;
