// 화면 좌표를 클릭한다 (JXA + CGEvent 합성).
//
//   osascript -l JavaScript click.js <x> <y> [parkX parkY]
//
// 왜 CGEvent인가: System Events의 `click at {x,y}`는 -25208로 실패하고 WebView
// 내부는 접근성 트리에 노출되지 않는다. CGEvent를 직접 합성하면 WebView 안의
// 요소(상태바 칩·픽커 항목)도 눌린다.
//
// kCGMouseEventClickState=1 이 핵심이다. 없으면 이벤트가 앱에 도달해 :hover까지는
// 걸리지만 WebKit이 DOM click으로 합성하지 않아 "클릭이 안 먹는 것처럼" 보인다.
//
// parkX/parkY: 클릭 후 포인터를 옮길 곳. 상태바 칩에는 title 툴팁이 달려 있어
// (statusbar.ts paneChip/pickerItem) 포인터를 올려둔 채 기다리면 영상에 툴팁이
// 뜬다. 창 밖(캡처 영역 밖)으로 대피시켜 이를 막는다.

ObjC.import("CoreGraphics");

function post(type, p) {
  var e = $.CGEventCreateMouseEvent($(), type, p, $.kCGMouseButtonLeft);
  $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, 1);
  $.CGEventPost($.kCGHIDEventTap, e);
}

function run(argv) {
  // --move: 누르지 않고 포인터만 옮긴다. 촬영 시작 전에 포인터를 창 밖으로 빼
  // 두는 용도 — 사용자가 마지막에 마우스를 놓아둔 자리에 hover가 걸린 채로
  // 첫 프레임이 찍히는 것을 막는다.
  var moveOnly = argv[0] === "--move";
  var i = moveOnly ? 1 : 0;
  var p = $.CGPointMake(parseFloat(argv[i]), parseFloat(argv[i + 1]));
  post($.kCGEventMouseMoved, p);
  if (moveOnly) return;
  // 이동 → 누름 사이를 넉넉히 벌리고 이동 이벤트를 한 번 더 보낸다. 붙여 보내면
  // WebKit이 hover만 걸고 클릭으로 합성하지 않는 일이 잦다(그때마다 호출 측이
  // 다시 눌러야 해서 영상에 군더더기 지연이 생긴다).
  delay(0.25);
  post($.kCGEventMouseMoved, p);
  delay(0.15);
  post($.kCGEventLeftMouseDown, p);
  delay(0.08);
  post($.kCGEventLeftMouseUp, p);
  if (argv.length >= 4) {
    delay(0.15);
    post($.kCGEventMouseMoved, $.CGPointMake(parseFloat(argv[2]), parseFloat(argv[3])));
  }
}
