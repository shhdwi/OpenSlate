# openSlate

> Agent-native screen recorder + motion-design polish for AI coding tools. The dev never leaves their editor.

```
You: demo what I just built
Claude: Looking at your last commit... you added /settings with a theme toggle.
        Recording... ✓ (5.8s, 348 frames)
        Polishing with default profile... ✓
        ./demos/settings-toggle-20260504.mp4 · 5.8s · 1080p · 1.2 MB
```

That's the entire product. No UI. Just an MCP server, a single bundled skill, and a polish DSL grounded in the 10 motion-design principles.

---

## Status

**Pre-release.** Active build toward v1, target launch August 2026.

This repo is the in-progress implementation. The OSS launch — with stable npm package, polished docs, and three benchmark demo videos — happens at the end of [the build calendar](#timeline).

## What it is

You install openSlate. Your AI coding agent (Claude Code, Cursor, Codex, OpenCode) gets eight new tools via MCP. When you say "demo this," the agent reads your git diff, drives Playwright against your dev server, captures frame-accurate recordings, applies a polish pipeline encoded with the 10 motion-design principles, and exports a tweet-ready mp4 or gif. Your project gets a `polish.config.ts` you can tweak by asking your agent ("calmer zooms," "darker theme," "phone frame").

## What it isn't

- A GUI. There is none. There never will be one.
- A timeline editor. Editing happens in `polish.config.ts`, mediated by your agent.
- A SaaS. Local capture, local render, your machine, your files.
- An "AI video generator." We don't generate pixels; we record real ones and polish them.
- A Loom replacement. Loom is async messaging. openSlate is for product demos.

## Why

Every existing screen recorder (Screen Studio, Cap, Recordly, Tella) is a desktop app you click around in. They produce great output but require human-driven editing.

Every dev who ships with Claude Code / Cursor wants a demo of the feature they just shipped. Right now they record with Loom, edit in iMovie, upload, share. Forty minutes for an eight-second clip.

openSlate collapses that to fifteen seconds. The agent already knows what was built (it built it). The polish pipeline already knows how things should move (the 10 principles are in the config). The user never opens an app.

## The 10 principles

Every default in `polish.config.ts` traces to one of these:

1. **Timing & spacing** — 60fps locked
2. **Easings** — never linear
3. **Mass & weight** — cursor light, frame grounded, bg subordinate
4. **Anticipation** — cursor settles before clicking
5. **Arcs** — partial in v1 (spring overshoot); full in v1.5
6. **Squash & stretch** — restrained click bounce
7. **Follow-through & overlap** — motion blur + spring wobble
8. **Exaggeration** — emphatic, with restraint axiom (one gesture per beat)
9. **Secondary animation** — bg parallax during zoom
10. **Appeal** — emergent; tested via the [benchmark](./benchmark/README.md)

Each principle has a concrete benchmark test the calibration week runs.

## Quickstart

```bash
npm install openslate          # or:  bun add openslate / pnpm add openslate
```

Three ways to use it, smallest to biggest. Pick whichever fits.

### 1. One-shot URL → mp4 (no scripting)

```bash
npx openslate quick https://your-app.com \
  --click "button:has-text('Sign up')" \
  --wait 800 \
  --type "input[name=email]=alice@example.com" \
  --click "button:has-text('Continue')"
```

`--click`, `--type`, and `--wait` are repeatable; argv order is preserved. For longer scenarios, pass `--steps demo.json` instead. Result lands in `./demos/` and auto-opens (macOS). First run downloads Chromium (~150MB, one-time).

### 2. Scripted demo (multi-step, version-controlled)

```bash
npx openslate scaffold         # drops demo.mjs at project root
# edit demo.mjs — base_url + steps array
node demo.mjs
```

The scaffold gives you the full 4-call orchestration flow (`plan → execute → planEdit → export`) with a placeholder click step you replace. Same 7-action DSL as the agent path:

| Action | Required | Does |
|---|---|---|
| `navigate` | `selector` (URL) | Loads the page |
| `click` | `selector` | Cursor moves with anticipation, clicks |
| `type` | `selector`, `value` | Clicks to focus, types |
| `scroll` | `selector` (optional) | Scrolls the matched element |
| `hover` | `selector` | Cursor hovers |
| `highlight` | `selector` | Camera spotlights the element |
| `wait` | — | Holds for `expected_duration_ms` |

Selectors are CSS or `:has-text(...)`. The recorder fail-softs on misses (logs which step missed and continues). Verify selectors before recording with `npx openslate preview <url>`.

### 3. Agent-driven (Claude Code / Cursor / Codex via MCP)

```bash
npx openslate init             # drops polish.config.ts, registers MCP project-locally
```

Writes `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor), or `~/.codex/config.json` (Codex) so your agent picks up 8 tools — `record_plan`, `record_execute`, `record_export`, `record_list`, `record_status`, `record_polish`, `polish_preview`, `polish_preview_after`. Then in your agent: **"demo this feature"**. Make sure your dev server is running first (typically `http://localhost:3000`).

## Paid templates (optional)

Hand-tuned plans for common SaaS demos (onboarding flows, dashboard tours, checkout walkthroughs). Free templates are included; the catalog lives at [openslate.dev/templates](https://openslate.dev/templates).

```bash
npx openslate templates                                 # list catalog (free + paid)
npx openslate template hello-world --base-url ...       # free, no license needed
npx openslate login osl_xxx                             # after buying the bundle
npx openslate template saas-onboarding --base-url ...   # paid templates work
npx openslate logout                                    # remove saved key
```

**OSS boundary.** Three CLI commands talk to openslate.dev — `login`, `logout`, `template <slug>` — and the source for each is small and isolated:

- [src/cli/login.ts](./src/cli/login.ts) — POSTs the license to `/api/license/verify`
- [src/cli/template.ts](./src/cli/template.ts) — GETs `/api/templates/<slug>` with `Authorization: Bearer <key>`
- [src/utils/license-config.ts](./src/utils/license-config.ts) — reads/writes `~/.config/openslate/license` (mode 0600)

The rest of openSlate is fully offline. The recorder, compositor, planner, polish pipeline, `quick`, `scaffold`, `init`, MCP — none of them touch the network. Templates are JSON (`{ meta, plan, polish_overrides }`) and are executed by the same orchestration pipeline as any other plan; no arbitrary code runs from the server.

### Canonical reference example

The repo also ships a longer, hand-tuned reference: a 6-step walkthrough of [nanoindex.nanonets.com/demo](https://nanoindex.nanonets.com/demo). Clone and run from source:

```bash
git clone https://github.com/shhdwi/openSlate && cd openSlate
bun install && bun run build
bun examples/quickstart/demo.mjs
```

`./demos/ask-question-*.mp4` (~33s, 1080p) — pick a benchmark question, send, watch the answer stream in, click a citation, switch to Entities.

## Architecture

```
plan ─→ recorder ─→ compositor ─→ export
 │         │            │           │
 │         │            │           └─ ffmpeg via Remotion
 │         │            │
 │         │            └─ Remotion compositions; cursor, frame, bg, captions, flourishes
 │         │
 │         └─ Playwright headless; CDP screencast at 60fps; events.json
 │
 └─ generates a DemoPlan from a diff or description; principle-validated
```

## Repo layout

```
src/
├── core/         types, Zod schema, default profile, principle metadata
├── plan/         plan generator + principle-based validator
├── recorder/     Playwright wrapper, event log
├── compositor/   Remotion compositions, cursor, frame, bg, auto-zoom
├── flourishes/   curated vector flourish library
├── mcp/          MCP server + 8 tools
├── cli/          openslate quick, scaffold, init, mcp, preview, export, list, plan
└── config/       polish.config.ts loader
skills/openslate/SKILL.md   single bundled skill (Claude Code, Cursor, Codex)
benchmark/                   the calibration week artifacts
```

## v1 scope (locked, May 2026)

**Includes:**
- Browser-only capture via Playwright
- 6 frame styles × light/dark
- 10 background presets + custom image
- Cursor smoothing / click bounce / motion blur
- Auto-zoom from click events with anticipation drift
- Click impact ripple
- Cursor path arcs on long traversals
- Captions (from steps)
- Curated flourish library (12-15 hand-authored presets)
- mp4 + gif export
- MCP server + single SKILL.md
- `openslate init` CLI

**Excludes:**
- Native (non-browser) capture
- Audio (music, voiceover)
- Multi-scene composition with match cuts (v2)
- Agent-authored vector graphics (v2-v3)
- GUI of any kind
- Hosted rendering

## Timeline

| Phase | Dates | Deliverable |
|---|---|---|
| Benchmark week | May 11 – 17 | 3 hand-authored reference videos + tuned defaults |
| Core build | May 18 – Jun 14 | recorder + compositor + DSL + MCP |
| v1.5 polish | Jun 15 – Jun 28 | arcs, drift, ripple |
| Flourish library | Jun 29 – Jul 26 | 12-15 presets + agent rules |
| Polish + launch prep | Jul 27 – Aug 9 | docs, landing, demo videos |
| **Public launch** | **~Aug 10** | OSS release, npm publish, tweet |

## License

Apache 2.0. See [LICENSE](./LICENSE).

## Contributing

This is in active early build. Contributions welcome once v1 lands.

---

*Built by [Shrish](https://github.com/shhdwi).*
