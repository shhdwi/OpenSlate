// openSlate quickstart — the canonical demo. 6-step walkthrough of
// nanoindex.nanonets.com:
//
//   1. Click the first benchmark question (pre-fills the textbox)
//   2. Click send (the answer streams in over ~15s)
//   3. Wait, camera holds wide so the full answer is visible
//   4. Click a yellow citation pill in the answer
//   5. Close the citation panel
//   6. Click the Entities tab
//
// Run from the openslate repo root:
//
//   bun run build                    # one-time
//   bun examples/quickstart/demo.mjs
//
// Output: ./demos/ask-question-<id>-<date>.mp4 (~33s, 1080p mp4)
//
// Selectors verified against nanoindex.nanonets.com/demo on 2026-05-07.
// If the page changes you'll see "selector_missed" lines in the run
// output — re-probe with a small Playwright script.

import {
  orchestratePlan,
  orchestrateExecute,
  orchestratePlanEdit,
  orchestrateExport,
  summarizeEditPlan,
  DEFAULT_POLISH_PROFILE,
} from "../../dist/index.js";
import path from "node:path";

// Per-demo profile override: disable connected-pan so each click dips
// back to wide between zoomed beats. The default profile keeps
// adjacent clicks connected (camera holds at 1.6× and pans between
// them) which reads great for "I'm filling out a form" flows but the
// wrong feel for "I asked a question, look at the answer, click a
// citation" — the viewer wants a moment to read between actions.
const profileOverrides = {
  zoom: {
    ...DEFAULT_POLISH_PROFILE.zoom,
    connected_gap_ms: 0, // never connect by time
    connected_focal_dist_max: 0, // never connect by spatial proximity
  },
};

const planResult = await orchestratePlan({
  description:
    "nanoindex demo — pick a benchmark question, send, highlight the answer, click a yellow citation, switch to Entities",
  protagonist: "ask-question",
  base_url: "https://nanoindex.nanonets.com/demo",
  // walkthrough (45s cap) rather than demo (10s cap) — the answer-wait
  // alone is ~15s and the seven steps total ~38s.
  kind: "walkthrough",
  steps: [
    {
      action: "navigate",
      selector: "https://nanoindex.nanonets.com/demo",
      expected_duration_ms: 2500,
    },
    { action: "wait", expected_duration_ms: 1200 },

    // 1. Click the first benchmark question — pre-fills the textbox
    //    with the canned query.
    {
      action: "click",
      selector: "button:has-text('By drawing conclusions')",
      expected_duration_ms: 1800,
      note: "Pick benchmark question",
    },
    { action: "wait", expected_duration_ms: 600 },

    // 2. Send. The send button is the 3rd button.bg-neutral-900 on the
    //    page (the first two are 'Tree' and 'Fast' toggles). It's
    //    disabled until the textbox has content; the click above
    //    enables it.
    {
      action: "click",
      selector: "button.bg-neutral-900:nth-of-type(3), button.bg-neutral-900:has(svg):not(:has-text('Tree')):not(:has-text('Fast'))",
      expected_duration_ms: 1500,
      note: "Send the question",
    },

    // 3. Wait for the answer to stream in. ~15s typical; visual-
    //    stability primitive returns earlier when DOM mutations stop.
    //    The send click's zoom envelope (1.6× in, hold, out) completes
    //    well within this window, so the camera is back to wide (1.0×)
    //    by the time the answer finishes streaming — viewer reads the
    //    full response without a competing zoom.
    { action: "wait", expected_duration_ms: 20000 },

    // 4. Click a yellow citation pill. These are amber-styled buttons
    //    with section title + page number ("Note 11 — QUARTERLY RESULTS p.70").
    //    First-match works; the demo just picks the first inline citation.
    {
      action: "click",
      selector: "button.bg-amber-50",
      expected_duration_ms: 1800,
      note: "Open a citation",
    },
    { action: "wait", expected_duration_ms: 2500 },

    // 5. Close the citation panel. The X-close button has a lucide-x
    //    SVG inside; no aria-label, no text. Targeting the svg's class
    //    is the stable selector — the wrapping button uses generic
    //    Tailwind utility classes (p-1.5 rounded shrink-0).
    {
      action: "click",
      selector: "button:has(svg.lucide-x)",
      expected_duration_ms: 1500,
      note: "Close citation panel",
    },
    { action: "wait", expected_duration_ms: 800 },

    // 6. Click Entities — switches the right rail from the document
    //    tree to the entity list (581 entities for the demo doc).
    {
      action: "click",
      selector: "button:has-text('Entities')",
      expected_duration_ms: 1800,
      note: "Open Entities",
    },
    { action: "wait", expected_duration_ms: 1500 },
  ],
});

console.log(`✓ plan: ${planResult.plan.rationale}`);
if (!planResult.is_valid) {
  console.error("Invalid plan:", planResult.violations);
  process.exit(1);
}

const exec = await orchestrateExecute({ plan: planResult.plan });
console.log(`✓ recorded ${exec.manifest.frame_count} frames`);

// Per-step status — important for iteration when selectors miss.
for (const r of exec.step_results) {
  const mark = r.status === "fired" ? "✓" : r.status === "selector_missed" ? "✗" : "·";
  console.log(`  ${mark} step ${String(r.step_index).padStart(2)} ${r.action.padEnd(10)} ${r.status}`);
}

const planEdit = await orchestratePlanEdit({
  recording_id: exec.recording_id,
  profile_overrides: profileOverrides,
});
console.log(`✓ edit plan: ${path.relative(process.cwd(), planEdit.edit_plan_path)}`);
console.log(summarizeEditPlan(planEdit.edit_plan));

const out = await orchestrateExport({
  recording_id: exec.recording_id,
  profile_overrides: profileOverrides,
});
console.log(
  `✓ exported ${path.relative(process.cwd(), out.output_path)} · ${(out.size_bytes / 1024 / 1024).toFixed(2)} MB`,
);
