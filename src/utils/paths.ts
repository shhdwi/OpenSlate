/**
 * File path conventions. All recordings, polished clips, and exports live
 * under deterministic local paths so the agent and the user see the same
 * tree without negotiation.
 */

import path from "node:path";
import fs from "node:fs/promises";

export interface ProjectPaths {
  root: string;
  recordings: string;
  demos: string;
  benchmark: string;
  cache: string;
}

export function projectPaths(rootDir: string = process.cwd()): ProjectPaths {
  return {
    root: rootDir,
    recordings: path.join(rootDir, "recordings"),
    demos: path.join(rootDir, "demos"),
    benchmark: path.join(rootDir, "benchmark"),
    cache: path.join(rootDir, ".openslate-cache"),
  };
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function ensureProjectDirs(rootDir?: string): Promise<ProjectPaths> {
  const p = projectPaths(rootDir);
  await Promise.all([ensureDir(p.recordings), ensureDir(p.demos), ensureDir(p.cache)]);
  return p;
}

export function recordingDir(paths: ProjectPaths, recordingId: string): string {
  return path.join(paths.recordings, recordingId);
}

export function timestampSlug(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}
