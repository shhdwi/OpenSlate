/**
 * .osl bundle — round-trip + invariant tests.
 *
 * Why this matters: the bundle format is the cross-surface contract. If
 * any surface (MCP, Mac app, webapp) writes a bundle that another can't
 * read cleanly, the "no platform constraint" guarantee is broken. These
 * tests are the gate.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OSL_SCHEMA_VERSION,
  buildFixture,
  isBundle,
  oslBundleManifestSchema,
  readBundle,
  readBundleManifest,
  writeBundleManifest,
} from "../src/osl/index.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osl-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe(".osl bundle", () => {
  it("buildFixture produces a valid, readable bundle", async () => {
    const bundleDir = await buildFixture({ outDir: path.join(tmpRoot, "fixture.osl") });

    expect(await isBundle(bundleDir)).toBe(true);

    const bundle = await readBundle(bundleDir);
    expect(bundle.manifest.schema_version).toBe(OSL_SCHEMA_VERSION);
    expect(bundle.manifest.source).toBe("cli");
    expect(bundle.manifest.capture_backend).toBe("playwright");
    expect(bundle.manifest.target.viewport.width).toBeGreaterThan(0);
    expect(bundle.manifest.target.fps).toBe(60);

    // Required JSON artifacts are resolved and well-formed.
    expect(Array.isArray(bundle.events)).toBe(true);
    expect(Array.isArray(bundle.cursor)).toBe(true);
    expect(bundle.edit_plan).toBeTruthy();

    // Artifact inventory includes every required slot with a sha256.
    const a = bundle.manifest.artifacts;
    expect(a.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.events.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.cursor.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.edit_plan.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Optional artifacts that the fixture doesn't produce must be absent
    // (not present-but-null) so consumers can do `if (a.raw_capture)`.
    expect(a.raw_capture).toBeUndefined();
    expect(a.mic_audio).toBeUndefined();
    expect(a.system_audio).toBeUndefined();
  });

  it("rewriting the bundle preserves bundle_id and created_at", async () => {
    const bundleDir = await buildFixture({ outDir: path.join(tmpRoot, "stable.osl") });
    const first = await readBundleManifest(bundleDir);

    // Wait one ms so modified_at can change without a clock collision.
    await new Promise((r) => setTimeout(r, 5));

    await writeBundleManifest({
      bundleRoot: bundleDir,
      recordingId: first.recording_id,
      source: first.source,
      captureBackend: first.capture_backend,
      producer: first.producer,
      target: first.target,
    });
    const second = await readBundleManifest(bundleDir);

    expect(second.bundle_id).toBe(first.bundle_id);
    expect(second.created_at).toBe(first.created_at);
    expect(second.modified_at).not.toBe(first.modified_at);
  });

  it("rejects a bundle with the wrong schema_version", async () => {
    const bundleDir = await buildFixture({ outDir: path.join(tmpRoot, "bad.osl") });
    const manifestPath = path.join(bundleDir, "osl-bundle.json");
    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));

    // Older / unknown versions trigger the migration seam. Today the
    // migrator stamps to current; a forged future version should still
    // fail validation if it ships malformed fields.
    raw.schema_version = "9.9";
    raw.target = { not_a_valid_shape: true };
    await fs.writeFile(manifestPath, JSON.stringify(raw, null, 2));

    await expect(readBundle(bundleDir)).rejects.toThrow();
  });

  it("rejects an existing recording directory that lacks required artifacts", async () => {
    const halfDir = path.join(tmpRoot, "half.osl");
    await fs.mkdir(halfDir, { recursive: true });
    await fs.writeFile(path.join(halfDir, "manifest.json"), "{}");
    // No events.json, cursor.json, edit-plan.json — should fail.

    await expect(
      writeBundleManifest({
        bundleRoot: halfDir,
        recordingId: "x",
        source: "cli",
        captureBackend: "playwright",
        producer: { name: "openslate", version: "0.0.0" },
        target: { label: "x", viewport: { width: 1280, height: 800 }, device_pixel_ratio: 1, fps: 60 },
      }),
    ).rejects.toThrow(/missing required artifacts/);
  });

  it("validates a bundle manifest via Zod (positive path)", async () => {
    const bundleDir = await buildFixture({ outDir: path.join(tmpRoot, "valid.osl") });
    const raw = JSON.parse(await fs.readFile(path.join(bundleDir, "osl-bundle.json"), "utf8"));
    expect(() => oslBundleManifestSchema.parse(raw)).not.toThrow();
  });
});
