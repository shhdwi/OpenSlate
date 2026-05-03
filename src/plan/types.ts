/**
 * The DemoPlan: a sequence of Playwright actions, principle-validated before
 * execution. The agent generates a plan; the validator rejects plans that
 * violate principles (too many simultaneous gestures, too long, no interactions).
 */

export type WorkflowKind = "demo" | "walkthrough" | "readme_hero";

export type StepAction =
  | "navigate"
  | "click"
  | "type"
  | "wait"
  | "scroll"
  | "hover"
  | "wait_for_selector";

export interface PlanStep {
  /** what kind of interaction */
  action: StepAction;
  /** CSS selector or URL fragment, depending on action */
  selector?: string;
  /** for `type`, the text to enter */
  value?: string;
  /** human-readable note (used in chat-with-agent confirmation + as caption source) */
  note?: string;
  /** estimated duration; the recorder honors this for `wait` steps and uses it as a budget elsewhere */
  expected_duration_ms: number;
  /** when true, suppress auto-zoom for this step (e.g., dismissing a dropdown) */
  no_zoom?: boolean;
  /** only used in walkthrough plans: which beat does this step belong to */
  beat?: number;
}

export interface DemoPlan {
  /** unique id, short kebab slug derived from the protagonist */
  id: string;
  /** what is this demo about, in one sentence */
  description: string;
  /** which workflow / pacing cap to use */
  kind: WorkflowKind;
  /** dev server base URL */
  base_url: string;
  /** the protagonist (the one thing this demo lands on) */
  protagonist: string;
  /** ordered steps */
  steps: PlanStep[];
  /** sum of expected_duration_ms */
  total_duration_ms: number;
  /** brief reasoning the agent shows the user before executing */
  rationale: string;
}

/** A single principle violation found during plan validation. */
export interface PrincipleViolation {
  principle: string; // e.g., "exaggeration_restraint"
  message: string;
  step_index?: number;
  severity: "block" | "warn";
}
