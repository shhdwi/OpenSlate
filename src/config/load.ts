/**
 * Loads polish.config.ts from a project root. Falls back to DEFAULT_POLISH_PROFILE
 * if no config file exists.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_POLISH_PROFILE } from "../core/defaults.js";
import { parsePolishProfile } from "../core/schema.js";
import type { PolishProfile } from "../core/types.js";

const CANDIDATES = ["polish.config.ts", "polish.config.js", "polish.config.mjs"];

export async function loadPolishProfile(rootDir: string = process.cwd()): Promise<PolishProfile> {
  for (const name of CANDIDATES) {
    const file = path.join(rootDir, name);
    let exists = false;
    try {
      await fs.access(file);
      exists = true;
    } catch {
      continue;
    }
    if (!exists) continue;
    // From here, ANY error is meaningful — it means a config exists but
    // failed to load. Silently falling back to DEFAULT_POLISH_PROFILE
    // hides hours of "why aren't my settings taking effect?" debugging
    // (e.g. polish.config.ts using ESM syntax in a CJS-default project).
    try {
      const url = pathToFileURL(file).toString();
      const mod = (await import(url)) as { default?: unknown };
      const exported = mod.default ?? mod;
      return parsePolishProfile(exported);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `\n[openslate] WARNING: ${name} found at ${file} but failed to load:\n  ${msg}\n` +
          `Falling back to DEFAULT_POLISH_PROFILE. Common causes:\n` +
          `  • polish.config.ts uses ESM "import" but package.json has no "type": "module"\n` +
          `  • profile fails schema validation (mismatched field types, out-of-range values)\n`,
      );
      // try next candidate (in case multiple variants exist)
    }
  }
  return DEFAULT_POLISH_PROFILE;
}

export async function configFileExists(rootDir: string = process.cwd()): Promise<string | null> {
  for (const name of CANDIDATES) {
    const file = path.join(rootDir, name);
    try {
      await fs.access(file);
      return file;
    } catch {
      // try next
    }
  }
  return null;
}
