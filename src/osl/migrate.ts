/**
 * Forward-migrations for the .osl bundle manifest. We only ever bump
 * `schema_version` when there's a breaking change; minor additions go in
 * with optional fields and don't require migration.
 *
 * The contract: `migrateBundleManifest(raw)` accepts ANY past version and
 * returns a manifest shaped like the current `OSL_SCHEMA_VERSION`. Loaders
 * call this BEFORE Zod validation so old bundles keep working.
 *
 * Today there's only v1.0 — this file is the seam where future migrations
 * land. Keep migrations small, pure, and order-able by version.
 */

import { OSL_SCHEMA_VERSION } from "./types.js";

type AnyRecord = Record<string, unknown>;

/** Coerce/upgrade a raw bundle manifest to the current schema version. */
export function migrateBundleManifest(raw: unknown): unknown {
  if (raw == null || typeof raw !== "object") return raw;
  const m = raw as AnyRecord;
  const version = typeof m.schema_version === "string" ? m.schema_version : "0.0";

  // No migrations needed yet — v1.0 is the floor.
  if (version === OSL_SCHEMA_VERSION) return m;

  // Future migrations go here, e.g.:
  //   if (version === "1.0") return migrate_1_0_to_1_1(m);
  //   if (version === "1.1") return migrate_1_1_to_2_0(m);

  // Unknown / downlevel version. Stamp it to current and let Zod surface
  // the specific field issues. The producer will then re-write a clean
  // manifest on next save.
  return { ...m, schema_version: OSL_SCHEMA_VERSION };
}
