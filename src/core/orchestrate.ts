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
import { recordPlaywright } from "../recorder/playwright.js";
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
}

export interface ExecuteOrchestratorResult {
  recording_id: string;
  recording_dir: string;
  manifest: RecordingManifest;
}

export async function orchestrateExecute(
  args: ExecuteOrchestratorArgs,
): Promise<ExecuteOrchestratorResult> {
  const profile = await loadPolishProfile(args.rootDir);
  const paths = await ensureProjectDirs(args.rootDir);
  const captureProfile = { ...profile.capture, ...(args.capture_override ?? {}) };
  return recordPlaywright({
    plan: args.plan,
    capture: captureProfile,
    paths,
  });
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
