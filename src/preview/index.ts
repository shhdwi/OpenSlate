/**
 * openslate/preview — PixiJS live-preview engine.
 *
 * The dual-renderer contract:
 *   - This engine ships the editor experience (scrubbing, instant updates).
 *   - The Remotion compositor ships the offline export (deterministic,
 *     frame-cacheable, hardware-encoded).
 *   - Both consume the same `.osl` bundle and the same camera math from
 *     openslate/compositor/camera. Parity is enforced by tests.
 *
 * This package is the surface the Mac app + webapp embed. The MCP/CLI
 * doesn't need it (headless export only).
 */

export { PreviewEngine } from "./engine.js";
export type { PreviewEngineOptions, PreviewState } from "./engine.js";

// Re-export the shared camera math so editor UIs can compute virtual
// keyframe positions on the timeline without round-tripping through the
// engine. Same module the engine itself uses internally.
export { sampleCamera, cameraTransform, outToSrc } from "../compositor/camera.js";
export type { CameraState, CameraTransform } from "../compositor/camera.js";
