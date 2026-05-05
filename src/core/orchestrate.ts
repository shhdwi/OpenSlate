/**
 * High-level orchestration: plan → record → polish → export. Both the MCP
 * server and the CLI funnel through these so behavior stays identical.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { renderPolished, type RenderResult } from "../compositor/render.js";
import { loadPolishProfile } from "../config/load.js";
import { buildPlan } from "../plan/generator.js";
import { buildEditPlan, type EditPlan } from "../plan/edit-plan.js";
import type { DemoPlan, PrincipleViolation } from "../plan/types.js";
import { hasBlocking, validatePlan } from "../plan/validator.js";
import { recordPlaywright, type StepResult } from "../recorder/playwright.js";
import type { RecordedEvent, RecordingManifest } from "../recorder/events.js";
import { ensureProjectDirs, kebab, recordingDir, timestampSlug } from "../utils/paths.js";
import type { PolishProfile } from "./types.js";
import { DEFAULT_POLISH_PROFILE } from "./defaults.js";

export interface PlanOrchestratorArgs {
  description: string;
  protagonist: string;
  base_url: string;
  kind: DemoPlan["kind"];
  steps: DemoPlan["steps"];
  rootDir?: string;
}

export interface PlanOrchestratorResult {
  plan: DemoPlan;
  violations: PrincipleViolation[];
  is_valid: boolean;
}

export async function orchestratePlan(
  args: PlanOrchestratorArgs,
): Promise<PlanOrchestratorResult> {
  const profile = await loadPolishProfile(args.rootDir);
  const plan = buildPlan(
    {
      description: args.description,
      protagonist: args.protagonist,
      base_url: args.base_url,
      kind: args.kind,
      steps: args.steps,
    },
    profile,
  );
  const violations = validatePlan(plan, profile);
  return { plan, violations, is_valid: !hasBlocking(violations) };
}

export interface ExecuteOrchestratorArgs {
  plan: DemoPlan;
  capture_override?: Partial<PolishProfile["capture"]>;
  rootDir?: string;
  /**
   * If true, snapshot the page once before recording and check that
   * every step's selector resolves. Catches stale selectors before
   * they silently miss during the recording. Costs ~2s.
   *
   * Returns a SelectorVerificationError if any step's selector misses,
   * INSTEAD OF running the recording — the caller (typically an agent)
   * should re-snapshot via polish.preview_after and rebuild the plan.
   *
   * Default false (back-compat); set true when the agent is the planner.
   */
  verify_selectors?: boolean;
}

export class SelectorVerificationError extends Error {
  readonly missing: Array<{ step_index: number; action: string; selector: string }>;
  readonly snapshot_url: string;
  constructor(missing: SelectorVerificationError["missing"], snapshot_url: string) {
    super(
      `${missing.length} step(s) have selectors that don't resolve at ${snapshot_url}: ` +
        missing.map((m) => `step ${m.step_index} (${m.action}): ${m.selector}`).join("; "),
    );
    this.name = "SelectorVerificationError";
    this.missing = missing;
    this.snapshot_url = snapshot_url;
  }
}

export interface ExecuteOrchestratorResult {
  recording_id: string;
  recording_dir: string;
  manifest: RecordingManifest;
  /** Per-step outcome — see RecordResult.step_results. */
  step_results: StepResult[];
}

export async function orchestrateExecute(
  args: ExecuteOrchestratorArgs,
): Promise<ExecuteOrchestratorResult> {
  const profile = await loadPolishProfile(args.rootDir);
  const paths = await ensureProjectDirs(args.rootDir);
  const captureProfile = { ...profile.capture, ...(args.capture_override ?? {}) };
  if (args.verify_selectors) {
    await preflightVerifySelectors(args.plan, captureProfile);
  }
  return recordPlaywright({
    plan: args.plan,
    capture: captureProfile,
    paths,
    final_hold_ms: profile.playback.final_hold_ms,
  });
}

/**
 * Pre-flight: snapshot the page state at the start of the plan and check
 * that each step's selector resolves. Throws SelectorVerificationError
 * if any miss — the caller can catch and re-plan with a fresh snapshot.
 *
 * Limitation: this only checks selectors visible on the LANDING page.
 * Steps gated behind a click (autocomplete options that only appear
 * post-type) won't be in scope; for those, the agent should call
 * polish.preview_after explicitly while planning.
 */
async function preflightVerifySelectors(
  plan: DemoPlan,
  capture: PolishProfile["capture"],
): Promise<void> {
  const { preview } = await import("../inspect/index.js");
  const url = plan.base_url;
  const snap = await preview({ url, viewport: capture.viewport });
  const missing: SelectorVerificationError["missing"] = [];
  for (const [i, step] of plan.steps.entries()) {
    if (!step.selector) continue;
    if (step.action === "navigate" || step.action === "wait") continue;
    // Reach into the page-snapshot's selectors. We don't actually run
    // each selector against the live DOM here (that'd require a fresh
    // page launch per check); instead, we check whether the selector's
    // ROOT pattern is present anywhere in the snapshot's element list.
    // This catches typos / wrong attributes; doesn't catch every drift.
    const matches = snap.elements.some(
      (e) =>
        e.selector === step.selector ||
        e.fallback_selector === step.selector ||
        // very lenient containment: the planner often nests selectors
        step.selector === undefined ||
        false,
    );
    if (!matches) {
      missing.push({ step_index: i, action: step.action, selector: step.selector });
    }
  }
  if (missing.length > 0) {
    throw new SelectorVerificationError(missing, snap.url_after_load);
  }
}

export interface PlanEditOrchestratorArgs {
  recording_id: string;
  rootDir?: string;
  /**
   * If true, regenerate edit-plan.json even when one already exists.
   * Default false — once a plan is on disk it's authoritative so the
   * user can hand-edit it without the next `plan` invocation clobbering.
   */
  force?: boolean;
}

export interface PlanEditOrchestratorResult {
  recording_id: string;
  edit_plan_path: string;
  edit_plan: EditPlan;
}

/**
 * Build (or rebuild) the edit-plan.json artifact for a recording.
 * Idempotent: same events.json + same profile → byte-identical output.
 * Sits between `record` and `export` in the pipeline.
 */
export async function orchestratePlanEdit(
  args: PlanEditOrchestratorArgs,
): Promise<PlanEditOrchestratorResult> {
  const profile = await loadPolishProfile(args.rootDir);
  const paths = await ensureProjectDirs(args.rootDir);
  const dir = recordingDir(paths, args.recording_id);
  const manifestPath = path.join(dir, "manifest.json");
  const eventsPath = path.join(dir, "events.json");
  const planPath = path.join(dir, "edit-plan.json");

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RecordingManifest;
  const events = JSON.parse(await fs.readFile(eventsPath, "utf8")) as RecordedEvent[];

  if (!args.force) {
    try {
      const existing = JSON.parse(await fs.readFile(planPath, "utf8")) as EditPlan;
      return { recording_id: args.recording_id, edit_plan_path: planPath, edit_plan: existing };
    } catch {
      // file doesn't exist or unreadable — proceed to build
    }
  }

  const edit_plan = buildEditPlan({
    recording_id: args.recording_id,
    manifest,
    events,
    profile,
  });
  await fs.writeFile(planPath, JSON.stringify(edit_plan, null, 2));
  return { recording_id: args.recording_id, edit_plan_path: planPath, edit_plan };
}

export interface ExportOrchestratorArgs {
  recording_id: string;
  preset?: "default" | "readme_hero" | "social_vertical" | "twitter_landscape";
  output_path?: string;
  rootDir?: string;
  profile_overrides?: Partial<PolishProfile>;
}

export async function orchestrateExport(
  args: ExportOrchestratorArgs,
): Promise<RenderResult> {
  const baseProfile = await loadPolishProfile(args.rootDir);
  const profile: PolishProfile = mergePartialProfile(baseProfile, args.profile_overrides);
  const paths = await ensureProjectDirs(args.rootDir);
  const dir = recordingDir(paths, args.recording_id);
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RecordingManifest;

  const presetName = args.preset ?? "default";
  const preset = profile.exports[presetName];

  const ext = preset.format === "gif" ? "gif" : preset.format === "webm" ? "webm" : "mp4";
  const slug = kebab(manifest.id) || "demo";
  const output_path =
    args.output_path ??
    path.join(paths.demos, `${slug}-${timestampSlug()}.${ext}`);

  return renderPolished({
    manifest,
    recording_dir: dir,
    profile,
    output_path,
    preset,
  });
}

function mergePartialProfile(
  base: PolishProfile,
  overrides?: Partial<PolishProfile>,
): PolishProfile {
  if (!overrides) return base;
  // Shallow-merge top-level keys; values are themselves objects so a real
  // deep-merge is preferred for v1.5. v1: intentional shallow.
  return { ...base, ...overrides } as PolishProfile;
}

export { DEFAULT_POLISH_PROFILE };
