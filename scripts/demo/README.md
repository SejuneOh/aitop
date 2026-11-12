# 데모 GIF

`docs/demo.gif` 는 `demo.tape` 를 [vhs](https://github.com/charmbracelet/vhs) 로 녹화해 만든다. 화면의 세션은 모두 `seed.mjs` 가 임시 폴더에 만든 가짜 기록이고, 실제 `~/.claude`, `~/.codex`, `~/.gemini` 는 읽지 않는다.

다시 만들기 (저장소 맨 위에서, docker 만 있으면 된다):

```sh
docker build -t aitop-demo scripts/demo
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/vhs -w /vhs aitop-demo scripts/demo/demo.tape
```

가짜 화면만 직접 보려면 `node scripts/demo/seed.mjs --lang en` 을 실행한다. `q` 로 끝내면 가짜 프로세스와 임시 폴더를 지운다.
녹화는 컨테이너 안에서 한다. 로컬에서 실행할 때 실제 codex·gemini·agy 프로세스가 돌고 있으면 그 작업 폴더 이름이 화면에 섞일 수 있다 (기록 파일은 읽지 않는다).
`scripts/` 와 `docs/` 는 `package.json` 의 `files` 에 없어 npm 패키지에 들어가지 않는다.
