# UniNotepad 소개·다운로드 사이트 (`site/`)

Vercel로 배포하는 정적 랜딩 페이지 + 다운로드 리다이렉트 함수입니다.
빌드 단계·프레임워크·의존성이 없습니다(순수 HTML/CSS/JS + 서버리스 함수 1개).

## 구성

| 파일 | 역할 |
|--|--|
| `index.html` | 랜딩 페이지 **영어판** (`/`). 기본 언어 |
| `ko.html` | 랜딩 페이지 **한국어판** (`/ko`). `cleanUrls`가 확장자를 떼 준다 |
| `assets/site.css` | 두 페이지가 공유하는 스타일 |
| `assets/site.js` | 두 페이지가 공유하는 스크립트 (OS 감지·라이트박스·복사 버튼·언어 스위처·히어로 영상 제어) |
| `api/download/[os].js` | 최신 릴리스 에셋을 파일명 접미사로 매칭해 302 리다이렉트. `/download/<os>`로 접근 |
| `vercel.json` | `/download/:os` → 함수 rewrite, `cleanUrls` |
| `assets/*.png` | 스크린샷·아이콘 (README/docs 갤러리에서 복제) |
| `assets/md-preview-v2.mp4` (+ `-poster.jpg`) | 히어로 lead shot의 데모 영상(파일타입 선택 → 작성 → 편집창 토글). 촬영은 `scripts/demo/` |

지원 OS 키: `mac-arm` · `mac-intel` · `windows` · `windows-exe` · `linux-deb` · `linux-rpm` · `linux-appimage`

## 이중 언어 규칙 — 반드시 지킬 것

- **`index.html`과 `ko.html`은 항상 함께 고친다.** 본문 마크업만 각자 갖고 있고 구조·id·클래스는
  동일해야 한다. 한쪽에만 섹션을 추가하면 다른 언어에서 그 내용이 통째로 사라진다.
- **`assets/site.css` · `assets/site.js`를 고치면 두 HTML의 `?v=` 숫자를 함께 올린다.**
  Vercel 엣지가 정적 자산을 캐시하므로, 올리지 않으면 배포해도 옛 파일이 계속 나간다.
- **영상·이미지에는 `?v=`가 안 걸려 있다** — 데모 영상을 다시 찍으면 쿼리를 붙이지 말고
  **파일명 자체의 버전을 올리고**(`md-preview-v2.mp4`) 두 HTML을 함께 고친다.
- **페이지 폭은 `site.css`의 `--page`(상한 1200px)와 `--gutter`(창 폭의 5%, 24~80px)
  두 값으로 정해진다.** 창이 좁으면 창에 맞춰 줄고 넓으면 1200px에서 멈춘다.
  **`--page`를 1400px 위로 올리지 말 것** — 스크린샷·데모 영상의 원본 가로폭이 1400px이라
  그보다 넓히면 히어로 영상이 확대되어 흐려진다. 더 넓히려면 자산부터 다시 찍어야 한다.
  본문 텍스트는 이 폭을 따르지 않는다(각 블록이 34~48rem 상한을 따로 갖는다).
- **본문 문구는 HTML에, JS가 만들어 내는 문구만 `site.js`의 `T` 사전에** 둔다
  (추천 배지 · 복사 버튼 · 히어로 다운로드 라벨 · 썸네일 aria-label).
- **언어는 URL이 정한다** — `/`는 영어, `/ko`는 한국어. 선택을 저장하지도, 자동으로
  다른 언어로 보내지도 않는다. 예전에는 `localStorage`에 기억해 두고 `<head>` 인라인
  스크립트가 되돌렸는데, 한 번의 클릭이 영구 고정으로 남아 영어 주소를 직접 열어도
  `/ko`로 튕겼다. 자동 이동을 다시 넣지 말 것.
- 한국어 브라우저에는 영어 페이지에서 안내 줄(`#langNudge`)만 보여 준다 — 안내일 뿐
  이동은 클릭한 사람만 한다.
- 새 섹션에 `id`를 달면 양쪽에 같은 `id`로 단다 — 스위처가 현재 해시를 그대로 이어 붙인다.

## 배포 — Vercel CLI 수동 실행

**GitHub↔Vercel Git 연동은 해제되어 있습니다. `main`에 push해도 사이트는 바뀌지 않습니다.**
`site/`를 고쳤다면 아래를 직접 실행해야 반영됩니다.

```bash
npm i -g vercel   # 최초 1회
# 리포 루트에서 실행할 것 — Vercel 프로젝트가 루트에 링크되어 있고(/.vercel),
# 루트 .vercelignore가 배포 대상을 걸러 낸다. `cd site` 후 실행하면 안 된다.
vercel --prod     # 프로덕션 배포 (https://uninotepad-xi.vercel.app/)
```

`vercel`(플래그 없이)은 프리뷰 배포이며, 최초 실행 시 로그인·프로젝트 연결을 물어봅니다.

<details>
<summary>참고: Git 연동을 다시 켜려면</summary>

Vercel 대시보드에서 프로젝트 **Settings → Git**으로 저장소를 연결하고 **Root Directory**를 `site/`로
지정하면(Framework Preset은 **Other**), 이후 `main` push마다 자동 배포되고 PR마다 프리뷰가 생깁니다.
</details>

## 선택: GitHub API 레이트리밋 완화
다운로드 함수는 미인증 GitHub API(IP당 60회/시)를 쓰고, 응답을 엣지에서 1시간 캐시합니다.
트래픽이 많다면 Vercel 프로젝트 **Settings → Environment Variables**에 `GITHUB_TOKEN`
(public_repo 읽기 권한 PAT)을 추가하면 한도가 크게 올라갑니다.

## 배포 후 할 일
- README의 소개/갤러리 링크를 새 Vercel 주소로 교체.
- 기존 GitHub Pages 갤러리(`docs/`)는 이 페이지의 "화면" 섹션으로 흡수되었으므로,
  Pages를 은퇴시키거나 `docs/index.html`을 Vercel 주소로 리다이렉트.
- (선택) Vercel에서 커스텀 도메인 연결.

## 로컬 미리보기
리포 루트에서 `vercel dev` → http://localhost:3000
(`/ko`와 `/download/<os>`는 Vercel 런타임의 `cleanUrls`·rewrite가 있어야 동작합니다)

정적 부분만 급히 보려면 `cd site && python3 -m http.server 8000` — 다만 이때 한국어 페이지는
`/ko`가 아니라 `/ko.html`로 열어야 합니다.
