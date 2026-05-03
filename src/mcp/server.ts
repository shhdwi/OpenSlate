/**
 * openSlate MCP server. Exposes 6 tools:
 *   - record.plan
 *   - record.execute
 *   - record.polish    (no-op in v1; reserved for v1.5 repolish-without-rerecord)
 *   - record.export
 *   - record.list
 *   - record.status
 *
 * Stdio transport; intended to be invoked by Claude Code, Cursor, Codex
 * or OpenCode through their MCP server config.
 *
 * Hyperframes ships a similar pattern; see /Users/shhdwi/Motion/hyperframes/skills/hyperframes
 * for reference on shape but our tool surface is intentionally narrower.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  orchestrateExecute,
  orchestrateExport,
  orchestratePlan,
} from "../core/orchestrate.js";
import { ensureProjectDirs, recordingDir } from "../utils/paths.js";
import { formatViolations } from "../plan/validator.js";
import type { RecordingManifest } from "../recorder/events.js";

const planArgsSchema = z.object({
  description: z.string().min(1),
  protagonist: z.string().min(1),
  base_url: z.string().url(),
  kind: z.enum(["demo", "walkthrough", "readme_hero"]),
  steps: z.array(
    z.object({
      action: z.enum([
        "navigate",
        "click",
        "type",
        "wait",
        "scroll",
        "hover",
        "wait_for_selector",
      ]),
      selector: z.string().optional(),
      value: z.string().optional(),
      note: z.string().optional(),
      expected_duration_ms: z.number().int().positive(),
      no_zoom: z.boolean().optional(),
      beat: z.number().int().nonnegative().optional(),
    }),
  ).min(1),
  rootDir: z.string().optional(),
});

const executeArgsSchema = z.object({
  plan: z.unknown(),
  capture_override: z
    .object({
      target: z.enum(["browser_desktop", "browser_mobile", "browser_tablet", "window_macos"]).optional(),
      viewport: z.object({ width: z.number().int(), height: z.number().int() }).optional(),
      device_pixel_ratio: z.number().optional(),
      fps: z.number().int().optional(),
    })
    .optional(),
  rootDir: z.string().optional(),
});

const exportArgsSchema = z.object({
  recording_id: z.string().min(1),
  preset: z.enum(["default", "readme_hero", "social_vertical", "twitter_landscape"]).optional(),
  output_path: z.string().optional(),
  rootDir: z.string().optional(),
});

const polishArgsSchema = z.object({
  recording_id: z.string().min(1),
  rootDir: z.string().optional(),
});

const listArgsSchema = z.object({
  rootDir: z.string().optional(),
});

const statusArgsSchema = z.object({
  recording_id: z.string().min(1),
  rootDir: z.string().optional(),
});

const TOOLS = [
  {
    name: "record_plan",
    description:
      "Build a validated demo plan from a description + step list. Returns the plan, principle violations, and is_valid flag. Always call this before record_execute and show the user the rationale before executing.",
    inputSchema: {
      type: "object",
      required: ["description", "protagonist", "base_url", "kind", "steps"],
      properties: {
        description: { type: "string", description: "One-sentence description of the demo." },
        protagonist: {
          type: "string",
          description: "The single thing this demo lands on. Used as the recording id slug.",
        },
        base_url: {
          type: "string",
          description: "Dev server URL (e.g. http://localhost:3000)",
        },
        kind: {
          type: "string",
          enum: ["demo", "walkthrough", "readme_hero"],
          description: "Selects the pacing cap and export defaults.",
        },
        steps: {
          type: "array",
          description: "Ordered Playwright actions: navigate / click / type / wait / scroll / hover.",
          items: { type: "object" },
        },
        rootDir: {
          type: "string",
          description: "Optional project root override; defaults to cwd.",
        },
      },
    },
  },
  {
    name: "record_execute",
    description:
      "Execute a previously-built plan against the user's dev server. Captures frames + structured event log. Returns the recording_id.",
    inputSchema: {
      type: "object",
      required: ["plan"],
      properties: {
        plan: { type: "object", description: "The DemoPlan from record_plan." },
        capture_override: { type: "object" },
        rootDir: { type: "string" },
      },
    },
  },
  {
    name: "record_polish",
    description:
      "(v1: no-op) Reserved for v1.5 repolish-without-rerecord. In v1, polish happens inline during export.",
    inputSchema: {
      type: "object",
      required: ["recording_id"],
      properties: {
        recording_id: { type: "string" },
        rootDir: { type: "string" },
      },
    },
  },
  {
    name: "record_export",
    description:
      "Export a polished mp4 / gif from a recording. Pick a preset (default | readme_hero | social_vertical | twitter_landscape).",
    inputSchema: {
      type: "object",
      required: ["recording_id"],
      properties: {
        recording_id: { type: "string" },
        preset: {
          type: "string",
          enum: ["default", "readme_hero", "social_vertical", "twitter_landscape"],
        },
        output_path: { type: "string" },
        rootDir: { type: "string" },
      },
    },
  },
  {
    name: "record_list",
    description: "List all recordings in this project.",
    inputSchema: {
      type: "object",
      properties: { rootDir: { type: "string" } },
    },
  },
  {
    name: "record_status",
    description: "Get the current state of a recording (recording / polishing / rendering / done).",
    inputSchema: {
      type: "object",
      required: ["recording_id"],
      properties: {
        recording_id: { type: "string" },
        rootDir: { type: "string" },
      },
    },
  },
] as const;

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: "openslate", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      switch (name) {
        case "record_plan": {
          const a = planArgsSchema.parse(args);
          const result = await orchestratePlan(a);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    plan: result.plan,
                    is_valid: result.is_valid,
                    violations: result.violations,
                    violations_summary: formatViolations(result.violations),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        case "record_execute": {
          const a = executeArgsSchema.parse(args);
          // Trust the agent's plan shape; the validator already ran in record_plan.
          const result = await orchestrateExecute({
            plan: a.plan as Parameters<typeof orchestrateExecute>[0]["plan"],
            capture_override: a.capture_override,
            rootDir: a.rootDir,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    recording_id: result.recording_id,
                    recording_dir: result.recording_dir,
                    manifest: result.manifest,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        case "record_polish": {
          const a = polishArgsSchema.parse(args);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    polished_id: a.recording_id,
                    note: "v1: polish is inline during export. Call record_export.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        case "record_export": {
          const a = exportArgsSchema.parse(args);
          const result = await orchestrateExport(a);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
        case "record_list": {
          const a = listArgsSchema.parse(args);
          const paths = await ensureProjectDirs(a.rootDir);
          const recordings = await listRecordings(paths.recordings);
          return {
            content: [{ type: "text", text: JSON.stringify({ recordings }, null, 2) }],
          };
        }
        case "record_status": {
          const a = statusArgsSchema.parse(args);
          const paths = await ensureProjectDirs(a.rootDir);
          const dir = recordingDir(paths, a.recording_id);
          const exists = await fileExists(path.join(dir, "manifest.json"));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    recording_id: a.recording_id,
                    state: exists ? "done" : "unknown",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        default:
          return {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `openSlate error: ${message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function listRecordings(recordingsRoot: string): Promise<
  Array<{
    id: string;
    created_at: string;
    base_url: string;
    duration_ms: number;
    frame_count: number;
  }>
> {
  try {
    const entries = await fs.readdir(recordingsRoot, { withFileTypes: true });
    const out: Array<{
      id: string;
      created_at: string;
      base_url: string;
      duration_ms: number;
      frame_count: number;
    }> = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const manifestPath = path.join(recordingsRoot, e.name, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf8");
        const m = JSON.parse(raw) as RecordingManifest;
        out.push({
          id: m.id,
          created_at: m.created_at,
          base_url: m.base_url,
          duration_ms: m.duration_ms,
          frame_count: m.frame_count,
        });
      } catch {
        // skip
      }
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return out;
  } catch {
    return [];
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
