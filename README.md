<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="UniNotepad 앱 아이콘">
</p>

# UniNotepad

**껐다 켜도 그대로인 메모장.**

메모장에 뭔가 적어두고 저장하는 걸 깜빡한 채 창을 닫아본 적 있으신가요?
아니면 컴퓨터가 갑자기 꺼져서 쓰던 내용이 날아간 적은요?

UniNotepad에서는 그런 일이 생기지 않습니다. 열어둔 탭은 **저장하지 않은 내용까지**
그대로 남아 있다가, 다음에 앱을 열면 떠날 때 모습 그대로 돌아옵니다.
앱을 종료하든, 갑자기 꺼지든, 컴퓨터를 재시작하든 똑같습니다.
저장 버튼을 누를 필요가 없습니다.

Windows · macOS · Linux에서 쓸 수 있습니다.

## 설치

[다운로드 페이지](https://github.com/ilphs/UniNotepad/releases/latest)에서
쓰시는 운영체제에 맞는 파일을 내려받으세요.

| 운영체제 | 받을 파일 |
|:--|:--|
| Windows | `UniNotepad_x.y.z_x64_en-US.msi` (또는 `x64-setup.exe`) |
| macOS — M1 이후 | `UniNotepad_x.y.z_aarch64.dmg` |
| macOS — 인텔 | `UniNotepad_x.y.z_x64.dmg` |
| Linux | `.AppImage` · `.deb` · `.rpm` 중 편한 것 |

### macOS에서 "손상되었기 때문에 열 수 없습니다"라고 나올 때

이 앱은 Apple 개발자 인증서 서명·공증(notarization) 없이 배포됩니다. 그래서 내려받은
앱을 처음 열면 macOS가 "손상된 파일"이라며 열어 주지 않을 수 있습니다. 파일이 실제로
깨진 것은 아니고, 공증되지 않은 앱을 인터넷에서 받았을 때 나오는 macOS의 기본 안내입니다.

`UniNotepad.app`을 `응용 프로그램` 폴더로 옮긴 뒤, 터미널에서 아래 한 줄을 실행하고
다시 열면 됩니다. (내려받은 파일에 붙는 격리 꼬리표를 지우는 명령입니다.)

```bash
xattr -cr /Applications/UniNotepad.app
```

## 무엇이 다른가요

**저장을 신경 쓰지 않아도 됩니다.**
타이핑을 잠깐 멈추면 알아서 기록해 둡니다. 그래서 앱을 닫을 때 "저장하시겠습니까?"
같은 걸 묻지 않습니다. 물어볼 이유가 없으니까요. 이미 다 저장돼 있습니다.

**탭으로 여러 문서를 함께 봅니다.**
웹 브라우저처럼 탭을 열고, 닫고, 순서를 바꿀 수 있습니다. 제목 없이 그냥
끄적인 메모도 탭째로 보관됩니다.

**글에 자동으로 색이 입혀집니다.**
코드나 설정 파일을 열면 종류를 알아서 알아보고 보기 좋게 색을 입혀줍니다.
143개 언어를 지원하는데, 따로 고를 필요 없이 파일 이름만 보고 판단합니다.

**메모를 문서처럼 볼 수 있습니다.**
Markdown 파일을 열면 화면이 둘로 나뉘어, 왼쪽에 쓰는 대로 오른쪽에 완성된
문서 모양이 바로 나타납니다. 순서도나 도표(Mermaid)도 그림으로 그려집니다.

**가볍습니다.**
브라우저를 통째로 끼워 넣는 흔한 방식 대신 운영체제에 이미 있는 기능을 쓰기 때문에,
설치 파일이 **3MB 안팎**입니다. (Linux `.AppImage`만은 필요한 것을 전부 담느라 큽니다.
가볍게 쓰시려면 `.deb`나 `.rpm`을 받으세요.)

## 화면

밝은 테마와 어두운 테마를 모두 지원하며, 색상은 지금 쓰는 테마를 따라갑니다.

**이미지를 클릭하면 [갤러리](https://ilphs.github.io/UniNotepad/)가 열려 한 장씩 크게 넘겨볼 수 있습니다.**

| |
|:--|
| **파일 타입 선택** — 상태 표시줄에서 고르면 됩니다. 저장하지 않은 새 글도 Markdown이나 Mermaid로 지정하면 바로 색이 입혀지고 미리보기가 열립니다 |
| [![상태 표시줄의 파일 타입 선택 메뉴](docs/filetype-picker.png)](https://ilphs.github.io/UniNotepad/#filetype) |

| | |
|:--|:--|
| **Markdown** — 쓰는 대로 오른쪽에 문서가 완성됩니다 | **Mermaid** — 순서도를 글로 적으면 그림이 됩니다 |
| [![분할 미리보기가 있는 Markdown](docs/syntax-markdown.png)](https://ilphs.github.io/UniNotepad/#markdown) | [![Mermaid 다이어그램 미리보기](docs/syntax-mermaid.png)](https://ilphs.github.io/UniNotepad/#mermaid) |
| **TypeScript** — 타입과 제네릭까지 | **Python** — docstring과 데코레이터 |
| [![TypeScript 구문 강조](docs/syntax-typescript.png)](https://ilphs.github.io/UniNotepad/#typescript) | [![Python 구문 강조](docs/syntax-python.png)](https://ilphs.github.io/UniNotepad/#python) |
| **Bash** — 명령어 스크립트 | |
| [![Bash 구문 강조](docs/syntax-bash.png)](https://ilphs.github.io/UniNotepad/#bash) | |

## 자주 묻는 질문

**저장을 안 했는데 정말 안 없어지나요?**
네. 타이핑을 멈추면 1.5초 뒤에, 그리고 탭을 옮기거나 창을 닫을 때마다 조용히
기록해 둡니다. 컴퓨터가 강제로 꺼져도 마지막 1~2초 분량 외에는 남아 있습니다.

**그럼 저장 버튼은 왜 있나요?**
앱이 알아서 보관하는 건 이 앱 안에서만 쓰는 임시 보관본입니다.
내용을 실제 파일로 남겨 다른 프로그램에서도 열려면 저장을 해야 합니다.

**작업하던 파일을 다른 프로그램에서 고치면요?**
다음에 앱을 켤 때 알아채고 "파일이 바뀌었다"고 알려줍니다. 이때도 사용자가 쓰던
내용이 우선이라 멋대로 덮어쓰지 않습니다. 다만 앱이 켜져 있는 동안 실시간으로
지켜보지는 않으니, 같은 파일을 다른 프로그램과 번갈아 편집 중이라면 주의하세요.

**탭을 실수로 닫으면요?**
저장하지 않은 탭을 닫을 때는 저장할지 물어봅니다. 앱을 통째로 종료할 때와 달리,
탭을 닫는 건 "이제 그만 보겠다"는 분명한 의사 표시로 보기 때문입니다.

**한글이 깨지지 않나요?**
요즘 표준인 UTF-8 파일은 (BOM이 있든 없든) 그대로 잘 열립니다. 예전 윈도우
메모장에서 "ANSI"로 저장한 한글 파일(EUC-KR/CP949)도 알아서 판별해 제대로
엽니다. 혹시 잘못 인식되면 상태 표시줄의 인코딩 항목을 눌러 **EUC-KR**을 직접
고르면 그 인코딩으로 다시 읽어 옵니다. 줄바꿈 방식도 Windows식·Unix식을 알아서
알아본 뒤 저장할 때 원래대로 되돌려 놓습니다.

다만 **일본어(Shift-JIS)·중국어(GBK) 등 그 밖의 옛 인코딩은 아직 지원하지 않습니다.**
그런 문서는 임시 방식으로 열리니, 다른 편집기에서 UTF-8로 바꿔 저장한 뒤 여시는
편이 안전합니다.

---

## 개발자용

### 기술 스택

- **[Tauri 2](https://tauri.app)** — Rust 백엔드 + OS 네이티브 WebView (작은 바이너리, 브라우저 미포함)
- **[CodeMirror 6](https://codemirror.dev)** — 에디터 컴포넌트. 주요 언어 팩은 번들에 포함, 나머지는 언어 단위로 lazy-load
- **Vanilla TypeScript + Vite** — 프론트엔드 프레임워크 런타임 없음

### 구문 강조 범위

**143개 언어 / 224개 확장자**를 파일명으로 판별합니다.

자주 쓰는 언어(JSON, JS/TS, Python, C/C++, Rust, Go, HTML/CSS, Markdown, YAML, XML,
SQL, Java, shell)는 번들에 포함돼 즉시 강조됩니다. 나머지는
[`@codemirror/language-data`](https://github.com/codemirror/language-data)에 매칭한 뒤
해당 언어 팩을 처음 쓸 때 별도 청크로 가져오므로, 롱테일 언어를 지원해도 시작 비용은 0입니다.

롱테일에는 웹(LESS/SCSS/Vue/Pug/Handlebars), 시스템(Swift/Objective-C/D/Fortran/Cobol/
어셈블리), JVM·.NET(Kotlin/Scala/Groovy/Clojure/C#/F#/VB.NET), 스크립트(Ruby/Perl/PHP/
Lua/PowerShell/Tcl/R/Julia), 함수형(Haskell/Elm/Erlang/OCaml/Lisp/Scheme), 데이터·설정
(TOML/INI/ProtoBuf/LaTeX/diff), 데이터베이스(Cypher/XQuery/PL-SQL 및 SQL 방언),
하드웨어 기술 언어(Verilog/SystemVerilog/VHDL)가 포함됩니다.

확장자가 없는 파일은 이름으로 인식합니다: `Dockerfile`, `CMakeLists.txt`, `Jenkinsfile`,
`Gemfile`, `Rakefile`, `BUILD`, `PKGBUILD`, `nginx*.conf`. 매칭되지 않으면 플레인 텍스트로 열립니다.

### 사전 요구사항

- [Node.js](https://nodejs.org) 18 이상
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Linux 한정: `webkit2gtk-4.1`, `libgtk-3` 개발 패키지

### 개발 / 빌드 / 테스트

```bash
npm install
npm run tauri dev      # 핫 리로드로 앱 실행

npm run tauri build    # src-tauri/target/release/bundle/ 아래에 플랫폼별 설치 파일 생성

# Rust: 인코딩 왕복 변환 + 세션 스토어 내구성 (원자적 쓰기, 손상 파일 격리, GC)
cd src-tauri && cargo test

# 프론트엔드 타입체크 + 프로덕션 번들
npm run build
```

### 세션 지속성 동작 방식

- 세션 데이터는 OS별 앱 데이터 디렉터리(`app_data_dir()`)에 저장됩니다.
  `session.json` 매니페스트 + `backups/` 아래에 dirty/untitled 탭마다 백업 파일 하나씩.
- dirty 버퍼는 편집 후 1.5초 디바운스, 탭 전환, 창 blur, 구조 변경, 30초 주기 안전장치,
  창 닫기 시점에 flush됩니다.
- 모든 쓰기는 원자적입니다(임시 파일 → fsync → rename). 그래서 `kill -9`나 정전에도
  파일이 깨지지 않으며, 최악의 경우 마지막 디바운스 구간만 유실됩니다.
- 시작 시 매니페스트를 읽어 각 탭을 디스크와 대조합니다. clean 파일은 다시 읽고,
  dirty 파일은 백업을 복원하며(사용자의 편집이 우선), 디스크에서 파일이 변경되거나
  삭제됐으면 작업을 막지 않는 배너로 알립니다.

### 수동 인수 테스트 (세션 복원)

1. `npm run tauri dev`로 실행해 파일 몇 개를 열고, 하나를 편집하고, 내용이 있는 untitled 탭을 1~2개 만듭니다.
2. 프로세스를 강제 종료합니다 (`kill -9 <pid>` 또는 활성 상태 보기 / 작업 관리자).
3. 다시 실행 — 모든 탭이 순서대로 돌아오고, 활성 탭·커서 위치·dirty 표시·untitled 내용이
   그대로 유지됩니다.
