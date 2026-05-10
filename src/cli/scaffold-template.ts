/**
 * Renders the starter demo.mjs that `openslate scaffold` drops at the
 * project root. Mirrors the shape of examples/quickstart/demo.mjs but
 * imports from the published `openslate` package and ships a single
 * placeholder click step instead of a full nanoindex flow.
 *
 * Kept testable (drift-protection) the same way `renderInitTemplate` is.
 */

export interface ScaffoldOptions {
  /** dev server URL or a placeholder; substituted into the steps[] navigate */
  url: string;
  /** kebab slug used as the protagonist + recording id prefix */
  protagonist: string;
}

export function renderScaffoldTemplate(opts: ScaffoldOptions): string {
  const { url, protagonist } = opts;
  return `// openSlate demo script. Edit the steps array below, then run:
//
//   node ${defaultFilename(protagonist)}
//
// Output lands in ./demos/. First run downloads Chromium (~150MB, one-time).
//
// Selector tips:
//   - CSS or Playwright text-match: button:has-text('Sign in')
//   - Verify selectors before recording: \`npx openslate preview ${url}\`
//   - Misses fail-soft (logged as 'selector_missed'); the run continues.

import {
  orchestratePlan,
  orchestrateExecute,
  orchestratePlanEdit,
  orchestrateExport,
  summarizeEditPlan,
} from "openslate";
import path from "node:path";

const planResult = await orchestratePlan({
  description: "<one-sentence description of the demo>",
  protagonist: "${protagonist}",
  base_url: "${url}",
  // "demo" caps at 10s, "walkthrough" at 45s, "readme_hero" at 6s.
  kind: "demo",
  steps: [
    { action: "navigate", selector: "${url}", expected_duration_ms: 2000 },
    { action: "wait", expected_duration_ms: 800 },

    // TODO: replace this placeholder with your real interactions.
    // Each step is one of: click, type, wait, scroll, hover, highlight,
    // wait_for_selector. \`expected_duration_ms\` is a soft budget the
    // recorder honors for waits and uses for pacing on actions.
    {
      action: "click",
      selector: "button:has-text('Get started')",
      expected_duration_ms: 1500,
      note: "first click",
    },
    { action: "wait", expected_duration_ms: 800 },
  ],
});

console.log(\`▶ plan: \${planResult.plan.rationale}\`);
if (!planResult.is_valid) {
  console.error("✗ plan invalid:", planResult.violations);
  process.exit(1);
}

const exec = await orchestrateExecute({ plan: planResult.plan });
console.log(\`✓ recorded \${exec.manifest.frame_count} frames\`);
for (const r of exec.step_results) {
  const mark = r.status === "fired" ? "✓" : r.status === "selector_missed" ? "✗" : "·";
  console.log(\`  \${mark} step \${String(r.step_index).padStart(2)} \${r.action.padEnd(10)} \${r.status}\`);
}

const planEdit = await orchestratePlanEdit({ recording_id: exec.recording_id });
console.log(summarizeEditPlan(planEdit.edit_plan));

const out = await orchestrateExport({ recording_id: exec.recording_id });
console.log(
  \`✓ \${path.relative(process.cwd(), out.output_path)} · \${(out.size_bytes / 1024 / 1024).toFixed(2)} MB\`,
);
`;
}

export function defaultFilename(protagonist: string): string {
  return `${protagonist}.mjs`;
}
