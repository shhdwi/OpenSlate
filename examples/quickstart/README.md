# Quick start — record your first demo in 5 minutes

A self-contained example that records [nanoindex.nanonets.com/demo](https://nanoindex.nanonets.com/demo), polishes it with the default profile, and exports an mp4. Works without an MCP-aware editor — just Node and the openSlate package.

## Run it

From the openSlate repo root:

```bash
bun install        # install package deps
bun run build      # build the package (writes dist/)
bun examples/quickstart/demo.mjs
```

Or from `npm`:

```bash
npm install
npm run build
node examples/quickstart/demo.mjs
```

You'll see:

```
✓ plan: nanoindex demo — expand entity tree + ask a sample question
✓ recorded 612 frames
✓ edit plan: recordings/<id>/edit-plan.json
  output: 8.3s @ 1× rate
  segments (2): ...
  keyframes (12): ...
✓ exported demos/<id>-<date>.mp4 · 4.2 MB
```

The demo file lands in `./demos/`. Open it:

```bash
open demos/*.mp4    # macOS — opens in QuickTime
```

## What's happening

The script calls four orchestration functions in order:

1. **`orchestratePlan`** — turns your `description + steps` into a typed `DemoPlan`. Validates it against the [10 motion-design principles](../../README.md#the-10-principles).
2. **`orchestrateExecute`** — drives Playwright headless against the URL, captures frames at 60fps, records every interaction event.
3. **`orchestratePlanEdit`** — turns the events into an edit plan: segments (which time-windows survive), camera keyframes (zoom/pan), and connected pans.
4. **`orchestrateExport`** — bundles the Remotion compositor and renders to mp4 with the package's default polish profile.

## Adapt it for your own site

Change the `base_url` and `steps` array in [demo.mjs](demo.mjs). Each step is one of:

| Action | Required fields | What it does |
|---|---|---|
| `navigate` | `selector` (URL) | `page.goto(url)`, waits for stability |
| `click` | `selector` | Moves cursor with anticipation, clicks |
| `type` | `selector`, `value` | Clicks to focus, types via keyboard |
| `scroll` | `selector` (optional) | Scrolls the matched element |
| `hover` | `selector` | Moves the cursor onto the element |
| `highlight` | `selector` | Camera-frames the element with a spotlight |
| `wait` | — | Holds the recording for `expected_duration_ms` |

Selectors are CSS or Playwright text-match (e.g. `button:has-text('Save')`). The orchestrator validates them at record-time and skips gracefully on misses (fail-soft).

## What you'll want to tweak (later, not now)

When you want more control — calmer zooms, dark theme, transparent export, 3D tilt — drop a `polish.config.ts` at your project root:

```bash
bun openslate init
```

That writes a fully-annotated config file you can edit directly or via your AI agent ("calmer zooms," "tilt the screen like a product shot"). See the [main README](../../README.md) for the full DSL.

## Troubleshooting

**`Remotion entry not found`** — you didn't run `bun run build`. The renderer needs the bundled compositor entry; see [src/compositor/render.ts](../../src/compositor/render.ts) for the candidate paths.

**`Selector missed`** — the page DOM doesn't match your selector. Open the URL manually, copy the actual selector via DevTools, retry. The recorder logs which step failed and continues.

**Slow on first run** — Playwright downloads Chromium (~150MB) the first time. Subsequent runs reuse the binary.
