/**
 * `openslate templates` (list) and `openslate template <slug>` (run).
 *
 * Both hit the openslate-web API. `templates` is public and shows
 * everything in the catalog with a free/paid badge. `template <slug>`
 * fetches the demo plan + polish overrides; the server verifies the
 * license header on paid slugs and 401s otherwise.
 *
 * The fetched plan is a typed DemoPlan with `{{base_url}}` placeholders
 * that the CLI substitutes from --base-url before handing it to the
 * existing orchestratePlan → execute → planEdit → export pipeline.
 * Templates are JSON, never executable code; the OSS pipeline does
 * the actual recording.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { apiUrl, readLicense } from "../utils/license-config.js";
import {
  orchestrateExecute,
  orchestrateExport,
  orchestratePlan,
  orchestratePlanEdit,
} from "../core/orchestrate.js";
import type { DemoPlan } from "../plan/types.js";
import type { PolishProfile } from "../core/types.js";

export interface TemplateListEntry {
  slug: string;
  title: string;
  blurb: string;
  is_free: boolean;
  /** What's-included bullets shown in `openslate template <slug>`. */
  includes: string[];
}

interface TemplateBundle {
  meta: TemplateListEntry & { kind: "demo" | "walkthrough" | "readme_hero" };
  plan: DemoPlan;
  polish_overrides?: Partial<PolishProfile>;
}

export async function runTemplatesList(): Promise<void> {
  const url = `${apiUrl()}/api/templates`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(`✗ couldn't reach ${url}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`✗ list failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const { templates } = (await res.json()) as { templates: TemplateListEntry[] };
  if (templates.length === 0) {
    console.log("(no templates published yet)");
    return;
  }
  const free = templates.filter((t) => t.is_free);
  const paid = templates.filter((t) => !t.is_free);
  if (free.length > 0) {
    console.log("Free templates");
    for (const t of free) printTemplateRow(t);
    console.log("");
  }
  if (paid.length > 0) {
    const license = await readLicense();
    console.log(license ? "Paid templates (unlocked)" : "Paid templates (unlock with a license)");
    for (const t of paid) printTemplateRow(t);
    console.log("");
    if (!license) {
      console.log("  Buy a bundle at https://openslate.dev/templates");
      console.log("  Then: openslate login <key>");
    }
  }
}

function printTemplateRow(t: TemplateListEntry): void {
  const slug = t.slug.padEnd(24);
  const title = t.title.length > 40 ? `${t.title.slice(0, 37)}...` : t.title;
  console.log(`  ${slug} ${title}`);
}

export interface RunTemplateOpts {
  slug: string;
  base_url: string;
  /** If true, skip auto-opening the result on macOS. */
  no_open?: boolean;
}

export async function runTemplate(opts: RunTemplateOpts): Promise<void> {
  const startedAt = Date.now();
  const license = await readLicense();
  const url = `${apiUrl()}/api/templates/${encodeURIComponent(opts.slug)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (license) headers["Authorization"] = `Bearer ${license.key}`;

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    console.error(`✗ couldn't reach ${url}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (res.status === 401) {
    console.error(
      "✗ this template requires a paid license. Buy at https://openslate.dev/templates,\n" +
        "  then `openslate login <key>` and try again.",
    );
    process.exit(1);
  }
  if (res.status === 404) {
    console.error(`✗ no template named "${opts.slug}". Try \`openslate templates\` to see the catalog.`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`✗ fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const bundle = (await res.json()) as TemplateBundle;

  // Substitute {{base_url}} placeholders. Done on the JSON string so we
  // don't have to walk the typed structure looking for occurrences.
  const planJson = JSON.stringify(bundle.plan).replaceAll("{{base_url}}", opts.base_url);
  const plan: DemoPlan = JSON.parse(planJson);

  const license_label = license
    ? `(${license.email})`
    : bundle.meta.is_free
      ? "(free template)"
      : "";
  console.log(`✓ fetched ${opts.slug} ${license_label}`);
  console.log(`▶ recording ${opts.base_url}`);
  console.log(`  this takes 1–3 minutes (Chromium download is one-time on first run)`);

  const planResult = await orchestratePlan({
    description: plan.description,
    protagonist: plan.protagonist,
    base_url: plan.base_url,
    kind: plan.kind,
    steps: plan.steps,
  });
  if (!planResult.is_valid) {
    console.error("✗ plan invalid:", planResult.violations);
    process.exit(1);
  }
  const exec = await orchestrateExecute({ plan: planResult.plan });
  console.log(`✓ recorded ${exec.manifest.frame_count} frames`);
  for (const r of exec.step_results) {
    const mark = r.status === "fired" ? "✓" : r.status === "selector_missed" ? "✗" : "·";
    const sel = r.selector ? `  ${r.selector}` : "";
    console.log(
      `  ${mark} step ${String(r.step_index).padStart(2)} ${r.action.padEnd(10)} ${r.status}${sel}`,
    );
  }

  await orchestratePlanEdit({
    recording_id: exec.recording_id,
    profile_overrides: bundle.polish_overrides,
  });
  const out = await orchestrateExport({
    recording_id: exec.recording_id,
    profile_overrides: bundle.polish_overrides,
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `✓ ${path.relative(process.cwd(), out.output_path)} · ${(out.size_bytes / 1024 / 1024).toFixed(2)} MB · ${elapsedSec}s`,
  );
  if (!opts.no_open && process.platform === "darwin") {
    spawn("open", [out.output_path], { detached: true, stdio: "ignore" }).unref();
  }
}
