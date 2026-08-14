#!/usr/bin/env python3
"""Generate an ffmpeg zoompan filtergraph that punches in on specific scenes
of md-preview-v2.mp4: the file-type picker and the two Editor-chip toggle
clicks. Used by zoom-punch.sh to produce md-preview-v3.mp4 as a post-process
over the raw v2 capture (no re-recording).

Why zoompan and not crop+eval=frame: ffmpeg 8.x removed crop's `eval` option,
so crop's w/h expressions are only evaluated once at filter init (a `t`-based
if/between never becomes true there). zoompan's z/x/y ARE re-evaluated every
output frame by design, so it's used here as a drop-in "time-varying crop"
even though there's no still-image panning happening.

The timestamps below are specific to out/md-preview-v2.mp4 (2026-08-11
capture) — they were measured by extracting frames at ~0.1s steps around
each click and reading off when the on-screen state actually changed
(picker open, Markdown hover, split appearing; Editor chip label flip).
If the source video is ever re-recorded, these will drift (typing/click
timing is not frame-exact between runs) and must be re-measured the same
way before reusing this script — see README.md "줌 인서트 후처리".
"""

OUT_W, OUT_H, FPS = 1400, 900, 30
FULL = (0, 0, OUT_W, OUT_H)

SCENE1_BOX = (670, 430, 730, 470)   # file-type chip + picker popup, ~1.92x
SCENE2_BOX = (800, 540, 560, 360)   # Editor chip, ~2.5x

# (time, (x, y, w, h)) — box is the crop rect in INPUT pixel coords.
KEYFRAMES = [
    (0.00, FULL),
    (0.55, FULL),
    (0.80, SCENE1_BOX),   # picker opens ~0.85s
    (2.55, SCENE1_BOX),   # Markdown selected / split appears ~2.35s
    (2.85, FULL),
    (30.30, FULL),
    (30.55, SCENE2_BOX),  # Editor-off click lands ~30.85s
    (31.15, SCENE2_BOX),
    (31.45, FULL),
    (34.70, FULL),
    (34.95, SCENE2_BOX),  # Editor-on click lands ~35.25s
    (35.55, SCENE2_BOX),
    (35.85, FULL),
    (39.00, FULL),        # past clip end; keeps the last segment well-defined
]

TCLOCK = f"(on/{FPS})"  # output frame number / fps == elapsed seconds
                        # (valid because d=1 and fps=FPS below: no frame drop/dup)


def piecewise_expr(idx):
    """Nested if(between(...)) linear-interpolation expression for
    component `idx` (0=x, 1=y, 2=w, 3=h) of KEYFRAMES, in terms of TCLOCK.
    Commas inside if()/between() must be backslash-escaped: ffmpeg's
    filtergraph parser and its per-filter eval parser both use `,`, so an
    unescaped one would be read as ending the zoompan filter description."""
    segs = []
    for i in range(len(KEYFRAMES) - 1):
        t0, v0 = KEYFRAMES[i][0], KEYFRAMES[i][1][idx]
        t1, v1 = KEYFRAMES[i + 1][0], KEYFRAMES[i + 1][1][idx]
        if t1 == t0:
            continue
        interp = f"{v0}" if v0 == v1 else f"({v0}+({v1}-{v0})*({TCLOCK}-{t0})/({t1}-{t0}))"
        segs.append((t0, t1, interp))

    expr = f"{KEYFRAMES[-1][1][idx]}"
    for t0, t1, interp in reversed(segs):
        expr = f"if(between({TCLOCK}\\,{t0}\\,{t1})\\,{interp}\\,{expr})"
    return expr


def main():
    # zoompan's x/y are the top-left corner of the crop box in input pixel
    # coords (matches our box keyframes exactly); z is the magnification,
    # derived from the interpolated crop width so it's always consistent
    # with x/y (z = iw/w). Height is implied by z + the fixed output aspect,
    # so it's never referenced directly.
    x_expr = piecewise_expr(0)
    y_expr = piecewise_expr(1)
    w_expr = piecewise_expr(2)
    z_expr = f"({OUT_W}/({w_expr}))"

    print(f"zoompan=z={z_expr}:x={x_expr}:y={y_expr}:d=1:s={OUT_W}x{OUT_H}:fps={FPS}")


if __name__ == "__main__":
    main()
