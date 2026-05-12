/**
 * `openslate logout` — removes the local license file. Paid templates
 * stop working until you `openslate login` again. Free templates and
 * the rest of openSlate are unaffected (they never needed a license).
 */
import { deleteLicense } from "../utils/license-config.js";

export async function runLogout(): Promise<void> {
  const removed = await deleteLicense();
  if (removed) {
    console.log("✓ removed ~/.config/openslate/license");
  } else {
    console.log("· nothing to do — no license file was saved");
  }
}
