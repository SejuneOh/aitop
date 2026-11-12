# aitop README 데모 GIF. 다시 만드는 법은 scripts/demo/README.md 를 본다.
# 화면의 세션은 모두 seed.mjs 가 만든 가짜 기록이다. aitop 은 네트워크를 쓰지 않는다.

Output docs/demo.gif

Require node

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1120
Set Height 640
Set Padding 14
Set Framerate 12
Set TypingSpeed 60ms
Set Theme "Catppuccin Mocha"

# 첫 프레임이 빈 터미널이 되지 않게, 실행과 첫 로딩은 숨기고 aitop 화면이 뜬 뒤부터 녹화한다.
# seed.mjs 가 가짜 홈을 만들고 aitop 을 띄운다.
Hide
Type "clear; node scripts/demo/seed.mjs --lang en"
Enter
Sleep 3s
Show
Sleep 2.5s

# 세션 고르기
Down
Sleep 1.2s
Down
Sleep 1.2s
Down
Sleep 1.5s

# 정렬 바꾸기
Type "s"
Sleep 2s

# 끝난 세션도 보기
Type "e"
Sleep 2.5s

Type "q"
Sleep 500ms
