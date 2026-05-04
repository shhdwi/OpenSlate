/**
 * Full nanonets signup-flow smoke test.
 *
 * Flow:
 *   1. Land on accounts.nanonets.com/signup
 *   2. Hold so the form reads
 *   3. Click into email field (auto-zoom on protagonist click)
 *   4. Type a fake email
 *   5. Click into password field
 *   6. Type a fake password
 *   7. Hover the "Create free account" button (no click — we don't make an account)
 *   8. Hold for the final beat
 *
 * This stops just BEFORE the submit click so no real account is created.
 * Total budget: ~10s (within demo pacing cap).
 *
 * Real selectors discovered via scripts/probe-nanonets.ts:
 *   #email, #password, button:has-text("Create free account")
 */

import {
  orchestrateExecute,
  orchestrateExport,
  orchestratePlan,
} from "../src/core/orchestrate.js";

async function main() {
  const planResult = await orchestratePlan({
    description: "Full signup form fill on accounts.nanonets.com",
    protagonist: "nanonets-signup-flow",
    base_url: "https://accounts.nanonets.com/signup",
    kind: "demo",
    steps: [
      // 1. Land on the signup page. Recorder enforces a 1500ms post-nav
      //    settle on top of the navigate's networkidle + this budget.
      {
        action: "navigate",
        selector: "https://accounts.nanonets.com/signup",
        expected_duration_ms: 1200,
        note: "Sign up for Nanonets",
      },
      // 2. Hero hold — let the viewer register what page we're on.
      { action: "wait", expected_duration_ms: 800 },
      // 3. Click into the email field. Triggers auto-zoom; connected-pan
      //    will sustain it through the subsequent type + click sequence.
      {
        action: "click",
        selector: "#email",
        expected_duration_ms: 900,
        note: "Enter your email",
      },
      // 4. Type the email. Synthetic 'type' event the recorder emits is
      //    zoom-eligible too; connected-pan keeps us in the zoomed view.
      {
        action: "type",
        selector: "#email",
        value: "demo@example.dev",
        expected_duration_ms: 700,
      },
      // 5. Click password field — connected-pan smoothly transitions the
      //    focal from email to password; no zoom-out → zoom-in jitter.
      {
        action: "click",
        selector: "#password",
        expected_duration_ms: 700,
        note: "Choose a password",
      },
      // 6. Type the password.
      {
        action: "type",
        selector: "#password",
        value: "OpenSlateTest!2026",
        expected_duration_ms: 800,
      },
      // 7. Hover the submit button. The hover step also emits a synthetic
      //    interaction event; if it's far enough from password (it is —
      //    button is below), it'll start a fresh envelope cleanly.
      {
        action: "hover",
        selector: "button:has-text('Create free account')",
        expected_duration_ms: 800,
        note: "Click to create account",
      },
      // 8. Final hold — let the viewer see the filled form.
      { action: "wait", expected_duration_ms: 1200 },
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
    console.error("Plan invalid — aborting.");
    process.exit(1);
  }

  console.log("\nRecording signup flow (~12-15s incl. real-network load + typing)...");
  const exec = await orchestrateExecute({ plan: planResult.plan });
  console.log(`✓ recorded ${exec.manifest.frame_count} frames in ${exec.recording_dir}`);
  console.log(
    `  duration_ms=${exec.manifest.duration_ms}, viewport=${exec.manifest.viewport.width}x${exec.manifest.viewport.height}`,
  );

  console.log("\nRendering polished mp4...");
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
