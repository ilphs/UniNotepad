#!/usr/bin/env bash
#
# release.sh — UniNotepad 원스텝 릴리스 스크립트
#
# 하는 일:
#   1. 버전 범프 (package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml)
#   2. 변경사항 커밋
#   3. 현재 브랜치 push
#   4. 주석 태그 vX.Y.Z 생성 + push
#   5. 태그 push가 .github/workflows/release.yml(CI)를 트리거 →
#      CI가 macOS(arm64/x86_64)·Windows·Linux 바이너리를 빌드하고
#      GitHub Release를 생성해 에셋으로 첨부한다.
#
#   ※ 크로스플랫폼 바이너리는 GitHub Actions에서 빌드되므로 릴리스 자체는
#      스크립트가 만들지 않는다(tauri-action과의 중복 생성을 피하기 위함).
#
# 사용법:
#   ./release.sh <버전>        예) ./release.sh 0.3.0
#   ./release.sh patch|minor|major   현재 버전에서 자동 증가
#   옵션:
#     -y, --yes     확인 프롬프트 건너뛰기
#     --watch       태그 push 후 CI 빌드 진행 상황을 따라가기(gh run watch)
#     -h, --help    도움말
#
set -euo pipefail

# ── 저장소 루트로 이동 (스크립트 위치 기준) ─────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
cd "$SCRIPT_DIR"

# ── 출력 헬퍼 ───────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi
info()  { printf '%s\n' "${C_BLUE}▶${C_RESET} $*"; }
ok()    { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn()  { printf '%s\n' "${C_YELLOW}!${C_RESET} $*"; }
die()   { printf '%s\n' "${C_RED}✗ $*${C_RESET}" >&2; exit 1; }

usage() {
  sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# ── 인자 파싱 ───────────────────────────────────────────────────────────
ASSUME_YES=0
WATCH=0
BUMP=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes)   ASSUME_YES=1 ;;
    --watch)    WATCH=1 ;;
    -h|--help)  usage 0 ;;
    -*)         die "알 수 없는 옵션: $arg (도움말: -h)" ;;
    *)          [ -z "$BUMP" ] && BUMP="$arg" || die "인자가 너무 많습니다: $arg" ;;
  esac
done
[ -n "$BUMP" ] || { warn "버전 또는 patch|minor|major 를 지정하세요."; usage 1; }

# ── 사전 점검 ───────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git 이 필요합니다."
command -v gh  >/dev/null 2>&1 || die "GitHub CLI(gh) 가 필요합니다: https://cli.github.com"
command -v npm >/dev/null 2>&1 || die "npm 이 필요합니다."
command -v node >/dev/null 2>&1 || die "node 가 필요합니다."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "git 저장소가 아닙니다."
gh auth status >/dev/null 2>&1 || die "gh 로그인이 필요합니다: gh auth login"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  warn "현재 브랜치가 '$BRANCH' 입니다(기본: main)."
fi

# ── 현재 버전 읽기 & 새 버전 계산 ───────────────────────────────────────
CURRENT="$(node -p "require('./package.json').version")"
[ -n "$CURRENT" ] || die "package.json 에서 현재 버전을 읽지 못했습니다."

case "$BUMP" in
  major|minor|patch)
    IFS=. read -r MAJ MIN PAT <<EOF
$CURRENT
EOF
    case "$BUMP" in
      major) VERSION="$((MAJ + 1)).0.0" ;;
      minor) VERSION="${MAJ}.$((MIN + 1)).0" ;;
      patch) VERSION="${MAJ}.${MIN}.$((PAT + 1))" ;;
    esac
    ;;
  [0-9]*.[0-9]*.[0-9]*)
    VERSION="$BUMP"
    ;;
  *)
    die "버전 형식이 올바르지 않습니다: '$BUMP' (예: 0.3.0 또는 patch|minor|major)"
    ;;
esac

# semver 형태 최종 검증
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || die "유효하지 않은 버전: $VERSION"

TAG="v$VERSION"

# ── 태그 중복 확인 ──────────────────────────────────────────────────────
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "로컬 태그 $TAG 이(가) 이미 존재합니다."
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  die "원격 태그 $TAG 이(가) 이미 존재합니다."
fi

# ── 계획 요약 & 확인 ────────────────────────────────────────────────────
echo
info "${C_BOLD}릴리스 계획${C_RESET}"
echo "  현재 버전 : $CURRENT"
echo "  새 버전   : ${C_BOLD}$VERSION${C_RESET}  (태그 $TAG)"
echo "  브랜치    : $BRANCH → origin"
echo
info "커밋될 변경사항:"
git status --short || true
echo

if [ "$ASSUME_YES" -ne 1 ]; then
  printf '%s' "진행할까요? [y/N] "
  read -r REPLY </dev/tty
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) die "취소되었습니다." ;;
  esac
fi

# ── in-place 파일 치환 헬퍼(GNU/BSD sed 모두 호환) ─────────────────────
sed_inplace() {
  local expr="$1" file="$2" tmp
  tmp="$(mktemp)"
  sed -E "$expr" "$file" > "$tmp" && mv "$tmp" "$file"
}

# ── 1) 버전 범프 ────────────────────────────────────────────────────────
info "버전 범프 → $VERSION"

# package.json (+ package-lock.json) : npm 이 안전하게 갱신
npm version --no-git-tag-version --allow-same-version "$VERSION" >/dev/null

# src-tauri/tauri.conf.json : "version": "..." (파일 내 유일)
sed_inplace 's/("version"[[:space:]]*:[[:space:]]*")[0-9]+\.[0-9]+\.[0-9]+(")/\1'"$VERSION"'\2/' \
  src-tauri/tauri.conf.json

# src-tauri/Cargo.toml : [package] 의 version (줄 시작 anchor 로 의존성 version 제외)
sed_inplace 's/^version = "[0-9]+\.[0-9]+\.[0-9]+"/version = "'"$VERSION"'"/' \
  src-tauri/Cargo.toml

# Cargo.lock 의 패키지 버전도 동기화(빌드 시 자동 갱신되지만 미리 반영)
if [ -f src-tauri/Cargo.lock ]; then
  ( cd src-tauri && cargo update -p uninotepad --precise "$VERSION" >/dev/null 2>&1 ) || true
fi

ok "버전 파일 갱신 완료"

# ── 2) 커밋 ─────────────────────────────────────────────────────────────
git add -A
if git diff --cached --quiet; then
  warn "커밋할 변경사항이 없습니다(버전이 이미 반영됨). 태그만 생성합니다."
else
  git commit -m "[Release] $TAG 버전 범프"
  ok "커밋 완료: [Release] $TAG 버전 범프"
fi

# ── 3) 브랜치 push ──────────────────────────────────────────────────────
info "origin/$BRANCH push"
git push origin "$BRANCH"
ok "브랜치 push 완료"

# ── 4) 태그 생성 & push ─────────────────────────────────────────────────
info "태그 $TAG 생성 & push"
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
ok "태그 push 완료 → CI(release.yml) 트리거됨"

# ── 5) 결과 안내 / CI 추적 ──────────────────────────────────────────────
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo '')"
echo
ok "${C_BOLD}릴리스 트리거 완료: $TAG${C_RESET}"
echo "  GitHub Actions 가 전 플랫폼 바이너리를 빌드하고 Release 에 첨부합니다."
[ -n "$REPO" ] && {
  echo "  • Actions : https://github.com/$REPO/actions"
  echo "  • Release : https://github.com/$REPO/releases/tag/$TAG"
}

if [ "$WATCH" -eq 1 ]; then
  echo
  info "CI 빌드 진행 상황을 추적합니다(gh run watch)…"
  # 태그 push 로 시작된 워크플로 run 이 등록될 때까지 잠시 대기
  RUN_ID=""
  for _ in 1 2 3 4 5 6; do
    RUN_ID="$(gh run list --workflow=release.yml --limit 1 \
      --json databaseId -q '.[0].databaseId' 2>/dev/null || echo '')"
    [ -n "$RUN_ID" ] && break
    sleep 5
  done
  if [ -n "$RUN_ID" ]; then
    gh run watch "$RUN_ID" --exit-status || warn "CI 빌드가 실패했거나 취소되었습니다. Actions 페이지를 확인하세요."
  else
    warn "워크플로 run 을 찾지 못했습니다. Actions 페이지에서 직접 확인하세요."
  fi
fi
