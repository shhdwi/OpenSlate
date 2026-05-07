# Quickstart — your first demo in 3 minutes

Self-contained example. Records [nanoindex.nanonets.com/demo](https://nanoindex.nanonets.com/demo), polishes with the default profile, exports an mp4. No MCP-aware editor needed — just Node and the openSlate package.

## Run it

From the openSlate repo root:

```bash
bun install
bun run build
bun examples/quickstart/demo.mjs
```

(or `npm install && npm run build && node examples/quickstart/demo.mjs`)

You'll see:

```
✓ plan: nanoindex demo — pick a benchmark question, send, ...
✓ recorded 1820 frames
  ✓ step  0 navigate   fired
  · step  1 wait       skipped
  ✓ step  2 click      fired       ← benchmark question
  · step  3 wait       skipped
  ✓ step  4 click      fired       ← send
  · step  5 wait       skipped     ← 20s answer-stream
  ✓ step  6 click      fired       ← yellow citation
  · step  7 wait       skipped
  ✓ step  8 click      fired       ← close citation
  · step  9 wait       skipped
  ✓ step 10 click      fired       ← Entities tab
  · step 11 wait       skipped
✓ edit plan: recordings/<id>/edit-plan.json
  output: 13.2s @ 1× rate
  segments (3): ...
  keyframes (21): ...
✓ exported demos/ask-question-<id>-<date>.mp4 · ~8 MB
```

The mp4 lands in `./demos/`. Open it:

```bash
open demos/ask-question-*.mp4
```

## What it shows

A 6-step walkthrough of nanoindex's RAG demo:

1. **Click the first benchmark question** — pre-fills the textbox with a canned query
2. **Click send** — the answer streams in (~15s)
3. **Wait, camera holds wide** — viewer reads the full answer with no competing zoom
4. **Click a yellow citation pill** — opens the PDF preview
5. **Close the citation panel** — back to the answer
6. **Click the Entities tab** — switches the right rail to the entity list

Camera dips back to wide between every click (the demo overrides `connected_gap_ms: 0` so adjacent zooms don't merge — gives each beat its own moment).

## How it works

Four orchestration calls in order:

1. **`orchestratePlan`** — turns your `description` + `steps` into a typed `DemoPlan`. Validates against the [10 motion-design principles](../../README.md#the-10-principles).
2. **`orchestrateExecute`** — drives Playwright headless against the URL, captures frames at 60fps, records every interaction.
3. **`orchestratePlanEdit`** — turns events into an edit plan: segment trimming, camera keyframes, connected pans.
4. **`orchestrateExport`** — bundles the Remotion compositor, renders to mp4 with the default polish profile.

## Adapt it for your own site

Open [demo.mjs](./demo.mjs) and edit the `steps` array. Each step is one of:

| Action | Required | What it does |
|---|---|---|
| `navigate` | `selector` (URL) | `page.goto`, waits for visual stability |
| `click` | `selector` | Cursor moves with anticipation, clicks |
| `type` | `selector`, `value` | Clicks to focus, types via keyboard |
| `scroll` | `selector` (optional) | Scrolls the matched element |
| `hover` | `selector` | Cursor moves onto element |
| `highlight` | `selector` | Camera-frames + spotlights the element |
| `wait` | — | Holds for `expected_duration_ms` |

Selectors are CSS or Playwright text-match (e.g. `button:has-text('Save')`). The recorder fail-softs on misses (logs which step failed, continues) so a flaky selector won't kill the demo.

## Discovering selectors

When adapting for your site, use:

```bash
bun src/cli/index.ts preview https://your-site.com
```

Prints every interactive element with a stable selector. Saves you from guessing.

## Tweaking the polish later

When you want darker themes, calmer zooms, transparent export, or 3D tilt — drop a `polish.config.ts`:

```bash
bun src/cli/index.ts init
```

Fully-annotated config you can edit directly or via your AI agent ("calmer zooms," "tilt the screen like a product shot"). See the [main README](../../README.md) for the full DSL.

## Troubleshooting

**`Remotion entry not found`** — you didn't run `bun run build`.

**`Selector missed` on a step** — the page DOM doesn't match. Run `bun src/cli/index.ts preview <url>` to see actual selectors.

**Slow first run** — Playwright downloads Chromium (~150MB) once. Subsequent runs are 60–90s for a 5-second demo, 2–3 minutes for a long one like nanoindex.

**The render hangs** — kill it (`pkill -f chrome-headless-shell`). Common causes: a page that streams content forever (the visual-stability primitive waits for quiet). Increase `expected_duration_ms` ceilings on the affected step or add explicit `wait` steps.
