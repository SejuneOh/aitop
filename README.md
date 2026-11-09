# ⣠⣴⣾ aitop

터미널에서 지금 돌고 있는 AI 코딩 세션(Claude Code · Codex CLI · Antigravity CLI · Gemini CLI)과 진행 내용, 토큰을 실시간으로 보는 읽기 전용 모니터.

- 포트를 열지 않고, 네트워크 요청을 하지 않는다. 각 CLI 가 내 PC 에 남기는 세션 파일만 읽는다.
- 세션 파일은 읽기 전용으로만 연다. 디스크에 쓰는 곳은 읽은 위치·합계를 기억하는 `~/.cache/aitop` 뿐이다 (지워도 된다).
- 화면에 표시되는 텍스트 중 API 키·토큰처럼 보이는 값은 `••••` 로 가린다.
- 외부 라이브러리 없음 (Node 22 이상). Antigravity CLI 의 세부 정보는 Node 내장 `node:sqlite` 로 기록을 immutable(파일을 하나도 만들거나 고치지 않는 열기)로 열 수 있는 Node 22.15 이상에서만 읽는다.

## 설치

개발 중에는 비공개 GitHub Packages 레지스트리에만 올린다. 저장소 권한이 있는 계정만 설치할 수 있다.

```bash
# 1회: 패키지 읽기 권한을 토큰에 추가하고 npm 에 등록
gh auth switch -u SejuneOh            # refresh 는 활성 계정에만 적용된다
gh auth refresh -h github.com -s read:packages
npm config set @sejuneoh:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "$(gh auth token -u SejuneOh)"

# 설치·업데이트
npm install -g @sejuneoh/aitop
aitop
```

로컬 코드로 바로 써 보려면 저장소에서 `npm install -g .`

## 릴리스

| 브랜치 | 하는 일 |
|---|---|
| 기능 브랜치 → `dev` | PR 마다 CI(단위 테스트 → e2e → 실행 확인 → `npm pack` 설치 확인, Node 22/22.13/22.15/24, macOS 22) 실행. 병합 후 로컬에서 `npm install -g .` 로 확인. `dev` 에 들어오면 `release-pr` 워크플로가 `dev` → `main` release PR 을 만들거나 제목·본문(포함된 PR, 닫는 이슈)을 갱신한다 |
| `dev` → `main` | 단위 테스트와 e2e 를 통과하고 `package.json` 의 `version` 이 아직 배포되지 않은 값이면 GitHub Packages 에 배포하고, `v<버전>` 릴리스가 없으면 태그·릴리스 생성 (배포 뒤 릴리스 생성만 실패했으면 재실행하면 배포는 건너뛰고 릴리스만 만든다) |

테스트

```
npm test            # 단위 테스트 (test/*.test.mjs)
npm run test:e2e    # e2e: 실제 bin 실행(--json/--once/--help), 가상 터미널에서 키 입력·종료 확인 (Linux, util-linux script 필요)
```

버전 올리기는 `dev` 에서 `npm version patch|minor|major --no-git-tag-version` 후 커밋한다. 버전을 올리지 않은 `main` 병합은 테스트만 돌고 배포하지 않는다.

공개 배포로 바꿀 때는 `package.json` 의 `publishConfig.registry` 를 `https://registry.npmjs.org` 로 바꾸고, `release.yml` 에 `NPM_TOKEN` 시크릿과 `--access public` 을 넣는다.

## 사용

```
aitop            실시간 화면
aitop --all      종료된 세션(24시간 이내)도 함께
aitop --once     현재 상태를 한 번 출력
aitop --json     세션 목록과 오늘·7일 사용량을 JSON 으로 한 번 출력 (--all 과 함께 가능)
                 0.5.0 부터 files[] 의 줄 수 필드는 writtenLines·deletedLines (편집 누적, 예전 added·removed)
                 0.6.1 부터 비용(cost 등)은 소수 넷째 자리까지 반올림
aitop --version  설치된 버전
aitop --doctor   도구별 연결 점검 (기록 폴더, 기록 수, 마지막 기록, 실행 수). --json 과 함께 가능
aitop --theme light|dark  밝은 배경 / 어두운 배경 색. 없으면 AITOP_THEME 환경변수, 그다음 COLORFGBG 로 고르고, 모르면 어두운 배경
```

동료 PC 에서 Codex · Gemini 가 잡히는지 볼 때는 `aitop --doctor` 결과를 그대로 붙여 넣으면 된다. 기록 내용은 나오지 않는다 (Gemini 는 형식 확인용 JSON 키 이름만).
`--json` 에는 `version` 과 같은 점검 결과 `tools` 가 들어 있다.

색 없이도(NO_COLOR) 보이도록 비용 상위 두 세션에는 `▲`, 컨텍스트 85% 이상에는 `!` 가 붙는다.

실시간 화면은 창(탭) 제목을 `󰚩 (2◆ 1●) aitop` 처럼 아이콘과 응답 대기·확인 전 수로 바꾼다. `--bell` 을 주면 응답 대기가 새로 생길 때 벨을 한 번 울린다.

### 로고와 탭 아이콘

로고 `⣠⣴⣾` 는 점점 높아지는 막대 세 개다 (top 미터, 도구 셋). 점자 글자라 한글 터미널에서도 폭이 1칸으로 정해져 있다.

| `AITOP_ICONS` | 헤더 로고 | 창·탭 제목 | WezTerm user var |
|---|---|---|---|
| (기본) | `⣠⣴⣾` | `󰚩 (2◆) aitop` (Nerd Font 로봇 U+F06A9) | 내보냄 |
| `plain` | `⣠⣴⣾` | `⣾ (2◆) aitop` | 끔 |
| `ascii` | `>_ai` | `(2◆) aitop` | 끔 |

Nerd Font 를 쓰지 않는 터미널에서는 탭 제목 아이콘이 빈 네모로 보일 수 있다. 그때는 `export AITOP_ICONS=plain` 으로 끈다.

WezTerm 은 aitop 이 내보내는 user var(`aitop`, `aitop_waiting`, `aitop_unseen`)로 탭을 꾸밀 수 있다. `wezterm.lua` 예:

```lua
local wezterm = require 'wezterm'
wezterm.on('format-tab-title', function(tab)
  local v = tab.active_pane.user_vars
  if v.aitop == '1' then
    local w = tonumber(v.aitop_waiting or '0') or 0
    return { { Foreground = { Color = w > 0 and '#fbbf24' or '#7dd3fc' } }, { Text = ' 󰚩 aitop' .. (w > 0 and (' ' .. w .. '◆') or '') .. ' ' } }
  end
end)
```

- `format-tab-title` 핸들러는 하나만 쓰인다. 이미 있으면 그 안에 위 조건을 합친다.
- tmux 안에서 돌리면 tmux 가 user var 를 전달하지 않아 탭 값이 오지 않는다.

- 모르는 옵션을 주면 오류와 도움말을 보이고 2 로 끝난다.
- `--once` 를 파이프나 파일로 받으면 색 코드를 넣지 않고(`FORCE_COLOR=1` 이면 넣음), 크기는 `COLUMNS`·`LINES` 를 따른다.

| 키 | 동작 |
|---|---|
| / | 세션 검색 (이름·폴더·모델). Enter 적용, Esc 지우기 |
| ↑↓ / j k | 세션 선택 |
| n | 다음 볼 세션으로 이동 (응답 대기 → 완료 · 확인 전) |
| f / Tab | 변경 파일 목록으로. ←→ 지시 탭, ↑↓ 파일 고르기, Enter diff 보기 |
| diff 에서 ↑↓ · space · [ ] | 스크롤 · 페이지 · 이전·다음 파일 |
| d | 상세 열기·닫기 |
| e | 종료된 세션 보이기·숨기기 |
| c | 비용 기준 전환: API 환산(캐시 포함, 기본) ↔ 캐시 제외(입력·출력만). 표·헤더·상세가 같이 바뀐다 |
| ? | 도움말 |
| Esc | 한 단계 뒤로 (도움말 닫기, 검색 지우기, diff → 파일 목록 → 세션). 종료하지 않는다 |
| q / Ctrl-C | 나가기 |

## 화면

- 헤더 오른쪽: 오늘·최근 7일 Claude 와 Antigravity CLI 사용량(토큰, API 환산 비용). 최근 7일 안에 바뀐 기록(서브에이전트 포함)을 날짜별로 모은다. agy 는 호출마다 그 직전 단계의 만든 시각을 호출 날짜로 본다. 처음 실행 때는 `7일 집계 중 N%` 로 채워진다. 폭이 모자라면 토큰 수, 7일, 오늘 순으로 줄인다.
- 지출 속도: `오늘 $194 ($31/h)` 의 괄호는 최근 1시간(5분 단위 근사) 비용이다. 0 이면 숨기고, 폭이 모자라면 가장 먼저 뺀다. `--json` 에는 `usage.lastHour` 로 나간다.
- 화면 높이가 30줄 이상이면 세션 표를 `세션 N` 상자로 감싼다. 비용 색은 화면에서 가장 큰 금액 두 개에만 칠한다.
- 키 안내 줄은 폭이 모자라면 오른쪽부터 줄이고 `?`·`q` 는 늘 남긴다. `NO_COLOR` 이면 키가 `[q]` 처럼 괄호로 보이고, 포커스된 상자는 굵은 선(`┏━┃`)으로 그린다.
- `● 완료 · 확인 전`: 작업 중이던 세션이 끝났는데 아직 선택해 보지 않은 세션. aitop 을 다시 켜면 초기화된다.

- STATUS: 지금 단계 (`도구 실행 · Bash`, `생각 중`, `답변 작성 중`, `팀원 N명 작업 중`, `응답 대기`, `다음 지시 대기`). 큰 기록을 처음 읽는 동안은 `기록 읽는 중 N%`
- 응답 대기 세션은 맨 위에 배경색으로 보인다. 화면이 작아 표가 잘리면 마지막 줄에 `… +N 세션` 이 나온다.
- 서브에이전트는 메인 세션 아래 `├─` 행으로 붙고, 하는 일(description) 뒤에 타입이 흐리게 붙는다. 첫 응답 전에는 `시작 중`, 끝나면 6초간 `완료`로 보였다가 사라진다.
- COST: Claude API 정가로 환산한 비용. 구독 요금제 사용분도 같은 기준으로 계산한다 (`src/pricing.mjs`). 가격표에 없는 모델이 섞이면 `$1.20?` 처럼 `?` 가 붙는다. Codex 는 OpenAI API 정가로 환산한다 (gpt-5.3-codex, gpt-5.1-codex(-mini), codex-mini, gpt-4o-mini). 값은 2026-11 가격 비교 사이트 기준 추정이며, 세션 중 모델이 바뀌면 마지막 모델 가격으로 계산한다. Antigravity CLI 는 Google 공식 Gemini API 가격표(유료 등급 standard, https://aistudio.google.com/docs/pricing, 2026-11-06 확인)로 호출마다 그 호출 시각의 가격으로 환산한다: gemini-4-argon 은 2026-12-01 부터, gemini-3.8-flash·gemini-3.6-flash 는 2027-01-01 부터 두 배 가격이다 (UTC 기준). gemini-3.5-flash-lite, gemini-3.1-flash-lite 도 표에 있다. 모델 이름이 표와 똑같을 때만 가격을 매기고, 그 밖의 모델(gemini-3.5-flash, gemini-3-flash-preview 등)은 추측하지 않고 `?` 로 보인다. 서브에이전트 비용은 부모 세션에 더한다.
- IDLE: 마지막 활동 후 지난 시간. 작업 중이면 `now`.
- 상세 패널의 토큰 합계 = 메인 + 서브에이전트 = 입력 + 출력 + 캐시 읽기 + 캐시 쓰기. 비용은 캐시 제외 금액도 함께 보인다.
- `--all`: 24시간 안에 바뀐 기록을 종료 세션으로 보인다. 본문은 선택했을 때 읽는다.
- 변경 파일: 세션(서브에이전트 포함)이 Edit/Write(Codex 는 apply_patch)로 고친 파일이 있으면 상세 패널 오른쪽 위에 `src/ui.mjs  편집 ×3  14:02` 처럼 편집 횟수와 마지막 시각이 보인다. git diff 가 아니라 이 세션의 편집 기록이다. diff 머리의 `쓴 줄 · 지운 줄` 은 편집마다 더한 누적값이라 최종 변경량과 다르다.
- 지시 탭: `[이번 지시] T5 T3 전체`. 처음에는 마지막 지시 뒤에 고친 파일만 보인다. 편집이 있었던 이전 지시는 `T번호` 탭으로, 세션 전체는 `전체` 탭으로 본다. 서브에이전트 편집은 그 서브에이전트를 부른 지시에 들어간다. lock·빌드 결과 파일은 목록 끝에 흐리게 보인다. 지시는 최근 50개까지 기억한다. 파일을 열면 고친 순서의 역순으로 변경 조각마다 `시각 · 누가 · @@ 위치` 를 붙여 보인다. `.env`, `*.pem` 같은 비밀 파일은 목록에만 보이고 내용은 숨긴다.

## 읽는 곳

| 도구 | 실행 중 판단 | 진행 내용·토큰 |
|---|---|---|
| Claude Code | `~/.claude/sessions/<pid>.json` + pid 가 살아 있는지 | `~/.claude/projects/*/<sessionId>.jsonl`, `…/subagents/agent-*.jsonl` |
| Codex CLI | `codex` 프로세스와 작업 폴더 (Linux `/proc`, macOS `ps`·`lsof`) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Antigravity CLI (`agy`) | `agy` 프로세스가 열어 둔 `presence/<id>.lock` (Linux `/proc/<pid>/fd`). macOS 는 작업 폴더로 짝짓는다 | `~/.gemini/antigravity-cli/conversation_summaries.db`(제목·상태·서브에이전트), `conversations/<id>.db` 의 `gen_metadata`(모델·토큰)·`steps`(지시·답변·도구 호출) |
| Gemini CLI | `gemini` 프로세스 | 아직 미지원 |

## 알려진 한계

- Linux·WSL·macOS 만 지원한다. Windows(PowerShell)는 설치되지 않는다. macOS 는 `ps`·`lsof` 를 2초에 한 번 부른다.
- 배경색 자동 판별은 `COLORFGBG` 에 기대는데 Windows Terminal 은 이 값을 넣지 않는다. 밝은 배경의 Windows Terminal 에서는 `aitop --theme light` 로 실행한다.
- 세션 파일 형식은 각 CLI 의 내부 형식이라, CLI 업데이트로 바뀌면 `src/sources/` 의 해당 파일을 고쳐야 한다.
- 컨텍스트 창 크기는 기록에 없어서 모델별 표(`src/pricing.mjs`)로 정한다. 표에 없는 모델은 200k 를 넘으면 1M 으로 가정한다.
- 같은 폴더에서 codex 를 여러 개 띄우면, 최근에 바뀐 세션 파일부터 순서대로 짝짓는다.
- Antigravity CLI 세션은 Gemini 탭에 보인다. 지시·답변·도구 호출은 `conversations/<id>.db` 의 `steps` 에서 읽지만 변경 파일은 아직 읽지 않는다. 토큰·단계 필드 번호는 실제 기록에서 확인한 값이라(출력 = 생각 + 답변) agy 업데이트로 바뀔 수 있다. Windows Antigravity 앱(`/mnt/c/…/.gemini/antigravity`)은 읽지 않는다.
- agy 기록은 파일을 하나도 건드리지 않으려고 `-wal` 을 읽지 않는다. 그래서 진행 내용과 응답 대기(도구 허락 대기)는 agy 가 `-wal` 을 본 파일에 합친 뒤에야 보이고, 보통 30초쯤 늦다. 허락한 뒤에는 `-wal` 이 다시 바뀌는 것을 보고 바로 작업 중으로 돌린다.
- 토큰 합계에는 캐시 읽기 토큰이 포함된다. 세부 구성은 상세 패널에서 본다.
- 실시간 화면은 한 번 갱신에 기록을 24MB 까지만 읽는다. 아주 큰 기록은 처음 몇 초 동안 합계가 채워지는 중으로 보인다.
- 캐시 폴더 이름에 가격표 지문이 들어가서, 가격표를 바꾼 버전으로 올리면 첫 실행 때 비용을 다시 계산한다.
- 변경 파일은 Edit/Write 도구 결과와 Codex 의 성공한 apply_patch 만 본다. Codex 패치에는 줄 번호가 없어 diff 에 `@@ 문맥` 만 보인다. Bash(`sed`, `git checkout` 등)로 바꾼 파일과 사람이 직접 고친 내용은 빠진다. 파일 60개, 파일당 변경 조각 8개, 세션당 1500줄까지만 보관하고, 넘치면 오래된 조각부터 버린다 (줄 수 통계는 남는다).
- 서브에이전트는 `finished` 표시 없이 끊긴 기록이 남기 때문에, 메인이 결과를 기다리는 중이거나 15분 안에 기록이 바뀐 경우만 실행 중으로 본다.
