# aitop README 데모 GIF. 다시 만드는 법은 scripts/demo/README.md 를 본다.
# 화면의 세션은 모두 seed.mjs 가 만든 가짜 기록이다. aitop 은 네트워크를 쓰지 않는다.

Output docs/demo.gif

Require node

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1120
Set Height 760
Set Padding 14
Set Framerate 12
Set TypingSpeed 60ms
Set Theme "Catppuccin Mocha"

# 첫 프레임이 빈 터미널이 되지 않게, 실행과 첫 로딩은 숨기고 aitop 화면이 뜬 뒤부터 녹화한다.
# seed.mjs 가 가짜 홈을 만들고 aitop 을 띄운다. AITOP_DEMO_WAIT_MS 뒤 "k8s limits" 세션이 허락을 기다리기 시작한다.
Hide
Type "clear; AITOP_DEMO_WAIT_MS=6000 node scripts/demo/seed.mjs --lang en"
Enter
Sleep 3s
Show

# 여러 세션이 일하는 화면. 곧 한 세션이 기다리기 시작해 맨 위로 올라온다.
Sleep 4.5s

# n: 확인할 다음 세션으로 간다. 상세 패널에 이어 열기 명령(Resume)이 보인다.
Type "n"
Sleep 4s

Hide
Type "q"
Sleep 500ms
