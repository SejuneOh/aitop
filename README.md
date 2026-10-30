# aitop

터미널에서 지금 돌고 있는 AI 코딩 세션(Claude Code · Codex CLI · Gemini CLI)과 진행 내용, 토큰을 실시간으로 보는 읽기 전용 모니터.

- 포트를 열지 않고, 네트워크 요청을 하지 않는다. 각 CLI 가 내 PC 에 남기는 세션 파일만 읽는다.
- 세션 파일은 읽기 전용으로만 연다.
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
| Enter | 상세 열기·닫기 |
| e | 종료된 세션 보이기·숨기기 |
| q / Esc / Ctrl-C | 나가기 |

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
