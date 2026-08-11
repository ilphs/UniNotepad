#!/usr/bin/env bash
# 상태바 파일타입 픽커의 실측 좌표를 구한다 (녹화 없음, 약 20초).
#
#   ./scripts/demo/probe-picker.sh
#
# 왜 실측인가: 픽커 팝업은 상태바 위쪽에 **바닥 기준**으로 붙는다
# (statusbar.ts openPicker: top = anchor.top - menuHeight - 4). 항목이 17개라
# 항목 높이를 1px만 잘못 잡아도 팝업 전체가 17px 밀린다 — "Markdown"(위에서 두 번째)
# 좌표를 계산으로 맞추려 하면 ±30px 오차가 난다. 한 번 찍어서 눈으로 재는 편이 싸다.
#
# 산출물: out/probe/01-normal.png (평문 상태 상태바), 02-picker.png (팝업 열림)
# 좌표는 창 기준(0,0 = 창 좌상단)으로 읽으면 된다 — 캡처 영역이 곧 창이다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_DIR="$ROOT/scripts/demo"
OUT_DIR="$DEMO_DIR/out/probe"
BIN="$ROOT/src-tauri/target/release/uninotepad"

WIN_X=60 WIN_Y=60 WIN_W=1400 WIN_H=900
# 파일타입 칩 추정 좌표(창 기준). 칩 텍스트의 오른쪽 끝은 타입과 무관하게 고정이고
# (오른쪽 정렬), "Normal"은 "Markdown"보다 짧아 중심이 약간 오른쪽이다.
CHIP_TYPE_X=1265 CHIP_TYPE_Y=891

# ---- 가드: 실행 중인 UniNotepad 전면 차단 (record.sh와 동일한 이유) ----------
if pgrep -il uninotepad; then
  echo "중단: 위 UniNotepad 프로세스를 먼저 종료해 주세요." >&2
  exit 1
fi
[[ -x "$BIN" ]] || { echo "중단: 릴리즈 바이너리가 없습니다 — npm run tauri build 먼저." >&2; exit 1; }

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

TITLE="$(osascript -e 'tell application "System Events" to tell process "uninotepad" to get title of window 1')"
case "$TITLE" in
  *Untitled*) : ;;
  *) echo "중단: 창 제목이 예상과 다릅니다 ($TITLE)." >&2; exit 1 ;;
esac

osascript <<'OSA'
tell application "System Events" to tell process "uninotepad"
  click menu item "Dark" of menu 1 of menu item "Theme" of menu 1 of menu bar item "View" of menu bar 1
end tell
OSA
sleep 2

screencapture -x -R"$WIN_X,$WIN_Y,$WIN_W,$WIN_H" "$OUT_DIR/01-normal.png"

osascript -l JavaScript "$DEMO_DIR/click.js" $((WIN_X + CHIP_TYPE_X)) $((WIN_Y + CHIP_TYPE_Y))
sleep 1
screencapture -x -R"$WIN_X,$WIN_Y,$WIN_W,$WIN_H" "$OUT_DIR/02-picker.png"

# 팝업이 안 열렸을 수 있다 — 첫 CGEvent 클릭이 창 활성화만 먹는 사례가 있었다.
# 한 번 더 눌러 보고 따로 남긴다.
osascript -l JavaScript "$DEMO_DIR/click.js" $((WIN_X + CHIP_TYPE_X)) $((WIN_Y + CHIP_TYPE_Y))
sleep 1
screencapture -x -R"$WIN_X,$WIN_Y,$WIN_W,$WIN_H" "$OUT_DIR/03-picker-2nd.png"

kill "$APP_PID" 2>/dev/null || true
trap - EXIT

echo "완료: $OUT_DIR"
ls -1 "$OUT_DIR"
