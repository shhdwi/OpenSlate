/**
 * Principle-based plan validation. Runs before execution so the agent can
 * propose fixes in plain English. The hard rules ("block") refuse execution;
 * "warn" rules surface to the agent for it to acknowledge or override.
 */

import type { PolishProfile } from "../core/types.js";
import type { DemoPlan, PrincipleViolation } from "./types.js";

export function validatePlan(plan: DemoPlan, profile: PolishProfile): PrincipleViolation[] {
  const violations: PrincipleViolation[] = [];
  const cap_s = profile.pacing.max_total_duration_s[plan.kind];
  const total_s = plan.total_duration_ms / 1000;

  // principle 1+8 — pacing cap
  if (total_s > cap_s) {
    violations.push({
      principle: "timing_and_spacing",
      message: `Plan total ${total_s.toFixed(1)}s exceeds pacing cap of ${cap_s}s for ${plan.kind}.`,
      severity: "block",
    });
  }

  // principle 8 (restraint) — suppress double-zooms within skip_if_within_ms
  const click_indices = plan.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.action === "click" && !s.no_zoom);
  for (let k = 1; k < click_indices.length; k++) {
    const prev = click_indices[k - 1];
    const cur = click_indices[k];
    if (!prev || !cur) continue;
    const between = plan.steps
      .slice(prev.i, cur.i)
      .reduce((a, s) => a + s.expected_duration_ms, 0);
    if (between < profile.auto_zoom.skip_if_within_ms) {
      violations.push({
        principle: "exaggeration_restraint",
        message: `Two zoom-eligible clicks within ${profile.auto_zoom.skip_if_within_ms}ms (steps ${prev.i} and ${cur.i}). Add no_zoom to one or insert a wait step.`,
        step_index: cur.i,
        severity: "warn",
      });
    }
  }

  // principle 8 — appeal hygiene: at least one interaction
  const has_interaction = plan.steps.some(
    (s) => s.action === "click" || s.action === "type" || s.action === "scroll" || s.action === "hover",
  );
  if (!has_interaction) {
    violations.push({
      principle: "appeal",
      message:
        "Plan has zero interactions. Static demos read as flat. Add at least one click/type/scroll/hover.",
      severity: "block",
    });
  }

  // principle 4 (anticipation) — every click step must allow pre_click_settle_ms
  for (const [i, step] of plan.steps.entries()) {
    if (step.action !== "click") continue;
    if (step.expected_duration_ms < profile.cursor.pre_click_settle_ms + 80) {
      violations.push({
        principle: "anticipation",
        message: `Click step ${i} budget (${step.expected_duration_ms}ms) is too tight for pre_click_settle_ms (${profile.cursor.pre_click_settle_ms}ms). Raise expected_duration_ms or click will feel teleported.`,
        step_index: i,
        severity: "warn",
      });
    }
  }

  // sanity: minimum total length
  if (total_s < 2) {
    violations.push({
      principle: "appeal",
      message: `Plan is too short (${total_s.toFixed(1)}s) to read. Minimum 2s.`,
      severity: "block",
    });
  }

  // principle 1 — minimum holds between actions
  for (let i = 1; i < plan.steps.length; i++) {
    const a = plan.steps[i - 1];
    const b = plan.steps[i];
    if (!a || !b) continue;
    const interactive = (s: { action: string }) =>
      s.action === "click" || s.action === "type" || s.action === "scroll";
    if (interactive(a) && interactive(b)) {
      const gap = a.expected_duration_ms;
      if (gap < profile.pacing.min_hold_between_actions_ms) {
        violations.push({
          principle: "timing_and_spacing",
          message: `Step ${i - 1} → ${i}: gap ${gap}ms is below min_hold_between_actions_ms (${profile.pacing.min_hold_between_actions_ms}ms). Insert a wait step.`,
          step_index: i,
          severity: "warn",
        });
      }
    }
  }

  return violations;
}

export function hasBlocking(violations: PrincipleViolation[]): boolean {
  return violations.some((v) => v.severity === "block");
}

export function formatViolations(violations: PrincipleViolation[]): string {
  if (violations.length === 0) return "Plan is valid.";
  return violations
    .map(
      (v) =>
        `${v.severity === "block" ? "BLOCK" : "warn"} [${v.principle}]${
          v.step_index != null ? ` step ${v.step_index}` : ""
        }: ${v.message}`,
    )
    .join("\n");
}
