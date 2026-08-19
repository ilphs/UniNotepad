#!/usr/bin/env python3
"""테마 팔레트 감사 도구 — 유일한 품질 게이트.

설계서 `Ref-docs/specs/design/theme-multi-palette.md` §6, §9 참조.

이 앱은 팔레트별 GUI 스크린샷 검증을 **하지 않기로** 결정했다(§9 말미).
따라서 10패밀리 × dark/light = 20블록짜리 `src/themes.css`의 품질을 담보하는
수단은 이 스크립트가 유일하다. 여기서 놓친 결함은 사람 눈으로 발견되기 전까지
사용자에게 그대로 노출된다 — 예를 들어 변수 하나가 빠지면 CSS 캐스케이드를 타고
다른 테마(보통 직전에 로드된 다크 기본값)의 값이 새어 들어오는데, 이건 화면을
봐도 "그 테마가 원래 이런 색인가?" 싶을 뿐 눈치채기 어렵다. 대비 미달도 마찬가지로
디자인 취향처럼 보여서 리뷰에서 잘 걸러지지 않는다.

이 도구는 개발 편의 스크립트이지 빌드 파이프라인의 일부가 아니다. 따라서
표준 라이브러리만 사용한다(서드파티 의존성을 팔레트 검증 때문에 들이는 것은
설계서가 강조하는 "의존성 0개" 원칙에 반한다).

검사 4종 (task 지시 기준 — 설계서 §6 초안의 26변수는 §4-a에서 신설된
`--ws-mark`/`--trailing-mark` 반영 전 숫자이고, 실제 배선 대상은 28변수다):

1. 변수 누락   — 20블록 모두 28개 변수를 빠짐없이 정의하는지 (블록 자체 누락/과잉도 실패)
2. 대비 하한   — WCAG 상대휘도 기반 대비비, `--bg` 대비 (comment 2.5:1 / accent 계열 6종 3.0:1 / fg 4.5:1)
3. chrome 구분 — `--chrome-bg != --bg`, `--tab-active-bg != --tab-inactive-bg`
4. 골든        — `dracula-dark` 블록이 설계서 §9-1이 못박은 값과 정확히 일치 (기존 사용자 화면 불변 보장)

추가로 `@media`가 파일에 하나라도 있으면 즉시 실패시킨다. system 모드는
`theme.ts`가 JS에서 해석하는 설계이므로(§2), themes.css에 조건부 블록이
남아있다면 그 자체가 설계 위반이자 미디어쿼리 복제 부채의 재발이다.

사용법:
    python3 scripts/themes/audit.py [path-to-themes.css] [--verbose]

기본 대상 경로는 `src/themes.css`. 실패 시 exit code 1.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# 상수 — 팔레트 스펙 (설계서 §3, §6, §9-1)
# ---------------------------------------------------------------------------

FAMILIES: list[str] = [
    "dracula",
    "github",
    "solarized",
    "gruvbox",
    "catppuccin",
    "nord",
    "tokyo-night",
    "one-half",
    "rose-pine",
    "kanagawa",
]
MODES: list[str] = ["dark", "light"]
EXPECTED_BLOCK_IDS: list[str] = [f"{fam}-{mode}" for fam in FAMILIES for mode in MODES]

# 블록당 반드시 정의되어야 하는 28개 변수 (설계서 §4-a로 26 -> 28 확장됨)
REQUIRED_VARS: list[str] = [
    "--bg",
    "--fg",
    "--chrome-bg",
    "--chrome-fg",
    "--border",
    "--tab-active-bg",
    "--tab-inactive-bg",
    "--accent",
    "--banner-conflict",
    "--banner-deleted",
    "--cm-comment",
    "--cm-keyword",
    "--cm-string",
    "--cm-number",
    "--cm-function",
    "--cm-type",
    "--cm-property",
    "--cm-operator",
    "--cm-variable",
    "--cm-invalid",
    "--gutter-bg",
    "--gutter-fg",
    "--gutter-active-fg",
    "--active-line-bg",
    "--caret",
    "--selection-bg",
    "--ws-mark",
    "--trailing-mark",
]

# 대비 하한 (§6-1). --bg 대비.
CONTRAST_MIN_COMMENT = 2.5
CONTRAST_MIN_ACCENT = 3.0
CONTRAST_MIN_FG = 4.5

ACCENT_TOKENS = [
    "--cm-keyword",
    "--cm-string",
    "--cm-number",
    "--cm-function",
    "--cm-type",
    "--cm-property",
]

# chrome 구분 검사 대상 쌍 (§6-2 / task 3)
CHROME_PAIRS = [
    ("--chrome-bg", "--bg"),
    ("--tab-active-bg", "--tab-inactive-bg"),
]

# 골든 값 — dracula-dark (설계서 §9-1, 기존 styles.css:39-71과 동일해야 함)
GOLDEN_BLOCK_ID = "dracula-dark"
GOLDEN_VALUES: dict[str, str] = {
    "--bg": "#282a36",
    "--fg": "#f8f8f2",
    "--chrome-bg": "#21222c",
    "--chrome-fg": "#f8f8f2",
    "--border": "#44475a",
    "--tab-active-bg": "#282a36",
    "--tab-inactive-bg": "#21222c",
    "--accent": "#bd93f9",
    "--banner-conflict": "#3a3320",
    "--banner-deleted": "#3a2330",
    "--cm-comment": "#6272a4",
    "--cm-keyword": "#ff79c6",
    "--cm-string": "#f1fa8c",
    "--cm-number": "#bd93f9",
    "--cm-function": "#50fa7b",
    "--cm-type": "#8be9fd",
    "--cm-property": "#50fa7b",
    "--cm-operator": "#f8f8f2",
    "--cm-variable": "#f8f8f2",
    "--cm-invalid": "#ff5555",
    "--gutter-bg": "#282a36",
    "--gutter-fg": "#6272a4",
    "--gutter-active-fg": "#f8f8f2",
    "--active-line-bg": "rgba(255, 255, 255, 0.055)",
    "--caret": "#f8f8f2",
    "--selection-bg": "#44475a",
    "--ws-mark": "#6272a4",
    "--trailing-mark": "#ff5555",
}

DEFAULT_THEMES_CSS = "src/themes.css"

# ---------------------------------------------------------------------------
# 파싱
# ---------------------------------------------------------------------------

# :root[data-theme="dracula-dark"] { ... } 블록을 통째로 캡처
BLOCK_RE = re.compile(
    r':root\[data-theme=(["\'])(?P<id>[^"\']+)\1\]\s*\{(?P<body>[^}]*)\}',
    re.DOTALL,
)
# --var-name: value; 선언 하나
DECL_RE = re.compile(r"(--[a-zA-Z0-9-]+)\s*:\s*([^;]+?)\s*;")

HEX_RE = re.compile(r"^#(?P<hex>[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
RGBA_RE = re.compile(
    r"^rgba?\(\s*(?P<r>\d+)\s*,\s*(?P<g>\d+)\s*,\s*(?P<b>\d+)\s*(?:,\s*(?P<a>[\d.]+)\s*)?\)$",
    re.IGNORECASE,
)


@dataclass
class ThemeBlock:
    block_id: str
    raw_body: str
    declarations: dict[str, str] = field(default_factory=dict)


def parse_blocks(css_text: str) -> list[ThemeBlock]:
    """CSS 텍스트에서 :root[data-theme="..."] 블록을 전부 추출한다."""
    blocks: list[ThemeBlock] = []
    for m in BLOCK_RE.finditer(css_text):
        body = m.group("body")
        decls: dict[str, str] = {}
        for dm in DECL_RE.finditer(body):
            name, value = dm.group(1), dm.group(2).strip()
            # 같은 블록 안에 같은 변수가 두 번 정의되면 마지막 값이 유효 (CSS와 동일 규칙)
            decls[name] = value
        blocks.append(ThemeBlock(block_id=m.group("id"), raw_body=body, declarations=decls))
    return blocks


def parse_color(value: str) -> tuple[int, int, int, float] | None:
    """`#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` 를 (r,g,b,a) 정수/실수 튜플로 정규화한다.

    파싱 불가능하면 None을 반환한다 (호출부가 "값이 색이 아님"으로 처리).
    """
    v = value.strip()

    m = HEX_RE.match(v)
    if m:
        hex_digits = m.group("hex")
        if len(hex_digits) in (3, 4):
            # #rgb / #rgba 축약형 -> 각 자리 두 번 반복
            hex_digits = "".join(ch * 2 for ch in hex_digits)
        r = int(hex_digits[0:2], 16)
        g = int(hex_digits[2:4], 16)
        b = int(hex_digits[4:6], 16)
        a = int(hex_digits[6:8], 16) / 255.0 if len(hex_digits) == 8 else 1.0
        return (r, g, b, round(a, 4))

    m = RGBA_RE.match(v)
    if m:
        r, g, b = int(m.group("r")), int(m.group("g")), int(m.group("b"))
        a = float(m.group("a")) if m.group("a") is not None else 1.0
        return (r, g, b, round(a, 4))

    return None


def normalize_color(value: str) -> str | None:
    """값 단위 비교(포매팅 무관)를 위한 정규 문자열 표현. 파싱 실패 시 None."""
    parsed = parse_color(value)
    if parsed is None:
        return None
    r, g, b, a = parsed
    if a == 1.0:
        return f"#{r:02x}{g:02x}{b:02x}"
    # alpha 유의미 자릿수 보존 (0.055 등)
    a_str = f"{a:.4f}".rstrip("0").rstrip(".")
    return f"rgba({r}, {g}, {b}, {a_str})"


# ---------------------------------------------------------------------------
# WCAG 상대휘도 / 대비비
# ---------------------------------------------------------------------------


def _srgb_channel_to_linear(c: int) -> float:
    cs = c / 255.0
    if cs <= 0.03928:
        return cs / 12.92
    return ((cs + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    r, g, b = rgb
    rl, gl, bl = (_srgb_channel_to_linear(c) for c in (r, g, b))
    return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl


def contrast_ratio(rgb1: tuple[int, int, int], rgb2: tuple[int, int, int]) -> float:
    l1 = relative_luminance(rgb1)
    l2 = relative_luminance(rgb2)
    lighter, darker = max(l1, l2), min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


# ---------------------------------------------------------------------------
# 검사 로직
# ---------------------------------------------------------------------------


@dataclass
class Finding:
    """단일 실패 항목. 표 출력용."""

    block_id: str
    check: str
    message: str


@dataclass
class AuditResult:
    findings: list[Finding] = field(default_factory=list)
    block_count: int = 0
    verbose_lines: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.findings

    def fail(self, block_id: str, check: str, message: str) -> None:
        self.findings.append(Finding(block_id=block_id, check=check, message=message))


COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def strip_comments(css_text: str) -> str:
    """CSS 주석을 제거하되 줄 수는 보존한다.

    themes.css의 헤더 주석은 "왜 @media를 쓰지 않는가"를 산문으로 설명하고,
    각 블록 위에는 출처 URL이 달려 있다. 원문을 그대로 스캔하면 그 산문이
    선언·규칙으로 오인된다 — 실제로 헤더가 @media를 언급한다는 이유만으로
    이 감사가 오탐을 냈다. 주석에 반응하는 게이트는 신뢰를 잃고 결국
    무시당하므로, 모든 검사는 주석을 걷어낸 텍스트 위에서 돈다.

    개행을 남기는 것은 향후 줄 번호 보고를 붙일 때를 위한 것이다.
    """
    return COMMENT_RE.sub(lambda m: "\n" * m.group(0).count("\n"), css_text)


def check_media_queries(css_text: str, result: AuditResult) -> None:
    if re.search(r"@media", css_text, re.IGNORECASE):
        result.fail(
            "(file)",
            "no-media-query",
            "themes.css 안에 @media 블록이 존재한다 — system 모드는 JS(theme.ts)가 해석해야 하며"
            " CSS 조건부 블록이 남아있으면 설계 위반(§2)이자 미디어쿼리 복제 부채 재발이다.",
        )


def check_block_set(blocks: list[ThemeBlock], result: AuditResult) -> None:
    found_ids = [b.block_id for b in blocks]
    found_set = set(found_ids)
    expected_set = set(EXPECTED_BLOCK_IDS)

    # 중복 블록 정의 검출
    seen: set[str] = set()
    dupes: set[str] = set()
    for bid in found_ids:
        if bid in seen:
            dupes.add(bid)
        seen.add(bid)
    for bid in sorted(dupes):
        result.fail(bid, "block-set", f"블록 '{bid}'가 파일에 두 번 이상 정의되어 있다 (캐스케이드로 마지막 정의만 유효해진다).")

    missing = expected_set - found_set
    for bid in sorted(missing):
        result.fail(bid, "block-set", f"기대되는 블록 ':root[data-theme=\"{bid}\"]'가 파일에 없다.")

    unexpected = found_set - expected_set
    for bid in sorted(unexpected):
        result.fail(bid, "block-set", f"20블록 스펙에 없는 블록 ':root[data-theme=\"{bid}\"]'가 존재한다.")


def check_missing_vars(block: ThemeBlock, result: AuditResult) -> None:
    missing = [v for v in REQUIRED_VARS if v not in block.declarations]
    for var in missing:
        result.fail(block.block_id, "missing-var", f"필수 변수 '{var}'가 정의되어 있지 않다.")


def check_chrome_distinction(block: ThemeBlock, result: AuditResult) -> None:
    for var_a, var_b in CHROME_PAIRS:
        val_a = block.declarations.get(var_a)
        val_b = block.declarations.get(var_b)
        if val_a is None or val_b is None:
            continue  # missing-var 검사가 이미 잡는다
        norm_a, norm_b = normalize_color(val_a), normalize_color(val_b)
        if norm_a is not None and norm_b is not None and norm_a == norm_b:
            result.fail(
                block.block_id,
                "chrome-distinction",
                f"'{var_a}'({val_a})와 '{var_b}'({val_b})가 동일한 색이다 — 구분이 사라진다.",
            )


def check_contrast(block: ThemeBlock, result: AuditResult, verbose: bool) -> None:
    bg_raw = block.declarations.get("--bg")
    if bg_raw is None:
        return  # missing-var 검사가 이미 잡는다
    bg_rgb = parse_color(bg_raw)
    if bg_rgb is None:
        result.fail(block.block_id, "contrast", f"'--bg' 값 '{bg_raw}'을(를) 색으로 파싱할 수 없다.")
        return

    targets: list[tuple[str, float]] = [("--cm-comment", CONTRAST_MIN_COMMENT), ("--fg", CONTRAST_MIN_FG)]
    targets += [(tok, CONTRAST_MIN_ACCENT) for tok in ACCENT_TOKENS]

    for var, min_ratio in targets:
        raw = block.declarations.get(var)
        if raw is None:
            continue  # missing-var 검사가 이미 잡는다
        rgb = parse_color(raw)
        if rgb is None:
            result.fail(block.block_id, "contrast", f"'{var}' 값 '{raw}'을(를) 색으로 파싱할 수 없다.")
            continue
        ratio = contrast_ratio(bg_rgb[:3], rgb[:3])
        if verbose:
            result.verbose_lines.append(
                f"  [{block.block_id}] {var} vs --bg = {ratio:.2f}:1 (기준 {min_ratio:.1f}:1)"
            )
        if ratio < min_ratio:
            result.fail(
                block.block_id,
                "contrast",
                f"'{var}'({raw}) 대비 '--bg'({bg_raw}) = {ratio:.2f}:1, 기준 {min_ratio:.1f}:1 미달.",
            )


def check_golden(blocks_by_id: dict[str, ThemeBlock], result: AuditResult) -> None:
    block = blocks_by_id.get(GOLDEN_BLOCK_ID)
    if block is None:
        result.fail(GOLDEN_BLOCK_ID, "golden", "골든 블록 'dracula-dark'가 파일에 없다.")
        return

    for var, expected_raw in GOLDEN_VALUES.items():
        actual_raw = block.declarations.get(var)
        if actual_raw is None:
            continue  # missing-var 검사가 이미 잡는다
        expected_norm = normalize_color(expected_raw)
        actual_norm = normalize_color(actual_raw)
        if expected_norm is None:
            # 골든 상수 자체가 파싱 안 되면 스크립트 버그 — 그래도 방어적으로 문자열 비교
            expected_norm = expected_raw
        if actual_norm is None:
            result.fail(
                GOLDEN_BLOCK_ID,
                "golden",
                f"'{var}' 값 '{actual_raw}'을(를) 색으로 파싱할 수 없다 (기대: {expected_raw}).",
            )
            continue
        if actual_norm != expected_norm:
            result.fail(
                GOLDEN_BLOCK_ID,
                "golden",
                f"'{var}' 기대값 '{expected_raw}' (정규화 {expected_norm}) != 실제값 '{actual_raw}' (정규화 {actual_norm}).",
            )


# ---------------------------------------------------------------------------
# 실행 / 출력
# ---------------------------------------------------------------------------


def run_audit(css_text: str, verbose: bool) -> AuditResult:
    result = AuditResult()

    # 모든 검사는 주석을 걷어낸 텍스트를 본다 (strip_comments의 주석 참조).
    css_text = strip_comments(css_text)

    check_media_queries(css_text, result)

    blocks = parse_blocks(css_text)
    result.block_count = len(blocks)
    check_block_set(blocks, result)

    blocks_by_id = {b.block_id: b for b in blocks}

    for bid in EXPECTED_BLOCK_IDS:
        block = blocks_by_id.get(bid)
        if block is None:
            continue  # block-set 검사가 이미 잡는다
        check_missing_vars(block, result)
        check_chrome_distinction(block, result)
        check_contrast(block, result, verbose)

    check_golden(blocks_by_id, result)

    return result


def print_report(result: AuditResult, target_path: Path, verbose: bool) -> None:
    print(f"테마 감사: {target_path}")
    print(f"발견된 블록 수: {result.block_count} (기대: {len(EXPECTED_BLOCK_IDS)})")
    print()

    if verbose and result.verbose_lines:
        print("--- 대비비 상세 ---")
        for line in result.verbose_lines:
            print(line)
        print()

    # 블록별 통과/실패 표
    findings_by_block: dict[str, list[Finding]] = {}
    for f in result.findings:
        findings_by_block.setdefault(f.block_id, []).append(f)

    print(f"{'블록':<20} {'상태':<6} 상세")
    print("-" * 70)
    all_ids = ["(file)"] + EXPECTED_BLOCK_IDS
    # 스펙 밖 블록도 표에 노출
    extra_ids = sorted(set(findings_by_block.keys()) - set(all_ids))
    for bid in all_ids + extra_ids:
        block_findings = findings_by_block.get(bid, [])
        status = "PASS" if not block_findings else "FAIL"
        if not block_findings:
            print(f"{bid:<20} {status:<6}")
            continue
        first = True
        for f in block_findings:
            label = bid if first else ""
            print(f"{label:<20} {status if first else '':<6} [{f.check}] {f.message}")
            first = False

    print()
    checks_count = 4  # 변수 누락 / 대비 하한 / chrome 구분 / 골든 (task 스펙)
    if result.passed:
        print(f"요약: {result.block_count} blocks, {checks_count} checks — PASS")
    else:
        n = len(result.findings)
        print(f"요약: {result.block_count} blocks, {checks_count} checks — FAIL ({n}개 이슈)")


def main(argv: list[str]) -> int:
    verbose = "--verbose" in argv
    positional = [a for a in argv if a != "--verbose"]
    target = Path(positional[0]) if positional else Path(DEFAULT_THEMES_CSS)

    if not target.exists():
        print(f"오류: '{target}' 파일이 없다.", file=sys.stderr)
        return 1

    css_text = target.read_text(encoding="utf-8")
    result = run_audit(css_text, verbose)
    print_report(result, target, verbose)
    return 0 if result.passed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
