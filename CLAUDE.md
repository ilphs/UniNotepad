# Claude Code 개발 가이드

> 공통 규칙(Agent Delegation, 커밋 정책, Context DB 등)은 글로벌 설정(`~/.claude/CLAUDE.md`)을 따릅니다.
> 글로벌 미설치 시: `curl -fsSL https://raw.githubusercontent.com/leonardo204/dotclaude/main/install.sh | bash`

---

## Slim 정책

이 파일은 **100줄 이하**를 유지한다. 새 지침 추가 시:
1. 매 턴 참조 필요 → 이 파일에 1줄 추가
2. 상세/예시/테이블 → ref-docs/*.md에 작성 후 여기서 참조
3. ref-docs 헤더: `# 제목 — 한 줄 설명` (모델이 첫 줄만 보고 필요 여부 판단)

---

## PROJECT

### 개요

**UniNotepad** — 탭 + Notepad++ 스타일 세션 지속성을 갖춘 경량 크로스플랫폼 플레인 텍스트 에디터. 수동 저장 없이도 앱 종료·크래시·컴퓨터 재시작 후 열려 있던 탭(미저장 untitled 포함)이 그대로 복원된다. 주요 확장자 syntax highlighting 지원.

| 항목 | 값 |
|------|-----|
| 기술 스택 | Tauri 2 (Rust + OS WebView) · CodeMirror 6 · Vanilla TS + Vite |
| 플랫폼 | Windows / macOS / Linux |
| 개발 | `npm install` → `npm run tauri dev` |
| 빌드 | `npm run tauri build` (release 바이너리 ~3.3MB) |
| 테스트 | `cd src-tauri && cargo test` (인코딩·세션스토어) · `npm run build` (프론트 타입체크) |
| 상태 | v1 구현 완료 (M1~M4) · 안정성/경량화/UX/업데이터 개선 구현 완료 — 플랫폼별 수동검증·Secrets 등록 대기 |

### 아키텍처 요점

- **역할 분담** — Rust: 디스크 I/O·인코딩/EOL·원자적 세션 쓰기·OS통합 / JS: 탭 상태·CM6 버퍼·디바운스 스케줄링
- **세션 지속성** — `app_data_dir()`에 `session.json`(매니페스트) + `backups/<tab-uuid>.txt`. temp→fsync→rename 원자적 쓰기로 크래시 안전. 1.5초 디바운스/탭전환/blur/30초/창닫기에 flush
- **핵심 파일** — Rust: `src-tauri/src/{lib.rs, encoding.rs, watcher.rs, session/store.rs, commands/}` / JS: `src/{session.ts, editor.ts, tabs.ts, state.ts, preferences.ts, updater.ts}`
- **외부 변경 감시** — `watcher.rs`가 부모 디렉터리를 notify로 감시(파일 직접 감시 금지 — rename-over 시 watch 소멸). 자기 저장은 suppress map(mtime)으로 무시
- **대용량 가드** — 10MB 경고/100MB 거부는 Rust `read_guarded`가 단일 집행. file-backed 대용량 탭은 세션 백업 제외
- **업데이터** — 서명 키 `~/.tauri/uninotepad.key`(레포 밖). 릴리즈 전 GitHub Secrets(`TAURI_SIGNING_PRIVATE_KEY`(_PASSWORD)) 등록 필수
- 상세 설계: `~/.claude/plans/notepad-dynamic-turtle.md`, 실행 안내: `README.md`

### 문서 구조 (소유권 분리)

- **하니스 문서** (`Ref-docs/claude/` 하위) — 🔒 dotclaude 소유. `dotclaude-update`가 덮어쓰니 **수정 금지**.
- **프로젝트 스펙** (`specs/` 하위) — 📝 자유롭게 작성.

### 하니스 상세 문서 (Ref-docs/claude/)

- [Context DB](Ref-docs/claude/context-db.md) — SQLite 기반 세션/태스크/결정 저장소
- [Context Monitor](Ref-docs/claude/context-monitor.md) — HUD + compaction 감지/복구
- [Hooks](Ref-docs/claude/hooks.md) — 자동 실행 Hook 상세
- [컨벤션](Ref-docs/claude/conventions.md) — 커밋, 주석, 로깅 규칙
- [셋업](Ref-docs/claude/setup.md) — 새 환경 초기 설정
- [Agent Delegation](Ref-docs/claude/agent-delegation.md) — 에이전트 위임/파이프라인 상세

### 핵심 규칙

- **CM6는 항상 LF만 다룬다** — 디스크 쓰기는 반드시 Rust `save_file`을 통해서만 (EOL/BOM 재적용). JS에서 직접 파일 쓰기 금지
- **세션 쓰기는 원자적으로** — 백업 먼저, 매니페스트 나중. `store.rs`의 `atomic_write_bytes` 경유
- **single-instance 플러그인은 Builder에 최우선 등록** (변경 시 순서 유지)
- **탭당 EditorView를 새로 만들지 말 것** — 단일 View에 `EditorState` 스왑 (undo 히스토리 보존)

---

*최종 업데이트: 2026-07-21*
