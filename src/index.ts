/**
 * Public package entry. Consumers (polish.config.ts authors, build tooling)
 * import from `openslate`.
 */

export {
  defineProfile,
  type PolishProfile,
  type DefineProfileResult,
  type BrandKit,
  type CaptureProfile,
  type CursorProfile,
  type AutoZoomProfile,
  type CaptionsProfile,
  type FrameProfile,
  type BackgroundProfile,
  type LayoutProfile,
  type IntroProfile,
  type OutroProfile,
  type PacingProfile,
  type FlourishesProfile,
  type ExportsProfile,
  type ExportPreset,
  type ExportFormat,
  type CaptureTarget,
  type FrameStyle,
  type BackgroundStyle,
  type CaptionsMode,
  type AutoZoomTrigger,
} from "./core/types.js";

export { DEFAULT_POLISH_PROFILE } from "./core/defaults.js";
export {
  parsePolishProfile,
  polishProfileSchema,
  type ParsedPolishProfile,
} from "./core/schema.js";
export {
  Principle,
  PRINCIPLE_META,
  Ease,
  type EaseName,
} from "./core/principles.js";

export type { DemoPlan, PlanStep, WorkflowKind, PrincipleViolation } from "./plan/types.js";
export { buildPlan, validatePlan, hasBlocking, formatViolations } from "./plan/index.js";

export type { RecordedEvent, RecordingManifest, CursorSample } from "./recorder/events.js";

export {
  orchestratePlan,
  orchestrateExecute,
  orchestrateExport,
} from "./core/orchestrate.js";

export { loadPolishProfile, configFileExists } from "./config/load.js";
export { renderInitTemplate } from "./config/init-template.js";
