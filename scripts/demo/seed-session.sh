#!/usr/bin/env bash
# 데모 녹화용 격리 HOME을 만들고 session.json을 심는다.
#
# 목적: **평문(Normal) 상태의 빈 Untitled 탭**으로 앱을 띄우는 것. 영상은 여기서
# 시작해 상태바 파일타입 픽커로 Markdown을 고르고, 그 선택이 프리뷰를 여는
# 장면(src/tabs.ts:300-303 — markdown|mermaid를 고르면 previewVisible=true)을 보여준다.
#
# v1은 프리뷰가 열린 상태를 세션에 심어 클릭 자체를 피했지만, v2는 픽커 조작이
# 시나리오의 일부다. 클릭은 CGEvent 합성으로 해결한다(click.js) — 세션 씨딩은
# "빈 Untitled 하나만 있는 깨끗한 시작 상태"를 만드는 역할로 남는다.
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
#   fileType: "normal"    → 평문으로 시작. isPreviewCapable()이 markdown|mermaid만
#                           허용하므로(preview.ts:174-180) 프리뷰 칩도 창도 없다 —
#                           영상의 첫 장면인 "편집기 전체 폭"이 여기서 나온다.
#   previewVisible: false → 위와 같은 이유로 어차피 무시되지만, 시작 상태를 명시한다.
#   previewRatio: 0.5     → Markdown을 고른 뒤 열릴 분할 비율.
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
      "fileType": "normal",
      "diskMtimeMs": null,
      "largeFile": false,
      "cursor": 0,
      "scrollTop": 0,
      "previewRatio": 0.5,
      "editorFontSize": 15,
      "previewZoomExp": 0,
      "editorVisible": true,
      "previewVisible": false
    }
  ]
}
JSON

echo "$DEMO_HOME"
