/**
 * Real product demo against nanoindex.nanonets.com/demo — Nanonets's open-
 * source agentic RAG product. The /demo page hosts the live interactive
 * UI: a document tree view, an entities tab (581 entities), a chat tab
 * with a "Ask about this document..." input.
 *
 * Flow:
 *   1. Land on /demo
 *   2. Hold (let the tree view register)
 *   3. Click "Entities (581)" tab — switch view
 *   4. Hold so the entities panel is visible
 *   5. Click "Chat" tab — switch to chat
 *   6. Click into the question input
 *   7. Type a real question
 *   8. Hold so the typed query reads
 *
 * Connected-pan auto-merges the close-in-time clicks into one sustained
 * zoom that smoothly pans the focal between Tree → Entities → Chat → Input.
 */

import {
  orchestrateExecute,
  orchestrateExport,
  orchestratePlan,
} from "../src/core/orchestrate.js";

async function main() {
  const planResult = await orchestratePlan({
    description: "NanoIndex live demo — Tree → Entities → Chat → Ask",
    protagonist: "nanoindex-demo-tour",
    base_url: "https://nanoindex.nanonets.com/demo",
    kind: "demo",
    steps: [
      {
        action: "navigate",
        selector: "https://nanoindex.nanonets.com/demo",
        expected_duration_ms: 1800,
        note: "Open the live demo",
      },
      // Longer hero hold — /demo loads documents async; need ~2s for the
      // tree view to render before we start clicking around.
      { action: "wait", expected_duration_ms: 1500 },
      // Switch to the Entities view (581 entities — real product moment).
      {
        action: "click",
        selector: "button:has-text('Entities')",
        expected_duration_ms: 700,
        note: "Browse 581 entities",
      },
      { action: "wait", expected_duration_ms: 600 },
      // Switch to Chat — the agentic RAG interface.
      {
        action: "click",
        selector: "button:has-text('Chat')",
        expected_duration_ms: 700,
        note: "Open chat",
      },
      { action: "wait", expected_duration_ms: 400 },
      // Focus the question input and type a real query.
      {
        action: "click",
        selector: "input[placeholder*='Ask about']",
        expected_duration_ms: 600,
        note: "Ask a question",
      },
      {
        action: "type",
        selector: "input[placeholder*='Ask about']",
        value: "What are the key risks in this document?",
        expected_duration_ms: 1400,
      },
      // Hold so the typed query reads, then end.
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

  console.log("\nRecording NanoIndex live demo tour (browser_zoom: 1.25)...");
  const exec = await orchestrateExecute({
    plan: planResult.plan,
    // Zoom the page 25% so dense product UI reads at 1080p output.
    capture_override: { browser_zoom: 1.25 },
  });
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
