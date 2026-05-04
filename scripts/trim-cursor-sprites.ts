/**
 * Trim cursor SVG sprites so their viewBox matches the visible content's
 * bounding box. After trimming, hotspot fractions (e.g. Recordly's
 * `pointer-1__34-24.svg` → 0.34, 0.24) apply directly to the rendered
 * sprite image — no separate "content lives at offset X within the
 * viewBox" knowledge required.
 *
 * Why this matters: the source SVGs from Recordly have viewBox 0 0 768 768
 * but the cursor body only occupies a fraction of that box, in different
 * sub-rectangles per kind. Without trimming, applying hotspot 0.34 to the
 * un-trimmed render lands in empty space, NOT on the cursor's tip — and
 * the click point appears displaced. Trimming makes the SVG file itself
 * authoritative; the rendering math (left_pct, hotspot * size) is then
 * trivially correct for every sprite forever.
 *
 * Run: bun run scripts/trim-cursor-sprites.ts
 *
 * This is a one-off build step. Commit the trimmed SVGs.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPRITES_DIR = path.resolve(__dirname, "../src/compositor/cursor-sprites");

interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function bboxFor(svgPath: string): Promise<BBox> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const svgRaw = await fs.readFile(svgPath, "utf8");
    // Wrap the SVG in a tiny HTML page so we can evaluate getBBox.
    await page.setContent(
      `<!doctype html><html><body style="margin:0">${svgRaw}</body></html>`,
    );
    const bbox = await page.evaluate(() => {
      const svg = document.querySelector("svg") as SVGSVGElement | null;
      if (!svg) throw new Error("no svg root");
      // getBBox on the root only counts direct children; we want all
      // visible content. So query all renderable descendants and union.
      const elements = svg.querySelectorAll(
        "path, rect, circle, ellipse, line, polyline, polygon, text, image, use",
      );
      if (elements.length === 0) {
        const b = svg.getBBox();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const el of Array.from(elements)) {
        try {
          const b = (el as SVGGraphicsElement).getBBox();
          // A graphics element nested in <defs> or hidden by visibility
          // returns a zero-size box at origin — skip those.
          if (b.width === 0 && b.height === 0) continue;
          // Walk up parents looking for <defs>; if found, skip — those
          // are gradient stops / filter primitives, not visible content.
          let p: Element | null = el.parentElement;
          let inDefs = false;
          while (p) {
            if (p.tagName.toLowerCase() === "defs") {
              inDefs = true;
              break;
            }
            p = p.parentElement;
          }
          if (inDefs) continue;
          minX = Math.min(minX, b.x);
          minY = Math.min(minY, b.y);
          maxX = Math.max(maxX, b.x + b.width);
          maxY = Math.max(maxY, b.y + b.height);
        } catch {
          // ignore
        }
      }
      if (minX === Infinity) {
        const b = svg.getBBox();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    });
    return bbox;
  } finally {
    await browser.close();
  }
}

function rewriteViewBox(svgRaw: string, bbox: BBox): string {
  // Replace the viewBox attr; also drop width/height attrs that hard-code
  // the un-trimmed canvas size (we set them at render time anyway).
  // Use a tiny padding (1 unit) so anti-aliased strokes at the edges
  // don't get clipped by sub-pixel rounding.
  const PAD = 1;
  const x = bbox.x - PAD;
  const y = bbox.y - PAD;
  const w = bbox.width + 2 * PAD;
  const h = bbox.height + 2 * PAD;
  let out = svgRaw.replace(
    /viewBox\s*=\s*"[^"]*"/,
    `viewBox="${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}"`,
  );
  // Strip width/height attrs from the root <svg> — render time supplies
  // them via <img width=...>. Leaving the originals locks in the wrong
  // intrinsic ratio.
  out = out.replace(
    /(<svg[^>]*?)\s+width\s*=\s*"[^"]*"/,
    "$1",
  );
  out = out.replace(
    /(<svg[^>]*?)\s+height\s*=\s*"[^"]*"/,
    "$1",
  );
  return out;
}

function fmt(n: number): string {
  // 4 decimal places is plenty; trims trailing zeros
  return Number(n.toFixed(4)).toString();
}

/**
 * Hotspots taken from Recordly's filename convention (e.g. `pointer-1__34-24.svg`
 * → 34/100, 24/100). These are normalized 0..1 within the *trimmed* sprite
 * bbox, which is exactly what the trim above produces.
 */
const SOURCE_HOTSPOTS: Record<string, { x: number; y: number }> = {
  arrow: { x: 0.34, y: 0.24 },
  pointer: { x: 0.39, y: 0.26 },
  text: { x: 0.5, y: 0.5 },
  grab: { x: 0.5, y: 0.5 },
  "not-allowed": { x: 0.23, y: 0.0 },
};

async function main() {
  const files = (await fs.readdir(SPRITES_DIR))
    .filter((f) => f.endsWith(".svg"))
    .sort();
  console.log(`Trimming ${files.length} sprites in ${SPRITES_DIR}`);
  const info: Record<string, { width: number; height: number; hotspot: { x: number; y: number } }> = {};
  for (const f of files) {
    const p = path.join(SPRITES_DIR, f);
    const before = await fs.readFile(p, "utf8");
    const bbox = await bboxFor(p);
    const after = rewriteViewBox(before, bbox);
    await fs.writeFile(p, after);
    // The post-pad viewBox is bbox padded by 1 on each side; record the
    // padded dimensions so the renderer's aspect-ratio math matches what
    // the SVG actually renders.
    const PAD = 1;
    const kind = path.basename(f, ".svg");
    const hotspot = SOURCE_HOTSPOTS[kind];
    if (!hotspot) throw new Error(`unknown cursor kind: ${kind} (add to SOURCE_HOTSPOTS)`);
    info[kind] = {
      width: bbox.width + 2 * PAD,
      height: bbox.height + 2 * PAD,
      hotspot,
    };
    console.log(
      `  ${f}: bbox = ${fmt(bbox.x)},${fmt(bbox.y)} → ${fmt(bbox.width)}×${fmt(bbox.height)} (aspect ${(bbox.width / bbox.height).toFixed(3)})`,
    );
  }

  // Emit a TS manifest the renderer reads. Single source of truth: any
  // re-trim regenerates the manifest, so renderer math can never drift
  // from the actual SVG geometry.
  const manifestPath = path.resolve(SPRITES_DIR, "../cursor-sprite-info.ts");
  const banner = `// AUTO-GENERATED by scripts/trim-cursor-sprites.ts — do not edit by hand.\n// Run \`bun run scripts/trim-cursor-sprites.ts\` to regenerate after editing\n// any SVG in cursor-sprites/.\n\n`;
  const lines: string[] = [
    banner,
    'export interface SpriteInfo {',
    '  /** post-trim viewBox width (incl. 1u padding on each side) */',
    '  width: number;',
    '  /** post-trim viewBox height (incl. 1u padding on each side) */',
    '  height: number;',
    '  /** click anchor as fraction of the rendered sprite, from Recordly\'s filename */',
    '  hotspot: { x: number; y: number };',
    '}',
    '',
    'export const SPRITE_INFO = {',
  ];
  for (const [kind, v] of Object.entries(info)) {
    lines.push(
      `  ${JSON.stringify(kind)}: { width: ${fmt(v.width)}, height: ${fmt(v.height)}, hotspot: { x: ${v.hotspot.x}, y: ${v.hotspot.y} } },`,
    );
  }
  lines.push('} as const satisfies Record<string, SpriteInfo>;');
  lines.push('');
  await fs.writeFile(manifestPath, lines.join('\n'));
  console.log(`wrote ${manifestPath}`);
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
