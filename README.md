# aitop

터미널에서 지금 돌고 있는 AI 코딩 세션(Claude Code · Codex CLI · Gemini CLI)과 진행 내용, 토큰을 실시간으로 보는 읽기 전용 모니터.

- 포트를 열지 않고, 네트워크 요청을 하지 않는다. 각 CLI 가 내 PC 에 남기는 세션 파일만 읽는다.
- 세션 파일은 읽기 전용으로만 연다. 디스크에 쓰는 곳은 읽은 위치·합계를 기억하는 `~/.cache/aitop` 뿐이다 (지워도 된다).
- 화면에 표시되는 텍스트 중 API 키·토큰처럼 보이는 값은 `••••` 로 가린다.
- 외부 라이브러리 없음 (Node 20 이상).

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
| 기능 브랜치 → `dev` | PR 마다 CI(단위 테스트 → e2e → 실행 확인, Node 20/22/24) 실행. 병합 후 로컬에서 `npm install -g .` 로 확인 |
| `dev` → `main` | 단위 테스트와 e2e 를 통과하고 `package.json` 의 `version` 이 아직 배포되지 않은 값이면 GitHub Packages 에 배포하고 `v<버전>` 태그·릴리스 생성 |

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
```

동료 PC 에서 Codex · Gemini 가 잡히는지 볼 때는 `aitop --doctor` 결과를 그대로 붙여 넣으면 된다. 기록 내용은 나오지 않는다 (Gemini 는 형식 확인용 JSON 키 이름만).
`--json` 에는 `version` 과 같은 점검 결과 `tools` 가 들어 있다.

실시간 화면은 창(탭) 제목을 `(2◆ 1●) aitop` 처럼 응답 대기·확인 전 수로 바꾼다. `--bell` 을 주면 응답 대기가 새로 생길 때 벨을 한 번 울린다.

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
| ? | 도움말 |
| Esc | 한 단계 뒤로 (도움말 닫기, 검색 지우기, diff → 파일 목록 → 세션). 종료하지 않는다 |
| q / Ctrl-C | 나가기 |

## 화면

- 헤더 오른쪽: 오늘·최근 7일 Claude 사용량(토큰, API 환산 비용). 최근 7일 안에 바뀐 기록(서브에이전트 포함)을 날짜별로 모은다. 처음 실행 때는 `7일 집계 중 N%` 로 채워진다. 폭이 모자라면 토큰 수, 7일, 오늘 순으로 줄인다.
- 화면 높이가 30줄 이상이면 세션 표를 `세션 N` 상자로 감싼다. 비용 색은 화면에서 가장 큰 금액 두 개에만 칠한다.
- 키 안내 줄은 폭이 모자라면 오른쪽부터 줄이고 `?`·`q` 는 늘 남긴다. `NO_COLOR` 이면 키가 `[q]` 처럼 괄호로 보이고, 포커스된 상자는 굵은 선(`┏━┃`)으로 그린다.
- `● 완료 · 확인 전`: 작업 중이던 세션이 끝났는데 아직 선택해 보지 않은 세션. aitop 을 다시 켜면 초기화된다.

- STATUS: 지금 단계 (`도구 실행 · Bash`, `생각 중`, `답변 작성 중`, `팀원 N명 작업 중`, `응답 대기`, `다음 지시 대기`). 큰 기록을 처음 읽는 동안은 `기록 읽는 중 N%`
- 응답 대기 세션은 맨 위에 배경색으로 보인다. 화면이 작아 표가 잘리면 마지막 줄에 `… +N 세션` 이 나온다.
- 서브에이전트는 메인 세션 아래 `├─` 행으로 붙고, 하는 일(description) 뒤에 타입이 흐리게 붙는다. 첫 응답 전에는 `시작 중`, 끝나면 6초간 `완료`로 보였다가 사라진다.
- COST: Claude API 정가로 환산한 비용. 구독 요금제 사용분도 같은 기준으로 계산한다 (`src/pricing.mjs`). 가격표에 없는 모델이 섞이면 `$1.20?` 처럼 `?` 가 붙는다. Codex 는 OpenAI API 정가로 환산한다 (gpt-5.3-codex, gpt-5.1-codex(-mini), codex-mini, gpt-4o-mini). 값은 2026-11 가격 비교 사이트 기준 추정이며, 세션 중 모델이 바뀌면 마지막 모델 가격으로 계산한다.
- IDLE: 마지막 활동 후 지난 시간. 작업 중이면 `now`.
- 상세 패널의 토큰 합계 = 메인 + 서브에이전트 = 입력 + 출력 + 캐시 읽기 + 캐시 쓰기. 비용은 캐시 제외 금액도 함께 보인다.
- `--all`: 24시간 안에 바뀐 기록을 종료 세션으로 보인다. 본문은 선택했을 때 읽는다.
- 변경 파일: 세션(서브에이전트 포함)이 Edit/Write(Codex 는 apply_patch)로 고친 파일이 있으면 상세 패널 오른쪽 위에 `src/ui.mjs  편집 ×3  14:02` 처럼 편집 횟수와 마지막 시각이 보인다. git diff 가 아니라 이 세션의 편집 기록이다. diff 머리의 `쓴 줄 · 지운 줄` 은 편집마다 더한 누적값이라 최종 변경량과 다르다.
- 지시 탭: `[이번 지시] T5 T3 전체`. 처음에는 마지막 지시 뒤에 고친 파일만 보인다. 편집이 있었던 이전 지시는 `T번호` 탭으로, 세션 전체는 `전체` 탭으로 본다. 서브에이전트 편집은 그 서브에이전트를 부른 지시에 들어간다. lock·빌드 결과 파일은 목록 끝에 흐리게 보인다. 지시는 최근 50개까지 기억한다. 파일을 열면 고친 순서의 역순으로 변경 조각마다 `시각 · 누가 · @@ 위치` 를 붙여 보인다. `.env`, `*.pem` 같은 비밀 파일은 목록에만 보이고 내용은 숨긴다.

## 읽는 곳

| 도구 | 실행 중 판단 | 진행 내용·토큰 |
|---|---|---|
| Claude Code | `~/.claude/sessions/<pid>.json` + `/proc/<pid>` | `~/.claude/projects/*/<sessionId>.jsonl`, `…/subagents/agent-*.jsonl` |
| Codex CLI | `/proc` 의 `codex` 프로세스 작업 폴더 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Gemini CLI | `/proc` 의 `gemini` 프로세스 | 아직 미지원 |

## 알려진 한계

- Linux·WSL 전용 (`/proc` 사용).
- 세션 파일 형식은 각 CLI 의 내부 형식이라, CLI 업데이트로 바뀌면 `src/sources/` 의 해당 파일을 고쳐야 한다.
- 컨텍스트 창 크기는 기록에 없어서 모델별 표(`src/pricing.mjs`)로 정한다. 표에 없는 모델은 200k 를 넘으면 1M 으로 가정한다.
- 같은 폴더에서 codex 를 여러 개 띄우면, 최근에 바뀐 세션 파일부터 순서대로 짝짓는다.
- 토큰 합계에는 캐시 읽기 토큰이 포함된다. 세부 구성은 상세 패널에서 본다.
- 실시간 화면은 한 번 갱신에 기록을 24MB 까지만 읽는다. 아주 큰 기록은 처음 몇 초 동안 합계가 채워지는 중으로 보인다.
- 캐시 폴더 이름에 가격표 지문이 들어가서, 가격표를 바꾼 버전으로 올리면 첫 실행 때 비용을 다시 계산한다.
- 변경 파일은 Edit/Write 도구 결과와 Codex 의 성공한 apply_patch 만 본다. Codex 패치에는 줄 번호가 없어 diff 에 `@@ 문맥` 만 보인다. Bash(`sed`, `git checkout` 등)로 바꾼 파일과 사람이 직접 고친 내용은 빠진다. 파일 60개, 파일당 변경 조각 8개, 세션당 1500줄까지만 보관하고, 넘치면 오래된 조각부터 버린다 (줄 수 통계는 남는다).
- 서브에이전트는 `finished` 표시 없이 끊긴 기록이 남기 때문에, 메인이 결과를 기다리는 중이거나 15분 안에 기록이 바뀐 경우만 실행 중으로 본다.
