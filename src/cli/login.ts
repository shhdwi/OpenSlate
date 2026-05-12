/**
 * `openslate login <key>` — verifies the key with the openslate-web API
 * and saves it to ~/.config/openslate/license. After this, `openslate
 * template <slug>` and the MCP record_template tool can use paid
 * templates without re-passing the key each time.
 *
 * This is the ONLY OSS-side surface that talks to a server, alongside
 * the template fetcher in template.ts. The recorder / compositor /
 * planner do not touch the network.
 */
import { apiUrl, writeLicense } from "../utils/license-config.js";

export async function runLogin(key: string): Promise<void> {
  if (!/^osl_[A-Za-z0-9_-]{20,}$/.test(key)) {
    console.error(
      "✗ that doesn't look like an openSlate license key. Format is osl_<40-or-so chars>.",
    );
    process.exit(1);
  }
  const url = `${apiUrl()}/api/license/verify`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
  } catch (err) {
    console.error(`✗ couldn't reach ${url}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (res.status === 401) {
    console.error("✗ license rejected. Did you copy the full key from the email?");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`✗ verify failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const body = (await res.json()) as { valid: boolean; email?: string };
  if (!body.valid || !body.email) {
    console.error("✗ license rejected. Did you copy the full key from the email?");
    process.exit(1);
  }
  await writeLicense({
    key,
    email: body.email,
    last_verified_at: new Date().toISOString(),
  });
  console.log(`✓ logged in as ${body.email}`);
  console.log(`  saved to ~/.config/openslate/license`);
  console.log(`  next: try \`openslate templates\` to see what's available`);
}
