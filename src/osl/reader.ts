/**
 * Bundle reader. Resolves `<root>/osl-bundle.json`, validates it, then
 * lazily reads the declared JSON artifacts and returns a typed bundle.
 *
 * Heavy artifacts (mp4, wav, PNG sequence) are NOT read here — they stay
 * on disk and the consumer pulls them when it needs to render. This keeps
 * `readBundle()` cheap even for very large projects.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { EditPlan } from "../plan/edit-plan.js";
import type { CursorSample, RecordedEvent, RecordingManifest } from "../recorder/events.js";
import { oslBundleManifestSchema } from "./schema.js";
import { migrateBundleManifest } from "./migrate.js";
import type { OslBundle, OslBundleManifest } from "./types.js";

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

/**
 * Read an .osl bundle from a directory. Throws if the bundle manifest
 * is missing or invalid.
 */
export async function readBundle(bundleRoot: string): Promise<OslBundle> {
  const manifestPath = path.join(bundleRoot, "osl-bundle.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Could not read osl-bundle.json at ${manifestPath}. ` +
        `Is this an .osl bundle? (${(err as Error).message})`,
    );
  }

  // Apply forward-migrations before validation so old bundles work.
  const migrated = migrateBundleManifest(raw);
  const manifest = oslBundleManifestSchema.parse(migrated) as OslBundleManifest;

  // Resolve required artifacts.
  const recording_manifest = await readJson<RecordingManifest>(
    path.join(bundleRoot, manifest.artifacts.manifest.path),
  );
  const events = await readJson<RecordedEvent[]>(
    path.join(bundleRoot, manifest.artifacts.events.path),
  );
  const cursor = await readJson<CursorSample[]>(
    path.join(bundleRoot, manifest.artifacts.cursor.path),
  );
  const edit_plan = await readJson<EditPlan>(
    path.join(bundleRoot, manifest.artifacts.edit_plan.path),
  );

  let polish_config: unknown;
  if (manifest.artifacts.polish_config) {
    polish_config = await readJson(
      path.join(bundleRoot, manifest.artifacts.polish_config.path),
    );
  }

  return {
    root: bundleRoot,
    manifest,
    recording_manifest,
    events,
    cursor,
    edit_plan,
    polish_config,
  };
}

/**
 * Cheap probe: does this directory look like an .osl bundle? Used by
 * surfaces that want to auto-detect bundle vs. loose directory.
 */
export async function isBundle(bundleRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(bundleRoot, "osl-bundle.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read just the manifest without resolving the JSON artifacts. Used by
 * UIs that need to list bundles in a directory without paying the cost
 * of parsing every project's full event log.
 */
export async function readBundleManifest(bundleRoot: string): Promise<OslBundleManifest> {
  const manifestPath = path.join(bundleRoot, "osl-bundle.json");
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  return oslBundleManifestSchema.parse(migrateBundleManifest(raw)) as OslBundleManifest;
}
