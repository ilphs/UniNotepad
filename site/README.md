# UniNotepad 소개·다운로드 사이트 (`site/`)

Vercel로 배포하는 정적 랜딩 페이지 + 다운로드 리다이렉트 함수입니다.
빌드 단계·프레임워크·의존성이 없습니다(순수 HTML/CSS/JS + 서버리스 함수 1개).

## 구성

| 파일 | 역할 |
|--|--|
| `index.html` | 랜딩 페이지 (히어로·다운로드·기능·화면·FAQ). 방문 OS를 감지해 알맞은 다운로드 버튼을 강조 |
| `api/download/[os].js` | 최신 릴리스 에셋을 파일명 접미사로 매칭해 302 리다이렉트. `/download/<os>`로 접근 |
| `vercel.json` | `/download/:os` → 함수 rewrite, `cleanUrls` |
| `assets/` | 스크린샷·아이콘 (README/docs 갤러리에서 복제) |

지원 OS 키: `mac-arm` · `mac-intel` · `windows` · `windows-exe` · `linux-deb` · `linux-rpm` · `linux-appimage`

## 배포 — Vercel CLI 수동 실행

**GitHub↔Vercel Git 연동은 해제되어 있습니다. `main`에 push해도 사이트는 바뀌지 않습니다.**
`site/`를 고쳤다면 아래를 직접 실행해야 반영됩니다.

```bash
npm i -g vercel   # 최초 1회
cd site
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
정적 부분만 보려면: `cd site && python3 -m http.server 8000` → http://localhost:8000
(다운로드 리다이렉트 함수는 Vercel 런타임이 필요하므로 `vercel dev`로 확인)
