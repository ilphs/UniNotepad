#!/usr/bin/env bash
# 데모 녹화용 격리 HOME을 만들고 session.json을 심는다.
#
# 목적: Markdown 프리뷰가 이미 열린 빈 Untitled 탭으로 앱을 띄우는 것.
# 프리뷰 분할 상태는 탭별로 세션에 저장되므로(src/session.ts:85-89, 170-176)
# 여기서 미리 써 두면 녹화 중에 Cmd+Shift+M을 누를 필요가 없다 — 이 프로젝트의
# "마우스 클릭 자동화 불가"와 "CM6가 accelerator를 가로챔" 제약을 통째로 피한다.
#
# 사용자의 실제 세션(~/Library/Application Support/com.uninotepad.app)은 건드리지
# 않는다. 격리 성공 여부는 창이 지정한 크기로 뜨는지로 확인한다.

set -euo pipefail

DEMO_HOME="${DEMO_HOME:-/tmp/uninotepad-demo-home}"
APP_DIR="$DEMO_HOME/Library/Application Support/com.uninotepad.app"

rm -rf "$DEMO_HOME"
mkdir -p "$APP_DIR/backups"

TAB_ID="$(uuidgen)"

# 스키마는 src/session.ts buildManifest() 기준 (MANIFEST_VERSION = 1).
#   path: null            → Untitled. 내용은 backups/<id>.txt 에만 존재하고,
#                           백업이 없으면 빈 문서로 복원된다(session.ts:203-208).
#   fileType: "markdown"  → 확장자 없는 Untitled 탭에 프리뷰 자격을 준다.
#                           isPreviewCapable()이 markdown|mermaid만 허용(preview.ts:174-180).
#   previewVisible: true  → 프리뷰 창을 연 채로 시작.
#   previewRatio: 0.5     → 좌우 반반.
#   hasBackup: false      → 빈 문서로 시작(백업 파일 자체를 만들지 않는다).
cat > "$APP_DIR/session.json" <<JSON
{
  "version": 1,
  "activeTabId": "$TAB_ID",
  "nextUntitled": 2,
  "tabs": [
    {
      "id": "$TAB_ID",
      "path": null,
      "title": "Untitled 1",
      "dirty": false,
      "hasBackup": false,
      "encoding": "utf8",
      "eol": "lf",
      "fileType": "markdown",
      "diskMtimeMs": null,
      "largeFile": false,
      "cursor": 0,
      "scrollTop": 0,
      "previewRatio": 0.5,
      "editorFontSize": 15,
      "previewZoomExp": 0,
      "editorVisible": true,
      "previewVisible": true
    }
  ]
}
JSON

echo "$DEMO_HOME"
