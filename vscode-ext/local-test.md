# 로컬 테스트 가이드

`vscode-ext`를 내 VS Code에서 직접 확인하는 방법. 경로는 이 리포가
`~/Work/UniNotepad`에 있다는 전제.

> **두 방법을 동시에 쓰지 말 것.** 설치본(.vsix)과 개발본(Extension Development
> Host)이 겹치면 명령이 중복 등록되고 타이틀바 버튼도 두 개가 된다.

---

## 사전 준비

```bash
cd ~/Work/UniNotepad/vscode-ext
npm install
```

`code` CLI가 PATH에 없으면 매번 전체 경로를 써야 한다. 한 번만 등록해두면 편하다:
VS Code에서 `Cmd+Shift+P` → **Shell Command: Install 'code' command in PATH**

이 문서에서는 등록 안 된 상태를 가정해 전체 경로를 쓴다:

```
/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code
```

---

## 방법 A — 설치 없이 실행 (개발 중 권장)

Extension Development Host라는 **별도 창**이 뜨고 그 창에서만 확장이 로드된다.
창을 닫으면 흔적이 남지 않는다.

### A-1. F5

```bash
open -a "Visual Studio Code" ~/Work/UniNotepad/vscode-ext
```

**`vscode-ext/`를 워크스페이스 폴더로** 열어야 한다 (리포 루트 아님 —
`.vscode/launch.json`의 경로가 `${workspaceFolder}` 기준). 그다음 `F5`.
빌드(`preLaunchTask: npm: build`) → 새 창 → `sample/demo.md` 자동 오픈까지 진행된다.

> macOS에서 상단 F키가 미디어 키로 설정돼 있으면(`defaults read -g
> com.apple.keyboard.fnState` 가 `0`) **`fn+F5`** 를 눌러야 한다. 메뉴
> **Run → Start Debugging** 이나 `Cmd+Shift+D` → ▶ 로도 같다.

### A-2. CLI (F5 없이 한 방)

```bash
cd ~/Work/UniNotepad/vscode-ext
npm run build
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --extensionDevelopmentPath=$PWD \
  $PWD/sample/demo.md
```

빌드를 대신 해주지 않으므로 `npm run build`가 선행돼야 한다.

---

## 방법 B — 실제 설치 (.vsix)

평소 쓰는 VS Code에 얹어서 써보는 경로.

### B-1. 패키징

```bash
cd ~/Work/UniNotepad/vscode-ext
npm run package
```

`npm test`(40 checks) → production 번들 → `vsce package` 순으로 돈다.
결과: `uninotepad-markdown-preview-0.1.0.vsix` (약 957 KB, 8 files).
`.gitignore`에 `*.vsix`가 있어 커밋에 섞이지 않는다.

### B-2. 설치

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --install-extension ~/Work/UniNotepad/vscode-ext/uninotepad-markdown-preview-0.1.0.vsix
```

GUI: `Cmd+Shift+X` → 우상단 `...` → **Install from VSIX...**

설치 후 `Cmd+Shift+P` → **Developer: Reload Window** 로 창을 새로고침한다.

### B-3. 설치 확인

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --list-extensions --show-versions | grep -i uninotepad
# 기대: ilphs.uninotepad-markdown-preview@0.1.0
```

```bash
ls -d ~/.vscode/extensions/ilphs.uninotepad-markdown-preview-*
```

VS Code 안에서 확인하려면:

- `Cmd+Shift+X` → 검색창에 `@installed uninotepad`
- `Cmd+Shift+P` → `UniNotepad` 입력 → 명령 5개가 떠야 한다

### B-4. 제거

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --uninstall-extension ilphs.uninotepad-markdown-preview
```

---

## 동작 확인 체크리스트

`sample/demo.md`를 연 상태에서:

1. 타이틀바 프리뷰 버튼 중 **`type-hierarchy` 글리프**가 우리 것 — 호버 툴팁이
   *Open Mermaid Preview to the Side*. (내장 Markdown 프리뷰는 `open-preview`
   아이콘을 그대로 쓰므로 둘이 나란히 뜬다.)
2. `Cmd+K Shift+M` → 옆 칸에 프리뷰가 열린다.
3. `Cmd+Shift+M` → **Problems 패널**이 토글돼야 한다 (기본 단축키 충돌 없음 확인).
4. 프리뷰에 포커스를 준 뒤 `Cmd+=` / `Cmd+-` / `Cmd+0` → 본문과 다이어그램이 **같이**
   확대·축소되고, `Cmd+0`은 정확히 100%로 돌아온다.
5. 확대 상태에서 다이어그램 안을 드래그 → 팬.
6. 다이어그램에 호버 → **Transparent / Backdrop** 툴바. Backdrop 슬라이더가 실시간 반영.
7. 테마를 라이트↔다크로 바꾼다 → 다이어그램이 **새 팔레트로 재렌더**돼야 한다
   (mermaid는 색을 SVG에 구워 넣으므로 리페인트로는 안 바뀐다).
8. 에디터를 스크롤 → 프리뷰가 따라온다 (단방향).
9. `sample/chart.mmd` 열기 → 프리뷰가 **따라와서** 전체 폭 solo 레이아웃으로 바뀐다.
    이어서 `demo.md` 탭으로 돌아가면 프리뷰도 같이 돌아오고 **맨 위로** 스크롤된다.
    프리뷰를 클릭해 포커스를 줘도 내용이 비지 않아야 하고, `.ts` 같은 파일로 넘어가면
    마지막 렌더가 그대로 남아 있어야 한다.
10. `Cmd+Shift+P` → **UniNotepad: Export Preview as HTML** → 저장 후 "Open in
    Browser". (웹뷰는 `window.print()`를 못 쓰므로 인쇄는 이 경로.)

`test/`의 자동 테스트가 못 덮는 건 **mermaid의 실제 SVG 출력**이다 — jsdom에
`getBBox`가 없어 다이어그램이 의도적으로 에러 경로를 탄다. 1·5·6·7·9번은 눈으로만
검증된다.

---

## 자동 검증

```bash
cd ~/Work/UniNotepad/vscode-ext
npm run typecheck   # tsconfig.json + webview/tsconfig.json
npm test            # build 후 extension-host 26 + webview 23 = 49 checks
npm run watch       # 개발 중 증분 빌드
```

---

## 알려진 제약

- `package.json`의 `publisher`는 placeholder(`ilphs`)이고 `private: true`다.
  로컬 패키징·설치는 이대로 문제없지만 마켓플레이스 게시는 둘 다 정리해야 한다.
- 펜스 코드 블록에 syntax highlighting이 없다. 웹뷰 CSP가 분할 번들의 청크
  fetch를 막아서, CodeMirror 문법을 언어별 동적 import로 끌어오던 앱 방식을
  그대로 옮길 수 없다.
- 스크롤 동기화는 에디터 → 프리뷰 단방향이다 (앱과 동일).
