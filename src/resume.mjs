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

// 세션을 이어 여는 한 줄 명령. 작업 폴더를 알면 cd 를 앞에 붙인다. 만들 수 없으면 null.
export function resumeCmd(s) {
  if (!s) return null;
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
