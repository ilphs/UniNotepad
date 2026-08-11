# Markdown 프리뷰 데모 영상 — 촬영 파이프라인 (초안)

랜딩 페이지 히어로의 lead shot을 "타이핑 → 프리뷰가 따라옴" 영상으로 바꾸기 위한
촬영 도구 모음. **아직 실행 검증되지 않은 초안이다** — 아래 검증 체크리스트를 통과하기
전에는 산출물을 `site/assets/`에 넣지 말 것.

## 파일

| 파일 | 역할 |
|---|---|
| `seed-session.sh` | 격리 HOME + `session.json` 씨딩 → 프리뷰가 열린 빈 Untitled 탭 |
| `type.applescript` | 텍스트 파일을 사람 속도로 한 글자씩 타이핑 |
| `steps/00-warmup.txt` | Mermaid lazy import 워밍업용 (영상에 안 들어감) |
| `steps/0{1,2,3}-*.txt` | 실제 원고 3단락 |
| `record.sh` | 가드 → 실행 → 녹화 → 타이핑 → 트림/인코딩 |

## 실행

```bash
npm run tauri build            # 릴리즈 바이너리 필요
./scripts/demo/record.sh
```

산출물은 `scripts/demo/out/` 에 떨어진다. 눈으로 확인한 뒤 직접 복사한다.

## 왜 이렇게 만들었나

**프리뷰를 세션으로 연다.** 프리뷰 분할 상태는 탭별로 `session.json`에 저장된다
(`src/session.ts:85-89, 170-176`). 격리 HOME에 미리 써 두면 녹화 중 `Cmd+Shift+M`을
누를 필요가 없다 — 이 프로젝트의 고질적 제약인 "마우스 클릭 자동화 불가"와
"CM6가 네이티브 accelerator를 가로챔"을 둘 다 우회한다. 이게 이 시나리오를
자동화 가능하게 만드는 핵심이다.

**원고가 에디터 동작을 피해 간다.** `src/editor.ts:173-190` 확인 결과:

- `closeBrackets()` 활성 — `[`는 `[]`로 자동 페어링되지만 닫는 문자를 이어서 치면
  skip-over 되므로 소스를 그대로 쳐도 결과가 맞는다. 원고의 `[`, `(`는 짝을 이룬다.
  (1차 촬영에서 `- [x]`가 그대로 찍히는 것으로 확인됨.)
- **줄바꿈은 Shift+Return으로 보낸다.** `markdown()`은 `addKeymap` 기본값이 true라
  `Prec.high`로 Enter → `insertNewlineContinueMarkup`을 심는다
  (`node_modules/@codemirror/lang-markdown/dist/index.js:396-422`). `editor.ts`의
  keymap 배열에는 안 보이지만 실제로는 `defaultKeymap`을 이긴다. 그냥 Return을 쓰면
  `- [x] ...` 다음 줄에 `- [ ] `가 자동 삽입돼 원고와 겹치고(`- [ ] - [x] ...`),
  빈 리스트 항목에서 Enter가 마커를 지우느라 빈 줄 하나가 먹힌다 — 1차 촬영이 그렇게
  깨졌다. `markdownKeymap`은 `Enter`만 바인딩하므로 Shift+Return은 `defaultKeymap`의
  `insertNewlineAndIndent`로 빠져 원고를 글자 그대로 입력한다.
- 펜스 안 들여쓰기는 실제로 붙지 않았다. 붙더라도 mermaid는 선행 공백을 허용한다.

**Mermaid를 워밍업한다.** mermaid는 최초 사용 시 lazy import 된다
(`src/preview.ts:146-157`). 워밍업 없이 찍으면 영상의 클라이맥스 직전에 번들 로딩
멈칫이 그대로 들어간다.

**줄바꿈 지연은 프리뷰 디바운스보다 커야 한다.** `schedulePreviewRender`는 키 입력마다
200ms 타이머를 리셋한다(`src/preview.ts:365-374`). 글자 간격이 200ms 아래로 이어지면
타이핑 중에는 프리뷰가 **한 번도 그려지지 않고** 쉼에서만 뭉텅이로 따라온다 — 1차
촬영이 그랬다(10초 시점까지 리스트가 프리뷰에 전혀 없었다). `LINE_DELAY=0.5`로
줄마다 디바운스를 통과시켜 줄 단위로 따라오게 만든다.

## 스토리보드

전체 ~19초. 클라이맥스는 Mermaid — 표·체크박스만으로는 기존 정지 스크린샷 대비
이득이 없다.

| 구간 | 내용 | 대략 |
|---|---|---|
| 0.0s | 빈 에디터 + 빈 프리뷰, 좌우 반반 | — |
| 0.0–4s | `# UniNotepad` / `Type on the left. It renders on the right.` | H1과 문단이 오른쪽에 뜬다 |
| 4–5s | 쉼 | 프리뷰가 따라잡는 것을 보여주는 구간 |
| 5–11s | 체크박스 3줄 | GFM task list 렌더 |
| 11–12s | 쉼 | |
| 12–17s | ```` ```mermaid ```` / `flowchart LR` / `A[Type] --> B[Render] --> C[Ship]` | |
| 17–19s | 다이어그램이 그려지고 정지 | 마지막 프레임 = poster |

원고는 **영어 1벌만** 만든다. 언어별 촬영은 제작·용량이 2배가 되는데 얻는 게 없다.
캡션만 `index.html` / `ko.html`에서 각각 쓴다.

## 검증 체크리스트 (전부 통과해야 사이트 반영)

1. ~~**가드 1** — 시작 시 실행 중인 UniNotepad가 있으면 중단되는가.~~ **검증 완료**
   (2026-08-11): 설치본이 실행 중인 상태에서 실행해 PID를 출력하고 exit 1로 막히는 것을
   확인했다. 과거 이 가드를 빌드 경로로 좁혔다가 두 번 사고가 났다(사용자의 미저장 탭이 촬영됨).
2. **가드 2** — 창 제목에 `Untitled`가 없으면 중단되는가.
3. **격리** — 창이 1400×900으로 뜨는가(격리 HOME이 먹었다는 신호).
4. **테마** — 첫 프레임이 다크인가. `theme.ts` 기본값을 믿지 말고 눈으로 볼 것.
5. **타이핑 결과** — 영상 안의 소스가 `steps/*.txt`와 글자 단위로 같은가.
   특히 `[x]` 대괄호 중복, mermaid 펜스 백틱 개수, 들여쓰기 누적.
6. **Mermaid** — 다이어그램이 멈칫 없이 그려지는가(워밍업이 먹었는가).
7. **산출물** — mp4가 1400×900 / 2MB 이하 / 오디오 트랙 없음.
8. **육안 확인** — 사용자의 실제 파일명·문서가 한 프레임도 들어가지 않았는가.

## 사이트 반영 (검증 통과 후)

`site/index.html:79-82` 와 `site/ko.html:75-78` 의 lead shot `figure` 하나만 교체한다.
스텝 탭·크로스페이드는 넣지 않는다 — 영상이 1개면 오버엔지니어링이다.

```html
<figure class="lead-shot">
  <video
    src="/assets/md-preview-v1.mp4"
    poster="/assets/md-preview-v1-poster.jpg"
    preload="auto" autoplay loop muted playsinline controls
    aria-label="Typing Markdown in UniNotepad while the preview pane renders it live"
  ></video>
  <figcaption><b>Dark</b> theme — type on the left, rendered on the right</figcaption>
</figure>
```

`site/assets/site.css` 에 한 줄 추가 — 기존 규칙이 `.hero .shot img`만 잡는다:

```css
.hero .shot video { width: 100%; display: block; border-radius: var(--radius); border: 3px solid var(--border); box-shadow: var(--shadow-lg); }
```

주의:

- **캐시** — `?v=` 규칙은 css/js에만 있다. 영상은 파일명에 버전을 박는다
  (`md-preview-v1.mp4`). 재촬영하면 `-v2`로 올리고 두 HTML을 함께 고친다.
- **CSS·JS를 고쳤으면** 두 HTML의 `?v=` 숫자를 함께 올린다(Vercel 엣지 캐시).
- **자동재생 중이다** (2026-08-11 사용자 요청). `muted` 없이는 어느 브라우저도
  자동재생을 허용하지 않으니 절대 떼지 말 것. `autoplay`/`loop`을 JS가 아니라 HTML에
  두는 이유는 JS가 죽어도 재생은 되게 하려는 것이고, `site.js`의 "히어로 데모 영상"
  블록이 두 가지를 얹는다 — 동작 최소화(`prefers-reduced-motion`)면 `load()`로
  poster를 되살려 정지, 화면 밖으로 나가면 일시정지.
  - **`controls`를 떼지 말 것.** 5초를 넘겨 자동 반복하는 콘텐츠에는 멈출 수단이
    있어야 한다(WCAG 2.2.2). 이 영상은 21.9초 루프다.
  - 동작 최소화에서 `pause()`만 하면 **거의 빈 편집기에서 얼어붙는다** — 재생이
    한 번 시작되면 poster가 다시 나오지 않기 때문이다. 마지막 프레임으로 seek하는
    방법은 디코딩에 기대야 해서 헤드리스 검증에서 실패했다. `load()`가 확실하다.
  - 참고로 marimo는 `autoplay`/`loop`을 쓰지 않고 JS로 선택된 스텝만 재생한다.
- **poster는 마지막 프레임**이다. 기존 `syntax-markdown.png`를 poster로 재활용하지
  말 것 — 정지 이미지(가득 찬 문서)와 영상 첫 프레임(빈 에디터)이 어긋나 재생 순간
  내용이 사라지는 것처럼 보인다.
- **`.git`는 현재 19MB, LFS 미사용.** 재촬영본을 커밋할 때마다 히스토리에 누적되고
  되돌릴 수 없다. 커밋 전에 영상이 확정됐는지 확인할 것.

## 검증 이력

**2차 촬영 (2026-08-11) — 체크리스트 8항목 전부 통과.** 산출물
`out/md-preview-v1.mp4` (1400×900 · 21.9s · 154KB · h264 · 오디오 없음) +
`out/md-preview-v1-poster.jpg`.

초안 단계에서 미검증으로 남겨 뒀던 항목은 모두 해소됐다:

- `screencapture -v` + `-R` → **영역만 녹화된다.** 원본이 1400×900으로 나왔다
  (Retina 2배가 아니라 논리 해상도). ffmpeg `crop` 불필요.
- `-v` 를 SIGINT로 종료 → **mov가 정상 마무리된다.** `-V` 고정 길이 폴백 불필요.
- AppleScript `keystroke` 백틱 → **정상.** ```` ```mermaid ```` 펜스가 그대로 입력된다.

1차 촬영에서 드러나 고친 결함 2건은 위 "왜 이렇게 만들었나"에 원인과 함께 적어 뒀다
(Enter 리스트 이어쓰기, 디바운스보다 짧은 줄바꿈 지연).

남은 한계: `- [x]`가 프리뷰에서 체크 표시가 아니라 **파란 원**으로 렌더된다(미체크는
회색 원). 앱의 실제 렌더링 스타일이므로 그대로 둔다 — 영상은 제품의 실제 모습이어야 한다.
