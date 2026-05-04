/**
 * The polish.config.ts that `openslate init` drops into a project.
 *
 * Generated programmatically from DEFAULT_POLISH_PROFILE so it can never
 * drift from the actual defaults. Previously this file held a hand-written
 * config string that drifted whenever defaults changed (browser_zoom,
 * click_bounce, frame.style, outro defaults, etc all silently went stale).
 */

import { DEFAULT_POLISH_PROFILE } from "../core/defaults.js";
import type { PolishProfile } from "../core/types.js";

export function renderInitTemplate(opts: {
  brand?: Partial<PolishProfile["brand"]>;
} = {}): string {
  const profile: PolishProfile = {
    ...DEFAULT_POLISH_PROFILE,
    brand: { ...DEFAULT_POLISH_PROFILE.brand, ...(opts.brand ?? {}) },
  };

  // Serialize the profile as TypeScript source. JSON.stringify gets us 90%
  // of the way; we then unquote keys, prefer single→double quotes consistency,
  // and strip the implementation field.
  const body = formatTsObject(profile, 1);

  return `// polish.config.ts — openSlate motion-design profile.
// Every default below traces to one of the 10 motion-design principles.
// Tweak via your agent: "calmer zooms" / "darker theme" / "snappier cursor".
// You will rarely edit this by hand; the agent handles it.

import { defineProfile } from "openslate";

export default defineProfile(${body});
`;
}

/**
 * Format a JS value as TypeScript source. Recurses into objects/arrays.
 * Unquotes keys when they're valid identifiers. Uses double quotes for
 * strings.
 */
function formatTsObject(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const padOuter = "  ".repeat(indent - 1);

  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Inline short numeric arrays (e.g. [0.85, 1.0])
    if (value.every((v) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")) {
      return `[${value.map((v) => formatTsObject(v, indent)).join(", ")}]`;
    }
    const items = value.map((v) => `${pad}${formatTsObject(v, indent + 1)}`).join(",\n");
    return `[\n${items},\n${padOuter}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return "{}";
    const lines = entries.map(([k, v]) => {
      const key = isValidIdentifier(k) ? k : JSON.stringify(k);
      return `${pad}${key}: ${formatTsObject(v, indent + 1)}`;
    });
    return `{\n${lines.join(",\n")},\n${padOuter}}`;
  }

  return JSON.stringify(value);
}

function isValidIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}
