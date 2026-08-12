# 탐색기(파일 트리) 사이드바 도입 검토

> 에디터 왼쪽에 on/off 가능한 파일 탐색기 창을 추가하는 방안. **경량화 유지가 최우선 제약.**
> 검토일: 2026-08-06 · 기준 버전: v0.9.0

---

## 결론 먼저

**경량화를 지키면서 구현 가능하다.** 핵심은 세 가지 금지선이다.

| 금지선 | 이유 |
|---|---|
| `tauri-plugin-fs` 도입 금지 | 필요한 건 `read_dir` 하나. std::fs로 자체 커맨드 작성 → **신규 크레이트 0개** |
| 트리 UI 라이브러리 도입 금지 | vanilla TS + `<div>` 재귀 렌더로 충분. 아이콘은 CSS 문자(`▸`/`▾`) |
| v1에서 재귀 디렉터리 감시 금지 | notify 재귀 watch는 대형 트리에서 FD/메모리 폭증. 지연 확장 + 포커스 갱신으로 대체 |

이 셋을 지키면 예상 증가분은 다음과 같다.

- **Rust 바이너리**: 신규 의존성 없음 → 코드 증가분(약 150줄)만, 수 KB. 현재 3.3MB 대비 **0.1% 미만**
- **JS 엔트리 청크**: 현재 `index-*.js` 96KB → **+5~8KB**(minify 기준, gzip 시 +2~3KB)
- **CSS**: 현재 17KB → **+1KB 내외**
- **런타임 메모리**: 펼친 폴더의 엔트리만 보유. 1000개 기준 수백 KB

즉 "경량"이라는 정체성은 유지된다. 진짜 위험은 번들이 아니라 **런타임 성능(대형 디렉터리)과 레이아웃 회귀**다.

---

## 1. 레이아웃 — 가장 중요한 설계 판단

**`#sidebar`를 `#split` 안에 넣으면 안 된다.** `preview.ts`가 프리뷰 분할 비율을 `#split`의 실제 폭 기준으로 계산하기 때문이다.

```ts
// src/preview.ts:635 onDividerMove
const rect = splitEl.getBoundingClientRect();
const raw = (e.clientX - rect.left) / rect.width;   // 사이드바 폭이 rect에 섞이면 비율이 어긋남
```

또 `applyRatio()`는 `editorHost`/`previewHost`의 `flex-grow` 합이 1이라는 전제로 동작한다(코드 주석에 명시). `#split`에 세 번째 flex 자식이 끼면 이 전제가 깨진다.

### 권장: `#split`을 감싸는 `#workspace` 행을 새로 만든다

```html
<div id="workspace">
  <div id="sidebar" hidden></div>
  <div id="sidebar-divider" hidden></div>
  <div id="split"> … 기존 그대로 … </div>
</div>
```

```css
#workspace { flex: 1; display: flex; flex-direction: row; min-height: 0; }
#sidebar   { flex: 0 0 var(--sidebar-width, 240px); min-width: 0;
             overflow: auto; border-right: 1px solid var(--border); }
#split     { flex: 1 1 0; min-width: 0; }  /* flex:1 → flex:1 1 0 로 변경 */
```

이러면 `preview.ts`는 **한 줄도 손대지 않는다.** 사이드바 리사이저는 `flex-basis`(px)를 직접 쓰므로 비율 로직과 완전히 분리된다.

놓치기 쉬운 지점: `@media print` 블록(`styles.css:1096~`)에 `#sidebar, #sidebar-divider`를 `display:none`으로 추가해야 한다. 안 하면 인쇄 결과에 트리가 섞인다.

---

## 2. Rust — 커맨드 하나

`src-tauri/src/commands/fsdir.rs` 신규. 의존성 추가 없음.

```rust
#[derive(Serialize)]
pub struct DirEntryInfo {
    name: String,
    path: String,
    #[serde(rename = "isDir")] is_dir: bool,
    hidden: bool,
}

#[derive(Serialize)]
pub struct DirListing {
    entries: Vec<DirEntryInfo>,
    /// 캡을 넘겨 잘렸는지 — 프런트가 "…N개 더" 를 표시
    truncated: bool,
}

#[tauri::command]
pub fn read_dir(path: String) -> Result<DirListing, String>
```

설계 포인트:

- **엔트리 캡 5000.** 넘으면 `truncated: true`로 잘라 반환. `read_guarded`가 파일 크기를 단일 집행하는 것과 같은 철학 — 가드는 Rust가 소유한다
- **심볼릭 링크 추종 금지.** `entry.file_type()`은 링크 자체를 보고하므로, 링크면 `fs::metadata`(추종)로 한 번만 판정하고 실패 시 파일 취급. 순환은 지연 확장(사용자 클릭)이라 무한 재귀가 구조적으로 불가능
- **숨김 판정**: Unix는 `.` 접두, Windows는 `std::os::windows::fs::MetadataExt::file_attributes()` — 둘 다 std, 크레이트 0
- **정렬은 Rust에서**: 디렉터리 우선 → 이름 소문자 비교. JS에서 다시 정렬하지 않는다
- `#[tauri::command]` 동기 함수는 웹뷰 스레드를 막지 않지만, 네트워크 드라이브에서는 응답이 수 초 걸릴 수 있으니 프런트에 로딩 표시가 필요하다

---

## 3. 외부 변경 감시 — v1은 하지 않기를 권장

`watcher.rs`는 이미 잘 짜여 있고 `notify`도 이미 들어 있어 "재사용하면 공짜"처럼 보이지만, 실제로는 그렇지 않다.

- 현재 레지스트리(`by_canon`, `watch_count`, `suppress`)는 **파일 단위** 매칭 전용이다. 디렉터리 감시를 얹으려면 별도 레지스트리와 별도 refcount가 필요하고, `Inner.dirs`를 파일 watch와 공유하면 unwatch 순서에 따라 형제 탭의 감시가 끊기는 버그를 만들기 쉽다
- 폴더를 펼칠 때마다 watch가 늘어나므로, 큰 프로젝트를 훑으면 OS watch 핸들이 수백 개로 증가한다

**v1 대안 (비용 거의 0):**

- 창 `focus` 시 — 이미 `main.ts:84`에 스로틀된 focus 핸들러가 있다. 여기에 "펼쳐진 폴더만 재조회"를 얹는다
- 컨텍스트 메뉴 / F5 수동 새로고침
- 앱이 자기 탭을 저장하면 해당 폴더만 갱신

v2에서 감시가 정말 필요해지면 `watcher.rs`에 **독립된 dir 레지스트리**로 추가(디바운서만 공유)하고, `dir-changed` 이벤트를 별도로 emit하는 방향을 권한다.

---

## 4. 프런트 — `src/explorer.ts` 단일 파일

예상 350~450줄. 상태는 이 정도면 충분하다.

```ts
let rootPath: string | null;
const expanded = new Set<string>();                // 펼친 폴더 경로
const cache = new Map<string, DirEntryInfo[]>();   // 폴더 → 엔트리
```

- **지연 확장만**: 루트는 1단계만 읽는다. 펼칠 때 그 폴더만 `read_dir`
- **DOM 캡**: 한 폴더당 렌더 1000개 + "…N개 더 보기" 버튼. 가상 스크롤은 이 앱 규모에 과설계
- **파일 클릭 → 기존 `openPaths([path])` 재사용.** 탭 로직·대용량 가드·인코딩 처리가 전부 그대로 적용된다. 이미 열린 탭이면 활성화만
- **아이콘 없음**: `▸`/`▾` 문자 + 폴더/파일 폰트 굵기 차이. 아이콘 폰트나 SVG 스프라이트는 번들 정책 위반

### 영속성은 localStorage

`settings.ts` 패턴 그대로 간다. `session.json`에 넣지 않는다 — Rust `TabEntry`가 명시적으로 모델링되어 있어(`ipc.ts:60` 주석) 필드 추가마다 Rust 동기화 비용이 생기고, 사이드바는 탭 단위가 아니라 앱 전역 UI 상태다.

```
uninotepad.explorerVisible   / uninotepad.explorerRoot
uninotepad.explorerWidth     / uninotepad.explorerExpanded  (JSON 배열)
```

복원 시 루트 폴더가 사라졌으면 조용히 비운다.

---

## 5. 진입점 / 단축키 — 이 프로젝트 특유의 함정 두 개

### (a) Windows accelerator는 절대 발화하지 않는다

웹뷰가 포커스를 가진 동안 네이티브 accelerator가 안 먹는 건 이 앱의 알려진 제약이고, `main.ts:159`의 `accelTable`이 실질 담당이다. **메뉴 항목 추가 시 `menu.rs`와 `accelTable` 양쪽을 반드시 함께** 수정해야 한다.

### (b) CM6가 `preventDefault`하는 키는 메뉴가 못 이긴다

후보 단축키 검증 결과:

- `Cmd+B`(macOS): macOS의 `standardKeymap`은 emacs 스타일(`Ctrl-B` = 커서 왼쪽)을 포함하지만 `Cmd`는 무관 → **안전**
- `Ctrl+B`(Win/Linux): `standardKeymap`에 없음 → **안전**
- 확신이 없으면 `Ctrl/Cmd+Shift+E`가 충돌 여지가 더 적다

### 추가 진입점

- `File ▸ Open Folder…` (dialog 플러그인 이미 있음 — `open({ directory: true })`)
- **폴더 드롭 처리**: 현재 `onFileDrop → openPaths`는 경로를 파일로 가정한다. 폴더가 떨어지면 `open_file`이 실패하므로, 드롭 경로를 `stat`해서 디렉터리면 탐색기 루트로 보내는 분기가 필요하다 — **이건 현재 코드의 미세 버그이기도 하다**

---

## 6. 위험 요소

| 위험 | 심각도 | 완화 |
|---|---|---|
| `node_modules` / `/` 루트 펼침 | **높음** | Rust 5000 캡 + DOM 1000 캡. 재귀 스캔 자체를 하지 않음 |
| `preview.ts` 비율 회귀 | **높음** | `#workspace` 래핑으로 구조적 차단 (§1) |
| macOS TCC — Desktop/Documents/Downloads 최초 접근 시 시스템 권한 프롬프트 | 중간 | `read_dir` 실패를 사이드바 인라인 메시지로 표시(모달 금지) |
| 인쇄에 트리 노출 | 중간 | `@media print`에 추가 (§1) |
| Windows accelerator 누락 | 중간 | `accelTable` 동기화 (§5) |
| 네트워크 드라이브 지연 | 낮음 | 폴더 노드에 로딩 상태 표시 |

---

## 7. 권장 범위

### v1 (권장 — 위 예산 안에 들어감)

루트 1개 · 지연 확장 · 클릭으로 열기 · 토글(메뉴+단축키) · 드래그 리사이즈 · localStorage 복원 · 포커스/수동 새로고침

### v2 (분리)

파일 감시 · 컨텍스트 메뉴(새 파일/이름 변경/삭제) · 이름 필터 · 다중 루트 · 활성 탭 자동 노출(reveal)

v2의 "삭제/이름 변경"은 성격이 다르다 — 파괴적 파일 조작이라 확인 절차·되돌리기·watcher 상호작용을 별도로 설계해야 하고, v1에 섞으면 검증 범위가 급격히 커진다.

---

## 8. 검증 계획

- `cd src-tauri && cargo test` — `read_dir` 캡·정렬·심볼릭 링크·숨김 판정 단위 테스트
- `npm run build` — 프런트 타입체크
- `npm run tauri build` 후 **바이너리 크기 전후 비교** (기준: v0.9.0 release ~3.3MB)
- 수동: 대형 디렉터리(`node_modules`) 펼침 응답성, 프리뷰 분할 비율 회귀, 인쇄 미리보기, Windows 단축키

크기 회귀 여부를 수치로 남기는 것이 이 기능에서는 특히 중요하다.

---

## 참고: 검토 시 확인한 파일

- `index.html` — 현재 DOM 구조(`#split` / `#editor-host` / `#divider` / `#preview-host`)
- `src/preview.ts:553-680` — 분할 비율 계산 및 divider 드래그
- `src/styles.css:262-320, 1096-1160` — 분할 레이아웃 및 인쇄 규칙
- `src/main.ts:84-96, 141-204` — focus 재검사 핸들러, Windows accelTable
- `src/ipc.ts`, `src/settings.ts` — IPC 및 localStorage 설정 패턴
- `src-tauri/src/watcher.rs` — 부모 디렉터리 감시 및 refcount 구조
- `src-tauri/src/commands/file.rs` — 대용량 가드(`read_guarded`) 패턴
- `src-tauri/Cargo.toml`, `package.json` — 현재 의존성 및 release 프로필
