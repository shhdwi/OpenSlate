# Third-party attribution

openSlate is licensed under Apache 2.0 (see `LICENSE`). It draws on patterns,
ideas, and (where noted below) specific assets from third-party open-source
projects.

## Patterns and constants (clean-room)

The following design patterns and calibrated constants are adopted as IDEAS
from Recordly (https://github.com/webadderallorg/Recordly, AGPL 3.0). All
implementations in openSlate are independent (clean-room) reimplementations:

- **Focal-clamp formula** (`src/compositor/auto-zoom.ts: getFocusBoundsForScale`)
  — `[1/(2s), 1 − 1/(2s)]` window for keeping the recording covering the
  frame at any zoom level.
- **Connected-zoom-pan timing** (`CHAINED_GAP_MS = 1350`,
  `CONNECTED_PAN_MS = 800`) for merging close-in-time zoom regions into a
  single sustained zoom with focal interpolation.
- **Camera transform formulation** (`pos = finalPos * progress`,
  `scale = 1 + (peak − 1) * progress` with transform-origin top-left) —
  coverage-safe at every intermediate progress.
- **Spring overshoot guard** for overdamped springs on target reversal
  (`src/utils/springs.ts: stepSpring`).
- **Asymmetric zoom durations** (slower in than out — Recordly uses
  ~1.5x ratio).
- **Cubic-bezier easing curves** (`(0.1, 0, 0.2, 1)` for connected pan,
  inspired by Recordly's `easeConnectedPan`).

These are functional/mathematical patterns and calibrated numbers.
Patterns and individual numbers are not copyrightable.

## Asset: minimal cursor SVG

The file `src/assets/cursors/minimal-cursor.svg` and the inlined cursor
path data in `src/compositor/cursor.tsx` are derived from Recordly's
`Minimal Cursor.svg` (AGPL 3.0).

This is a creative work and Recordly's AGPL 3.0 license normally requires
derivative distributions to be relicensed under AGPL 3.0. openSlate's
maintainer has elected to ship this asset under our Apache 2.0 license
deliberately, with full disclosure here. The maintainer accepts the
associated license tension; downstream users redistributing openSlate with
this asset should be aware that strict AGPL compliance would require
relicensing the package.

If Recordly's authors object, this asset will be replaced with an
independent SVG implementation (see commit history of `cursor.tsx` for a
prior clean-room version).

## Bundled libraries

Standard transitive dependencies (Remotion, Playwright, MCP SDK, React,
Zod, etc.) ship under their respective open-source licenses. Run
`npm ls --all` for the full dependency tree.
