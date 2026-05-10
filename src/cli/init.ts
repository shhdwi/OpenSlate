/**
 * `openslate init` — drop a polish.config.ts into the project, register MCP
 * server entries with Claude Code / Cursor / Codex, ensure ./demos/ is in
 * .gitignore.
 *
 * Opinionated; asks zero questions. Run, then ask your agent to tweak.
 */

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { renderInitTemplate } from "../config/init-template.js";
import { configFileExists } from "../config/load.js";

export interface InitResult {
  config_written: boolean;
  config_path: string;
  mcp_clients_registered: string[];
  gitignore_updated: boolean;
}

const MCP_SERVER_NAME = "openslate";

export async function initProject(rootDir: string = process.cwd()): Promise<InitResult> {
  const result: InitResult = {
    config_written: false,
    config_path: path.join(rootDir, "polish.config.ts"),
    mcp_clients_registered: [],
    gitignore_updated: false,
  };

  // 1. Drop polish.config.ts (only if not already present)
  const existing = await configFileExists(rootDir);
  if (!existing) {
    const tpl = renderInitTemplate();
    await fs.writeFile(result.config_path, tpl, "utf8");
    result.config_written = true;
  } else {
    result.config_path = existing;
  }

  // 1b. Ensure package.json has "type": "module" — polish.config.ts uses
  // ESM `import` syntax. Without "type": "module" Node treats .ts files
  // as CJS by default, and dynamic-importing the config silently fails;
  // the recorder then runs against DEFAULT_POLISH_PROFILE (with the user's
  // settings ignored). Update or create package.json so the config loads.
  await ensurePackageJsonIsEsm(rootDir);

  // 2. Register with MCP-compatible clients
  for (const client of [registerClaudeCode, registerCursor, registerCodex]) {
    try {
      const name = await client(rootDir);
      if (name) result.mcp_clients_registered.push(name);
    } catch {
      // best-effort; failures are silent because the user may not have the client
    }
  }

  // 3. Update .gitignore
  result.gitignore_updated = await updateGitignore(rootDir);

  return result;
}

/**
 * Ensures the project's package.json has `"type": "module"`. Idempotent.
 * Creates a minimal package.json if none exists. Leaves anything already
 * set to "module" alone. Coerces "commonjs" → "module" with a warning so
 * the user knows.
 */
async function ensurePackageJsonIsEsm(rootDir: string): Promise<void> {
  const pkgPath = path.join(rootDir, "package.json");
  let pkg: Record<string, unknown> = {};
  let existed = false;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    existed = true;
  } catch {
    // create minimal
    pkg = { name: path.basename(rootDir), version: "0.0.0", private: true };
  }
  const currentType = pkg.type;
  if (currentType === "module") return;
  if (currentType === "commonjs") {
    console.warn(
      `[openslate] package.json had "type": "commonjs"; switching to "module" so polish.config.ts can load via ESM.`,
    );
  }
  pkg.type = "module";
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  if (!existed) {
    console.log(`[openslate] created minimal package.json at ${pkgPath}`);
  }
}

async function registerClaudeCode(rootDir: string): Promise<string | null> {
  // Project-shared `.mcp.json` at the repo root — committable, applies to
  // anyone who clones the repo. This is the modern Claude Code convention
  // for project-scoped MCP servers; openSlate is project-scoped (records
  // the project's dev server), so this is the right slot.
  const projectPath = path.join(rootDir, ".mcp.json");
  await mergeMcpEntry(projectPath, MCP_SERVER_NAME, claudeMcpEntry());
  return "claude_code";
}

async function registerCursor(rootDir: string): Promise<string | null> {
  // Cursor reads project-local `.cursor/mcp.json`. Same project-scoped
  // reasoning as Claude Code.
  const projectPath = path.join(rootDir, ".cursor", "mcp.json");
  await mergeMcpEntry(projectPath, MCP_SERVER_NAME, cursorMcpEntry());
  return "cursor";
}

async function registerCodex(_rootDir: string): Promise<string | null> {
  // Codex doesn't have a widely-adopted project-local MCP convention, so
  // keep the user-level config to avoid inventing one. Re-evaluate when /
  // if Codex ships project-scoped MCP support.
  const userPath = path.join(os.homedir(), ".codex", "config.json");
  await mergeMcpEntry(userPath, MCP_SERVER_NAME, codexMcpEntry());
  return "codex";
}

function claudeMcpEntry(): unknown {
  return {
    command: "npx",
    args: ["-y", "openslate", "mcp"],
  };
}

function cursorMcpEntry(): unknown {
  return {
    command: "npx",
    args: ["-y", "openslate", "mcp"],
  };
}

function codexMcpEntry(): unknown {
  return {
    command: "npx",
    args: ["-y", "openslate", "mcp"],
  };
}

async function mergeMcpEntry(
  configPath: string,
  serverName: string,
  entry: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  let raw = "{}";
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    // file does not exist; we'll create it
  }

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  servers[serverName] = entry;
  parsed.mcpServers = servers;

  await fs.writeFile(configPath, JSON.stringify(parsed, null, 2), "utf8");
}

async function updateGitignore(rootDir: string): Promise<boolean> {
  const gitignorePath = path.join(rootDir, ".gitignore");
  const ENTRIES = ["", "# openSlate", "demos/", "recordings/", ".openslate-cache/"];

  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch {
    // create new
  }

  if (existing.includes("# openSlate")) return false;

  const updated = (existing + (existing.endsWith("\n") || existing === "" ? "" : "\n") + ENTRIES.join("\n") + "\n").trimStart();
  await fs.writeFile(gitignorePath, updated, "utf8");
  return true;
}
