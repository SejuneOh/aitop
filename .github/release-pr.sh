#!/usr/bin/env bash
# dev -> main release PR 을 만들거나 갱신한다. .github/workflows/release-pr.yml 이 dev 푸시마다 부른다.
# 제목은 dev 의 package.json 버전, 본문은 main 에 아직 없는 병합 PR 목록과 그 PR 들이 닫은 이슈다.
# DRY_RUN=1 이면 만들거나 고치지 않고 제목·라벨·본문만 출력한다 (로컬 확인용).
set -euo pipefail

BASE=${BASE:-main}
HEAD_BRANCH=${HEAD_BRANCH:-dev}

git fetch --quiet origin "$BASE" "$HEAD_BRANCH"
RANGE="origin/$BASE..origin/$HEAD_BRANCH"

# main 에 없는 dev 의 PR 병합 커밋에서 PR 번호를 오래된 순으로 모은다.
mapfile -t PRS < <(git log --merges --reverse --format=%s "$RANGE" | sed -n 's/^Merge pull request #\([0-9][0-9]*\) .*/\1/p')
if [ "${#PRS[@]}" -eq 0 ]; then
  echo "main 에 아직 없는 PR 이 없어 release PR 을 만들지 않는다"
  exit 0
fi

VERSION=$(git show "origin/$HEAD_BRANCH:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')

LINES=()
TITLES=()
CLOSES=()
LABELS=()
for n in "${PRS[@]}"; do
  info=$(gh pr view "$n" --json title,labels,body)
  title=$(jq -r .title <<<"$info")
  LINES+=("- #$n $title")
  TITLES+=("$(sed -E 's/^[a-z]+(\([^)]*\))?: //; s/ \(#[0-9]+\)$//' <<<"$title")")
  # dev 는 기본 브랜치가 아니라 GitHub 가 닫는 이슈를 연결하지 않으므로 본문의 Closes #N 을 읽는다.
  while read -r i; do [ -n "$i" ] && CLOSES+=("$i"); done < <(jq -r .body <<<"$info" | grep -oiE '(close[sd]?|fix(e[sd])?|resolve[sd]?) #[0-9]+' | grep -oE '[0-9]+')
  while read -r l; do [ -n "$l" ] && LABELS+=("$l"); done < <(jq -r '.labels[].name' <<<"$info")
done

# 라벨은 포함된 PR 중 가장 큰 변경 종류 하나 (feat > fix > perf > refactor > ci).
LABEL=""
for want in feat fix perf refactor ci; do
  for l in "${LABELS[@]}"; do
    if [ "$l" = "$want" ]; then LABEL=$want; break 2; fi
  done
done

SUMMARY=""
for t in "${TITLES[@]}"; do SUMMARY+="${SUMMARY:+ / }$t"; done
TITLE="release: v$VERSION $SUMMARY"
if [ "${#TITLE}" -gt 100 ]; then TITLE="${TITLE:0:97}..."; fi

# 이 버전이 이미 태그로 있으면 병합해도 release.yml 이 배포하지 않는다.
if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
  NOTE="- **v$VERSION 은 이미 배포됨.** package.json 버전을 올리기 전에는 main 에 병합해도 테스트만 하고 배포하지 않는다"
else
  NOTE="- main 에 병합하면 release.yml 이 테스트 후 v$VERSION 을 GitHub Packages 에 배포하고 태그·릴리스를 만든다"
fi

BODY=$(
  echo "## 변경"
  printf '%s\n' "${LINES[@]}"
  echo
  echo "## 확인"
  echo "- 각 PR 은 CI 와 리뷰를 거쳐 dev 에 병합됨"
  echo "$NOTE"
  if [ "${#CLOSES[@]}" -gt 0 ]; then
    echo
    printf 'Closes #%s\n' $(printf '%s\n' "${CLOSES[@]}" | sort -un)
  fi
  echo
  echo "_release-pr 워크플로가 dev 병합마다 갱신한다._"
)

if [ "${DRY_RUN:-}" = "1" ]; then
  printf 'title: %s\nlabel: %s\n\n%s\n' "$TITLE" "${LABEL:-(없음)}" "$BODY"
  exit 0
fi

EXISTING=$(gh pr list --base "$BASE" --head "$HEAD_BRANCH" --state open --json number -q '.[0].number // empty')
if [ -n "$EXISTING" ]; then
  gh pr edit "$EXISTING" --title "$TITLE" --body "$BODY" ${LABEL:+--add-label "$LABEL"}
  echo "release PR #$EXISTING 갱신"
else
  gh pr create --base "$BASE" --head "$HEAD_BRANCH" --title "$TITLE" --body "$BODY" ${LABEL:+--label "$LABEL"}
fi
