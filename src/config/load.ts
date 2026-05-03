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
    try {
      await fs.access(file);
      const url = pathToFileURL(file).toString();
      // Dynamic import; tolerate both default-export and named-export shapes.
      const mod = (await import(url)) as { default?: unknown };
      const exported = mod.default ?? mod;
      return parsePolishProfile(exported);
    } catch {
      // try next candidate
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
