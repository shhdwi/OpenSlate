#!/usr/bin/env node
/**
 * openSlate CLI. The three "primary" commands cover the npm-install →
 * mp4 journey:
 *   - quick     : one-shot URL → polished mp4, inline step flags
 *   - scaffold  : drop a starter <name>.mjs at the project root
 *   - init      : drop polish.config.ts + register MCP project-locally
 *
 * The agent path is `mcp` (started by Claude Code / Cursor / Codex via the
 * MCP entry that `init` registers). The remaining commands (preview,
 * export, plan, list, record) are escape hatches for power users and CI.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import {
  orchestrateExecute,
  orchestrateExport,
  orchestratePlan,
  orchestratePlanEdit,
} from "../core/orchestrate.js";
import { summarizeEditPlan } from "../plan/edit-plan.js";
import { preview } from "../inspect/index.js";
import { startMcpServer } from "../mcp/index.js";
import { ensureProjectDirs, recordingDir } from "../utils/paths.js";
import { initProject } from "./init.js";
import { renderScaffoldTemplate } from "./scaffold-template.js";
import type { PlanStep, StepAction } from "../plan/types.js";

// Default expected_duration_ms per action — used when the user passes a
// step flag without specifying duration. Tuned to match the quickstart
// reference example.
const DEFAULT_STEP_DURATIONS: Record<Exclude<StepAction, "wait">, number> = {
  navigate: 1500,
  click: 1200,
  type: 1500,
  scroll: 800,
  hover: 600,
  highlight: 1500,
  wait_for_selector: 800,
};

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
    console.log(
      `\nNext steps:\n` +
        `  1. Make sure your dev server is running (typically http://localhost:3000)\n` +
        `  2a. Open Claude Code / Cursor / Codex and ask: "demo this feature"\n` +
        `      — or —\n` +
        `  2b. Drop a multi-step starter script:  npx openslate scaffold\n` +
        `      then edit it and run:  node demo.mjs`,
    );
  });

program
  .command("scaffold [name]")
  .description(
    "Drop a starter <name>.mjs at the project root with the canonical 4-step orchestration flow (plan → execute → planEdit → export). Edit the steps array, then run with node.",
  )
  .option("--url <url>", "dev server URL to use in the template", "http://localhost:3000")
  .option("-f, --force", "overwrite existing file", false)
  .action(async (name: string | undefined, opts: { url: string; force?: boolean }) => {
    const protagonist = (name ?? "demo").replace(/\.(mjs|js|ts)$/i, "");
    const filename = `${protagonist}.mjs`;
    const target = path.resolve(process.cwd(), filename);
    if (!opts.force) {
      try {
        await fs.access(target);
        console.error(`✗ ${filename} already exists. Pass --force to overwrite.`);
        process.exit(1);
      } catch {
        // file does not exist — happy path
      }
    }
    const content = renderScaffoldTemplate({ url: opts.url, protagonist });
    await fs.writeFile(target, content, "utf8");
    console.log(`✓ wrote ${path.relative(process.cwd(), target)}`);
    console.log(`\nNext: edit the steps array, then run:  node ${filename}`);
  });

program
  .command("mcp")
  .description("Start the openSlate MCP server (stdio).")
  .action(async () => {
    await startMcpServer();
  });

program
  .command("helper")
  .description(
    "Build + run the openslate-helper macOS daemon (Swift binary). The helper streams the global cursor position over a local WebSocket so the web recorder can render a polished cursor sprite at the recorded positions (instead of the raw system cursor). macOS only.",
  )
  .argument("<action>", "build | start")
  .option("--port <n>", "WebSocket port (default 9292)", "9292")
  .action(async (action: string, opts: { port: string }) => {
    const helperRoot = path.resolve(import.meta.dirname ?? __dirname, "../../helper-mac");
    if (action === "build") {
      const { spawn } = await import("node:child_process");
      // Debug build — it's 8s vs 60s for release, the binary is 90 KB
      // larger (negligible), and there's a Swift 6.0 release-mode
      // incremental-cache quirk that occasionally serves stale objects
      // for this package. Performance isn't a concern (the helper polls
      // a single Cocoa method at 125 Hz; debug-mode is plenty fast).
      const proc = spawn("swift", ["build"], {
        cwd: helperRoot,
        stdio: "inherit",
      });
      const code = await new Promise<number>((resolve) => proc.on("close", resolve));
      if (code !== 0) process.exit(code);
      console.log(`✓ helper built at ${helperRoot}/.build/debug/openslate-helper`);
      return;
    }
    if (action === "start") {
      const binary = path.join(helperRoot, ".build/debug/openslate-helper");
      const { existsSync } = await import("node:fs");
      if (!existsSync(binary)) {
        console.error(`✗ helper binary not found. Run \`openslate helper build\` first.`);
        process.exit(1);
      }
      const { spawn } = await import("node:child_process");
      const proc = spawn(binary, ["--port", opts.port], { stdio: "inherit" });
      await new Promise<void>((resolve) => proc.on("close", () => resolve()));
      return;
    }
    console.error(`✗ unknown action: ${action} (expected build | start)`);
    process.exit(1);
  });

program
  .command("record-web")
  .description(
    "Open a local browser page that records your screen via getDisplayMedia. Stop the recording and openSlate polishes the video locally — frame chrome, gradient bg, intro/outro, optional 3D tilt. Zero install: nothing leaves your machine.",
  )
  .option("--port <n>", "preferred port for the local server (default: random free port)")
  .action(async (opts: { port?: string }) => {
    const { startWebRecorderServer } = await import("../recorder/web-server.js");
    const handle = await startWebRecorderServer({
      port: opts.port ? Number.parseInt(opts.port, 10) : undefined,
      onJobDone: ({ output_path, size_bytes }) => {
        console.log(
          `✓ ${path.relative(process.cwd(), output_path)} · ${(size_bytes / 1024 / 1024).toFixed(2)} MB`,
        );
      },
      onJobError: ({ recording_id, error }) => {
        console.error(`✗ ${recording_id}: ${error}`);
      },
    });
    console.log(`▶ recorder UI: ${handle.url}`);
    console.log(`  opening in your default browser… (Ctrl+C to stop)`);
    if (process.platform === "darwin") {
      const { spawn } = await import("node:child_process");
      spawn("open", [handle.url], { detached: true, stdio: "ignore" }).unref();
    }
    // Run until SIGINT — server stays up so the user can record multiple
    // takes from the same browser tab.
    await new Promise<void>((resolve) => {
      const stop = async () => {
        await handle.close();
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  });

// Shared closure that captures the order of step flags. Commander invokes
// option coercers in argv order, so this array reflects the user's actual
// intent across --click / --type / --wait. Per-option `opts` slots only
// preserve order within a single flag — not across flags — which is why
// we sidestep them.
const cliSteps: PlanStep[] = [];

const pushClick = (val: string): true => {
  cliSteps.push({
    action: "click",
    selector: val,
    expected_duration_ms: DEFAULT_STEP_DURATIONS.click,
  });
  return true;
};

// Split on the first `=` outside of `[...]` bracket pairs. Attribute-
// matcher selectors like textarea[aria-label="Search"] contain a `=`
// inside the brackets that's part of the selector, not the value
// separator. A naïve indexOf("=") would slice the selector mid-attribute.
const splitTypeArg = (val: string): [string, string] | null => {
  let bracket = 0;
  for (let i = 0; i < val.length; i++) {
    const c = val[i];
    if (c === "[") bracket++;
    else if (c === "]") bracket--;
    else if (c === "=" && bracket === 0) {
      if (i === 0 || i === val.length - 1) return null;
      return [val.slice(0, i), val.slice(i + 1)];
    }
  }
  return null;
};

const pushType = (val: string): true => {
  const split = splitTypeArg(val);
  if (!split) {
    throw new InvalidArgumentError(`--type expects "<selector>=<text>", got: ${val}`);
  }
  const [selector, value] = split;
  cliSteps.push({
    action: "type",
    selector,
    value,
    expected_duration_ms: DEFAULT_STEP_DURATIONS.type,
  });
  return true;
};

const pushWait = (val: string): true => {
  const ms = Number.parseInt(val, 10);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new InvalidArgumentError(`--wait expects a positive integer (ms), got: ${val}`);
  }
  cliSteps.push({ action: "wait", expected_duration_ms: ms });
  return true;
};

program
  .command("quick <url>")
  .description(
    "Record + polish + export a demo of any URL. Use --click / --type / --wait (repeatable, in order) for an inline scenario, or --steps <file.json> for a longer scenario. Result lands in ./demos/.",
  )
  .option(
    "--click <selector>",
    "click a CSS selector (repeatable; order with other step flags preserved)",
    pushClick,
  )
  .option(
    "--type <selector=text>",
    "click a selector and type into it, e.g. \"input[name=email]=alice@example.com\" (repeatable)",
    pushType,
  )
  .option(
    "--wait <ms>",
    "hold for N milliseconds between steps (repeatable)",
    pushWait,
  )
  .option(
    "--steps <file>",
    "path to a JSON file with a steps array; mutually exclusive with --click/--type/--wait",
  )
  .option("-d, --description <text>", "description of the demo", "Quick demo")
  .option("--no-open", "don't auto-open the result in your default video player")
  .action(
    async (
      url: string,
      opts: { steps?: string; description: string; open?: boolean },
    ) => {
      const userSteps = await resolveQuickSteps(opts.steps, cliSteps);

      const startedAt = Date.now();
      console.log(`▶ recording ${url}`);
      console.log(`  this takes 1–3 minutes (Chromium download is one-time on first run)`);
      const steps: PlanStep[] = [
        { action: "navigate", selector: url, expected_duration_ms: DEFAULT_STEP_DURATIONS.navigate },
        { action: "wait", expected_duration_ms: 800 },
        ...userSteps,
        { action: "wait", expected_duration_ms: 600 },
      ];

      const planResult = await orchestratePlan({
        description: opts.description,
        protagonist: "quickstart",
        base_url: url,
        kind: "demo",
        steps,
      });
      if (!planResult.is_valid) {
        console.error("✗ plan invalid:", planResult.violations);
        process.exit(1);
      }
      const exec = await orchestrateExecute({ plan: planResult.plan });
      console.log(`✓ recorded ${exec.manifest.frame_count} frames`);
      await orchestratePlanEdit({ recording_id: exec.recording_id });
      const out = await orchestrateExport({ recording_id: exec.recording_id });
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `✓ ${path.relative(process.cwd(), out.output_path)} · ${(out.size_bytes / 1024 / 1024).toFixed(2)} MB · ${elapsedSec}s`,
      );
      if (opts.open !== false && process.platform === "darwin") {
        const { spawn } = await import("node:child_process");
        spawn("open", [out.output_path], { detached: true, stdio: "ignore" }).unref();
      }
    },
  );

async function resolveQuickSteps(
  stepsFile: string | undefined,
  inlineSteps: PlanStep[],
): Promise<PlanStep[]> {
  if (stepsFile && inlineSteps.length > 0) {
    console.error(
      "✗ --steps is mutually exclusive with --click/--type/--wait. Pick one input mode.",
    );
    process.exit(1);
  }
  if (!stepsFile) return inlineSteps;

  let raw: string;
  try {
    raw = await fs.readFile(stepsFile, "utf8");
  } catch (err) {
    console.error(`✗ failed to read --steps file ${stepsFile}: ${(err as Error).message}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`✗ --steps file is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error(`✗ --steps file must contain a JSON array of steps`);
    process.exit(1);
  }

  const out: PlanStep[] = [];
  parsed.forEach((s, i) => {
    if (typeof s !== "object" || s === null) {
      console.error(`✗ --steps[${i}] must be an object`);
      process.exit(1);
    }
    const obj = s as Record<string, unknown>;
    const action = obj.action;
    if (typeof action !== "string") {
      console.error(`✗ --steps[${i}].action is required`);
      process.exit(1);
    }
    const step: PlanStep = {
      action: action as StepAction,
      expected_duration_ms:
        typeof obj.expected_duration_ms === "number"
          ? obj.expected_duration_ms
          : action === "wait"
            ? 600
            : (DEFAULT_STEP_DURATIONS[action as Exclude<StepAction, "wait">] ?? 800),
    };
    if (typeof obj.selector === "string") step.selector = obj.selector;
    if (typeof obj.value === "string") step.value = obj.value;
    if (typeof obj.note === "string") step.note = obj.note;
    if (typeof obj.no_zoom === "boolean") step.no_zoom = obj.no_zoom;
    if (typeof obj.zoom === "number") step.zoom = obj.zoom;
    out.push(step);
  });
  return out;
}

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
  .command("preview <url>")
  .description(
    "Inspect a page and print interactive elements with stable selectors. Use to verify selectors when authoring a plan by hand, or to see what the agent would see via polish_preview.",
  )
  .option(
    "-w, --viewport <wxh>",
    'viewport size, e.g. "1440x900" (default 1440x900)',
    "1440x900",
  )
  .option("--json", "output JSON only (no human summary)", false)
  .action(async (url: string, opts: { viewport: string; json?: boolean }) => {
    const m = /^(\d+)x(\d+)$/.exec(opts.viewport);
    const viewport = m
      ? { width: Number.parseInt(m[1]!, 10), height: Number.parseInt(m[2]!, 10) }
      : { width: 1440, height: 900 };
    const result = await preview({ url, viewport });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`URL after load: ${result.url_after_load}`);
    console.log(`Title: ${result.page_title}`);
    console.log(`Viewport: ${result.viewport.width}×${result.viewport.height}`);
    if (result.has_consent_banner) console.log("⚠ consent banner detected");
    if (result.notes.length > 0) {
      console.log("\nNotes:");
      for (const n of result.notes) console.log(`  • ${n}`);
    }
    console.log(`\n${result.elements.length} interactive elements:`);
    for (const e of result.elements) {
      const visMark = e.in_viewport ? " " : "↓";
      console.log(
        `  [${e.id.toString().padStart(2)}] ${visMark} ${e.role.padEnd(10)} '${e.name.slice(0, 40).padEnd(40)}'  ${e.selector}`,
      );
    }
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
