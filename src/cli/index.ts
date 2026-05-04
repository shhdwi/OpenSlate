#!/usr/bin/env node
/**
 * openSlate CLI. Five commands:
 *   - init     : scaffold polish.config.ts + register MCP + update .gitignore
 *   - record   : run a quick smoke recording (mostly for testing)
 *   - export   : render a polished mp4/gif from an existing recording
 *   - mcp      : start the MCP server (used by Claude Code / Cursor / Codex)
 *   - list     : list recordings in this project
 *
 * Most users won't invoke this directly; their agent will via MCP. The CLI
 * exists for CI use cases and for the smoke-test path.
 */

import path from "node:path";
import { Command } from "commander";
import {
  orchestrateExecute,
  orchestrateExport,
  orchestratePlan,
  orchestratePlanEdit,
} from "../core/orchestrate.js";
import { summarizeEditPlan } from "../plan/edit-plan.js";
import { startMcpServer } from "../mcp/index.js";
import { ensureProjectDirs, recordingDir } from "../utils/paths.js";
import { initProject } from "./init.js";

const program = new Command();

program
  .name("openslate")
  .description("Agent-native screen recorder + motion-design polish for AI coding tools.")
  .version("0.0.1");

program
  .command("init")
  .description("Scaffold polish.config.ts and register MCP with detected agents.")
  .option("-r, --root <dir>", "project root (defaults to cwd)")
  .action(async (options: { root?: string }) => {
    const result = await initProject(options.root ?? process.cwd());
    if (result.config_written) {
      console.log(`✓ wrote ${path.relative(process.cwd(), result.config_path)}`);
    } else {
      console.log(`· ${path.relative(process.cwd(), result.config_path)} already exists`);
    }
    if (result.mcp_clients_registered.length > 0) {
      console.log(`✓ registered MCP with: ${result.mcp_clients_registered.join(", ")}`);
    }
    if (result.gitignore_updated) {
      console.log(`✓ updated .gitignore`);
    }
    console.log("\nNext: open Claude Code / Cursor / Codex and ask: 'demo this feature'.");
  });

program
  .command("mcp")
  .description("Start the openSlate MCP server (stdio).")
  .action(async () => {
    await startMcpServer();
  });

program
  .command("record")
  .description("Quick smoke recording — useful for testing the pipeline. Records a single page interaction.")
  .requiredOption("-u, --url <url>", "dev server URL")
  .option("-d, --description <text>", "description of the demo", "Smoke test")
  .option("--protagonist <name>", "the thing this demo lands on", "smoke")
  .option("--selector <css>", "selector to click")
  .action(
    async (opts: { url: string; description: string; protagonist: string; selector?: string }) => {
      const steps = [
        { action: "navigate" as const, selector: opts.url, expected_duration_ms: 1500 },
        { action: "wait" as const, expected_duration_ms: 800 },
        ...(opts.selector
          ? [{ action: "click" as const, selector: opts.selector, expected_duration_ms: 1200 }]
          : []),
        { action: "wait" as const, expected_duration_ms: 600 },
      ];

      const planResult = await orchestratePlan({
        description: opts.description,
        protagonist: opts.protagonist,
        base_url: opts.url,
        kind: "demo",
        steps,
      });

      console.log("Plan:", planResult.plan.rationale);
      if (!planResult.is_valid) {
        console.error("Plan invalid:", planResult.violations);
        process.exit(1);
      }

      const exec = await orchestrateExecute({ plan: planResult.plan });
      console.log(`✓ recorded ${exec.manifest.frame_count} frames in ${exec.recording_dir}`);

      const planEdit = await orchestratePlanEdit({ recording_id: exec.recording_id });
      console.log(`✓ wrote ${path.relative(process.cwd(), planEdit.edit_plan_path)}`);
      console.log(summarizeEditPlan(planEdit.edit_plan));

      const out = await orchestrateExport({ recording_id: exec.recording_id });
      console.log(`✓ exported ${path.relative(process.cwd(), out.output_path)} · ${(out.size_bytes / 1024 / 1024).toFixed(2)} MB`);
    },
  );

program
  .command("plan <recording_id>")
  .description("Build (or rebuild) the edit plan for an existing recording.")
  .option("--force", "regenerate edit-plan.json even if one already exists", false)
  .action(async (recording_id: string, opts: { force?: boolean }) => {
    const result = await orchestratePlanEdit({
      recording_id,
      force: opts.force ?? false,
    });
    console.log(`✓ ${path.relative(process.cwd(), result.edit_plan_path)}`);
    console.log(summarizeEditPlan(result.edit_plan));
  });

program
  .command("export <recording_id>")
  .description("Render a polished video from an existing recording.")
  .option("-p, --preset <name>", "default | readme_hero | social_vertical | twitter_landscape", "default")
  .option("-o, --output <path>", "explicit output path")
  .action(
    async (
      recording_id: string,
      opts: { preset?: "default" | "readme_hero" | "social_vertical" | "twitter_landscape"; output?: string },
    ) => {
      const out = await orchestrateExport({
        recording_id,
        preset: opts.preset,
        output_path: opts.output,
      });
      console.log(`✓ exported ${path.relative(process.cwd(), out.output_path)}`);
      console.log(`  ${(out.duration_ms / 1000).toFixed(1)}s · ${out.dimensions[0]}×${out.dimensions[1]} · ${(out.size_bytes / 1024 / 1024).toFixed(2)} MB`);
    },
  );

program
  .command("list")
  .description("List recordings in this project.")
  .action(async () => {
    const paths = await ensureProjectDirs();
    const fs = await import("node:fs/promises");
    try {
      const entries = await fs.readdir(paths.recordings, { withFileTypes: true });
      const recordings: Array<{ id: string; created_at: string }> = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        try {
          const raw = await fs.readFile(
            path.join(recordingDir(paths, e.name), "manifest.json"),
            "utf8",
          );
          const m = JSON.parse(raw) as { id: string; created_at: string };
          recordings.push({ id: m.id, created_at: m.created_at });
        } catch {
          // skip
        }
      }
      recordings.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      if (recordings.length === 0) console.log("(no recordings)");
      for (const r of recordings) console.log(`  ${r.id}  (${r.created_at})`);
    } catch {
      console.log("(no recordings)");
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
