/**
 * Bundle writer. Two responsibilities:
 *  1. Write `osl-bundle.json` to an existing recording directory so it
 *     can be consumed as a bundle. This is the additive integration with
 *     the existing pipeline — recordings already have every artifact;
 *     we just declare them.
 *  2. Pack/unpack the directory form into/out of a single `.osl` file
 *     (zip). Implemented later; the directory form is the canonical one.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { oslBundleManifestSchema } from "./schema.js";
import type { OslArtifactRef, OslBundleManifest } from "./types.js";
import { OSL_SCHEMA_VERSION } from "./types.js";

/**
 * Compute a sha256 of a file. Streamed so large captures don't OOM.
 * Returns null if the file doesn't exist — caller decides whether that's
 * an error or "this artifact wasn't captured."
 */
async function hashFile(filePath: string): Promise<{ sha256: string; size: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    const hash = crypto.createHash("sha256");
    const fh = await fs.open(filePath, "r");
    try {
      const stream = fh.createReadStream();
      for await (const chunk of stream) hash.update(chunk as Buffer);
    } finally {
      await fh.close();
    }
    return { sha256: hash.digest("hex"), size: stat.size };
  } catch {
    return null;
  }
}

async function maybeArtifact(
  bundleRoot: string,
  relativePath: string,
): Promise<OslArtifactRef | undefined> {
  const abs = path.join(bundleRoot, relativePath);
  const meta = await hashFile(abs);
  if (!meta) return undefined;
  return { path: relativePath, sha256: meta.sha256, size_bytes: meta.size };
}

async function countFiles(dir: string): Promise<number | undefined> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length;
  } catch {
    return undefined;
  }
}

export interface WriteBundleManifestInput {
  /** Path to the directory that holds the artifacts. */
  bundleRoot: string;
  /** Required: stable recording id (matches manifest.json.recording_id). */
  recordingId: string;
  /** Which surface invoked the write. */
  source: OslBundleManifest["source"];
  /** Which capture backend produced the frames. */
  captureBackend: OslBundleManifest["capture_backend"];
  /** Producer tool version (typically the openslate package version). */
  producer: { name: string; version: string };
  /** Sticky metadata about the recording target. */
  target: OslBundleManifest["target"];
  /** Optional title shown in editor UIs. */
  title?: string;
  /** Optional free-text notes. */
  notes?: string;
  /** Optional audio metadata when audio was captured. */
  audio?: OslBundleManifest["audio"];
  /** Optional explicit bundle_id; otherwise a random one is generated. */
  bundleId?: string;
}

/**
 * Write `osl-bundle.json` to an existing recording directory. Idempotent:
 * running twice on the same directory updates `modified_at` and refreshes
 * artifact hashes/sizes, but the bundle_id is preserved across writes if
 * one already exists.
 */
export async function writeBundleManifest(
  input: WriteBundleManifestInput,
): Promise<OslBundleManifest> {
  const { bundleRoot } = input;
  const manifestPath = path.join(bundleRoot, "osl-bundle.json");

  // Preserve bundle_id across re-writes so external references stay valid.
  let existingBundleId: string | undefined = input.bundleId;
  let createdAt: string | undefined;
  try {
    const prior = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Partial<OslBundleManifest>;
    existingBundleId = existingBundleId ?? prior.bundle_id;
    createdAt = prior.created_at;
  } catch {
    /* first write; fine */
  }

  const nowIso = new Date().toISOString();

  // Required artifacts — these should all exist after a normal recording.
  const [manifest, events, cursor, edit_plan, polish_config, raw_capture, mic_audio, system_audio] =
    await Promise.all([
      maybeArtifact(bundleRoot, "manifest.json"),
      maybeArtifact(bundleRoot, "events.json"),
      maybeArtifact(bundleRoot, "cursor.json"),
      maybeArtifact(bundleRoot, "edit-plan.json"),
      maybeArtifact(bundleRoot, "polish.config.json"),
      maybeArtifact(bundleRoot, "raw/capture.mp4"),
      maybeArtifact(bundleRoot, "raw/mic.wav"),
      maybeArtifact(bundleRoot, "raw/system.wav"),
    ]);

  if (!manifest || !events || !cursor || !edit_plan) {
    throw new Error(
      `Cannot write osl-bundle.json: missing required artifacts in ${bundleRoot}. ` +
        `Need manifest.json, events.json, cursor.json, edit-plan.json.`,
    );
  }

  const [frames_count, thumbs_count] = await Promise.all([
    countFiles(path.join(bundleRoot, "frames")),
    countFiles(path.join(bundleRoot, "thumbnails")),
  ]);

  const bundle: OslBundleManifest = {
    schema_version: OSL_SCHEMA_VERSION,
    bundle_id: existingBundleId ?? crypto.randomUUID(),
    recording_id: input.recordingId,
    source: input.source,
    capture_backend: input.captureBackend,
    created_at: createdAt ?? nowIso,
    modified_at: nowIso,
    title: input.title,
    notes: input.notes,
    producer: input.producer,
    artifacts: {
      manifest,
      events,
      cursor,
      edit_plan,
      polish_config,
      raw_capture,
      mic_audio,
      system_audio,
      frames_dir: frames_count !== undefined ? { path: "frames", count: frames_count } : undefined,
      thumbnails_dir:
        thumbs_count !== undefined ? { path: "thumbnails", count: thumbs_count } : undefined,
    },
    audio: input.audio,
    target: input.target,
  };

  // Validate before writing so we never persist a broken manifest.
  const parsed = oslBundleManifestSchema.parse(bundle);
  await fs.writeFile(manifestPath, JSON.stringify(parsed, null, 2));
  return bundle;
}
