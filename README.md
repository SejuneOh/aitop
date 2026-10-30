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
| 기능 브랜치 → `dev` | PR 마다 CI(테스트) 실행. 병합 후 로컬에서 `npm install -g .` 로 확인 |
| `dev` → `main` | `package.json` 의 `version` 이 아직 배포되지 않은 값이면 GitHub Packages 에 배포하고 `v<버전>` 태그·릴리스 생성 |

버전 올리기는 `dev` 에서 `npm version patch|minor|major --no-git-tag-version` 후 커밋한다. 버전을 올리지 않은 `main` 병합은 테스트만 돌고 배포하지 않는다.

공개 배포로 바꿀 때는 `package.json` 의 `publishConfig.registry` 를 `https://registry.npmjs.org` 로 바꾸고, `release.yml` 에 `NPM_TOKEN` 시크릿과 `--access public` 을 넣는다.

## 사용

```
aitop            실시간 화면
aitop --all      종료된 세션(24시간 이내)도 함께
aitop --once     현재 상태를 한 번 출력
```

| 키 | 동작 |
|---|---|
| ↑↓ / j k | 세션 선택 |
| Enter | 선택한 백그라운드 세션 열기 (`claude attach`). 나오면 aitop 으로 돌아온다 |
| d | 상세 열기·닫기 |
| e | 종료된 세션 보이기·숨기기 |
| q / Esc / Ctrl-C | 나가기 |

## 화면

- STATUS: 지금 단계 (`도구 실행 · Bash`, `생각 중`, `답변 작성 중`, `팀원 N명 작업 중`, `응답 대기`, `다음 지시 대기`). 큰 기록을 처음 읽는 동안은 `기록 읽는 중 N%`
- 응답 대기 세션은 맨 위에 배경색으로 보인다. 화면이 작아 표가 잘리면 마지막 줄에 `… +N 세션` 이 나온다.
- 서브에이전트는 메인 세션 아래 `├─` 행으로 붙고, 하는 일(description) 뒤에 타입이 흐리게 붙는다. 첫 응답 전에는 `시작 중`, 끝나면 6초간 `완료`로 보였다가 사라진다.
- COST: Claude API 정가로 환산한 비용. 구독 요금제 사용분도 같은 기준으로 계산한다 (`src/pricing.mjs`). 가격표에 없는 모델이 섞이면 `$1.20?` 처럼 `?` 가 붙는다. Codex 는 표시하지 않는다.
- IDLE: 마지막 활동 후 지난 시간. 작업 중이면 `now`.
- 상세 패널의 토큰 합계 = 메인 + 서브에이전트 = 입력 + 출력 + 캐시 읽기 + 캐시 쓰기. 비용은 캐시 제외 금액도 함께 보인다.
- `--all`: 24시간 안에 바뀐 기록을 종료 세션으로 보인다. 본문은 선택했을 때 읽는다.

## 읽는 곳

| 도구 | 실행 중 판단 | 진행 내용·토큰 |
|---|---|---|
| Claude Code | `~/.claude/sessions/<pid>.json` + `/proc/<pid>` | `~/.claude/projects/*/<sessionId>.jsonl`, `…/subagents/agent-*.jsonl` |
| Codex CLI | `/proc` 의 `codex` 프로세스 작업 폴더 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Gemini CLI | `/proc` 의 `gemini` 프로세스 | 아직 미지원 |

## 알려진 한계

- Linux·WSL 전용 (`/proc` 사용).
- 세션 파일 형식은 각 CLI 의 내부 형식이라, CLI 업데이트로 바뀌면 `src/sources/` 의 해당 파일을 고쳐야 한다.
- Claude 의 컨텍스트 창 크기는 기록에 없어서 200k 를 넘으면 1M 으로 가정한다.
- 같은 폴더에서 codex 를 여러 개 띄우면, 최근에 바뀐 세션 파일부터 순서대로 짝짓는다.
- 토큰 합계에는 캐시 읽기 토큰이 포함된다. 세부 구성은 상세 패널에서 본다.
- 실시간 화면은 한 번 갱신에 기록을 24MB 까지만 읽는다. 아주 큰 기록은 처음 몇 초 동안 합계가 채워지는 중으로 보인다.
- 캐시 폴더 이름에 가격표 지문이 들어가서, 가격표를 바꾼 버전으로 올리면 첫 실행 때 비용을 다시 계산한다.
- 서브에이전트는 `finished` 표시 없이 끊긴 기록이 남기 때문에, 메인이 결과를 기다리는 중이거나 15분 안에 기록이 바뀐 경우만 실행 중으로 본다.
- 세션 열기는 백그라운드 Claude 세션만 된다. 다른 터미널에서 직접 띄운 세션과 Codex 는 열 수 없다.
