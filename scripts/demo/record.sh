#!/usr/bin/env bash
# Markdown 라이브 프리뷰 데모 영상 촬영 파이프라인 (macOS 전용).
#
#   ./scripts/demo/record.sh
#
# 산출물: scripts/demo/out/md-preview-v1.mp4 + md-preview-v1-poster.jpg (1400x900)
# 확인 후 site/assets/ 로 복사한다 (이 스크립트는 사이트 자산을 직접 덮어쓰지 않는다).
#
# 사전 요구 — 프런트 터미널 앱에 두 권한이 모두 있어야 한다:
#   * 화면 기록      : 없으면 screencapture가 "could not create image" 로 실패
#   * 손쉬운 사용    : 없으면 osascript가 -1719 로 실패 (창 이동/메뉴/타이핑 전부)
# 이 환경에서 권한 대상은 Tabby가 아니라 실제 프런트 앱(iTerm2)이었다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_DIR="$ROOT/scripts/demo"
OUT_DIR="$DEMO_DIR/out"
BIN="$ROOT/src-tauri/target/release/uninotepad"

WIN_X=60 WIN_Y=60 WIN_W=1400 WIN_H=900
CHAR_DELAY=0.045   # 글자당 지연 — 육안 타이핑 속도
# 줄바꿈 뒤 지연은 반드시 프리뷰 디바운스(200ms, preview.ts:371)보다 커야 한다.
# schedulePreviewRender는 키 입력마다 타이머를 리셋하므로, 이 값이 200ms 아래면
# 타이핑이 이어지는 동안 프리뷰가 한 번도 안 그려지고 단락 쉼에서만 뭉텅이로
# 따라온다 — "치는 대로 렌더된다"는 영상의 핵심이 죽는다(1차 촬영이 그랬다).
LINE_DELAY=0.5
STEP_PAUSE=1.0     # 단락 사이 쉼
TRIM_HEAD=0.8      # 녹화 시작 직후 잘라낼 구간
TRIM_TAIL=2.2      # 마지막 다이어그램을 보여주는 여운

now() { perl -MTime::HiRes=time -e 'printf "%.2f", time'; }

# ---- 가드 1: 실행 중인 UniNotepad 전면 차단 --------------------------------
# 설치본(/Applications)이 떠 있으면 single-instance가 격리 HOME 실행을 가로채고,
# 그대로 촬영하면 사용자의 실제 탭(미저장 문서 포함)이 영상에 박힌다.
# 패턴을 빌드 경로로 좁히지 말 것 — 과거 두 번 그렇게 사고가 났다.
#
# `ps aux | grep -i uninotepad` 는 쓸 수 없다: 이 리포 경로 자체가
# /Users/.../Work/UniNotepad 라서 무관한 프로세스의 커맨드라인까지 걸린다(자기 자신 포함).
# pgrep 은 -f 없이 쓰면 **프로세스 이름만** 본다 — 설치본과 빌드 산출물의 이름이
# 둘 다 `uninotepad` 이므로, 경로로 좁히지 않으면서 오탐도 없다.
if pgrep -il uninotepad; then
  echo "중단: 위 UniNotepad 프로세스를 먼저 종료해 주세요." >&2
  echo "      실행 중이면 single-instance가 격리 HOME 실행을 가로채고," >&2
  echo "      사용자의 실제 탭(미저장 문서 포함)이 그대로 녹화됩니다." >&2
  exit 1
fi

[[ -x "$BIN" ]] || { echo "중단: 릴리즈 바이너리가 없습니다 — npm run tauri build 먼저." >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "중단: ffmpeg 필요." >&2; exit 1; }

mkdir -p "$OUT_DIR"
RAW="$OUT_DIR/raw.mov"
MP4="$OUT_DIR/md-preview-v1.mp4"
POSTER="$OUT_DIR/md-preview-v1-poster.jpg"
rm -f "$RAW" "$MP4" "$POSTER"

# ---- 격리 HOME + 프리뷰가 열린 빈 Untitled 탭 ------------------------------
DEMO_HOME="$("$DEMO_DIR/seed-session.sh")"
echo "격리 HOME: $DEMO_HOME"

HOME="$DEMO_HOME" nohup "$BIN" >/dev/null 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT
sleep 4

# ---- 창 위치·크기 고정 ------------------------------------------------------
osascript <<OSA
tell application "System Events" to tell process "uninotepad"
  set frontmost to true
  set position of window 1 to {$WIN_X, $WIN_Y}
  set size of window 1 to {$WIN_W, $WIN_H}
end tell
OSA
sleep 1

# ---- 가드 2: 창 제목 검증 ---------------------------------------------------
# 격리 HOME이 먹었다면 씨딩한 "Untitled 1" 탭이 떠 있어야 한다.
TITLE="$(osascript -e 'tell application "System Events" to tell process "uninotepad" to get title of window 1')"
case "$TITLE" in
  *Untitled*) : ;;
  *) echo "중단: 창 제목이 예상과 다릅니다 ($TITLE) — 격리 HOME이 적용되지 않았을 수 있습니다." >&2; exit 1 ;;
esac

# ---- 테마 명시 선택 ---------------------------------------------------------
# theme.ts 기본값은 dark지만 격리 HOME에서 light로 뜬 전례가 있다 — 기본값을 믿지 않는다.
osascript <<'OSA'
tell application "System Events" to tell process "uninotepad"
  click menu item "Dark" of menu 1 of menu item "Theme" of menu 1 of menu bar item "View" of menu bar 1
end tell
OSA
sleep 2

# ---- Mermaid 워밍업 ---------------------------------------------------------
# mermaid는 최초 사용 시 lazy import (preview.ts:146-157). 워밍업 없이 찍으면
# 영상의 클라이맥스 직전에 번들 로딩 멈칫이 그대로 들어간다.
osascript "$DEMO_DIR/type.applescript" "$DEMO_DIR/steps/00-warmup.txt" 0.01 0.02
sleep 3.5
osascript -e 'tell application "System Events" to keystroke "a" using command down' \
          -e 'tell application "System Events" to key code 51'
sleep 1.5

# ---- 녹화 시작 --------------------------------------------------------------
# -v 는 Ctrl+C(SIGINT)까지 녹화한다. -V 는 폭주 대비 상한.
screencapture -v -V 120 -x -R"$WIN_X,$WIN_Y,$WIN_W,$WIN_H" "$RAW" &
CAP_PID=$!
T0="$(now)"
sleep 1.2

osascript -e 'tell application "System Events" to tell process "uninotepad" to set frontmost to true'
for step in "$DEMO_DIR"/steps/0[123]-*.txt; do
  osascript "$DEMO_DIR/type.applescript" "$step" "$CHAR_DELAY" "$LINE_DELAY"
  sleep "$STEP_PAUSE"
done

sleep "$TRIM_TAIL"
T1="$(now)"
kill -INT "$CAP_PID" 2>/dev/null || true
wait "$CAP_PID" 2>/dev/null || true
sleep 1

[[ -s "$RAW" ]] || {
  echo "중단: 녹화 파일이 비어 있습니다. SIGINT로 마무리되지 않았다면" >&2
  echo "      screencapture 를 -V<초> 고정 길이로 바꿔 다시 시도하세요." >&2
  exit 1
}

kill "$APP_PID" 2>/dev/null || true
trap - EXIT

# ---- 트림 + 웹 인코딩 -------------------------------------------------------
DUR="$(perl -e "printf '%.2f', $T1 - $T0 - $TRIM_HEAD")"
echo "원본: $(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$RAW")"
echo "트림: start=$TRIM_HEAD duration=$DUR"

ffmpeg -y -v error -ss "$TRIM_HEAD" -i "$RAW" -t "$DUR" \
  -vf "scale=1400:900:flags=lanczos,fps=30" \
  -an -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 26 -preset slow \
  -movflags +faststart "$MP4"

# poster = 마지막 프레임. 정지 상태에서 "완성된 문서"가 보이고, 재생하면 빈
# 화면부터 다시 시작하는 표준 데모 패턴.
ffmpeg -y -v error -sseof -0.3 -i "$MP4" -frames:v 1 -q:v 3 "$POSTER"

echo
echo "완료:"
ls -lh "$MP4" "$POSTER"
echo
echo "다음: 영상을 눈으로 확인한 뒤 site/assets/ 로 복사하세요."
echo "  cp $MP4 $POSTER $ROOT/site/assets/"
