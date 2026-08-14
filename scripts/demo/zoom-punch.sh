#!/usr/bin/env bash
# 파일타입 픽커 + Editor 칩 클릭 구간을 확대하고 전체를 균등 배속하는 후처리
# — 재촬영 없이 기존 md-preview-v2.mp4 위에서 돌아간다. 산출물:
# md-preview-v3.mp4 (+poster).
#
#   ./scripts/demo/zoom-punch.sh
#   ZOOM_SPEED=1.25 ./scripts/demo/zoom-punch.sh   # 배속 조절 (기본 1.4)
#
# 무엇을 확대하는지, 왜 zoompan을 쓰는지는 zoom-scenes.py 상단 주석 참고.
# 좌표/타임스탬프는 out/md-preview-v2.mp4 전용 실측값이다 — 재촬영하면
# zoom-scenes.py의 KEYFRAMES를 다시 실측해 채워야 한다(README "줌 인서트
# 후처리" 참고). 배속은 KEYFRAMES와 무관하게 뒤에서 적용되므로 재실측 없이
# 바꿀 수 있다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_DIR="$ROOT/scripts/demo"
OUT_DIR="$DEMO_DIR/out"
SRC="$OUT_DIR/md-preview-v2.mp4"
FILTER="$OUT_DIR/zoom-filter.txt"
MP4="$OUT_DIR/md-preview-v3.mp4"
POSTER="$OUT_DIR/md-preview-v3-poster.jpg"

# 전체 균등 배속. zoompan의 crop 타이밍은 v2의 원래 타임라인(on/30) 기준으로
# 계산되므로 그대로 두고, setpts를 zoompan 뒤에 이어 붙여 재생 시간만
# 압축한다 — 프레임을 버리지 않고 PTS 간격만 좁히므로(1/30 → 1/(30*SPEED))
# 결과 프레임레이트가 30*SPEED로 올라갈 뿐 끊김이 없다. 1.0이면 무변화.
SPEED="${ZOOM_SPEED:-1.4}"

[[ -f "$SRC" ]] || { echo "중단: $SRC 가 없습니다 — record.sh로 먼저 촬영하세요." >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "중단: ffmpeg 필요." >&2; exit 1; }
command -v python3 >/dev/null || { echo "중단: python3 필요." >&2; exit 1; }

printf '%s' "$(python3 "$DEMO_DIR/zoom-scenes.py")" > "$FILTER"
if awk -v s="$SPEED" 'BEGIN { exit !(s != 1.0) }'; then
  printf ',setpts=PTS/%s' "$SPEED" >> "$FILTER"
  echo "배속: ${SPEED}x"
fi

echo "렌더: $SRC → $MP4"
ffmpeg -y -v error -i "$SRC" -filter_script:v "$FILTER" \
  -an -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 26 -preset slow \
  -movflags +faststart "$MP4"

# poster = 마지막 프레임 (record.sh와 동일한 관례: 정지 시 완성된 문서가 보인다)
ffmpeg -y -v error -sseof -0.3 -i "$MP4" -frames:v 1 -q:v 3 "$POSTER"

echo
echo "완료:"
ls -lh "$MP4" "$POSTER"
echo
echo "다음: 영상을 눈으로 확인한 뒤 site/assets/ 로 복사하세요."
echo "  cp $MP4 $POSTER $ROOT/site/assets/"
