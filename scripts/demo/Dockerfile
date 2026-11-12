# vhs 공식 이미지에는 node 가 없어 같은 Debian(bookworm) 의 node 실행 파일만 옮겨 온다.
FROM node:22.21.1-bookworm-slim AS node
FROM ghcr.io/charmbracelet/vhs:v0.10.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node
