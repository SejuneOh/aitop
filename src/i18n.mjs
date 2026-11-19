// 화면 문구(--help, --doctor, 옵션 오류, --print-config, 실시간 화면의 표·상세·도움말·키 줄, 알림)의 한국어·영어 표와 t(). 의존성 없이 이 파일만으로 돈다.
// 언어는 --lang > AITOP_LANG > 설정 파일 lang > LC_ALL > LC_MESSAGES > LANG 순서로 고른다 (bin 이 setLang 으로 정한다).
// 로캘 문자열이 ko 로 시작하면 ko, 그 밖(C, C.UTF-8, POSIX, 없음 포함)은 en 이다.
// --json 의 phase 와 --on-waiting 의 AITOP_WAITING_FOR 는 호환을 위해 언어와 상관없이 ko 표로 만든다.
// 표의 값은 문자열이거나 { long, short } 다. short 는 좁은 폭에서 쓰고, 없으면 long 을 쓴다.
// 영어 수 문구는 { one, other } (long·short 안에도 가능)로 단수·복수를 나눈다. ko 는 늘 문자열이다.
// {name} 은 t(key, { name }) 의 값으로 바꾼다. vars 에 없는 {name} 은 그대로 둔다 (설정 예시의 { ... } 를 건드리지 않게).

export const LANGS = ['ko', 'en'];

// 모듈을 바로 불러 쓰는 테스트·화면은 한국어다. bin 만 setLang 으로 바꾼다.
let current = 'ko';
export const getLang = () => current;
export function setLang(lang) {
  if (LANGS.includes(lang)) current = lang;
  return current;
}

// 로캘 문자열 하나를 언어로. ko, ko_KR.UTF-8, ko-KR 은 ko, 그 밖은 en.
export const langOf = (locale) => (/^ko(?:$|[_.@-])/i.test(String(locale ?? '')) ? 'ko' : 'en');

// LC_ALL > LC_MESSAGES > LANG 중 비어 있지 않은 첫 값. 셋 다 없으면 en.
export function localeLang(env = process.env) {
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) if (env[k]) return langOf(env[k]);
  return 'en';
}

// AITOP_LANG, 설정 파일 lang, --lang 의 값. ko·en 만 받는다 (대소문자 무시). 아니면 undefined.
export const langValue = (v) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return LANGS.includes(s) ? s : undefined;
};

// 고르는 순서 한 곳. flag: --lang 값, file: 설정 파일의 lang (올바른 값만).
export function pickLang({ flag, env = process.env, file } = {}) {
  return langValue(flag) ?? langValue(env.AITOP_LANG) ?? langValue(file) ?? localeLang(env);
}

// argv 에서 --lang <ko|en>, --lang=<ko|en> 을 꺼낸다. 뒤에 준 쪽을 따른다.
// value: 언어(올바른 값만), rest: 나머지 인자, error: [키, vars] (언어를 정한 뒤 t 로 문장을 만든다).
export function langOption(argv) {
  let value;
  let error = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--lang(?:=(.*))?$/.exec(argv[i]);
    if (!m) {
      rest.push(argv[i]);
      continue;
    }
    const raw = m[1] ?? (argv[i + 1] == null || argv[i + 1].startsWith('-') ? '' : argv[++i]);
    const v = langValue(raw);
    if (v) value = v;
    else error ??= raw === '' ? ['opt.langMissing', {}] : ['opt.langBad', { value: JSON.stringify(raw) }];
  }
  return { value, rest, error };
}

const HELP_KO = `{logo} aitop - 터미널에서 Claude Code · Codex · Antigravity · Gemini 세션을 실시간으로 본다

  aitop            실시간 화면
  aitop --once     현재 상태를 한 번 출력하고 끝낸다
  aitop --all      종료된 세션(24시간 이내)도 함께 본다
  aitop --line     오늘 비용·응답 대기(가장 오래 기다린 세션 이름과 대기 시간)·작업 중 수·시간당 지출을 한 줄로 내고 끝낸다
                   (tmux 상태줄용, 예: $54.13 wait 2 fix-login 3m run 3 $3.1/h. 하나만 기다리면 wait fix-login 3m)
                   --line=tmux 는 tmux 색 서식(#[fg=...])을 넣는다. --line-width <N> 폭 상한(기본 40, 넘으면 뒤 항목부터 빼고 대기 세션 이름은 대기 수보다 먼저 뺀다)
                   캐시만 읽는다. 캐시가 없어 1.5초 안에 못 읽으면 ... 을 낸다. 작업 중 수와 Antigravity 의 대기 수는
                   1분 안에 aitop 화면·--once·--json 이 남긴 요약이 있을 때만 보인다
  aitop --json     세션 목록과 사용량 합계를 JSON 으로 한 번 출력한다 (--all 과 함께 쓸 수 있다)
                   세션마다 resumeCmd 에 그 세션을 이어 여는 명령을 넣는다 (예: cd /repo && claude --resume <id>, 없으면 null)
  aitop --report daily [--by tool|model|project] [--days N] [--json]  최근 N일(기본·최대 30)의 날짜별 토큰·비용(API 정가 환산)을
                   도구별·모델별·프로젝트별 표로 내고 끝낸다. 최근 날짜가 위, 맨 아래는 합계. 처음 실행은 30일치 기록을 읽느라 오래 걸릴 수 있다
                   프로젝트는 작업 폴더의 마지막 이름이고, 열이 터미널 폭을 넘으면 비용이 작은 쪽을 (그 외) 로 합친다
  aitop --report monthly [--by tool|model|project] [--months N] [--json]  최근 N달(기본·최대 12)의 달별 표. 지난 날은 캐시 폴더의
                   monthly.json 에 달별로 남겨 기록이 지워져도 남는다. 처음 실행은 1년치 기록을 한 번 읽는다. * 이번 달, ~ 일부만 센 달
  aitop --report sessions [--since yesterday|today|Nd|YYYY-MM-DD] [--plan USD] [--md|--json] [--show-prompts]
                   기간(기본: 어제 0시부터 지금까지, 최대 30일 전) 안에 사용량이 있는 세션을 비용이 큰 순서로 한 줄씩 보인다
                   (도구, 모델, 프로젝트, 세션 이름, 시작·끝, 토큰, API 정가 환산 비용, 고친 파일 수). 맨 위 요약 카드에 합계와 도구별 비중.
                   --plan 월 구독료를 주면 기간 몫의 몇 배인지 보인다. --md 는 붙여 넣을 Markdown. 첫 지시는 --show-prompts 일 때만
  aitop --report trace <세션> [--md|--json] [--show-prompts]  Claude Code 세션 하나의 호출 트리 (지시 → 도구 호출 → 서브에이전트)에
                   시간·토큰·추정 비용(API 정가 환산)을 붙여 보인다. 세션은 id 앞부분, 기록 파일 경로, 또는 /rename 이름·제목.
                   같은 도구 연속 호출은 Grep ×38 처럼 묶고, 깊은 가지는 접는다. 명령·경로 같은 인자와 지시 글은 --show-prompts 일 때만
  aitop --doctor   Claude · Codex · Antigravity · Gemini 기록과 실행 중인 프로세스, 설정 파일을 점검한다 (--json 과 함께 쓸 수 있다)
  aitop --bell     응답 대기 세션이 새로 생기면 터미널 벨을 울린다
  aitop --notify   응답 대기 세션이 새로 생기면 데스크톱 알림을 띄운다 (Linux notify-send · macOS osascript · WSL·Windows 는 powershell.exe 로 Windows 알림, 없으면 건너뜀)
  aitop --notify=waiting,done,context  알릴 종류를 고른다 (--notify 만 주면 설정 파일 notify 배열, 없으면 waiting). done: 3분(설정 파일 doneMinutes, 응답 대기 시간 빼고) 넘게 작업하던 세션이 다음 지시를
                   기다리면 한 번. context: 컨텍스트가 90% 를 넘으면 한 번 (85% 아래로 내려가면 다시)
  aitop --on-waiting <명령>  알릴 일이 생기면 /bin/sh -c (Windows 는 cmd.exe /c) 로 명령을 실행한다 (내 권한으로 실행, 10초 제한). 종류는 --notify 를 따른다 (--no-notify 여도)
                   세션 정보는 환경변수로만: AITOP_EVENT(waiting|done|context) AITOP_TOOL AITOP_PROJECT AITOP_SESSION_ID AITOP_CWD AITOP_WAITING_FOR
  aitop --show-requests  응답 대기 요청 전체를 상세 패널·--json 에 보인다 (AITOP_SHOW_REQUESTS=1). 비밀값 가림은 최선일 뿐이라 명령 속 비밀값이 보일 수 있다
  aitop --budget-day <달러>  하루 예산. 헤더에 오늘 $12.30/$50 처럼 보이고, 오늘 끝 예상 비용(오늘 + 최근 속도 × 자정까지, 늘 API 환산)이
                   80% 를 넘으면 '예상 $45', 100% 를 넘으면 '예상 $60!' 로 알린다 (AITOP_BUDGET_DAY, 설정 파일 budgetDay)
  aitop --theme light|dark  밝은 배경 / 어두운 배경 색 (없으면 COLORFGBG 로 고른다)
  aitop --color-blind  적록 색약용 색. 응답 대기·돈·경고·diff 를 노랑·파랑 계열로 가른다 (AITOP_COLOR_BLIND=1, 설정 파일 colorBlind). --theme 과 함께 쓴다
  aitop --lang ko|en  화면·--help·--doctor·오류 문구의 언어 (AITOP_LANG, 설정 파일 lang, 없으면 LC_ALL·LC_MESSAGES·LANG 이 ko 로 시작할 때 한국어)
  aitop --no-bell · --no-all · --no-show-requests · --no-notify · --no-on-waiting · --no-budget-day · --no-debug · --no-color-blind  설정 파일에서 켠 값을 이번 실행만 끈다
  aitop --debug    디버그 로그를 남긴다 (AITOP_DEBUG=1, 설정 파일 debug). 기록 형식이 바뀌어 값이 빌 때 원인 확인용
                   {logPath} (1MB 넘으면 .1 로 하나만 남김, 오류 이름·파일 이름만 쓰고 비밀값은 가림)
  aitop --print-config  설정 값마다 값과 출처(flag/env/file/default), 설정 파일 위치를 보인다 (--json 과 함께 쓸 수 있다)
  aitop --version  설치된 버전을 보인다

  AITOP_ICONS=plain  창 제목의 Nerd Font 아이콘과 WezTerm 탭 값을 끈다 (ascii 면 로고도 ASCII)
  AITOP_AMBIGUOUS=wide  ·, →, ─, ● 같은 폭이 모호한 기호를 2칸으로 그리는 터미널(동아시아 폭 설정)용. 표·상자 기호를 1칸 기호로 바꿔 줄이 밀리지 않게 한다 (설정 파일 ambiguous)

  설정 파일: {configPath}
    예) { "theme": "light", "icons": "plain", "bell": true, "notify": true, "onWaiting": "say 대기", "budgetDay": 50, "ambiguous": "wide", "hideIdleTools": false }
    notify 에 ["waiting", "done", "context"] 처럼 종류를 주면 그 종류만 알린다. doneMinutes: done 알림 기준 작업 시간(분, 기본 3)
    hideIdleTools: 실행 중 세션이 없고 7일 동안 쓰지 않은 도구를 헤더 아래 도구 줄에서 숨긴다 (기본 true, false 면 늘 셋 다)
    claudeDirs, codexHomes: 읽을 Claude 설정 폴더·Codex 홈 목록 (예: ["~/.claude", "~/.claude-work"], 기본 ~/.claude, ~/.codex).
      AITOP_CLAUDE_DIRS, AITOP_CODEX_HOMES 에 경로를 : (Windows 는 ;) 로 이어 주면 설정 파일보다 먼저 쓴다.
      설정 파일 목록이 있으면 물려받은 CLAUDE_CONFIG_DIR, CODEX_HOME 은 쓰지 않는다 (없으면 그 경로를 읽는다)
    onWaiting 은 파일 소유자가 나이고 그룹·다른 사용자가 쓸 수 없을 때(chmod 600)만 받는다.
    옵션 > 환경 변수 > 설정 파일 순서로 정한다. 잘못된 값은 무시하고 --doctor 에 알린다.

{keys}
  실시간 화면에서 ? 를 누르면 지금 화면의 키부터 보인다
  y 는 고른 세션을 이어 여는 명령을 OSC 52 로 클립보드에 복사한다. 지원하지 않는 터미널(tmux 는 set-clipboard on 필요)은 조용히 무시하니 상세 패널의 명령을 직접 복사한다`;

const HELP_EN = `{logo} aitop - watch Claude Code, Codex, Antigravity and Gemini sessions live in your terminal

  aitop            live screen
  aitop --once     print the current state once and exit
  aitop --all      also show sessions that ended in the last 24 hours
  aitop --line     print today's cost, waiting sessions (the longest waiting one's name and wait time), running count and spend per hour on one line
                   and exit (for tmux, e.g. $54.13 wait 2 fix-login 3m run 3 $3.1/h; with one waiting: wait fix-login 3m)
                   --line=tmux adds tmux colors (#[fg=...]). --line-width <N> sets the max width (default 40, drops items from the end, the waiting name before its count)
                   Reads only the cache. With no cache it prints ... after 1.5 seconds. The running count and waiting Antigravity sessions
                   show only when the live screen, --once or --json left a summary in the last minute
  aitop --json     print the session list and usage totals as JSON once (works with --all)
                   Each session has resumeCmd, the command that reopens it (e.g. cd /repo && claude --resume <id>, null if none)
  aitop --report daily [--by tool|model|project] [--days N] [--json]  print daily tokens and cost (API list price) for the last N days
                   (default and max 30) by tool, model or project, then exit. Newest day first, total at the bottom. The first run reads 30 days of logs and may take a while
                   A project is the last folder name of the working directory. Columns beyond the terminal width are merged into (others)
  aitop --report monthly [--by tool|model|project] [--months N] [--json]  the same per month for the last N months (default and max 12).
                   Past days are kept per month in monthly.json in the cache folder, so they survive log cleanup. The first run reads up to a year of logs once.
                   * marks this month, ~ a month only partly counted
  aitop --report sessions [--since yesterday|today|Nd|YYYY-MM-DD] [--plan USD] [--md|--json] [--show-prompts]
                   list each session with usage in the period (default: since midnight yesterday, at most 30 days back), highest cost first
                   (tool, model, project, session name, start and end, tokens, API list price cost, files changed), with a summary card on top.
                   --plan with your monthly subscription shows how many times its share for the period you used. --md prints pasteable Markdown.
                   First prompts are shown only with --show-prompts
  aitop --report trace <session> [--md|--json] [--show-prompts]  show the call tree of one Claude Code session (prompt, tool calls, subagents)
                   with time, tokens and estimated cost (API list price). The session is the start of its id, a log file path, or a /rename name or title.
                   Repeated calls of one tool are grouped like Grep ×38 and deep branches are folded. Arguments and prompt text only with --show-prompts
  aitop --doctor   check Claude, Codex, Antigravity and Gemini logs, running processes and the config file (works with --json)
  aitop --bell     ring the terminal bell when a session starts waiting for you
  aitop --notify   show a desktop notification when a session starts waiting (notify-send on Linux, osascript on macOS, a Windows toast via powershell.exe on WSL and Windows; skipped if missing)
  aitop --notify=waiting,done,context  pick what to notify about (plain --notify: the config notify list, else waiting). done: once when a session that worked for
                   over 3 minutes (config doneMinutes, approval waits not counted) waits for its next instruction. context: once when context passes 90% (again after it drops below 85%)
  aitop --on-waiting <cmd>  run a command with /bin/sh -c (cmd.exe /c on Windows) when there is something to notify (runs as you, 10 second limit). Follows the --notify kinds (even with --no-notify)
                   Session info is passed only in env vars: AITOP_EVENT(waiting|done|context) AITOP_TOOL AITOP_PROJECT AITOP_SESSION_ID AITOP_CWD AITOP_WAITING_FOR
  aitop --show-requests  show full waiting requests in the detail panel and --json (AITOP_SHOW_REQUESTS=1). Secret masking is best effort, so secrets in commands may show
  aitop --budget-day <usd>  daily budget. The header shows today $12.30/$50, and it warns when the projected end-of-day cost (today + recent rate until midnight, always API cost)
                   passes 80%, and in the warning color with ! past 100% (AITOP_BUDGET_DAY, config budgetDay)
  aitop --theme light|dark  colors for a light or dark background (picked from COLORFGBG if not set)
  aitop --color-blind  red-green color blind palette. Waiting, money, warnings and diffs use yellow and blue (AITOP_COLOR_BLIND=1, config colorBlind). Works with --theme
  aitop --lang ko|en  language for the screen, --help, --doctor and error messages (AITOP_LANG, config lang, else Korean when LC_ALL, LC_MESSAGES or LANG starts with ko)
  aitop --no-bell · --no-all · --no-show-requests · --no-notify · --no-on-waiting · --no-budget-day · --no-debug · --no-color-blind  turn off a config file setting for this run
  aitop --debug    write a debug log (AITOP_DEBUG=1, config debug). Useful when a log format changes and values go blank
                   {logPath} (keeps one .1 file past 1MB, writes only error and file names, masks secrets)
  aitop --print-config  show each setting with its value, source (flag/env/file/default) and the config file path (works with --json)
  aitop --version  show the installed version

  AITOP_ICONS=plain  turn off the Nerd Font icon in the window title and the WezTerm tab values (ascii also makes the logo ASCII)
  AITOP_AMBIGUOUS=wide  for terminals that draw ambiguous width symbols like ·, →, ─, ● as 2 columns (East Asian width). Uses 1 column symbols so lines stay aligned (config ambiguous)

  Config file: {configPath}
    e.g. { "theme": "light", "icons": "plain", "bell": true, "notify": true, "onWaiting": "say waiting", "budgetDay": 50, "ambiguous": "wide", "hideIdleTools": false, "lang": "en" }
    notify can also be a list like ["waiting", "done", "context"] to pick the kinds. doneMinutes: busy time (minutes, default 3) before a done notice
    hideIdleTools: hide tools with no running session and no use in 7 days from the tool line under the header (default true, false always shows all)
    claudeDirs, codexHomes: Claude config folders and Codex homes to read (e.g. ["~/.claude", "~/.claude-work"], default ~/.claude, ~/.codex).
      AITOP_CLAUDE_DIRS and AITOP_CODEX_HOMES take paths joined with : (; on Windows) and win over the config file.
      With a config list, an inherited CLAUDE_CONFIG_DIR or CODEX_HOME is not used (without one, that path is read)
    onWaiting is accepted only when you own the file and no group or other user can write it (chmod 600).
    Order: option > env var > config file. Bad values are ignored and reported by --doctor.

{keys}
  Press ? on the live screen to see the keys for the current view first
  y copies the selected session's resume command to the clipboard with OSC 52. Terminals without it (tmux needs set-clipboard on) ignore it silently, so copy it from the detail panel`;

export const STRINGS = {
  ko: {
    'help.usage': HELP_KO,
    'help.keys': '키',
    // 키 안내의 화면 이름과 키 짧은 이름. 화면 안 도움말(help.mjs 의 VIEWS)도 이 ko 값을 쓴다.
    'view.table': '세션 표',
    'view.detail': '상세 패널',
    'view.files': '변경 파일 목록',
    'view.diff': 'diff',
    'view.filtered': '검색어가 걸린 표',
    'view.search': '검색 입력 중',
    'view.common': '어디서나',
    'key.search': '검색',
    'key.select': '선택',
    'key.next': '다음 볼 세션',
    'key.sort': '정렬',
    'key.group': '묶기',
    'key.costMode': '비용 기준',
    'key.pin': '고정',
    'key.files': '변경 파일',
    'key.detail': '상세',
    'key.ended': '종료 세션 토글',
    'key.back': '뒤로',
    'key.switchSession': '세션 바꾸기',
    'key.close': '닫기',
    'key.copy': '명령 복사',
    'key.pick': '고르기',
    'key.promptTab': '지시 탭',
    'key.diff': 'diff',
    'key.scroll': '스크롤',
    'key.page': '페이지',
    'key.prevNext': '이전·다음 파일',
    'key.clearSearch': '검색어 지우기',
    'key.newSearch': '새 검색',
    'key.type': '입력',
    'key.letters': '글자',
    'key.erase': '지우기',
    'key.apply': '적용',
    'key.cancel': '취소',
    'key.help': '도움말',
    'key.quit': '나가기',

    'cli.unknown': '모르는 옵션 {opts}',
    'cli.themeMissing': '--theme 값이 없습니다 (light 또는 dark)',
    'cli.unhandled': '처리되지 않은 오류로 끝냅니다 ({why})',
    'cli.logOff': '디버그 로그를 열 수 없어 끕니다 ({path})',
    'cli.notifyLiveOnly': '--notify, --on-waiting 은 실시간 화면에서만 동작한다 (--once·--json·--doctor·파이프 출력에서는 무시)',
    'opt.langMissing': '--lang 값이 없습니다 (ko 또는 en)',
    'opt.langBad': '--lang 값 {value} 이 잘못되었습니다 (ko 또는 en)',
    'opt.budgetMissing': '--budget-day 값이 없습니다 (하루 예산, 달러)',
    'opt.budgetBad': '--budget-day 값 {value} 이 잘못되었습니다 (0 보다 큰 수)',
    'opt.onWaitingMissing': '--on-waiting 값이 없습니다 (실행할 명령)',
    'opt.notifyBad': '--notify={value} 를 알 수 없습니다. 쉼표로 이은 {kinds} 중에서 고른다',
    'opt.onWaitingDash': "--on-waiting 값이 - 로 시작합니다 ({value}). 명령이 맞으면 --on-waiting='{value}' 처럼 = 로 붙여 쓴다",
    'opt.lineBad': '--line 값 {value} 이 잘못되었습니다 (plain 또는 tmux)',
    'opt.lineWidthMissing': '--line-width 값이 없습니다 (글자 수)',
    'opt.lineWidthBad': '--line-width 값 {value} 이 잘못되었습니다 (0 보다 큰 정수)',
    'opt.reportMissing': '--report 값이 없습니다 (daily, monthly, sessions 또는 trace)',
    'opt.reportBad': '--report 값 {value} 이 잘못되었습니다 (daily, monthly, sessions 또는 trace)',
    'opt.sinceMissing': '--since 값이 없습니다 (yesterday, today, 7d 같은 일 수, 또는 YYYY-MM-DD)',
    'opt.sinceBad': '--since 값 {value} 이 잘못되었습니다 (yesterday, today, 7d 같은 일 수, 또는 YYYY-MM-DD)',
    'opt.sinceFuture': '--since 값 {value} 이 오늘보다 뒤입니다',
    'opt.planMissing': '--plan 값이 없습니다 (월 구독료, USD)',
    'opt.planBad': '--plan 값 {value} 이 잘못되었습니다 (0 보다 큰 숫자, USD)',
    'opt.sessionsOnly': '{opt} 는 --report sessions 와 함께 쓴다',
    'opt.notSessions': '{opt} 는 --report sessions 와 함께 쓸 수 없다 (기간은 --since)',
    'opt.mdJson': '--md 와 --json 은 함께 쓸 수 없다',
    'opt.mdOnly': '{opt} 는 --report sessions 또는 --report trace 와 함께 쓴다',
    'opt.notTrace': '{opt} 는 --report trace 와 함께 쓸 수 없다',
    'opt.traceMissing': '--report trace 뒤에 세션을 준다 (세션 id 앞부분, 기록 파일 경로, 또는 세션 이름)',
    'opt.byMissing': '--by 값이 없습니다 (tool, model 또는 project)',
    'opt.byBad': '--by 값 {value} 이 잘못되었습니다 (tool, model 또는 project)',
    'opt.daysMissing': '--days 값이 없습니다 (일 수)',
    'opt.daysBad': '--days 값 {value} 이 잘못되었습니다 (0 보다 큰 정수)',
    'opt.monthsMissing': '--months 값이 없습니다 (달 수)',
    'opt.monthsBad': '--months 값 {value} 이 잘못되었습니다 (0 보다 큰 정수)',
    'opt.daysDaily': '--days 는 --report daily 와 함께 쓴다 (monthly 는 --months)',
    'opt.monthsMonthly': '--months 는 --report monthly 와 함께 쓴다 (daily 는 --days)',
    'opt.reportOnly': '--by, --days, --months 는 --report 와 함께 쓴다',

    // 기간 리포트 (--report daily). 도구·모델 이름은 번역하지 않는다.
    'report.title': '날짜별 사용량 · 최근 {n}일 ({from} ~ {to}) · {by} · API 정가 환산',
    'report.by.tool': '도구별',
    'report.by.model': '모델별',
    'report.by.project': '프로젝트별',
    'report.unknown': '(모름)',
    'report.others': '(그 외)',
    'report.date': '날짜',
    'report.total': '합계',
    'report.empty': '이 기간에 기록된 사용량이 없습니다',
    'report.unpriced': '가격표에 없는 모델이 있어 비용이 실제보다 적게 잡혔을 수 있습니다',
    'report.partial': '시간 상한 안에 기록을 다 읽지 못해 일부만 셌습니다. 다시 실행하면 이어 읽습니다',
    'report.progress': '사용량 장부 읽는 중 {pct}% ({s}초)',
    'report.capped': '--days 는 장부가 남기는 {n}일까지만 볼 수 있어 {n}일로 줄입니다',
    'report.cappedMonths': '--months 는 보관함이 남기는 {n}달까지만 볼 수 있어 {n}달로 줄입니다',
    'report.titleMonthly': '달별 사용량 · 최근 {n}달 ({from} ~ {to}) · {by} · API 정가 환산',
    'report.month': '달',
    'report.missing': '기록 없음',
    'report.noteCurrent': '* 이번 달 (아직 진행 중)',
    'report.notePartial': '~ 일부 날만 셌습니다 (그 전 기록이 지워졌거나 보관함이 비어 있던 때)',
    'report.noteMissing': '기록 없음: 남은 기록도 보관함도 없는 달입니다 (0 이 아니라 모름)',
    // 세션 리포트 (--report sessions).
    'sessions.title': '세션 리포트 · {from} ~ {to} ({days}일)',
    'sessions.cardTotal': '합계 {cost} (API 정가 환산) · 토큰 {tokens} · 세션 {n}개',
    'sessions.cardTools': '도구별 비용 비중: {tools}',
    'sessions.cardToolsTokens': '도구별 토큰 비중: {tools}',
    'sessions.cardPlan': '구독료 {plan}/월의 {days}일 몫 {prorated} 대비 {ratio} (API 정가 환산, 실제 청구액이 아님)',
    'sessions.cardWaited': '에이전트가 기다린 시간 {waited} (추정)',
    'sessions.col.tool': '도구',
    'sessions.col.model': '모델',
    'sessions.col.project': '프로젝트',
    'sessions.col.name': '세션',
    'sessions.col.start': '시작',
    'sessions.col.end': '끝',
    'sessions.col.waited': '기다림',
    'sessions.col.tokens': '토큰',
    'sessions.col.cost': '비용',
    'sessions.col.files': '파일',
    'sessions.col.prompt': '첫 지시',
    'sessions.empty': '이 기간에 사용량이 있는 세션이 없습니다',
    'sessions.noteBasis': '비용은 API 정가 환산이며 실제 청구액이 아닙니다. 시작·끝은 기간 안의 활동 시각, 파일은 고친 파일 수 (- 는 모름). 기다림은 응답을 끝낸 뒤 다음 입력·허락까지의 추정 (간격 하나당 2시간까지, 자리 비움과 구분하지 못함)',
    'sessions.capped': '--since 는 장부가 남기는 {n}일 전까지만 볼 수 있어 {n}일 전으로 줄입니다',
    'trace.title': '호출 트리 · {name} · {id}',
    'trace.summary': '{span} · 지시 {prompts} · 도구 호출 {tools} (서브에이전트 {agents}) · 토큰 {tokens} · {cost}',
    'trace.col.time': '시간',
    'trace.col.tokens': '토큰',
    'trace.col.cost': '비용',
    'trace.prompt': '지시',
    'trace.reply': '응답',
    'trace.running': '진행 중',
    'trace.errors': '(실패 {n})',
    'trace.lost': '(결과 없음)',
    'trace.folded': '(+{n} 접힘)',
    'trace.omittedSteps': '앞 {n}개 생략',
    'trace.omitted': '줄이 많아 오래된 지시 {n}개를 뺐습니다',
    'trace.noteBasis': '비용은 API 정가 환산 추정이며 실제 청구액이 아닙니다. 도구 줄은 그 도구를 부른 응답의 비용을 도구 수로 나눈 몫, 서브에이전트 줄과 지시 줄은 그 가지 전체 합입니다',
    'trace.empty': '이 기록에는 지시나 응답이 없습니다',
    'trace.unsupported': '{tool} 세션은 아직 호출 트리를 만들지 않습니다 (지금은 Claude Code 세션만)',
    'trace.notFound': '세션 {query} 를 찾지 못했습니다 (세션 id 앞부분, 기록 파일 경로, 또는 /rename 이름·제목)',
    'trace.many': '세션 {query} 에 맞는 것이 여럿입니다. id 를 더 길게 준다:',

    'cfg.notFile': '설정 파일이 일반 파일이 아니라 읽지 않습니다',
    'cfg.tooBig': '설정 파일이 {kb}KB 를 넘어 읽지 않습니다',
    'cfg.unreadable': '설정 파일을 읽을 수 없습니다 ({code})',
    'cfg.badJson': '설정 파일이 올바른 JSON 이 아니라 무시합니다 ({why})',
    'cfg.notObject': '설정 파일의 맨 위는 JSON 객체({ ... })여야 합니다',
    'cfg.unknownKey': '모르는 키 {key} 는 무시합니다',
    'cfg.badValue': '{key} 값 {value} 이 잘못되어 무시합니다 ({expect})',
    'cfg.badEnv': '환경 변수 {name} 값 {value} 이 잘못되어 무시합니다 ({expect})',
    'cfg.onWaitingIgnored': 'onWaiting 은 무시합니다: {why}. chmod 600 으로 고치세요',
    'cfg.onWaitingIgnoredWin': 'onWaiting 은 무시합니다: 설정 파일이 사용자 프로필(%USERPROFILE%) 밖에 있어 다른 사용자가 고칠 수 있음. 프로필 아래(%APPDATA%\\aitop)로 옮기세요',
    'cfg.notMine': '파일 소유자가 현재 사용자가 아님',
    'cfg.shared': '그룹·다른 사용자가 쓸 수 있음 (mode {mode})',
    'cfg.either': '{a} 또는 {b}',
    'cfg.command': '실행할 명령 문자열',
    'cfg.notify': 'true, false 또는 waiting·done·context 배열',
    'cfg.positive': '0 보다 큰 수',
    'cfg.paths': '절대 경로(또는 ~/...) 문자열 배열, 1~16개',
    'cfg.file': '설정 파일: {path} ({state})',
    'cfg.exists': '있음',
    'cfg.missing': '없음',

    'doctor.title': '{logo} aitop {version} 연결 점검 ({os})',
    'doctor.os': '{platform}, 프로세스 {state}',
    'doctor.procsOk': '확인 가능',
    'doctor.procsNo': '확인 불가',
    'doctor.procsCim': ' · PowerShell CIM {s}초',
    'doctor.procsTimeout': ', 시간 초과',
    'doctor.procsFailed': ', 실패',
    'doctor.state.ok': '찾음',
    'doctor.state.missing': '없음',
    'doctor.state.limited': '일부 지원',
    'doctor.noFolder': '기록 폴더 없음',
    'doctor.records': '기록 {n}개',
    'doctor.dirMissing': '폴더 없음',
    'doctor.candidate': '읽지 않는 기록 폴더 {path} (기록 {n}개)',
    'doctor.candidateHintClaude': '읽으려면 설정 파일 claudeDirs 배열에 넣거나 AITOP_CLAUDE_DIRS 로 주세요 (예: ["~/.claude", "~/.claude-work"])',
    'doctor.candidateHintCodex': '읽으려면 설정 파일 codexHomes 배열에 넣거나 AITOP_CODEX_HOMES 로 주세요 (예: ["~/.codex", "~/.codex-alt"])',
    'doctor.last': '마지막 {ago} 전',
    'doctor.runningUnknown': '실행 수 확인 불가 (프로세스 목록을 얻지 못함)',
    'doctor.running': '실행 {n}',
    'doctor.unreadable': '최근 기록 읽기 실패',
    'doctor.keys': '키: {keys}',
    'doctor.hint.missing': '{tool} 를 한 번 실행하면 생깁니다',
    'doctor.hint.agyMissing': 'agy 를 한 번 실행하면 생깁니다 (Gemini 탭에 보입니다)',
    'doctor.hint.gemini': '프로세스만 감지합니다 (세션·토큰은 아직 지원하지 않음)',
    'doctor.hint.agyNode': 'Node {node} 에서는 기록을 읽기 전용으로 열 수 없어 프로세스만 감지합니다 (Node 22.15 이상 필요)',
    'doctor.notifier': '✓ 알림    {kind} ({path}) · --notify 로 켬 (끝남·context 경고는 --notify=waiting,done,context)',
    'doctor.noNotifier': '○ 알림    {want} 없음 · --notify 를 켜도 알림을 건너뜀',
    'doctor.noNotifierWsl': '! 알림    powershell.exe·notify-send 없음 · --notify 를 켜도 알림을 건너뜀',
    'doctor.wslHint': 'WSL 은 powershell.exe 로 Windows 알림을 띄운다. Windows PATH 를 넣었는지(/etc/wsl.conf 의 appendWindowsPath) 확인한다',
    'doctor.busBad': '! 알림    {kind} ({path}) · D-Bus 세션 버스가 없어 알림이 뜨지 않음 ({why})',
    'doctor.busMissing': 'DBUS_SESSION_BUS_ADDRESS 없음',
    'doctor.busSocket': '{path} 소켓 없음',
    'doctor.busHint': '데스크톱 세션 안에서 실행하거나 사용자 D-Bus(systemctl --user, dbus-launch)를 켠다. 대신 --on-waiting 으로 다른 알림 명령을 부를 수 있다',
    'doctor.legacyConsole': '! 터미널  구형 콘솔(conhost)로 보임 · ▕█░ 막대와 점자 글자(⠋, 로고)가 네모로 보일 수 있음',
    'doctor.legacyConsoleHint': 'Windows Terminal 을 권장한다. 이 콘솔을 쓴다면 AITOP_AMBIGUOUS=wide(표·막대를 ASCII 로)나 NO_COLOR(진행 막대를 [#.] 로)로 실행한다',
    'doctor.config': '{mark} 설정   {state}{path}',
    'doctor.configExists': '있음',
    'doctor.configMissing': '없음 (기본값)',
    'doctor.debug': '{mark} 디버그 {state}{path}{tail}',
    'doctor.debugOn': '켬',
    'doctor.debugOff': '꺼짐',
    'doctor.debugTail': ' · --debug 로 켬',

    // 상태 문구 (phaseText 가 phase.msg ?? phase.kind 로 고른다). --json 의 phase 는 늘 이 한국어 표로 만든다.
    'phase.ended': '종료',
    'phase.done': '완료',
    'phase.unseen': '완료 · 확인 전',
    'phase.idle': '다음 지시 대기',
    'phase.starting': '시작 중',
    'phase.firstInput': '첫 입력 대기',
    'phase.noPrompt': '아직 지시 없음',
    'phase.geminiLimited': '실행 중 (세부 정보 미지원)',
    'phase.agyOldNode': '실행 중 (세부 정보는 Node 22.15 이상)',
    'phase.waiting': '응답 대기',
    // 오류로 멈춤 (kind stopped, claude.mjs stoppedPhase). 사용 한도는 기록 표본이 없어 아직 가르지 않는다.
    'phase.stopAuth': '로그인 필요',
    'phase.stopNetwork': '연결 끊김',
    'phase.stopApi': 'API 오류로 멈춤',
    // 프롬프트 캐시 만료까지 남은 시간 (STATUS 칸 뒤, 상세 패널). 비용·한도는 단정하지 않는다.
    'cache.left': '캐시 {t}',
    // STATUS 칸이 좁아 경고 덧붙임(캐시 1분 미만 등)을 남길 때 '다음 지시 대기' 대신 쓰는 짧은 문구.
    'status.idleBrief': '지시 대기',
    'cache.expired': '캐시 만료',
    'cache.ttl5m': '5분',
    'cache.ttl1h': '1시간',
    'detail.cacheLeft': '프롬프트 캐시 {t} 남음 ({ttl} TTL, 마지막 요청 시작 기준 추정)',
    'detail.cacheExpired': '프롬프트 캐시 만료 ({ttl} TTL, 마지막 요청 시작 기준 추정)',
    'phase.shell': '쉘 명령 실행 중',
    'phase.tool': '도구 실행 · {what}',
    'phase.toolUnknown': '도구 실행 · 도구',
    'phase.team': '팀원 {n}명 작업 중',
    'phase.think': '생각 중',
    'phase.working': '작업 중',
    'phase.steps': '작업 중 · {n}단계',
    'phase.loading': '…',
    'phase.write': '답변 작성 중',
    'phase.agents': '에이전트 {n}개 실행 중',

    // 실시간 화면 문구 (영어 화면 3/3). ko 값은 예전 화면 글자 그대로라 한국어 화면은 바뀌지 않는다.
    'ui.loading': '세션 기록을 읽는 중…',
    'ui.noMatch': "'{q}' 에 맞는 세션이 없습니다.",
    'ui.more': '… +{n} 세션',
    'ui.moreWaiting': ' (응답 대기 {n})',
    'ui.moveHint': '  ↑↓ 로 이동',

    'hdr.working': { long: '작업 중', short: '작업' },
    'hdr.unseen': { long: '확인 전', short: '확인' },
    // '응답 대기'와 헷갈리지 않게 무엇을 기다리는지 적는다 (#264).
    'hdr.idle': { long: '지시 대기', short: '대기' },
    // 살아 있는 세션 수. 영어 'live' 를 그대로 두지 않는다.
    'hdr.live': '세션 {n}',
    'hdr.waiting': { long: '응답 대기', short: '응답' },
    'hdr.stopped': '멈춤',
    'hdr.proj': '예상',
    'hdr.projApi': 'API 예상',
    'hdr.budget': '예산',
    'hdr.today': '오늘',
    'hdr.week': '7일',
    'hdr.loading': '집계 중',
    'hdr.apiLong': 'API 환산',
    'hdr.apiShort': 'API',
    'hdr.netLong': '캐시 제외',
    'hdr.netShort': '캐시제외',

    'tools.missing': '미설치',
    'tools.hiddenMissing': '미설치: {list}',
    'tools.hiddenIdle': '7일 미사용: {list}',
    'tools.ended': '종료된 세션 포함 (24시간)',
    'table.title': '세션 {n}',
    'member.stalled': '멈춘 듯',
    'member.sdk': '-p',
    'session.auto': '자동',
    'group.count': '{n}개',
    'group.waiting': '응답 대기',
    'group.pinned': '고정',
    'group.noFolder': '(폴더 없음)',
    'sort.default': '기본',
    'sort.cost': '비용',
    'sort.context': '컨텍스트',
    'sort.recent': '최근',
    'groupBy.none': '없음',
    'groupBy.project': '프로젝트',
    'groupBy.tool': '도구',
    'empty.none': '실행 중인 AI 세션이 없습니다.',
    'empty.none24': '지난 24시간 안에 AI 세션이 없습니다.',
    'empty.procs': '{list} 실행 중이지만 읽을 세션 기록이 아직 없습니다.',
    'empty.procsHint': '그 도구에 요청을 보내면 여기에 나옵니다. 점검: aitop --doctor',
    'empty.show': '지난 24시간 세션 보기: ',
    'empty.or': ' 또는 ',

    'foot.help': '도움',
    'foot.closeHelp': '도움 닫기',
    'foot.readOnly': '⊘ 읽기전용',
    'foot.count': '{n}개',
    'foot.clear': '지우기',
    'foot.toFiles': '파일 목록으로',
    'foot.prompts': '지시',
    'foot.pickFile': '파일 선택',
    'foot.viewDiff': 'diff 보기',
    'foot.toSessions': '세션으로',
    'foot.hideEnded': '종료 숨김',
    'foot.showEnded': '종료 포함',
    'foot.next': '다음',
    'foot.files': '파일',
    'foot.hideDetail': '상세 닫기',
    'foot.showDetail': '상세 열기',
    'foot.unpin': '고정 해제',
    'foot.costMode': '비용 기준',
    'foot.copied': '이어 여는 명령을 클립보드로 보냄 (OSC 52)',
    'foot.copyNone': '이 세션은 이어 여는 명령이 없다',
    'foot.clearSearch': '검색 지우기',

    'help.title': '도움말  ·  ? 또는 Esc 로 닫기',
    'help.more': '… {n}줄 더 · ↑↓ 로 스크롤',
    'help.here': '  (지금 화면)',
    'help.others': '다른 화면',
    'help.options': '옵션',
    'help.config': '설정 파일',
    'help.now': '지금',
    'help.legend': '상태 기호',
    'help.columns': '열',
    'legend.busy': '작업 중 (STATUS 칸에 생각·답변, 도구 실행, 팀원 작업. 색으로도 나뉜다)',
    'legend.waiting': '응답 대기 (권한·질문). 행 배경이 강조된다',
    'legend.unseen': '완료 · 확인 전 (작업이 끝났는데 아직 선택해 보지 않음)',
    'legend.idle': '다음 지시 대기',
    'legend.live': '실행 중, 상태 모름 (Gemini 는 프로세스만 보인다)',
    'legend.stopped': '오류로 멈춤 (로그인 필요, 연결 끊김 등). 기록의 API 오류 줄로 판단한다',
    'legend.ended': '종료',
    'legend.pin': '고정한 세션 (p). SESSION 칸 앞에 붙는다',
    'help.extras': '상태 덧붙임',
    'legend.done': '끝난 팀원 (잠깐 보이고 사라진다)',
    'legend.hot': '비용이 가장 큰 세션 두 개 (COST 칸)',
    'legend.cacheKey': '캐시 m:ss',
    'legend.cache': '캐시 남은 시간 (추정). 1분 미만은 굵은 경고색',
    'legend.toolKey': '· 4m12s',
    'legend.tool': '도구가 돈 시간 (1분부터). 10분 넘으면 경고색',
    'legend.elapsedKey': '{g}3m12s',
    'legend.elapsed': '팀원 행 끝: 팀원이 일을 시작한 뒤 지난 시간',
    'legend.stalledKey': '멈춘 듯',
    'legend.stalled': '팀원 기록이 3분(느린 도구 10분) 그대로. 짐작',
    'legend.sdk': '팀원 행: 이 세션이 띄운 claude -p 실행',
    'legend.auto': '부모 없는 claude -p 실행. 대기 알림 없음',
    'legend.status': '지금 단계. 큰 기록을 처음 읽는 동안은 기록 읽는 중 N%',
    'legend.tokens': '세션 누적 토큰 (서브에이전트 포함, 캐시 읽기 포함)',
    'legend.cost': 'API 정가로 환산한 비용 (Codex 는 OpenAI 정가 추정). 가격표에 없는 모델은 빼고 센다',
    'legend.context': '마지막 요청의 컨텍스트 사용률 (모델별 창 크기 기준)',
    'legend.idleCol': '마지막 활동 후 지난 시간. 작업 중이면 now',
    'legend.missingKey': '미설치: N',
    'legend.missing': '도구 줄 끝: 기록 폴더가 없어 숨긴 도구',
    'legend.hiddenKey': '7일 미사용: N',
    'legend.hidden': '도구 줄 끝: 7일 동안 안 쓴 도구를 숨김. 다시 보려면 설정 파일에 "hideIdleTools": false',
    'legend.folded': '도구 줄 끝: 화면이 좁아 접은 도구 수 (넓히면 보인다)',
    'legend.periodKey': '오늘 / 7일',
    'legend.period': '헤더 오른쪽. 날짜별 합계, API 정가 환산이며 구독 요금제의 청구액이 아니다',
    'legend.filesKey': '변경 파일',
    'legend.files': 'Edit/Write(Codex 는 apply_patch) 로 고친 파일과 편집 횟수. git diff 가 아니다',

    // 화면 안 도움말의 키 설명 (help.mjs 의 VIEWS·COMMON). hk.<화면>.<이름>.
    'hk.table.search': '세션 검색 (이름·폴더·모델). Enter 적용, Esc 지우기',
    'hk.table.select': '세션 선택',
    'hk.table.next': '다음 볼 세션으로 (응답 대기 → 멈춤 → 완료 · 확인 전)',
    'hk.table.sort': '정렬: 기본 → 비용순 → 컨텍스트순 → 최근순. 응답 대기는 늘 맨 위',
    'hk.table.group': '묶기: 없음 → 프로젝트 → 도구. 묶음 머리에 세션 수·비용',
    'hk.table.costMode': '비용 기준: API 환산 ↔ 캐시 제외. 표·헤더·상세가 같이 바뀐다 (예산은 늘 API 환산)',
    'hk.table.pin': '고른 세션을 맨 위(응답 대기 아래)에 고정·해제. 여러 개는 고정한 순서, 이번 실행에만',
    'hk.table.files': '고른 세션의 변경 파일 목록으로',
    'hk.table.detail': '상세 패널 열기·닫기',
    'hk.table.ended': '종료된 세션(24시간) 보이기·숨기기',
    'hk.table.back': '한 단계 뒤로 (도움말·검색 닫기, diff → 파일 목록 → 세션). 종료하지 않음',
    'hk.detail.switch': '다른 세션을 고르면 상세도 따라 바뀐다',
    'hk.detail.files': '변경 파일 목록으로',
    'hk.detail.close': '상세 패널 닫기',
    'hk.detail.copy': '이어 여는 명령을 클립보드로 복사 (OSC 52, 지원하지 않는 터미널은 조용히 무시)',
    'hk.files.pick': '파일 고르기',
    'hk.files.tabs': '지시 탭: 이번 지시 · 편집이 있던 이전 지시 T번호 · 전체',
    'hk.files.diff': '고른 파일의 diff 보기',
    'hk.files.back': '세션 표로',
    'hk.diff.scroll': '한 줄씩 스크롤',
    'hk.diff.page': '한 페이지씩',
    'hk.diff.prevNext': '이전·다음 파일',
    'hk.diff.back': '파일 목록으로',
    'hk.filtered.select': '검색 결과 안에서 세션 선택',
    'hk.filtered.clear': '검색어 지우기 (표 전체로)',
    'hk.filtered.new': '지금 검색어를 지우고 새로 입력',
    'hk.search.type': '검색어 입력 (이름·폴더·모델, 대소문자 무시)',
    'hk.search.erase': '한 글자 지우기',
    'hk.search.apply': '검색어를 남기고 표로',
    'hk.search.cancel': '검색 취소 (검색어 지우기)',
    'hk.common.help': '이 도움말 열기·닫기',
    'hk.common.quit': '나가기',

    // 화면 안 도움말의 옵션 묶음 (help.mjs 의 OPTIONS). 값이 있는 옵션은 이름도 언어마다 다르다.
    'hopt.onWaiting': '--on-waiting <명령>',
    'hopt.notifyOpt': '--notify[=종류]',
    'hopt.budgetDay': '--budget-day <달러>',
    'hopt.notify': '응답 대기(·작업 끝남·context 90%)에 데스크톱 알림',
    'hopt.onWaitingText': '알릴 일이 생기면 명령 실행 (AITOP_EVENT)',
    'hopt.budgetDayText': '하루 예산. 헤더에 예상 비용 경고',
    'hopt.showRequests': '응답 대기 요청 전체를 상세·--json 에',
    'hopt.colorBlind': '적록 색약용 색 (대기·돈·경고를 노랑·파랑 계열로)',
    'hopt.debug': '디버그 로그를 남긴다',
    'hopt.line': '오늘 비용·대기·작업 중 수·시간당 지출 한 줄 (tmux 상태줄용)',
    'hopt.printConfig': '설정 값과 출처, 설정 파일 위치',
    'hopt.ambiguous': '·→─● 를 2칸으로 그리는 터미널용 (1칸 기호로)',
    'set.budget': '예산 {v}',
    'set.none': '없음',
    'set.notify': '알림 {v}',
    'set.onWaiting': '대기 명령 있음',
    'set.debug': '디버그 {v}',
    'set.on': '켜짐',
    'set.off': '꺼짐',

    'detail.edits': '편집 ×{n}',
    'detail.newFile': '새 파일',
    'detail.hidden': '비밀값이 있을 수 있는 파일이라 변경 내용을 숨겼습니다',
    'detail.deleted': '이 파일을 삭제했습니다',
    'detail.noHunks': '보관된 변경 내용이 없습니다',
    // 소스(claude·codex)가 메인 세션의 변경에 붙이는 이름. 화면에서만 바꾼다.
    'detail.main': '메인',
    'detail.cut': '… {n}줄 생략',
    'detail.dropped': '… 이전 변경 {n}개는 보관 한도를 넘어 생략',
    'detail.diffStats': ' · 편집 ×{e} · 쓴 줄 {a} · 지운 줄 {d}',
    'detail.noActivity': '아직 기록된 활동이 없습니다',
    'detail.hours': ' {n}시간',
    'detail.tabNow': { long: '이번 지시', short: '이번' },
    'detail.tabAll': '전체',
    'detail.allNote': '세션 전체 · 편집 {n}회',
    'detail.noTurn': '지시 기록 없음',
    'detail.editCount': '  편집 {n}회',
    'detail.request': '요청',
    'detail.activity': '최근 활동',
    'detail.files': '변경 파일',
    'detail.tabNone': ' · {tab} 0개',
    'detail.allFiles': '전체 {n}개 · f',
    'detail.filesMeta': '편집 기록 · Bash 제외 · {n}개',
    'detail.noFiles': '· 이 지시에서는 고친 파일 없음',
    'detail.otherPrompts': '다른 지시',
    'detail.fThen': 'f 다음',
    'detail.moreFiles': '+{n}개 더',
    'detail.startedAgo': '시작 {at} ({ago} 전)',
    'detail.tokenParts': '입력 {i}·출력 {o}·캐시 {c}',
    'detail.sub': ' +서브{n}',
    'detail.netTag': '캐시제외 ',
    'detail.session': '세션',
    'detail.resume': '이어 열기',
    'detail.folder': '폴더',
    'detail.branch': '브랜치',
    'detail.model': '모델',
    'detail.kind': '종류',
    'detail.started': '시작',
    'detail.ago': '{at}  ({ago} 전)',
    'detail.tokens': '토큰',
    'detail.total': '합계',
    'detail.mainSub': '메인 {m} + 서브 {n}개 {s}',
    'detail.inOut': '입력 {i} · 출력 {o}',
    'detail.cache': '캐시 읽기 {r} · 쓰기 {w}',
    'detail.cost': '비용',
    'detail.context': '컨텍스트',
    'detail.apiLabel': 'API 환산',
    'detail.netLabel': '캐시제외',
    'detail.apiValue': 'API 환산 {v}',
    'detail.netValue': '캐시 제외 {v}',
    'detail.unpriced': '  가격표에 없는 모델은 빼고 셈',

    // 데스크톱 알림 (--notify). 화면 언어를 따른다.
    'notify.one': 'aitop: 응답 대기 ({tool})',
    'notify.title': 'aitop: 응답 대기',
    'notify.many': '{n}개 세션이 응답을 기다립니다',
    'notify.done.one': 'aitop: 작업 끝남 ({tool})',
    'notify.done.title': 'aitop: 작업 끝남',
    'notify.done.many': '{n}개 세션이 다음 지시를 기다립니다',
    'notify.context.one': 'aitop: context 90% 넘음 ({tool})',
    'notify.context.title': 'aitop: context 90% 넘음',
    'notify.context.many': '{n}개 세션의 context 가 90% 를 넘었습니다',
    // Antigravity 소스가 요청 이름을 모를 때 넣는 대기 사유. --json 에는 이 한국어 그대로 나가고 화면에서만 바꾼다.
    'phase.approve': '도구 허락',
  },
  en: {
    'help.usage': HELP_EN,
    'help.keys': 'Keys',
    'view.table': 'Session table',
    'view.detail': 'Detail panel',
    'view.files': 'Changed files',
    'view.diff': 'diff',
    'view.filtered': 'Filtered table',
    'view.search': 'Typing a search',
    'view.common': 'Anywhere',
    'key.search': 'search',
    'key.select': 'select',
    'key.next': 'next to check',
    'key.sort': 'sort',
    'key.group': 'group',
    'key.costMode': 'cost basis',
    'key.pin': 'pin',
    'key.files': 'changed files',
    'key.detail': 'detail',
    'key.ended': 'ended sessions',
    'key.back': 'back',
    'key.switchSession': 'switch session',
    'key.close': 'close',
    'key.copy': 'copy cmd',
    'key.pick': 'pick',
    'key.promptTab': 'prompt tabs',
    'key.diff': 'diff',
    'key.scroll': 'scroll',
    'key.page': 'page',
    'key.prevNext': 'prev/next file',
    'key.clearSearch': 'clear search',
    'key.newSearch': 'new search',
    'key.type': 'to search',
    'key.letters': 'text',
    'key.erase': 'erase',
    'key.apply': 'apply',
    'key.cancel': 'cancel',
    'key.help': 'help',
    'key.quit': 'quit',

    'cli.unknown': 'unknown option {opts}',
    'cli.themeMissing': '--theme needs a value (light or dark)',
    'cli.unhandled': 'stopping on an unhandled error ({why})',
    'cli.logOff': 'cannot open the debug log, turning it off ({path})',
    'cli.notifyLiveOnly': '--notify and --on-waiting only work on the live screen (ignored with --once, --json, --doctor and piped output)',
    'opt.langMissing': '--lang needs a value (ko or en)',
    'opt.langBad': 'bad --lang value {value} (ko or en)',
    'opt.budgetMissing': '--budget-day needs a value (daily budget in USD)',
    'opt.budgetBad': 'bad --budget-day value {value} (a number above 0)',
    'opt.onWaitingMissing': '--on-waiting needs a value (a command to run)',
    'opt.notifyBad': 'unknown --notify={value}. Use a comma separated list of {kinds}',
    'opt.onWaitingDash': "--on-waiting value starts with - ({value}). If it is the command, attach it with =, like --on-waiting='{value}'",
    'opt.lineBad': 'bad --line value {value} (plain or tmux)',
    'opt.lineWidthMissing': '--line-width needs a value (characters)',
    'opt.lineWidthBad': 'bad --line-width value {value} (a whole number above 0)',
    'opt.reportMissing': '--report needs a value (daily, monthly, sessions or trace)',
    'opt.reportBad': 'bad --report value {value} (daily, monthly, sessions or trace)',
    'opt.sinceMissing': '--since needs a value (yesterday, today, a number of days like 7d, or YYYY-MM-DD)',
    'opt.sinceBad': 'bad --since value {value} (yesterday, today, a number of days like 7d, or YYYY-MM-DD)',
    'opt.sinceFuture': '--since value {value} is after today',
    'opt.planMissing': '--plan needs a value (monthly subscription in USD)',
    'opt.planBad': 'bad --plan value {value} (a number above 0, USD)',
    'opt.sessionsOnly': '{opt} only works with --report sessions',
    'opt.notSessions': '{opt} does not work with --report sessions (use --since for the period)',
    'opt.mdJson': '--md and --json cannot be used together',
    'opt.mdOnly': '{opt} only works with --report sessions or --report trace',
    'opt.notTrace': '{opt} does not work with --report trace',
    'opt.traceMissing': '--report trace needs a session (the start of a session id, a log file path, or a session name)',
    'opt.byMissing': '--by needs a value (tool, model or project)',
    'opt.byBad': 'bad --by value {value} (tool, model or project)',
    'opt.daysMissing': '--days needs a value (number of days)',
    'opt.daysBad': 'bad --days value {value} (a whole number above 0)',
    'opt.monthsMissing': '--months needs a value (number of months)',
    'opt.monthsBad': 'bad --months value {value} (a whole number above 0)',
    'opt.daysDaily': '--days only works with --report daily (use --months for monthly)',
    'opt.monthsMonthly': '--months only works with --report monthly (use --days for daily)',
    'opt.reportOnly': '--by, --days and --months only work with --report',

    'report.title': 'Daily usage, last {n} days ({from} to {to}), {by}, API list price',
    'report.by.tool': 'by tool',
    'report.by.model': 'by model',
    'report.by.project': 'by project',
    'report.unknown': '(unknown)',
    'report.others': '(others)',
    'report.date': 'Date',
    'report.total': 'Total',
    'report.empty': 'No usage recorded in this period',
    'report.unpriced': 'Includes unpriced models, so the cost may be lower than actual',
    'report.partial': 'Could not read all logs within the time limit, so this is partial. Run again to continue',
    'report.progress': 'Reading usage logs {pct}% ({s}s)',
    'report.capped': '--days is limited to the {n} days the ledger keeps, using {n}',
    'report.cappedMonths': '--months is limited to the {n} months the archive keeps, using {n}',
    'report.titleMonthly': 'Monthly usage, last {n} months ({from} to {to}), {by}, API list price',
    'report.month': 'Month',
    'report.missing': 'no data',
    'report.noteCurrent': '* this month (still in progress)',
    'report.notePartial': '~ only some days were counted (older logs were deleted or the archive was empty then)',
    'report.noteMissing': 'no data: neither logs nor the archive cover this month (unknown, not zero)',
    'sessions.title': 'Sessions, {from} to {to} ({days} days)',
    'sessions.cardTotal': 'Total {cost} (API list price) · {tokens} tokens · {n} sessions',
    'sessions.cardTools': 'Cost share by tool: {tools}',
    'sessions.cardToolsTokens': 'Token share by tool: {tools}',
    'sessions.cardPlan': '{ratio} the {days}-day share {prorated} of a {plan}/month subscription (API list price, not your actual bill)',
    'sessions.cardWaited': 'Agents waited for you {waited} (estimate)',
    'sessions.col.tool': 'Tool',
    'sessions.col.model': 'Model',
    'sessions.col.project': 'Project',
    'sessions.col.name': 'Session',
    'sessions.col.start': 'Start',
    'sessions.col.end': 'End',
    'sessions.col.waited': 'Waited',
    'sessions.col.tokens': 'Tokens',
    'sessions.col.cost': 'Cost',
    'sessions.col.files': 'Files',
    'sessions.col.prompt': 'First prompt',
    'sessions.empty': 'No session used tokens in this period',
    'sessions.noteBasis': 'Cost is the API list price, not your actual bill. Start and end are activity times within the period; Files is the number of files changed (- means unknown). Waited estimates the time from a finished reply to your next prompt or approval (up to 2 hours per gap; time away is counted too)',
    'sessions.capped': '--since is limited to {n} days back, which the ledger keeps, using {n} days',
    'trace.title': 'Call tree · {name} · {id}',
    'trace.summary': '{span} · prompts {prompts} · tool calls {tools} (subagents {agents}) · tokens {tokens} · {cost}',
    'trace.col.time': 'Time',
    'trace.col.tokens': 'Tokens',
    'trace.col.cost': 'Cost',
    'trace.prompt': 'prompt',
    'trace.reply': 'reply',
    'trace.running': 'running',
    'trace.errors': '({n} failed)',
    'trace.lost': '(no result)',
    'trace.folded': '(+{n} folded)',
    'trace.omittedSteps': '{n} earlier steps left out',
    'trace.omitted': 'Too many lines, so the {n} oldest prompts were left out',
    'trace.noteBasis': 'Cost is an API list price estimate, not your actual bill. A tool line gets the cost of the reply that called it, split across the tools it called; subagent and prompt lines total their whole branch',
    'trace.empty': 'This log has no prompts or replies',
    'trace.unsupported': '{tool} sessions have no call tree yet (only Claude Code sessions for now)',
    'trace.notFound': 'no session matches {query} (the start of a session id, a log file path, or a /rename name or title)',
    'trace.many': 'more than one session matches {query}. Give more of the id:',

    'cfg.notFile': 'config file is not a regular file, not reading it',
    'cfg.tooBig': 'config file is over {kb}KB, not reading it',
    'cfg.unreadable': 'cannot read the config file ({code})',
    'cfg.badJson': 'config file is not valid JSON, ignoring it ({why})',
    'cfg.notObject': 'config file must be a JSON object ({ ... }) at the top',
    'cfg.unknownKey': 'ignoring unknown key {key}',
    'cfg.badValue': 'ignoring bad {key} value {value} ({expect})',
    'cfg.badEnv': 'ignoring bad env var {name} value {value} ({expect})',
    'cfg.onWaitingIgnored': 'ignoring onWaiting: {why}. Fix with chmod 600',
    'cfg.onWaitingIgnoredWin': 'ignoring onWaiting: the config file is outside your profile (%USERPROFILE%), so other users may be able to change it. Move it under your profile (%APPDATA%\\aitop)',
    'cfg.notMine': 'file is not owned by the current user',
    'cfg.shared': 'group or other users can write it (mode {mode})',
    'cfg.either': '{a} or {b}',
    'cfg.command': 'a command string',
    'cfg.notify': 'true, false or a list of waiting, done, context',
    'cfg.positive': 'a number above 0',
    'cfg.paths': 'a list of 1 to 16 absolute paths (or ~/...)',
    'cfg.file': 'Config file: {path} ({state})',
    'cfg.exists': 'found',
    'cfg.missing': 'not found',

    'doctor.title': '{logo} aitop {version} setup check ({os})',
    'doctor.os': '{platform}, processes {state}',
    'doctor.procsOk': 'visible',
    'doctor.procsNo': 'not visible',
    'doctor.procsCim': ' · PowerShell CIM {s}s',
    'doctor.procsTimeout': ', timed out',
    'doctor.procsFailed': ', failed',
    'doctor.state.ok': 'found',
    'doctor.state.missing': 'missing',
    'doctor.state.limited': { long: 'partial support', short: 'partial' },
    'doctor.noFolder': 'no log folder',
    'doctor.records': { one: '{n} log', other: '{n} logs' },
    'doctor.dirMissing': 'folder not found',
    'doctor.candidate': { one: 'not read: {path} ({n} log)', other: 'not read: {path} ({n} logs)' },
    'doctor.candidateHintClaude': 'to read it, add it to claudeDirs in the config file or AITOP_CLAUDE_DIRS (e.g. ["~/.claude", "~/.claude-work"])',
    'doctor.candidateHintCodex': 'to read it, add it to codexHomes in the config file or AITOP_CODEX_HOMES (e.g. ["~/.codex", "~/.codex-alt"])',
    'doctor.last': 'last {ago} ago',
    'doctor.runningUnknown': 'cannot count running (no process list)',
    'doctor.running': 'running {n}',
    'doctor.unreadable': 'cannot read the latest log',
    'doctor.keys': 'keys: {keys}',
    'doctor.hint.missing': 'created after you run {tool} once',
    'doctor.hint.agyMissing': 'created after you run agy once (shown in the Gemini tab)',
    'doctor.hint.gemini': 'detects processes only (sessions and tokens not supported yet)',
    'doctor.hint.agyNode': 'Node {node} cannot open the logs read-only, so only processes are detected (needs Node 22.15 or later)',
    'doctor.notifier': '✓ notify  {kind} ({path}) · turn on with --notify (done and context alerts: --notify=waiting,done,context)',
    'doctor.noNotifier': '○ notify  {want} not found · --notify will skip notifications',
    'doctor.noNotifierWsl': '! notify  powershell.exe and notify-send not found · --notify will skip notifications',
    'doctor.wslHint': 'WSL shows Windows notifications through powershell.exe. Check that the Windows PATH is added (appendWindowsPath in /etc/wsl.conf)',
    'doctor.busBad': '! notify  {kind} ({path}) · no D-Bus session bus, notifications will not show ({why})',
    'doctor.busMissing': 'DBUS_SESSION_BUS_ADDRESS not set',
    'doctor.busSocket': 'no socket at {path}',
    'doctor.busHint': 'run inside a desktop session or start a user D-Bus (systemctl --user, dbus-launch). Or call another notifier with --on-waiting',
    'doctor.legacyConsole': '! console legacy console (conhost) · ▕█░ bars and braille (⠋, logo) may show as boxes',
    'doctor.legacyConsoleHint': 'Windows Terminal is recommended. In this console, run with AITOP_AMBIGUOUS=wide (ASCII tables and bars) or NO_COLOR (progress bar as [#.])',
    'doctor.config': '{mark} config {state}{path}',
    'doctor.configExists': 'found',
    'doctor.configMissing': 'not found',
    'doctor.debug': '{mark} debug  {state}{path}{tail}',
    'doctor.debugOn': 'on',
    'doctor.debugOff': 'off',
    'doctor.debugTail': ' · turn on with --debug',

    'phase.ended': 'Ended',
    'phase.done': 'Done',
    'phase.unseen': { long: 'Done, unseen', short: 'Done, unseen' },
    'phase.idle': { long: 'Idle, ready for the next prompt', short: 'Idle' },
    'phase.starting': 'Starting',
    'phase.firstInput': { long: 'Idle, ready for the first prompt', short: 'Idle' },
    'phase.noPrompt': 'No prompt yet',
    'phase.geminiLimited': { long: 'Running (no details yet)', short: 'Running' },
    'phase.agyOldNode': { long: 'Running (details need Node 22.15+)', short: 'Running' },
    'phase.waiting': { long: 'Waiting for you', short: 'Waiting' },
    'phase.stopAuth': 'Login needed',
    'phase.stopNetwork': 'Connection lost',
    'phase.stopApi': { long: 'Stopped by API error', short: 'API error' },
    'cache.left': 'cache {t}',
    'status.idleBrief': 'Idle',
    'cache.expired': 'cache expired',
    'cache.ttl5m': '5m',
    'cache.ttl1h': '1h',
    'detail.cacheLeft': 'Prompt cache {t} left ({ttl} TTL, estimated from the last request start)',
    'detail.cacheExpired': 'Prompt cache expired ({ttl} TTL, estimated from the last request start)',
    'phase.shell': { long: 'Running shell command', short: 'Shell' },
    'phase.tool': { long: 'Running tool · {what}', short: 'Tool · {what}' },
    'phase.toolUnknown': { long: 'Running tool', short: 'Tool' },
    'phase.team': { long: 'Team working · {n}', short: 'Team · {n}' },
    'phase.think': 'Thinking',
    'phase.working': 'Working',
    'phase.steps': { long: 'Working · step {n}', short: 'Step {n}' },
    'phase.loading': '…',
    'phase.write': { long: 'Writing reply', short: 'Writing' },
    'phase.agents': { long: { one: '{n} agent running', other: '{n} agents running' }, short: { one: '{n} agent', other: '{n} agents' } },

    'ui.loading': 'Reading session logs…',
    'ui.noMatch': "No sessions match '{q}'.",
    'ui.more': { one: '… +{n} session', other: '… +{n} sessions' },
    'ui.moreWaiting': ' ({n} waiting)',
    'ui.moveHint': '  ↑↓ to move',

    'hdr.working': { long: 'working', short: 'busy' },
    'hdr.unseen': 'unseen',
    'hdr.idle': 'idle',
    'hdr.live': '{n} live',
    'hdr.waiting': { long: 'waiting', short: 'wait' },
    'hdr.stopped': 'stopped',
    'hdr.proj': 'est',
    'hdr.projApi': 'API est',
    'hdr.budget': 'budget',
    'hdr.today': 'today',
    'hdr.week': '7d',
    'hdr.loading': 'Loading',
    'hdr.apiLong': 'API cost',
    'hdr.apiShort': 'API',
    'hdr.netLong': 'no cache',
    'hdr.netShort': 'no cache',

    'tools.missing': 'not installed',
    'tools.hiddenMissing': 'not installed: {list}',
    'tools.hiddenIdle': 'unused 7d: {list}',
    'tools.ended': 'with ended sessions (24h)',
    'table.title': 'Sessions {n}',
    'member.stalled': 'stalled?',
    'member.sdk': '-p',
    'session.auto': 'auto',
    'group.count': '{n}',
    'group.waiting': 'Waiting',
    'group.pinned': 'Pinned',
    'group.noFolder': '(no folder)',
    'sort.default': 'default',
    'sort.cost': 'cost',
    'sort.context': 'context',
    'sort.recent': 'recent',
    'groupBy.none': 'none',
    'groupBy.project': 'project',
    'groupBy.tool': 'tool',
    'empty.none': 'No AI sessions running.',
    'empty.none24': 'No AI sessions in the last 24 hours.',
    'empty.procs': '{list} running, but no session records to read yet.',
    'empty.procsHint': 'Send it a request to see it here. Check: aitop --doctor',
    'empty.show': 'Show the last 24 hours: ',
    'empty.or': ' or ',

    'foot.help': 'help',
    'foot.closeHelp': 'close help',
    'foot.readOnly': '⊘ read-only',
    'foot.count': '{n} found',
    'foot.clear': 'clear',
    'foot.toFiles': 'to files',
    'foot.prompts': 'prompts',
    'foot.pickFile': 'pick file',
    'foot.viewDiff': 'view diff',
    'foot.toSessions': 'to sessions',
    'foot.hideEnded': 'hide ended',
    'foot.showEnded': 'show ended',
    'foot.next': 'next',
    'foot.files': 'files',
    'foot.hideDetail': 'hide detail',
    'foot.showDetail': 'show detail',
    'foot.unpin': 'unpin',
    'foot.costMode': 'cost',
    'foot.copied': 'resume command sent to clipboard (OSC 52)',
    'foot.copyNone': 'no resume command for this session',
    'foot.clearSearch': 'clear search',

    'help.title': 'Help  ·  ? or Esc to close',
    'help.more': { one: '… {n} more line · ↑↓ to scroll', other: '… {n} more lines · ↑↓ to scroll' },
    'help.here': '  (this view)',
    'help.others': 'Other views',
    'help.options': 'Options',
    'help.config': 'Config file',
    'help.now': 'Now',
    'help.legend': 'Status marks',
    'help.columns': 'Columns',
    'legend.busy': 'Working (thinking, writing, tools, team)',
    'legend.waiting': 'Waiting for you (permission or question)',
    'legend.unseen': 'Done, unseen (not selected yet)',
    'legend.idle': 'Idle, ready for the next prompt',
    'legend.live': 'Running, state unknown (Gemini: process only)',
    'legend.stopped': 'Stopped by an error (login needed, connection lost)',
    'legend.ended': 'Ended',
    'legend.pin': 'Pinned session (p), before SESSION',
    'help.extras': 'Status extras',
    'legend.done': 'Subagent finished (shown briefly)',
    'legend.hot': 'Two costliest sessions (COST)',
    'legend.cacheKey': 'cache m:ss',
    'legend.cache': 'Cache time left (estimate). Bold under 1 min',
    'legend.toolKey': '· 4m12s',
    'legend.tool': 'Tool run time (from 1 min). Warning at 10 min',
    'legend.elapsedKey': '{g}3m12s',
    'legend.elapsed': 'Subagent row end: time since it started',
    'legend.stalledKey': 'stalled?',
    'legend.stalled': 'No log change 3 min (slow tools 10). A guess',
    'legend.sdk': 'Member row: claude -p run of this session',
    'legend.auto': 'claude -p run with no parent. No wait alerts',
    'legend.status': 'Current step (Reading log N% on first load)',
    'legend.tokens': 'Tokens incl. subagents and cache reads',
    'legend.cost': 'API cost (Codex estimated). Unpriced models not counted',
    'legend.context': 'Context used by the last request',
    'legend.idleCol': 'Time since last activity. now while working',
    'legend.missingKey': 'not installed: N',
    'legend.missing': 'Tools hidden because their log folder is missing',
    'legend.hiddenKey': 'unused 7d: N',
    'legend.hidden': 'Tools unused for 7 days (hideIdleTools)',
    'legend.folded': 'Tools folded on a narrow screen',
    'legend.periodKey': 'today / 7d',
    'legend.period': 'Daily API cost totals, not your bill',
    'legend.filesKey': 'Changed files',
    'legend.files': 'Edit/Write/apply_patch edits. Not git diff',

    'hk.table.search': 'Search by name, folder or model',
    'hk.table.select': 'Select a session',
    'hk.table.next': 'Next session to check (waiting, stopped, then unseen)',
    'hk.table.sort': 'Sort: cost, context, recent. Waiting on top',
    'hk.table.group': 'Group by project or tool, with cost',
    'hk.table.costMode': 'Cost basis: API cost or no cache',
    'hk.table.pin': 'Pin on top, below waiting (this run only)',
    'hk.table.files': 'Changed files of the session',
    'hk.table.detail': 'Show or hide the detail panel',
    'hk.table.ended': 'Show or hide ended sessions (24h)',
    'hk.table.back': 'Go back one step. Never quits',
    'hk.detail.switch': 'Pick another session, the detail follows',
    'hk.detail.files': 'Open the changed files',
    'hk.detail.close': 'Close the detail panel',
    'hk.detail.copy': 'Copy the resume command to the clipboard (OSC 52, terminals without it ignore it silently)',
    'hk.files.pick': 'Pick a file',
    'hk.files.tabs': 'Prompt tabs: latest, earlier (T number), all',
    'hk.files.diff': 'View the diff of the file',
    'hk.files.back': 'Back to the session table',
    'hk.diff.scroll': 'Scroll one line',
    'hk.diff.page': 'Scroll one page',
    'hk.diff.prevNext': 'Previous or next file',
    'hk.diff.back': 'Back to the file list',
    'hk.filtered.select': 'Select a session in the results',
    'hk.filtered.clear': 'Clear the search (full table)',
    'hk.filtered.new': 'Clear the search and type a new one',
    'hk.search.type': 'Type a search (name, folder, model)',
    'hk.search.erase': 'Erase one character',
    'hk.search.apply': 'Keep the search and go to the table',
    'hk.search.cancel': 'Cancel (clear the search)',
    'hk.common.help': 'Open or close this help',
    'hk.common.quit': 'Quit',

    'hopt.onWaiting': '--on-waiting <cmd>',
    'hopt.notifyOpt': '--notify[=kinds]',
    'hopt.budgetDay': '--budget-day <usd>',
    'hopt.notify': 'Desktop alert on waiting (or done, context 90%)',
    'hopt.onWaitingText': 'Run a command on alerts (AITOP_EVENT)',
    'hopt.budgetDayText': 'Daily budget, warns in the header',
    'hopt.showRequests': 'Show full waiting requests',
    'hopt.colorBlind': 'Red-green color blind palette',
    'hopt.debug': 'Write a debug log',
    'hopt.line': 'One line for the tmux status bar',
    'hopt.printConfig': 'Settings, sources, config path',
    'hopt.ambiguous': 'For 2 column ·→─● terminals',
    'set.budget': 'budget {v}',
    'set.none': 'none',
    'set.notify': 'notify {v}',
    'set.onWaiting': 'on-waiting set',
    'set.debug': 'debug {v}',
    'set.on': 'on',
    'set.off': 'off',

    'detail.edits': 'edits ×{n}',
    'detail.newFile': 'new file',
    'detail.hidden': 'Changes hidden because this file may hold secrets',
    'detail.deleted': 'This file was deleted',
    'detail.noHunks': 'No saved changes',
    'detail.main': 'main',
    'detail.cut': { one: '… {n} line cut', other: '… {n} lines cut' },
    'detail.dropped': { one: '… {n} older change cut (over the limit)', other: '… {n} older changes cut (over the limit)' },
    'detail.diffStats': ' · edits ×{e} · added {a} · removed {d}',
    'detail.noActivity': 'No activity yet',
    'detail.hours': ' {n}h',
    'detail.tabNow': { long: 'Latest prompt', short: 'Latest' },
    'detail.tabAll': 'All',
    'detail.allNote': { one: 'Whole session · {n} edit', other: 'Whole session · {n} edits' },
    'detail.noTurn': 'No prompt found',
    'detail.editCount': { one: '  {n} edit', other: '  {n} edits' },
    'detail.request': 'Request',
    'detail.activity': 'Recent activity',
    'detail.files': 'Changed files',
    'detail.tabNone': ' · {tab}: none',
    'detail.allFiles': 'all {n} · f',
    'detail.filesMeta': 'edit log · no Bash · {n}',
    'detail.noFiles': '· No files changed in this prompt',
    'detail.otherPrompts': 'other prompts',
    'detail.fThen': 'f then',
    'detail.moreFiles': '+{n} more',
    'detail.startedAgo': 'started {at} ({ago} ago)',
    'detail.tokenParts': 'in {i}·out {o}·cache {c}',
    'detail.sub': ' +sub{n}',
    'detail.netTag': 'no cache ',
    'detail.session': 'Session',
    'detail.resume': 'Resume',
    'detail.folder': 'Folder',
    'detail.branch': 'Branch',
    'detail.model': 'Model',
    'detail.kind': 'Kind',
    'detail.started': 'Started',
    'detail.ago': '{at}  ({ago} ago)',
    'detail.tokens': 'Tokens',
    'detail.total': 'Total',
    'detail.mainSub': { one: 'main {m} + {n} subagent {s}', other: 'main {m} + {n} subagents {s}' },
    'detail.inOut': 'in {i} · out {o}',
    'detail.cache': 'cache read {r} · write {w}',
    'detail.cost': 'Cost',
    'detail.context': 'Context',
    'detail.apiLabel': 'API cost',
    'detail.netLabel': 'No cache',
    'detail.apiValue': 'API cost {v}',
    'detail.netValue': 'no cache {v}',
    'detail.unpriced': '  unpriced models not counted',

    'notify.one': 'aitop: waiting ({tool})',
    'notify.title': 'aitop: waiting',
    'notify.many': { one: '{n} session is waiting for you', other: '{n} sessions are waiting for you' },
    'notify.done.one': 'aitop: done ({tool})',
    'notify.done.title': 'aitop: done',
    'notify.done.many': { one: '{n} session finished its work', other: '{n} sessions finished their work' },
    'notify.context.one': 'aitop: context over 90% ({tool})',
    'notify.context.title': 'aitop: context over 90%',
    'notify.context.many': { one: '{n} session passed 90% context', other: '{n} sessions passed 90% context' },
    'phase.approve': 'Approve tool',
  },
};

// 문구 하나. opts.lang 이 없으면 지금 언어, opts.short 면 짧은 문구(없으면 긴 문구).
// 표에 없는 키는 키 이름을 그대로 돌려 빠진 번역이 화면에서 드러나게 한다 (키 일치는 테스트가 막는다).
// 값이 { one, other } 면 vars.n 이 1 일 때 one, 아니면 other 를 쓴다 (영어 단수·복수). long·short 안에도 둘 수 있다.
export function t(key, vars, { lang = current, short = false } = {}) {
  const table = STRINGS[lang] ?? STRINGS.ko;
  const v = Object.hasOwn(table, key) ? table[key] : key;
  const plural = (x) => (typeof x === 'string' ? x : Number(vars?.n) === 1 ? x.one : x.other);
  const s = plural(typeof v === 'string' || 'one' in v ? v : short ? (v.short ?? v.long) : v.long);
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
}

// 상태 문구. 수집 단계는 phase = { kind, msg?, args? } 만 보내고 문장은 화면(과 --json)이 여기서 만든다.
// msg 가 없으면 kind 가 문구 이름이다. args: what(도구 이름·대기 요청), n(팀원 수·단계 수), pct(기록 읽은 비율), agents(같이 도는 에이전트 수).
// 응답 대기는 '응답 대기 · {what}' 처럼 요청을 붙이고, agents 가 있으면 어느 상태든 ' · 에이전트 N개 실행 중' 을 붙인다.
// short: 표의 STATUS 칸. 짧은 문구를 쓰고, 응답 대기는 ◆ 와 행 색으로 이미 보이므로 앞의 '응답 대기' 를 뗀다 (뒤에 붙은 것이 없으면 남긴다).
export function phaseText(phase, { lang = current, short = false } = {}) {
  if (!phase?.kind) return '';
  const o = { lang, short };
  const raw = phase.args ?? {};
  // 소스가 넣은 한국어 대기 사유(도구 허락)는 ko 가 아닐 때만 바꾼다. ko(화면·--json)는 그대로.
  const a = lang !== 'ko' && raw.what === STRINGS.ko['phase.approve'] ? { ...raw, what: t('phase.approve', null, o) } : raw;
  const parts = [t(`phase.${phase.msg ?? phase.kind}`, a, o)];
  if (phase.kind === 'waiting' && a.what) parts.push(String(a.what));
  if (a.agents) parts.push(t('phase.agents', { n: a.agents }, o));
  if (short && phase.kind === 'waiting' && parts.length > 1) parts.shift();
  // 영어 에이전트 문구는 소문자로 시작해 문장 가운데(' · ' 뒤)에 붙는다. 맨 앞에 혼자 남으면 첫 글자만 대문자로.
  if (lang !== 'ko' && a.agents && parts.length === 1) parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
  return parts.join(' · ');
}
