/**
 * Stubs for the flourishes that are not yet implemented in v1.0 but are
 * present in the polish DSL. They render nothing; the dispatcher calls them
 * so the type contract holds. Implementing each is a 1-2 day task — see the
 * curated flourish library spec for the full list.
 */

import React from "react";
import type {
  FlourishSceneTitleCard,
  FlourishStepBadges,
  FlourishSuccessBurst,
} from "../core/types.js";
import type { FlourishContext } from "./types.js";

export const StepBadges: React.FC<{ config: FlourishStepBadges; ctx: FlourishContext }> = () =>
  null;

export const SceneTitleCard: React.FC<{
  config: FlourishSceneTitleCard;
  ctx: FlourishContext;
}> = () => null;

export const SuccessBurst: React.FC<{ config: FlourishSuccessBurst; ctx: FlourishContext }> = () =>
  null;
