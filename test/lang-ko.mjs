// npm test 가 쓰는 언어 고정. cmd.exe 에서는 'AITOP_LANG=ko node …' 꼴이 안 되므로 여기서 정한다.
// node --import 로 먼저 불러, 테스트 파일을 돌리는 자식 프로세스도 이 값을 물려받는다.
process.env.AITOP_LANG = 'ko';
// Claude Desktop Cowork 앱 폴더(#304, WSL 이면 /mnt/c 의 실제 앱 폴더)를 읽지 않게 한다. Cowork 를 보는 테스트는 가짜 폴더로 덮어쓴다.
process.env.AITOP_COWORK_HOME ??= 'off';
