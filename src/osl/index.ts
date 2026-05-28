/**
 * .osl bundle — public surface.
 *
 * Import from "openslate/osl" to read, write, validate, or generate .osl
 * project bundles. Stable across surfaces (MCP/CLI, Mac app, webapp).
 */

export type {
  OslBundle,
  OslBundleManifest,
  OslCaptureBackend,
  OslSource,
  OslArtifactRef,
  OslAudioInfo,
} from "./types.js";
export { OSL_SCHEMA_VERSION } from "./types.js";

export { oslBundleManifestSchema } from "./schema.js";
export type { ParsedOslBundleManifest } from "./schema.js";

export { readBundle, readBundleManifest, isBundle } from "./reader.js";
export { writeBundleManifest } from "./writer.js";
export type { WriteBundleManifestInput } from "./writer.js";

export { migrateBundleManifest } from "./migrate.js";
export { buildFixture } from "./fixture.js";
export type { BuildFixtureOptions } from "./fixture.js";
