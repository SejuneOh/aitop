// 화면 밖 문구(--help, --doctor, 옵션 오류, --print-config)의 한국어·영어 표와 t(). 의존성 없이 이 파일만으로 돈다.
// 언어는 --lang > AITOP_LANG > 설정 파일 lang > LC_ALL > LC_MESSAGES > LANG 순서로 고른다 (bin 이 setLang 으로 정한다).
// 로캘 문자열이 ko 로 시작하면 ko, 그 밖(C, C.UTF-8, POSIX, 없음 포함)은 en 이다.
// 실시간 화면(표·상세·도움말 화면)은 상태 문구(phaseText)만 이 표를 쓴다. 나머지 화면 문구는 영어 화면 3/3 에서 옮긴다.
// 표의 값은 문자열이거나 { long, short } 다. short 는 좁은 폭에서 쓰고, 없으면 long 을 쓴다.
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
  aitop --line     오늘 비용·응답 대기 수·시간당 지출을 한 줄로 내고 끝낸다 (tmux 상태줄용, 예: $54.13/$50 wait 2 $3.1/h)
                   --line=tmux 는 tmux 색 서식(#[fg=...])을 넣는다. --line-width <N> 폭 상한(기본 40, 넘으면 뒤 항목부터 뺀다)
                   장부 캐시만 읽는다. 캐시가 없어 1.5초 안에 못 읽으면 ... 을 낸다. 응답 대기 수는 Claude Code 세션만 센다
  aitop --json     세션 목록과 사용량 합계를 JSON 으로 한 번 출력한다 (--all 과 함께 쓸 수 있다)
  aitop --doctor   Claude · Codex · Antigravity · Gemini 기록과 실행 중인 프로세스, 설정 파일을 점검한다 (--json 과 함께 쓸 수 있다)
  aitop --bell     응답 대기 세션이 새로 생기면 터미널 벨을 울린다
  aitop --notify   응답 대기 세션이 새로 생기면 데스크톱 알림을 띄운다 (notify-send · osascript, 없으면 건너뜀)
  aitop --on-waiting <명령>  응답 대기 세션이 새로 생기면 /bin/sh -c 로 명령을 실행한다 (내 권한으로 실행, 10초 제한)
                   세션 정보는 환경변수로만: AITOP_TOOL AITOP_PROJECT AITOP_SESSION_ID AITOP_CWD AITOP_WAITING_FOR
  aitop --show-requests  응답 대기 요청 전체를 상세 패널·--json 에 보인다 (AITOP_SHOW_REQUESTS=1). 비밀값 가림은 최선일 뿐이라 명령 속 비밀값이 보일 수 있다
  aitop --budget-day <달러>  하루 예산. 헤더에 오늘 $12.30/$50 처럼 보이고, 오늘 끝 예상 비용(오늘 + 최근 속도 × 자정까지, 늘 API 환산)이
                   80% 를 넘으면 '예상 $45', 100% 를 넘으면 '예상 $60!' 로 알린다 (AITOP_BUDGET_DAY, 설정 파일 budgetDay)
  aitop --theme light|dark  밝은 배경 / 어두운 배경 색 (없으면 COLORFGBG 로 고른다)
  aitop --color-blind  적록 색약용 색. 응답 대기·돈·경고·diff 를 노랑·파랑 계열로 가른다 (AITOP_COLOR_BLIND=1, 설정 파일 colorBlind). --theme 과 함께 쓴다
  aitop --lang ko|en  --help·--doctor·오류 문구의 언어 (AITOP_LANG, 설정 파일 lang, 없으면 LC_ALL·LC_MESSAGES·LANG 이 ko 로 시작할 때 한국어). 실시간 화면은 아직 한국어
  aitop --no-bell · --no-all · --no-show-requests · --no-notify · --no-on-waiting · --no-budget-day · --no-debug · --no-color-blind  설정 파일에서 켠 값을 이번 실행만 끈다
  aitop --debug    디버그 로그를 남긴다 (AITOP_DEBUG=1, 설정 파일 debug). 기록 형식이 바뀌어 값이 빌 때 원인 확인용
                   {logPath} (1MB 넘으면 .1 로 하나만 남김, 오류 이름·파일 이름만 쓰고 비밀값은 가림)
  aitop --print-config  설정 값마다 값과 출처(flag/env/file/default), 설정 파일 위치를 보인다 (--json 과 함께 쓸 수 있다)
  aitop --version  설치된 버전을 보인다

  AITOP_ICONS=plain  창 제목의 Nerd Font 아이콘과 WezTerm 탭 값을 끈다 (ascii 면 로고도 ASCII)
  AITOP_AMBIGUOUS=wide  ·, →, ─, ● 같은 폭이 모호한 기호를 2칸으로 그리는 터미널(동아시아 폭 설정)용. 표·상자 기호를 1칸 기호로 바꿔 줄이 밀리지 않게 한다 (설정 파일 ambiguous)

  설정 파일: {configPath}
    예) { "theme": "light", "icons": "plain", "bell": true, "notify": true, "onWaiting": "say 대기", "budgetDay": 50, "ambiguous": "wide", "hideIdleTools": false }
    hideIdleTools: 실행 중 세션이 없고 7일 동안 쓰지 않은 도구를 헤더 아래 도구 줄에서 숨긴다 (기본 true, false 면 늘 셋 다)
    onWaiting 은 파일 소유자가 나이고 그룹·다른 사용자가 쓸 수 없을 때(chmod 600)만 받는다.
    옵션 > 환경 변수 > 설정 파일 순서로 정한다. 잘못된 값은 무시하고 --doctor 에 알린다.

{keys}
  실시간 화면에서 ? 를 누르면 지금 화면의 키부터 보인다`;

const HELP_EN = `{logo} aitop - watch Claude Code, Codex, Antigravity and Gemini sessions live in your terminal

  aitop            live screen
  aitop --once     print the current state once and exit
  aitop --all      also show sessions that ended in the last 24 hours
  aitop --line     print today's cost, waiting count and spend per hour on one line and exit (for tmux, e.g. $54.13/$50 wait 2 $3.1/h)
                   --line=tmux adds tmux colors (#[fg=...]). --line-width <N> sets the max width (default 40, drops items from the end)
                   Reads only the cache. With no cache it prints ... after 1.5 seconds. The waiting count covers Claude Code sessions only
  aitop --json     print the session list and usage totals as JSON once (works with --all)
  aitop --doctor   check Claude, Codex, Antigravity and Gemini logs, running processes and the config file (works with --json)
  aitop --bell     ring the terminal bell when a session starts waiting for you
  aitop --notify   show a desktop notification when a session starts waiting (notify-send or osascript, skipped if missing)
  aitop --on-waiting <cmd>  run a command with /bin/sh -c when a session starts waiting (runs as you, 10 second limit)
                   Session info is passed only in env vars: AITOP_TOOL AITOP_PROJECT AITOP_SESSION_ID AITOP_CWD AITOP_WAITING_FOR
  aitop --show-requests  show full waiting requests in the detail panel and --json (AITOP_SHOW_REQUESTS=1). Secret masking is best effort, so secrets in commands may show
  aitop --budget-day <usd>  daily budget. The header shows today $12.30/$50, and it warns when the projected end-of-day cost (today + recent rate until midnight, always API price)
                   passes 80%, and in the warning color with ! past 100% (AITOP_BUDGET_DAY, config budgetDay)
  aitop --theme light|dark  colors for a light or dark background (picked from COLORFGBG if not set)
  aitop --color-blind  red-green color blind palette. Waiting, money, warnings and diffs use yellow and blue (AITOP_COLOR_BLIND=1, config colorBlind). Works with --theme
  aitop --lang ko|en  language for --help, --doctor and error messages (AITOP_LANG, config lang, else Korean when LC_ALL, LC_MESSAGES or LANG starts with ko). The live screen is still in Korean
  aitop --no-bell · --no-all · --no-show-requests · --no-notify · --no-on-waiting · --no-budget-day · --no-debug · --no-color-blind  turn off a config file setting for this run
  aitop --debug    write a debug log (AITOP_DEBUG=1, config debug). Useful when a log format changes and values go blank
                   {logPath} (keeps one .1 file past 1MB, writes only error and file names, masks secrets)
  aitop --print-config  show each setting with its value, source (flag/env/file/default) and the config file path (works with --json)
  aitop --version  show the installed version

  AITOP_ICONS=plain  turn off the Nerd Font icon in the window title and the WezTerm tab values (ascii also makes the logo ASCII)
  AITOP_AMBIGUOUS=wide  for terminals that draw ambiguous width symbols like ·, →, ─, ● as 2 columns (East Asian width). Uses 1 column symbols so lines stay aligned (config ambiguous)

  Config file: {configPath}
    e.g. { "theme": "light", "icons": "plain", "bell": true, "notify": true, "onWaiting": "say waiting", "budgetDay": 50, "ambiguous": "wide", "hideIdleTools": false, "lang": "en" }
    hideIdleTools: hide tools with no running session and no use in 7 days from the tool line under the header (default true, false always shows all)
    onWaiting is accepted only when you own the file and no group or other user can write it (chmod 600).
    Order: option > env var > config file. Bad values are ignored and reported by --doctor.

{keys}
  Press ? on the live screen to see the keys for the current view first`;

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
    'opt.onWaitingDash': "--on-waiting 값이 - 로 시작합니다 ({value}). 명령이 맞으면 --on-waiting='{value}' 처럼 = 로 붙여 쓴다",
    'opt.lineBad': '--line 값 {value} 이 잘못되었습니다 (plain 또는 tmux)',
    'opt.lineWidthMissing': '--line-width 값이 없습니다 (글자 수)',
    'opt.lineWidthBad': '--line-width 값 {value} 이 잘못되었습니다 (0 보다 큰 정수)',

    'cfg.notFile': '설정 파일이 일반 파일이 아니라 읽지 않습니다',
    'cfg.tooBig': '설정 파일이 {kb}KB 를 넘어 읽지 않습니다',
    'cfg.unreadable': '설정 파일을 읽을 수 없습니다 ({code})',
    'cfg.badJson': '설정 파일이 올바른 JSON 이 아니라 무시합니다 ({why})',
    'cfg.notObject': '설정 파일의 맨 위는 JSON 객체({ ... })여야 합니다',
    'cfg.unknownKey': '모르는 키 {key} 는 무시합니다',
    'cfg.badValue': '{key} 값 {value} 이 잘못되어 무시합니다 ({expect})',
    'cfg.badEnv': '환경 변수 {name} 값 {value} 이 잘못되어 무시합니다 ({expect})',
    'cfg.onWaitingIgnored': 'onWaiting 은 무시합니다: {why}. chmod 600 으로 고치세요',
    'cfg.notMine': '파일 소유자가 현재 사용자가 아님',
    'cfg.shared': '그룹·다른 사용자가 쓸 수 있음 (mode {mode})',
    'cfg.either': '{a} 또는 {b}',
    'cfg.command': '실행할 명령 문자열',
    'cfg.positive': '0 보다 큰 수',
    'cfg.file': '설정 파일: {path} ({state})',
    'cfg.exists': '있음',
    'cfg.missing': '없음',

    'doctor.title': '{logo} aitop {version} 연결 점검 ({os})',
    'doctor.os': '{platform}, 프로세스 {state}',
    'doctor.procsOk': '확인 가능',
    'doctor.procsNo': '확인 불가',
    'doctor.state.ok': '찾음',
    'doctor.state.missing': '없음',
    'doctor.state.limited': '일부 지원',
    'doctor.noFolder': '기록 폴더 없음',
    'doctor.records': '기록 {n}개',
    'doctor.last': '마지막 {ago} 전',
    'doctor.runningUnknown': '실행 수 확인 불가 (Linux·WSL·macOS 만 지원)',
    'doctor.running': '실행 {n}',
    'doctor.unreadable': '최근 기록 읽기 실패',
    'doctor.keys': '키: {keys}',
    'doctor.hint.missing': '{tool} 를 한 번 실행하면 생깁니다',
    'doctor.hint.agyMissing': 'agy 를 한 번 실행하면 생깁니다 (Gemini 탭에 보입니다)',
    'doctor.hint.gemini': '프로세스만 감지합니다 (세션·토큰은 아직 지원하지 않음)',
    'doctor.hint.agyNode': 'Node {node} 에서는 기록을 읽기 전용으로 열 수 없어 프로세스만 감지합니다 (Node 22.15 이상 필요)',
    'doctor.notifier': '✓ 알림    {kind} ({path}) · --notify 로 켬',
    'doctor.noNotifier': '○ 알림    {want} 없음 · --notify 를 켜도 알림을 건너뜀{wsl}',
    'doctor.wsl': ' (WSL 은 notify-send 만 쓴다)',
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
    'phase.shell': '쉘 명령 실행 중',
    'phase.tool': '도구 실행 · {what}',
    'phase.toolUnknown': '도구 실행 · 도구',
    'phase.team': '팀원 {n}명 작업 중',
    'phase.think': '생각 중',
    'phase.working': '작업 중',
    'phase.steps': '작업 중 · {n}단계',
    'phase.loading': '기록 읽는 중 {pct}%',
    'phase.write': '답변 작성 중',
    'phase.agents': '에이전트 {n}개 실행 중',
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
    'opt.onWaitingDash': "--on-waiting value starts with - ({value}). If it is the command, attach it with =, like --on-waiting='{value}'",
    'opt.lineBad': 'bad --line value {value} (plain or tmux)',
    'opt.lineWidthMissing': '--line-width needs a value (characters)',
    'opt.lineWidthBad': 'bad --line-width value {value} (a whole number above 0)',

    'cfg.notFile': 'config file is not a regular file, not reading it',
    'cfg.tooBig': 'config file is over {kb}KB, not reading it',
    'cfg.unreadable': 'cannot read the config file ({code})',
    'cfg.badJson': 'config file is not valid JSON, ignoring it ({why})',
    'cfg.notObject': 'config file must be a JSON object ({ ... }) at the top',
    'cfg.unknownKey': 'ignoring unknown key {key}',
    'cfg.badValue': 'ignoring bad {key} value {value} ({expect})',
    'cfg.badEnv': 'ignoring bad env var {name} value {value} ({expect})',
    'cfg.onWaitingIgnored': 'ignoring onWaiting: {why}. Fix with chmod 600',
    'cfg.notMine': 'file is not owned by the current user',
    'cfg.shared': 'group or other users can write it (mode {mode})',
    'cfg.either': '{a} or {b}',
    'cfg.command': 'a command string',
    'cfg.positive': 'a number above 0',
    'cfg.file': 'Config file: {path} ({state})',
    'cfg.exists': 'found',
    'cfg.missing': 'not found',

    'doctor.title': '{logo} aitop {version} setup check ({os})',
    'doctor.os': '{platform}, processes {state}',
    'doctor.procsOk': 'visible',
    'doctor.procsNo': 'not visible',
    'doctor.state.ok': 'found',
    'doctor.state.missing': 'missing',
    'doctor.state.limited': { long: 'partial support', short: 'partial' },
    'doctor.noFolder': 'no log folder',
    'doctor.records': '{n} logs',
    'doctor.last': 'last {ago} ago',
    'doctor.runningUnknown': 'cannot count running (Linux, WSL and macOS only)',
    'doctor.running': 'running {n}',
    'doctor.unreadable': 'cannot read the latest log',
    'doctor.keys': 'keys: {keys}',
    'doctor.hint.missing': 'created after you run {tool} once',
    'doctor.hint.agyMissing': 'created after you run agy once (shown in the Gemini tab)',
    'doctor.hint.gemini': 'detects processes only (sessions and tokens not supported yet)',
    'doctor.hint.agyNode': 'Node {node} cannot open the logs read-only, so only processes are detected (needs Node 22.15 or later)',
    'doctor.notifier': '✓ notify  {kind} ({path}) · turn on with --notify',
    'doctor.noNotifier': '○ notify  {want} not found · --notify will skip notifications{wsl}',
    'doctor.wsl': ' (WSL uses notify-send only)',
    'doctor.config': '{mark} config {state}{path}',
    'doctor.configExists': 'found',
    'doctor.configMissing': 'not found',
    'doctor.debug': '{mark} debug  {state}{path}{tail}',
    'doctor.debugOn': 'on',
    'doctor.debugOff': 'off',
    'doctor.debugTail': ' · turn on with --debug',

    'phase.ended': 'Ended',
    'phase.done': 'Done',
    'phase.unseen': { long: 'Done · not checked', short: 'Done · new' },
    'phase.idle': { long: 'Waiting for prompt', short: 'Idle' },
    'phase.starting': 'Starting',
    'phase.firstInput': { long: 'Waiting for first prompt', short: 'Idle' },
    'phase.noPrompt': 'No prompt yet',
    'phase.geminiLimited': { long: 'Running (no details yet)', short: 'Running' },
    'phase.agyOldNode': { long: 'Running (details need Node 22.15+)', short: 'Running' },
    'phase.waiting': { long: 'Waiting for you', short: 'Waiting' },
    'phase.shell': { long: 'Running shell command', short: 'Shell' },
    'phase.tool': { long: 'Running tool · {what}', short: 'Tool · {what}' },
    'phase.toolUnknown': { long: 'Running tool', short: 'Tool' },
    'phase.team': { long: 'Team working · {n}', short: 'Team · {n}' },
    'phase.think': 'Thinking',
    'phase.working': 'Working',
    'phase.steps': { long: 'Working · step {n}', short: 'Step {n}' },
    'phase.loading': { long: 'Reading log {pct}%', short: 'Loading {pct}%' },
    'phase.write': { long: 'Writing reply', short: 'Writing' },
    'phase.agents': { long: 'agents running {n}', short: 'agents {n}' },
  },
};

// 문구 하나. opts.lang 이 없으면 지금 언어, opts.short 면 짧은 문구(없으면 긴 문구).
// 표에 없는 키는 키 이름을 그대로 돌려 빠진 번역이 화면에서 드러나게 한다 (키 일치는 테스트가 막는다).
export function t(key, vars, { lang = current, short = false } = {}) {
  const table = STRINGS[lang] ?? STRINGS.ko;
  const v = Object.hasOwn(table, key) ? table[key] : key;
  const s = typeof v === 'string' ? v : short ? (v.short ?? v.long) : v.long;
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
  const a = phase.args ?? {};
  const parts = [t(`phase.${phase.msg ?? phase.kind}`, a, o)];
  if (phase.kind === 'waiting' && a.what) parts.push(String(a.what));
  if (a.agents) parts.push(t('phase.agents', { n: a.agents }, o));
  if (short && phase.kind === 'waiting' && parts.length > 1) parts.shift();
  return parts.join(' · ');
}
