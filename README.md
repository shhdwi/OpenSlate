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

You install openSlate. Your AI coding agent (Claude Code, Cursor, Codex, OpenCode) gets six new tools via MCP. When you say "demo this," the agent reads your git diff, drives Playwright against your dev server, captures frame-accurate recordings, applies a polish pipeline encoded with the 10 motion-design principles, and exports a tweet-ready mp4 or gif. Your project gets a `polish.config.ts` you can tweak by asking your agent ("calmer zooms," "darker theme," "phone frame").

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

## Try it in 5 minutes

The pre-release ships now and works end-to-end. Three paths:

### 1. Zero-config: record any URL

```bash
git clone https://github.com/shhdwi/openslate
cd openslate
bun install && bun run build

# Record + polish + export any URL — no config, no agent
bun src/cli/index.ts quick https://nanoindex.nanonets.com/demo \
  --click "button:has-text('Expand all')"
```

The result lands in `./demos/quickstart-<id>-<date>.mp4` and auto-opens (macOS). First run downloads Chromium (~150MB, one time); subsequent runs are 60–90s.

### 2. Multi-step demo via JS

For real demos you'll script the steps. See the runnable example at [examples/quickstart/demo.mjs](./examples/quickstart/demo.mjs):

```bash
bun examples/quickstart/demo.mjs
```

That records nanoindex.nanonets.com, expands the entity tree, asks a sample question, exports the result. Six lines per step in the `steps` array — copy the file and adapt for your own site.

### 3. Inside Claude Code / Cursor / Codex

The MCP path. Drops a config file at your project root and registers six tools with your agent:

```bash
bun src/cli/index.ts init
# → drops polish.config.ts
# → registers MCP with Claude Code, Cursor, Codex (whichever are installed)
# → adds ./demos/ to .gitignore
```

Then in your agent: **"demo this feature"**. The agent reads your git diff, drives the recorder, and ships the polish.

For raw CLI usage see [docs](./docs).

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
├── mcp/          MCP server + 6 tools
├── cli/          openslate init, record, polish, export, mcp commands
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
