---
id: theme-multi-palette
title: 내장 테마 10종 × dark/light/system
type: design
version: 1.0.0
status: approved
scope: 에디터/앱 팔레트를 테마 축과 명암 축으로 분리하고 내장 테마를 10종으로 확장한다
related: []
updated: 2026-08-19
---

# 내장 테마 10종 × dark/light/system — 설계서

> **구현 완료 (2026-08-19).** 이 문서는 as-built로 갱신됐다. 설계 시점의 추정치는
> 실측값으로 교체했고, 구현 중 드러나 설계가 틀렸던 지점은 §10에 남겼다 —
> 지우지 않은 이유는 같은 함정을 다음에 다시 밟지 않기 위해서다.
>
> 검증: `npm run build` OK · `cargo test` 39 passed · `scripts/themes/audit.py`
> 20블록 4게이트 PASS · 테마 로직 런타임 37케이스 PASS (§9)

## Context

기존 UniNotepad의 테마는 Light / Dark(Dracula) / System 3택이었고, "Light"와 "Dark"가 곧 서로 다른 두 팔레트였다. 즉 **테마 선택과 명암 선택이 한 축에 뒤섞여 있었다.** 테마를 늘리려 해도 이 구조에서는 늘릴 자리가 없었다.

이 설계는 축을 둘로 분리한다.

- **축 1 — 테마**: Dracula 포함 **10종**
- **축 2 — 명암**: 각 테마마다 **dark / light / system**

(Ghostty 연동은 이번 범위에서 제외했다.)

---

## 1. 착수 시점의 구조 — 이 작업에 유리했다

| 사실 | 근거 |
|---|---|
| 테마 관련 npm 패키지 **0개**. Dracula는 CSS 값으로만 존재 | `package.json`에 `@uiw/*`·`thememirror`·`theme-one-dark` 없음 |
| 팔레트 = **CSS 변수 26개**가 전부 | 구 `src/styles.css:1-108` |
| `HighlightStyle`의 색이 전부 `var(--cm-*)` 문자열 | `src/language.ts` |
| 에디터 chrome(거터/캐럿/선택영역)도 CSS 변수로 오버라이드 | 구 `src/styles.css:703-745` |
| 테마 전환 = `<html data-theme>` 속성 하나 | 구 `src/theme.ts` (전체 39줄) |

**핵심 함의: CodeMirror를 전혀 건드리지 않아도 된다.** theme compartment도, `reconfigureAll()` 호출도 불필요하다. CSS 변수 블록만 늘리면 에디터·탭바·상태바·마크다운 프리뷰가 한꺼번에 따라온다. **이 예측은 구현에서 그대로 맞았다** — `editor.ts`·`language.ts`는 한 줄도 바뀌지 않았다.

이 작업의 실질은 **팔레트 값을 채우는 일**이지 배선을 새로 놓는 일이 아니다.

> ⚠️ 설계 초안은 변수를 "24개"로 적었다. 실제 현행은 **26개**였고, §4-a의 신설 2개를 더해 최종 **28개**다. 이 숫자는 감사 스크립트의 누락 검사 기준이므로 정확해야 한다.

---

## 2. 설계 — 2축 모델

### 상태

```
uninotepad.theme      = "dracula" | "github" | ...     (패밀리 10종)
uninotepad.themeMode  = "dark" | "light" | "system"
```

두 값을 합성해 `<html data-theme="dracula-dark">` 형태로 세팅한다. CSS는 `:root[data-theme="dracula-dark"] { ... }` 블록 20개를 갖는다.

`theme.ts`는 39줄짜리 단일 책임 모듈이었고, 저장 패턴은 다른 설정들과 동일했다. 그 형태를 유지한 채 값만 2개로 늘렸다(as-built 159줄 — 늘어난 분량은 마이그레이션·OS 리스너·주석이다).

### System 처리 — 미디어쿼리 복제를 없앤다

기존 `system`은 `data-theme` 속성을 지우고 `@media (prefers-color-scheme: dark)` 블록이 dark 블록을 **손으로 복제**하는 구조였다(구 `styles.css:74-107`, 주석에도 "keep in sync"라고 적혀 있었다). 2축이 되면 이 복제가 10배가 된다.

> **해결**: `theme.ts`가 `matchMedia("(prefers-color-scheme: dark)")`를 구독해 `system`을 **JS에서** 해석하고, 항상 구체적인 `data-theme="<family>-<mode>"`를 세팅한다. OS 명암이 바뀌면 리스너가 즉시 갱신한다.
> → **미디어쿼리 복제 블록이 통째로 사라졌다.** 테마가 10종이어도 CSS 블록은 딱 20개다.

**as-built 보강 2건:**

- `MediaQueryList`를 모듈 상수(`OS_DARK`)로 잡아둔다. 참조가 없는 MQL이 GC되어 리스너가 조용히 죽는 WebKit 사례가 알려져 있고, 이제 라이브 전환이 **이 객체 하나에만** 의존하기 때문이다. 이전에는 CSS가 담당해 GC 대상이 아니었다 — 구조가 바뀌며 위험 프로파일도 바뀌었다.
- `themes.css`의 `dracula-dark` 블록에 **맨 `:root` 별칭**을 붙였다. 팔레트 블록이 전부 `[data-theme]` 조건부가 되면서, deferred 모듈 스크립트가 실행되기 전에 페인트되는 프레임에서는 `var()`가 전부 무효가 되어 **무팔레트(흰 배경/검정 글자)** 로 렌더될 수 있다. 구 스타일시트도 같은 안전망을 갖고 있었다(무조건 `:root`가 light 팔레트를 들고 있었다). 폴백을 기본 테마로 두면 손대지 않은 다수 사용자는 어긋난 프레임을 아예 보지 않는다.

`applyStoredTheme()`는 `main.ts` 임포트 시점에 호출되므로 플래시 노출은 최소다.

### UI

**네이티브 메뉴** — `src-tauri/src/menu.rs`. 한 서브메뉴 안에서 두 축을 구분선으로 나눈다. 기존 `MenuItemBuilder`는 선택 표시가 없어 **`CheckMenuItemBuilder`로 교체**해 현재 값을 표시한다.

```
View ▸ Theme
 ├ ● Dracula      ○ GitHub       ○ Solarized
 ├ ○ Gruvbox      ○ Catppuccin   ○ Nord
 ├ ○ Tokyo Night  ○ One Half     ○ Rosé Pine
 ├ ○ Kanagawa
 ├──────────────────────
 ├ ○ Light   ● Dark   ○ System        ← 명암 축
```

**메뉴 id 계약** — 패밀리 `view.theme.<family>`, 모드 `view.themeMode.<mode>`. 구 id(`view.themeLight`/`Dark`/`System`)는 제거했다.
같은 10개 id가 **다섯 곳**에 존재한다: `themes.ts`의 유니온 타입, `themes.ts`의 `THEMES[].id`, `menu.rs`의 `THEME_FAMILIES`, `themes.css`의 블록 이름, `menu.ts`의 prefix 분기. 하나라도 어긋나면 그 테마는 조용히 무시되거나 팔레트가 안 먹는다.

> 함정: `"view.themeMode.dark".startsWith("view.theme.")`는 **false**다(11번째 문자가 `.`가 아니라 `M`). 두 prefix 분기의 순서가 뒤바뀌어도 안전하지만, 한 글자 차이로 성립하는 안전이다.

**체크마크 동기화** — 체크 상태는 Rust가 소유하지만 값은 프런트(localStorage)가 소유한다. Rust가 기본값으로 메뉴를 빌드한 뒤, 프런트가 시작 시 1회 + 변경 시마다 `set_theme_menu`로 밀어 넣는다(`set_recent_files`와 같은 패턴). 메뉴는 값을 **따라가지 이끌지 않는다.**

이때 recent-files와 테마가 **같은 전체 리빌드 경로**를 공유한다는 문제가 생긴다. 각자 자기 값만 알고 리빌드하면 상대의 상태를 지운다. → `MenuState { recent, family, mode }`를 managed state로 두고, 두 커맨드가 자기 필드만 갱신한 뒤 공통 헬퍼로 리빌드한다. 헬퍼는 lock을 잡고 값을 복제한 뒤 **lock을 놓고 나서** 메뉴를 빌드한다(메뉴 생성이 Tauri로 재진입하므로 데드락 방지).

**Preferences 모달** — Appearance 섹션에 `selectRow` 두 개(Theme / Appearance). `modal.ts`의 기존 헬퍼를 그대로 쓴다.

세 진입점(메뉴 / Preferences / 시작 시 복원) 모두 같은 `setThemeFamily()`/`setThemeMode()`를 호출하므로 저장·적용·메뉴 동기화는 자동이다. 단 **Preferences 모달은 `uninotepad:themechange`를 구독해야 한다** — HTML 모달이 떠 있어도 네이티브 메뉴는 살아 있어서, 메뉴로 테마를 바꾸면 모달의 `<select>`가 낡은 값을 표시하기 때문이다(`selectRow`는 값을 생성 시점 스냅샷으로만 받는다).

> 축이 서로를 오염시키지 않는 것은 `commit()`이 두 값을 **localStorage에서 다시 읽어** 합성하기 때문이다. 낡은 UI 스냅샷에서 한 축만 바꿔도 다른 축은 저장된 값을 유지한다.

---

## 3. 내장 10종

선정 기준은 **공식 dark/light 짝이 둘 다 존재**하고 **팔레트를 자유롭게 쓸 수 있을 것**이다.

| # | 패밀리 | id | dark / light | 출처 | 라이선스 |
|---|---|---|---|---|---|
| 1 | **Dracula** | `dracula` | Dracula / *자체 파생* | `spec.draculatheme.com` | MIT |
| 2 | **GitHub** | `github` | Dark Default / Light Default | `primer/github-vscode-theme` | MIT |
| 3 | **Solarized** | `solarized` | Dark / Light | `ethanschoonover.com/solarized` | MIT |
| 4 | **Gruvbox** | `gruvbox` | Dark / Light | `morhetz/gruvbox` | MIT |
| 5 | **Catppuccin** | `catppuccin` | Mocha / Latte | `catppuccin/catppuccin` | MIT |
| 6 | **Nord** | `nord` | Polar Night / Snow Storm | `nordtheme.com` | MIT |
| 7 | **Tokyo Night** | `tokyo-night` | Night / Day | `folke/tokyonight.nvim` | MIT |
| 8 | **One Half** | `one-half` | Dark / Light | `sonph/onehalf` | MIT |
| 9 | **Rosé Pine** | `rose-pine` | Rosé Pine / Dawn | `rosepinetheme.com` | MIT |
| 10 | **Kanagawa** | `kanagawa` | Wave / Lotus | `rebelot/kanagawa.nvim` | MIT |

**Dracula는 검증된 값이 이미 있었다** — `spec.draculatheme.com` 기준 배경 `#282A36`, 전경 `#F8F8F2`, 선택 `#44475A`, 주석 `#6272A4`, red `#FF5555`, yellow `#F1FA8C`, green `#50FA7B`, purple `#BD93F9`, cyan `#8BE9FD`, pink `#FF79C6`. 구 `styles.css` dark 블록과 정확히 일치했으므로 `dracula-dark`는 **그대로 옮겼다**(골든, §9-1).

**출처 정정 (as-built)** — Tokyo Night의 근거를 `enkia/tokyo-night-vscode-theme`에서 `folke/tokyonight.nvim`으로 바꿨다. enkia의 light는 bg `#e6e7ed`/fg `#343b59`인데, 널리 통용되는 Tokyo Night Day 값은 folke 쪽(`#e1e2e7`/`#3760bf`)이다. folke Day는 upstream이 이미 대비를 튜닝해 두어 **보정이 0건**이었다.

### ⚠ Monokai Pro는 제외했다

후보로 검토했으나 **Monokai Pro는 유료 상품**이고 팔레트 재사용 라이선스가 불명확하다. 같은 이유로 아래 Dracula의 Alucard도 제외하므로, 일관성을 위해 Kanagawa(MIT, 공식 dark/light 양쪽 존재)로 대체했다.
→ Monokai 계열을 원한다면 **클래식 Monokai**(2006, Wimer Hazenberg)가 대안이지만 공식 라이트 변형이 없어 Dracula와 같은 자체 파생 문제가 생긴다.

### ⚠ Dracula의 light 짝이 존재하지 않는다

- Dracula의 공식 라이트 테마는 **Alucard**인데 **Dracula PRO(유료 상품)의 일부**다. 공개 스펙(`spec.draculatheme.com`)에도 없다. → **번들 불가**.
- 널리 쓰이는 Ghostty 테마 컬렉션 463종을 전수 확인했으나 **라이트 배경 Dracula 계열이 하나도 없다**(`Dracula+`도 배경 `#212121`로 다크다).

> **해법**: Dracula의 6개 액센트 **색조(hue)를 유지**한 채 명도·채도만 라이트 배경에 맞게 재조정한 자체 파생 변형 **"Dracula Light"**를 만든다.
> **as-built**: 색조 이탈 0.2° 이내, 채도 상한 0.68로 재조정했다. 역할 매핑(keyword=핑크, string=노랑→올리브, number/accent=보라, function=초록, type=청록, invalid=빨강)을 보존했고, `--bg`/`--fg`는 공식 Dracula의 전경/배경을 **뒤집어** 써서 표면색까지 공식 팔레트 안에 머문다. comment는 공식 `#6272a4`가 밝은 배경에서 4.41:1로 이미 통과해 무보정.
> 10종 중 자체 제작이 필요한 건 **이것 하나뿐**이다.

### ⚠ 라이트 변형은 대비가 잘 깨진다 — 예측대로였다

라이트 테마의 액센트 색(문자열·함수·타입)이 흰 배경에서 3:1을 못 넘기는 경우가 흔할 것이라 예측했고, **실제로 그랬다.**

| | 명도 보정 | 공식 토큰 교체 |
|---|---|---|
| dark 블록 10개 | **2건** (nord-dark / one-half-dark의 comment뿐) | 0건 |
| light 블록 10개 | **15건** | 3건 |

가장 심한 곳은 `nord-light`다. Nord는 공식 라이트 **syntax** 테마가 없어 표면색만 Snow Storm이고, Frost/Aurora 액센트를 nord6 위에 올리면 1.74~2.46:1까지 떨어진다. 액센트 4종을 크게 내렸다.

보정 방식은 **HSL 명도만 이동**(색조 이탈 전부 ≤ 1.07°, 1°에 근접한 3건은 채도가 매우 낮은 회색 계열이라 색상각이 수치적으로 불안정한 경우)이다. 임의 hex를 만드는 대신 **같은 팔레트의 다른 공식 토큰으로 교체**한 것이 3건 있다:

| 블록 | 토큰 | 기본 후보 → 채택 | 대비 |
|---|---|---|---|
| solarized-light | `--fg` | base00 `#657b83` → base01 `#586e75` | 4.13 → 4.99 |
| solarized-light | `--cm-comment` | base1 `#93a1a1` → base0 `#839496` | 2.48 → 2.93 |
| catppuccin-light | `--cm-comment` | overlay0 `#9ca0b0` → overlay1 `#8c8fa1` | 2.30 → 2.83 |

`solarized-dark`는 공식 base0 `#839496`가 base03 대비 4.75:1로 이미 통과해 **보정 0건**이다.

### 경량성 영향 — 실측

이 앱의 정체성은 "경량"이므로 테마 확장이 그 약속을 깎는지 실측했다. 아래는 **설계 시점의 예측과 구현 후 실측을 나란히 둔 것**이다.

| 항목 | 착수 시점 | 예측 | **실측** | 실제 증가 |
|---|---|---|---|---|
| 빌드 CSS (minified) | 17.3 kB | 32.0 kB | **27.8 kB** | +10.5 kB |
| 빌드 CSS (min+gzip) | 4.2 kB | 7.8 kB | **7.0 kB** | +2.8 kB |
| 릴리즈 바이너리(≈3.3 MB) 비중 | — | — | — | **+0.3%** |
| 런타임 비용 | — | 0 | **0** | 0 |
| 추가 의존성 | — | 0개 | **0개** | 0개 |

예측보다 가벼운 이유는 **미디어쿼리 복제 블록이 사라졌기 때문**이다. 예측은 20블록을 순수 추가로 잡았지만 실제로는 기존 3블록 + 화이트스페이스 분기 3쌍이 함께 제거됐다.

- **런타임이 0인 이유**: 팔레트가 CSS 변수라 파싱 후 상수다. JS도, CodeMirror 확장도 늘지 않는다. 오히려 CSS 규칙 수는 줄었다.
- **의존성 0개가 핵심**이다. `@uiw/codemirror-themes` 같은 패키지를 썼다면 수백 KB와 트리셰이킹 문제가 따라붙었을 텐데, 이 앱은 팔레트를 이미 CSS 변수로 뽑아둔 덕에 그럴 필요가 없었다.

> **결론: 10종을 유지한다.** 무게는 무의미한 수준이고 검증 노동은 자동화되므로, 종 수를 줄여 얻을 실익이 없다.
>
> 단 **2축 분리 자체는 테마 수와 무관하게 수행한다.** 그것은 기능 추가가 아니라 결함 수정이다 — 기존에는 "Light를 고르면 팔레트도 함께 바뀌는" 축 혼선이 있었고, dark 블록을 손으로 복제한 미디어쿼리 부채가 있었다.

---

## 4. 곁가지로 반드시 고쳐야 했던 것

**(a) `[data-theme="dark"]`로 색을 갈아끼우던 두 규칙** — 구 `styles.css:754-775`. 탭 화살표 SVG(data URI라 `var()` 불가)와 trailing-space 표시가 변수를 쓰지 않고 셀렉터로 분기했다. 블록이 20개가 되면 이 방식은 무너진다.

> **변수 2개(`--ws-mark`, `--trailing-mark`)를 신설**해 규칙 하나로 통일했다. 팔레트 변수 26 → **28개**.
>
> **SVG 처리 (as-built)**: `stroke="currentColor"`는 **동작하지 않는다** — data URI SVG를 `background-image`로 쓰면 호스트 요소의 `color`가 상속되지 않는다. 대신 **mask 방식**을 썼다: `background-color: var(--ws-mark)` + SVG를 `mask-image`로. 이때 CM의 `background-size/position/repeat` 기본값(`auto 100%` / `right 90%` / `no-repeat`)을 `mask-*`에 그대로 복제해야 한다 — 빠뜨리면 화살표가 늘어나고 타일링된다. `-webkit-` 접두사판을 무접두사판보다 먼저 둔다.

**(b) `effectiveDark()`의 문자열 비교** — `src/preview.ts`가 `dataset.theme === "dark"`를 직접 비교했다. `data-theme`이 `"dracula-dark"` 형태가 되면 깨진다. **`theme.ts`의 `resolvedMode()`를 쓰도록** 바꿨다. (Mermaid 다크/라이트 판정에 쓰인다.)

**(c) CSS 분량** — 28변수 × 20블록 ≈ 992줄. 팔레트를 **`src/themes.css`로 분리**하고 `styles.css`가 최상단에서 `@import`한다(Vite가 인라인하므로 단일 파일로 배포된다). `@import`는 `@charset` 외 모든 규칙보다 앞서야 하는데, 앞에 있는 것은 주석뿐이라 규칙 위반이 아니다.

**(d) 구현 중 추가 발견 2건** — §10 참조.

---

## 5. 마이그레이션

기존 `localStorage["uninotepad.theme"]` 값을 2축으로 승계한다.

| 기존 | 신규 | 시각적 연속성 |
|---|---|---|
| `"dark"` | `dracula` + `dark` | **완전 동일** (골든) |
| `"light"` | `github` + `light` | 구 light 팔레트가 GitHub Light 계열이라 거의 동일 |
| `"system"` | `dracula` + `system` | 다크는 동일, **라이트는 GitHub Light → Dracula Light로 바뀜** |

마지막 항목만 눈에 띄는 변화다. 기본 패밀리를 Dracula로 두는 편이 앱 정체성에 맞다고 보아 이 쪽을 택했다 — 릴리즈 노트에 명시한다.

값이 없거나 알 수 없는 값이면 `dracula` + `dark`(구 기본값과 동일)로 떨어진다.

**as-built 세부:**

- **감지 방식** — 별도 버전 플래그를 두지 않고 "family 키가 구값을 들고 있는가"로 판별한다. 구값 3종은 10개 family id와 서로소라 모호함이 없다. 두 키를 모두 덮어써 확정하므로 **1회성**이다(이후 `isThemeFamily` 가드에서 즉시 리턴 → 사용자의 이후 선택을 덮지 않는다).
- **프로토타입 체인** — 매핑 테이블 조회는 `hasOwnProperty` 검사를 거친다. `"constructor"`/`"toString"`/`"__proto__"` 같은 값이 들어오면 평범한 조회는 `Object.prototype` 멤버를 찾아내 폴백을 건너뛰고 두 키에 문자열 `"undefined"`를 기록한다.
- **`github-light`의 `--fg`** — 구 `#1e1e1e`가 아니라 Primer 공식값 `#1f2328`을 썼다. 골든 규약은 `dracula-dark`에만 걸리고 지각 임계 이하 차이지만, 구 light 사용자에게는 글자 단위로 바뀌는 유일한 값이다. 나머지 구 light 값(chrome/tab/accent/배너/syntax 10종/gutter/caret/selection)은 전부 그대로 승계했다.
- **알려진 경계** — 마이그레이션이 `themeMode` 키를 무조건 덮어쓴다. "신버전 사용 → 구버전으로 다운그레이드(구버전이 family 키에 `"light"` 기록) → 재업그레이드" 경로에서만 사용자가 고른 모드가 버려진다. 도달 경로가 사실상 없어 그대로 둔다.

---

## 6. 검증 도구 — 감사 스크립트

`scripts/themes/audit.py` (개발 도구, 빌드 파이프라인 아님, 표준 라이브러리만 사용). `src/themes.css`를 파싱해 검사한다.

```bash
python3 scripts/themes/audit.py [path] [--verbose]   # 실패 시 exit 1
```

1. **변수 누락** — 20블록 전부가 28개 변수를 빠짐없이, 그리고 규격 외 변수 없이 정의하는지. 하나라도 빠지면 캐스케이드를 타고 다른 테마 값이 새어 들어오는데, 화면을 봐도 "원래 이런 색인가?" 싶어 눈치채기 어렵다. 블록 자체의 누락·중복·과잉도 잡는다.
2. **대비 하한** — WCAG 상대휘도 기준, `--bg` 대비. 주석 2.5:1, 액센트 6종 3.0:1, `--fg` 4.5:1.
3. **chrome 구분** — 모든 블록에서 `--chrome-bg ≠ --bg`, `--tab-active-bg ≠ --tab-inactive-bg`. 탭바가 에디터에 묻히거나 활성/비활성 탭이 구분되지 않는 회귀를 막는다.
4. **골든** — `dracula-dark` 28개 값이 §9-1이 못박은 값과 정확히 일치하는지. 색 비교는 정규화 후 값 단위로 한다(`#rgb`/`#rrggbbaa`/`rgba()` 포매팅 차이는 통과).

추가로 파일에 `@media`가 하나라도 있으면 실패시킨다 — system을 JS가 해석하는 설계(§2)에서 조건부 블록의 존재 자체가 위반이자 복제 부채의 재발이다.

**모든 검사는 주석을 걷어낸 텍스트 위에서 돈다.** `themes.css` 헤더가 "왜 @media를 쓰지 않는가"를 산문으로 설명하는데, 원문을 스캔하면 그 산문이 규칙으로 오인된다(실제로 초판이 이 오탐을 냈다). **주석에 반응하는 게이트는 신뢰를 잃고 결국 무시당한다.**

> ⚠️ **이 게이트의 사각지대**: `--trailing-mark`의 알파(28%)는 `styles.css`의 규칙에 상수로 있어 `themes.css`를 파싱하는 골든 검사가 **원리적으로 볼 수 없다**. 이 값을 바꾸면 골든 보장이 조용히 깨진다 — 해당 규칙에 경고 주석을 달아 두었다.

---

## 7. 변경 대상 파일 (as-built)

| 파일 | 변경 |
|---|---|
| `src/themes.css` | **신규 992줄** — 10패밀리 × 2모드 = 20블록 × 28변수 |
| `src/themes.ts` | **신규 83줄** — `{ id, label }` 레지스트리 + 타입 가드 (메뉴·Preferences가 참조) |
| `src/theme.ts` | 2축 재작성(39→159줄). System을 JS에서 해석, 구버전 마이그레이션, 메뉴 동기화 |
| `src/styles.css` | 팔레트 블록 이관(`@import`), 미디어쿼리 복제 제거, `--ws-mark`/`--trailing-mark` 도입, 화이트스페이스 규칙 mask 전환 |
| `src/preferences.ts` | Theme/Appearance `selectRow` 2개 + `themechange` 구독으로 select 갱신 |
| `src/menu.ts` | 구 case 3개 제거, `view.theme.` / `view.themeMode.` prefix 분기 |
| `src/preview.ts` | `effectiveDark()`를 `resolvedMode()` 기반으로, 중복 `matchMedia` 구독 제거 |
| `src/ipc.ts` | `syncThemeMenu()` best-effort 래퍼 |
| `src/main.ts` | 주석만 (구 "system은 CSS 폴백" 설명이 거짓이 됨) |
| `src-tauri/src/menu.rs` | `THEME_FAMILIES`/`THEME_MODES` 상수, 서브메뉴 `CheckMenuItemBuilder` 전환 |
| `src-tauri/src/lib.rs` | `MenuState` managed state, `rebuild_menu()` 공통 헬퍼, `set_theme_menu` 커맨드 |
| `scripts/themes/audit.py` | **신규 508줄** — 대비·chrome·누락·골든 + `@media` 가드 |

기존 자산 재사용: `modal.ts`의 `selectRow`, `theme.ts`의 `uninotepad:themechange` 이벤트, `set_recent_files`의 메뉴 리빌드 패턴.

Rust 변경은 메뉴 정의와 상태 관리뿐이고, 새 플러그인·권한은 없다(커맨드 1개 추가).
`editor.ts`·`language.ts`는 **한 줄도 바뀌지 않았다** — §1의 예측대로다.

---

## 8. 리스크 — 실제로 어떻게 됐나

| 예측한 리스크 | 결과 |
|---|---|
| **팔레트 값 큐레이션이 실질 부피** | 그대로 적중. 28변수 × 20블록이 이 작업 분량의 대부분이었다. 터미널 ANSI 16색에서 유도하는 자동 변환은 검증 결과 쓸 수 없었다 — Dracula에서만 우연히 맞고 GitHub Light에서는 keyword가 빨강→보라, string이 초록→갈색으로 **역할이 통째로 뒤바뀐다.** 공식 스펙을 직접 조회해 역할 매핑까지 확인하는 수밖에 없었다. |
| **Dracula Light는 원본 없는 자체 파생** | 그대로. 파일 주석과 이 문서에 "공식 아님"을 명시했다. |
| **`data-theme` 값 형식 변경** | 문자열 비교처는 `preview.ts` 한 곳뿐이었고 §4-b에서 처리했다. 구 API(`themeChoice`/`setTheme`)·구 메뉴 id의 잔존 참조는 리포 전체(`vscode-ext/`·`site/`·문서 포함) 검색 결과 **0건**. |

예측하지 못했던 것은 §10에 있다.

---

## 9. 검증 — 결과

> 팔레트별 GUI 스크린샷 촬영은 하지 않는다. 팔레트 품질은 §6의 감사 스크립트가 수치로 판정하며, 그것이 유일한 게이트다.

| # | 항목 | 결과 |
|---|---|---|
| 1 | **골든** — `dracula-dark`가 구 `styles.css` dark 블록과 값 단위로 동일. 기본 사용자에게는 픽셀 하나도 바뀌면 안 된다 | ✅ 28/28 일치 |
| 2 | **감사 스크립트** — §6의 검사 전부 통과 | ✅ 20 blocks, 4 checks PASS |
| 3 | `npm run build` (tsc --noEmit + vite build) / `cargo test` | ✅ exit 0 / 39 passed |
| 4 | **System 라이브 전환** — 모드가 system일 때 OS 명암 변경이 즉시 반영되고, system이 아닐 때는 무반응 | ✅ 로직 실행 검증 |
| 5 | **마이그레이션** — §5 표대로 승계 | ✅ 구값 3종 + 빈 값 + 미지값 + 프로토타입 키 3종 + 부분 저장 |
| 6 | **프리뷰 연동** — 팔레트 변수 정의/사용 정합 | ✅ 미사용 변수 0개, 미정의 변수 0개 |

**4·5번 검증 방식** — GUI 없이 `theme.ts`를 실제로 실행했다. `localStorage`/`matchMedia`/`document`를 스텁한 뒤 esbuild로 번들해 Node에서 돌리는 방식으로, **37개 케이스 전부 통과**했다. 축 독립성(한 축을 바꿔도 다른 축 보존)과 메뉴 동기화 호출값까지 포함한다.

**감사 스크립트 자체의 실효성** — 통과만 확인하면 아무것도 안 잡는 검사기를 통과로 오인한다. 의도적으로 망가뜨린 픽스처로 각 검사가 실제로 실패를 잡는지 확인했다: 변수 누락 / 대비 미달 / chrome 충돌 / 골든 변조 / `@media` 삽입 / 블록 전체 누락 — **6종 전부 검출**.

**미검증 (실기 필요)** — 네이티브 메뉴 체크마크의 실제 표시, 플랫폼별 mask 렌더링(WKWebView/WebView2/WebKitGTK), OS 외관 변경의 실제 반영.

---

## 10. 구현에서 드러난 것 — 설계가 몰랐던 것

설계서를 그대로 따랐다면 조용히 남았을 결함들이다.

**(a) `.cm-highlightSpace:before`는 죽은 코드였다.** 구 `styles.css`는 공백 점 색을 `:before { color: … }`로 지정했지만, 설치된 CodeMirror(6.43.6)는 점을 `radial-gradient(circle at 50% 55%, #aaa 20%, transparent 5%)`로 그리고 `:before`를 쓰지 않는다. 설계대로 "`:before`의 색만 변수로 교체"했다면 **공백 점이 20개 팔레트 전부에서 `#aaa`로 하드코딩된 채** 남았을 것이다. 그래디언트 자체를 재선언했다.

**(b) `preview.ts`에 `matchMedia` 구독이 하나 더 있었다.** `theme.ts`가 OS 구독을 소유하고 `themechange`를 쏘게 되면서, 이 구독을 그대로 뒀다면 OS 명암 전환마다 mermaid가 **두 번** 렌더된다. 제거하고 단일 이벤트로 수렴시켰다.

**(c) `CheckMenuItemBuilder`의 `checked` 기본값은 `true`다.** 명시하지 않으면 패밀리 10개가 전부 체크된 채로 보인다. 13개 항목 전부에 명시했다.

**(d) 감사 스크립트가 자기 검사 대상의 주석에 반응했다.** §6에 기록.

**(e) 설계 계약의 오류 — `--trailing-mark` 알파.** 알파를 규칙에 25%로 고정하도록 정했는데, 구 dark는 **28%**(light는 22%)였다. §9-1이 `dracula-dark`에 "픽셀 하나도 바뀌면 안 된다"고 못박은 것을 3%p 어긴 셈이다. 28%로 되돌렸다. 이 상수는 `themes.css` 밖에 있어 골든 게이트가 못 본다는 점이 문제의 본질이다(§6 사각지대).

---

## 11. 남은 판단 사항

구현을 막지 않지만 기록해 둔다.

- **`--gutter-fg`의 대비** — 이 변수는 라인번호 외에 blockquote 본문, foldPlaceholder, 그리고 **h1~h5 색상의 40% 혼합 성분**으로도 쓰인다. light 계열 3종(kanagawa 2.23:1, catppuccin 2.30:1, tokyo-night 2.42:1)에서 낮고, `color-mix` 후 헤딩이 3.0:1 아래로 떨어지는 조합이 22건 있다.
  **회귀는 아니다** — 구 light의 `--gutter-fg: #9aa0a6`도 흰 배경에서 약 2.3:1이었고 혼합 공식도 기존 것이다. 감사 게이트를 `--gutter-fg`까지 넓힐지는 별건이다.
- **`github-light`의 `--fg`** (§5) — Primer 공식값을 택했다. 마이그레이션 연속성을 글자 단위로 지키려면 `#1e1e1e`로 되돌리면 된다(대비 15.80 → 15.30, 게이트 영향 없음).
- **마이그레이션의 다운그레이드 경계** (§5) — 도달 경로가 사실상 없어 그대로 뒀다.
