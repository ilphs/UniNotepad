#!/usr/bin/env bash
# 리허설 도중 앱 창이 앞에서 밀려나는 지점을 찾는 진단 (녹화 없음, 약 30초).
#
#   ./scripts/demo/probe-focus.sh
#
# 단계마다 (1) 최상위 앱 이름 (2) 창 영역 캡처를 남긴다. 2026-08-11 촬영에서
# 워밍업 타이핑 구간 캡처에 바탕화면이 찍혔다 — 어느 단계에서 앱이 뒤로 밀리는지
# 추측하지 말고 기록으로 잡는다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_DIR="$ROOT/scripts/demo"
OUT_DIR="$DEMO_DIR/out/focus"
BIN="$ROOT/src-tauri/target/release/uninotepad"

WIN_X=60 WIN_Y=60 WIN_W=1400 WIN_H=900
CHIP_TYPE_X=1265 CHIP_TYPE_Y=891
MENU_X=1240 MENU_MD_Y=485
EDITOR_X=350 EDITOR_Y=300

front() { osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>&1; }
geom() {
  osascript <<'OSA' 2>&1
tell application "System Events" to tell process "uninotepad"
  set n to count of windows
  if n = 0 then return "windows=0"
  return "windows=" & n & " pos=" & (position of window 1 as text) & " size=" & (size of window 1 as text)
end tell
OSA
}
mark() { # <라벨>
  printf '%-28s front=%-12s %s\n' "$1" "$(front)" "$(geom)"
  screencapture -x -R"$WIN_X,$WIN_Y,$WIN_W,$WIN_H" "$OUT_DIR/$1.png"
  # 창 영역이 바탕화면으로 찍힐 때 "창이 어디로 갔는지"를 보려면 화면 전체가 필요하다.
  screencapture -x "$OUT_DIR/$1-FULL.png"
}
click() { osascript -l JavaScript "$DEMO_DIR/click.js" $((WIN_X + $1)) $((WIN_Y + $2)); }

pgrep -il uninotepad && { echo "중단: UniNotepad를 먼저 종료하세요." >&2; exit 1; }
rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"

DEMO_HOME="$("$DEMO_DIR/seed-session.sh")"
HOME="$DEMO_HOME" nohup "$BIN" >/dev/null 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT
sleep 4

osascript <<OSA
tell application "System Events" to tell process "uninotepad"
  set frontmost to true
  set position of window 1 to {$WIN_X, $WIN_Y}
  set size of window 1 to {$WIN_W, $WIN_H}
end tell
OSA
sleep 1
mark 01-after-position

osascript <<'OSA'
tell application "System Events" to tell process "uninotepad"
  click menu item "Dark" of menu 1 of menu item "Theme" of menu 1 of menu bar item "View" of menu bar 1
end tell
OSA
sleep 2
mark 02-after-theme

click "$CHIP_TYPE_X" "$CHIP_TYPE_Y"; sleep 1
mark 03-after-chip-click-1
click "$CHIP_TYPE_X" "$CHIP_TYPE_Y"; sleep 1
mark 04-after-chip-click-2
click "$MENU_X" "$MENU_MD_Y"; sleep 1.5
mark 05-after-pick-markdown

click "$EDITOR_X" "$EDITOR_Y"; sleep 0.6
mark 06-after-editor-click

# 워밍업 원고를 한 줄씩 나눠 치며 매 줄 뒤에 상태를 남긴다 — 창이 어느 글자에서
# 사라지는지 좁힌다.
i=0
while IFS= read -r line; do
  i=$((i + 1))
  printf '%s\n' "$line" > "$OUT_DIR/line-$i.txt"
  osascript "$DEMO_DIR/type.applescript" "$OUT_DIR/line-$i.txt" 0.02 0.05
  mark "07-typed-line-$i"
done < "$DEMO_DIR/steps/00-warmup.txt"
sleep 4
mark 08-after-mermaid-wait

kill "$APP_PID" 2>/dev/null || true
trap - EXIT
echo "완료: $OUT_DIR"
