/**
 * Smoke test against a real hosted URL: nanonets.com signup CTA.
 *
 * Proves the recorder + compositor pipeline works for hosted sites, not
 * just localhost. Uses text-based selectors (Playwright's text= engine)
 * since we don't know nanonets's specific class names — selectors degrade
 * gracefully (the recorder swallows selector-not-found and continues).
 *
 * IMPORTANT: this script does NOT submit any form. It clicks the signup
 * CTA, lands on the signup page, hovers near the email input, then stops.
 * No real account is created.
 */

import {
  orchestrateExecute,
  orchestrateExport,
  orchestratePlan,
} from "../src/core/orchestrate.js";

async function main() {
  const planResult = await orchestratePlan({
    description: "Land on nanonets.com and open the signup flow",
    protagonist: "nanonets-signup",
    base_url: "https://nanonets.com",
    kind: "demo",
    steps: [
      // 1. Open the homepage. networkidle handles the actual load wait;
      //    the budget here is just for the post-load read.
      {
        action: "navigate",
        selector: "https://nanonets.com",
        expected_duration_ms: 1500,
        note: "Land on nanonets",
      },
      // 2. Hold on the hero so the viewer reads it.
      { action: "wait", expected_duration_ms: 1400 },
      // 3. Reveal what's below the fold (also gets the cursor moving).
      {
        action: "scroll",
        selector: "body",
        expected_duration_ms: 900,
        note: "Show feature section",
      },
      { action: "wait", expected_duration_ms: 600 },
      // 4. Click the most likely signup CTA. Playwright text= selector
      //    matches case-insensitive and trims whitespace. If none of these
      //    match, the step degrades to a wait — the smoke test still
      //    produces a valid recording showing the homepage scroll.
      {
        action: "click",
        selector:
          "a:has-text('Sign up'), button:has-text('Sign up'), a:has-text('Get started'), button:has-text('Get started'), a:has-text('Free trial'), button:has-text('Free trial')",
        expected_duration_ms: 1200,
        note: "Open signup",
      },
      // 5. Settle on the signup page (or wherever the click landed).
      { action: "wait", expected_duration_ms: 1400 },
    ],
  });

  console.log("Plan:");
  console.log(planResult.plan.rationale);
  console.log(`is_valid=${planResult.is_valid}`);
  if (planResult.violations.length > 0) {
    console.log("violations:");
    for (const v of planResult.violations) {
      console.log(`  ${v.severity} [${v.principle}]: ${v.message}`);
    }
  }
  if (!planResult.is_valid) {
    console.error("Plan is invalid — aborting.");
    process.exit(1);
  }

  console.log("\nRecording (this will take ~10-15s incl. real-network page load)...");
  const exec = await orchestrateExecute({ plan: planResult.plan });
  console.log(`✓ recorded ${exec.manifest.frame_count} frames in ${exec.recording_dir}`);
  console.log(
    `  duration_ms=${exec.manifest.duration_ms}, viewport=${exec.manifest.viewport.width}x${exec.manifest.viewport.height}`,
  );

  console.log("\nRendering polished mp4 (Remotion bundle is slow on first run)...");
  const out = await orchestrateExport({ recording_id: exec.recording_id });
  console.log(`\n✓ ${out.output_path}`);
  console.log(
    `  ${(out.duration_ms / 1000).toFixed(1)}s · ${out.dimensions[0]}×${out.dimensions[1]} · ${(out.size_bytes / 1024 / 1024).toFixed(2)} MB`,
  );
}

main().catch((err) => {
  console.error("smoke test failed:", err);
  process.exit(1);
});
