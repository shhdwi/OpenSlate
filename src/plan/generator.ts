/**
 * Plan generation helpers. Most plans come from the agent (which knows the
 * diff), but we provide deterministic helpers for:
 *  - building a plan from explicit step inputs (used by `record.plan` MCP tool)
 *  - inferring a tight default plan for "demo this URL" with no further input
 *
 * The plan generator does NOT call any LLM. The agent produces the plan
 * specification; this module shapes it into a validated DemoPlan.
 */

import type { PolishProfile } from "../core/types.js";
import { kebab } from "../utils/paths.js";
import type { DemoPlan, PlanStep, WorkflowKind } from "./types.js";

export interface PlanInput {
  description: string;
  protagonist: string;
  base_url: string;
  kind: WorkflowKind;
  steps: PlanStep[];
}

export function buildPlan(input: PlanInput, _profile: PolishProfile): DemoPlan {
  const total_duration_ms = input.steps.reduce((a, s) => a + s.expected_duration_ms, 0);

  return {
    id: kebab(input.protagonist || input.description) || "demo",
    description: input.description,
    kind: input.kind,
    base_url: input.base_url,
    protagonist: input.protagonist,
    steps: input.steps,
    total_duration_ms,
    rationale: explainPlan(input.steps, input.kind),
  };
}

function explainPlan(steps: PlanStep[], kind: WorkflowKind): string {
  const summary = steps
    .map((s, i) => {
      const t = (s.expected_duration_ms / 1000).toFixed(1);
      const noZoom = s.no_zoom ? " [no_zoom]" : "";
      switch (s.action) {
        case "navigate":
          return `${i + 1}. open ${s.selector ?? ""} (${t}s)${noZoom}`;
        case "click":
          return `${i + 1}. click ${s.selector ?? ""} (${t}s)${noZoom}`;
        case "type":
          return `${i + 1}. type ${JSON.stringify(s.value ?? "")} into ${s.selector ?? ""} (${t}s)`;
        case "wait":
          return `${i + 1}. wait ${t}s`;
        case "scroll":
          return `${i + 1}. scroll ${s.selector ?? ""} (${t}s)`;
        case "hover":
          return `${i + 1}. hover ${s.selector ?? ""} (${t}s)`;
        case "wait_for_selector":
          return `${i + 1}. wait for ${s.selector ?? ""} (${t}s)`;
      }
    })
    .join("\n");
  return `${kind} plan:\n${summary}`;
}

/** Soft default — "open URL, wait, click body, hold" — used as a placeholder when no agent is involved. */
export function blankDemoPlan(base_url: string, profile: PolishProfile): DemoPlan {
  const steps: PlanStep[] = [
    {
      action: "navigate",
      selector: base_url,
      expected_duration_ms: 1200,
      note: "Open the page",
    },
    {
      action: "wait",
      expected_duration_ms: 800,
    },
    {
      action: "scroll",
      expected_duration_ms: 1000,
      selector: "body",
      note: "Scroll the page",
    },
    {
      action: "wait",
      expected_duration_ms: 800,
    },
  ];
  return buildPlan(
    {
      description: `Smoke demo of ${base_url}`,
      protagonist: "smoke",
      base_url,
      kind: "demo",
      steps,
    },
    profile,
  );
}
