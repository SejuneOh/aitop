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
  aitop --line     오늘 비용·응답 대기 수·시간당 지출을 한 줄로 내고 끝낸다 (tmux 상태줄용, 예: $54.13/$50 wait 2 $3.1/h)
                   --line=tmux 는 tmux 색 서식(#[fg=...])을 넣는다. --line-width <N> 폭 상한(기본 40, 넘으면 뒤 항목부터 뺀다)
                   장부 캐시만 읽는다. 캐시가 없어 1.5초 안에 못 읽으면 ... 을 낸다. 응답 대기 수는 Claude Code 세션만 센다
  aitop --json     세션 목록과 사용량 합계를 JSON 으로 한 번 출력한다 (--all 과 함께 쓸 수 있다)
  aitop --report daily [--by tool|model] [--days N] [--json]  최근 N일(기본·최대 30)의 날짜별 토큰·비용(API 정가 환산)을
                   도구별 또는 모델별 표로 내고 끝낸다. 최근 날짜가 위, 맨 아래는 합계. 처음 실행은 30일치 기록을 읽느라 오래 걸릴 수 있다
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
  aitop --report daily [--by tool|model] [--days N] [--json]  print daily tokens and cost (API list price) for the last N days
                   (default and max 30) by tool or by model, then exit. Newest day first, total at the bottom. The first run reads 30 days of logs and may take a while
  aitop --doctor   check Claude, Codex, Antigravity and Gemini logs, running processes and the config file (works with --json)
  aitop --bell     ring the terminal bell when a session starts waiting for you
  aitop --notify   show a desktop notification when a session starts waiting (notify-send or osascript, skipped if missing)
  aitop --on-waiting <cmd>  run a command with /bin/sh -c when a session starts waiting (runs as you, 10 second limit)
                   Session info is passed only in env vars: AITOP_TOOL AITOP_PROJECT AITOP_SESSION_ID AITOP_CWD AITOP_WAITING_FOR
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
    'opt.reportMissing': '--report 값이 없습니다 (daily)',
    'opt.reportBad': '--report 값 {value} 이 잘못되었습니다 (daily)',
    'opt.byMissing': '--by 값이 없습니다 (tool 또는 model)',
    'opt.byBad': '--by 값 {value} 이 잘못되었습니다 (tool 또는 model)',
    'opt.daysMissing': '--days 값이 없습니다 (일 수)',
    'opt.daysBad': '--days 값 {value} 이 잘못되었습니다 (0 보다 큰 정수)',
    'opt.reportOnly': '--by, --days 는 --report 와 함께 쓴다',

    // 기간 리포트 (--report daily). 도구·모델 이름은 번역하지 않는다.
    'report.title': '날짜별 사용량 · 최근 {n}일 ({from} ~ {to}) · {by} · API 정가 환산',
    'report.by.tool': '도구별',
    'report.by.model': '모델별',
    'report.date': '날짜',
    'report.total': '합계',
    'report.empty': '이 기간에 기록된 사용량이 없습니다',
    'report.unpriced': '? 가격표에 없는 모델이 있어 비용이 실제보다 적게 잡혔을 수 있습니다',
    'report.partial': '시간 상한 안에 기록을 다 읽지 못해 일부만 셌습니다. 다시 실행하면 이어 읽습니다',
    'report.progress': '사용량 장부 읽는 중 {pct}% ({s}초)',
    'report.capped': '--days 는 장부가 남기는 {n}일까지만 볼 수 있어 {n}일로 줄입니다',

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
    'hdr.idle': '대기',
    'hdr.waiting': { long: '응답 대기', short: '응답' },
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
    'tools.hidden': '숨김 {list}',
    'tools.ended': '종료된 세션 포함 (24시간)',
    'table.title': '세션 {n}',
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
    'legend.ended': '종료',
    'legend.pin': '고정한 세션 (p). SESSION 칸 앞에 붙는다',
    'legend.status': '지금 단계. 큰 기록을 처음 읽는 동안은 기록 읽는 중 N%',
    'legend.tokens': '세션 누적 토큰 (서브에이전트 포함, 캐시 읽기 포함)',
    'legend.cost': 'API 정가로 환산한 비용 (Codex 는 OpenAI 정가 추정). ? 는 가격표에 없는 모델 포함',
    'legend.context': '마지막 요청의 컨텍스트 사용률 (모델별 창 크기 기준)',
    'legend.idleCol': '마지막 활동 후 지난 시간. 작업 중이면 now',
    'legend.hiddenKey': '숨김 N',
    'legend.hidden': '도구 줄 끝: 7일 동안 안 쓴 도구를 숨김. 다시 보려면 설정 파일에 "hideIdleTools": false',
    'legend.folded': '도구 줄 끝: 화면이 좁아 접은 도구 수 (넓히면 보인다)',
    'legend.periodKey': '오늘 / 7일',
    'legend.period': '헤더 오른쪽. 날짜별 합계, API 정가 환산이며 구독 요금제의 청구액이 아니다',
    'legend.filesKey': '변경 파일',
    'legend.files': 'Edit/Write(Codex 는 apply_patch) 로 고친 파일과 편집 횟수. git diff 가 아니다',

    // 화면 안 도움말의 키 설명 (help.mjs 의 VIEWS·COMMON). hk.<화면>.<이름>.
    'hk.table.search': '세션 검색 (이름·폴더·모델). Enter 적용, Esc 지우기',
    'hk.table.select': '세션 선택',
    'hk.table.next': '다음 볼 세션으로 (응답 대기 → 완료 · 확인 전)',
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
    'hopt.budgetDay': '--budget-day <달러>',
    'hopt.notify': '응답 대기가 생기면 데스크톱 알림',
    'hopt.onWaitingText': '응답 대기가 생기면 명령 실행',
    'hopt.budgetDayText': '하루 예산. 헤더에 예상 비용 경고',
    'hopt.showRequests': '응답 대기 요청 전체를 상세·--json 에',
    'hopt.colorBlind': '적록 색약용 색 (대기·돈·경고를 노랑·파랑 계열로)',
    'hopt.debug': '디버그 로그를 남긴다',
    'hopt.line': '오늘 비용·대기 수·시간당 지출 한 줄 (tmux 상태줄용)',
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
    'detail.unpriced': '  ? 가격표에 없는 모델 포함',

    // 데스크톱 알림 (--notify). 화면 언어를 따른다.
    'notify.one': 'aitop: 응답 대기 ({tool})',
    'notify.title': 'aitop: 응답 대기',
    'notify.many': '{n}개 세션이 응답을 기다립니다',
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
    'opt.reportMissing': '--report needs a value (daily)',
    'opt.reportBad': 'bad --report value {value} (daily)',
    'opt.byMissing': '--by needs a value (tool or model)',
    'opt.byBad': 'bad --by value {value} (tool or model)',
    'opt.daysMissing': '--days needs a value (number of days)',
    'opt.daysBad': 'bad --days value {value} (a whole number above 0)',
    'opt.reportOnly': '--by and --days only work with --report',

    'report.title': 'Daily usage, last {n} days ({from} to {to}), {by}, API list price',
    'report.by.tool': 'by tool',
    'report.by.model': 'by model',
    'report.date': 'Date',
    'report.total': 'Total',
    'report.empty': 'No usage recorded in this period',
    'report.unpriced': '? includes unpriced models, so the cost may be lower than actual',
    'report.partial': 'Could not read all logs within the time limit, so this is partial. Run again to continue',
    'report.progress': 'Reading usage logs {pct}% ({s}s)',
    'report.capped': '--days is limited to the {n} days the ledger keeps, using {n}',

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
    'doctor.records': { one: '{n} log', other: '{n} logs' },
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
    'phase.unseen': { long: 'Done, unseen', short: 'Done, unseen' },
    'phase.idle': { long: 'Idle, ready for the next prompt', short: 'Idle' },
    'phase.starting': 'Starting',
    'phase.firstInput': { long: 'Idle, ready for the first prompt', short: 'Idle' },
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
    'hdr.waiting': { long: 'waiting', short: 'wait' },
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
    'tools.hidden': 'hidden {list}',
    'tools.ended': 'with ended sessions (24h)',
    'table.title': 'Sessions {n}',
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
    'legend.ended': 'Ended',
    'legend.pin': 'Pinned session (p), before SESSION',
    'legend.status': 'Current step (Reading log N% on first load)',
    'legend.tokens': 'Tokens incl. subagents and cache reads',
    'legend.cost': 'API cost (Codex estimated). ? = unpriced',
    'legend.context': 'Context used by the last request',
    'legend.idleCol': 'Time since last activity. now while working',
    'legend.hiddenKey': 'hidden N',
    'legend.hidden': 'Tools unused for 7 days (hideIdleTools)',
    'legend.folded': 'Tools folded on a narrow screen',
    'legend.periodKey': 'today / 7d',
    'legend.period': 'Daily API cost totals, not your bill',
    'legend.filesKey': 'Changed files',
    'legend.files': 'Edit/Write/apply_patch edits. Not git diff',

    'hk.table.search': 'Search by name, folder or model',
    'hk.table.select': 'Select a session',
    'hk.table.next': 'Next session to check (waiting, then unseen)',
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
    'hopt.budgetDay': '--budget-day <usd>',
    'hopt.notify': 'Desktop alert when a session waits',
    'hopt.onWaitingText': 'Run a command when a session waits',
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
    'detail.unpriced': '  ? includes unpriced models',

    'notify.one': 'aitop: waiting ({tool})',
    'notify.title': 'aitop: waiting',
    'notify.many': { one: '{n} session is waiting for you', other: '{n} sessions are waiting for you' },
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
