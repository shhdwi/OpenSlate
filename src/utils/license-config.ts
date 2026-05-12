/**
 * Local file store for the openSlate license key.
 *
 * Layout: `~/.config/openslate/license` (XDG-style). One JSON object,
 * no encryption — the file is mode 0600 so other users on the box can't
 * read it, but if your machine is compromised the key is gone anyway
 * (just like any other API key in $HOME).
 *
 * Server URL: defaults to `https://openslate.dev`; override with
 * OPENSLATE_API_URL for local dev (e.g. `http://localhost:3000`).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface LicenseFile {
  /** the osl_… key the buyer received by email */
  key: string;
  /** the email the buyer used at checkout — purely for display */
  email: string;
  /** ISO timestamp of last successful /api/license/verify call */
  last_verified_at: string;
}

export const DEFAULT_API_URL = "https://openslate.dev";

export function apiUrl(): string {
  return process.env.OPENSLATE_API_URL ?? DEFAULT_API_URL;
}

function licensePath(): string {
  const home = os.homedir();
  return path.join(home, ".config", "openslate", "license");
}

export async function readLicense(): Promise<LicenseFile | null> {
  try {
    const raw = await fs.readFile(licensePath(), "utf8");
    const parsed = JSON.parse(raw) as LicenseFile;
    if (typeof parsed?.key !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeLicense(value: LicenseFile): Promise<void> {
  const p = licensePath();
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await fs.writeFile(p, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export async function deleteLicense(): Promise<boolean> {
  try {
    await fs.unlink(licensePath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
