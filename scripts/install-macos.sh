#!/usr/bin/env bash
#
# UniEditPlus — macOS 로컬 빌드 & 설치 스크립트
# 릴리스 빌드 후 /Applications 에 UniEditPlus.app 을 설치한다.
#
# 사용법:  ./scripts/install-macos.sh
#
set -euo pipefail

# 프로젝트 루트로 이동 (이 스크립트가 scripts/ 하위에 있다고 가정)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "==> UniEditPlus 로컬 설치 (macOS)"

# 1) 툴체인 확인 — cargo 가 PATH 에 없으면 rustup 환경을 로드
if ! command -v cargo >/dev/null 2>&1; then
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
fi
command -v cargo >/dev/null 2>&1 || {
  echo "❌ cargo(Rust)가 없습니다. https://rustup.rs 에서 설치 후 다시 실행하세요."; exit 1;
}
command -v node >/dev/null 2>&1 || {
  echo "❌ node 가 없습니다. https://nodejs.org 에서 설치 후 다시 실행하세요."; exit 1;
}
echo "    rust:  $(cargo --version)"
echo "    node:  $(node --version)"

# 2) 프론트엔드 의존성
echo "==> 프론트엔드 의존성 설치 (npm install)"
npm install

# 3) 릴리스 빌드 (프론트 타입체크 + 번들 → Rust release → .app/.dmg 번들링)
echo "==> 릴리스 빌드 — 처음이면 수 분 걸립니다"
npm run tauri build

# 4) 산출물 확인
APP_SRC="src-tauri/target/release/bundle/macos/UniEditPlus.app"
if [ ! -d "$APP_SRC" ]; then
  echo "❌ 빌드 산출물을 찾지 못했습니다: $APP_SRC"; exit 1
fi

# 5) /Applications 에 설치
DEST="/Applications/UniEditPlus.app"
echo "==> 설치: $DEST"
rm -rf "$DEST"
cp -R "$APP_SRC" "$DEST"

# 로컬 빌드 앱은 서명이 없어 Gatekeeper 격리 속성이 붙으면 실행이 막힐 수 있어 제거
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

DMG_DIR="src-tauri/target/release/bundle/dmg"
echo ""
echo "✅ 설치 완료"
echo "   앱:  $DEST"
echo "   실행: open \"$DEST\"   (또는 Launchpad/Spotlight 에서 'UniEditPlus')"
if ls "$DMG_DIR"/*.dmg >/dev/null 2>&1; then
  echo "   배포용 DMG: $(ls "$DMG_DIR"/*.dmg | head -1)"
fi
