/**
 * Shapes for MCP tool inputs/outputs. Mirrors the API surface described in
 * the SKILL.md so agents and humans see the same contract.
 */

import type { PolishProfile } from "../core/types.js";
import type { DemoPlan, PrincipleViolation, WorkflowKind } from "../plan/types.js";
import type { RecordingManifest } from "../recorder/events.js";

// ── record.plan ────────────────────────────────────────────────────────────
export interface PlanArgs {
  description: string;
  protagonist: string;
  base_url: string;
  kind: WorkflowKind;
  steps: DemoPlan["steps"];
}

export interface PlanResult {
  plan: DemoPlan;
  violations: PrincipleViolation[];
  is_valid: boolean;
}

// ── record.execute ─────────────────────────────────────────────────────────
export interface ExecuteArgs {
  plan: DemoPlan;
  /** override default capture profile from polish.config.ts */
  capture_override?: Partial<PolishProfile["capture"]>;
}

export interface ExecuteResult {
  recording_id: string;
  recording_dir: string;
  manifest: RecordingManifest;
}

// ── record.polish ──────────────────────────────────────────────────────────
export interface PolishArgs {
  recording_id: string;
  /** override fields in the loaded polish.config.ts; not a full replacement */
  profile_overrides?: Partial<PolishProfile>;
}

export interface PolishResult {
  polished_id: string; // currently equal to recording_id; v2 will diverge
  preview_path?: string;
  profile_used: PolishProfile;
}

// ── record.export ──────────────────────────────────────────────────────────
export interface ExportArgs {
  polished_id: string;
  preset?: "default" | "readme_hero" | "social_vertical" | "twitter_landscape";
  output_path?: string;
}

export interface ExportResult {
  output_path: string;
  size_bytes: number;
  duration_ms: number;
  dimensions: [number, number];
}

// ── record.list ────────────────────────────────────────────────────────────
export interface ListResult {
  recordings: Array<{
    id: string;
    created_at: string;
    base_url: string;
    duration_ms: number;
    frame_count: number;
  }>;
}

// ── record.status ──────────────────────────────────────────────────────────
export interface StatusArgs {
  recording_id: string;
}

export interface StatusResult {
  recording_id: string;
  state: "recording" | "polishing" | "rendering" | "done" | "error" | "unknown";
  progress?: number; // 0..1
  message?: string;
}
