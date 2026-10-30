# aitop

터미널에서 지금 돌고 있는 AI 코딩 세션(Claude Code · Codex CLI · Gemini CLI)과 진행 내용, 토큰을 실시간으로 보는 읽기 전용 모니터.

- 포트를 열지 않고, 네트워크 요청을 하지 않는다. 각 CLI 가 내 PC 에 남기는 세션 파일만 읽는다.
- 세션 파일은 읽기 전용으로만 연다. 디스크에 쓰는 곳은 읽은 위치·합계를 기억하는 `~/.cache/aitop` 뿐이다 (지워도 된다).
- 화면에 표시되는 텍스트 중 API 키·토큰처럼 보이는 값은 `••••` 로 가린다.
- 외부 라이브러리 없음 (Node 20 이상).

## 설치

```bash
npm install -g .        # 이 폴더를 가리키는 aitop 명령이 생긴다 (npm 레지스트리에 올리지 않음)
aitop
```

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

- STATUS: 지금 단계 (`도구 실행 · Bash`, `생각 중`, `답변 작성 중`, `팀원 N명 작업 중`, `응답 대기`, `다음 지시 대기`)
- 서브에이전트는 메인 세션 아래 `├─` 행으로 붙고, 끝나면 6초간 `완료`로 보였다가 사라진다.
- COST: Claude API 정가로 환산한 비용. 구독 요금제 사용분도 같은 기준으로 계산한다 (`src/pricing.mjs`). Codex 는 표시하지 않는다.

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
- 서브에이전트는 `finished` 표시 없이 끊긴 기록이 남기 때문에, 메인이 결과를 기다리는 중이거나 15분 안에 기록이 바뀐 경우만 실행 중으로 본다.
- 세션 열기는 백그라운드 Claude 세션만 된다. 다른 터미널에서 직접 띄운 세션과 Codex 는 열 수 없다.
