// openSlate quick-start demo. Records a 3-step demo of nanoindex.nanonets.com,
// applies the default polish profile, exports an mp4. No config file needed —
// the package's built-in defaults handle everything.
//
// Run from the openslate repo root:
//
//   bun run build           # one time, builds the package
//   bun examples/quickstart/demo.mjs
//
// Output: ./demos/quickstart-<timestamp>.mp4 (~10-15s, 1080p mp4)
//
// To adapt for your own site: change `base_url` and the `steps` array. Each
// step is one of: navigate / click / type / scroll / hover / highlight / wait.

import {
  orchestratePlan,
  orchestrateExecute,
  orchestratePlanEdit,
  orchestrateExport,
  summarizeEditPlan,
} from "../../dist/index.js";
import path from "node:path";

const planResult = await orchestratePlan({
  description: "nanoindex demo — expand entity tree + ask a sample question",
  protagonist: "ask-question",
  base_url: "https://nanoindex.nanonets.com/demo",
  kind: "demo",
  steps: [
    {
      action: "navigate",
      selector: "https://nanoindex.nanonets.com/demo",
      expected_duration_ms: 2500,
    },
    { action: "wait", expected_duration_ms: 1200 },
    {
      action: "click",
      selector: "button:has-text('Expand all')",
      expected_duration_ms: 1800,
      note: "Expand entity tree",
    },
    { action: "wait", expected_duration_ms: 800 },
    {
      action: "click",
      selector: "button:has-text('What was the FY2019 EBITDA')",
      expected_duration_ms: 2200,
      note: "Ask EBITDA question",
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

const planEdit = await orchestratePlanEdit({ recording_id: exec.recording_id });
console.log(`✓ edit plan: ${path.relative(process.cwd(), planEdit.edit_plan_path)}`);
console.log(summarizeEditPlan(planEdit.edit_plan));

const out = await orchestrateExport({ recording_id: exec.recording_id });
console.log(
  `✓ exported ${path.relative(process.cwd(), out.output_path)} · ${(out.size_bytes / 1024 / 1024).toFixed(2)} MB`,
);
