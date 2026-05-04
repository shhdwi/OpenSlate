/**
 * Real demo against nanoindex.nanonets.com — Nanonets's open-source agentic
 * RAG product. The homepage has Finance / Legal / Healthcare buttons that
 * toggle visible example content; perfect material for a multi-beat demo.
 *
 * Flow:
 *   1. Land on homepage (post-nav settle handles page-load period)
 *   2. Hold on hero (read the title)
 *   3. Click "Finance" tab
 *   4. Hold (let viewer see the Finance example)
 *   5. Click "Healthcare" tab
 *   6. Hold (let viewer see the Healthcare example)
 *   7. Hover "Try the demo" CTA
 *   8. Final hold
 *
 * Connected-pan auto-merges close-in-time clicks into one sustained zoom
 * with smooth focal interpolation between Finance → Healthcare → CTA.
 */

import {
  orchestrateExecute,
  orchestrateExport,
  orchestratePlan,
} from "../src/core/orchestrate.js";

async function main() {
  const planResult = await orchestratePlan({
    description: "NanoIndex use-case showcase — Finance + Healthcare + CTA",
    protagonist: "nanoindex-tour",
    base_url: "https://nanoindex.nanonets.com",
    kind: "demo",
    steps: [
      {
        action: "navigate",
        selector: "https://nanoindex.nanonets.com",
        expected_duration_ms: 1000,
        note: "Open NanoIndex",
      },
      // Brief hero hold so the viewer registers what NanoIndex is.
      { action: "wait", expected_duration_ms: 700 },
      // Show the Finance use case.
      {
        action: "click",
        selector: "button:has-text('Finance')",
        expected_duration_ms: 900,
        note: "Try Finance docs",
      },
      // Hold so the use-case content reads.
      { action: "wait", expected_duration_ms: 800 },
      // Show the Healthcare use case — connected-pan smoothly transitions.
      {
        action: "click",
        selector: "button:has-text('Healthcare')",
        expected_duration_ms: 900,
        note: "Or Healthcare records",
      },
      { action: "wait", expected_duration_ms: 800 },
      // Land on the CTA. Hover (no real click — we don't navigate away).
      {
        action: "hover",
        selector: "a:has-text('Try the demo')",
        expected_duration_ms: 700,
        note: "Try the demo",
      },
      { action: "wait", expected_duration_ms: 1100 },
    ],
  });

  console.log("Plan:");
  console.log(planResult.plan.rationale);
  console.log(`is_valid=${planResult.is_valid}`);
  if (planResult.violations.length > 0) {
    for (const v of planResult.violations) {
      console.log(`  ${v.severity} [${v.principle}]: ${v.message}`);
    }
  }
  if (!planResult.is_valid) {
    console.error("Plan invalid — aborting.");
    process.exit(1);
  }

  console.log("\nRecording NanoIndex tour...");
  const exec = await orchestrateExecute({ plan: planResult.plan });
  console.log(
    `✓ recorded ${exec.manifest.frame_count} frames · duration=${exec.manifest.duration_ms}ms · trim=${exec.manifest.start_offset_ms}ms`,
  );

  console.log("\nRendering polished mp4...");
  const out = await orchestrateExport({ recording_id: exec.recording_id });
  console.log(`\n✓ ${out.output_path}`);
  console.log(
    `  ${(out.duration_ms / 1000).toFixed(1)}s · ${out.dimensions[0]}×${out.dimensions[1]} · ${(out.size_bytes / 1024 / 1024).toFixed(2)} MB`,
  );

  console.log("\nAlso rendering README hero gif...");
  const gif = await orchestrateExport({
    recording_id: exec.recording_id,
    preset: "readme_hero",
  });
  console.log(
    `✓ ${gif.output_path}  (${(gif.size_bytes / 1024).toFixed(0)} KB · ${gif.dimensions[0]}×${gif.dimensions[1]})`,
  );
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
