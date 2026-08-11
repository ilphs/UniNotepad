#!/usr/bin/env bash
# Markdown 라이브 프리뷰 데모 영상 촬영 파이프라인 v2 (macOS 전용).
#
#   ./scripts/demo/probe-picker.sh   # 최초 1회 — 픽커 좌표 실측 (아래 MENU_* 채우기)
#   ./scripts/demo/record.sh
#
# 산출물: scripts/demo/out/md-preview-v2.mp4 + md-preview-v2-poster.jpg (1400x900)
# 확인 후 site/assets/ 로 복사한다 (이 스크립트는 사이트 자산을 직접 덮어쓰지 않는다).
#
# v2 시나리오: 평문 Untitled → 상태바 픽커에서 Markdown 선택(프리뷰 등장) →
#              마크다운 + 확장된 Mermaid 작성 → 편집창 닫기/다시 열기.
#
# 사전 요구 — 프런트 터미널 앱에 두 권한이 모두 있어야 한다:
#   * 화면 기록      : 없으면 screencapture가 "could not create image" 로 실패
#   * 손쉬운 사용    : 없으면 osascript가 -1719 로 실패 (창 이동/메뉴/타이핑/클릭 전부)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_DIR="$ROOT/scripts/demo"
OUT_DIR="$DEMO_DIR/out"
STATE_DIR="$OUT_DIR/state"     # 사전 리허설의 검증용 스냅샷
BIN="$ROOT/src-tauri/target/release/uninotepad"

WIN_X=60 WIN_Y=60 WIN_W=1400 WIN_H=900

# ---- 클릭 좌표 (창 기준: 0,0 = 창 좌상단) ----------------------------------
# 상태바 칩은 오른쪽 정렬이라 **텍스트의 오른쪽 끝**이 고정이고 라벨 길이에 따라
# 왼쪽 끝만 움직인다. 아래 x는 "Normal"/"Markdown", "Editor 107%"/"Editor off"
# 양쪽 상태에서 모두 칩 안에 들어오는 지점으로 잡았다.
CHIP_TYPE_X=1265   CHIP_TYPE_Y=891    # 파일타입 칩
CHIP_EDITOR_X=1080 CHIP_EDITOR_Y=891  # "Editor NNN%" / "Editor off" 칩
EDITOR_X=350       EDITOR_Y=300       # 편집창 포커스 복구용 클릭 지점
# 픽커 팝업은 상태바 위에 **바닥 기준**으로 붙는다(statusbar.ts openPicker):
# top = anchor.top - menuHeight - 4. 항목이 17개라 항목 높이 1px 오차가 팝업 전체를
# 17px 밀어 버린다 — 계산하지 말고 probe-picker.sh 로 실측해 채운다.
# 2026-08-11 실측(out/probe/03-picker-2nd.png): 팝업 x 1134–1294, 항목 높이 25px,
# Normal 460 / Markdown 485 / Mermaid 510 … YAML 860.
MENU_X=1240
MENU_MD_Y=485      # 픽커의 "Markdown" 행 y (위에서 두 번째)
MENU_NORMAL_Y=460  # 픽커의 "Normal" 행 y (맨 위) — 리허설 후 시작 상태 복원용

# 포인터 대피 지점(화면 절대좌표). 상태바 칩에는 title 툴팁이 달려 있어
# (statusbar.ts paneChip) 포인터를 올려둔 채 기다리면 영상에 툴팁이 뜬다.
PARK_X=$((WIN_X + WIN_W + 60)) PARK_Y=$((WIN_Y + 500))

# ---- 타이밍 ----------------------------------------------------------------
CHAR_DELAY=0.038        # 산문 타이핑 속도 — 육안으로 읽히는 속도
CHAR_DELAY_CODE=0.024   # 코드(mermaid)는 조금 빠르게. 12줄을 산문 속도로 치면 10초가 넘는다.
# 줄바꿈 뒤 지연은 반드시 프리뷰 디바운스(200ms, preview.ts:365-374)보다 커야 한다.
# schedulePreviewRender는 키 입력마다 타이머를 리셋하므로, 이 값이 200ms 아래면
# 타이핑이 이어지는 동안 프리뷰가 한 번도 안 그려지고 단락 쉼에서만 뭉텅이로
# 따라온다 — "치는 대로 렌더된다"는 영상의 핵심이 죽는다(1차 촬영이 그랬다).
LINE_DELAY=0.5
LINE_DELAY_CODE=0.32
STEP_PAUSE=0.7          # 단락 사이 쉼
HOLD_DIAGRAM=1.5        # 다이어그램이 그려진 뒤 여운
HOLD_EDITOR_OFF=2.6     # 편집창을 닫고 프리뷰 단독을 보여주는 구간
HOLD_END=2.0            # 편집창 복귀 후 마지막 정지 (= poster 프레임)
TRIM_HEAD=0.8           # 녹화 시작 직후 잘라낼 구간

now() { perl -MTime::HiRes=time -e 'printf "%.2f", time'; }

# ---- 도우미 ----------------------------------------------------------------
# 창 기준 좌표를 클릭한다. 세 번째 인자가 park 면 클릭 뒤 포인터를 창 밖으로 뺀다.
click() {
  local x=$((WIN_X + $1)) y=$((WIN_Y + $2))
  if [[ "${3:-}" == park ]]; then
    osascript -l JavaScript "$DEMO_DIR/click.js" "$x" "$y" "$PARK_X" "$PARK_Y"
  else
    osascript -l JavaScript "$DEMO_DIR/click.js" "$x" "$y"
  fi
}
park_pointer() { osascript -l JavaScript "$DEMO_DIR/click.js" --move "$PARK_X" "$PARK_Y"; }
# 접근성(AX) 메뉴 조작 직후의 **첫 CGEvent 클릭은 창 활성화로 흡수되어** DOM click이
# 되지 않는다 (2026-08-11 프로브에서 확인: 파일타입 칩이 hover만 걸리고 팝업이 안 열림,
# 두 번째 클릭에서 열렸다). 빈 편집창을 한 번 눌러 그 몫을 대신 소비시킨다 — 빈
# 문서라 커서 위치도 바뀌지 않는다.
prime_click() { click "$EDITOR_X" "$EDITOR_Y"; sleep 0.4; }
# 편집창에 포커스를 준다. 두 번 누르는 이유는 위와 같다 — 한 번이 흡수되면 타이핑이
# 아무 데도 들어가지 않는다. 빈 문서에서는 두 번 눌러도 커서 위치가 그대로고,
# click.js가 clickState=1로 보내므로 더블클릭(단어 선택)으로 합쳐지지도 않는다.
focus_editor() {
  click "$EDITOR_X" "$EDITOR_Y"; sleep 0.6
  click "$EDITOR_X" "$EDITOR_Y"; sleep 0.5
}
# 상태바 칩을 누르기 직전에 편집기 포커스를 떼어 둔다.
#
# 편집기에 포커스가 있는 동안 상태바를 누르면 **첫 클릭이 blur로 소모되어** 칩의
# click 핸들러까지 가지 않는다(2026-08-11 촬영 로그: 편집기 포커스 상태에서 누른
# "픽커 열기"·"편집창 닫기"는 두 번째 클릭에 반응했고, 포커스가 이미 빠져 있던
# "Markdown 선택"·"편집창 다시 열기"는 한 번에 반응했다). 그대로 두면 재클릭까지
# 2초쯤 정지 화면이 남아 영상이 굼떠 보인다.
#
# 탭 바의 빈 자리는 클릭 핸들러가 없어(tabs.ts는 탭 요소에만 건다) 눌러도 아무 일이
# 없고, 포커스만 걷어 간다 — 흡수될 클릭을 여기서 대신 소모시킨다.
TABBAR_X=600 TABBAR_Y=49
blur_editor() { click "$TABBAR_X" "$TABBAR_Y"; sleep 0.35; }
# 창 기준 영역을 캡처한다: shot_raw <파일> <x> <y> <w> <h>
shot_raw() { screencapture -x -R"$((WIN_X + $2)),$((WIN_Y + $3)),$4,$5" "$1"; }

# 캡처가 **창을 담았는지** 확인하고, 아니면 다시 찍는다.
#
# screencapture 정지 캡처는 간헐적으로 창을 제외한 바탕화면만 돌려준다(화면 기록
# 권한을 세션 도중 부여했을 때의 증상으로 보인다). 2026-08-11 촬영에서 이것 때문에
# "편집창이 닫혔다"고 오판해 리허설이 엉뚱한 곳에서 통과·실패했다. AX는 창이 계속
# (60,60) 1400×900에 있다고 보고했고 같은 시각의 **영상 녹화에는 창이 정상적으로
# 찍혔다** — 즉 창이 사라진 게 아니라 정지 캡처만 틀렸다.
#
# 판정은 타이틀바 **밝기**로 한다. 픽셀 비교로 하면 안 된다 — 문서가 수정되는 순간
# 제목 앞에 수정됨 표시(●)가 붙어 픽셀이 크게 달라진다(실제로 오판해서 촬영이
# 중단됐다). 밝기는 그 변화에 둔감하고(71.99 → 72.26) 창이 빠진 캡처(벽지, ~200)와는
# 확실히 갈린다.
TITLEBAR=(0 0 240 22)
TB_BASE_Y=""   # capture_baseline() 이 채운다
shot() {
  local out="$1"; shift
  local i v
  for i in 1 2 3 4 5; do
    shot_raw "$out" "$@"
    [[ -z "$TB_BASE_Y" ]] && return 0
    shot_raw "$STATE_DIR/tb-now.png" "${TITLEBAR[@]}"
    v="$(yavg_of "$STATE_DIR/tb-now.png")"
    if awk -v v="${v:-255}" -v b="$TB_BASE_Y" 'BEGIN { d = v - b; if (d < 0) d = -d; exit !(d < 30) }'; then
      [[ "$i" -gt 1 ]] && echo "  (캡처 재시도 ${i}회)"
      return 0
    fi
    sleep 0.5
  done
  echo "중단: 화면 캡처에 앱 창이 담기지 않습니다 (5회 재시도 실패)." >&2
  echo "      화면 기록 권한이 이 터미널 앱에 제대로 적용되지 않은 상태입니다." >&2
  echo "      터미널 앱을 완전히 종료했다가 다시 실행한 뒤 재시도하세요." >&2
  exit 1
}
capture_baseline() {
  local f="$STATE_DIR/tb-base.png" i v
  for i in 1 2 3 4 5; do
    shot_raw "$f" "${TITLEBAR[@]}"
    # 기준 프레임 자체가 바탕화면이면 이후 판정이 통째로 뒤집힌다. 앱은 다크 테마라
    # 타이틀바가 어둡고(측정 ~45–65), 창이 빠진 캡처는 밝은 벽지가 찍힌다.
    v="$(yavg_of "$f")"
    if awk -v v="${v:-255}" 'BEGIN { exit !(v < 120) }'; then
      TB_BASE_Y="$v"; return 0
    fi
    sleep 0.6
  done
  echo "중단: 기준 캡처에 앱 창이 담기지 않습니다 (밝기 ${v:-?})." >&2
  echo "      화면 기록 권한이 이 터미널 앱에 제대로 적용되지 않은 상태입니다." >&2
  echo "      터미널 앱을 완전히 종료했다가 다시 실행한 뒤 재시도하세요." >&2
  exit 1
}
yavg_of() {
  ffmpeg -hide_banner -i "$1" \
    -lavfi "format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" \
    -f null - 2>/dev/null | sed -n 's/^lavfi\.signalstats\.YAVG=//p' | head -1
}
# 리허설이 실패했을 때 "무엇이 화면에 있었는지"를 남긴다 — 차이값만으로는 팝업이
# 안 열린 것인지 항목을 빗맞힌 것인지 구분할 수 없다.
shot_full() { screencapture -x -R"$WIN_X,$WIN_Y,$WIN_W,$WIN_H" "$STATE_DIR/full-$1.png"; }

# 두 이미지의 평균 밝기 차이(0=동일). metadata 필터는 file=- 를 줘야 표준출력으로 나온다.
yavg_diff() {
  ffmpeg -hide_banner -i "$1" -i "$2" \
    -lavfi "blend=all_mode=difference,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" \
    -f null - 2>/dev/null | sed -n 's/^lavfi\.signalstats\.YAVG=//p' | head -1
}
# 화면이 기대대로 바뀌었는지 검증한다. 클릭이 빗나가면 영상이 통째로 헛것이 되므로
# 녹화 전에 리허설로 전부 확인하고, 어긋나면 촬영을 시작조차 하지 않는다.
assert_changed() { # <before> <after> <최소차이> <설명>
  local d; d="$(yavg_diff "$1" "$2")"
  awk -v d="${d:-0}" -v t="$3" 'BEGIN { exit !(d > t) }' || {
    echo "중단: $4 — 화면이 바뀌지 않았습니다 (차이 ${d:-0} <= $3)." >&2
    echo "      좌표가 어긋났을 수 있습니다. probe-picker.sh 로 다시 실측하세요." >&2
    echo "      비교 이미지: $1 $2" >&2
    exit 1
  }
}
# 클릭이 실제로 먹을 때까지 다시 누른다.
#   click_until <설명> <x> <y> <검증영역 x> <y> <w> <h> [park]
#
# CGEvent 클릭은 **첫 번째가 창 활성화/hover로 흡수되는 일이 잦다** (2026-08-11 확인:
# 파일타입 칩이 하이라이트만 되고 팝업이 안 열렸다. 앞선 편집창 클릭으로 대신
# 소비시키려 했지만 그것만으로는 부족했다). 몇 번 눌러야 하는지를 미리 정하는 대신
# 화면이 바뀌었는지 보고 판단한다 — 정지 캡처는 `screencapture -v` 녹화와 동시에
# 동작하므로(검증 완료) 녹화 중에도 같은 방식을 쓸 수 있다.
#
# 이미 먹은 클릭을 한 번 더 누르는 사고는 나지 않는다: 바뀐 것을 확인하는 즉시 멈춘다.
click_until() {
  local label="$1" x="$2" y="$3" rx="$4" ry="$5" rw="$6" rh="$7" park="${8:-}"
  # 파일명을 점으로 시작하지 말 것 — screencapture가 숨김 파일에는 쓰지 못한다
  # ("cannot write file to intended destination").
  local before="$STATE_DIR/cu-before.png" after="$STATE_DIR/cu-after.png"
  shot "$before" "$rx" "$ry" "$rw" "$rh"
  local i d
  for i in 1 2 3; do
    click "$x" "$y" "$park"
    sleep 0.55
    shot "$after" "$rx" "$ry" "$rw" "$rh"
    d="$(yavg_diff "$before" "$after")"
    if awk -v d="${d:-0}" 'BEGIN { exit !(d > 1.0) }'; then
      [[ "$i" -gt 1 ]] && echo "  ($label: ${i}번째 클릭에 반응)"
      return 0
    fi
  done
  cp "$after" "$STATE_DIR/fail-${label}.png" 2>/dev/null || true
  echo "중단: $label — 3번 눌렀는데 화면이 바뀌지 않았습니다." >&2
  echo "      좌표를 probe-picker.sh 로 다시 실측하세요. 실패 시점 화면:" >&2
  echo "      $STATE_DIR/fail-${label}.png" >&2
  exit 1
}
assert_same() { # <before> <after> <최대차이> <설명>
  local d; d="$(yavg_diff "$1" "$2")"
  awk -v d="${d:-0}" -v t="$3" 'BEGIN { exit !(d < t) }' || {
    echo "중단: $4 — 시작 상태로 돌아오지 않았습니다 (차이 ${d:-0} >= $3)." >&2
    echo "      비교 이미지: $1 $2" >&2
    exit 1
  }
}
# 검증 영역(창 기준): 상태바 오른쪽 칩 묶음 / 프리뷰 창 안쪽 / 픽커 팝업 자리.
# 팝업 자리를 따로 두는 이유: 칩 클릭이 hover만 걸려도 상태바는 미세하게 바뀌므로
# 상태바로 판정하면 "열렸다"고 오판한다.
SB=(1000 880 400 20)
PV=(760 120 560 500)
MENU_REGION=(1140 450 150 400)
# 편집창 첫 몇 줄. 타이핑이 실제로 편집기에 들어갔는지는 여기로 본다 —
# 프리뷰로 판정하면 안 된다. mermaid 다이어그램은 프리뷰 면적의 3%에 불과하고
# 노드 채움색이 배경과 비슷해 평균 차이가 0.55밖에 안 나온다(오판으로 촬영이 멈췄다).
ED=(40 95 640 200)

# ---- 가드 0: 실측 좌표가 채워졌는가 ----------------------------------------
if [[ "$MENU_MD_Y" == 0 || "$MENU_NORMAL_Y" == 0 ]]; then
  echo "중단: 픽커 항목 좌표가 비어 있습니다 (MENU_MD_Y / MENU_NORMAL_Y)." >&2
  echo "      ./scripts/demo/probe-picker.sh 를 먼저 실행해 팝업을 찍고," >&2
  echo "      out/probe/02-picker.png 에서 행 y를 재어 이 스크립트에 채우세요." >&2
  exit 1
fi

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
rm -rf "$STATE_DIR"; mkdir -p "$STATE_DIR"
RAW="$OUT_DIR/raw.mov"
MP4="$OUT_DIR/md-preview-v2.mp4"
POSTER="$OUT_DIR/md-preview-v2-poster.jpg"
rm -f "$RAW" "$MP4" "$POSTER"

# ---- 격리 HOME + 평문 빈 Untitled 탭 ---------------------------------------
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

# ============================================================================
# 리허설 — 녹화 없이 전 구간을 한 번 돌려 좌표를 검증하고, mermaid를 워밍업하고,
# 마지막에 시작 상태(평문·빈 문서)로 되돌린다. 클릭 좌표가 어긋난 채 녹화를
# 시작하면 1분을 버리고도 "아무 일도 안 일어나는 영상"을 얻는다.
# ============================================================================
echo "리허설: 좌표 검증 + mermaid 워밍업"
capture_baseline   # 이후 모든 캡처가 "창이 담겼는지"를 이 프레임과 비교해 판정한다

# 테마 메뉴(AX) 직후라 첫 클릭이 흡수된다 — 편집창에서 소비시키고, 포인터는 창 밖으로.
prime_click
park_pointer
sleep 0.3
shot "$STATE_DIR/01-sb-normal.png" "${SB[@]}"

# 파일타입 픽커 → Markdown (프리뷰가 열린다: tabs.ts:300-303)
shot_full "01-start"
blur_editor
click_until "픽커 열기" "$CHIP_TYPE_X" "$CHIP_TYPE_Y" "${MENU_REGION[@]}"
shot_full "02-picker-open"
click_until "Markdown 선택" "$MENU_X" "$MENU_MD_Y" "${SB[@]}"
sleep 0.5
shot_full "03-after-pick"
shot "$STATE_DIR/02-sb-markdown.png" "${SB[@]}"
assert_changed "$STATE_DIR/01-sb-normal.png" "$STATE_DIR/02-sb-markdown.png" 1.0 \
  "픽커에서 Markdown 선택"

# 픽커 항목은 mousedown에서 preventDefault 하지만, 칩 자체를 누를 때 편집기 포커스가
# 이미 풀린다(pickerItem은 blur를 막지 않고 이후 focus 복구도 없다). 클릭으로 되찾는다.
shot "$STATE_DIR/03-ed-empty.png" "${ED[@]}"
focus_editor

# mermaid는 최초 사용 시 lazy import (preview.ts:146-157). 워밍업 없이 찍으면
# 영상의 클라이맥스 직전에 번들 로딩 멈칫이 그대로 들어간다.
osascript "$DEMO_DIR/type.applescript" "$DEMO_DIR/steps/00-warmup.txt" 0.01 0.02
sleep 4
# 다이어그램이 실제로 그려졌는지는 이 전체 스냅샷으로 눈으로 확인한다(체크리스트 7).
shot_full "04-after-warmup"
shot "$STATE_DIR/04-ed-typed.png" "${ED[@]}"
assert_changed "$STATE_DIR/03-ed-empty.png" "$STATE_DIR/04-ed-typed.png" 2.0 \
  "워밍업 타이핑이 편집기에 들어갔는지"

# 편집창 토글 좌표 검증 — 닫고 다시 연다. 판정은 편집창 자리로 한다: 그 자리가
# 소스 텍스트에서 프리뷰 배경으로 통째로 바뀌므로 차이가 가장 크다.
blur_editor
click_until "편집창 닫기" "$CHIP_EDITOR_X" "$CHIP_EDITOR_Y" "${ED[@]}" park
shot "$STATE_DIR/05-ed-editor-off.png" "${ED[@]}"
assert_changed "$STATE_DIR/04-ed-typed.png" "$STATE_DIR/05-ed-editor-off.png" 2.0 \
  "편집창 닫기 (Editor 칩)"
click_until "편집창 다시 열기" "$CHIP_EDITOR_X" "$CHIP_EDITOR_Y" "${ED[@]}" park
shot "$STATE_DIR/06-ed-editor-on.png" "${ED[@]}"
assert_changed "$STATE_DIR/05-ed-editor-off.png" "$STATE_DIR/06-ed-editor-on.png" 2.0 \
  "편집창 다시 열기 (Editor 칩)"

# 문서를 비우고 파일타입을 평문으로 되돌려 녹화 시작 상태로 복원한다.
# Normal을 고르면 isPreviewCapable()이 false가 되어 프리뷰 창도 함께 닫힌다.
focus_editor
osascript -e 'tell application "System Events" to keystroke "a" using command down' \
          -e 'tell application "System Events" to key code 51'
sleep 1
blur_editor
click_until "픽커 열기(복원)" "$CHIP_TYPE_X" "$CHIP_TYPE_Y" "${MENU_REGION[@]}"
click_until "Normal 선택(복원)" "$MENU_X" "$MENU_NORMAL_Y" "${SB[@]}"
sleep 0.5
shot "$STATE_DIR/07-sb-back-to-normal.png" "${SB[@]}"
assert_same "$STATE_DIR/01-sb-normal.png" "$STATE_DIR/07-sb-back-to-normal.png" 1.0 \
  "평문 상태로 복원"
echo "리허설 통과 — 녹화를 시작합니다."
osascript -e 'tell application "System Events" to tell process "uninotepad" to set frontmost to true'
blur_editor    # AX 호출/포커스에 흡수될 첫 클릭 몫을 녹화 밖에서 소모한다
park_pointer   # 첫 프레임에 포인터가 걸치지 않도록
sleep 1

# ============================================================================
# 본 촬영
# ============================================================================
# -v 는 Ctrl+C(SIGINT)까지 녹화한다. -V 는 폭주 대비 상한.
screencapture -v -V 150 -x -R"$WIN_X,$WIN_Y,$WIN_W,$WIN_H" "$RAW" &
CAP_PID=$!
T0="$(now)"
sleep 1.2

# 1) 파일타입 픽커에서 Markdown 선택 → 프리뷰가 열린다
# (frontmost 지정과 첫 클릭 소모는 녹화 시작 전에 끝냈다 — AX 호출과 흡수될 클릭이
#  영상 안에 들어가면 앞머리에 정지 화면이 남는다.)
click_until "픽커 열기(녹화)" "$CHIP_TYPE_X" "$CHIP_TYPE_Y" "${MENU_REGION[@]}"
click_until "Markdown 선택(녹화)" "$MENU_X" "$MENU_MD_Y" "${SB[@]}"
sleep 0.8

# 2) 편집창을 눌러 포커스를 잡고 본문 작성
focus_editor
for step in "$DEMO_DIR"/steps/0[1234]-*.txt; do
  case "$(basename "$step")" in
    # 펜스만 열린 상태(내용 없음)로 프리뷰가 한 번이라도 그려지면 "No diagram type
    # detected" 오류 박스가 뜬다. 이 두 줄만 디바운스(200ms)보다 짧은 간격으로 쳐서
    # 렌더 자체를 건너뛴다 — 다음 렌더는 "flowchart LR"이 완성된 뒤다.
    03-mermaid-open.txt) cd="$CHAR_DELAY_CODE"; ld=0.12; pause=0.2 ;;
    04-mermaid-body.txt) cd="$CHAR_DELAY_CODE"; ld="$LINE_DELAY_CODE"; pause="$STEP_PAUSE" ;;
    *)                   cd="$CHAR_DELAY";      ld="$LINE_DELAY";      pause="$STEP_PAUSE" ;;
  esac
  osascript "$DEMO_DIR/type.applescript" "$step" "$cd" "$ld"
  sleep "$pause"
done
sleep "$HOLD_DIAGRAM"

# 3) 편집창을 닫아 프리뷰를 전체 폭으로 — 넓은 다이어그램이 창을 따라 커진다
blur_editor   # 방금까지 타이핑했으므로 편집기에 포커스가 있다
click_until "편집창 닫기(녹화)" "$CHIP_EDITOR_X" "$CHIP_EDITOR_Y" "${ED[@]}" park
sleep "$HOLD_EDITOR_OFF"

# 4) 편집창 복귀. 마지막 프레임이 poster가 되므로 분할 화면으로 끝낸다.
click_until "편집창 다시 열기(녹화)" "$CHIP_EDITOR_X" "$CHIP_EDITOR_Y" "${ED[@]}" park
sleep "$HOLD_END"

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
